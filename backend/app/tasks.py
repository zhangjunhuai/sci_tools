"""具体任务实现：文献入库后处理、Zotero 导入、arXiv 订阅抓取。"""
import json
import re
import urllib.request
from . import db as DB
from . import pdfproc, metadata
from .config import PDF_DIR
from .db import get_db
from . import settings as S
from . import ai_client

def run_job(job_type: str, payload: dict):
    if job_type == "process_paper":
        process_paper(payload["paper_id"])
    elif job_type == "import_zotero":
        import_zotero(payload["path"])
    elif job_type == "fetch_feed":
        fetch_feed()
    elif job_type == "fetch_journal_feed":
        fetch_journal_feed()
    elif job_type == "refresh_memory":
        refresh_memory()
    else:
        raise ValueError(f"unknown job type {job_type}")


def process_paper(paper_id: int):
    """拿到 PDF 后：提取文本 → 识别元数据并补全 → AI 标签/摘要 → 向量。"""
    conn = get_db()
    row = conn.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
    if row is None:
        return
    paper = DB.row_to_dict(row)

    # 1. PDF 文本
    pdf_text = paper.get("pdf_text") or ""
    if paper.get("pdf_path") and not pdf_text:
        import os
        path = str(PDF_DIR / paper["pdf_path"])
        if os.path.exists(path):
            pdf_text, _ = pdfproc.extract_text(path)
            conn.execute(
                "UPDATE papers SET pdf_text=? WHERE id=?", (pdf_text, paper_id)
            )
            conn.commit()

    # 2. 元数据补全（标题是占位符，或 DOI/arXiv 缺失时）
    paper = DB.row_to_dict(
        conn.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
    )
    needs_meta = _is_placeholder_title(paper["title"]) or (
        not paper.get("doi") and not paper.get("arxiv_id")
    )
    if needs_meta:
        import os
        filename = os.path.basename(paper.get("pdf_path") or "")
        # 标识符提示（上传时带入的 DOI）→ 文件名 → 全文 → 猜标题
        hint = paper.get("doi") or paper.get("arxiv_id") or ""
        probe = " ".join(
            filter(None, [hint, filename, pdfproc.head_text(pdf_text, 8000), paper["title"]])
        )
        meta, _src = metadata.lookup(probe, fallback_title=pdfproc.guess_title_from(pdf_text))
        if meta:
            _merge_meta(conn, paper_id, paper, meta)

    # 2.5 没 PDF 但有 DOI：试 Unpaywall 的合法 OA 副本（机构库/预印本）
    paper = DB.row_to_dict(
        conn.execute("SELECT pdf_path, doi FROM papers WHERE id=?", (paper_id,)).fetchone()
    )
    if not paper.get("pdf_path") and paper.get("doi"):
        oa_url = metadata.fetch_oa_pdf_url(paper["doi"])
        if oa_url:
            rel = _download_oa_pdf(oa_url, f"oa_{paper_id}.pdf")
            if rel:
                conn.execute(
                    "UPDATE papers SET pdf_path=? WHERE id=?", (rel, paper_id)
                )
                conn.commit()
                pdf_text, _ = pdfproc.extract_text(str(PDF_DIR / rel))
                conn.execute("UPDATE papers SET pdf_text=? WHERE id=?", (pdf_text, paper_id))
                conn.commit()
                print(f"[oa] paper {paper_id}: OA copy downloaded from {oa_url}")

    # 3. AI 标签 + 摘要 + 相关度（未配置 API 则跳过）
    if S.ai_configured() and (pdf_text or paper.get("abstract")):
        try:
            _ai_enrich(conn, paper_id)
        except (ai_client.AINotConfigured, ai_client.AICallError) as e:
            print(f"[ai_enrich] paper {paper_id}: {e}")


def _download_oa_pdf(url: str, rel: str):
    """下载 OA 副本，校验确实是 PDF。"""
    import urllib.request
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "research-hub/0.1"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
        if data[:4] == b"%PDF":
            (PDF_DIR / rel).write_bytes(data)
            return rel
    except Exception as e:
        print(f"[oa_download] {url}: {e}")
    return None


def _merge_meta(conn, paper_id: int, paper: dict, meta: dict):
    """用抓取到的元数据补全空字段；标题是文件名占位符时直接覆盖。"""
    updates, params = [], []

    def set_if_empty(col, val):
        nonlocal updates, params
        if val and not paper.get(col):
            updates.append(f"{col}=?")
            params.append(val)

    # 文件名占位标题（上传时以文件名代替）用抓取结果覆盖
    if meta.get("title") and _is_placeholder_title(paper["title"]):
        updates.append("title=?")
        params.append(meta["title"])
    if meta.get("authors") and paper["authors"] == []:
        updates.append("authors=?")
        params.append(json.dumps(meta["authors"], ensure_ascii=False))
    for col in ("year", "venue", "doi", "arxiv_id", "abstract"):
        set_if_empty(col, meta.get(col))
    if updates:
        updates.append("updated_at=datetime('now','localtime')")
        params.append(paper_id)
        conn.execute(f"UPDATE papers SET {', '.join(updates)} WHERE id=?", params)
        conn.commit()


def _is_placeholder_title(title: str) -> bool:
    """上传时以文件名做标题，形如 xxx.pdf / 未命名；这类标题可被覆盖。"""
    t = (title or "").strip()
    return (
        not t
        or t.lower().endswith(".pdf")
        or t.startswith("未命名")
        or t.lower() in {"untitled", "paper", "document", "article"}
    )


def _ai_enrich(conn, paper_id: int):
    research = S.get("research_interests")
    preset = S.get("tag_preset").strip()

    paper = DB.row_to_dict(
        conn.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
    )
    content = paper.get("abstract") or ""
    if not content and paper.get("pdf_text"):
        content = pdfproc.head_text(paper["pdf_text"], 4000)

    preset_line = f"候选标签（优先从中选，可补充少量新标签）：{preset}" if preset else "标签自由拟定，3-6 个。"
    prompt = (
        f"你是一名类脑导航（brain-inspired navigation）领域的研究助手。\n"
        f"用户的研究方向：{research}\n\n{_memory_block()}\n"
        f"论文标题：{paper['title']}\n"
        f"论文内容（摘要或开头）：{content[:4000]}\n\n"
        f"请输出 JSON，字段：\n"
        f'1. "tags": 字符串数组，{preset_line}\n'
        f'2. "summary": 结构化中文摘要，包含「研究问题」「方法」「核心发现」「与用户研究的关联」四部分，用换行分隔，共 150-250 字。\n'
        f'3. "relevance": 0-10 整数，该论文与用户研究方向的相关度。\n'
        f"只输出 JSON。"
    )
    resp = ai_client.chat(
        [{"role": "user", "content": prompt}], temperature=0.2, json_mode=True
    )
    data = ai_client.parse_json(resp)
    tags = [str(t).strip() for t in data.get("tags", []) if str(t).strip()][:8]
    summary = str(data.get("summary", "")).strip()
    conn.execute(
        "UPDATE papers SET tags=?, ai_summary=?, updated_at=datetime('now','localtime') WHERE id=?",
        (json.dumps(tags, ensure_ascii=False), summary, paper_id),
    )
    conn.commit()


# ---------- Zotero 导入 ----------

def import_zotero(path: str):
    """导入 CSL JSON（含文件附件路径）。"""
    with open(path, encoding="utf-8") as f:
        items = json.load(f)

    # CSL JSON 的附件以相对/绝对路径给出，通常与 json 同目录
    import os
    base_dir = os.path.dirname(os.path.abspath(path))
    ok, fail = 0, 0
    for item in items:
        try:
            _import_zotero_item(item, base_dir)
            ok += 1
        except Exception as e:
            print(f"[zotero] skip item: {e}")
            fail += 1
    print(f"[zotero] imported {ok}, failed {fail}")


def _import_zotero_item(item: dict, base_dir: str):
    conn = get_db()
    it = item.get("item", item)  # Zotero 导出有时包一层
    mtype = it.get("type", "")
    if mtype not in ("journal-article", "preprint", "book-chapter", "book", "report", "thesis", "conference-paper", "article", "chapter"):
        # 跳过笔记、附件等
        if mtype in ("note", "attachment"):
            return
    title = (it.get("title") or "").strip()
    if not title:
        return

    doi = (it.get("DOI") or "").strip() or None
    arxiv_id = None
    if it.get("URL") and "arxiv.org" in it["URL"]:
        arxiv_id = metadata.detect_arxiv_id(it["URL"])
    if not arxiv_id and doi:
        arxiv_id = metadata.detect_arxiv_id(doi)

    authors = []
    for a in it.get("author", []):
        name = " ".join(filter(None, [a.get("given"), a.get("family")])).strip()
        if not name and a.get("literal"):
            name = a["literal"]
        if name:
            authors.append(name)

    year = None
    issued = it.get("issued", {}).get("date-parts", [[None]])
    if issued and issued[0]:
        year = issued[0][0]

    venue = it.get("container-title") or it.get("publisher") or ""
    abstract = re.sub(r"<[^>]+>", "", it.get("abstract", "") or "")

    tags = [t.get("tag") for t in it.get("tag", []) if isinstance(t, dict) and t.get("tag")]

    # 找 PDF 附件（Zotero 导出时 link 里带相对/绝对路径）
    import os
    pdf_rel = None
    for link in it.get("link", []):
        if link.get("content-type") == "application/pdf" or (link.get("URL") or "").lower().endswith(".pdf"):
            url = link["URL"]
            if url.startswith("http"):
                continue  # 在线链接不下载，保持轻量
            cand = url if os.path.isabs(url) else os.path.join(base_dir, url)
            if os.path.exists(cand) and not os.path.isdir(cand):
                pdf_rel = _store_pdf_file(cand)
                break

    # 也可能文件字段直接给出（Zotero 导出文件时部分条目带 file）
    if pdf_rel is None and it.get("file"):
        cand = it["file"] if os.path.isabs(it["file"]) else os.path.join(base_dir, it["file"])
        if os.path.exists(cand) and cand.lower().endswith(".pdf"):
            pdf_rel = _store_pdf_file(cand)

    cur = conn.execute(
        """INSERT INTO papers(title, authors, year, venue, doi, arxiv_id, abstract,
           tags, projects, source, pdf_path)
           VALUES(?,?,?,?,?,?,?,?,?, 'zotero', ?)""",
        (
            title,
            json.dumps(authors, ensure_ascii=False),
            year,
            venue,
            doi,
            arxiv_id,
            abstract[:5000],
            json.dumps(tags, ensure_ascii=False),
            json.dumps([], ensure_ascii=False),
            pdf_rel,
        ),
    )
    conn.commit()
    paper_id = cur.lastrowid
    from . import jobs as J
    J.enqueue("process_paper", {"paper_id": paper_id})


def _store_pdf_file(src_path: str) -> str:
    """把 PDF 复制进 PDF_DIR，返回相对路径。"""
    import hashlib
    import shutil
    h = hashlib.md5(src_path.encode()).hexdigest()[:12]
    rel = f"zotero_{h}.pdf"
    dst = PDF_DIR / rel
    if not dst.exists():
        shutil.copy2(src_path, dst)
    return rel


# ---------- arXiv 订阅 ----------

def fetch_feed():
    cats = [c.strip() for c in S.get("arxiv_categories").split(",") if c.strip()]
    kws = [k.strip() for k in S.get("arxiv_keywords").split(",") if k.strip()]
    max_results = int(S.get("arxiv_max_results") or 80)
    if not cats:
        return
    items = metadata.fetch_arxiv_feed(cats, kws, max_results)
    conn = get_db()
    new = 0
    for it in items:
        cur = conn.execute(
            """INSERT INTO feed_items(arxiv_id, title, authors, abstract, primary_category, published, pdf_url)
               VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(arxiv_id) DO NOTHING""",
            (
                it["arxiv_id"],
                it["title"],
                json.dumps(it["authors"], ensure_ascii=False),
                it["abstract"],
                it["primary_category"],
                it["published"],
                it["pdf_url"],
            ),
        )
        new += cur.rowcount
    conn.commit()
    print(f"[feed] fetched {len(items)}, new {new}")

    # AI 相关度打分（未配置则跳过）
    if S.ai_configured():
        _score_feed(conn)


def _score_feed(conn):
    research = S.get("research_interests")
    rows = conn.execute(
        "SELECT id, title, abstract FROM feed_items WHERE relevance IS NULL AND dismissed=0 LIMIT 30"
    ).fetchall()
    if not rows:
        return
    titles = "\n".join(f"{i+1}. {r['title']}" for i, r in enumerate(rows))
    prompt = (
        f"用户研究方向：{research}\n\n{_memory_block()}"
        f"下面是 arXiv 新论文列表：\n{titles}\n\n"
        f"请结合用户的研究方向与研究记忆，对每篇论文打相关度分（0-10，10 为核心相关），"
        f"并为 7 分以上的给出一句中文推荐理由（理由中可点出与用户哪方面兴趣相关）。\n"
        f'输出 JSON：{{"scores": [{{"n": 1, "score": 8, "reason": "..."}}, ...]}}，只列 7 分以上的即可，其他不用列。'
    )
    try:
        resp = ai_client.chat([{"role": "user", "content": prompt}], temperature=0.1, json_mode=True)
        data = ai_client.parse_json(resp)
        for s in data.get("scores", []):
            try:
                idx = int(s["n"]) - 1
                if 0 <= idx < len(rows):
                    conn.execute(
                        "UPDATE feed_items SET relevance=?, relevance_reason=? WHERE id=?",
                        (float(s["score"]), str(s.get("reason", ""))[:300], rows[idx]["id"]),
                    )
            except (KeyError, ValueError, IndexError):
                continue
        conn.commit()
    except (ai_client.AINotConfigured, ai_client.AICallError) as e:
        print(f"[feed_score] {e}")


def add_feed_item_to_library(feed_id: int) -> int:
    """把订阅条目加入文献库（先下载 PDF）。"""
    conn = get_db()
    row = conn.execute("SELECT * FROM feed_items WHERE id=?", (feed_id,)).fetchone()
    if row is None:
        raise ValueError("feed item not found")
    if row["added_paper_id"]:
        return row["added_paper_id"]

    arxiv_id = row["arxiv_id"]
    # 查重
    dup = conn.execute(
        "SELECT id FROM papers WHERE arxiv_id=?", (arxiv_id,)
    ).fetchone()
    if dup:
        conn.execute(
            "UPDATE feed_items SET added_paper_id=? WHERE id=?", (dup["id"], feed_id)
        )
        conn.commit()
        return dup["id"]

    pdf_rel = None
    try:
        req = urllib.request.Request(
            row["pdf_url"], headers={"User-Agent": "research-hub/0.1"}
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
        if data[:4] == b"%PDF":
            rel = f"arxiv_{arxiv_id.replace('/', '_')}.pdf"
            (PDF_DIR / rel).write_bytes(data)
            pdf_rel = rel
    except Exception as e:
        print(f"[feed_download] {arxiv_id}: {e}")

    # 写锁内"查重+插入"原子化：下载可能耗时几十秒，期间连点的请求都会走到这里排队，
    # 排到后能看到前面请求已写的 added_paper_id，只返回同一篇文献
    conn.execute("BEGIN IMMEDIATE")
    try:
        added = conn.execute(
            "SELECT added_paper_id FROM feed_items WHERE id=?", (feed_id,)
        ).fetchone()["added_paper_id"]
        if added:
            conn.rollback()
            return added

        dup = conn.execute(
            "SELECT id FROM papers WHERE arxiv_id=?", (arxiv_id,)
        ).fetchone()
        if dup:
            conn.execute(
                "UPDATE feed_items SET added_paper_id=? WHERE id=?", (dup["id"], feed_id)
            )
            conn.commit()
            return dup["id"]

        cur = conn.execute(
            """INSERT INTO papers(title, authors, year, venue, arxiv_id, abstract, source, pdf_path)
               VALUES(?,?,?,?,?,?, 'arxiv_feed', ?)""",
            (
                row["title"],
                row["authors"],
                int(row["published"][:4]) if row["published"] else None,
                "arXiv",
                arxiv_id,
                row["abstract"],
                pdf_rel,
            ),
        )
        paper_id = cur.lastrowid
        conn.execute(
            "UPDATE feed_items SET added_paper_id=? WHERE id=?", (paper_id, feed_id)
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    from . import jobs as J
    J.enqueue("process_paper", {"paper_id": paper_id})
    return paper_id


# ---------- 期刊订阅（Crossref 增量抓取） ----------

def fetch_journal_feed():
    """对所有已订阅期刊增量拉取最新论文，进 journal_feed 表。"""
    import httpx
    conn = get_db()
    subs = conn.execute("SELECT * FROM journal_subs").fetchall()
    for sub in subs:
        if not sub["issn"]:
            continue
        last = conn.execute(
            "SELECT MAX(published) m FROM journal_feed WHERE sub_id=?", (sub["id"],)
        ).fetchone()["m"]
        try:
            works = metadata.fetch_journal_works(sub["issn"], last)
        except httpx.HTTPError as e:
            print(f"[journal_feed] {sub['name']}: {e}")
            continue
        new = 0
        for w in works:
            cur = conn.execute(
                """INSERT INTO journal_feed(sub_id, doi, title, authors, abstract, venue, published)
                   VALUES(?,?,?,?,?,?,?)
                   ON CONFLICT(doi) DO NOTHING""",
                (
                    sub["id"], w["doi"], w["title"],
                    json.dumps(w["authors"], ensure_ascii=False),
                    w["abstract"], w["venue"], w["published"],
                ),
            )
            new += cur.rowcount
        conn.commit()
        print(f"[journal_feed] {sub['name']}: fetched {len(works)}, new {new}")
    if S.ai_configured():
        _score_journal_feed(conn)


def _score_journal_feed(conn):
    """给未打分的期刊条目批量打相关度分（逐篇，标题+摘要）。"""
    research = S.get("research_interests")
    rows = conn.execute(
        "SELECT id, title, abstract FROM journal_feed WHERE relevance IS NULL AND dismissed=0 LIMIT 30"
    ).fetchall()
    mem_block = _memory_block()
    for r in rows:
        prompt = (
            f"用户研究方向：{research}\n\n{mem_block}"
            f"论文标题：{r['title']}\n"
            f"摘要：{(r['abstract'] or '（无）')[:1500]}\n\n"
            f"请结合用户的研究方向与研究记忆打分。"
            f"请输出 JSON：{{\"score\": 0-10 整数（与用户研究方向的相关度），"
            f"\"reason\": 一句中文理由（仅 7 分以上给，其他给空字符串；可点出与用户哪方面兴趣相关）}}，只输出 JSON。"
        )
        try:
            resp = ai_client.chat(
                [{"role": "user", "content": prompt}], temperature=0.1, json_mode=True
            )
            data = ai_client.parse_json(resp)
            conn.execute(
                "UPDATE journal_feed SET relevance=?, relevance_reason=? WHERE id=?",
                (float(data.get("score", 0)), str(data.get("reason", ""))[:300], r["id"]),
            )
            conn.commit()
        except (ai_client.AINotConfigured, ai_client.AICallError) as e:
            print(f"[journal_score] {r['id']}: {e}")
            break


def add_journal_item_to_library(item_id: int) -> int:
    """期刊条目入库：复用 DOI 入库管道（add_by_id：Crossref 元数据 + OA PDF + AI 处理）。"""
    conn = get_db()
    row = conn.execute("SELECT * FROM journal_feed WHERE id=?", (item_id,)).fetchone()
    if row is None:
        raise ValueError("journal feed item not found")
    if row["added_paper_id"]:
        return row["added_paper_id"]

    # 写锁内"查重+插入"原子化：并发连点时在此排队，后来的请求能看到已入库结果
    conn.execute("BEGIN IMMEDIATE")
    try:
        added = conn.execute(
            "SELECT added_paper_id FROM journal_feed WHERE id=?", (item_id,)
        ).fetchone()["added_paper_id"]
        if added:
            conn.rollback()
            return added

        # 查重（同 DOI 已在库，DOI 大小写不敏感）
        dup = conn.execute(
            "SELECT id FROM papers WHERE doi=? COLLATE NOCASE", (row["doi"],)
        ).fetchone()
        if dup:
            conn.execute(
                "UPDATE journal_feed SET added_paper_id=? WHERE id=?", (dup["id"], item_id)
            )
            conn.commit()
            return dup["id"]

        # 走现有 DOI 入库流程：建 paper 记录 → process_paper 会补 Unpaywall OA PDF 与 AI 标签
        cur = conn.execute(
            """INSERT INTO papers(title, authors, year, venue, doi, abstract, source)
               VALUES(?,?,?,?,?,?,'journal_feed')""",
            (
                row["title"],
                row["authors"],
                int(row["published"][:4]) if row["published"] else None,
                row["venue"],
                row["doi"],
                row["abstract"],
            ),
        )
        paper_id = cur.lastrowid
        conn.execute(
            "UPDATE journal_feed SET added_paper_id=? WHERE id=?", (paper_id, item_id)
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    from . import jobs as J
    J.enqueue("process_paper", {"paper_id": paper_id})
    return paper_id


def _memory_block():
    """打分提示词用的记忆段：记忆摘要一行铺垫。"""
    mem = S.get_memory()
    return f"用户的研究记忆摘要：\n{mem}\n" if mem else ""


# ---------- 研究记忆摘要 ----------

def refresh_memory():
    """每周任务：聚合 文献 / 项目 / 近期对话，刷新研究记忆摘要（存 settings）。"""
    from datetime import datetime
    if not S.ai_configured():
        print("[memory] AI 未配置，跳过")
        return
    conn = get_db()

    # 文献：总数 + 高频标签 + 近 60 天新入库标题
    n_papers = conn.execute("SELECT COUNT(*) c FROM papers").fetchone()["c"]
    tag_counts = {}
    for r in conn.execute("SELECT tags FROM papers"):
        for t in (json.loads(r["tags"]) if r["tags"] else []):
            tag_counts[t] = tag_counts.get(t, 0) + 1
    top_tags = sorted(tag_counts.items(), key=lambda kv: -kv[1])[:12]
    recent = conn.execute(
        "SELECT title FROM papers WHERE created_at >= datetime('now', '-60 days') "
        "ORDER BY created_at DESC LIMIT 15"
    ).fetchall()

    # 项目：名称 + 描述 + 条目数
    projects = conn.execute(
        """SELECT p.name, p.description,
                  (SELECT COUNT(*) FROM papers WHERE projects LIKE '%' || p.name || '%') np,
                  (SELECT COUNT(*) FROM project_items WHERE project_id = p.id) ni
           FROM projects p"""
    ).fetchall()

    # 近期对话：最近 30 轮问答
    chats = conn.execute(
        "SELECT question, answer, created_at FROM chats ORDER BY created_at DESC LIMIT 30"
    ).fetchall()

    parts = [f"研究兴趣（用户自述）：{S.get('research_interests')}"]
    parts.append(f"文献库规模：{n_papers} 篇；高频标签：{', '.join(f'{t}({n})' for t, n in top_tags) or '无'}")
    if recent:
        parts.append("近 60 天新入库：" + "；".join(r["title"][:40] for r in recent))
    if projects:
        plines = [f"「{p['name']}」（文献 {p['np']}，条目 {p['ni']}）：{p['description'] or '无描述'}" for p in projects]
        parts.append("进行中的项目：\n" + "\n".join(plines))
    if chats:
        clines = [f"问：{c['question'][:80]}" for c in chats[:10]]
        parts.append("近期问过 AI 的问题：\n" + "\n".join(clines))
    prev = S.get_memory()
    if prev:
        parts.append("现有记忆摘要（在其基础上修订，保留仍然成立的内容）：\n" + prev[:2000])

    prompt = (
        "你是研究助理。请根据以下材料，更新用户的「研究记忆摘要」。"
        "摘要用中文，Markdown，包含小节：研究主线 / 当前关注点 / 进行中的项目 / 近期动向。"
        "只保留有信息量的内容，不要写空话，总长 300-500 字。\n\n" + "\n\n".join(parts)
    )
    try:
        # 不设 max_tokens：思考模型的推理会消耗输出预算，导致 content 为空
        summary = ai_client.chat([{"role": "user", "content": prompt}], temperature=0.3)
    except (ai_client.AINotConfigured, ai_client.AICallError) as e:
        print(f"[memory] {e}")
        return
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    S.update({"memory_summary": summary.strip(), "memory_updated_at": now})
    print(f"[memory] refreshed at {now}")


def log_chat(scope: str, question: str, answer: str):
    """把一轮 AI 问答落库（供记忆摘要参考）。失败不影响主流程。"""
    try:
        conn = get_db()
        conn.execute(
            "INSERT INTO chats(scope, question, answer) VALUES(?,?,?)",
            (scope, question[:2000], answer[:6000]),
        )
        conn.commit()
    except Exception as e:
        print(f"[log_chat] {e}")
