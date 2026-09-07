"""期刊订阅：自定义期刊（Crossref）→ 增量拉新论文 → 复用 DOI 入库管道。

与 arXiv 订阅平行的第二条订阅线：
- journal_subs：订阅的期刊（名称 + ISSN）
- journal_feed：抓到的最新论文条目
入库走 add_journal_item_to_library（DOI → Crossref 元数据 → Unpaywall OA → AI 标签）。
"""
import re

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..db import get_db
from .. import db as DB
from .. import jobs as J
from .. import metadata, tasks

router = APIRouter(prefix="/api/journals", tags=["journals"])


class SubCreate(BaseModel):
    query: str  # 期刊名称或 ISSN


# ---------- 订阅管理 ----------

@router.get("")
def list_subs():
    conn = get_db()
    rows = conn.execute(
        """SELECT s.*, COUNT(f.id) c, MAX(f.published) latest
           FROM journal_subs s LEFT JOIN journal_feed f ON f.sub_id = s.id
           GROUP BY s.id ORDER BY s.created_at DESC"""
    ).fetchall()
    return {"items": [dict(r) for r in rows]}


@router.post("")
async def create_sub(body: SubCreate):
    query = body.query.strip()
    if not query:
        raise HTTPException(400, "请输入期刊名称或 ISSN")
    conn = get_db()

    # ISSN 直查 / 名称模糊搜索，取第一个匹配
    try:
        if re.fullmatch(r"[\dxX-]{8,9}", query):
            cands = [{"name": query, "issn": query, "issns": [query]}]
        else:
            cands = metadata.search_journal(query)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Crossref 检索失败：{e}")
    if not cands:
        raise HTTPException(400, f"Crossref 上没有找到期刊「{query}」")
    # 名称最匹配的优先（完全一致 > 包含查询词 > 其余），同级取更短名
    ql = query.lower()
    cands.sort(key=lambda c: (0 if ql == c["name"].lower() else
                              1 if ql in c["name"].lower() else 2, len(c["name"])))
    cand = cands[0]

    exists = conn.execute(
        "SELECT id, name FROM journal_subs WHERE issn=? OR name=?", (cand["issn"], cand["name"])
    ).fetchone()
    if exists:
        return {"ok": True, "id": exists["id"], "name": exists["name"], "duplicate": True}
    cur = conn.execute(
        "INSERT INTO journal_subs(name, issn) VALUES(?, ?)", (cand["name"], cand["issn"])
    )
    conn.commit()
    return {"ok": True, "id": cur.lastrowid, "name": cand["name"], "duplicate": False}


@router.delete("/{sub_id}")
def delete_sub(sub_id: int):
    conn = get_db()
    if conn.execute("SELECT 1 FROM journal_subs WHERE id=?", (sub_id,)).fetchone() is None:
        raise HTTPException(404, "订阅不存在")
    conn.execute("DELETE FROM journal_subs WHERE id=?", (sub_id,))  # 条目级联删除
    conn.commit()
    return {"ok": True}


@router.post("/fetch")
def fetch_now():
    J.enqueue("fetch_journal_feed", {})
    return {"ok": True, "message": "期刊抓取任务已加入队列，完成后条目会出现在下方"}


@router.post("/score")
def score_now():
    """手动补打分（配置了 API Key 才有效）。"""
    J.enqueue("fetch_journal_feed", {})
    return {"ok": True, "message": "打分任务已加入队列"}


# ---------- 条目流 ----------

@router.get("/feed")
def list_items(hide_dismissed: bool = True, min_score: float | None = None):
    conn = get_db()
    sql = (
        "SELECT f.*, s.name AS sub_name FROM journal_feed f "
        "JOIN journal_subs s ON s.id = f.sub_id"
    )
    conds = []
    if hide_dismissed:
        conds.append("f.dismissed=0")
    if min_score is not None:
        conds.append(f"(f.relevance IS NULL OR f.relevance >= {float(min_score)})")
    if conds:
        sql += " WHERE " + " AND ".join(conds)
    # 已打分的按分数从高到低排前；未打分的按日期排后（等待补分）
    sql += " ORDER BY (f.relevance IS NULL) ASC, f.relevance DESC, f.published DESC, f.id DESC LIMIT 200"
    rows = conn.execute(sql).fetchall()
    items = []
    for r in rows:
        d = DB.row_to_dict(r)
        d["authors"] = d.get("authors") or []
        items.append(d)
    return {"items": items}


@router.post("/feed/{item_id}/dismiss")
def dismiss_item(item_id: int):
    conn = get_db()
    conn.execute("UPDATE journal_feed SET dismissed=1 WHERE id=?", (item_id,))
    conn.commit()
    return {"ok": True}


@router.post("/feed/{item_id}/add")
def add_item(item_id: int):
    conn = get_db()
    row = conn.execute("SELECT added_paper_id FROM journal_feed WHERE id=?", (item_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "条目不存在")
    paper_id = tasks.add_journal_item_to_library(item_id)
    return {"ok": True, "paper_id": paper_id, "duplicate": bool(row["added_paper_id"])}
