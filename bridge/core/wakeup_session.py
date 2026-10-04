import asyncio

from core.ref import (
    get_app,
    get_kws,
    get_speaker,
)
from core.utils.config import ConfigManager
from core.utils.logger import logger


class WakeupSessionManager:
    """Dispatches wakeup events to the external backend controllers."""

    def __init__(self):
        self.config = ConfigManager.instance()
        self._openai_controller = None
        self._openai_task: asyncio.Task | None = None
        self._dsh_controller = None
        self._dsh_task: asyncio.Task | None = None

    def _get_loop(self):
        app = get_app()
        if app:
            return app.loop
        from core.xiaoai import XiaoAI
        return XiaoAI.async_loop

    async def _stop_device_playback(self):
        """Stop all audio playback on the device and restart recording.

        - killall tts_play.sh miplayer: stop blocking TTS (tts_play.sh + child miplayer)
        - mphelper pause: stop non-blocking TTS (mibrain text_to_speech via mediaplayer)
        - stop_playing: kill aplay (our PCM channel)
        - start_playing / start_recording: restart audio streams

        播放全停之后还要重置半双工闸门：被打断/被抢断的那一路留下的设备占用
        （`hold_until_device_stops` 的登记）否则会把麦克风通路继续关着，用户
        下一句进不来。重置必须排在设备命令之后，否则麦克风会在音箱还在响的
        时候就恢复收音（自问自答）。
        """
        speaker = get_speaker()
        if speaker:
            await speaker.stop_device_audio()
        else:
            import dsh_xiaoai_server
            await dsh_xiaoai_server.stop_playing()

        import dsh_xiaoai_server
        await dsh_xiaoai_server.start_recording()

        from core.utils.playback_gate import PlaybackGate

        PlaybackGate.reset()

    def on_interrupt(self):
        logger.info("[Wakeup] XiaoAI wakeup — interrupting active sessions")

        loop = self._get_loop()

        # Stop external backend conversations (cancels VAD + stops TTS stream + kills aplay)
        if self._openai_controller and self._openai_controller.is_active():
            self._openai_controller.stop()
        if self._openai_task and not self._openai_task.done():
            loop.call_soon_threadsafe(self._openai_task.cancel)
        if self._dsh_controller and self._dsh_controller.is_active():
            self._dsh_controller.stop()
        if self._dsh_task and not self._dsh_task.done():
            loop.call_soon_threadsafe(self._dsh_task.cancel)

        # API Server 的播报队列也要一起打断：只停设备上的当前一路，早先排队的
        # 话会在闸门放行后接着念。队列任务住在 app 循环里，这里通常在别的线程
        # 上，所以走 call_soon_threadsafe（闸门由 _stop_device_playback 重置）。
        from core.services.api_server import cancel_pending_plays

        loop.call_soon_threadsafe(cancel_pending_plays)

        asyncio.run_coroutine_threadsafe(self._stop_device_playback(), loop)

        from core.xiaoai import XiaoAI
        XiaoAI.stop_conversation()

    def on_speech(self, speech_buffer: bytes):
        """Called by VAD when speech is detected."""
        pass

    def on_silence(self):
        """Called by VAD when silence is detected."""
        pass

    @staticmethod
    def is_playback_active() -> bool:
        """播报期间（半双工闸门关着）为 True。

        `consume_xiaoai_asr_result` 在闸门关着时丢弃结果并返回 False，调用方
        （`XiaoAI.on_event`）无法据此区分"没有活动会话、可以继续走"和"这是播报
        期的回声、必须到此为止"，所以另开这一个只读查询。
        """
        from core.utils.playback_gate import PlaybackGate

        return PlaybackGate.closed

    def consume_xiaoai_asr_result(
        self,
        dialog_id: str,
        text: str,
        is_final,
        is_vad_begin,
    ) -> bool:
        """Route XiaoAI native ASR results to the active external backend controller."""
        from core.utils.playback_gate import PlaybackGate

        if PlaybackGate.closed:
            # 小爱自己的识别同样会听到我们刚播出去的回复，播报期间的结果一律
            # 不算用户输入，否则就会自问自答。
            logger.debug(f"[Wakeup] 忽略播报期间的识别结果: {text!r}")
            return False

        for controller in (
            self._openai_controller,
            self._dsh_controller,
        ):
            if controller and controller.is_active():
                return controller.consume_xiaoai_recognize_result(
                    dialog_id=dialog_id,
                    text=text,
                    is_final=is_final,
                    is_vad_begin=is_vad_begin,
                )
        return False

    async def wakeup(self, text, source):
        before_wakeup = self.config.get_app_config("wakeup.before_wakeup")
        kws = get_kws()
        logger.debug(f"[Wakeup] Received wakeup request from {source}: {text}")

        # Reset session_key to config default before each wakeup,
        # so paths that don't call set_openai_session_key() always use the default.
        from core.openai import OpenAIManager
        default_openai_session_key = self.config.get_app_config(
            "openai", {}
        ).get("session_key", "agent:default:dsh-xiaoai-bridge")
        OpenAIManager._session_key = default_openai_session_key
        from core.dsh import DshManager
        default_dsh_session_key = self.config.get_app_config("dsh", {}).get(
            "session_key", "agent:main:dsh-xiaoai-bridge"
        )
        DshManager._session_key = default_dsh_session_key

        if kws:
            kws.pause()
        try:
            should_wakeup = await before_wakeup(
                get_speaker(),
                text,
                source,
                get_app(),
            )
        finally:
            # 与 pause 配对：`before_wakeup` 是用户可改的配置函数（bridge/config.py
            # 渲染出来的），抛错或被取消时也必须恢复唤醒词检测，否则 KWS 永久
            # paused、音箱再也叫不醒，只能重启桥接器。
            if kws:
                kws.resume()
        logger.info(f"[Wakeup] before_wakeup returned: {should_wakeup}")
        if should_wakeup is not None:
            await self.reset_all_sessions()

        if should_wakeup == "openai":
            await self._start_openai_conversation()
        elif should_wakeup == "dsh":
            await self._start_dsh_conversation()

    async def _start_openai_conversation(self):
        """Start an OpenAI-compatible continuous conversation session."""
        from core.openai_conversation import OpenAIConversationController

        kws = get_kws()
        if kws:
            kws.pause()
        try:
            self._openai_controller = OpenAIConversationController()
            self._openai_task = asyncio.create_task(self._openai_controller.start())
            await self._openai_task
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.error(
                f"[Wakeup] OpenAI conversation failed: {type(exc).__name__}: {exc}",
                module="Wakeup",
            )
        finally:
            self._openai_controller = None
            self._openai_task = None
            if kws:
                kws.resume()

    async def _start_dsh_conversation(self):
        """Start a DSH continuous conversation session.

        This runs independently of the wakeup session state machine.
        KWS is paused during the conversation and resumed when done.
        """
        from core.dsh_conversation import DshConversationController

        kws = get_kws()
        if kws:
            kws.pause()
        try:
            self._dsh_controller = DshConversationController()
            self._dsh_task = asyncio.create_task(self._dsh_controller.start())
            await self._dsh_task
        except asyncio.CancelledError:
            pass  # interrupted cleanly by on_interrupt
        except Exception as exc:
            logger.error(
                f"[Wakeup] DSH conversation failed: {type(exc).__name__}: {exc}",
                module="Wakeup",
            )
        finally:
            self._dsh_controller = None
            self._dsh_task = None
            if kws:
                kws.resume()

    async def reset_all_sessions(self):
        """Reset all active sessions before starting a new one.

        Stops XiaoAI continuous conversation and any external backend
        continuous conversation.
        """
        from core.xiaoai import XiaoAI

        # Stop XiaoAI continuous conversation
        XiaoAI.stop_conversation()

        # Stop external backend continuous conversations (also stop their TTS stream)
        if self._openai_controller and self._openai_controller.is_active():
            self._openai_controller.stop()
        if self._dsh_controller and self._dsh_controller.is_active():
            self._dsh_controller.stop()

        # Stop all audio playback on the device
        await self._stop_device_playback()

        logger.debug("[Wakeup] All sessions reset")


EventManager = WakeupSessionManager()
