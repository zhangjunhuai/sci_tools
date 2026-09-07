import sqlite3
import threading
import json
from .config import DB_PATH

_local = threading.local()


def get_db() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        _local.conn = conn
    return conn


def init_db():
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS papers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            authors TEXT NOT NULL DEFAULT '[]',      -- JSON array
            year INTEGER,
            venue TEXT,
            doi TEXT,
            arxiv_id TEXT,
            abstract TEXT DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]',          -- JSON array
            projects TEXT NOT NULL DEFAULT '[]',      -- JSON array of project names
            status TEXT NOT NULL DEFAULT 'unread',    -- unread | reading | read
            starred INTEGER NOT NULL DEFAULT 0,
            notes TEXT NOT NULL DEFAULT '',
            last_page INTEGER,                        -- PDF 上次读到的页码（阅读进度记忆）
            ai_summary TEXT,
            pdf_path TEXT,                            -- relative to PDF_DIR
            pdf_text TEXT,                            -- extracted plain text
            embedding BLOB,                           -- float32 numpy array
            source TEXT DEFAULT 'manual',             -- manual | zotero | arxiv_feed
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL DEFAULT '',
            icon TEXT NOT NULL DEFAULT '📁',
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS project_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            item_type TEXT NOT NULL DEFAULT 'note',   -- note | result
            title TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',          -- Markdown 正文
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
        CREATE INDEX IF NOT EXISTS idx_project_items ON project_items(project_id);

        CREATE TABLE IF NOT EXISTS annotations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
            page INTEGER NOT NULL,
            kind TEXT NOT NULL DEFAULT 'highlight',   -- highlight | note
            color TEXT NOT NULL DEFAULT 'yellow',
            content TEXT NOT NULL DEFAULT '',          -- selected text
            comment TEXT NOT NULL DEFAULT '',          -- user comment
            rects TEXT NOT NULL DEFAULT '[]',          -- JSON array of {x,y,w,h} in page coords
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,          -- ingest | import_zotero | ai_process ...
            payload TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error
            message TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS journal_subs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            issn TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS journal_feed (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sub_id INTEGER NOT NULL REFERENCES journal_subs(id) ON DELETE CASCADE,
            doi TEXT NOT NULL,
            title TEXT NOT NULL,
            authors TEXT NOT NULL DEFAULT '[]',
            abstract TEXT DEFAULT '',
            venue TEXT DEFAULT '',
            published TEXT,
            relevance REAL,               -- AI 相关度 0-10
            relevance_reason TEXT,
            dismissed INTEGER NOT NULL DEFAULT 0,
            added_paper_id INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
        CREATE INDEX IF NOT EXISTS idx_journal_feed_sub ON journal_feed(sub_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_feed_doi ON journal_feed(doi);

        CREATE TABLE IF NOT EXISTS feed_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            arxiv_id TEXT UNIQUE,
            title TEXT NOT NULL,
            authors TEXT NOT NULL DEFAULT '[]',
            abstract TEXT DEFAULT '',
            primary_category TEXT,
            published TEXT,
            pdf_url TEXT,
            relevance REAL,              -- AI score 0-10
            relevance_reason TEXT,
            dismissed INTEGER NOT NULL DEFAULT 0,
            added_paper_id INTEGER,       -- set when user adds it to library
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE INDEX IF NOT EXISTS idx_papers_fts ON papers(title);
        CREATE INDEX IF NOT EXISTS idx_annotations_paper ON annotations(paper_id);
        CREATE INDEX IF NOT EXISTS idx_feed_created ON feed_items(created_at DESC);
        """
    )
    # 旧库迁移：补充新增列
    cols = [r[1] for r in conn.execute("PRAGMA table_info(papers)").fetchall()]
    if "last_page" not in cols:
        conn.execute("ALTER TABLE papers ADD COLUMN last_page INTEGER")
    pcols = [r[1] for r in conn.execute("PRAGMA table_info(projects)").fetchall()]
    if "icon" not in pcols:
        conn.execute("ALTER TABLE projects ADD COLUMN icon TEXT DEFAULT '📁'")
    jcols = [r[1] for r in conn.execute("PRAGMA table_info(journal_feed)").fetchall()]
    if "relevance" not in jcols:
        conn.execute("ALTER TABLE journal_feed ADD COLUMN relevance REAL")
    if "relevance_reason" not in jcols:
        conn.execute("ALTER TABLE journal_feed ADD COLUMN relevance_reason TEXT")
    # trigram tokenizer: 支持中文子串检索（unicode61 对 CJK 不友好）
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5("
        "title, abstract, pdf_text, tags, content='papers', content_rowid='id', "
        "tokenize='trigram')"
    )
    # 外部内容表需要触发器与 papers 保持同步
    conn.executescript(
        """
        CREATE TRIGGER IF NOT EXISTS papers_fts_ai AFTER INSERT ON papers BEGIN
            INSERT INTO papers_fts(rowid, title, abstract, pdf_text, tags)
            VALUES (new.id, new.title, new.abstract, new.pdf_text, new.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS papers_fts_ad AFTER DELETE ON papers BEGIN
            INSERT INTO papers_fts(papers_fts, rowid, title, abstract, pdf_text, tags)
            VALUES ('delete', old.id, old.title, old.abstract, old.pdf_text, old.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS papers_fts_au AFTER UPDATE ON papers BEGIN
            INSERT INTO papers_fts(papers_fts, rowid, title, abstract, pdf_text, tags)
            VALUES ('delete', old.id, old.title, old.abstract, old.pdf_text, old.tags);
            INSERT INTO papers_fts(rowid, title, abstract, pdf_text, tags)
            VALUES (new.id, new.title, new.abstract, new.pdf_text, new.tags);
        END;
        """
    )
    conn.commit()


def row_to_dict(row) -> dict:
    d = dict(row)
    for key in ("authors", "tags", "projects"):
        if key in d and isinstance(d[key], str):
            try:
                d[key] = json.loads(d[key])
            except (json.JSONDecodeError, TypeError):
                d[key] = []
    return d
