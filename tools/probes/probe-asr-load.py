"""Time how long each local ASR backend takes to load, and one decode.

Run with the bridge virtualenv:
    bridge\\.venv\\Scripts\\python.exe tools\\probes\\probe-asr-load.py start <backend>   (run from the repo root)
    ... probe-asr-load.py decode <backend> <seconds>

Each subcommand is a separate process so `.cpu_seconds` is honest about the
load, and so the OS page cache state is the same as a bridge restart.
"""

import os
import sys
import time

MODELS = os.environ.get(
    "XIAOAI_MODELS",
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "bridge", "core", "models"),
)
SPECS = {
    "sense_voice": {
        "dir": "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
        "factory": "from_sense_voice",
        "kwargs": {"model": "model.int8.onnx"},
        "extra": {"language": "auto", "use_itn": True},
    },
    "paraformer": {
        "dir": "sherpa-onnx-paraformer-trilingual-zh-cantonese-en",
        "factory": "from_paraformer",
        "kwargs": {"paraformer": "model.int8.onnx"},
        "extra": {},
    },
}


def register_ort_dll_dir():
    """Same trick as bridge/core/utils/ort_dll.py.

    `sherpa_onnx` loads `onnxruntime.dll` by bare name; without this the DLL
    search order picks up the machine-wide 1.17.1 copy in C:\\Windows\\System32
    and dies with an access violation while building the recognizer.
    """
    import importlib.util

    spec = importlib.util.find_spec("onnxruntime")
    capi = os.path.join(os.path.dirname(spec.origin), "capi")
    if os.path.isfile(os.path.join(capi, "onnxruntime.dll")):
        os.add_dll_directory(capi)


def build(backend):
    register_ort_dll_dir()
    import sherpa_onnx

    spec = SPECS[backend]
    root = os.path.join(MODELS, spec["dir"])
    model_kwargs = {k: os.path.join(root, v) for k, v in spec["kwargs"].items()}
    factory = getattr(sherpa_onnx.OfflineRecognizer, spec["factory"])
    started = time.time()
    recognizer = factory(
        **model_kwargs,
        tokens=os.path.join(root, "tokens.txt"),
        num_threads=2,
        debug=False,
        provider="cpu",
        **spec["extra"],
    )
    return recognizer, time.time() - started


def main():
    what, backend = sys.argv[1], sys.argv[2]
    if what == "start":
        _, seconds = build(backend)
        print(f"{backend}: load {seconds:.2f}s", flush=True)
        # Tearing the recognizer down segfaults in this venv (ORT API drift), so
        # the measurement ends here instead of at interpreter exit.
        os._exit(0)
    seconds = float(sys.argv[3])
    import numpy as np

    recognizer, load = build(backend)
    sample_rate = 16000
    # A tone, not silence: it exercises the decode path rather than an early exit.
    t = np.arange(int(sample_rate * seconds), dtype=np.float32) / sample_rate
    samples = (0.05 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    stream = recognizer.create_stream()
    stream.accept_waveform(sample_rate, samples)
    first = time.time()
    recognizer.decode_stream(stream)
    decode = time.time() - first
    print(f"{backend}: load {load:.2f}s, decode {seconds:.0f}s -> {decode:.2f}s, text={stream.result.text!r}")


if __name__ == "__main__":
    main()
