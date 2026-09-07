"""OpenAI 兼容接口客户端（chat）。"""
import base64
import re
import httpx
from . import settings as S


class AINotConfigured(Exception):
    pass


class AICallError(Exception):
    pass


def _headers() -> dict:
    key = S.get("api_key")
    if not key:
        raise AINotConfigured("尚未在设置中配置 API Key")
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


# 思考参数兼容性缓存：{base_url|model: True/False}，False 表示该模型不认 reasoning_effort
_thinking_support = {}


def chat(messages: list, temperature: float = 0.3, json_mode: bool = False,
         max_tokens: int | None = None) -> str:
    base = S.get("api_base_url").rstrip("/")
    model = S.get("chat_model")
    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    if max_tokens:
        body["max_tokens"] = max_tokens

    effort = S.get("reasoning_effort").strip()
    cache_key = f"{base}|{model}"
    use_effort = bool(effort) and _thinking_support.get(cache_key, True)
    if use_effort:
        body["reasoning_effort"] = effort

    r = httpx.post(f"{base}/chat/completions", headers=_headers(), json=body, timeout=120)
    if r.status_code == 400 and use_effort:
        # 该模型不支持 reasoning_effort（如非思考模型）：去掉参数重试，并记住结果
        _thinking_support[cache_key] = False
        body.pop("reasoning_effort", None)
        r = httpx.post(f"{base}/chat/completions", headers=_headers(), json=body, timeout=120)
    elif r.status_code == 200 and use_effort:
        _thinking_support[cache_key] = True
    if r.status_code != 200:
        raise AICallError(f"Chat API {r.status_code}: {r.text[:300]}")
    return r.json()["choices"][0]["message"]["content"]


def parse_json(text: str):
    """从模型输出中提取 JSON 对象（容忍 ```json 包裹等）。"""
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        text = m.group(1).strip()
    try:
        import json
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            import json
            return json.loads(m.group(0))
        raise
