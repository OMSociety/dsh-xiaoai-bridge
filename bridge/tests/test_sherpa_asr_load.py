"""`sherpa.py` 的后端装载与热重载（设置页切 `asrBackend` 靠它生效）。

为什么值得盯着：桥接器每秒轮询配置文件，`ConfigManager` 重载完会回调
ASR；如果这里只会"第一次装好就不再看配置"，用户切了后端就只能重启进程
（这正是修复前的情况），而选一个没装模型的后端时，日志和界面都不会说
一句。断言锁三件事：载荷没变不重建、载荷变了重建、装不上时留着旧的那个
并只警告一次。

全程用假的模型目录与假的 `sherpa_onnx.OfflineRecognizer`，不加载真模型。
"""

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pytest

from core.services.audio.asr import sherpa

SENSE_VOICE_DIR = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
PARAFORMER_DIR = "sherpa-onnx-paraformer-trilingual-zh-cantonese-en"


class _FakeConfig:
    """最小 ConfigManager 替身：只认 `get_app_config` 与监听器注册。"""

    def __init__(self, app_config):
        self.app = app_config
        self.listeners = []

    def get_app_config(self, path=None, default=None):
        if not path:
            return self.app
        value = self.app
        for key in path.split("."):
            if not isinstance(value, dict):
                return default
            value = value.get(key, default)
            if value is default:
                return default
        return value

    def add_reload_listener(self, callback):
        if callback not in self.listeners:
            self.listeners.append(callback)


class _Stream:
    def __init__(self):
        self.result = type("_Result", (), {"text": " 你好 世界 "})()
        self.rate = None

    def accept_waveform(self, sample_rate, samples):
        self.rate = sample_rate


class _Recognizer:
    """假 recognizer：`asr()` 只用到 create_stream/decode_stream。"""

    def __init__(self, factory_name):
        self.factory_name = factory_name
        self.decoded = 0

    def create_stream(self):
        return _Stream()

    def decode_stream(self, stream):
        self.decoded += 1


class _FakeRecognizerFactory:
    """替身 `sherpa_onnx.OfflineRecognizer`：只记谁被建、带了什么参数。"""

    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        if not name.startswith("from_"):
            raise AttributeError(name)

        def build(**kwargs):
            self.calls.append((name, kwargs))
            return _Recognizer(name)

        return build


class _FakeLogger:
    def __init__(self):
        self.events = []

    def _record(self, level, message, details=None, module=None):
        self.events.append((level, str(message), str(details) if details else ""))

    def asr_event(self, event, details="", module="ASR"):
        self._record("event", event, details)

    def debug(self, message, module=None):
        self._record("debug", message)

    def info(self, message, module=None):
        self._record("info", message)

    def warning(self, message, module=None):
        self._record("warning", message)

    def error(self, message, module=None):
        self._record("error", message)

    def warnings(self):
        return [row[1] for row in self.events if row[0] == "warning"]


class _Bench:
    """一个只有假模型目录的"本机"。"""

    def __init__(self, tmp_path, monkeypatch):
        self.models_root = tmp_path / "models"
        self.models_root.mkdir()
        self.config = _FakeConfig({"asr": {"model": "sense_voice", "int8": True}})
        self.factory = _FakeRecognizerFactory()
        self.logger = _FakeLogger()
        monkeypatch.setattr(sherpa, "get_model_file_path", self._model_path)
        monkeypatch.setattr(
            sherpa.ConfigManager, "instance", staticmethod(lambda: self.config)
        )
        monkeypatch.setattr(sherpa.sherpa_onnx, "OfflineRecognizer", self.factory)
        monkeypatch.setattr(sherpa, "logger", self.logger)

    def _model_path(self, name=""):
        return str(self.models_root / name) if name else str(self.models_root)

    def install(self, dirname, files=("model.int8.onnx", "tokens.txt")):
        target = self.models_root / dirname
        target.mkdir(parents=True, exist_ok=True)
        for filename in files:
            (target / filename).write_bytes(b"")
        return target

    def set_backend(self, backend, **extra):
        self.config.app["asr"] = {"model": backend, "int8": True, **extra}

    def new_asr(self):
        return sherpa._SherpaASR()

    def built(self):
        return [name for name, _kwargs in self.factory.calls]

    def events(self, level):
        return [message for kind, message, _details in self.logger.events if kind == level]


@pytest.fixture
def bench(tmp_path, monkeypatch):
    return _Bench(tmp_path, monkeypatch)


def _wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_loads_the_requested_backend(bench):
    bench.install(SENSE_VOICE_DIR)
    asr = bench.new_asr()

    asr._ensure_loaded()

    assert bench.built() == ["from_sense_voice"]
    # 中文锁定：`language="auto"` 会把短音频判成日文。
    assert bench.factory.calls[0][1]["language"] == "zh"
    assert asr.status()["requested"] == "sense_voice"
    assert asr.status()["active"] == "sense_voice"
    assert asr.status()["error"] is None


def test_a_second_call_does_not_rebuild(bench):
    bench.install(SENSE_VOICE_DIR)
    asr = bench.new_asr()

    asr._ensure_loaded()
    asr._ensure_loaded()

    assert bench.built() == ["from_sense_voice"]


def test_switching_the_backend_rebuilds_without_a_restart(bench):
    """修复前这里只会保持 sense_voice：切后端要重启进程才生效。"""
    bench.install(SENSE_VOICE_DIR)
    bench.install(PARAFORMER_DIR)
    asr = bench.new_asr()
    asr._ensure_loaded()

    bench.set_backend("paraformer")
    asr._ensure_loaded()

    assert bench.built() == ["from_sense_voice", "from_paraformer"]
    assert asr.status()["active"] == "paraformer"
    assert any("热重载" in message for message in bench.events("event"))


def test_int8_and_model_dir_are_part_of_the_payload_signature(bench):
    bench.install(
        SENSE_VOICE_DIR, files=("model.int8.onnx", "model.onnx", "tokens.txt")
    )
    asr = bench.new_asr()
    asr._ensure_loaded()

    bench.set_backend("sense_voice", int8=False)
    asr._ensure_loaded()

    assert bench.built() == ["from_sense_voice", "from_sense_voice"]
    assert bench.factory.calls[1][1]["model"].endswith("model.onnx")


def test_the_config_watcher_callback_hot_swaps_in_the_background(bench):
    bench.install(SENSE_VOICE_DIR)
    bench.install(PARAFORMER_DIR)
    asr = bench.new_asr()
    asr._ensure_loaded()

    assert bench.config.listeners, "第一次装载就该挂上配置重载监听器"

    bench.set_backend("paraformer")
    asr._on_config_reload({}, {})

    assert _wait_for(lambda: asr.status()["active"] == "paraformer"), bench.factory.calls


def test_a_missing_model_keeps_the_previous_recognizer_and_warns_once(bench):
    """防呆：选了没装模型的后端，不能把已经在用的那个弄没。"""
    bench.install(SENSE_VOICE_DIR)
    asr = bench.new_asr()
    asr._ensure_loaded()

    bench.set_backend("paraformer")
    asr._ensure_loaded()  # 不该抛
    asr._ensure_loaded()  # 也不该再试一次装载

    assert bench.built() == ["from_sense_voice"]
    assert asr.status()["active"] == "sense_voice"
    assert "paraformer" in asr.status()["error"]
    assert len(bench.logger.warnings()) == 1
    assert asr._recognizer is not None


def test_an_unknown_backend_falls_back_to_the_loaded_one(bench):
    bench.install(SENSE_VOICE_DIR)
    asr = bench.new_asr()
    asr._ensure_loaded()

    bench.set_backend("whisper")
    asr._ensure_loaded()

    assert bench.built() == ["from_sense_voice"]
    assert asr.status()["known"] is False
    assert asr.status()["active"] == "sense_voice"
    assert any("whisper" in message for message in bench.logger.warnings())


def test_an_unknown_backend_with_nothing_loaded_uses_the_default(bench):
    bench.install(SENSE_VOICE_DIR)
    asr = bench.new_asr()

    bench.set_backend("whisper")
    asr._ensure_loaded()

    assert bench.built() == ["from_sense_voice"]
    assert asr.status()["active"] == "sense_voice"


def test_when_nothing_can_be_loaded_it_still_raises(bench):
    """一个都装不上时，"让上层知道 ASR 不可用"才是对的状态。"""
    bench.install(PARAFORMER_DIR, files=("model.int8.onnx",))  # 缺 tokens.txt
    asr = bench.new_asr()

    bench.set_backend("paraformer")
    with pytest.raises(FileNotFoundError):
        asr._ensure_loaded()


def test_the_reload_thread_logs_instead_of_raising(bench):
    """后台线程里没人接异常：`_reload()` 必须自己咽下去并留下日志。"""
    asr = bench.new_asr()  # 一个模型都没有

    bench.set_backend("paraformer")
    asr._reload()

    assert bench.events("error"), bench.logger.events
    assert asr._recognizer is None


def test_available_backends_lists_what_is_installed(bench):
    asr = bench.new_asr()
    assert asr.available_backends() == []

    bench.install(SENSE_VOICE_DIR)
    bench.install(PARAFORMER_DIR)

    assert asr.available_backends() == ["sense_voice", "paraformer"]


def test_asr_decodes_with_the_recognizer_it_checked(bench):
    bench.install(SENSE_VOICE_DIR)
    bench.config.app["asr"]["replacements"] = {"世界": "地球"}
    asr = bench.new_asr()

    text = asr.asr(b"\x01\x00" * 160, sample_rate=16000)

    assert text == "你好 地球"
    assert asr._recognizer.decoded == 1
