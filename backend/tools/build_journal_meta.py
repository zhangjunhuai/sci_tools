"""构建期刊分区/影响因子离线数据 journal_meta.json。

数据来源：hitfyd/ShowJCR 项目收录的官方原始数据
  - 中科院分区表升级版（advanced.fenqubiao.com，2025 版）
  - JCR 期刊引证报告（2025 版）
用法：下载两个 CSV 后运行本脚本，输出到 backend/app/data/journal_meta.json。
"""
import csv
import json
import re
import sys
from pathlib import Path

FQB_CSV = "FQBJCR2025.csv"   # 中科院分区表升级版
JCR_CSV = "JCR2025.csv"      # JCR 影响因子
OUT = Path(__file__).resolve().parent.parent / "app" / "data" / "journal_meta.json"

BEST_Q = {"Q1": 1, "Q2": 2, "Q3": 3, "Q4": 4}


def norm_name(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def zone_of(v: str):
    """'4 [625/778]' -> '4'；空返回 None。"""
    m = re.match(r"\s*(\d)", v or "")
    return m.group(1) if m else None


def main():
    fqb_path, jcr_path = Path(sys.argv[1] if len(sys.argv) > 1 else FQB_CSV), Path(
        sys.argv[2] if len(sys.argv) > 2 else JCR_CSV)
    if not fqb_path.exists():
        fqb_path = Path(__file__).parent / FQB_CSV
    if not jcr_path.exists():
        jcr_path = Path(__file__).parent / JCR_CSV

    journals = {}

    # JCR：影响因子 + Q 分区（按刊名与 ISSN 建索引）
    issn_map = {}
    with open(jcr_path, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            key = norm_name(r["Journal"])
            if not key:
                continue
            best_q, best_c = None, ""
            for i in range(1, 7):
                q = (r.get(f"IF Quartile(2025)_{i}") or "").strip()
                if q in BEST_Q and (best_q is None or BEST_Q[q] < BEST_Q[best_q]):
                    best_q, best_c = q, (r.get(f"Category_{i}") or "").strip()
            try:
                imp = float(r["IF(2025)"]) if (r.get("IF(2025)") or "").strip() else None
            except ValueError:
                imp = None
            entry = {"n": r["Journal"], "i": imp, "q": best_q, "c": best_c,
                     "w": (r.get("Web of Science") or "").strip()}
            journals[key] = entry
            for issn in (r.get("ISSN"), r.get("EISSN")):
                if issn:
                    issn_map[issn.strip().lower()] = key

    # 中科院分区：大类分区 + Top（优先按 ISSN 关联到 JCR 条目，否则独立建条目）
    with open(fqb_path, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            zone = zone_of(r.get("大类分区"))
            top = (r.get("Top") or "").strip() == "是"
            category = (r.get("大类") or "").strip()
            issns = [x.strip().lower() for x in (r.get("ISSN/EISSN") or "").split("/") if x.strip()]
            key = next((issn_map[i] for i in issns if i in issn_map), norm_name(r["Journal"]))
            if not key:
                continue
            e = journals.setdefault(key, {"n": r["Journal"], "i": None, "q": None, "c": "", "w": ""})
            e["z"] = zone
            e["t"] = 1 if top else 0
            if category and not e["c"]:
                e["c"] = category
            if (r.get("Web of Science") or "").strip() and not e["w"]:
                e["w"] = r["Web of Science"].strip()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "meta": {"cas_year": 2025, "jcr_year": 2025,
                 "source": "中科院文献情报中心期刊分区表升级版 + JCR，经 hitfyd/ShowJCR 数据文件转换"},
        "journals": journals,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    with_zone = sum(1 for e in journals.values() if e.get("z"))
    with_if = sum(1 for e in journals.values() if e.get("i"))
    print(f"期刊总数 {len(journals)}，含分区 {with_zone}，含影响因子 {with_if}")
    print(f"输出 {OUT}（{OUT.stat().st_size / 1e6:.1f} MB）")


if __name__ == "__main__":
    main()
