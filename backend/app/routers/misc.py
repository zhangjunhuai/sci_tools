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


# ---------- arXiv 订阅流 ----------

@router.get("/feed")
def get_feed(limit: int = 100, hide_dismissed: bool = True):
    conn = get_db()
    sql = "SELECT * FROM feed_items"
    if hide_dismissed:
        sql += " WHERE dismissed=0"
    sql += " ORDER BY (relevance IS NULL), relevance DESC, created_at DESC LIMIT ?"
    rows = conn.execute(sql, (limit,)).fetchall()
    items = [DB.row_to_dict(r) for r in rows]
    for it in items:
        it["authors"] = it.get("authors") or []
    return {"items": items}


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
def graph(sim_threshold: float = 0.72):
    """节点 = 库内文献；边 = 笔记 [[双链]]（kind=link）+ 语义相似（kind=sim）。"""
    import re
    import numpy as np
    conn = get_db()
    rows = conn.execute("SELECT id, title, status, starred, notes, embedding FROM papers").fetchall()

    def title_key(s):
        return journalinfo.norm_name(re.sub(r"\.pdf$", "", s or "", flags=re.I))

    nodes, tmap, embeds = [], {}, {}
    for r in rows:
        nodes.append({"id": r["id"], "title": r["title"], "status": r["status"], "starred": bool(r["starred"])})
        tmap[title_key(r["title"])] = r["id"]
        if r["embedding"]:
            try:
                embeds[r["id"]] = np.frombuffer(r["embedding"], dtype=np.float32)
            except ValueError:
                pass

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

    # 语义相似：每节点取最相似的 2 篇（双向去重后保留）
    if len(embeds) >= 2:
        ids = list(embeds.keys())
        mat = np.stack([embeds[i] for i in ids])
        if len({m.shape for m in mat}) == 1:  # 向量维度一致才可比
            mat = mat / (np.linalg.norm(mat, axis=1, keepdims=True) + 1e-9)
            sims = mat @ mat.T
            for i, pi in enumerate(ids):
                for j in np.argsort(-sims[i])[1:3]:
                    if sims[i][j] >= sim_threshold:
                        add_edge(pi, ids[j], "sim")

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
    embed_model: str | None = None
    reasoning_effort: str | None = None
    research_interests: str | None = None
    tag_preset: str | None = None
    arxiv_categories: str | None = None
    arxiv_keywords: str | None = None
    arxiv_max_results: str | None = None


@router.get("/settings")
def get_settings():
    d = S.get_all()
    # key 不明文回传，只回传是否已配置
    d["api_key"] = "••••••••" if d["api_key"] else ""
    d["api_key_set"] = bool(S.get("api_key"))
    return d


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
