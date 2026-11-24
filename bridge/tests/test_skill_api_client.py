"""Run bundled client paths with isolated configuration and a recording transport."""
import io
import os
import runpy
import sys
import urllib.error
from pathlib import Path
from unittest.mock import patch

import pytest

SKILL = Path(__file__).resolve().parents[1] / 'skills/xiaoai-tts'
sys.path.insert(0, str(SKILL / 'scripts'))
import api_client as client
import play_file
import tts_doubao

REMOTE = 'https://bridge.example.org'


@pytest.fixture(autouse=True)
def isolated(tmp_path):
    with patch.dict(os.environ, {'HOME': str(tmp_path), 'DSH_HOME': str(tmp_path),
                                 'CONFIG_PATH': str(tmp_path / 'config.py'), 'XIAOAI_API_TOKEN': 'local-fixture'}, clear=True):
        yield


@pytest.fixture
def capture(monkeypatch):
    calls = []
    def record(req, timeout):
        calls.append((req, timeout))
        return io.BytesIO(b'{"success":true}')
    monkeypatch.setattr(client, '_open', record)
    return calls


@pytest.mark.parametrize('upload', [False, True])
@pytest.mark.parametrize('remote', [False, True])
def test_destination_and_auth(tmp_path, capture, upload, remote):
    if remote:
        os.environ.update(OPENXIAOAI_BASE_URL=REMOTE, OPENXIAOAI_PAIRED_ORIGIN=REMOTE + ':443', OPENXIAOAI_REMOTE_TOKEN='paired-fixture')
    if upload:
        audio = tmp_path / 'sample.mp3'
        audio.write_bytes(b'sample')
        play_file.play_file(audio)
    else:
        client.check_health()
    (req, _), = capture
    assert req.full_url.startswith((REMOTE + ':443' if remote else 'http://127.0.0.1:9092') + '/api/')
    assert req.get_header('Authorization') == ('Bearer paired-fixture' if remote else None)
    if upload:
        boundary = req.get_header('Content-type').partition('boundary=')[2].encode()
        assert req.data.startswith(b'--' + boundary + b'\r\n')


@pytest.mark.parametrize('base,paired,key', [(REMOTE, '', 'a'), (REMOTE, REMOTE, ''),
    (REMOTE, 'https://other.example.org', 'a'), (REMOTE, REMOTE + ':8443', 'a'),
    ('http://bridge.example.org', 'http://bridge.example.org', 'a')])
def test_unpaired_requests_stop_before_transport(capture, base, paired, key):
    os.environ.update(OPENXIAOAI_BASE_URL=base, OPENXIAOAI_PAIRED_ORIGIN=paired, OPENXIAOAI_REMOTE_TOKEN=key)
    with pytest.raises(ValueError):
        client.check_health()
    assert capture == []


@pytest.mark.parametrize('deployment', ['managed', 'paired', 'paired-local'])
def test_client_request_matches_server_admission(deployment, capture):
    from core.services.api_auth import authorize, bearer_of, configured_token
    if deployment != 'managed':
        os.environ['OPENXIAOAI_REMOTE_TOKEN'] = 'origin-fixture'
    if deployment == 'paired':
        os.environ.update(OPENXIAOAI_BASE_URL=REMOTE, OPENXIAOAI_PAIRED_ORIGIN=REMOTE)
    client.check_health()
    (req, _), = capture
    # Managed bridge peer or TLS frontend on the same host as the paired backend.
    decision = authorize(configured_token(), bearer_of(dict(req.header_items())), '127.0.0.1')
    assert (decision is None) == (deployment != 'paired-local')


def test_redirect_is_refused():
    assert client._NoRedirect().redirect_request(None, None, 302, '', {}, REMOTE) is None


def test_401_names_pairing(monkeypatch):
    def refused(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 401, 'unauthorized', {}, None)
    monkeypatch.setattr(client, '_open', refused)
    with pytest.raises(RuntimeError, match='401.*OPENXIAOAI_REMOTE_TOKEN'):
        client.check_health()


def test_wrapper_timeout_reaches_selected_provider(monkeypatch, capture):
    tool = runpy.run_path(str(SKILL / 'tools/xiaoai-tts'))['main']
    providers = []
    def dispatch(script, args, capture):
        providers.append(script)
        monkeypatch.setattr(sys, 'argv', [script] + args)
        tts_doubao.main()
        return None, '', '', 0
    monkeypatch.setitem(tool.__globals__, 'run_script', dispatch)
    monkeypatch.setattr(sys, 'argv', ['xiaoai-tts', 'tts', 'fixture', '-t', '7500', '-s', 'voice-fixture'])
    with pytest.raises(SystemExit) as exit:
        tool()
    assert exit.value.code == 0 and providers == ['tts_doubao.py']
    (req, seconds), = capture
    assert seconds == 7.5 and b'voice-fixture' in req.data


@pytest.mark.parametrize('child_code', [1, 2])
def test_wrapper_propagates_error_without_resending(monkeypatch, child_code):
    tool = runpy.run_path(str(SKILL / 'tools/xiaoai-tts'))['main']
    providers = []
    def dispatch(script, args, capture):
        providers.append(script)
        return None, '', '', child_code
    monkeypatch.setitem(tool.__globals__, 'run_script', dispatch)
    monkeypatch.setattr(sys, 'argv', ['xiaoai-tts', 'tts', 'fixture'])
    with pytest.raises(SystemExit) as exit:
        tool()
    assert exit.value.code == child_code and providers == ['tts_doubao.py']
