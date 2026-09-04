"""标识符入库、引文网络（Semantic Scholar）、BibTeX 导出。"""
import json
import re
import urllib.request

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from .. import db as DB
from ..config import PDF_DIR
from ..db import get_db
from .. import jobs as J
from .. import metadata

router = APIRouter(prefix="/api", tags=["add-cite"])


# ---------- 标识符 / 链接直接入库 ----------

class AddByIdBody(BaseModel):
    identifier: str  # arXiv 链接/ID、DOI、或任意含标识符的文本


@router.post("/papers/add_by_id")
def add_by_id(body: AddByIdBody):
    text = body.identifier.strip()
    if not text:
        raise HTTPException(400, "请输入 arXiv 链接 / ID 或 DOI")

    arxiv_id = metadata.detect_arxiv_id(text)
    doi = None if arxiv_id else metadata.detect_doi(text)
    if not arxiv_id and not doi:
        raise HTTPException(400, "没能识别出 arXiv ID 或 DOI，请检查输入")

    conn = get_db()
    # 查重
    dup = conn.execute(
        "SELECT id FROM papers WHERE arxiv_id=? OR doi=?", (arxiv_id or "\x00", doi or "\x00")
    ).fetchone()
    if dup:
        return {"ok": True, "paper_id": dup["id"], "duplicate": True}

    # 抓元数据（arXiv 优先，还能拿到摘要；DOI 走 Crossref）
    if arxiv_id:
        meta = metadata.fetch_arxiv(arxiv_id)
        if not meta:
            raise HTTPException(400, f"arXiv 上找不到 {arxiv_id}，请检查 ID")
    else:
        try:
            meta = metadata.fetch_crossref(doi)
        except httpx.HTTPError as e:
            raise HTTPException(400, f"Crossref 请求失败：{e}")
        if not meta:
            raise HTTPException(400, f"Crossref 上找不到 {doi}，请检查 DOI")

    # arXiv 论文顺带下载 PDF（失败不阻塞入库）
    pdf_rel = None
    if arxiv_id:
        pdf_rel = _download_pdf(f"https://arxiv.org/pdf/{arxiv_id}", f"arxiv_{arxiv_id.replace('/', '_')}.pdf")

    cur = conn.execute(
        """INSERT INTO papers(title, authors, year, venue, doi, arxiv_id, abstract, source, pdf_path)
           VALUES(?,?,?,?,?,?,?,?,?)""",
        (
            meta["title"], json.dumps(meta["authors"], ensure_ascii=False), meta["year"],
            meta["venue"], meta["doi"], meta["arxiv_id"], meta["abstract"], "manual", pdf_rel,
        ),
    )
    conn.commit()
    paper_id = cur.lastrowid
    J.enqueue("process_paper", {"paper_id": paper_id})
    return {"ok": True, "paper_id": paper_id, "duplicate": False, "title": meta["title"]}


def _download_pdf(url: str, rel: str):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "research-hub/0.1"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
        if data[:4] == b"%PDF":
            (PDF_DIR / rel).write_bytes(data)
            return rel
    except Exception as e:
        print(f"[download_pdf] {url}: {e}")
    return None


# ---------- 引文网络（Semantic Scholar Graph API，无需 key） ----------

S2_BASE = "https://api.semanticscholar.org/graph/v1"
S2_FIELDS = "title,year,venue,abstract,externalIds,authors,citationCount"


def _s2_paper_id(paper: dict) -> str:
    if paper.get("arxiv_id"):
        return f"arXiv:{paper['arxiv_id']}"
    if paper.get("doi"):
        return f"DOI:{paper['doi']}"
    return None


@router.get("/papers/{paper_id}/citations")
def citations(paper_id: int, direction: str = "both", limit: int = 40):
    """参考文献（references）与被引（citations）。direction: refs | cited | both"""
    conn = get_db()
    row = conn.execute(
        "SELECT arxiv_id, doi, title, authors, year, venue FROM papers WHERE id=?", (paper_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(404)
    paper = DB.row_to_dict(row)
    s2_id = _s2_paper_id(paper)
    if not s2_id:
        raise HTTPException(400, "该文献没有 arXiv ID 或 DOI，无法查询引文网络")

    out = {"references": [], "citations": []}
    if direction in ("refs", "both"):
        out["references"] = _s2_get(f"/paper/{s2_id}/references", limit=limit)
    if direction in ("cited", "both"):
        out["citations"] = _s2_get(f"/paper/{s2_id}/citations", limit=limit)
    # 标记哪些已在库中
    _mark_in_library(conn, out)
    return out


def _s2_get(path: str, limit: int):
    try:
        r = httpx.get(
            f"{S2_BASE}{path}",
            params={"fields": S2_FIELDS, "limit": min(limit, 99)},
            timeout=30,
        )
        if r.status_code == 404:
            return []
        r.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Semantic Scholar 请求失败：{e}")
    data = r.json().get("data", [])
    items = []
    for d in data:
        p = d.get("citedPaper") or d.get("citingPaper") or {}
        ext = p.get("externalIds") or {}
        items.append(
            {
                "title": p.get("title"),
                "year": p.get("year"),
                "venue": p.get("venue"),
                "abstract": p.get("abstract"),
                "citationCount": p.get("citationCount"),
                "arxiv_id": ext.get("ArXiv"),
                "doi": ext.get("DOI"),
                "authors": [a.get("name") for a in (p.get("authors") or [])][:6],
            }
        )
    # 被引按引用数排序更有用
    items.sort(key=lambda x: -(x.get("citationCount") or 0))
    return items


def _mark_in_library(conn, out: dict):
    """给每条引文标 in_library + paper_id，方便前端一键跳转/入库。"""
    all_items = out.get("references", []) + out.get("citations", [])
    arxiv_ids = [it["arxiv_id"] for it in all_items if it["arxiv_id"]]
    dois = [it["doi"] for it in all_items if it["doi"]]
    in_lib = {}
    if arxiv_ids:
        q = ",".join("?" * len(arxiv_ids))
        for r in conn.execute(f"SELECT id, arxiv_id FROM papers WHERE arxiv_id IN ({q})", arxiv_ids):
            in_lib[f"a:{r['arxiv_id']}"] = r["id"]
    if dois:
        q = ",".join("?" * len(dois))
        for r in conn.execute(f"SELECT id, doi FROM papers WHERE doi IN ({q})", dois):
            in_lib[f"d:{r['doi']}"] = r["id"]
    for key in ("references", "citations"):
        for it in out.get(key, []):
            pid = in_lib.get(f"a:{it['arxiv_id']}") or in_lib.get(f"d:{it['doi']}")
            it["in_library"] = pid is not None
            it["paper_id"] = pid


class AddCitedBody(BaseModel):
    item: dict  # 引文条目（含 title/authors/arxiv_id/doi/...）


class QuickSummaryBody(BaseModel):
    item: dict  # 引文条目（未入库的，含 title/abstract）


@router.post("/citations/quick_summary")
def citations_quick_summary(body: QuickSummaryBody):
    """给引文网络中未入库的条目生成一句话速览（基于标题+摘要）。"""
    from .. import ai_client
    from .. import settings as S

    if not S.ai_configured():
        raise HTTPException(400, "请先在设置中配置 API Key")
    it = body.item
    title = (it.get("title") or "").strip()
    if not title:
        raise HTTPException(400, "条目缺标题")
    abstract = (it.get("abstract") or "").strip()[:3000]
    research = S.get("research_interests")
    prompt = (
        f"用户的研究方向：{research}\n\n"
        f"论文标题：{title}\n"
        f"摘要：{abstract or '（无摘要）'}\n\n"
        f"请用中文写一段 80-150 字的速览，包含：这篇论文做了什么、核心方法/发现、"
        f"与用户研究方向的关系（如明显不相关，直接说明属于什么领域）。只输出速览正文。"
    )
    answer = ai_client.chat([{"role": "user", "content": prompt}], temperature=0.3)
    return {"summary": answer.strip()}


@router.post("/papers/add_cited")
def add_cited(body: AddCitedBody):
    """把引文网络里的条目入库。有 arxiv_id 时顺带下载 PDF。"""
    it = body.item
    arxiv_id = it.get("arxiv_id")
    doi = it.get("doi")
    title = (it.get("title") or "").strip()
    if not title:
        raise HTTPException(400, "条目缺标题")

    conn = get_db()
    dup = conn.execute(
        "SELECT id FROM papers WHERE arxiv_id=? OR doi=?", (arxiv_id or "\x00", doi or "\x00")
    ).fetchone()
    if dup:
        return {"ok": True, "paper_id": dup["id"], "duplicate": True}

    # 有 arXiv ID 时用 arXiv 元数据（摘要更全），否则直接用 S2 给的信息
    if arxiv_id:
        try:
            meta = metadata.fetch_arxiv(arxiv_id)
        except httpx.HTTPError:
            meta = None
        if meta:
            pdf_rel = _download_pdf(f"https://arxiv.org/pdf/{arxiv_id}", f"arxiv_{arxiv_id.replace('/', '_')}.pdf")
        else:
            meta, pdf_rel = None, None
    else:
        meta, pdf_rel = None, None

    if meta is None:
        meta = {
            "title": title,
            "authors": it.get("authors") or [],
            "year": it.get("year"),
            "venue": it.get("venue") or "",
            "doi": doi,
            "arxiv_id": arxiv_id,
            "abstract": it.get("abstract") or "",
        }

    cur = conn.execute(
        """INSERT INTO papers(title, authors, year, venue, doi, arxiv_id, abstract, source, pdf_path)
           VALUES(?,?,?,?,?,?,?,?,?)""",
        (
            meta["title"], json.dumps(meta["authors"], ensure_ascii=False), meta["year"],
            meta["venue"], meta["doi"], meta["arxiv_id"], meta["abstract"], "manual", pdf_rel,
        ),
    )
    conn.commit()
    paper_id = cur.lastrowid
    J.enqueue("process_paper", {"paper_id": paper_id})
    return {"ok": True, "paper_id": paper_id, "duplicate": False, "title": meta["title"]}


# ---------- BibTeX 导出 ----------

@router.get("/papers/bibtex")
def bibtex_multi(ids: str):
    """ids: 逗号分隔的 paper id。"""
    pid_list = []
    for s in ids.split(","):
        s = s.strip()
        if s.isdigit():
            pid_list.append(int(s))
    if not pid_list:
        raise HTTPException(400, "没有有效的文献 id")
    conn = get_db()
    q = ",".join("?" * len(pid_list))
    rows = conn.execute(f"SELECT * FROM papers WHERE id IN ({q})", pid_list).fetchall()
    content = "\n\n".join(to_bibtex(DB.row_to_dict(r)) for r in rows)
    return Response(
        content=content,
        media_type="application/x-bibtex",
        headers={"Content-Disposition": 'attachment; filename="library.bib"'},
    )


@router.get("/papers/{paper_id}/bibtex")
def bibtex_one(paper_id: int):
    conn = get_db()
    row = conn.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    return Response(
        content=to_bibtex(DB.row_to_dict(row)),
        media_type="application/x-bibtex",
        headers={"Content-Disposition": 'attachment; filename="paper.bib"'},
    )


def _bibtex_key(p: dict) -> str:
    first = (p.get("authors") or ["unknown"])[0].strip() or "unknown"
    if re.search(r"[\u4e00-\u9fff]", first):
        # 中文人名：姓在开头
        family = re.sub(r"[^A-Za-z\u4e00-\u9fff]", "", first[:2])
    else:
        # 西文人名：姓在最后
        family = re.sub(r"[^A-Za-z]", "", first.split()[-1])
    return f"{family or 'unknown'}{p.get('year') or 'nd'}"


def to_bibtex(p: dict) -> str:
    key = _bibtex_key(p)
    is_arxiv = bool(p.get("arxiv_id")) and (p.get("venue") or "").lower() in ("arxiv", "")
    if is_arxiv:
        fields = [
            ("title", p.get("title")),
            ("author", " and ".join(p.get("authors") or [])),
            ("year", str(p.get("year") or "")),
            ("eprint", p.get("arxiv_id")),
            ("archivePrefix", "arXiv"),
            ("primaryClass", None),
        ]
        entry = "@article"
    elif p.get("venue"):
        fields = [
            ("title", p.get("title")),
            ("author", " and ".join(p.get("authors") or [])),
            ("journal", p.get("venue")),
            ("year", str(p.get("year") or "")),
            ("doi", p.get("doi")),
        ]
        entry = "@article"
    else:
        fields = [
            ("title", p.get("title")),
            ("author", " and ".join(p.get("authors") or [])),
            ("year", str(p.get("year") or "")),
            ("doi", p.get("doi")),
        ]
        entry = "@misc"
    lines = [f"{entry}{{{key},"]
    for name, val in fields:
        if val:
            val = str(val).replace("{", "").replace("}", "").replace("\n", " ").strip()
            lines.append(f"  {name} = {{{val}}},")
    lines.append("}")
    return "\n".join(lines)
