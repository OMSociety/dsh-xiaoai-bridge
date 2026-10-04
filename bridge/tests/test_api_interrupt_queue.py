"""打断要穿透播报队列（R7-1）。

`POST /api/interrupt` 与原生唤醒打断（`WakeupSessionManager.on_interrupt`）过去
只停设备上正在放的那一路：早先排好队、还在锁上等的话会在闸门放行后接着念 ——
用户听到的是"喊停了还在说"。同时闸门被排队期的那一路持有，用户喊停之后的下一句
根本进不来（`PlaybackGate.reset()` 在生产代码里零调用）。

这里的契约是：

1. 打断取消在飞 / 排队的播报任务，第二次请求的那句话永远不出声；
2. 队列名额归还（`_pending_plays` 回到 0，队列不会被占死）；
3. 设备停完之后才重置闸门（麦克风恢复收音，且不是提前恢复）。

全程用假 speaker + 真 `_PlaybackGate`，不碰真设备、不出声。
"""

import asyncio
import importlib
import sys
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

sys.modules.setdefault("dsh_xiaoai_server", types.SimpleNamespace())

from aiohttp.test_utils import TestClient, TestServer  # noqa: E402


class _FakeSpeaker:
    """记录调用时序的扬声器替身：播报期间由闸门持有，直到设备"放完"。"""

    def __init__(self, gate, seconds: float = 0.5):
        self.gate = gate
        self.seconds = seconds
        self.texts = []
        self.active = 0
        self.stopped = 0

    async def play(self, text=None, url=None, blocking=True, timeout=None, **kwargs):
        self.texts.append(text if text is not None else url)
        self.active += 1
        self.gate.hold_until_device_stops(max_seconds=30.0)
        self.gate.set_device_playing(True)
        try:
            await asyncio.sleep(self.seconds)
        finally:
            self.gate.set_device_playing(False)
            self.active -= 1
        return True

    async def stop_device_audio(self):
        self.stopped += 1
        return True


class _InterruptQueueTestCase(unittest.TestCase):
    def setUp(self):
        self.api_module = importlib.import_module("core.services.api_server")
        self.gate_module = importlib.import_module("core.utils.playback_gate")
        self.background = importlib.import_module("core.utils.background")
        self.gate = self.gate_module._PlaybackGate(tail_seconds=0.0)
        self.speaker = _FakeSpeaker(self.gate)
        self.server = self.api_module.APIServer(host="127.0.0.1", port=0)
        self._patches = [
            mock.patch.object(
                self.api_module, "get_speaker", return_value=self.speaker
            ),
            mock.patch.object(self.api_module, "get_xiaoai", return_value=None),
            mock.patch.object(self.api_module, "PlaybackGate", self.gate),
        ]
        for patch in self._patches:
            patch.start()
            self.addCleanup(patch.stop)
        # 队列状态是模块级全局，跑完必须还回去（同进程还有别的测试文件）。
        self.addCleanup(self._reset_queue_state)

    def _reset_queue_state(self):
        self.api_module._pending_plays = 0
        self.api_module._play_tasks.clear()

    async def _wait_for(self, predicate, timeout: float = 3.0, message: str = "条件没在超时前成立"):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                raise AssertionError(message)
            await asyncio.sleep(0.01)

    async def _drain(self, timeout: float = 3.0):
        """等桥接器侧的后台播报彻底结束（否则断言的是半截时序）。"""
        deadline = time.monotonic() + timeout
        while self.api_module._pending_plays > 0 or self.background.pending_count() > 0:
            if time.monotonic() > deadline:
                raise AssertionError("后台播报没有在超时前结束")
            await asyncio.sleep(0.02)


class InterruptCancelsQueueTest(_InterruptQueueTestCase):
    def test_interrupt_cancels_queued_playback(self):
        async def scenario():
            async with TestServer(self.server.app) as server:
                async with TestClient(server) as client:
                    first = await client.post(
                        "/api/play/text", json={"text": "第一句"}
                    )
                    self.assertEqual(first.status, 200)
                    await self._wait_for(
                        lambda: self.speaker.active == 1,
                        message="第一句没有开始播报",
                    )

                    second = await client.post(
                        "/api/play/text", json={"text": "第二句"}
                    )
                    self.assertEqual(second.status, 200)
                    await self._wait_for(
                        lambda: self.api_module._pending_plays == 2,
                        message="第二句没有排进队列",
                    )

                    interrupt = await client.post("/api/interrupt")
                    self.assertEqual(interrupt.status, 200)
                    self.assertTrue((await interrupt.json())["success"])

                    await self._wait_for(
                        lambda: self.api_module._pending_plays == 0,
                        message="打断后队列名额没有归还",
                    )
                    await self._drain()

            # 只有已经在放的第一句出过声，排队的那句永远没开播
            self.assertEqual(self.speaker.texts, ["第一句"])
            self.assertEqual(self.speaker.stopped, 1)
            self.assertTrue(self.gate.closed is False)

        asyncio.run(scenario())

    def test_interrupt_without_queue_keeps_device_stop_semantics(self):
        """没有排队任务时，打断仍然是"停设备 + 关会话"，闸门照旧放行。"""
        self.gate.hold_until_device_stops(max_seconds=30.0)
        self.assertTrue(self.gate.closed)

        async def scenario():
            async with TestServer(self.server.app) as server:
                async with TestClient(server) as client:
                    interrupt = await client.post("/api/interrupt")
                    self.assertEqual(interrupt.status, 200)
                    self.assertEqual(self.speaker.texts, [])
                    self.assertTrue(self.gate.closed is False)

        asyncio.run(scenario())
        self.assertEqual(self.speaker.stopped, 1)


class CancelPendingPlaysUnitTest(_InterruptQueueTestCase):
    def test_cancel_pending_plays_cancels_registered_tasks(self):
        async def scenario():
            tasks = [asyncio.create_task(asyncio.sleep(30)) for _ in range(3)]
            finished = asyncio.create_task(asyncio.sleep(0))
            await finished
            for task in tasks + [finished]:
                self.api_module._play_tasks.add(task)
                task.add_done_callback(self.api_module._play_tasks.discard)

            self.assertEqual(self.api_module.cancel_pending_plays(), 3)
            for task in tasks:
                with self.assertRaises(asyncio.CancelledError):
                    await task
            await asyncio.sleep(0)
            self.assertEqual(self.api_module._play_tasks, set())
            # 已经结束的任务不会被再取消一次
            self.assertEqual(self.api_module.cancel_pending_plays(), 0)

        asyncio.run(scenario())

    def test_slot_is_released_when_task_is_cancelled_before_start(self):
        """还没跑第一步就被取消的任务同样要归还名额，否则队列会被占死。"""

        async def scenario():
            self.api_module._pending_plays = 0
            self.assertTrue(self.api_module._reserve_play_slot())
            task = self.api_module._spawn_play_task(self.speaker, "第一句", 1000)
            # 协程体（含 finally）根本不会执行，名额只能靠任务收尾回调归还
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertEqual(self.api_module._pending_plays, 0)
            self.assertEqual(self.api_module._play_tasks, set())

        asyncio.run(scenario())


class NativeInterruptTest(_InterruptQueueTestCase):
    """原生唤醒打断（`WakeupSessionManager.on_interrupt`）与 HTTP 打断同效。"""

    def setUp(self):
        super().setUp()
        self.wakeup_module = importlib.import_module("core.wakeup_session")
        self.xiaoai_module = importlib.import_module("core.xiaoai")
        self.manager = self.wakeup_module.WakeupSessionManager()

        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run_loop, daemon=True)
        self.thread.start()
        self.manager._get_loop = lambda: self.loop

        extra = [
            mock.patch.object(self.gate_module, "PlaybackGate", self.gate),
            mock.patch.object(
                self.wakeup_module, "get_speaker", return_value=self.speaker
            ),
            mock.patch.object(
                self.xiaoai_module.XiaoAI, "stop_conversation", lambda: None
            ),
            mock.patch.dict(
                sys.modules,
                {
                    "dsh_xiaoai_server": types.SimpleNamespace(
                        stop_playing=self._noop_async,
                        start_recording=self._noop_async,
                    )
                },
            ),
        ]
        for patch in extra:
            patch.start()
            self.addCleanup(patch.stop)
        self.addCleanup(self._stop_loop)

    @staticmethod
    async def _noop_async(*_args, **_kwargs):
        return None

    def _run_loop(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def _stop_loop(self):
        if self.loop.is_running():
            self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=5)
        self.loop.close()

    def _make_pending_task(self) -> asyncio.Task:
        """在 app 循环上放一条"在飞播报任务"，登记进 `_play_tasks`。"""

        async def create():
            task = self.loop.create_task(asyncio.sleep(30))
            self.api_module._play_tasks.add(task)
            task.add_done_callback(self.api_module._play_tasks.discard)
            return task

        return asyncio.run_coroutine_threadsafe(create(), self.loop).result(timeout=5)

    def test_on_interrupt_cancels_queue_and_resets_gate(self):
        task = self._make_pending_task()
        self.gate.hold_until_device_stops(max_seconds=30.0)
        self.assertTrue(self.gate.closed)

        self.manager.on_interrupt()

        deadline = time.monotonic() + 5.0
        while not (
            task.cancelled() and self.speaker.stopped and not self.gate.closed
        ):
            if time.monotonic() > deadline:
                raise AssertionError(
                    "原生打断没有收尾: cancelled="
                    f"{task.cancelled()}, stopped={self.speaker.stopped}, "
                    f"closed={self.gate.closed}"
                )
            time.sleep(0.01)

        self.assertTrue(task.cancelled())
        self.assertEqual(self.speaker.stopped, 1)
        self.assertFalse(self.gate.closed)
        self.assertEqual(self.api_module._play_tasks, set())


if __name__ == "__main__":
    unittest.main()
