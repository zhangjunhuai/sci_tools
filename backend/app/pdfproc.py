"""PDF 文本提取与元数据补全。"""
import re
import fitz  # pymupdf
from . import metadata


def extract_text(pdf_path: str) -> tuple:
    """返回 (text, n_pages)。"""
    doc = fitz.open(pdf_path)
    pages = [page.get_text("text") for page in doc]
    doc.close()
    return "\n".join(pages), len(pages)


def guess_title(pdf_path: str) -> str:
    """打开 PDF 后猜标题（第一页最大字号文本块）。"""
    doc = fitz.open(pdf_path)
    try:
        return guess_title_text(doc[0].get_text("dict"))
    except Exception:
        return ""
    finally:
        doc.close()


def head_text(text: str, n: int = 3000) -> str:
    """前 n 个字符（元数据识别用）。"""
    return re.sub(r"\s+", " ", text or "")[:n]


def guess_title_from(text: str) -> str:
    """从已提取的全文文本猜标题（取第一页最大字号行）。"""
    return guess_title_text(text or "")


def guess_title(pdf_path: str) -> str:
    """打开 PDF 后猜标题。"""
    doc = fitz.open(pdf_path)
    try:
        return guess_title_text(doc[0].get_text("dict"))
    except Exception:
        return ""
    finally:
        doc.close()


def guess_title_text(text_or_dict):
    """第一页最大字号文本块作为标题候选。"""
    try:
        if isinstance(text_or_dict, str):
            # 没有字号信息时，取第一段较长的行
            for line in text_or_dict.splitlines()[:40]:
                line = line.strip()
                if 15 <= len(line) <= 200 and not re.search(r"arxiv|@[a-z]", line, re.I):
                    return line
            return ""
        blocks = text_or_dict["blocks"]
        best, best_size = "", 0
        for b in blocks:
            for line in b.get("lines", []):
                size = max((s["size"] for s in line["spans"]), default=0)
                text = "".join(s["text"] for s in line["spans"]).strip()
                if len(text) < 12 or size < 10:
                    continue
                if re.search(r"arxiv\.org|proceedings of|vol\.|isbn|copyright", text, re.I):
                    continue
                if size > best_size:
                    best_size, best = size, text
        return best
    except Exception:
        return ""
