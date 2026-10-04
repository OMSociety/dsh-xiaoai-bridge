"""`sherpa.py` 的后端装载与热重载（设置页切 `asrBackend` 靠它生效）。

为什么值得盯着：桥接器每秒轮询配置文件，`ConfigManager` 重载完会回调
ASR；如果这里只会"第一次装好就不再看配置"，用户切了后端就只能重启进程
（这正是修复前的情况），而选一个没装模型的后端时，日志和界面都不会说
一句。断言锁这些事：载荷没变不重建、载荷变了重建、装不上时留着旧的那个
并只警告一次，以及**装不上的签名不能记成终身拒绝**——失败要带冷却，
模型文件事后补齐时更要立刻放行重试（旧实现里"把模型装上再说话"是死路）。

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
FIRE_RED_DIR = "sherpa-onnx-fire-red-asr-large-zh_en-2025-02-16"


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


# ---- R4-1：装载失败是"带冷却的失败"，不是终身拒绝 --------------------


def test_installing_the_model_after_a_failure_retries_on_the_next_sentence(bench):
    """修复前这里是死路：模型装上后继续说话也永远不会生效。

    失败当刻文件不齐（`_failed_files_ready is False`），所以文件一补齐就
    立刻放行，不必干等冷却——这是最自然的恢复路径。
    """
    bench.install(SENSE_VOICE_DIR)
    asr = bench.new_asr()
    asr._ensure_loaded()

    bench.set_backend("fire_red_asr")  # 本机没装
    asr._ensure_loaded()

    assert asr._failed_key[0] == "fire_red_asr"
    assert asr._failed_at > 0.0
    assert asr._failed_files_ready is False
    assert asr.status()["known"] is True
    assert asr.status()["active"] == "sense_voice"
    assert asr.status()["error"]
    assert "fire_red_asr" not in asr.status()["available"]
    assert len(bench.logger.warnings()) == 1

    bench.install(
        FIRE_RED_DIR, files=("encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt")
    )
    asr._ensure_loaded()  # 不等冷却：文件补齐就是放行条件

    assert bench.built() == ["from_sense_voice", "from_fire_red_asr"]
    assert asr.status()["active"] == "fire_red_asr"
    assert "fire_red_asr" in asr.status()["available"]
    assert asr.status()["error"] is None
    assert asr._last_error is None
    assert asr._failed_key is None
    assert asr._failed_at == 0.0
    assert len(bench.logger.warnings()) == 1  # 失败那条不重复
    assert any("恢复" in message for message in bench.events("event"))


def test_a_missing_tokens_file_is_retried_once_it_appears(bench):
    """缺 tokens.txt 与缺整个模型目录一样是"补上就当场恢复"。"""
    bench.install(SENSE_VOICE_DIR)
    asr = bench.new_asr()
    asr._ensure_loaded()

    bench.install(PARAFORMER_DIR, files=("model.int8.onnx",))  # 缺 tokens.txt
    bench.set_backend("paraformer")
    asr._ensure_loaded()

    assert "tokens.txt" in asr.status()["error"]
    assert asr._failed_files_ready is False
    assert asr.status()["active"] == "sense_voice"

    (bench.models_root / PARAFORMER_DIR / "tokens.txt").write_bytes(b"")
    asr._ensure_loaded()

    assert bench.built() == ["from_sense_voice", "from_paraformer"]
    assert asr.status()["active"] == "paraformer"
    assert asr.status()["error"] is None


def test_a_dependency_failure_retries_only_once_per_cooldown(bench, monkeypatch):
    """文件都在时的失败（依赖层面）只能等冷却，且每次重试都重新计时。

    这就是原来那条防呆要守住的东西：不能让每一句话都等一次注定失败的装载。
    """
    bench.install(SENSE_VOICE_DIR)
    bench.install(PARAFORMER_DIR)
    asr = bench.new_asr()
    asr._ensure_loaded()

    def broken_build(backend, model_dir):
        attempts.append(backend)
        raise RuntimeError("onnxruntime 装不上")

    attempts = []
    monkeypatch.setattr(asr, "_build", broken_build)
    bench.set_backend("paraformer")
    asr._ensure_loaded()

    assert attempts == ["paraformer"]
    assert asr._failed_key[0] == "paraformer"
    assert asr._failed_files_ready is True  # 缺的不是模型文件
    assert asr.status()["active"] == "sense_voice"
    assert "onnxruntime" in asr.status()["error"]

    asr._ensure_loaded()
    asr._ensure_loaded()  # 冷却内：文件齐也不重试
    assert attempts == ["paraformer"]
    assert bench.built() == ["from_sense_voice"]
    assert len(bench.logger.warnings()) == 1

    fresh = asr._failed_at
    asr._failed_at = fresh - sherpa._FAILED_RETRY_COOLDOWN_SECONDS - 1.0
    asr._ensure_loaded()  # 冷却过后放行一次；依赖还是坏的，于是又失败
    assert attempts == ["paraformer", "paraformer"]
    # 冷却按"最近一次失败"重新计时，不是每一句话都重试一次。
    assert asr._failed_at > fresh - sherpa._FAILED_RETRY_COOLDOWN_SECONDS
    assert bench.built() == ["from_sense_voice"]
    assert len(bench.logger.warnings()) == 2  # 新一轮失败各自警告一次

    asr._ensure_loaded()  # 新的冷却窗口内，仍然不重试
    assert attempts == ["paraformer", "paraformer"]
    assert bench.built() == ["from_sense_voice"]


def test_the_cooldown_expiry_retries_a_dependency_failure(bench, monkeypatch):
    """依赖修好后不必重启、也不必切走再切回：冷却到点自动恢复。"""
    bench.install(SENSE_VOICE_DIR)
    bench.install(PARAFORMER_DIR)
    asr = bench.new_asr()
    asr._ensure_loaded()

    real_build = asr._build

    def broken_build(backend, model_dir):
        raise RuntimeError("依赖坏了")

    monkeypatch.setattr(asr, "_build", broken_build)
    bench.set_backend("paraformer")
    asr._ensure_loaded()
    assert asr.status()["error"]

    monkeypatch.setattr(asr, "_build", real_build)  # 依赖修好了
    asr._failed_at -= sherpa._FAILED_RETRY_COOLDOWN_SECONDS + 1.0  # 冷却已过

    asr._ensure_loaded()

    assert bench.built() == ["from_sense_voice", "from_paraformer"]
    assert asr.status()["active"] == "paraformer"
    assert asr.status()["error"] is None
    assert asr._failed_key is None
    assert asr._failed_at == 0.0
    assert any("恢复" in message for message in bench.events("event"))


def test_the_config_watcher_can_recover_after_the_model_appears(bench):
    """监听器那一侧的短路同样要松开：补上模型后下一次配置重载就恢复。"""
    bench.install(SENSE_VOICE_DIR)
    asr = bench.new_asr()
    asr._ensure_loaded()

    bench.set_backend("paraformer")
    asr._ensure_loaded()  # 失败，写进 `_failed_key`
    assert asr._failed_key[0] == "paraformer"

    asr._on_config_reload({}, {})  # 冷却内 + 文件没补齐：不该重建
    assert bench.built() == ["from_sense_voice"]

    bench.install(PARAFORMER_DIR)
    asr._on_config_reload({}, {})

    assert _wait_for(lambda: asr.status()["active"] == "paraformer"), bench.factory.calls
    assert asr.status()["error"] is None


def test_switching_away_and_back_clears_the_failure_record(bench):
    """另一条恢复路径：切到能装的后端（成功装载清空失败记录）再切回来。"""
    bench.install(SENSE_VOICE_DIR)
    bench.install(PARAFORMER_DIR)
    asr = bench.new_asr()
    asr._ensure_loaded()

    bench.set_backend("fire_red_asr")  # 没装
    asr._ensure_loaded()
    assert asr._failed_key is not None

    bench.set_backend("paraformer")  # 能装：这次成功装载把失败记录清空
    asr._ensure_loaded()
    assert asr._failed_key is None
    assert asr.status()["error"] is None

    bench.install(
        FIRE_RED_DIR, files=("encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt")
    )
    bench.set_backend("fire_red_asr")
    asr._ensure_loaded()

    assert bench.built() == [
        "from_sense_voice",
        "from_paraformer",
        "from_fire_red_asr",
    ]
    assert asr.status()["active"] == "fire_red_asr"
    assert asr.status()["error"] is None
