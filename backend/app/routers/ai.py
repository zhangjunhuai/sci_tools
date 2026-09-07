"""AI 功能：划选翻译、单篇/全库 RAG 问答、跨文献对比表。"""
import re
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from .. import ai_client
from .. import settings as S
from .. import tasks
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
    mem = S.get_memory()
    mem_line = f"\n用户的研究记忆摘要（回答时可结合其研究背景个性化）：\n{mem}" if mem else ""
    messages = [
        {
            "role": "system",
            "content": (
                "你是一名科研文献阅读助手。根据提供的文献片段回答用户问题，"
                "用中文回答；引用信息时标注来源编号（如【来源1】）。"
                "如果片段信息不足以回答，就直说不足。"
                f"本次涉及的文献：{ '、'.join(titles[:10]) }"
                f"{mem_line}"
            ),
        },
        {"role": "user", "content": f"文献片段：\n{ctx_text}\n\n问题：{question}"},
    ]
    answer = ai_client.chat(messages, temperature=0.3)
    tasks.log_chat(f"paper:{body.paper_ids[0]}" if body.paper_ids else "global", question, answer)
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


def _query_terms(question: str) -> list:
    """检索词：聊天模型提炼 3-6 个术语（失败退化为按标点切词）。"""
    if S.ai_configured():
        try:
            resp = ai_client.chat(
                [{"role": "user", "content":
                    "从下面的问题中提取 3-6 个最适合在文献库做全文检索的术语或短语"
                    "（保留中英文原样，去掉虚词），"
                    '输出 JSON：{"keywords": ["..."] }。\n问题：' + question}],
                temperature=0.1, json_mode=True, max_tokens=200,
            )
            data = ai_client.parse_json(resp)
            kws = [str(k).strip() for k in data.get("keywords", []) if str(k).strip()]
            if kws:
                return kws[:6]
        except (ai_client.AINotConfigured, ai_client.AICallError, ValueError):
            pass
    return [w for w in re.split(r"[\s,，。?？!！:：]+", question) if len(w) >= 2][:6]


def _select_papers(conn, terms: list, limit: int = 3):
    """按检索词在 标题/摘要/全文/标签 的命中数给论文排序（FTS 索引）。"""
    from .papers import _fts_query
    counts = {}
    for t in terms:
        for pid in _fts_query(conn, t) or []:
            counts[pid] = counts.get(pid, 0) + 1
    out = []
    for pid in sorted(counts, key=lambda i: -counts[i])[:limit]:
        r = conn.execute(
            "SELECT id, title, pdf_text, abstract FROM papers WHERE id=?", (pid,)
        ).fetchone()
        if r:
            out.append(r)
    return out


def _gather_context(conn, question: str, paper_ids: list, top_k: int = 6):
    """选定文献（或全库检索）→ 段落词面打分取最相关片段。

    服务商不支持 /v1/embeddings：检索词由聊天模型提炼，选论文走 FTS，段落用词面重合打分。
    """
    terms = _query_terms(question)

    if paper_ids:
        papers = []
        for pid in paper_ids:
            r = conn.execute(
                "SELECT id, title, pdf_text, abstract FROM papers WHERE id=?", (pid,)
            ).fetchone()
            if r:
                papers.append(r)
        scored = []
        for p in papers:
            paras = _paragraphs(p["pdf_text"] or p["abstract"] or "")
            for i, para in enumerate(paras):
                if len(para) < 40:
                    continue
                scored.append({"paper_id": p["id"], "title": p["title"], "para_idx": i + 1,
                               "text": para, "score": _term_overlap(terms, para)})
        scored.sort(key=lambda x: -x["score"])
        return scored[:top_k]

    # 全库：检索词命中数选论文 → 每篇取词面分最高的 2 段
    if not S.ai_configured():
        raise HTTPException(400, "全库问答需要先在设置中配置 API Key")
    top_papers = _select_papers(conn, terms)
    if not top_papers:
        raise HTTPException(400, "库里没有与问题相关的文献")
    scored = []
    for p in top_papers:
        paras = _paragraphs(p["pdf_text"] or p["abstract"] or "")
        cands = [{"paper_id": p["id"], "title": p["title"], "para_idx": i + 1,
                  "text": para, "score": _term_overlap(terms, para)}
                 for i, para in enumerate(paras) if len(para) >= 40]
        cands.sort(key=lambda x: -x["score"])
        scored.extend(cands[:2])
    if not scored:
        # 全文里没有可分段文本：退回摘要开头，保证回答有据可依
        for p in top_papers:
            if p["abstract"]:
                scored.append({"paper_id": p["id"], "title": p["title"], "para_idx": 1,
                               "text": p["abstract"][:1200], "score": 0.0})
    scored.sort(key=lambda x: -x["score"])
    return scored[:top_k]


def _paragraphs(text: str):
    """按空行分段，过滤过短段落。"""
    paras = [p.strip() for p in re.split(r"\n\s*\n", text or "") if len(p.strip()) >= 40]
    if not paras and text:
        paras = [text[:3000]]
    return paras[:200]


def _term_overlap(terms: list, para: str) -> float:
    """检索词在段落中的命中比例。"""
    if not terms:
        return 0.0
    pl = para.lower()
    return sum(1 for t in terms if t.lower() in pl) / len(terms)
