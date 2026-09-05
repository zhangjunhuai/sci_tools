"""期刊元数据（中科院分区 + JCR 影响因子）离线查询。

数据文件 app/data/journal_meta.json 由 tools/build_journal_meta.py 生成，
来源为中科院文献情报中心期刊分区表升级版与 JCR（经 hitfyd/ShowJCR 数据转换）。
按归一化刊名精确匹配，未收录或非期刊（如 arXiv 预印本、会议名）返回 None。
"""
import json
import re
from pathlib import Path

_DATA_FILE = Path(__file__).resolve().parent / "data" / "journal_meta.json"
_journals: dict = {}
_meta: dict = {}

if _DATA_FILE.exists():
    raw = json.loads(_DATA_FILE.read_text(encoding="utf-8"))
    _meta = raw.get("meta", {})
    _journals = raw.get("journals", {})


def norm_name(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def lookup(venue: str | None) -> dict | None:
    """按刊名查期刊元数据，返回 None 表示非期刊或未收录。"""
    return _journals.get(norm_name(venue))


def zone_map() -> dict:
    """归一化刊名 -> 中科院大类分区（'1'-'4'），供筛选/统计使用。"""
    return {k: e["z"] for k, e in _journals.items() if e.get("z")}


def journal_out(entry: dict) -> dict:
    """转成 API 输出格式（短键展开为可读字段）。"""
    return {
        "name": entry.get("n"),
        "impact_factor": entry.get("i"),
        "jcr_quartile": entry.get("q"),
        "jcr_category": entry.get("c"),
        "cas_zone": entry.get("z"),
        "cas_top": bool(entry.get("t")),
        "warn_years": entry.get("wy") or [],
        "cas_year": _meta.get("cas_year"),
        "jcr_year": _meta.get("jcr_year"),
    }


def enrich(paper: dict) -> dict:
    """向 paper dict 注入 journal_info 字段（无命中则为 None）。"""
    paper["journal_info"] = None
    e = lookup(paper.get("venue"))
    if e:
        paper["journal_info"] = journal_out(e)
    return paper
