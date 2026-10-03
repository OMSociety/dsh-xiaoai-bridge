import importlib
import os
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch


sys.modules.setdefault("dsh_xiaoai_server", types.SimpleNamespace())

router_module = importlib.import_module("core.services.tts.router")
TTSRouter = router_module.TTSRouter


class TTSRouterProviderTest(unittest.TestCase):
    def test_explicit_provider_is_shared_by_all_backends(self):
        for provider in ("xiaoai", "doubao", "openai", "mlx_audio"):
            self.assertEqual(
                provider,
                TTSRouter.resolve_provider(provider, "xiaoai"),
            )

    def test_missing_provider_preserves_legacy_speaker_selection(self):
        self.assertEqual("xiaoai", TTSRouter.resolve_provider(None, "xiaoai"))
        self.assertEqual("doubao", TTSRouter.resolve_provider(None, None))
        self.assertEqual("doubao", TTSRouter.resolve_provider(None, "alloy"))


class BackendTTSProviderConfigTest(unittest.TestCase):
    def test_dsh_reads_tts_provider_without_changing_existing_speaker_keys(self):
        module = importlib.import_module("core.dsh")
        manager = module.DshManager
        config = {
            "tts_provider": "mlx_audio",
            "tts_speaker": "xiaoai",
            "session_tts_speakers": {"agent:assistant:main": "xiaoai"},
        }
        config_manager = types.SimpleNamespace(
            get_app_config=lambda *_args: config,
            add_reload_listener=lambda *_args: None,
        )
        previous_listener_state = manager._reload_listener_registered
        previous_session_tts_speakers = manager._session_tts_speakers
        try:
            manager._reload_listener_registered = False
            with patch.object(
                module.ConfigManager, "instance", return_value=config_manager
            ):
                manager.reload_from_config(enabled=True)
            self.assertEqual("mlx_audio", manager._tts_provider)
            self.assertEqual("xiaoai", manager._tts_speaker)
            self.assertEqual(
                {"agent:assistant:main": "xiaoai"}, manager._session_tts_speakers
            )
        finally:
            manager._reload_listener_registered = previous_listener_state
            manager._session_tts_speakers = previous_session_tts_speakers


class BackendTTSRoutingTest(unittest.IsolatedAsyncioTestCase):
    async def test_dsh_delegates_to_shared_router(self):
        module = importlib.import_module("core.dsh")
        manager = module.DshManager
        previous = (
            manager._tts_provider,
            manager._tts_speaker,
            manager._tts_speed,
            manager._session_key,
            manager._session_tts_speakers,
            manager._initialized,
        )
        manager._tts_provider = "mlx_audio"
        manager._tts_speaker = "xiaoai"
        manager._tts_speed = 1.1
        manager._session_key = "agent:assistant:main"
        manager._session_tts_speakers = {}
        manager._initialized = True
        try:
            with patch.object(
                router_module.TTSRouter, "play", new=AsyncMock()
            ) as play:
                await manager._play_response_with_tts("你好", playback_token=7)
            play.assert_awaited_once_with(
                "你好",
                configured_provider="mlx_audio",
                tts_speaker="xiaoai",
                tts_speed=1.1,
                playback_token=7,
                log_prefix="DSH",
            )
        finally:
            (
                manager._tts_provider,
                manager._tts_speaker,
                manager._tts_speed,
                manager._session_key,
                manager._session_tts_speakers,
                manager._initialized,
            ) = previous


class DoubaoCredentialSourceTest(unittest.IsolatedAsyncioTestCase):
    """The Doubao Access Token follows the API token's rule: environment first."""

    def setUp(self):
        self.previous = os.environ.pop("DOUBAO_ACCESS_KEY", None)
        self.addCleanup(self._restore)

    def _restore(self):
        if self.previous is None:
            os.environ.pop("DOUBAO_ACCESS_KEY", None)
        else:
            os.environ["DOUBAO_ACCESS_KEY"] = self.previous

    async def _play(self, config):
        config_manager = types.SimpleNamespace(get_app_config=lambda *_args: config)
        client = types.SimpleNamespace(
            resource_id="seed-tts-1.0",
            resolve_audio_format=lambda text: "mp3",
        )
        with patch.object(
            router_module.ConfigManager, "instance", return_value=config_manager
        ), patch.object(
            router_module, "DoubaoTTS", return_value=client
        ) as client_class, patch.object(
            router_module.dsh_xiaoai_server, "tts_play", new=AsyncMock(), create=True
        ):
            await TTSRouter._play_doubao(
                "你好", tts_speaker="xiaoai", tts_speed=1.0, playback_token=None
            )
        return client_class.call_args.kwargs

    async def test_env_token_wins_over_the_config_value(self):
        os.environ["DOUBAO_ACCESS_KEY"] = "from-env"
        kwargs = await self._play({"app_id": "app", "access_key": "from-config"})
        self.assertEqual("from-env", kwargs["access_key"])

    async def test_config_value_is_the_fallback_for_a_manual_run(self):
        kwargs = await self._play({"app_id": "app", "access_key": "from-config"})
        self.assertEqual("from-config", kwargs["access_key"])

    async def test_missing_credentials_raise_before_any_synthesis(self):
        with self.assertRaises(ValueError):
            await self._play({"app_id": "app"})


if __name__ == "__main__":
    unittest.main()
