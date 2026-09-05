from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent  # backend/
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "research.db"
PDF_DIR = DATA_DIR / "pdfs"
LATEX_DIR = DATA_DIR / "latex"   # LaTeX 编译沙箱（临时工作目录）

APP_NAME = "科研文献中心"

for _d in (DATA_DIR, PDF_DIR, LATEX_DIR):
    _d.mkdir(parents=True, exist_ok=True)
