"""项目工作台：研究方向分组，收纳文献、自由笔记、实验记录。

文献归属存在 papers.projects（标签式，逗号 JSON），供文献库筛选复用；
笔记与实验记录存 project_items，随项目删除级联清除。
"""
import json
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..db import get_db
from ..routers.papers import _paper_out

router = APIRouter(prefix="/api/projects", tags=["projects"])


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
