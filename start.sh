#!/usr/bin/env bash
# 科研文献中心 一键启动
# 用法: ./start.sh [--dev]   --dev 时同时启动前端开发服务器（热更新）
set -e
cd "$(dirname "$0")"

PORT=8210

# 1. 后端依赖（首次）
if ! python3 -c "import fastapi, fitz, httpx, numpy" 2>/dev/null; then
    echo "[启动] 安装后端依赖…"
    pip install -q -r backend/requirements.txt
fi

# 2. 前端构建产物（首次或缺失时）
if [ ! -f frontend/dist/index.html ]; then
    echo "[启动] 构建前端…"
    (cd frontend && npm install --no-audit --no-fund --no-bin-links && npm run build)
fi

if [ "$1" = "--dev" ]; then
    echo "[启动] 开发模式：后端 :$PORT + 前端热更新 :5173"
    echo "       打开 http://127.0.0.1:5173"
    cd backend && python3 -m uvicorn app.main:app --port $PORT &
    cd ../frontend && exec node node_modules/vite/bin/vite.js
else
    echo "[启动] http://127.0.0.1:$PORT  （Ctrl+C 停止）"
    cd backend && exec python3 -m uvicorn app.main:app --port $PORT
fi
