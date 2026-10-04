"""播报期间的原生 ASR 回声不算用户输入（R7-2）。

音箱的麦克风一直在送音频，播我们自己的回复时小爱也会识别出文字。`consume_xiaoai_asr_result`
只在闸门关着时丢弃结果并返回 False —— 调用方拿到 False 会**继续往下走**，于是一句
带唤醒词的回声（例如"让小黑…"）就被当成真指令：切后端、开一轮新对话。

这里的契约是：闸门关着时**带文本**的结果到此为止（既不 `wakeup` 也不
`handle_text_command`），监听超时形状的结果同样丢掉；唯一放行的是音箱本机识别到的
唤醒（无文本 + `is_vad_begin=False`），因为那等于用户喊唤醒词要打断播报。闸门开着时
照旧走原来的分支，行为不变。

驱动的是真实 `XiaoAI.on_event`（含事件解析），只把 `EventManager` 与 `conversation`
换成记录调用的替身，不碰真设备、不出声。
"""

import asyncio
import importlib
import json
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

sys.modules.setdefault("dsh_xiaoai_server", types.SimpleNamespace())


def _recognize_result_event(text: str, is_vad_begin: bool = False) -> str:
    """构造一条 SpeechRecognizer.RecognizeResult 指令事件（原生 ASR 文本）。"""
    line = {
        "header": {
            "namespace": "SpeechRecognizer",
            "name": "RecognizeResult",
            "dialog_id": "dialog-echo",
        },
        "payload": {
            "results": [{"text": text}],
            "is_final": True,
            "is_vad_begin": is_vad_begin,
        },
    }
    return json.dumps(
        {
            "event": "instruction",
            "data": {"NewLine": json.dumps(line, ensure_ascii=False)},
        },
        ensure_ascii=False,
    )


class _EventManagerStub:
    """只区分"闸门关着"与"没接管"，并记录是否真的分派了出去。"""

    def __init__(self, playback_active: bool):
        self.playback_active = playback_active
        self.consumed = []
        self.wakeups = []
        self.interrupts = 0

    def consume_xiaoai_asr_result(self, **kwargs):
        self.consumed.append(kwargs)
        return False

    def is_playback_active(self):
        return self.playback_active

    async def wakeup(self, text, source):
        self.wakeups.append((text, source))

    def on_interrupt(self):
        self.interrupts += 1


class _ConversationStub:
    def __init__(self):
        self.commands = []
        self.retries = 0
        self.timeouts = 0

    def reset_retries(self):
        self.retries += 1

    async def handle_text_command(self, text, speaker):
        self.commands.append(text)

    async def handle_listening_timeout(self, speaker):
        self.timeouts += 1


async def _noop_suppress_dialog(dialog_id, reason):
    return None


class XiaoaiPlaybackEchoTest(unittest.TestCase):
    def setUp(self):
        self.xiaoai_module = importlib.import_module("core.xiaoai")
        self.conversation = _ConversationStub()
        self._patches = [
            mock.patch.object(
                self.xiaoai_module.XiaoAI, "conversation", self.conversation
            ),
            mock.patch.object(
                self.xiaoai_module.XiaoAI,
                "_suppress_dialog",
                _noop_suppress_dialog,
            ),
        ]
        for patch in self._patches:
            patch.start()
            self.addCleanup(patch.stop)

    def _drive(self, manager, text, is_vad_begin=False):
        with mock.patch.object(self.xiaoai_module, "EventManager", manager):
            asyncio.run(
                self.xiaoai_module.XiaoAI.on_event(
                    _recognize_result_event(text, is_vad_begin=is_vad_begin)
                )
            )

    def test_wakeup_word_echo_during_playback_is_consumed(self):
        """闸门关着时，带「让小黑」的回声不切后端、不二次唤醒。"""
        manager = _EventManagerStub(playback_active=True)
        with mock.patch.object(
            self.xiaoai_module.XiaoAI,
            "_external_wakeup_keywords",
            {"让小黑"},
        ):
            self._drive(manager, "让小黑")

        self.assertEqual(len(manager.consumed), 1)
        self.assertEqual(manager.wakeups, [])
        self.assertEqual(self.conversation.commands, [])
        self.assertEqual(self.conversation.retries, 0)

    def test_plain_echo_during_playback_is_consumed(self):
        """没有唤醒词的回声同样不能被当成指令提交给后端。"""
        manager = _EventManagerStub(playback_active=True)
        self._drive(manager, "你的快递明天到")

        self.assertEqual(manager.wakeups, [])
        self.assertEqual(self.conversation.commands, [])
        self.assertEqual(self.conversation.retries, 0)

    def test_native_wakeup_during_playback_still_interrupts(self):
        """闸门关着时，音箱本机的唤醒（无文本 + is_vad_begin=False）要能打断播报。"""
        manager = _EventManagerStub(playback_active=True)
        self._drive(manager, "")

        self.assertEqual(manager.interrupts, 1)
        self.assertEqual(self.conversation.retries, 1)
        self.assertEqual(manager.wakeups, [])
        self.assertEqual(self.conversation.commands, [])

    def test_listening_timeout_shape_during_playback_is_consumed(self):
        """闸门关着时，监听超时形状（无文本但 is_vad_begin 不是 False）也要丢弃。"""
        manager = _EventManagerStub(playback_active=True)
        self._drive(manager, "", is_vad_begin=True)

        self.assertEqual(manager.interrupts, 0)
        self.assertEqual(self.conversation.timeouts, 0)
        self.assertEqual(self.conversation.retries, 0)

    def test_wakeup_word_still_dispatches_when_gate_is_open(self):
        """对照组：闸门开着时，同样的文本照旧走原来的唤醒分支。"""
        manager = _EventManagerStub(playback_active=False)
        with mock.patch.object(
            self.xiaoai_module.XiaoAI,
            "_external_wakeup_keywords",
            {"让小黑"},
        ):
            self._drive(manager, "让小黑")

        self.assertEqual(manager.wakeups, [("让小黑", "kws")])
        self.assertEqual(self.conversation.commands, [])

    def test_command_still_dispatches_when_gate_is_open(self):
        """对照组：闸门开着时，普通指令照旧交给会话并唤醒。"""
        manager = _EventManagerStub(playback_active=False)
        self._drive(manager, "把灯关掉")

        self.assertEqual(self.conversation.commands, ["把灯关掉"])
        self.assertEqual(manager.wakeups, [("把灯关掉", "xiaoai")])


if __name__ == "__main__":
    unittest.main()
