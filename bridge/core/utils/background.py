"""后台任务的强引用池。

`asyncio.create_task()` 只是把协程交给事件循环：事件循环对**正在等 I/O** 的
任务只持弱引用，返回值一旦没人接住，任务就可能被 GC 回收 —— 跑了一半消失，
done 回调不执行，异常也不会有人看到（长跑进程里表现为"偶发丢一轮回复"）。

这里用一个模块级集合把在飞的任务钉住，任务结束后由 done 回调摘掉：引用与
生命周期对齐，异常统一写日志。
"""

import asyncio
from collections.abc import Coroutine
from typing import Any

from core.utils.logger import logger

# 在飞的后台任务。集合本身就是那根强引用，任务结束后由回调摘除。
_background_tasks: set[asyncio.Task] = set()


def spawn_background(coro: Coroutine[Any, Any, Any], name: str) -> asyncio.Task:
    """起一个不会被 GC 回收的后台任务，并把异常写进日志。

    统一入口的另一个好处：fire-and-forget 的任务出错时不再变成静默的
    "Task exception was never retrieved"。
    """
    task = asyncio.create_task(coro)
    _background_tasks.add(task)

    def _finalize(done_task: asyncio.Task) -> None:
        _background_tasks.discard(done_task)
        if done_task.cancelled():
            return
        exc = done_task.exception()
        if exc is not None:
            logger.error(f"[Background] Task failed ({name}): {exc}")

    task.add_done_callback(_finalize)
    return task


def pending_count() -> int:
    """当前在飞的后台任务数（测试与诊断用）。"""
    return len(_background_tasks)
