"""AI 功能：划选翻译、单篇/全库 RAG 问答、跨文献对比表。"""
import re
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from .. import ai_client
from .. import settings as S
from ..db import get_db

router = APIRouter(prefix="/api/ai", tags=["ai"])


class AskBody(BaseModel):
    question: str
    paper_ids: list[int] = []   # 空 = 全库检索


class CompareBody(BaseModel):
    paper_ids: list[int]


class TranslateBody(BaseModel):
    text: str


@router.post("/translate")
def translate(body: TranslateBody):
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "内容为空")
    if not S.ai_configured():
        raise HTTPException(400, "请先在设置中配置 API Key")
    text = text[:4000]
    answer = ai_client.chat(
        [
            {
                "role": "system",
                "content": "把文本准确翻译为中文。术语准确，专业名词、模型名、人名保留英文。只输出译文。",
            },
            {"role": "user", "content": text},
        ],
        temperature=0,
        max_tokens=3000,
    )
    return {"translation": answer.strip()}


@router.post("/ask")
def ask(body: AskBody):
    question = body.question.strip()
    if not question:
        raise HTTPException(400, "问题不能为空")
    if not S.ai_configured():
        raise HTTPException(400, "请先在设置中配置 API Key")

    conn = get_db()
    contexts = _gather_context(conn, question, body.paper_ids)
    if not contexts:
        raise HTTPException(400, "没有找到相关文献内容（库为空或文献尚未处理完成）")

    ctx_text = "\n\n".join(
        f"【来源 {i+1}】论文#{c['paper_id']}《{c['title']}》第{c.get('para_idx', '?')}段附近：\n{c['text']}"
        for i, c in enumerate(contexts)
    )
    titles = sorted({c["title"] for c in contexts})
    messages = [
        {
            "role": "system",
            "content": (
                "你是一名科研文献阅读助手。根据提供的文献片段回答用户问题，"
                "用中文回答；引用信息时标注来源编号（如【来源1】）。"
                "如果片段信息不足以回答，就直说不足。"
                f"本次涉及的文献：{ '、'.join(titles[:10]) }"
            ),
        },
        {"role": "user", "content": f"文献片段：\n{ctx_text}\n\n问题：{question}"},
    ]
    answer = ai_client.chat(messages, temperature=0.3)
    return {
        "answer": answer,
        "sources": [
            {"paper_id": c["paper_id"], "title": c["title"], "snippet": c["text"][:200]}
            for c in contexts
        ],
    }


@router.post("/compare")
def compare(body: CompareBody):
    """跨文献对比：勾选多篇 → 每篇提取 方法/数据集/核心结论/局限，生成对比表。"""
    if not S.ai_configured():
        raise HTTPException(400, "请先在设置中配置 API Key")
    ids = list(dict.fromkeys(body.paper_ids))  # 去重、保持勾选顺序
    if len(ids) < 2:
        raise HTTPException(400, "请至少勾选 2 篇文献再进行对比")
    if len(ids) > 8:
        raise HTTPException(400, "一次最多对比 8 篇文献，请先精简勾选")

    conn = get_db()
    papers = []
    skipped = []
    for pid in ids:
        r = conn.execute(
            "SELECT id, title, abstract, pdf_text FROM papers WHERE id=?", (pid,)
        ).fetchone()
        if r and (r["pdf_text"] or r["abstract"]):
            papers.append(r)
        else:
            skipped.append(r["title"] if r else f"#{pid}")
    if len(papers) < 2:
        raise HTTPException(400, "可对比的文献不足 2 篇（其余文献尚未处理完成或没有 PDF/摘要）")

    blocks = []
    for i, p in enumerate(papers):
        blocks.append(f"【论文{i + 1}】编号#{p['id']}《{p['title']}》\n{_excerpt(p)}")

    messages = [
        {
            "role": "system",
            "content": (
                "你是一名科研文献对比助手。根据给出的论文节选文本，逐篇用中文提取四个维度："
                "method（方法：核心技术路线/模型/关键设计，1-2 句）、"
                "datasets（数据集：使用的数据集、实验对象或评测基准）、"
                "findings（核心结论：主要实验结果或核心观点，1-2 句）、"
                "limitations（局限：作者自述或明显可见的局限，1-2 句）。"
                "节选中找不到的信息填「文中未明确」，不要编造。"
                "严格按照输入顺序，每篇论文输出一行。只输出 JSON，格式：\n"
                '{"rows": [{"paper_id": 论文编号, "method": "...", "datasets": "...", '
                '"findings": "...", "limitations": "..."}], '
                '"overall": "整体对比：各篇的共同点、关键差异与互补之处，2-3 句"}'
            ),
        },
        {"role": "user", "content": f"请对比以下 {len(papers)} 篇论文：\n\n" + "\n\n".join(blocks)},
    ]
    try:
        raw = ai_client.chat(messages, temperature=0.2, json_mode=True, max_tokens=4000)
        data = ai_client.parse_json(raw)
    except ai_client.AICallError as e:
        raise HTTPException(502, f"AI 调用失败：{e}")
    except Exception:
        raise HTTPException(502, "AI 返回格式异常，请重试")

    model_rows = data.get("rows") if isinstance(data, dict) else None
    if not isinstance(model_rows, list) or not model_rows:
        raise HTTPException(502, "AI 返回格式异常，请重试")
    # 按 paper_id 匹配模型输出，匹配不上退化为按输入顺序
    by_id = {}
    for r in model_rows:
        if isinstance(r, dict) and r.get("paper_id") in ids:
            by_id[r["paper_id"]] = r

    def field(r, key):
        v = r.get(key) if isinstance(r, dict) else None
        return (str(v).strip() if v else "") or "文中未明确"

    rows = []
    for i, p in enumerate(papers):
        r = by_id.get(p["id"]) or (model_rows[i] if i < len(model_rows) else {})
        rows.append({
            "paper_id": p["id"],
            "title": p["title"],
            "method": field(r, "method"),
            "datasets": field(r, "datasets"),
            "findings": field(r, "findings"),
            "limitations": field(r, "limitations"),
        })
    return {
        "rows": rows,
        "overall": (data.get("overall") or "").strip() if isinstance(data, dict) else "",
        "skipped": skipped,
    }


def _excerpt(p, head: int = 5000, tail: int = 2500) -> str:
    """单篇论文节选：摘要 + 正文开头（引言/方法）+ 结尾（结论/局限），控制 token 用量。"""
    parts = []
    abstract = (p["abstract"] or "").strip()
    text = (p["pdf_text"] or "").strip()
    if abstract:
        parts.append(f"摘要：{abstract[:1200]}")
    if text:
        body = text[:head]
        if len(text) > head + tail:
            body += "\n…（中间省略）…\n" + text[-tail:]
        parts.append(f"正文节选：{body}")
    return "\n".join(parts) if parts else "（无可用文本）"


def _gather_context(conn, question: str, paper_ids: list, top_k: int = 6):
    """选定文献（或全库语义检索）→ 段落级打分取最相关片段。"""
    import numpy as np

    if paper_ids:
        papers = []
        for pid in paper_ids:
            r = conn.execute(
                "SELECT id, title, pdf_text, abstract FROM papers WHERE id=?", (pid,)
            ).fetchone()
            if r:
                papers.append(r)
        # 语义可用时先粗筛段落，否则词面打分
        scored = []
        use_vec = S.ai_configured()
        qvec = None
        if use_vec:
            try:
                qvec = ai_client.embed([question])[0]
            except ai_client.AICallError:
                use_vec = False
        for p in papers:
            paras = _paragraphs(p["pdf_text"] or p["abstract"] or "")
            for i, para in enumerate(paras):
                if len(para) < 40:
                    continue
                if use_vec:
                    para_vec = ai_client.embed([para])[0]
                    score = float(np.dot(para_vec / (np.linalg.norm(para_vec) + 1e-9),
                                         qvec / (np.linalg.norm(qvec) + 1e-9)))
                else:
                    score = _term_overlap(question, para)
                scored.append({"paper_id": p["id"], "title": p["title"], "para_idx": i + 1, "text": para, "score": score})
        scored.sort(key=lambda x: -x["score"])
        return scored[:top_k]

    # 全库：先语义选论文，再在论文内选段落
    if not S.ai_configured():
        raise HTTPException(400, "全库问答需要配置 API Key（用于语义检索）")
    qvec = ai_client.embed([question])[0]
    rows = conn.execute("SELECT id, title, embedding, pdf_text, abstract FROM papers WHERE embedding IS NOT NULL").fetchall()
    if not rows:
        raise HTTPException(400, "库中还没有可检索的文献")
    import numpy as np
    mat = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
    mat = mat / (np.linalg.norm(mat, axis=1, keepdims=True) + 1e-9)
    qv = qvec / (np.linalg.norm(qvec) + 1e-9)
    sims = mat @ qv
    top_papers = [rows[i] for i in np.argsort(-sims)[:3]]
    scored = []
    for p in top_papers:
        paras = _paragraphs(p["pdf_text"] or p["abstract"] or "")
        if not paras:
            continue
        para_vecs = ai_client.embed(paras[:120])
        para_vecs = para_vecs / (np.linalg.norm(para_vecs, axis=1, keepdims=True) + 1e-9)
        psims = para_vecs @ qv
        best = np.argsort(-psims)[:2]
        for i in best:
            if len(paras[i]) >= 40:
                scored.append({"paper_id": p["id"], "title": p["title"], "para_idx": i + 1,
                               "text": paras[i], "score": float(psims[i])})
    scored.sort(key=lambda x: -x["score"])
    return scored[:top_k]


def _paragraphs(text: str):
    """按空行分段，过滤过短段落。"""
    paras = [p.strip() for p in re.split(r"\n\s*\n", text or "") if len(p.strip()) >= 40]
    if not paras and text:
        paras = [text[:3000]]
    return paras[:200]


def _term_overlap(question: str, para: str) -> float:
    terms = [t for t in re.split(r"[\s,，。?？!！:：]+", question) if len(t) >= 2]
    if not terms:
        return 0.0
    return sum(1 for t in terms if t.lower() in para.lower()) / len(terms)
