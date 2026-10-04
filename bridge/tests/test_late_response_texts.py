"""迟到的回复只写给还在等的调用方（R7-3）。

`_wait_response` 超时后的 finally 会把 `_response_events` / `_response_texts` 两条
登记都清掉；而 `_submit_utterance` / `_run_chat_completion` 是在另一个任务里跑的，
请求慢到超过超时之后仍然会把回复写回 `_response_texts[run_id]` —— run_id 是 uuid，
没有任何人会回来 `pop` 它，于是每发生一次就留下一条永久残留。

自然路径的窗口是亚毫秒级（服务器慢于超时必然先超时），所以这里直接构造竞态：
用 `asyncio.Event` 卡住响应体，先让等待方超时收尾，再放行请求，断言没有残留。
同时保留正向用例：等待方还在时回填照旧、future 照旧被 resolve。
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


class _FakeResponse:
    def __init__(self, payload, status=200, release: asyncio.Event | None = None):
        self.payload = payload
        self.status = status
        self.release = release

    async def json(self, content_type=None):
        if self.release is not None:
            await self.release.wait()
        return self.payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False


class _FakeSession:
    def __init__(self, response, **kwargs):
        self.response = response
        self.kwargs = kwargs
        self.posted = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False

    def post(self, url, json=None, headers=None):
        self.posted = {"url": url, "json": json, "headers": headers}
        return self.response


def _fake_aiohttp(response):
    """把模块里的 `aiohttp` 换成只认这两层 `async with` 的替身。"""
    return types.SimpleNamespace(
        ClientSession=lambda **kwargs: _FakeSession(response, **kwargs),
        ClientTimeout=lambda **kwargs: None,
    )


class _LateReplyDshTest(unittest.TestCase):
    def setUp(self):
        self.dsh_module = importlib.import_module("core.dsh")
        self.manager = self.dsh_module.DshManager
        self._saved = {
            "_response_events": self.manager._response_events,
            "_response_texts": self.manager._response_texts,
            "_timeout": self.manager._timeout,
        }
        self.manager._response_events = {}
        self.manager._response_texts = {}
        self.addCleanup(self._restore)

    def _restore(self):
        for name, value in self._saved.items():
            setattr(self.manager, name, value)

    def test_late_reply_is_not_stored_when_waiter_is_gone(self):
        response = _FakeResponse({"reply": "迟到的回复"})

        async def scenario():
            with mock.patch.object(self.dsh_module, "aiohttp", _fake_aiohttp(response)):
                await self.manager._submit_utterance("run-late", "你好")

        asyncio.run(scenario())

        self.assertNotIn("run-late", self.manager._response_texts)

    def test_reply_is_stored_and_waiter_resolved_while_waiting(self):
        response = _FakeResponse({"reply": "迟到的回复"})

        async def scenario():
            waiter = asyncio.get_running_loop().create_future()
            self.manager._response_events["run-waited"] = waiter
            self.manager._response_texts["run-waited"] = ""
            with mock.patch.object(self.dsh_module, "aiohttp", _fake_aiohttp(response)):
                await self.manager._submit_utterance("run-waited", "你好")
            self.assertEqual(self.manager._response_texts["run-waited"], "迟到的回复")
            self.assertIsNone(await asyncio.wait_for(waiter, 1.0))

        asyncio.run(scenario())

    def test_timeout_then_late_reply_leaves_no_residue(self):
        release = None

        async def scenario():
            nonlocal release
            release = asyncio.Event()
            response = _FakeResponse({"reply": "迟到的回复"}, release=release)
            self.manager._timeout = 0.05
            waiter = asyncio.get_running_loop().create_future()
            self.manager._response_events["run-race"] = waiter
            self.manager._response_texts["run-race"] = ""

            with mock.patch.object(self.dsh_module, "aiohttp", _fake_aiohttp(response)):
                task = asyncio.create_task(
                    self.manager._submit_utterance("run-race", "你好")
                )
                await asyncio.sleep(0.02)
                # 等待方先超时：两条登记都被清掉
                self.assertIsNone(await self.manager._wait_response("run-race"))
                self.assertNotIn("run-race", self.manager._response_events)
                self.assertNotIn("run-race", self.manager._response_texts)

                # 请求这才返回，迟到的那次回填不能再留残留
                release.set()
                await task

        asyncio.run(scenario())

        self.assertNotIn("run-race", self.manager._response_texts)
        self.assertNotIn("run-race", self.manager._response_events)


class _LateReplyOpenAITest(unittest.TestCase):
    def setUp(self):
        self.openai_module = importlib.import_module("core.openai")
        self.manager = type(
            "_LateReplyOpenAIManager",
            (self.openai_module.OpenAIManager,),
            {
                "_response_events": {},
                "_response_texts": {},
                "_session_key": "test",
                "_request_chat_completion": classmethod(
                    lambda cls, text: _late_completion()
                ),
            },
        )

    def test_late_reply_is_not_stored_when_waiter_is_gone(self):
        asyncio.run(self.manager._run_chat_completion("run-late", "你好"))
        self.assertNotIn("run-late", self.manager._response_texts)

    def test_reply_is_stored_and_waiter_resolved_while_waiting(self):
        async def scenario():
            waiter = asyncio.get_running_loop().create_future()
            self.manager._response_events["run-waited"] = waiter
            self.manager._response_texts["run-waited"] = ""
            await self.manager._run_chat_completion("run-waited", "你好")
            self.assertEqual(self.manager._response_texts["run-waited"], "迟到的回复")
            self.assertIsNone(await asyncio.wait_for(waiter, 1.0))

        asyncio.run(scenario())


async def _late_completion():
    return "迟到的回复"


if __name__ == "__main__":
    unittest.main()
