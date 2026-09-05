"""项目工作台：研究方向分组，收纳文献、自由笔记、实验记录。

文献归属存在 papers.projects（标签式，逗号 JSON），供文献库筛选复用；
笔记与实验记录存 project_items，随项目删除级联清除。
"""
import json
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..db import get_db
from .. import settings as S
from .. import db as DB
from ..routers.papers import _paper_out

router = APIRouter(prefix="/api/projects", tags=["projects"])

# 估算 token 用量：中文约 1 字/token，英文约 4 字符/token，取两者折中
CHARS_PER_TOKEN = 2
# 预留：系统提示 + 用户问题 + 模型输出
RESERVED_TOKENS = 4000


class ProjectCreate(BaseModel):
    name: str
    description: str = ""


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class ItemCreate(BaseModel):
    item_type: str = "note"       # note | result
    title: str = ""
    content: str = ""


class ItemUpdate(BaseModel):
    title: str | None = None
    content: str | None = None


class PapersBody(BaseModel):
    paper_ids: list[int]


def _get_project(conn, project_id: int):
    r = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    if r is None:
        raise HTTPException(404, "项目不存在")
    return r


@router.get("")
def list_projects():
    conn = get_db()
    rows = conn.execute("SELECT * FROM projects ORDER BY created_at DESC").fetchall()
    counts = {
        r["project_id"]: r["c"]
        for r in conn.execute(
            "SELECT project_id, COUNT(*) c FROM project_items GROUP BY project_id"
        )
    }
    paper_counts = {}
    for r in conn.execute("SELECT projects, id FROM papers"):
        for p in json.loads(r["projects"] or "[]"):
            paper_counts[p] = paper_counts.get(p, 0) + 1
    items = []
    for r in rows:
        d = dict(r)
        d["note_count"] = counts.get(r["id"], 0)
        d["paper_count"] = paper_counts.get(r["name"], 0)
        items.append(d)
    return {"items": items}


@router.post("")
def create_project(body: ProjectCreate):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "项目名称不能为空")
    conn = get_db()
    if conn.execute("SELECT 1 FROM projects WHERE name=?", (name,)).fetchone():
        raise HTTPException(400, f"项目「{name}」已存在")
    cur = conn.execute(
        "INSERT INTO projects(name, description) VALUES(?, ?)",
        (name, body.description.strip()),
    )
    conn.commit()
    return {"ok": True, "id": cur.lastrowid}


@router.get("/{project_id}")
def get_project(project_id: int):
    conn = get_db()
    r = _get_project(conn, project_id)
    d = dict(r)
    # 文献：papers.projects 里存的是项目名
    papers = conn.execute(
        "SELECT * FROM papers WHERE projects LIKE ? ORDER BY created_at DESC",
        (f'%"{d["name"]}"%',),
    ).fetchall()
    d["papers"] = [_paper_out(p) for p in papers]
    # 笔记 / 实验记录
    items = conn.execute(
        "SELECT * FROM project_items WHERE project_id=? ORDER BY updated_at DESC",
        (project_id,),
    ).fetchall()
    d["items"] = [dict(x) for x in items]
    # 全库文献简要列表（前端添加文献弹窗用）
    all_papers = conn.execute(
        "SELECT id, title, year, venue FROM papers ORDER BY created_at DESC LIMIT 2000"
    ).fetchall()
    d["all_papers"] = [dict(x) for x in all_papers]
    return d


@router.patch("/{project_id}")
def update_project(project_id: int, body: ProjectUpdate):
    conn = get_db()
    project = _get_project(conn, project_id)
    d = body.model_dump(exclude_none=True)
    if "name" in d:
        new_name = d["name"].strip()
        if not new_name:
            raise HTTPException(400, "项目名称不能为空")
        if conn.execute(
            "SELECT 1 FROM projects WHERE name=? AND id!=?", (new_name, project_id)
        ).fetchone():
            raise HTTPException(400, f"项目「{new_name}」已存在")
        # 同步 papers 里的项目名
        _rename_project_in_papers(conn, project["name"], new_name)
        d["name"] = new_name
    if d:
        sets = ", ".join(f"{k}=?" for k in d)
        conn.execute(f"UPDATE projects SET {sets} WHERE id=?", list(d.values()) + [project_id])
        conn.commit()
    return get_project(project_id)


def _rename_project_in_papers(conn, old: str, new: str):
    for r in conn.execute("SELECT id, projects FROM papers WHERE projects LIKE ?", (f'%"{old}"%',)).fetchall():
        names = json.loads(r["projects"] or "[]")
        names = [new if n == old else n for n in names]
        conn.execute(
            "UPDATE papers SET projects=? WHERE id=?",
            (json.dumps(names, ensure_ascii=False), r["id"]),
        )


@router.delete("/{project_id}")
def delete_project(project_id: int):
    conn = get_db()
    project = _get_project(conn, project_id)
    # 不动 papers.projects：删除项目保留文献上的历史标签会误导，一并清理
    for r in conn.execute(
        "SELECT id, projects FROM papers WHERE projects LIKE ?", (f'%"{project["name"]}"%',)
    ).fetchall():
        names = [n for n in json.loads(r["projects"] or "[]") if n != project["name"]]
        conn.execute(
            "UPDATE papers SET projects=? WHERE id=?",
            (json.dumps(names, ensure_ascii=False), r["id"]),
        )
    conn.execute("DELETE FROM project_items WHERE project_id=?", (project_id,))
    conn.execute("DELETE FROM projects WHERE id=?", (project_id,))
    conn.commit()
    return {"ok": True}


# ---------- 文献关联 ----------

@router.post("/{project_id}/papers")
def add_papers(project_id: int, body: PapersBody):
    conn = get_db()
    name = _get_project(conn, project_id)["name"]
    added = 0
    for pid in body.paper_ids:
        r = conn.execute("SELECT id, projects FROM papers WHERE id=?", (pid,)).fetchone()
        if r is None:
            continue
        names = json.loads(r["projects"] or "[]")
        if name not in names:
            names.append(name)
            conn.execute(
                "UPDATE papers SET projects=? WHERE id=?",
                (json.dumps(names, ensure_ascii=False), pid),
            )
            added += 1
    conn.commit()
    return {"ok": True, "added": added}


@router.delete("/{project_id}/papers/{paper_id}")
def remove_paper(project_id: int, paper_id: int):
    conn = get_db()
    name = _get_project(conn, project_id)["name"]
    r = conn.execute("SELECT projects FROM papers WHERE id=?", (paper_id,)).fetchone()
    if r is None:
        raise HTTPException(404, "文献不存在")
    names = [n for n in json.loads(r["projects"] or "[]") if n != name]
    conn.execute(
        "UPDATE papers SET projects=? WHERE id=?",
        (json.dumps(names, ensure_ascii=False), paper_id),
    )
    conn.commit()
    return {"ok": True}


# ---------- 笔记 / 实验记录 ----------

@router.post("/{project_id}/items")
def create_item(project_id: int, body: ItemCreate):
    conn = get_db()
    _get_project(conn, project_id)
    if body.item_type not in ("note", "result"):
        raise HTTPException(400, "item_type 必须是 note 或 result")
    cur = conn.execute(
        "INSERT INTO project_items(project_id, item_type, title, content) VALUES(?,?,?,?)",
        (project_id, body.item_type, body.title.strip(), body.content),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM project_items WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)


@router.patch("/{project_id}/items/{item_id}")
def update_item(project_id: int, item_id: int, body: ItemUpdate):
    conn = get_db()
    _get_project(conn, project_id)
    r = conn.execute(
        "SELECT * FROM project_items WHERE id=? AND project_id=?", (item_id, project_id)
    ).fetchone()
    if r is None:
        raise HTTPException(404, "条目不存在")
    d = body.model_dump(exclude_none=True)
    if d:
        d["updated_at"] = "datetime('now','localtime')"
        sets = ", ".join(
            "updated_at=datetime('now','localtime')" if k == "updated_at" else f"{k}=?"
            for k in d
        )
        conn.execute(
            f"UPDATE project_items SET {sets} WHERE id=?",
            [v for k, v in d.items() if k != "updated_at"] + [item_id],
        )
        conn.commit()
    return dict(conn.execute("SELECT * FROM project_items WHERE id=?", (item_id,)).fetchone())


@router.delete("/{project_id}/items/{item_id}")
def delete_item(project_id: int, item_id: int):
    conn = get_db()
    _get_project(conn, project_id)
    conn.execute("DELETE FROM project_items WHERE id=? AND project_id=?", (item_id, project_id))
    conn.commit()
    return {"ok": True}


# ---------- 项目 AI 助手 ----------

class ProjectAskBody(BaseModel):
    question: str
    include_papers: bool = True       # 权限：项目文献
    include_notes: bool = True        # 权限：项目笔记
    include_results: bool = True      # 权限：实验记录
    paper_ids: list[int] = []         # 范围：空 = 项目全部文献


@router.post("/{project_id}/ai_ask")
def project_ai_ask(project_id: int, body: ProjectAskBody):
    """项目内 AI 问答：按权限与勾选范围组装上下文，受上下文窗口预算约束。

    返回 answer、实际注入的 sources（含各类目 token 占用），前端据此展示用量。
    """
    from .. import ai_client

    question = body.question.strip()
    if not question:
        raise HTTPException(400, "问题不能为空")
    if not S.ai_configured():
        raise HTTPException(400, "请先在设置中配置 API Key")

    conn = get_db()
    name = _get_project(conn, project_id)["name"]
    try:
        window = max(4096, int(S.get("context_window") or 32768))
    except ValueError:
        window = 32768
    budget = window - RESERVED_TOKENS

    # ---- 组装素材（按 权限 → 勾选范围）----
    sections = []          # [(类别, 标题, 文本)]
    used = {"papers": 0, "notes": 0, "results": 0}
    truncated = False

    if body.include_papers:
        sql = "SELECT * FROM papers WHERE projects LIKE ?"
        params: list = [f'%"{name}"%']
        if body.paper_ids:
            sql += f" AND id IN ({','.join('?' * len(body.paper_ids))})"
            params.extend(body.paper_ids)
        sql += " ORDER BY created_at DESC"
        for r in conn.execute(sql, params):
            p = DB.row_to_dict(r)
            text = f"《{p['title']}》（{p.get('venue') or ''} {p.get('year') or ''}）\n摘要：{(p.get('abstract') or '（无）')[:1200]}"
            if p.get("ai_summary"):
                text += f"\nAI 摘要：{p['ai_summary'][:1500]}"
            sections.append(("papers", p["title"], text))

    if body.include_notes or body.include_results:
        types = [t for t, on in (("note", body.include_notes), ("result", body.include_results)) if on]
        q = ",".join("?" * len(types))
        for r in conn.execute(
            f"SELECT * FROM project_items WHERE project_id=? AND item_type IN ({q}) ORDER BY updated_at DESC",
            [project_id] + types,
        ):
            label = "笔记" if r["item_type"] == "note" else "实验记录"
            cat = "notes" if r["item_type"] == "note" else "results"
            title = r["title"] or "（无标题）"
            sections.append((cat, title, f"{label}「{title}」\n{r['content']}"))

    # ---- 按预算裁剪：题目相关度打分放前面，超预算截断 ----
    ql = question.lower()
    sections.sort(key=lambda s: -(sum(1 for w in ql.split() if len(w) >= 2 and w in s[2].lower())
                                  + (1 if name in s[2] else 0)))
    blocks, sources = [], []
    for cat, title, text in sections:
        tokens = len(text) // CHARS_PER_TOKEN
        if budget - used["papers"] - used["notes"] - used["results"] < tokens:
            # 单条超预算：截断到剩余空间的一半，尽量保留
            remain = budget - sum(used.values())
            if remain < 500:
                truncated = True
                break
            text = text[: remain * CHARS_PER_TOKEN] + "…（因上下文预算截断）"
            tokens = len(text) // CHARS_PER_TOKEN
            truncated = True
        used[cat] += tokens
        blocks.append(text)
        sources.append({"category": cat, "title": title[:60], "tokens": tokens})

    if not blocks:
        raise HTTPException(400, "没有可注入的上下文：项目里没有匹配权限范围的文献/笔记/实验记录")

    research = S.get("research_interests")
    system = (
        f"你是项目「{name}」的科研 AI 助手。用户的研究方向：{research}。\n"
        "根据提供的项目资料（文献摘要/AI 摘要、项目笔记、实验记录）用中文回答问题；"
        "引用资料时注明来源名（如《标题》或笔记/实验记录名）；资料不足以回答时直说不足，不要编造。"
        + ("（注意：部分资料因超出上下文预算被截断或未注入。）" if truncated else "")
    )
    user = "项目资料：\n\n" + "\n\n".join(blocks) + f"\n\n问题：{question}"
    try:
        answer = ai_client.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.3,
            max_tokens=min(3000, window - sum(used.values()) - 500),
        )
    except ai_client.AICallError as e:
        raise HTTPException(502, f"AI 调用失败：{e}")

    total = sum(used.values()) + len((system + user + answer)) // CHARS_PER_TOKEN
    return {
        "answer": answer,
        "sources": sources,
        "usage": {
            "window": window,
            "papers": used["papers"],
            "notes": used["notes"],
            "results": used["results"],
            "total": total,
        },
        "truncated": truncated,
    }
