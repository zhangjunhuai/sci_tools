import asyncio
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from .db import init_db
from . import jobs as J
from .routers import papers, ai, misc, addcite, projects, journals

FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"

app = FastAPI(title="科研文献中心", version="0.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

init_db()
app.include_router(addcite.router)
app.include_router(papers.router)
app.include_router(ai.router)
app.include_router(misc.router)
app.include_router(projects.router)
app.include_router(journals.router)


@app.on_event("startup")
async def startup():
    J.start_worker()


@app.get("/api/health")
def health():
    return {"ok": True}


# 前端构建产物（开发时走 Vite 代理，生产由这里托管）
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        # 未知的 /api/* 一律返回 JSON 404，避免 SPA 兜底返回 HTML 让前端报
        # 「Unexpected token '<'」这类难懂的解析错误（通常是前后端版本不一致）
        if full_path == "api" or full_path.startswith("api/"):
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": f"接口不存在：/{full_path}（后端版本可能与前端不一致，请重启后端）"}, status_code=404)
        file = FRONTEND_DIST / full_path
        if full_path and file.is_file():
            return FileResponse(file)
        return FileResponse(FRONTEND_DIST / "index.html")
