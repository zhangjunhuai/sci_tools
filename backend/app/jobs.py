"""后台任务：单 worker 队列，任务状态落库。"""
import asyncio
import json
import traceback
from datetime import datetime
from .db import get_db

_queue: asyncio.Queue = None
_worker_task = None


def enqueue(job_type: str, payload: dict):
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO jobs(type, payload, status) VALUES(?, ?, 'pending')",
        (job_type, json.dumps(payload, ensure_ascii=False)),
    )
    conn.commit()
    job_id = cur.lastrowid
    if _queue is not None:
        _queue.put_nowait(job_id)
    return job_id


def _set_status(job_id: int, status: str, message: str = ""):
    conn = get_db()
    conn.execute(
        "UPDATE jobs SET status=?, message=? WHERE id=?", (status, message, job_id)
    )
    conn.commit()


async def _worker():
    from .tasks import run_job  # 延迟导入避免循环
    from datetime import datetime as _dt

    last_mem_check = 0.0

    while True:
        # 每小时检查一次：记忆摘要超过 7 天（或为空）且配置了 AI，自动刷新
        import time as _time
        if _time.time() - last_mem_check > 3600:
            last_mem_check = _time.time()
            try:
                conn = get_db()
                if conn.execute("SELECT 1 FROM settings WHERE key='api_key' AND value!=''").fetchone():
                    upd = conn.execute("SELECT value FROM settings WHERE key='memory_updated_at'").fetchone()
                    stale = True
                    if upd and upd["value"]:
                        d = _dt.strptime(upd["value"], "%Y-%m-%d %H:%M")
                        stale = (_dt.now() - d).days >= 7
                    if stale:
                        enqueue("refresh_memory", {})
            except Exception:
                pass
        try:
            # 带超时取任务：队列空闲时也要定期醒一次，保证上面的记忆检查按时执行
            job_id = await asyncio.wait_for(_queue.get(), timeout=3600)
        except asyncio.TimeoutError:
            continue
        try:
            conn = get_db()
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                continue
            payload = json.loads(row["payload"])
            _set_status(job_id, "running")
            await asyncio.to_thread(run_job, row["type"], payload)
            _set_status(job_id, "done")
        except Exception as e:
            traceback.print_exc()
            _set_status(job_id, "error", f"{type(e).__name__}: {e}")
        finally:
            _queue.task_done()


def start_worker():
    """FastAPI startup 时调用；重启时把遗留 pending/running 任务重新入队。"""
    global _queue, _worker_task
    conn = get_db()
    stale = conn.execute(
        "SELECT id FROM jobs WHERE status IN ('pending','running') ORDER BY id"
    ).fetchall()
    conn.execute(
        "DELETE FROM jobs WHERE status IN ('pending','running')"
    )  # 重启后清掉，避免重复执行不确定的旧任务
    conn.commit()

    _queue = asyncio.Queue()
    _worker_task = asyncio.get_running_loop().create_task(_worker())
    for r in stale:
        _queue.put_nowait(r["id"])


def list_jobs(limit: int = 30):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM jobs ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    return [dict(r) for r in rows]
