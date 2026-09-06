"""项目工作台：研究方向分组，收纳文献、自由笔记、实验记录、LaTeX 文档。

文献归属存在 papers.projects（标签式，逗号 JSON），供文献库筛选复用；
笔记与实验记录存 project_items，随项目删除级联清除。
LaTeX 支持两种来源：手写（content 存 .tex 源码）或导入压缩包
（原始包存 LATEX_DIR/archives/，编译时解压以保留图片/参考文献等资源）。
"""
import json
import shutil
import subprocess
import tarfile
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..config import LATEX_DIR
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
    item_type: str = "note"       # note | result | latex
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
    # 笔记 / 实验记录 / LaTeX 文档
    items = []
    for x in conn.execute(
        "SELECT * FROM project_items WHERE project_id=? ORDER BY updated_at DESC",
        (project_id,),
    ):
        it = dict(x)
        if it["item_type"] == "latex":
            f = _latex_pdf_path(it["id"])
            it["pdf_ready"] = f.exists()
            if f.exists():
                it["compiled_at"] = datetime.fromtimestamp(f.stat().st_mtime).strftime("%m-%d %H:%M")
            # 归档项目（拖入压缩包）元信息
            src_dir = LATEX_DIR / "archives" / f"item_{it['id']}"
            if src_dir.exists() and any(src_dir.rglob("*.tex")):
                main = _find_main_tex(src_dir)
                it["archive"] = {
                    "main_tex": str(main.relative_to(src_dir)) if main else None,
                    "file_count": sum(1 for p in src_dir.rglob("*") if p.is_file()),
                }
        items.append(it)
    d["items"] = items
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
    # 清理项目下 LaTeX 条目的编译产物与源文件目录
    for r in conn.execute(
        "SELECT id FROM project_items WHERE project_id=? AND item_type='latex'", (project_id,)
    ).fetchall():
        (LATEX_DIR / f"item_{r['id']}.pdf").unlink(missing_ok=True)
        shutil.rmtree(LATEX_DIR / "archives" / f"item_{r['id']}", ignore_errors=True)
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
    if body.item_type not in ("note", "result", "latex"):
        raise HTTPException(400, "item_type 必须是 note、result 或 latex")
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
    # 顺带清理已编译的 PDF 和导入的源文件目录
    (LATEX_DIR / f"item_{item_id}.pdf").unlink(missing_ok=True)
    shutil.rmtree(LATEX_DIR / "archives" / f"item_{item_id}", ignore_errors=True)
    conn.commit()
    return {"ok": True}


def _latex_pdf_path(item_id: int) -> Path:
    return LATEX_DIR / f"item_{item_id}.pdf"


def _archive_dir(item_id: int) -> Path:
    """LaTeX 条目的源文件目录（拖入压缩包时解到这里）。"""
    d = LATEX_DIR / "archives" / f"item_{item_id}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _find_main_tex(root: Path) -> Path | None:
    """识别主 .tex：有 \\documentclass 的优先；多候选时取最短路径（通常是 main.tex）。"""
    candidates = []
    for p in root.rglob("*.tex"):
        try:
            head = p.read_text(encoding="utf-8", errors="ignore")[:4000]
        except OSError:
            continue
        if "\\documentclass" in head:
            candidates.append(p)
    if not candidates:
        texs = list(root.rglob("*.tex"))
        return min(texs, key=lambda p: len(p.parts)) if texs else None
    return min(candidates, key=lambda p: (len(p.parts), len(str(p))))


def _extract_archive(archive: Path, dest: Path):
    """安全解压 zip/tar 到 dest（拒绝绝对路径与 .. 穿越）。"""
    dest.mkdir(parents=True, exist_ok=True)
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as z:
            for m in z.namelist():
                target = (dest / m).resolve()
                if not str(target).startswith(str(dest.resolve())):
                    raise HTTPException(400, f"压缩包内含不安全路径：{m}")
            z.extractall(dest)
    elif tarfile.is_tarfile(archive):
        with tarfile.open(archive) as t:
            for m in t.getnames():
                target = (dest / m).resolve()
                if not str(target).startswith(str(dest.resolve())):
                    raise HTTPException(400, f"压缩包内含不安全路径：{m}")
            t.extractall(dest, filter="data")
    else:
        raise HTTPException(400, "不支持的压缩包格式（支持 .zip / .tar.gz / .tgz / .tar.bz2）")


def _log_errors(log_path: Path) -> str:
    """从 xelatex 日志提取报错行（! 开头）+ 上下文，失败则取尾部。"""
    if not log_path.exists():
        return ""
    text = log_path.read_text(encoding="utf-8", errors="ignore")
    lines = text.splitlines()
    errs = [l for l in lines if l.startswith("!")]
    if errs:
        out, capture = [], 0
        for i, l in enumerate(lines):
            if l.startswith("!"):
                capture = 6
            if capture > 0:
                out.append(l)
                capture -= 1
            if len(out) > 40:
                break
        return "\n".join(out)[:1800]
    return text[-1200:]


@router.post("/{project_id}/items/{item_id}/compile")
def compile_latex(project_id: int, item_id: int):
    """用 xelatex 编译 LaTeX 条目成 PDF（两遍以生成交叉引用）。

    有源文件目录（拖入过压缩包）时在目录内找主 .tex 编译（图片等资源可用）；
    否则编译 content 里的手写源码。
    """
    conn = get_db()
    _get_project(conn, project_id)
    r = conn.execute(
        "SELECT * FROM project_items WHERE id=? AND project_id=? AND item_type='latex'",
        (item_id, project_id),
    ).fetchone()
    if r is None:
        raise HTTPException(404, "LaTeX 文档不存在")

    src_dir = _archive_dir(item_id)
    has_project = src_dir.exists() and any(src_dir.rglob("*.tex"))
    if has_project:
        main_tex = _find_main_tex(src_dir)
        if main_tex is None:
            raise HTTPException(400, "压缩包里没有找到 .tex 文件")
        workdir = str(main_tex.parent)
        tex_name = main_tex.name
        pdf_name = main_tex.stem + ".pdf"
    else:
        src = r["content"] or ""
        if not src.strip():
            raise HTTPException(400, "文档内容为空")
        workdir = None
        tex_name = pdf_name = None

    try:
        if has_project:
            # 项目目录模式：复制到临时目录编译（不污染源目录），用户编辑的主 tex 内容一并写入
            with tempfile.TemporaryDirectory(dir=LATEX_DIR, prefix="build_") as td:
                build = Path(td) / "src"
                shutil.copytree(src_dir, build)
                if (r["content"] or "").strip():
                    (build / main_tex.relative_to(src_dir)).write_text(r["content"], encoding="utf-8")
                for _ in range(2):
                    proc = subprocess.run(
                        ["xelatex", "-interaction=nonstopmode", "-halt-on-error", tex_name],
                        cwd=build, capture_output=True, text=True, timeout=180,
                    )
                pdf = build / pdf_name
                log = build / (main_tex.stem + ".log")
                if not pdf.exists():
                    raise HTTPException(400, "编译失败：\n" + (_log_errors(log) or (proc.stderr or "")[-800:]))
                out = _latex_pdf_path(item_id)
                shutil.copyfile(pdf, out)
        else:
            with tempfile.TemporaryDirectory(dir=LATEX_DIR, prefix="build_") as td:
                (Path(td) / "doc.tex").write_text(src, encoding="utf-8")
                for _ in range(2):
                    proc = subprocess.run(
                        ["xelatex", "-interaction=nonstopmode", "-halt-on-error", "doc.tex"],
                        cwd=td, capture_output=True, text=True, timeout=180,
                    )
                pdf = Path(td) / "doc.pdf"
                log = Path(td) / "doc.log"
                if not pdf.exists():
                    raise HTTPException(400, "编译失败：\n" + (_log_errors(log) or (proc.stderr or "")[-800:]))
                out = _latex_pdf_path(item_id)
                shutil.copyfile(pdf, out)
        if not pdf.exists():
            raise HTTPException(400, "编译失败：\n" + (_log_errors(log) or (proc.stderr or "")[-800:]))
        out = _latex_pdf_path(item_id)
        shutil.copyfile(pdf, out)
    except subprocess.TimeoutExpired:
        raise HTTPException(400, "编译超时（超过 3 分钟），请检查文档是否有死循环命令")
    except HTTPException:
        raise
    except FileNotFoundError:
        raise HTTPException(500, "未找到 xelatex，请先安装 TeX Live（sudo apt install texlive-xetex texlive-lang-chinese）")

    ts = datetime.fromtimestamp(out.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
    return {"ok": True, "pdf_url": f"/api/projects/{project_id}/items/{item_id}/pdf", "compiled_at": ts}


@router.post("/{project_id}/latex_import")
async def import_latex_archive(project_id: int, file: UploadFile = File(...)):
    """拖入 LaTeX 项目压缩包：解压入库为 latex 条目，自动识别主 .tex。

    压缩包原样解压到 LATEX_DIR/archives/item_<id>/，保留图片、.bib 等资源，
    编译时在目录内完成。标题取主 .tex 的 \\title 或压缩包文件名。
    """
    conn = get_db()
    _get_project(conn, project_id)
    name = file.filename or "project.zip"
    if not name.lower().endswith((".zip", ".tar.gz", ".tgz", ".tar.bz2", ".tar")):
        raise HTTPException(400, "仅支持 .zip / .tar.gz / .tgz / .tar.bz2 / .tar 压缩包")

    import re as _re
    cur = conn.execute(
        "INSERT INTO project_items(project_id, item_type, title, content) VALUES(?,?,?,?)",
        (project_id, "latex", Path(name).stem, ""),
    )
    item_id = cur.lastrowid
    dest = _archive_dir(item_id)
    try:
        tmp = dest.parent / f"upload_{item_id}_{name}"
        with open(tmp, "wb") as f:
            f.write(await file.read())
        _extract_archive(tmp, dest)
        tmp.unlink(missing_ok=True)
        # 压缩包常见有一层同名顶层目录，拍平
        entries = [p for p in dest.iterdir()]
        if len(entries) == 1 and entries[0].is_dir():
            inner = entries[0]
            for child in inner.iterdir():
                shutil.move(str(child), str(dest / child.name))
            inner.rmdir()
        main = _find_main_tex(dest)
        if main is None:
            shutil.rmtree(dest, ignore_errors=True)
            conn.execute("DELETE FROM project_items WHERE id=?", (item_id,))
            conn.commit()
            raise HTTPException(400, "压缩包里没有找到 .tex 文件")
        # 标题：主 tex 的 \title{...} > 压缩包名
        title = Path(name).stem
        try:
            head = main.read_text(encoding="utf-8", errors="ignore")[:6000]
            m = _re.search(r"\\title\{([^}]{1,120})\}", head)
            if m:
                title = m.group(1).strip()
        except OSError:
            pass
        conn.execute(
            "UPDATE project_items SET title=?, updated_at=datetime('now','localtime') WHERE id=?",
            (title, item_id),
        )
        conn.commit()
        return {
            "ok": True, "id": item_id, "title": title,
            "main_tex": str(main.relative_to(dest)),
            "file_count": sum(1 for p in dest.rglob("*") if p.is_file()),
        }
    except HTTPException:
        conn.execute("DELETE FROM project_items WHERE id=?", (item_id,))
        conn.commit()
        shutil.rmtree(dest, ignore_errors=True)
        raise


@router.get("/{project_id}/items/{item_id}/pdf")
def latex_pdf(project_id: int, item_id: int):
    conn = get_db()
    _get_project(conn, project_id)
    r = conn.execute(
        "SELECT title FROM project_items WHERE id=? AND project_id=? AND item_type='latex'",
        (item_id, project_id),
    ).fetchone()
    if r is None:
        raise HTTPException(404, "LaTeX 文档不存在")
    f = _latex_pdf_path(item_id)
    if not f.exists():
        raise HTTPException(404, "尚未编译，先点「编译」生成 PDF")
    # inline：浏览器内直接预览；「⬇ 下载」按钮靠 <a download> 属性触发下载
    return FileResponse(f, media_type="application/pdf", filename=f"{r['title'] or 'document'}.pdf",
                        content_disposition_type="inline")


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
