"""arXiv 订阅流 + Zotero 导入 + 项目/标签汇总 + 设置。"""
import json
import os
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from .. import db as DB
from ..db import get_db
from .. import jobs as J
from .. import settings as S
from .. import tasks
from .. import journalinfo

router = APIRouter(prefix="/api", tags=["misc"])


# ---------- 订阅流（arXiv + 期刊统一） ----------

@router.get("/feed")
def get_feed(
    limit: int = 300,
    hide_dismissed: bool = True,
    hide_added: bool = True,
    min_score: bool = False,
    source: str = "",   # 逗号分隔：'arxiv' 或期刊名；空 = 全部
):
    """统一订阅流：arXiv 推荐与期刊订阅 UNION 聚合，字段对齐，支持来源/高分/已忽略/已入库筛选。"""
    conn = get_db()
    conds, params = [], []
    if hide_dismissed:
        conds.append("dismissed=0")
    if hide_added:
        conds.append("added_paper_id IS NULL")
    if min_score:
        conds.append("(relevance IS NULL OR relevance >= 7)")
    if source:
        wants = [s.strip() for s in source.split(",") if s.strip()]
        src_conds = []
        if "arxiv" in wants:
            src_conds.append("source='arxiv'")
            wants = [w for w in wants if w != "arxiv"]
        if wants:
            src_conds.append(
                "source IN (SELECT 'journal' FROM journal_subs WHERE name IN "
                f"({','.join('?' * len(wants))}))"
            )
            params.extend(wants)
        if src_conds:
            conds.append("(" + " OR ".join(src_conds) + ")")
    where = (" WHERE " + " AND ".join(conds)) if conds else ""

    sql = f"""
        SELECT * FROM (
            SELECT id, 'arxiv' AS source, '' AS sub_name, title, authors, abstract,
                   primary_category AS venue, arxiv_id AS external_id,
                   'https://arxiv.org/abs/' || arxiv_id AS ext_url,
                   published, relevance, relevance_reason, dismissed, added_paper_id
            FROM feed_items
            UNION ALL
            SELECT f.id, 'journal', s.name, f.title, f.authors, f.abstract,
                   f.venue, f.doi, 'https://doi.org/' || f.doi,
                   f.published, f.relevance, f.relevance_reason, f.dismissed, f.added_paper_id
            FROM journal_feed f JOIN journal_subs s ON s.id = f.sub_id
        ){where}
        ORDER BY (relevance IS NULL) ASC, relevance DESC, published DESC, source, id DESC
        LIMIT {int(limit)}
    """
    rows = conn.execute(sql, params).fetchall()
    items = []
    for r in rows:
        d = DB.row_to_dict(r)
        d["authors"] = d.get("authors") or []
        items.append(d)

    # facets：各来源的未处理条目数（排除已忽略与已入库；来源行 = arXiv + 每个订阅期刊）
    added_cond = " AND f.added_paper_id IS NULL" if hide_added else ""
    jfacets = conn.execute(
        f"""SELECT s.name, COUNT(f.id) c FROM journal_subs s
           LEFT JOIN journal_feed f ON f.sub_id = s.id AND f.dismissed=0{added_cond}
           GROUP BY s.id ORDER BY s.name"""
    ).fetchall()
    added_cond_a = " AND added_paper_id IS NULL" if hide_added else ""
    n_arxiv = conn.execute(
        f"SELECT COUNT(*) c FROM feed_items WHERE dismissed=0{added_cond_a}"
    ).fetchone()["c"]
    facets = {
        "sources": [["arxiv", n_arxiv]] + [[r["name"], r["c"]] for r in jfacets],
        "total": n_arxiv + sum(r["c"] for r in jfacets),
    }
    return {"items": items, "facets": facets}


@router.post("/feed/fetch")
def fetch_now():
    J.enqueue("fetch_feed", {})
    return {"ok": True, "message": "已加入抓取队列"}


@router.post("/feed/{feed_id}/dismiss")
def dismiss_feed(feed_id: int):
    conn = get_db()
    conn.execute("UPDATE feed_items SET dismissed=1 WHERE id=?", (feed_id,))
    conn.commit()
    return {"ok": True}


@router.post("/feed/{source}/{item_id}/dismiss")
def dismiss_unified(source: str, item_id: int):
    """统一列表的忽略：按来源分流到各自表。"""
    conn = get_db()
    table = "feed_items" if source == "arxiv" else "journal_feed"
    conn.execute(f"UPDATE {table} SET dismissed=1 WHERE id=?", (item_id,))
    conn.commit()
    return {"ok": True}


@router.post("/feed/{feed_id}/add")
def add_feed(feed_id: int):
    try:
        paper_id = tasks.add_feed_item_to_library(feed_id)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"ok": True, "paper_id": paper_id}


# ---------- Zotero 导入 ----------

@router.post("/zotero/import")
async def zotero_import(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".json"):
        raise HTTPException(400, "请上传 Zotero 导出的 CSL JSON 文件")
    import uuid
    path = f"/tmp/zotero_{uuid.uuid4().hex}.json"
    with open(path, "wb") as f:
        f.write(await file.read())
    J.enqueue("import_zotero", {"path": path})
    return {"ok": True, "message": "导入任务已加入队列，处理完成后文献将出现在库中"}


# ---------- 项目 / 标签 ----------

@router.get("/facets")
def facets():
    conn = get_db()
    rows = conn.execute("SELECT tags, projects, status, year, venue FROM papers").fetchall()
    tag_counts, proj_counts, status_counts, year_counts, zone_counts = {}, {}, {}, {}, {}
    import json
    for r in rows:
        for t in _load(r["tags"]):
            tag_counts[t] = tag_counts.get(t, 0) + 1
        for p in _load(r["projects"]):
            proj_counts[p] = proj_counts.get(p, 0) + 1
        status_counts[r["status"]] = status_counts.get(r["status"], 0) + 1
        if r["year"]:
            year_counts[r["year"]] = year_counts.get(r["year"], 0) + 1
        z = (journalinfo.lookup(r["venue"]) or {}).get("z")
        if z:
            zone_counts[z] = zone_counts.get(z, 0) + 1
    return {
        "tags": _sorted(tag_counts),
        "projects": _sorted(proj_counts),
        "statuses": _sorted(status_counts),
        "years": sorted(year_counts.items(), key=lambda kv: -kv[0]),
        "zones": sorted(zone_counts.items(), key=lambda kv: kv[0]),
    }


# ---------- 知识图谱（双链 + 语义相似度） ----------

@router.get("/graph")
def graph(sim_threshold: float = 0.3):
    """节点 = 库内文献；边 = 笔记 [[双链]]（kind=link）+ 标签重合（kind=sim）。"""
    import re
    import json as _json
    conn = get_db()
    rows = conn.execute("SELECT id, title, status, starred, notes, tags FROM papers").fetchall()

    def title_key(s):
        return journalinfo.norm_name(re.sub(r"\.pdf$", "", s or "", flags=re.I))

    def parse_tags(raw):
        try:
            return set(_json.loads(raw)) if raw else set()
        except (ValueError, TypeError):
            return set()

    nodes, tmap, tagsets = [], {}, {}
    for r in rows:
        nodes.append({"id": r["id"], "title": r["title"], "status": r["status"], "starred": bool(r["starred"])})
        tmap[title_key(r["title"])] = r["id"]
        ts = parse_tags(r["tags"])
        if ts:
            tagsets[r["id"]] = ts

    edges, seen = [], set()

    def add_edge(a, b, kind):
        key = (min(a, b), max(a, b), kind)
        if a == b or key in seen:
            return
        seen.add(key)
        edges.append({"source": a, "target": b, "kind": kind})

    # 笔记 [[双链]]
    for r in rows:
        for name in re.findall(r"\[\[([^\]]+)\]\]", r["notes"] or ""):
            target = tmap.get(title_key(name))
            if target:
                add_edge(r["id"], target, "link")

    # 标签相似：Jaccard 重合度每节点取最高的 2 篇（有 AI 标签的文献才有 sim 边）
    if len(tagsets) >= 2:
        ids = list(tagsets.keys())
        for i, pi in enumerate(ids):
            sims = []
            for pj in ids[i + 1:]:
                inter = len(tagsets[pi] & tagsets[pj])
                if inter:
                    sims.append((pj, inter / len(tagsets[pi] | tagsets[pj])))
            sims.sort(key=lambda x: -x[1])
            for pj, s in sims[:2]:
                if s >= sim_threshold:
                    add_edge(pi, pj, "sim")

    return {"nodes": nodes, "edges": edges}


def _load(s):
    try:
        return json.loads(s or "[]")
    except json.JSONDecodeError:
        return []


def _sorted(counter):
    return sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))


# ---------- 任务状态 ----------

@router.get("/jobs")
def jobs_list(limit: int = 30):
    return {"items": J.list_jobs(limit)}


# ---------- 设置 ----------

class SettingsBody(BaseModel):
    api_base_url: str | None = None
    api_key: str | None = None
    chat_model: str | None = None
    reasoning_effort: str | None = None
    research_interests: str | None = None
    tag_preset: str | None = None
    arxiv_categories: str | None = None
    arxiv_keywords: str | None = None
    arxiv_max_results: str | None = None
    context_window: str | None = None
    memory_summary: str | None = None


@router.get("/settings")
def get_settings():
    d = S.get_all()
    # key 不明文回传，只回传是否已配置
    d["api_key"] = "••••••••" if d["api_key"] else ""
    d["api_key_set"] = bool(S.get("api_key"))
    return d


@router.post("/memory/refresh")
def refresh_memory_now():
    """立即刷新研究记忆摘要（后台任务）。"""
    J.enqueue("refresh_memory", {})
    return {"ok": True, "message": "记忆刷新任务已加入队列"}


@router.patch("/settings")
def update_settings(body: SettingsBody):
    d = body.model_dump(exclude_none=True)
    if d.get("api_key") and set(d["api_key"]) == {"•"}:
        d.pop("api_key")  # 掩码占位，不覆盖真 key
    S.update(d)
    return get_settings()


@router.post("/settings/test")
def test_ai():
    """测试 AI 连通性。"""
    try:
        resp = ai_client_test()
        return {"ok": True, "reply": resp}
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"{type(e).__name__}: {e}"}, status_code=400)


def ai_client_test():
    from .. import ai_client
    return ai_client.chat([{"role": "user", "content": "回复 OK 两个字母即可"}], temperature=0)


# ---------- 批注 ----------

class AnnotationBody(BaseModel):
    page: int
    kind: str = "highlight"
    color: str = "yellow"
    content: str = ""
    comment: str = ""
    rects: list = []


@router.get("/papers/{paper_id}/annotations")
def list_annotations(paper_id: int):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM annotations WHERE paper_id=? ORDER BY page, id", (paper_id,)
    ).fetchall()
    return {"items": [_annotation_out(r) for r in rows]}


def _annotation_out(r) -> dict:
    d = DB.row_to_dict(r)
    if isinstance(d.get("rects"), str):
        try:
            d["rects"] = json.loads(d["rects"])
        except json.JSONDecodeError:
            d["rects"] = []
    return d


@router.post("/papers/{paper_id}/annotations")
def create_annotation(paper_id: int, body: AnnotationBody):
    import json as _json
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO annotations(paper_id, page, kind, color, content, comment, rects) VALUES(?,?,?,?,?,?,?)",
        (paper_id, body.page, body.kind, body.color, body.content, body.comment,
         _json.dumps(body.rects, ensure_ascii=False)),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM annotations WHERE id=?", (cur.lastrowid,)).fetchone()
    return _annotation_out(row)


@router.delete("/annotations/{annotation_id}")
def delete_annotation(annotation_id: int):
    conn = get_db()
    conn.execute("DELETE FROM annotations WHERE id=?", (annotation_id,))
    conn.commit()
    return {"ok": True}
