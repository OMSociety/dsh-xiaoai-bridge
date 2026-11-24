"""Configured voices, single attempts, and the scopes of local playback stops."""
import asyncio
import sys
import types
from unittest.mock import AsyncMock, Mock, patch

import pytest
from aiohttp.test_utils import TestClient, TestServer

sys.modules.setdefault('dsh_xiaoai_server', types.SimpleNamespace())
from core.external_conversation import ExternalConversationController
from core.services import api_server, speaker as speaker_module
from core.services.tts.router import TTSRouter


def test_managed_queue_routes_tool_and_reply_once_each():
    async def scenario():
        service = api_server.APIServer(port=0)
        speaker = types.SimpleNamespace(play=AsyncMock(return_value=True))
        settings = {'session_key': 'session', 'tts_speaker': 'default',
                    'session_tts_speakers': {'session': 'selected'}, 'tts_speed': 1.2}
        with (patch.object(api_server, 'get_speaker', return_value=speaker),
              patch('core.ref.get_speaker', return_value=speaker),
              patch.object(service.config, 'get_app_config', return_value=settings),
              patch.object(TTSRouter, '_play_doubao', new=AsyncMock()) as cloud):
            async with TestClient(TestServer(service.app)) as client:
                for provider in ('xiaoai', 'doubao'):
                    settings['tts_provider'] = provider
                    for source in ('tool', 'reply'):
                        r = await client.post('/api/play/text', json={'text': source})
                        assert (await r.json())['queued']
                    await asyncio.gather(*api_server._play_tasks)
                assert [c.kwargs['text'] for c in speaker.play.await_args_list] == ['tool', 'reply']
                assert [c.args[0] for c in cloud.await_args_list] == ['tool', 'reply']
                assert all(c.kwargs['tts_speaker'] == 'selected' and c.kwargs['tts_speed'] == 1.2
                           for c in cloud.await_args_list)
                for provider in ('doubao', 'unknown'):
                    cloud.side_effect = RuntimeError('result unknown')
                    settings['tts_provider'] = provider
                    r = await client.post('/api/play/text', json={'text': 'one attempt', 'blocking': True})
                    assert r.status == 500 and not (await r.json())['success']
                assert cloud.await_count == 3 and speaker.play.await_count == 2
    asyncio.run(scenario())


def test_session_stop_cancels_only_its_synthesis():
    async def scenario():
        entered = asyncio.Event()
        async def synthesize(*args, **kwargs):
            entered.set()
            await asyncio.Future()
        backend = types.SimpleNamespace(_play_response_with_tts=AsyncMock(side_effect=synthesize),
                                        get_tts_speaker_for_session_key=lambda: 'voice')
        class Controller(ExternalConversationController):
            MANAGER = backend
        controller = Controller()
        controller.active = True
        controller.uses_xiaoai_asr = lambda: False
        with (patch('core.external_conversation.dsh_xiaoai_server',
                    types.SimpleNamespace(begin_playback_session=lambda: 71, stop_tts_playback=Mock())) as native,
              patch.object(api_server, 'cancel_pending_plays') as global_stop):
            task = asyncio.create_task(controller._play_tts('reply'))
            await asyncio.wait_for(entered.wait(), 2)
            controller.stop()
            with pytest.raises(asyncio.CancelledError):
                await task
            native.stop_tts_playback.assert_called_once_with(71)
            global_stop.assert_not_called()
            backend._play_response_with_tts.assert_awaited_once_with('reply', tts_speaker='voice', playback_token=71)
    asyncio.run(scenario())


def test_native_dialog_stop_leaves_pcm_running_but_global_stop_invalidates_writers():
    speaker = object.__new__(speaker_module.SpeakerManager)
    speaker.run_shell = AsyncMock(return_value=types.SimpleNamespace(exit_code=0))
    with patch.object(speaker_module, 'dsh_xiaoai_server',
                      types.SimpleNamespace(begin_playback_session=Mock(), stop_playing=AsyncMock())) as native:
        asyncio.run(speaker.stop_native_dialog_audio())
        native.begin_playback_session.assert_not_called()
        native.stop_playing.assert_not_awaited()
        asyncio.run(speaker.stop_device_audio())
        native.begin_playback_session.assert_called_once()
        native.stop_playing.assert_awaited_once()
        assert speaker.run_shell.await_count == 2
