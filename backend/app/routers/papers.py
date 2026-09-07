"""文献 CRUD + 上传。"""
import json
import os
import re
import shutil
import uuid
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from .. import db as DB
from ..config import PDF_DIR
from ..db import get_db
from .. import jobs as J
from .. import ai_client, metadata
from .. import settings as S
from .. import journalinfo

router = APIRouter(prefix="/api/papers", tags=["papers"])


class PaperUpdate(BaseModel):
    title: str | None = None
    authors: list[str] | None = None
    year: int | None = None
    venue: str | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    abstract: str | None = None
    tags: list[str] | None = None
    projects: list[str] | None = None
    status: str | None = None
    starred: bool | None = None
    notes: str | None = None
    last_page: int | None = None


class BatchDeleteBody(BaseModel):
    ids: list[int]


def _paper_out(row) -> dict:
    p = DB.row_to_dict(row)
    p.pop("pdf_text", None)   # 列表接口不带全文
    p.pop("embedding", None)
    p["has_pdf"] = bool(p.get("pdf_path"))
    p["journal_info"] = journalinfo.enrich(p)["journal_info"]
    return p


@router.get("")
def list_papers(
    q: str = "",
    mode: str = Query("keyword", pattern="^(keyword|semantic)$"),
    status: str = "",
    starred: bool | None = None,
    year: int | None = None,
    tag: str = "",
    project: str = "",
    zone: str = "",
    sort: str = Query("created_desc", pattern="^(created_desc|created_asc|year_desc|year_asc|title_asc|starred)$"),
    limit: int = 100,
    offset: int = 0,
):
    conn = get_db()
    ids = None
    if q and mode == "semantic":
        # 服务商不支持 embeddings：语义检索 = 聊天模型提炼检索词 + FTS 命中数排序
        if not S.ai_configured():
            raise HTTPException(400, "语义搜索需要先在设置中配置 API Key")
        ids = _semantic_ids(conn, q, limit=200)
        if not ids:
            return {"total": 0, "items": []}

    where, params = [], []
    if ids is not None:
        if not ids:
            return {"total": 0, "items": []}
        where.append(f"id IN ({','.join('?' * len(ids))})")
        params.extend(ids)
    if q and mode == "keyword":
        rows = _fts_query(conn, q)
        if rows is not None:
            where.append(f"id IN ({','.join('?' * len(rows))})")
            params.extend(rows)
    if zone:
        # 中科院分区筛选（多值 OR）：按分区表匹配每篇论文的 venue
        want = [v for v in zone.split(",") if v]
        matched = [
            r["id"] for r in conn.execute("SELECT id, venue FROM papers").fetchall()
            if (journalinfo.lookup(r["venue"]) or {}).get("z") in want
        ]
        if not matched:
            return {"total": 0, "items": []}
        where.append(f"id IN ({','.join('?' * len(matched))})")
        params.extend(matched)
    if status:
        vals = [v for v in status.split(",") if v]
        where.append(f"status IN ({','.join('?' * len(vals))})")
        params.extend(vals)
    if starred is not None:
        where.append("starred=?")
        params.append(1 if starred else 0)
    if year:
        where.append("year=?")
        params.append(year)
    if tag:
        vals = [v for v in tag.split(",") if v]
        where.append("(" + " OR ".join(["tags LIKE ?"] * len(vals)) + ")")
        params.extend(f'%"{v}"%' for v in vals)
    if project:
        vals = [v for v in project.split(",") if v]
        where.append("(" + " OR ".join(["projects LIKE ?"] * len(vals)) + ")")
        params.extend(f'%"{v}"%' for v in vals)

    order = {
        "created_desc": "created_at DESC, id DESC",
        "created_asc": "created_at ASC, id ASC",
        "year_desc": "year DESC, created_at DESC",
        "year_asc": "year ASC, created_at DESC",
        "title_asc": "title COLLATE NOCASE ASC",
        "starred": "starred DESC, created_at DESC",
    }[sort]

    sql = "SELECT * FROM papers"
    if where:
        sql += " WHERE " + " AND ".join(where)
    total = conn.execute(
        f"SELECT COUNT(*) c FROM ({sql})", params
    ).fetchone()["c"]
    sql += f" ORDER BY {order} LIMIT ? OFFSET ?"
    rows = conn.execute(sql, params + [limit, offset]).fetchall()
    return {"total": total, "items": [_paper_out(r) for r in rows]}


def _fts_query(conn, q: str):
    """全文检索，返回命中的 paper id 列表；短查询（<3 字符）退化为 LIKE。"""
    q = q.strip()
    if not q:
        return None
    try:
        if len(q) < 3:
            rows = conn.execute(
                "SELECT id FROM papers WHERE title LIKE ? OR abstract LIKE ? OR pdf_text LIKE ? LIMIT 500",
                (f"%{q}%", f"%{q}%", f"%{q}%"),
            ).fetchall()
        else:
            escaped = q.replace('"', '""')
            rows = conn.execute(
                "SELECT rowid id FROM papers_fts WHERE papers_fts MATCH ? LIMIT 500",
                (f'"{escaped}"',),
            ).fetchall()
        return [r["id"] for r in rows]
    except Exception:
        # FTS 语法异常时退化为 LIKE
        rows = conn.execute(
            "SELECT id FROM papers WHERE title LIKE ? OR abstract LIKE ? LIMIT 500",
            (f"%{q}%", f"%{q}%"),
        ).fetchall()
        return [r["id"] for r in rows]


def _semantic_ids(conn, q: str, limit: int = 200):
    """智能检索：聊天模型把查询扩写成检索词，FTS 多词 OR，按命中词数排序（无 embeddings）。"""
    terms = [q.strip()]
    if S.ai_configured():
        try:
            resp = ai_client.chat(
                [{"role": "user", "content":
                    f"把下面的文献检索需求扩写成 3-6 个检索词（同义词、英文术语、中文译名），"
                    f'输出 JSON：{{"keywords": ["..."] }}。需求：{q}'}],
                temperature=0.2, json_mode=True, max_tokens=200,
            )
            data = ai_client.parse_json(resp)
            terms = [str(k).strip() for k in data.get("keywords", []) if str(k).strip()] or terms
        except (ai_client.AINotConfigured, ai_client.AICallError, ValueError):
            pass
    counts = {}
    for t in terms[:6]:
        for pid in _fts_query(conn, t) or []:
            counts[pid] = counts.get(pid, 0) + 1
    return [pid for pid, _ in sorted(counts.items(), key=lambda kv: -kv[1])[:limit]]


@router.get("/search")
def search(q: str, mode: str = "keyword", limit: int = 30):
    """独立搜索接口（标题/摘要高亮用，简化返回）。"""
    return list_papers(q=q, mode=mode, limit=limit)


@router.post("/upload")
async def upload_paper(file: UploadFile = File(...), doi: str = Form("")):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "只支持 PDF 文件")
    data = await file.read()
    if not data[:4] == b"%PDF":
        raise HTTPException(400, "文件不是有效的 PDF")

    rel = f"{uuid.uuid4().hex}.pdf"
    (PDF_DIR / rel).write_bytes(data)

    # 标题先以文件名占位（带 .pdf 后缀便于识别为占位符），元数据抓到后覆盖
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO papers(title, source, pdf_path, doi) VALUES(?, 'manual', ?, ?)",
        (file.filename or "未命名.pdf", rel, doi.strip() or None),
    )
    conn.commit()
    paper_id = cur.lastrowid
    J.enqueue("process_paper", {"paper_id": paper_id})
    row = conn.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
    return _paper_out(row)


@router.post("/batch_delete")
def batch_delete(body: BatchDeleteBody):
    conn = get_db()
    ids = [i for i in body.ids if isinstance(i, int)]
    if not ids:
        return {"ok": True, "deleted": 0}
    q = ",".join("?" * len(ids))
    rows = conn.execute(f"SELECT id, pdf_path FROM papers WHERE id IN ({q})", ids).fetchall()
    for r in rows:
        if r["pdf_path"]:
            f = PDF_DIR / r["pdf_path"]
            if f.exists():
                f.unlink()
    conn.execute(f"DELETE FROM papers WHERE id IN ({q})", ids)
    conn.commit()
    return {"ok": True, "deleted": len(rows)}


@router.get("/{paper_id}")
def get_paper(paper_id: int):
    conn = get_db()
    row = conn.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    p = DB.row_to_dict(row)
    p.pop("embedding", None)
    p["has_pdf"] = bool(p.get("pdf_path"))
    p["journal_info"] = journalinfo.enrich(p)["journal_info"]
    # 去重：是否有其他论文与本文同 DOI/arXiv
    p["duplicate_ids"] = [
        r["id"]
        for r in conn.execute(
            "SELECT id FROM papers WHERE id!=? AND ((doi!='' AND doi=?) OR (arxiv_id!='' AND arxiv_id=?))",
            (paper_id, p.get("doi") or "\x00", p.get("arxiv_id") or "\x00"),
        )
    ]
    return p


@router.patch("/{paper_id}")
def update_paper(paper_id: int, body: PaperUpdate):
    conn = get_db()
    row = conn.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    d = body.model_dump(exclude_none=True)
    if "authors" in d:
        d["authors"] = json.dumps(d["authors"], ensure_ascii=False)
    if "tags" in d:
        d["tags"] = json.dumps(d["tags"], ensure_ascii=False)
    if "projects" in d:
        d["projects"] = json.dumps(d["projects"], ensure_ascii=False)
    if "starred" in d:
        d["starred"] = 1 if d.pop("starred") else 0
    if d:
        d["updated_at"] = "now"
        sets = ", ".join(
            "updated_at=datetime('now','localtime')" if k == "updated_at" else f"{k}=?"
            for k in d
        )
        params = [v for k, v in d.items() if k != "updated_at"] + [paper_id]
        conn.execute(f"UPDATE papers SET {sets} WHERE id=?", params)
        conn.commit()
    return get_paper(paper_id)


@router.delete("/{paper_id}")
def delete_paper(paper_id: int):
    conn = get_db()
    row = conn.execute("SELECT pdf_path FROM papers WHERE id=?", (paper_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    if row["pdf_path"]:
        f = PDF_DIR / row["pdf_path"]
        if f.exists():
            f.unlink()
    conn.execute("DELETE FROM papers WHERE id=?", (paper_id,))
    conn.commit()
    return {"ok": True}


@router.post("/{paper_id}/note_draft")
def note_draft(paper_id: int):
    if not S.ai_configured():
        raise HTTPException(400, "请先在设置中配置 API Key")
    conn = get_db()
    row = conn.execute(
        "SELECT title, abstract, notes, pdf_text FROM papers WHERE id=?", (paper_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(404)
    anns = [
        DB.row_to_dict(r) for r in conn.execute(
            "SELECT page, kind, color, content, comment FROM annotations WHERE paper_id=? ORDER BY page, id",
            (paper_id,),
        )
    ]
    if not anns:
        raise HTTPException(400, "这篇文献还没有高亮或批注，先在 PDF 里划选标注吧")

    lines = []
    for a in anns:
        mark = {"yellow": "🟡", "green": "🟢", "blue": "🔵", "red": "🔴"}.get(a["color"], "🟡")
        entry = f"- {mark} 第{a['page']}页：\"{(a['content'] or '').strip()[:300]}\""
        if a["comment"]:
            entry += f"\n  我的批注：{a['comment']}"
        lines.append(entry)
    ann_text = "\n".join(lines)[:8000]

    prompt = (
        f"论文标题：{row['title']}\n"
        f"摘要：{(row['abstract'] or '（无）')[:1500]}\n\n"
        f"以下是阅读时的划线高亮和批注：\n{ann_text}\n\n"
        "请把这些素材整理成一篇结构化中文读书笔记（Markdown），包含：\n"
        "## 核心观点（3-5 条，综合高亮和摘要提炼）\n"
        "## 关键细节（方法/数据/结果中值得记住的点）\n"
        "## 我的思考（汇总用户批注，没有批注就写值得追问的问题）\n"
        "只输出 Markdown 正文，不要寒暄。"
    )
    from .. import ai_client
    try:
        draft = ai_client.chat([{"role": "user", "content": prompt}], temperature=0.4, max_tokens=2500)
    except ai_client.AICallError as e:
        raise HTTPException(502, f"AI 调用失败：{e}")

    header = f"\n\n---\n\n# AI 笔记草稿（生成于 {__import__('datetime').date.today()}）\n\n"
    notes = (row["notes"] or "").rstrip() + header + draft.strip() + "\n"
    conn.execute(
        "UPDATE papers SET notes=?, updated_at=datetime('now','localtime') WHERE id=?",
        (notes, paper_id),
    )
    conn.commit()
    return {"ok": True, "notes": notes}


@router.get("/{paper_id}/pdf")
def get_pdf(paper_id: int):
    conn = get_db()
    row = conn.execute("SELECT pdf_path, title FROM papers WHERE id=?", (paper_id,)).fetchone()
    if row is None or not row["pdf_path"]:
        raise HTTPException(404, "没有 PDF")
    path = PDF_DIR / row["pdf_path"]
    if not path.exists():
        raise HTTPException(404, "PDF 文件丢失")
    return FileResponse(path, media_type="application/pdf", filename=f"{row['title'] or 'paper'}.pdf",
                        content_disposition_type="inline")


@router.post("/{paper_id}/attach")
async def attach_pdf(paper_id: int, file: UploadFile = File(...)):
    """给已有条目补挂 PDF。"""
    data = await file.read()
    if not data[:4] == b"%PDF":
        raise HTTPException(400, "文件不是有效的 PDF")
    rel = f"{uuid.uuid4().hex}.pdf"
    (PDF_DIR / rel).write_bytes(data)
    conn = get_db()
    conn.execute(
        "UPDATE papers SET pdf_path=?, updated_at=datetime('now','localtime') WHERE id=?",
        (rel, paper_id),
    )
    conn.commit()
    J.enqueue("process_paper", {"paper_id": paper_id})
    return {"ok": True}


@router.post("/{paper_id}/similar")
def similar(paper_id: int, limit: int = 10):
    """找相似：标签重合数优先，其次 FTS 命中数（无 embeddings）。"""
    conn = get_db()
    row = conn.execute("SELECT title, abstract, tags FROM papers WHERE id=?", (paper_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    try:
        tags = set(json.loads(row["tags"]) if row["tags"] else [])
    except json.JSONDecodeError:
        tags = set()
    scores = {}
    # 标签重合：每重合 1 个标签计 3 分（最直接的"同领域"信号）
    for t in tags:
        for r in conn.execute("SELECT id FROM papers WHERE tags LIKE ?", (f'%"{t}"%',)).fetchall():
            if r["id"] != paper_id:
                scores[r["id"]] = scores.get(r["id"], 0) + 3
    # 标题+摘要 FTS 命中：每命中一个词计 1 分
    terms = [w for w in re.split(r"[\s,，。?？!！:：]+", f"{row['title']} {row['abstract'] or ''}") if len(w) >= 3][:6]
    for t in terms:
        for pid in _fts_query(conn, t) or []:
            if pid != paper_id:
                scores[pid] = scores.get(pid, 0) + 1
    ids = [pid for pid, _ in sorted(scores.items(), key=lambda kv: -kv[1])[:limit]]
    if not ids:
        return {"items": []}
    rows = conn.execute(
        f"SELECT * FROM papers WHERE id IN ({','.join('?' * len(ids))})", ids
    ).fetchall()
    rows.sort(key=lambda r: ids.index(r["id"]))
    return {"items": [_paper_out(r) for r in rows]}
