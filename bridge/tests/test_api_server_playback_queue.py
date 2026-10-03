"""播报串行化与后台任务持强引用（R6-3 / R6-4）。

插件侧的每个会话都是独立触发者：定时提醒和对话回复可以同时打
`POST /api/play/text`。上游那版处理器每请求裸 `asyncio.create_task`，两路 ubus
TTS 会同时出声 —— 叠音。这里的契约是：同一个音箱同一时刻只许一路出声，其余
排队；队列有界，满了立刻回 503 而不是无限堆积；HTTP 请求本身照旧可以在播报前
返回（响应里 `queued`/`serialized` 说明已经入队）。

同时也钉住后台任务的创建方式：`asyncio.create_task` 的返回值没有强引用时，
事件循环只持弱引用，在飞任务可能被 GC 回收（`_pending_plays` 就再也减不回去）。

全程用假 speaker + 真 `_PlaybackGate`，不碰真设备、不出声。注意每个用例的
"发请求 + 等后台播完"必须在**同一个事件循环**里：`asyncio.run` 收尾时会取消
在飞任务，跨 loop 断言拿到的是被取消的时序。
"""

import asyncio
import importlib
import sys
import time
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

sys.modules.setdefault("open_xiaoai_server", types.SimpleNamespace())

from aiohttp.test_utils import TestClient, TestServer  # noqa: E402


class _FakeSpeaker:
    """记录调用时序的扬声器替身。

    `play` 模拟真实异步播报：命令立刻返回，但闸门要一直关到设备上报播完
    （playing → 非 playing），这正是串行化要等的"真正放完"。
    """

    def __init__(self, gate):
        self.gate = gate
        self.seconds = 0.05
        self.started_at = []
        self.finished_at = []
        self.active = 0
        self.max_active = 0
        self.texts = []

    async def play(self, text=None, url=None, blocking=True, timeout=None, **kwargs):
        self.texts.append(text if text is not None else url)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        self.started_at.append(time.monotonic())
        self.gate.hold_until_device_stops(max_seconds=self.seconds + 5.0)
        self.gate.set_device_playing(True)
        try:
            await asyncio.sleep(self.seconds)
        finally:
            self.gate.set_device_playing(False)
            self.finished_at.append(time.monotonic())
            self.active -= 1
        return True


class PlaybackSerializationTest(unittest.TestCase):
    def setUp(self):
        self.api_module = importlib.import_module("core.services.api_server")
        self.gate_module = importlib.import_module("core.utils.playback_gate")
        self.background = importlib.import_module("core.utils.background")
        self.gate = self.gate_module._PlaybackGate(tail_seconds=0.0)
        self.speaker = _FakeSpeaker(self.gate)
        self.server = self.api_module.APIServer(host="127.0.0.1", port=0)
        self._patches = [
            mock.patch.object(self.api_module, "get_speaker", return_value=self.speaker),
            mock.patch.object(self.api_module, "PlaybackGate", self.gate),
        ]
        for patch in self._patches:
            patch.start()
            self.addCleanup(patch.stop)

    async def _drain(self, timeout: float = 3.0):
        """等桥接器侧的后台播报彻底结束（否则断言的是半截时序）。"""
        deadline = time.monotonic() + timeout
        while self.api_module._pending_plays > 0 or self.background.pending_count() > 0:
            if time.monotonic() > deadline:
                raise AssertionError("后台播报没有在超时前结束")
            await asyncio.sleep(0.02)

    def test_two_concurrent_requests_play_one_after_another(self):
        async def scenario():
            async with TestServer(self.server.app) as server:
                async with TestClient(server) as client:
                    first, second = await asyncio.gather(
                        client.post("/api/play/text", json={"text": "第一句"}),
                        client.post("/api/play/text", json={"text": "第二句"}),
                    )
                    bodies = [await first.json(), await second.json()]
                    statuses = (first.status, second.status)
                    await self._drain()
                    return statuses, bodies

        statuses, bodies = asyncio.run(scenario())

        self.assertEqual((200, 200), statuses)
        for body in bodies:
            self.assertTrue(body["success"])
            self.assertTrue(body["queued"])
            self.assertTrue(body["serialized"])

        self.assertEqual(1, self.speaker.max_active, self.speaker.texts)
        self.assertEqual(["第一句", "第二句"], sorted(self.speaker.texts))
        # 时间上真的不重叠：第一路结束不晚于第二路开始
        self.assertLessEqual(self.speaker.finished_at[0], self.speaker.started_at[1])
        self.assertEqual(0, self.api_module._pending_plays)

    def test_queue_full_is_refused_immediately(self):
        self.speaker.seconds = 0.4

        async def scenario():
            async with TestServer(self.server.app) as server:
                async with TestClient(server) as client:
                    with mock.patch.object(self.api_module, "MAX_PENDING_PLAYS", 1):
                        accepted = await client.post(
                            "/api/play/text", json={"text": "占住队列"}
                        )
                        refused = await client.post("/api/play/text", json={"text": "插队"})
                        refused_body = await refused.json()
                        refused_status = refused.status
                    await self._drain()
                    return accepted.status, refused_status, refused_body

        accepted, refused_status, refused_body = asyncio.run(scenario())

        self.assertEqual(200, accepted)
        self.assertEqual(503, refused_status)
        self.assertFalse(refused_body["success"])
        self.assertFalse(refused_body["queued"])
        self.assertIn("queue is full", refused_body["error"])
        # 被拒的请求没有留下任何登记：队列长度必须能回到 0
        self.assertEqual(["占住队列"], self.speaker.texts)
        self.assertEqual(0, self.api_module._pending_plays)

    def test_slot_is_released_after_the_playback_ends(self):
        async def scenario():
            async with TestServer(self.server.app) as server:
                async with TestClient(server) as client:
                    first = await client.post("/api/play/text", json={"text": "第一句"})
                    await self._drain()
                    second = await client.post("/api/play/text", json={"text": "第二句"})
                    await self._drain()
                    return first.status, second.status

        self.assertEqual((200, 200), asyncio.run(scenario()))
        self.assertEqual(["第一句", "第二句"], self.speaker.texts)
        self.assertEqual(1, self.speaker.max_active)


class BackgroundTaskReferenceTest(unittest.TestCase):
    """`asyncio.create_task` 的返回值必须有人拿着，否则在飞任务可能被 GC。"""

    def setUp(self):
        self.module = importlib.import_module("core.utils.background")

    def test_pending_task_is_tracked_and_released(self):
        baseline = self.module.pending_count()

        async def scenario():
            started = asyncio.Event()
            release = asyncio.Event()

            async def work():
                started.set()
                await release.wait()

            task = self.module.spawn_background(work(), name="t")
            await started.wait()
            self.assertFalse(task.done())
            self.assertEqual(baseline + 1, self.module.pending_count())
            release.set()
            await task
            await asyncio.sleep(0)
            return self.module.pending_count()

        self.assertEqual(baseline, asyncio.run(scenario()))

    def test_failure_is_logged_and_does_not_escape(self):
        baseline = self.module.pending_count()

        async def scenario():
            async def boom():
                raise RuntimeError("任务炸了")

            with mock.patch.object(self.module.logger, "error") as logged:
                task = self.module.spawn_background(boom(), name="boom")
                await asyncio.sleep(0)
                await asyncio.sleep(0)
                self.assertTrue(task.done())
                logged.assert_called_once()
                self.assertIn("boom", logged.call_args[0][0])
            await asyncio.sleep(0)
            return self.module.pending_count()

        self.assertEqual(baseline, asyncio.run(scenario()))

    def test_api_server_no_longer_defines_the_dead_helper(self):
        api_module = importlib.import_module("core.services.api_server")
        self.assertFalse(hasattr(api_module.APIServer, "_create_background_task"))


if __name__ == "__main__":
    unittest.main()
