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
        """
        speaker = get_speaker()
        if speaker:
            await speaker.stop_device_audio()
            import open_xiaoai_server
            await open_xiaoai_server.start_recording()
            return

        import open_xiaoai_server
        await open_xiaoai_server.stop_playing()
        await open_xiaoai_server.start_recording()

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

        asyncio.run_coroutine_threadsafe(self._stop_device_playback(), loop)

        from core.xiaoai import XiaoAI
        XiaoAI.stop_conversation()

    def on_speech(self, speech_buffer: bytes):
        """Called by VAD when speech is detected."""
        pass

    def on_silence(self):
        """Called by VAD when silence is detected."""
        pass

    def consume_xiaoai_asr_result(
        self,
        dialog_id: str,
        text: str,
        is_final,
        is_vad_begin,
    ) -> bool:
        """Route XiaoAI native ASR results to the active external backend controller."""
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
        ).get("session_key", "agent:default:open-xiaoai-bridge")
        OpenAIManager._session_key = default_openai_session_key
        from core.dsh import DshManager
        default_dsh_session_key = self.config.get_app_config("dsh", {}).get(
            "session_key", "agent:main:open-xiaoai-bridge"
        )
        DshManager._session_key = default_dsh_session_key

        if kws:
            kws.pause()
        should_wakeup = await before_wakeup(
            get_speaker(),
            text,
            source,
            get_app(),
        )
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
