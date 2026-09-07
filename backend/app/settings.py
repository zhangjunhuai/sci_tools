"""应用设置：存 settings 表，UI 可改。"""
import json
from .db import get_db

DEFAULTS = {
    # OpenAI 兼容接口配置（OpenAI / DeepSeek / 各种中转都可用）
    "api_base_url": "https://api.openai.com/v1",
    "api_key": "",
    "chat_model": "gpt-4o-mini",
    # 思考类模型的推理深度：low 是多数思考模型的最快档；非思考模型会自动忽略该参数
    "reasoning_effort": "low",
    # 研究方向描述，AI 打标签/打分都以此为准
    "research_interests": "类脑导航：空间导航的神经机制（位置细胞、网格细胞、头朝向细胞）与神经启发的人工智能导航算法",
    # AI 自动打标签的候选标签体系（逗号分隔，可留空让 AI 自由发挥）
    "tag_preset": "",
    # arXiv 订阅分类（逗号分隔）
    "arxiv_categories": "q-bio.NC,cs.NE,cs.RO,cs.LG",
    # arXiv 订阅关键词（逗号分隔，标题或摘要命中即保留；留空表示只按分类收）
    "arxiv_keywords": "grid cell,place cell,head direction,spatial navigation,path integration,spiking neural network,cognitive map,entorhinal,hippocampus",
    # 每次抓取条数
    "arxiv_max_results": "80",
    # 聊天模型的上下文窗口（tokens）：项目 AI 助手按它控制注入内容的预算
    "context_window": "32768",
    # 研究记忆摘要：每周由 refresh_memory 任务根据文献/项目/对话自动更新；AI 打分与问答会参考
    "memory_summary": "",
    "memory_updated_at": "",
}


def get_memory() -> str:
    """研究记忆摘要（可能被用户手改过，直接返回存量文本）。"""
    return get("memory_summary")


def get_all() -> dict:
    conn = get_db()
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    stored = {r["key"]: r["value"] for r in rows}
    return {k: stored.get(k, v) for k, v in DEFAULTS.items()}


def get(key: str) -> str:
    conn = get_db()
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else DEFAULTS.get(key, "")


def update(d: dict):
    conn = get_db()
    for k, v in d.items():
        if k not in DEFAULTS:
            continue
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (k, str(v) if v is not None else ""),
        )
    conn.commit()


def ai_configured() -> bool:
    return bool(get("api_key"))


def as_json(key: str, default):
    raw = get(key)
    if not raw:
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default
