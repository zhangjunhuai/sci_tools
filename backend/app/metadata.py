"""元数据识别与抓取：arXiv ID / DOI 识别 → arXiv API / Crossref 查询。"""
import re
import httpx
import xml.etree.ElementTree as ET

ARXIV_NS = {
    "a": "http://www.w3.org/2005/Atom",
    "ar": "http://arxiv.org/schemas/atom",
}

# 常见预印本 DO 的 journal 前缀，crossref 会返回，但展示时应识别为预印本
PREPRINT_PREFIXES = ("10.48550/arxiv.",)


def detect_arxiv_id(text: str):
    """从 DOI/文件名/URL/文本中识别 arXiv ID，如 2310.12345 或 2310.12345v2。"""
    m = re.search(
        r"(?:arxiv\s*[:\s]\s*|arxiv\.org/(?:abs|pdf)/|10\.48550/arxiv[.-])((\d{4})\.\d{4,5})(v\d+)?",
        text, re.I,
    )
    if m:
        return m.group(1)
    # 老式 ID: cat/0301012 或 cat-ph/0301012
    m = re.search(r"\b([a-z-]+/\d{7})(v\d+)?\b", text, re.I)
    if m and any(c.isdigit() for c in m.group(1)):
        return m.group(1)
    return None


def detect_doi(text: str):
    m = re.search(r"\b(10\.\d{4,9}/[^\s\"<>]+)", text, re.I)
    if m:
        doi = m.group(1).rstrip(".,;)")
        if doi.lower().startswith("10.48550/arxiv"):
            return None
        return doi
    return None


def fetch_arxiv(arxiv_id: str):
    url = f"https://export.arxiv.org/api/query?id_list={arxiv_id}"
    r = httpx.get(url, timeout=30, follow_redirects=True)
    r.raise_for_status()
    root = ET.fromstring(r.text)
    entry = root.find("a:entry", ARXIV_NS)
    if entry is None or entry.find("a:title", ARXIV_NS) is None:
        return None
    title = " ".join(entry.find("a:title", ARXIV_NS).text.split())
    authors = [a.find("a:name", ARXIV_NS).text for a in entry.findall("a:author", ARXIV_NS)]
    summary = " ".join(entry.find("a:summary", ARXIV_NS).text.split())
    doi_el = entry.find("ar:doi", ARXIV_NS)
    year_el = entry.find("a:published", ARXIV_NS)
    return {
        "title": title,
        "authors": authors,
        "year": int(year_el.text[:4]) if year_el is not None and year_el.text else None,
        "venue": "arXiv",
        "doi": doi_el.text if doi_el is not None else None,
        "arxiv_id": arxiv_id,
        "abstract": summary,
    }


def fetch_crossref(doi: str):
    r = httpx.get(f"https://api.crossref.org/works/{doi}", timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    m = r.json()["message"]
    title = m.get("title", [""])[0]
    authors = [
        (a.get("given", "") + " " + a.get("family", "")).strip()
        for a in m.get("author", [])
        if a.get("family") or a.get("given")
    ]
    year = None
    for k in ("published-print", "published-online", "issued", "created"):
        parts = m.get(k, {}).get("date-parts", [[None]])
        if parts and parts[0] and parts[0][0]:
            year = parts[0][0]
            break
    venue = m.get("container-title", [""])
    venue = venue[0] if venue else ""
    return {
        "title": " ".join(title.split()),
        "authors": authors,
        "year": year,
        "venue": venue,
        "doi": doi,
        "arxiv_id": None,
        "abstract": _clean_abstract(m.get("abstract", "") or ""),
    }


def _clean_abstract(ab: str) -> str:
    ab = re.sub(r"<[^>]+>", " ", ab)          # jats 标签
    ab = re.sub(r"\s+", " ", ab)
    return ab.strip()


def lookup(text: str, fallback_title: str = ""):
    """给一段文本（DOI/arXiv ID/文件名/PDF 全文），返回 (metadata, source_str)。

    先扫文本里的 arXiv ID / DOI；都没有时用 fallback_title 去 Crossref 按标题搜。
    """
    arxiv_id = detect_arxiv_id(text)
    if arxiv_id:
        try:
            meta = fetch_arxiv(arxiv_id)
            if meta:
                return meta, "arxiv"
        except httpx.HTTPError:
            pass
    doi = detect_doi(text)
    if doi:
        try:
            meta = fetch_crossref(doi)
            if meta:
                return meta, "crossref"
        except httpx.HTTPError:
            pass
    if fallback_title and len(fallback_title) >= 12:
        try:
            meta = search_crossref_by_title(fallback_title)
            if meta:
                return meta, "crossref_title"
        except httpx.HTTPError:
            pass
    return None, None


def _title_similar(a: str, b: str) -> bool:
    import difflib
    norm = lambda s: re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", s.lower()).strip()
    a, b = norm(a), norm(b)
    if not a or not b:
        return False
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.7


def search_crossref_by_title(title: str):
    r = httpx.get(
        "https://api.crossref.org/works",
        params={"query.bibliographic": title, "rows": 3},
        timeout=30,
    )
    r.raise_for_status()
    for item in r.json()["message"].get("items", []):
        ct = item.get("title", [""])
        if ct and _title_similar(title, ct[0]):
            doi = item.get("DOI", "")
            if not doi:
                continue
            authors = [
                (a.get("given", "") + " " + a.get("family", "")).strip()
                for a in item.get("author", [])
                if a.get("family") or a.get("given")
            ]
            year = None
            for k in ("published-print", "published-online", "issued", "created"):
                parts = item.get(k, {}).get("date-parts", [[None]])
                if parts and parts[0] and parts[0][0]:
                    year = parts[0][0]
                    break
            venue = item.get("container-title", [""])
            return {
                "title": " ".join(ct[0].split()),
                "authors": authors,
                "year": year,
                "venue": venue[0] if venue else "",
                "doi": doi,
                "arxiv_id": None,
                "abstract": _clean_abstract(item.get("abstract", "") or ""),
            }
    return None


def fetch_oa_pdf_url(doi: str):
    """Unpaywall：查该 DOI 的合法 OA 副本（机构库/预印本），返回可下载的 PDF URL。"""
    try:
        r = httpx.get(
            f"https://api.unpaywall.org/v2/{doi}",
            params={"email": "researchhub@example.org"},
            timeout=20,
        )
        if r.status_code != 200:
            return None
        d = r.json()
        loc = d.get("best_oa_location") or {}
        return loc.get("url_for_pdf") or None
    except httpx.HTTPError:
        return None


def fetch_arxiv_feed(categories: list, keywords: list, max_results: int = 80):
    """抓取 arXiv 订阅论文：关键词与分类取交集搜索，按提交日期倒序。

    关键词为空时退化为按分类抓最新；否则每个关键词分别命中（all 字段）。
    返回 feed_items 字段字典列表。
    """
    import urllib.parse

    cat_q = "(" + " OR ".join(f"cat:{c}" for c in categories) + ")"
    if keywords:
        kw_q = "(" + " OR ".join(f'all:"{k}"' for k in keywords) + ")"
        query = f"{kw_q} AND {cat_q}"
    else:
        query = cat_q
    url = (
        f"https://export.arxiv.org/api/query?search_query={urllib.parse.quote(query)}"
        f"&sortBy=submittedDate&sortOrder=descending&max_results={max_results}"
    )
    r = httpx.get(url, timeout=60, follow_redirects=True)
    r.raise_for_status()
    root = ET.fromstring(r.text)
    out = []
    for entry in root.findall("a:entry", ARXIV_NS):
        id_url = entry.find("a:id", ARXIV_NS).text
        m = re.search(r"abs/([\w.\-/]+?)(v\d+)?$", id_url)
        if not m:
            continue
        arxiv_id = m.group(1)
        title = " ".join(entry.find("a:title", ARXIV_NS).text.split())
        abstract = " ".join(entry.find("a:summary", ARXIV_NS).text.split())
        authors = [a.find("a:name", ARXIV_NS).text for a in entry.findall("a:author", ARXIV_NS)]
        cat_el = entry.find("ar:primary_category", ARXIV_NS)
        pub = entry.find("a:published", ARXIV_NS)
        out.append(
            {
                "arxiv_id": arxiv_id,
                "title": title,
                "authors": authors,
                "abstract": abstract,
                "primary_category": cat_el.get("term") if cat_el is not None else None,
                "published": pub.text if pub is not None else None,
                "pdf_url": f"https://arxiv.org/pdf/{arxiv_id}",
            }
        )
    return out
