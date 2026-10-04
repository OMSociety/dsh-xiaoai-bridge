"""唤醒词检测的 pause/resume 必须配对（R8-2-5）。

`wakeup()` 会在调 `before_wakeup` 之前暂停 KWS，播报 / 提示音期间不收音，回来
再恢复。`before_wakeup` 是用户可改的配置函数（`bridge/config.py` 渲染出来的），
它会 `await speaker.play(...)` 甚至抛错 —— 过去只有正常返回才 `resume()`，一次
抛错（或被取消）就把 KWS 永久留在 paused，音箱再也叫不醒，只能重启桥接器。

契约：无论 `before_wakeup` 是正常返回、抛错还是被取消，`pause()` 都必须有对应的
`resume()`；返回值语义（`None` / `"dsh"` / `"openai"`）不受影响。
"""

import asyncio
import importlib
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

sys.modules.setdefault("dsh_xiaoai_server", types.SimpleNamespace())


class _FakeKws:
    """只记录 pause/resume 的 KWS 替身（真实现见 core/services/audio/kws）。"""

    def __init__(self):
        self.paused = False
        self.calls = []

    def pause(self):
        self.paused = True
        self.calls.append("pause")

    def resume(self):
        self.paused = False
        self.calls.append("resume")


class _ConfigStub:
    """`get_app_config(key, default=None)` 的最小替身。"""

    def __init__(self, before_wakeup):
        self._before_wakeup = before_wakeup

    def get_app_config(self, key, default=None):
        if key == "wakeup.before_wakeup":
            return self._before_wakeup
        if default is not None:
            return default
        return {}


class KwsPairingTest(unittest.TestCase):
    def setUp(self):
        self.wakeup_module = importlib.import_module("core.wakeup_session")
        self.manager = self.wakeup_module.WakeupSessionManager()
        self.kws = _FakeKws()
        patches = [
            mock.patch.object(self.wakeup_module, "get_kws", return_value=self.kws),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def _set_before_wakeup(self, func):
        self.manager.config = _ConfigStub(func)

    def test_error_in_before_wakeup_still_resumes_kws(self):
        async def failing_before_wakeup(speaker, text, source, app):
            raise RuntimeError("before_wakeup 炸了")

        self._set_before_wakeup(failing_before_wakeup)

        with self.assertRaises(RuntimeError):
            asyncio.run(self.manager.wakeup("你好小黑", "kws"))

        self.assertEqual(self.kws.calls, ["pause", "resume"])
        self.assertFalse(self.kws.paused)

    def test_cancelled_before_wakeup_still_resumes_kws(self):
        async def cancelled_before_wakeup(speaker, text, source, app):
            raise asyncio.CancelledError()

        self._set_before_wakeup(cancelled_before_wakeup)

        with self.assertRaises(asyncio.CancelledError):
            asyncio.run(self.manager.wakeup("你好小黑", "kws"))

        self.assertEqual(self.kws.calls, ["pause", "resume"])
        self.assertFalse(self.kws.paused)

    def test_normal_before_wakeup_pairs_and_does_not_dispatch(self):
        async def quiet_before_wakeup(speaker, text, source, app):
            return None

        self._set_before_wakeup(quiet_before_wakeup)
        reset_calls = []

        async def record_reset():
            reset_calls.append(True)

        self.manager.reset_all_sessions = record_reset

        asyncio.run(self.manager.wakeup("你好小黑", "kws"))

        self.assertEqual(self.kws.calls, ["pause", "resume"])
        self.assertFalse(self.kws.paused)
        self.assertEqual(reset_calls, [])
        self.assertIsNone(self.manager._openai_controller)
        self.assertIsNone(self.manager._dsh_controller)

    def test_resume_happens_before_dispatch(self):
        """`resume()` 之后才分派会话，且返回值语义不受 finally 影响。"""

        async def dsh_before_wakeup(speaker, text, source, app):
            return "dsh"

        self._set_before_wakeup(dsh_before_wakeup)
        events = []

        async def record_reset():
            events.append(("reset", list(self.kws.calls)))

        async def record_start():
            events.append(("start", list(self.kws.calls)))

        self.manager.reset_all_sessions = record_reset
        self.manager._start_dsh_conversation = record_start

        asyncio.run(self.manager.wakeup("你好小黑", "kws"))

        self.assertEqual(self.kws.calls, ["pause", "resume"])
        self.assertEqual(
            events,
            [("reset", ["pause", "resume"]), ("start", ["pause", "resume"])],
        )


if __name__ == "__main__":
    unittest.main()
