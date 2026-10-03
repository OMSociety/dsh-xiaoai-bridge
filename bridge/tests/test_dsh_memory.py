"""fire-and-forget 播报不能漏掉每轮的 TTS 音色登记（R6-2）。

`send(wait_response=False)` 走的是后台协程：`_wait_response` 的 finally 只清
`_response_events` / `_response_texts`，而 `_response_tts_speakers[run_id]` 是
"这一轮该用哪个音色回复"的登记。fire-and-forget 路径没有外层调用者来 pop，
每说一句就积一条 —— 长跑进程内存单调增长。收尾统一交给
`_wait_response_and_release`，正常、超时、异常三条路径都不许漏。

这里用子类把"投递出口"换成当场完成的桩：不发请求、不碰真设备。
"""

import asyncio
import importlib
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

sys.modules.setdefault("dsh_xiaoai_server", types.SimpleNamespace())


def _make_test_manager(base, submit_name, *, complete: bool = True):
    """造一个"投递出口可控"的 backend 子类。

    `complete=True` 时投递会立刻把回复写进登记表并唤醒等待者（模拟插件秒回）；
    `False` 时什么都不做（让 `_wait_response` 走超时路径）。
    """

    class _TestManager(base):
        @classmethod
        def get_tts_speaker_for_session_key(cls):
            return "voice-test"

    async def _submit(cls, run_id, text):
        if not complete:
            return
        waiter = cls._response_events.get(run_id)
        if waiter is not None:
            cls._response_texts[run_id] = f"回复：{text}"
            waiter.set_result(None)

    setattr(_TestManager, submit_name, classmethod(_submit))
    return _TestManager


class _BackendMemoryCases:
    """两个 backend（DSH / OpenAI）结构一致，共用这套用例。

    故意不继承 `unittest.TestCase`：pytest 会无条件收集 TestCase 子类（不看
    类名前缀），基类自己跑一遍只会白报 4 条空模块名的失败。
    """

    module_name = ""
    manager_name = ""
    submit_name = ""

    def setUp(self):
        super().setUp()
        self.module = importlib.import_module(self.module_name)
        self.base = getattr(self.module, self.manager_name)
        # 登记表是**类属性**，跨用例共享；每例从干净状态开始。
        self._saved = (
            dict(self.base._response_events),
            dict(self.base._response_texts),
            dict(self.base._response_tts_speakers),
            self.base._initialized,
            self.base._enabled,
            self.base._timeout,
        )
        self.base._response_events.clear()
        self.base._response_texts.clear()
        self.base._response_tts_speakers.clear()
        self.base._initialized = True
        self.base._enabled = True
        self.base._timeout = 0.5

    def tearDown(self):
        events, texts, speakers, initialized, enabled, timeout = self._saved
        self.base._response_events.clear()
        self.base._response_events.update(events)
        self.base._response_texts.clear()
        self.base._response_texts.update(texts)
        self.base._response_tts_speakers.clear()
        self.base._response_tts_speakers.update(speakers)
        self.base._initialized = initialized
        self.base._enabled = enabled
        self.base._timeout = timeout
        super().tearDown()

    def _manager(self, *, complete: bool = True):
        return _make_test_manager(self.base, self.submit_name, complete=complete)

    def test_fire_and_forget_releases_the_tts_speaker(self):
        manager = self._manager()
        speakers = self.base._response_tts_speakers

        async def scenario():
            run_id = await manager.send("你好", wait_response=False)
            self.assertIn(run_id, speakers)
            self.assertEqual("voice-test", speakers[run_id])
            # 让后台那条 `_wait_response_and_release` 跑完（它会 pop 掉登记）。
            await asyncio.sleep(0.05)
            return run_id

        run_id = asyncio.run(scenario())

        self.assertNotIn(run_id, speakers)
        self.assertEqual({}, self.base._response_events)
        self.assertEqual({}, self.base._response_texts)

    def test_timeout_path_releases_the_tts_speaker(self):
        manager = self._manager(complete=False)
        speakers = self.base._response_tts_speakers
        self.base._timeout = 0.02

        async def scenario():
            run_id = await manager.send("有人吗", wait_response=False)
            self.assertIn(run_id, speakers)
            await asyncio.sleep(0.2)
            return run_id

        run_id = asyncio.run(scenario())

        self.assertNotIn(run_id, speakers)
        self.assertEqual({}, self.base._response_events)

    def test_exception_path_releases_the_tts_speaker(self):
        base = self.base

        class _Exploding(base):
            @classmethod
            async def _wait_response(cls, run_id):
                raise RuntimeError("boom")

        speakers = base._response_tts_speakers
        speakers["run-x"] = "voice-test"

        with self.assertRaises(RuntimeError):
            asyncio.run(_Exploding._wait_response_and_release("run-x"))

        self.assertNotIn("run-x", speakers)

    def test_blocking_send_releases_the_tts_speaker(self):
        manager = self._manager()
        speakers = self.base._response_tts_speakers

        async def scenario():
            run_id = await manager.send("在吗", wait_response=True)
            self.assertTrue(run_id)
            self.assertNotIn(run_id, speakers)
            return run_id

        run_id = asyncio.run(scenario())

        self.assertNotIn(run_id, speakers)


class DshMemoryTest(_BackendMemoryCases, unittest.TestCase):
    module_name = "core.dsh"
    manager_name = "DshManager"
    submit_name = "_submit_utterance"


class OpenAIMemoryTest(_BackendMemoryCases, unittest.TestCase):
    module_name = "core.openai"
    manager_name = "OpenAIManager"
    submit_name = "_run_chat_completion"


if __name__ == "__main__":
    unittest.main()
