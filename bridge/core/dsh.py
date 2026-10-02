"""DSH (DeepSeek Harness) manager.

Talks to the `dsh-xiaoai-bridge` DSH plugin over HTTP on the same machine.
The plugin runs inside the DSH desktop app; this bridge runs as a child
process of that same plugin, so the endpoint is always loopback.

There are two directions of traffic, and only the first one lives here:

  1. Bridge -> DSH (this module). The bridge POSTs a recognized user
     utterance to the plugin's `/asr` route. The plugin injects it into the
     DSH agent session bound to this speaker and returns immediately.

  2. DSH -> Bridge (NOT this module). When the DSH model wants to speak it
     calls the plugin's `xiaoai_speak` tool, which calls this bridge's own
     API Server (`/api/play/text`). The plugin owns the "did the model
     already speak this turn" bookkeeping, so the bridge never speaks a
     reply on its own and cannot double-speak.

Because of (2) a conversation turn here is fire-and-forget: the bridge
submits the utterance and goes straight back to listening. The plugin
speaks when the model has something to say.
"""

import asyncio
import uuid
from typing import Any

import aiohttp

from core.utils.base import get_env
from core.utils.config import ConfigManager
from core.utils.logger import logger

DEFAULT_BASE_URL = "http://127.0.0.1:19387/plugin/xiaoai"


class DshManager:
    """Manager for the DSH bridge plugin."""

    XIAOAI_TTS_SPEAKER = "xiaoai"

    _initialized = False
    _reload_listener_registered = False
    _enabled = False
    _base_url = DEFAULT_BASE_URL
    _api_key = ""
    _session_key = "agent:main:open-xiaoai-bridge"
    _device_name = ""
    _device_host = ""
    _timeout = 120
    _tts_provider: str | None = None
    _tts_speaker = None
    _session_tts_speakers: dict[str, str] = {}
    _tts_speed = 1.0
    _rule_prompt = ""
    _rule_prompt_for_skill = ""
    _sessions: dict[str, list[dict[str, str]]] = {}
    _response_events: dict[str, asyncio.Future] = {}
    _response_texts: dict[str, str] = {}
    _response_tts_speakers: dict[str, str | None] = {}
    _connected = False
    last_error: str | None = None

    # ---- lifecycle ----

    @classmethod
    def initialize_from_config(cls, enabled: bool | None = None):
        logger.info("[DSH] Initializing from config...")
        cls.reload_from_config(enabled=enabled)
        cls._initialized = True

    @classmethod
    def reload_from_config(cls, enabled: bool | None = None):
        """Refresh DSH settings from config.py."""
        config_manager = ConfigManager.instance()
        if not cls._reload_listener_registered:
            config_manager.add_reload_listener(
                lambda _old, _new: cls.reload_from_config()
            )
            cls._reload_listener_registered = True

        config = config_manager.get_app_config("dsh", {})

        if enabled is not None:
            cls._enabled = enabled
        else:
            env_enabled = get_env("DSH_ENABLE")
            cls._enabled = (
                env_enabled.lower() in ("1", "true", "yes")
                if env_enabled is not None
                else False
            )

        cls._base_url = str(config.get("base_url", DEFAULT_BASE_URL)).rstrip("/")
        # The shared secret lives in the DSH credential store and reaches the
        # bridge through the plugin's spawn environment, so prefer the env var
        # and treat the config value as a fallback for manual runs.
        env_token = get_env("XIAOAI_API_TOKEN")
        cls._api_key = str(env_token or config.get("token", "") or "")
        cls._session_key = str(
            config.get("session_key", "agent:main:open-xiaoai-bridge")
        )
        cls._device_name = str(
            get_env("XIAOAI_DEVICE_NAME") or config.get("device_name", "") or ""
        )
        # The plugin hands the speaker address down through the spawn
        # environment, so one config.py can still serve several speakers.
        cls._device_host = str(
            get_env("XIAOAI_DEVICE_HOST") or config.get("device_host", "") or ""
        )
        cls._timeout = int(config.get("response_timeout", 120))

        configured_provider = config.get("tts_provider")
        cls._tts_provider = (
            str(configured_provider).strip().lower() if configured_provider else None
        )
        cls._tts_speaker = config.get("tts_speaker", None)
        cls._session_tts_speakers = (
            {
                str(key): str(value)
                for key, value in config.get("session_tts_speakers", {}).items()
                if key and value
            }
            if isinstance(config.get("session_tts_speakers", {}), dict)
            else {}
        )
        cls._tts_speed = float(config.get("tts_speed", 1.0))
        cls._rule_prompt = str(config.get("rule_prompt", "") or "")
        cls._rule_prompt_for_skill = str(config.get("rule_prompt_for_skill", "") or "")

        if cls._enabled:
            logger.info(f"[DSH] Enabled, base_url={cls._base_url}")

    @classmethod
    def is_enabled(cls) -> bool:
        return cls._enabled

    @classmethod
    def is_connected(cls) -> bool:
        return cls._connected

    @classmethod
    async def connect(cls):
        """Probe the plugin health route.

        A failure here is expected whenever DSH is not running: the plugin
        hosts the bridge process, but the bridge can also be started by hand.
        Record the state and move on instead of raising.
        """
        if not cls._initialized:
            cls.initialize_from_config()
        cls._connected = False
        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=10)
            ) as session:
                async with session.get(
                    cls._health_url(), headers=cls._headers()
                ) as response:
                    body: Any = await response.json(content_type=None)
                    if response.status >= 400:
                        raise RuntimeError(f"HTTP {response.status}: {body}")
            if isinstance(body, dict) and body.get("ok"):
                cls._connected = True
                bridge = (body.get("health") or {}).get("bridge") or {}
                logger.info(
                    f"[DSH] Connected to plugin {body.get('plugin')} "
                    f"{body.get('version')} (namespace={body.get('namespace')}, "
                    f"bridge_managed={bridge.get('managed')})"
                )
            else:
                raise RuntimeError(f"unexpected health payload: {body!r}")
        except Exception as exc:
            cls.last_error = f"{type(exc).__name__}: {exc}"
            logger.warning(
                f"[DSH] Plugin not reachable at {cls._base_url}: {cls.last_error}"
            )

    @classmethod
    async def close(cls):
        cls._connected = False
        for waiter in list(cls._response_events.values()):
            if waiter and not waiter.done():
                waiter.cancel()
        cls._response_events.clear()
        cls._response_texts.clear()
        cls._response_tts_speakers.clear()

    @classmethod
    def set_session_key(cls, session_key: str):
        """Switch the active session for the next utterance."""
        cls._session_key = session_key

    # ---- url / headers ----

    @classmethod
    def _health_url(cls) -> str:
        return cls._base_url.rstrip("/") + "/health"

    @classmethod
    def _asr_url(cls) -> str:
        return cls._base_url.rstrip("/") + "/asr"

    @classmethod
    def _headers(cls) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if cls._api_key:
            headers["Authorization"] = f"Bearer {cls._api_key}"
        return headers

    # ---- tts ----

    @classmethod
    def get_tts_speaker_for_session_key(
        cls, session_key: str | None = None
    ) -> str | None:
        target_session_key = session_key or cls._session_key
        return cls._session_tts_speakers.get(target_session_key) or cls._tts_speaker

    @classmethod
    async def _play_response_with_tts(
        cls,
        text: str,
        tts_speaker: str | None = None,
        playback_token: int | None = None,
    ):
        """Synthesize text and play it through the speaker."""
        from core.services.tts.router import TTSRouter

        resolved_tts_speaker = tts_speaker or cls.get_tts_speaker_for_session_key()
        await TTSRouter.play(
            text,
            configured_provider=cls._tts_provider,
            tts_speaker=resolved_tts_speaker,
            tts_speed=cls._tts_speed,
            playback_token=playback_token,
            log_prefix="DSH",
        )

    # ---- send / wait ----

    @classmethod
    async def send(cls, text: str, wait_response: bool = False) -> str | None:
        run_id = await cls._send_and_track(text)
        if run_id is None:
            return None
        if not wait_response:
            asyncio.create_task(cls._wait_response(run_id))
            return run_id
        try:
            return await cls._wait_response(run_id)
        finally:
            cls._response_tts_speakers.pop(run_id, None)

    @classmethod
    async def send_and_play_reply(
        cls, text: str, wait_response: bool = False
    ) -> str | None:
        run_id = await cls._send_and_track(text)
        if run_id is None:
            return None
        try:
            response_text = await cls._wait_response(run_id)
            if response_text:
                await cls._play_response_with_tts(
                    response_text,
                    tts_speaker=cls._response_tts_speakers.get(run_id),
                )
            return response_text
        finally:
            cls._response_tts_speakers.pop(run_id, None)

    @classmethod
    async def _send_and_track(cls, text: str) -> str | None:
        if not cls._initialized:
            cls.initialize_from_config()
        if not cls._enabled:
            logger.warning("[DSH] send called but backend is disabled")
            return None

        run_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        cls._response_events[run_id] = loop.create_future()
        cls._response_texts[run_id] = ""
        cls._response_tts_speakers[run_id] = cls.get_tts_speaker_for_session_key()
        logger.user_speech(text, module=f"DSH({cls._session_key})")
        asyncio.create_task(cls._submit_utterance(run_id, text))
        return run_id

    @classmethod
    async def _wait_response(cls, run_id: str) -> str | None:
        event = cls._response_events.get(run_id)
        if not event:
            logger.warning(f"[DSH] No event found for run {run_id}")
            return None
        try:
            await asyncio.wait_for(event, timeout=cls._timeout)
            return cls._response_texts.pop(run_id, "") or None
        except asyncio.TimeoutError:
            logger.warning(f"[DSH] Timeout waiting for response (runId: {run_id})")
            return None
        finally:
            cls._response_events.pop(run_id, None)
            cls._response_texts.pop(run_id, None)

    # ---- http ----

    @classmethod
    async def _submit_utterance(cls, run_id: str, text: str):
        """POST one utterance to the plugin and resolve the run future.

        The plugin answers as soon as the message is injected into the DSH
        session; the spoken reply (if any) comes back later through the
        plugin's `xiaoai_speak` tool, not through this response.
        """
        payload: dict[str, Any] = {
            "text": text,
            "session_key": cls._session_key,
            "device_name": cls._device_name,
            "device_host": cls._device_host,
            "source": "kws",
        }
        reply: str | None = None
        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=cls._timeout)
            ) as session:
                async with session.post(
                    cls._asr_url(), json=payload, headers=cls._headers()
                ) as response:
                    body: Any = await response.json(content_type=None)
                    if response.status >= 400:
                        message = (
                            body.get("error", body) if isinstance(body, dict) else body
                        )
                        raise RuntimeError(f"HTTP {response.status}: {message}")
            if isinstance(body, dict):
                reply = body.get("reply") or None
            cls._connected = True
        except Exception as exc:
            cls.last_error = f"{type(exc).__name__}: {exc}"
            cls._connected = False
            logger.error(f"[DSH] Failed to submit utterance: {cls.last_error}")
        finally:
            if reply:
                cls._response_texts[run_id] = reply
                logger.ai_response(reply, module=f"DSH({cls._session_key})")
            waiter = cls._response_events.get(run_id)
            if waiter and not waiter.done():
                waiter.get_loop().call_soon_threadsafe(waiter.set_result, None)
