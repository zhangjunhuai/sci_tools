import asyncio
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from .db import init_db
from . import jobs as J
from .routers import papers, ai, misc, addcite, projects

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
        file = FRONTEND_DIST / full_path
        if full_path and file.is_file():
            return FileResponse(file)
        return FileResponse(FRONTEND_DIST / "index.html")
