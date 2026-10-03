"""半双工闸门：桥接器不能听见自己的声音。

DSH 的回合是**提交型**的（`DshConversationController._run_one_turn_with_local_asr`
把语句投给插件就返回），所以对话控制器会在插件还在通过音箱说话的时候就把麦克风
重新武装起来。没有这层保护，桥接器会把自己的 TTS 识别成新的用户语句，然后自己
回答自己 —— 实机日志里能看到它把自己的开场白又听了一遍。

这里固定闸门自身的契约，以及每个必须遵守它的调用点：VAD 丢帧、在途 ASR 结果被
丢弃、以及连续对话的等待窗口不被自己的播报吃掉。
"""

import asyncio
import importlib
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class _FakeStream:
    """MyStream 的替身：这里只需要 clear_input 被调用过几次。"""

    def __init__(self):
        self.cleared = 0

    def clear_input(self):
        self.cleared += 1


class _FakeXiaoai:
    """`SpeakerManager.play(buffer=...)` 的出口。"""

    def __init__(self):
        self.buffers = []

    def on_output_data(self, buffer):
        self.buffers.append(buffer)
        return True


class _FakeController:
    def __init__(self):
        self.seen = []

    def is_active(self):
        return True

    def consume_xiaoai_recognize_result(self, **kwargs):
        self.seen.append(kwargs)
        return True


class _GateTestCase(unittest.TestCase):
    """把模块级单例换成可控的小闸门（尾音为 0，测试不用等）。"""

    def setUp(self):
        sys.modules.setdefault("dsh_xiaoai_server", types.SimpleNamespace())
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        self.gate_module = importlib.import_module("core.utils.playback_gate")
        self.gate = self.gate_module._PlaybackGate(tail_seconds=0.0)
        self._singleton = self.gate_module.PlaybackGate
        # VAD 在模块导入时就绑定了名字，wakeup_session 是函数内局部导入，
        # 两处都要换，才能保证被测代码拿到这个小闸门。
        self.gate_module.PlaybackGate = self.gate

        # `core.external_conversation` 在模块层 `from … import PlaybackGate`
        # （第 25 行），所以「换掉 gate 模块里的名字」只对**之后**才导入它的
        # 模块有效。别的测试文件（例如 test_dsh_single_turn.py）可能先一步导入，
        # 那时监听窗口读到的还是真的单例 —— 窗口会照常过期，测试就会莫名其妙
        # 红掉。这里把已经导入过的模块里的绑定也一起换掉，tearDown 再放回去。
        self._patched_modules = []
        for name in ("core.external_conversation",):
            module = sys.modules.get(name)
            if module is not None and hasattr(module, "PlaybackGate"):
                self._patched_modules.append((module, module.PlaybackGate))
                module.PlaybackGate = self.gate

    def tearDown(self):
        for module, original in self._patched_modules:
            module.PlaybackGate = original
        self._patched_modules = []
        self.gate.reset()
        self.gate_module.PlaybackGate = self._singleton


class PlaybackGateTest(_GateTestCase):
    def test_counted_holds_keep_the_gate_shut(self):
        with self.gate:
            self.assertTrue(self.gate.closed)
        self.assertFalse(self.gate.closed)

    def test_nested_holds_release_only_when_all_leave(self):
        """一次播放里有回复、提示音等嵌套，少一层都不能提前开闸。"""
        self.gate.hold()
        self.gate.hold()
        self.gate.release()
        self.assertTrue(self.gate.closed)
        self.gate.release()
        self.assertFalse(self.gate.closed)

    def test_hold_for_expires_on_its_own(self):
        self.gate.hold_for(0.05)
        self.assertTrue(self.gate.closed)
        asyncio.run(asyncio.sleep(0.08))
        self.assertFalse(self.gate.closed)

    def test_release_keeps_the_gate_shut_for_the_tail(self):
        """调用返回后音箱还在响一小会儿。"""
        gate = self.gate_module._PlaybackGate(tail_seconds=0.05)
        with gate:
            pass
        self.assertTrue(gate.closed)
        asyncio.run(asyncio.sleep(0.08))
        self.assertFalse(gate.closed)

    def test_device_events_only_extend_a_hold(self):
        self.gate.set_device_playing(True)
        self.assertTrue(self.gate.closed)
        self.gate.set_device_playing(False)
        self.assertFalse(self.gate.closed)

        # 设备在播放刚开始时报 idle 也不能提前开闸。
        self.gate.hold()
        self.gate.set_device_playing(True)
        self.gate.set_device_playing(False)
        self.assertTrue(self.gate.closed)

    def test_async_hold_is_released_by_the_real_end_of_playback(self):
        """异步 ubus 播报：设备报"放完了"就开闸，不等估时。"""
        self.gate.hold_until_device_stops(max_seconds=30.0)
        self.assertTrue(self.gate.closed)
        self.gate.set_device_playing(True)
        self.assertTrue(self.gate.closed)
        self.gate.set_device_playing(False)
        self.assertFalse(self.gate.closed)

    def test_a_bare_idle_event_does_not_open_an_async_hold(self):
        """首条 playing 之前的 idle 不能当成"放完了" —— 那正是过去的空窗。"""
        self.gate.hold_until_device_stops(max_seconds=30.0)
        self.gate.set_device_playing(False)
        self.assertTrue(self.gate.closed)
        self.gate.reset()

    def test_async_hold_falls_back_to_its_deadline(self):
        """设备一个事件都不上报时，兜底上限到期也要开闸（不能永久静音）。"""
        self.gate.hold_until_device_stops(max_seconds=0.05)
        self.assertTrue(self.gate.closed)
        asyncio.run(asyncio.sleep(0.08))
        self.assertFalse(self.gate.closed)

    def test_zero_deadline_does_not_hold_at_all(self):
        self.gate.hold_until_device_stops(max_seconds=0)
        self.assertFalse(self.gate.closed)

    def test_wait_until_open_returns_when_the_gate_reopens(self):
        async def scenario():
            self.gate.hold_until_device_stops(max_seconds=5.0)
            self.gate.set_device_playing(True)

            async def finish():
                await asyncio.sleep(0.05)
                self.gate.set_device_playing(False)

            finisher = asyncio.ensure_future(finish())
            reopened = await self.gate.wait_until_open(timeout=2.0)
            await finisher
            return reopened

        self.assertTrue(asyncio.run(scenario()))

    def test_wait_until_open_gives_up_at_the_deadline(self):
        async def scenario():
            self.gate.hold_until_device_stops(max_seconds=30.0)
            return await self.gate.wait_until_open(timeout=0.05, poll_interval=0.01)

        self.assertFalse(asyncio.run(scenario()))

    def test_estimate_counts_characters_not_bytes(self):
        estimate = self.gate_module.estimate_speech_seconds
        self.assertEqual(self.gate_module.MIN_ASYNC_HOLD_SECONDS, estimate(""))
        self.assertEqual(
            self.gate_module.MIN_ASYNC_HOLD_SECONDS, estimate("   ")
        )
        # 8 个汉字 / 每秒 4 字 = 2 秒
        self.assertEqual(2.0, estimate("你好你好你好你好"))
        self.assertEqual(self.gate_module.MAX_ASYNC_HOLD_SECONDS, estimate("好" * 5000))


class VadMuteTest(_GateTestCase):
    def setUp(self):
        super().setUp()
        self.vad_module = importlib.import_module("core.services.audio.vad")
        self.gate_module.PlaybackGate = self.gate
        self.vad = self.vad_module.VAD
        self._saved = (
            self.vad.stream,
            self.vad.playback_muted,
            self.vad_module.Silero.vad,
            self.vad_module.PlaybackGate,
        )
        self.vad.stream = _FakeStream()
        self.vad.playback_muted = False
        self.vad.paused = True
        self.vad._reset_state()
        self.vad_module.PlaybackGate = self.gate
        self.detected = []
        self.vad_module.Silero.vad = self._silero

    def tearDown(self):
        (
            self.vad.stream,
            self.vad.playback_muted,
            self.vad_module.Silero.vad,
            self.vad_module.PlaybackGate,
        ) = self._saved
        super().tearDown()

    def _silero(self, frames, rate):
        self.detected.append(len(frames))
        return 0.0

    def test_frames_are_dropped_while_the_speaker_plays(self):
        self.gate.hold()
        self.vad._process_frames(b"\x00" * 1024)

        # 不对自己的声音跑检测，也不能进入任何检测状态
        self.assertEqual([], self.detected)
        self.assertEqual(0, self.vad.speech_count)
        self.assertEqual(0, self.vad.silence_count)
        self.assertTrue(self.vad.playback_muted)
        # 手上的半截录音与积压音频都要清掉
        self.assertEqual(1, self.vad.stream.cleared)

    def test_mute_is_entered_once_and_lifted_after_playback(self):
        self.gate.hold()
        self.vad._process_frames(b"\x00" * 1024)
        self.vad._process_frames(b"\x00" * 1024)
        self.assertEqual(1, self.vad.stream.cleared)

        self.gate.release()
        self.vad._process_frames(b"\x00" * 1024)
        self.assertFalse(self.vad.playback_muted)
        # 离开静音时再清一次（把播报期间攒下的回声丢掉），然后恢复检测
        self.assertEqual(2, self.vad.stream.cleared)
        self.assertEqual([1024], self.detected)
        self.assertEqual(512, self.vad.silence_count)


class WakeupAsrGateTest(_GateTestCase):
    def setUp(self):
        super().setUp()
        self.wakeup_module = importlib.import_module("core.wakeup_session")
        self.manager = self.wakeup_module.WakeupSessionManager()
        self.controller = _FakeController()
        self.manager._dsh_controller = self.controller

    def test_asr_results_are_dropped_while_the_speaker_plays(self):
        """小爱自己的识别同样会听到我们刚播出去的回复。"""
        self.gate.hold()
        accepted = self.manager.consume_xiaoai_asr_result(
            dialog_id="d1", text="你好，我是小爱", is_final=True, is_vad_begin=False
        )
        self.assertFalse(accepted)
        self.assertEqual([], self.controller.seen)

    def test_asr_results_flow_again_after_playback(self):
        accepted = self.manager.consume_xiaoai_asr_result(
            dialog_id="d2", text="你是笨蛋", is_final=True, is_vad_begin=False
        )
        self.assertTrue(accepted)
        self.assertEqual(1, len(self.controller.seen))
        self.assertEqual("你是笨蛋", self.controller.seen[0]["text"])


class SpeakerGateTest(_GateTestCase):
    def setUp(self):
        super().setUp()
        self.ref = importlib.import_module("core.ref")
        self.speaker_module = importlib.import_module("core.services.speaker")
        self.speaker = self.speaker_module.SpeakerManager()
        self.speaker_module.PlaybackGate = self.gate
        self.xiaoai = _FakeXiaoai()
        self.ref.set_xiaoai(self.xiaoai)

    def tearDown(self):
        self.ref.GLOBAL_STATES.pop("xiaoai", None)
        self.ref.GLOBAL_STATES.pop("speaker", None)
        super().tearDown()

    def _stub_shell(self, fake):
        """替换实例方法，调用结束后把原方法还回去。"""
        self.speaker.run_shell = fake
        self.addCleanup(lambda: self.speaker.__dict__.pop("run_shell", None))

    def test_pcm_buffer_holds_the_gate_for_its_duration(self):
        pcm = b"\x00" * (24000 * 2)  # 1 秒 24kHz int16
        asyncio.run(self.speaker.play(buffer=pcm))
        self.assertEqual([pcm], self.xiaoai.buffers)
        self.assertTrue(self.gate.closed)

    def test_blocking_tts_holds_the_gate_for_the_whole_shell_call(self):
        seen = []

        async def fake_shell(command, timeout=None):
            seen.append(self.gate.closed)
            return types.SimpleNamespace(exit_code=0, stdout="")

        self._stub_shell(fake_shell)
        ok = asyncio.run(self.speaker.play(text="小爱来了"))

        self.assertTrue(ok)
        self.assertEqual([True], seen)
        self.assertFalse(self.gate.closed)

    def test_async_tts_holds_the_gate_until_the_device_reports_back(self):
        async def fake_shell(command, timeout=None):
            return types.SimpleNamespace(exit_code=0, stdout='"code": 0')

        self._stub_shell(fake_shell)
        ok = asyncio.run(self.speaker.play(text="你好你好你好你好", blocking=False))

        self.assertTrue(ok)
        # 命令立刻返回，声音还在后面放：闸门要一直关着，直到设备报"放完了"，
        # 文本估时只是设备不上报事件时的兜底上限。
        self.assertTrue(self.gate.closed)
        self.gate.set_device_playing(True)
        self.gate.set_device_playing(False)
        self.assertFalse(self.gate.closed)

    def test_async_url_playback_waits_for_the_device_not_the_estimate(self):
        """URL 没有文本可估：过去按空文本估成 1.5 秒，长音频提前开闸。"""

        async def fake_shell(command, timeout=None):
            return types.SimpleNamespace(exit_code=0, stdout='"code": 0')

        self._stub_shell(fake_shell)
        ok = asyncio.run(
            self.speaker.play(url="http://example.com/long.mp3", blocking=False)
        )

        self.assertTrue(ok)
        self.assertTrue(self.gate.closed)
        self.gate.set_device_playing(True)
        self.assertTrue(self.gate.closed)
        self.gate.set_device_playing(False)
        self.assertFalse(self.gate.closed)


class ListeningWindowTest(_GateTestCase):
    """用户的聆听窗口不能被我们自己的播报吃掉。"""

    def setUp(self):
        super().setUp()
        self.module = importlib.import_module("core.external_conversation")

        # `timeout` 是只读 property（从渲染出来的配置里读），这里用子类压成 0.3s。
        class _WindowController(self.module.ExternalConversationController):
            timeout = 0.3

        self.controller = object.__new__(_WindowController)
        self.loop = asyncio.new_event_loop()
        self.controller._loop = self.loop

    def tearDown(self):
        self.loop.close()
        super().tearDown()

    def test_playback_time_does_not_expire_the_window(self):
        gate = self.gate
        gate.hold()
        controller = self.controller
        loop = self.loop

        async def main():
            controller._vad_future = loop.create_future()
            loop.call_later(0.6, controller._vad_future.set_result, b"user-bytes")
            loop.call_later(0.5, gate.release)
            return await asyncio.wait_for(controller._await_utterance(), timeout=3)

        self.assertEqual(b"user-bytes", loop.run_until_complete(main()))

    def test_window_still_expires_when_nobody_speaks(self):
        controller = self.controller
        loop = self.loop

        async def main():
            controller._vad_future = loop.create_future()
            return await controller._await_utterance()

        with self.assertRaises(asyncio.TimeoutError):
            loop.run_until_complete(main())


if __name__ == "__main__":
    unittest.main()
