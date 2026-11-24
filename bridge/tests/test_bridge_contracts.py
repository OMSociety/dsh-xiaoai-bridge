"""Offline contracts for host callbacks, paired TTS and native build inputs."""
import asyncio
from pathlib import Path
import sys
import tomllib
import types
from unittest.mock import AsyncMock, Mock

import pytest

sys.modules.setdefault('dsh_xiaoai_server', types.SimpleNamespace())
from core.dsh import callback_base
from core.services import api_server


@pytest.mark.parametrize('value', ['https://bridge.example.org', 'http://user@localhost/path'])
def test_host_callback_requires_local_address(value):
    with pytest.raises(ValueError):
        callback_base(value)


def test_callback_pins_localhost():
    assert callback_base('http://localhost:1234/plugin/xiaoai/') == 'http://127.0.0.1:1234/plugin/xiaoai'


@pytest.mark.parametrize('override,expected', [({}, 'from-env'), ({'access_key': 'from-request'}, 'from-request')])
def test_doubao_http_resolves_credentials_before_provider(monkeypatch, override, expected):
    monkeypatch.setenv('DOUBAO_ACCESS_KEY', 'from-env')
    server = types.SimpleNamespace(config=Mock())
    server.config.get_app_config.return_value = {'app_id': 'app'}
    request = types.SimpleNamespace(json=AsyncMock(return_value={'text': 'fixture', 'blocking': True, **override}))
    provider = Mock()
    provider.return_value.resolve_audio_format.return_value = 'mp3'
    play = AsyncMock()
    monkeypatch.setattr(api_server, 'get_speaker', lambda: object())
    monkeypatch.setattr(api_server, 'DoubaoTTS', provider)
    monkeypatch.setattr(api_server.dsh_xiaoai_server, 'tts_play', play, raising=False)
    response = asyncio.run(api_server.APIServer.handle_tts_doubao(server, request))
    assert response.status == 200
    assert provider.call_args.kwargs['access_key'] == expected
    assert play.await_args.kwargs['access_key'] == expected


def test_container_build_includes_and_enforces_rust_lock():
    root = Path(__file__).resolve().parents[1]
    assert 'Cargo.lock' not in (root / '.dockerignore').read_text(encoding='utf-8').splitlines()
    assert 'maturin build --locked' in (root / 'Dockerfile').read_text(encoding='utf-8')
    lock = tomllib.loads((root / 'Cargo.lock').read_text(encoding='utf-8'))
    revisions = [p['source'].partition('#')[2] for p in lock['package'] if p.get('source', '').startswith('git+')]
    assert revisions and all(len(r) == 40 for r in revisions)
