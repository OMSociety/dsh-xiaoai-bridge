"""Sherpa-ONNX offline ASR with configurable model backend.

Provides local speech-to-text recognition for the external conversation flow.
The model is lazily loaded on first use to avoid blocking startup.

Supported backends (set via APP_CONFIG["asr"]["model"]):
  - "sense_voice" (default): SenseVoice multilingual model
  - "paraformer": Paraformer Chinese model
  - "fire_red_asr": FireRedASR AED model

设置页改 `asr.model` / `asr.int8` / `asr.model_dir` 后**不用重启桥接器**：
桥接器每秒轮询配置文件，`ConfigManager` 重载完会回调 `_on_config_reload()`，
按需在后台重建 recognizer —— 和 `core/services/audio/kws` 对唤醒词做的是
同一件事。旧实现里 `_ensure_loaded()` 开头就是
`if self._recognizer is not None: return`，于是"切了后端没反应、要重启进程
才生效"，而且界面不会提示。

选了一个没装模型的后端也别把音箱弄哑（防呆，三层）：
  1. 名字不认识 → 退回当前在用的后端（首次启动退回 DEFAULT_BACKEND），只警告一次；
  2. 名字认识但装不上 → 继续用已经装好的那个 recognizer，警告一次，
     并把原因记进 `_last_error`（`/api/health` 会报给插件侧提示用户）。
     失败签名带冷却（`_FAILED_RETRY_COOLDOWN_SECONDS`）而不是终身拒绝：
     冷却过后允许再试，模型文件事后补齐时更是立刻放行——所以"先切到
     没装模型的后端、之后把模型装上、继续说话"能自动恢复，不必重启进程
     或来回切换后端；
  3. 真的一个都装不上，才抛异常（这时的正确状态是让上层知道 ASR 不可用）。
"""

import os
import threading
import time

import numpy as np

from core.utils.ort_dll import ensure_onnxruntime_dll_path

ensure_onnxruntime_dll_path()

import sherpa_onnx

from core.utils.config import ConfigManager
from core.utils.file import get_model_file_path
from core.utils.logger import logger

# 配置缺失或写错时的落点：它随包自带模型，是唯一"总还有得用"的后端。
DEFAULT_BACKEND = "sense_voice"

_BACKENDS = {
    # `language` 钉死中文：多语种自动检测会把一两秒的短音频判成日文（实机日志里
    # 出现过 `はみ。` / `八に。` / `あ嘛？`），而本项目只服务中文用户，暴露一个
    # `asr.language` 只会换来「选错了没反应」。`use_itn` 保留（数字、标点做逆
    # 文本规整）。
    "sense_voice": {
        "dir_keyword": "sense-voice",
        "factory": "from_sense_voice",
        "extra_kwargs": {"language": "zh", "use_itn": True},
        "model_files": {"model": {True: "model.int8.onnx", False: "model.onnx"}},
    },
    "paraformer": {
        "dir_keyword": "paraformer",
        "factory": "from_paraformer",
        "extra_kwargs": {},
        "model_files": {"paraformer": {True: "model.int8.onnx", False: "model.onnx"}},
    },
    "fire_red_asr": {
        "dir_keyword": "fire-red-asr",
        "factory": "from_fire_red_asr",
        "extra_kwargs": {},
        "model_files": {
            "encoder": {True: "encoder.int8.onnx", False: "encoder.onnx"},
            "decoder": {True: "decoder.int8.onnx", False: "decoder.onnx"},
        },
    },
}

# 装载失败后的冷却时间（秒）：失败记下 `(载荷签名, 失败时刻)`，冷却期内认了，
# 冷却过后放行再试一次。旧实现把失败签名记成"终身拒绝"（`_failed_key` 只在
# 成功装载时清空），于是"先切到没装模型的后端 → 事后把模型装上 → 继续说话"
# 这条最自然的恢复路径永远是死的：装上的模型再也不会被装载，`/api/health`
# 还会一直报那条过期的 error。冷却窗口既给了自动恢复的机会，又保留了原来的
# 防呆目的——不让每一句话都等一次注定失败的装载（一次失败 1~3 秒）。
_FAILED_RETRY_COOLDOWN_SECONDS = 60.0


class _SherpaASR:
    """Wrapper around sherpa_onnx.OfflineRecognizer with configurable backend."""

    def __init__(self):
        self._recognizer = None
        # 生效的载荷签名 (backend, use_int8, model_dir)：只有它变了才重建。
        self._loaded_key: tuple | None = None
        # 已经报过"装不上"的请求签名，以及那次失败的时刻：冷却期内不再重试
        # （见 `_failed_retry_allowed()`），免得每一句话都等一次失败的加载。
        self._failed_key: tuple | None = None
        self._failed_at: float = 0.0
        # 失败当刻"模型文件是否已经齐全"：False 说明是缺文件（模型没装），
        # 之后文件一补上就立刻放行重试，不必干等冷却；True 说明文件在但装载
        # 仍失败（多半是依赖问题），这种失败只能等冷却。
        self._failed_files_ready: bool = False
        # 建一个 recognizer 要 1~3 秒（本机实测），预热线程、重载线程和用户
        # 说的第一句话可能同时进来，没有锁会建出两个（内存和时间都翻倍）。
        self._load_lock = threading.Lock()
        self._warned: set = set()
        self._listening = False
        self._last_error: str | None = None

    # ---- 配置 --------------------------------------------------------

    def _request(self) -> tuple[str, str | None, str]:
        """返回 (配置里的原文, 认识的后端或 None, asr.model_dir 原文)。"""
        cfg = ConfigManager.instance()
        raw = str(cfg.get_app_config("asr.model", DEFAULT_BACKEND)).strip().lower()
        model_dir = str(cfg.get_app_config("asr.model_dir") or "")
        return raw, (raw if raw in _BACKENDS else None), model_dir

    def _load_key(self, backend: str, model_dir: str) -> tuple:
        """载荷签名：这三样任一变了，原来那个 recognizer 就不能再用。"""
        return (backend, self._use_int8(), model_dir)

    def _use_int8(self) -> bool:
        return bool(ConfigManager.instance().get_app_config("asr.int8", True))

    def _get_required_model_files(self, backend: str) -> dict[str, str]:
        spec = _BACKENDS[backend]
        use_int8 = self._use_int8()
        return {
            arg_name: filenames[use_int8]
            for arg_name, filenames in spec["model_files"].items()
        }

    # ---- 模型目录 ----------------------------------------------------

    def _dir_has_required_files(self, path: str, required_files: dict[str, str]) -> bool:
        return all(
            os.path.isfile(os.path.join(path, filename))
            for filename in required_files.values()
        )

    def _scan_model_dir(
        self, models_root: str, keyword: str, required_files: dict[str, str]
    ) -> str | None:
        """扫 core/models/ 找第一个文件名带 keyword 且文件齐的目录。"""
        try:
            entries = list(os.scandir(models_root))
        except OSError:
            return None
        for entry in entries:
            if entry.is_dir() and keyword in entry.name:
                if self._dir_has_required_files(entry.path, required_files):
                    return entry.path
        return None

    def _find_model_dir(
        self, keyword: str, required_files: dict[str, str], model_dir_name: str
    ) -> str:
        """定位模型目录：配置里点名了就用它，否则扫 core/models/。"""
        models_root = get_model_file_path("")

        # If model_dir is explicitly configured, use it directly
        if model_dir_name:
            explicit_path = os.path.join(models_root, model_dir_name)
            if self._dir_has_required_files(explicit_path, required_files):
                return explicit_path
            missing = [
                filename
                for filename in required_files.values()
                if not os.path.isfile(os.path.join(explicit_path, filename))
            ]
            raise FileNotFoundError(
                f"Configured model_dir '{model_dir_name}' not found or missing "
                f"required files {missing} in {models_root}."
            )

        found = self._scan_model_dir(models_root, keyword, required_files)
        if found:
            return found

        raise FileNotFoundError(
            f"No '{keyword}' model found in {models_root}. "
            f"Please place the matching model directory under core/models/ with files: "
            f"{', '.join(required_files.values())}."
        )

    def _model_files_ready(self, backend: str, model_dir_name: str) -> bool:
        """按 `_build()` 的口径查文件：这个后端现在装得上吗（只查文件，不建模型）。

        与 `available_backends()` 的区别是它跟着 `asr.model_dir` 的显式点名走：
        配置点名了一个错目录时，不该因为"别处碰巧有个同名模型目录"就判定成
        文件已补齐，否则会退化成每一句话都重试一次注定失败的装载。
        """
        spec = _BACKENDS.get(backend)
        if spec is None:
            return False
        try:
            required_files = self._get_required_model_files(backend)
            model_dir = self._find_model_dir(
                spec["dir_keyword"], required_files, model_dir_name
            )
        except Exception:
            return False
        return os.path.isfile(os.path.join(model_dir, "tokens.txt"))

    def available_backends(self) -> list[str]:
        """本机装了模型的后端（给 `/api/health` 与设置页提示用，只查文件不建模型）。"""
        models_root = get_model_file_path("")
        available = []
        for backend, spec in _BACKENDS.items():
            try:
                required_files = self._get_required_model_files(backend)
            except Exception:
                continue
            if self._scan_model_dir(models_root, spec["dir_keyword"], required_files):
                available.append(backend)
        return available

    # ---- 装载 --------------------------------------------------------

    def _build(self, backend: str, model_dir_name: str):
        """按后端建一个 recognizer；装不上就抛，错误信息说明缺什么。"""
        spec = _BACKENDS[backend]
        required_files = self._get_required_model_files(backend)

        model_dir = self._find_model_dir(
            spec["dir_keyword"], required_files, model_dir_name
        )
        model_kwargs = {
            arg_name: os.path.join(model_dir, filename)
            for arg_name, filename in required_files.items()
        }
        tokens_path = os.path.join(model_dir, "tokens.txt")

        if not os.path.isfile(tokens_path):
            raise FileNotFoundError(
                f"Missing tokens.txt in model dir: {model_dir}"
            )

        # Build homophone replacer kwargs if files exist
        hr_kwargs = {}
        models_root = get_model_file_path("")
        hr_dict = os.path.join(models_root, "dict")
        hr_fst = os.path.join(models_root, "replace.fst")
        hr_lexicon = os.path.join(models_root, "lexicon.txt")
        if os.path.isdir(hr_dict) and os.path.isfile(hr_fst):
            hr_kwargs["hr_dict_dir"] = hr_dict
            hr_kwargs["hr_rule_fsts"] = hr_fst
            if os.path.isfile(hr_lexicon):
                hr_kwargs["hr_lexicon"] = hr_lexicon

        factory = getattr(sherpa_onnx.OfflineRecognizer, spec["factory"])
        recognizer = factory(
            **model_kwargs,
            tokens=tokens_path,
            num_threads=2,
            debug=False,
            provider="cpu",
            **spec["extra_kwargs"],
            **hr_kwargs,
        )
        logger.asr_event(
            "语音识别服务启动",
            f"模型={backend}, 路径={model_dir}, int8={self._use_int8()}",
        )
        return recognizer

    def _failed_retry_allowed(self, backend: str, model_dir: str) -> bool:
        """刚失败过的载荷现在能不能再试一次（只在"确实失败过"这一支调用）。

        两条放行条件，任一满足即放行：
          1. 冷却（`_FAILED_RETRY_COOLDOWN_SECONDS`）已过——给"依赖层面"的
             失败（模型文件没变，比如 onnxruntime 装好了）留一条自动恢复的路；
          2. 上次失败时文件还没齐、现在齐了——"把模型装上 → 继续说话"这条
             最自然的恢复路径应当当场生效，不必让用户干等冷却。
        两条都不满足时保持原防呆：不让每一句话都等一次注定失败的装载。
        """
        if time.monotonic() - self._failed_at >= _FAILED_RETRY_COOLDOWN_SECONDS:
            return True
        if self._failed_files_ready:
            # 文件上次就在，这次失败跟"模型没装"无关，只能等冷却。
            return False
        return self._model_files_ready(backend, model_dir)

    def _ensure_loaded(self):
        """装载（或热换）配置要的那个后端。

        调用点有三处：启动时的预热线程、配置重载监听器、每句 `asr()`。
        所以它必须是幂等的：只有载荷签名变了才重建，否则只是一次比较。
        """
        self._attach_reload_listener()

        requested, backend, model_dir = self._request()
        if backend is None:
            # (防呆 1) 名字不认识：退回正在用的那个（首次启动退回默认），只警告一次。
            backend = self._loaded_key[0] if self._loaded_key else DEFAULT_BACKEND
            self._warn_once(
                f"unknown:{requested}",
                f"未知的语音识别模型 '{requested}'（可选：{', '.join(_BACKENDS)}），"
                f"继续使用 {backend}",
            )
        key = self._load_key(backend, model_dir)

        if self._recognizer is not None and self._loaded_key == key:
            return

        with self._load_lock:
            if self._recognizer is not None and self._loaded_key == key:
                return
            retrying = self._failed_key == key
            if retrying and not self._failed_retry_allowed(backend, model_dir):
                # 这个配置刚报过装不上：冷却期内别再让每一句话都等一次失败的
                # 加载。冷却过后（或模型文件补上后）会走到下面重试。
                return
            previous = self._loaded_key
            try:
                recognizer = self._build(backend, model_dir)
            except Exception as exc:
                self._failed_key = key
                self._failed_at = time.monotonic()
                # 记下失败当刻文件齐不齐：缺文件的那种失败，文件补上就立刻重试。
                self._failed_files_ready = self._model_files_ready(backend, model_dir)
                self._handle_build_failure(backend, previous, exc)
                return
            self._recognizer = recognizer
            self._loaded_key = key
            self._failed_key = None
            self._failed_at = 0.0
            self._failed_files_ready = False
            self._last_error = None
            if retrying:
                # 这次成功是"失败过又重试"来的：单独记一条，排错时可以按它
                # 对照 `/api/health` 的 `asr.error`（此时已经清空）。
                detail = (
                    f"{previous[0]} → {backend}（上次装载失败，重试成功）"
                    if previous is not None and previous[0] != backend
                    else f"{backend} 重试装载成功"
                )
                logger.asr_event("语音识别服务恢复", detail)
            elif previous is not None and previous[0] != backend:
                logger.asr_event("语音识别服务热重载", f"{previous[0]} → {backend}")

    def _handle_build_failure(self, backend: str, previous, exc: Exception):
        """(防呆 2) 装不上时说清楚，并尽量留住还能用的那个 recognizer。

        恢复路径（`_last_error` 与 `/api/health` 的 `asr.error` 会一直报这条
        原因，直到下面任一条把它清掉；旧实现里它们直到进程重启都不会清）：
          - 把模型文件补上：文件名/目录对得上之后，**继续说话**或下一次配置
            重载就会立刻重试（`/api/health` 轮询本身不会触发装载）；
          - 文件没变（缺的是依赖）时等冷却：`_FAILED_RETRY_COOLDOWN_SECONDS`
            过后允许再试一次；
          - 或者切到一个能装上的后端再切回来：那次成功装载会清空失败记录，
            切回来就立即重试。重存同一个值没有用（签名没变，仍受冷却约束）。
        """
        self._last_error = str(exc)
        if self._recognizer is not None:
            logger.warning(
                f"[ASR] 切到 {backend} 失败（{exc}），继续使用 {previous[0]}",
                module="ASR",
            )
            return
        if backend != DEFAULT_BACKEND:
            # 一个都还没装好时，宁愿退回自带模型的默认后端，也别让音箱哑掉。
            try:
                self._recognizer = self._build(DEFAULT_BACKEND, "")
            except Exception as fallback_exc:
                logger.error(
                    f"[ASR] {backend} 与默认 {DEFAULT_BACKEND} 都装不上："
                    f"{exc} / {fallback_exc}",
                    module="ASR",
                )
                raise exc
            self._loaded_key = (DEFAULT_BACKEND, self._use_int8(), "")
            logger.warning(
                f"[ASR] 模型 {backend} 装不上（{exc}），已改用默认 {DEFAULT_BACKEND}",
                module="ASR",
            )
            return
        logger.error(f"[ASR] 语音识别模型装不上：{exc}", module="ASR")
        raise exc

    # ---- 热重载 ------------------------------------------------------

    def _attach_reload_listener(self):
        """第一次装载时挂上配置重载监听器（和 VAD/KWS 一样）。

        放在这里而不是 `__init__`，是为了 import 本模块时不碰配置文件。
        """
        if self._listening:
            return
        ConfigManager.instance().add_reload_listener(self._on_config_reload)
        self._listening = True

    def _on_config_reload(self, *_args):
        """配置重载后把新后端装上去；不在这里真的加载。

        监听器跑在每秒轮询配置文件的 watcher 线程上，而加载要 1~3 秒：丢给
        后台线程，否则配置轮询会被卡住。装不上的原因由 `_ensure_loaded()`
        记成警告和 `_last_error`，于是用户切到一个没装模型的后端时，日志与
        健康检查里立刻就写明白了，而不是等他说完一句话才发现没反应。
        """
        _requested, backend, model_dir = self._request()
        if backend is None:
            return
        key = self._load_key(backend, model_dir)
        if self._loaded_key == key:
            return
        if self._failed_key == key and not self._failed_retry_allowed(
            backend, model_dir
        ):
            # 冷却内（且文件没补齐）不重复起线程；冷却过后或模型补上后放行，
            # 让"把模型装上"不必等到用户开口说话才生效。
            return
        threading.Thread(target=self._reload, name="asr-reload", daemon=True).start()

    def _reload(self):
        try:
            self._ensure_loaded()
        except Exception as exc:  # 线程里的异常没人接，兜在这里
            logger.error(f"[ASR] 热重载语音识别模型失败: {exc}", module="ASR")

    def _warn_once(self, key: str, message: str):
        if key in self._warned:
            return
        self._warned.add(key)
        logger.warning(f"[ASR] {message}", module="ASR")

    def status(self) -> dict:
        """给 `/api/health` 与设置页看的实况：要什么、在跑什么、哪些装得上。

        `error` 是**最近一次**装载失败的原因，不再是"一次失败就报一辈子"：
        下一次重试成功（冷却到期后的第一句话、或模型文件补上后的第一句话 /
        第一次配置重载）就会把它清空；`active` 同理可能在设置没变的情况下
        被自动恢复改写。这里只查文件、不建模型，也不会触发装载。
        """
        requested, backend, _model_dir = self._request()
        return {
            "requested": requested,
            "known": backend is not None,
            "active": self._loaded_key[0] if self._loaded_key else None,
            "available": self.available_backends(),
            "error": self._last_error,
        }

    # ---- 识别 --------------------------------------------------------

    def asr(self, pcm_bytes: bytes, sample_rate: int = 16000) -> str:
        """Recognize speech from raw PCM int16 audio bytes.

        Args:
            pcm_bytes: Raw PCM audio data (int16, mono).
            sample_rate: Sample rate of the audio (default 16000).

        Returns:
            Recognized text string, or empty string if nothing recognized.
        """
        self._ensure_loaded()

        # 先绑成局部变量：热重载随时可能在下一行换掉 self._recognizer，
        # create_stream 与 decode_stream 落到两个 recognizer 上会崩。
        recognizer = self._recognizer

        samples = np.frombuffer(pcm_bytes, dtype=np.int16)
        samples = samples.astype(np.float32) / 32768.0

        stream = recognizer.create_stream()
        stream.accept_waveform(sample_rate, samples)
        recognizer.decode_stream(stream)

        text = stream.result.text.strip()

        # Apply custom text replacements from config
        if text:
            cfg = ConfigManager.instance()
            replacements = cfg.get_app_config("asr.replacements", {})
            for old, new in replacements.items():
                text = text.replace(old, new)
            logger.debug(f"[ASR] Recognized: {text}", module="ASR")
        else:
            logger.debug("[ASR] No speech recognized", module="ASR")
        return text


SherpaASR = _SherpaASR()
