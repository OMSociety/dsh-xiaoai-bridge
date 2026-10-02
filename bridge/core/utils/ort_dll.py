"""Make sure the pip-installed ONNX Runtime wins over a machine-wide copy.

``sherpa_onnx`` loads ``onnxruntime.dll`` by bare name.  On Windows the DLL
search order may resolve that name to a machine-wide build that is much older
than the one shipped by the ``onnxruntime`` wheel.  The symptom is a warning
like::

    The requested API version [23] is not available, only API versions
    [1, 17] are supported in this build. Current ORT Version is: 1.17.1

followed by a hard crash while the VAD / KWS / ASR models are created.
Registering the wheel's ``capi`` directory as a DLL search directory before
``sherpa_onnx`` is imported puts the correct build first.

Call :func:`ensure_onnxruntime_dll_path` before every ``import sherpa_onnx``.
It is a no-op on non-Windows platforms and never raises.
"""

from __future__ import annotations

import os
import sys

# Keep the handles alive: closing them removes the directory from the search
# path again.
_DLL_DIRECTORY_HANDLES = []
_RESOLVED_CAPI_DIR = None
_ATTEMPTED = False


def _find_capi_dir():
    """Locate ``<site-packages>/onnxruntime/capi`` without importing onnxruntime."""
    import importlib.util

    try:
        spec = importlib.util.find_spec("onnxruntime")
    except (ImportError, ValueError):
        return None
    if spec is None or not getattr(spec, "origin", None):
        return None
    capi_dir = os.path.join(os.path.dirname(spec.origin), "capi")
    if not os.path.isfile(os.path.join(capi_dir, "onnxruntime.dll")):
        return None
    return capi_dir


def ensure_onnxruntime_dll_path():
    """Put the wheel's onnxruntime DLL directory first on Windows.

    Returns the registered directory, or ``None`` when there is nothing to do.
    """
    global _ATTEMPTED, _RESOLVED_CAPI_DIR

    if os.name != "nt":
        return None
    if _ATTEMPTED:
        return _RESOLVED_CAPI_DIR
    _ATTEMPTED = True

    capi_dir = _find_capi_dir()
    if not capi_dir:
        return None
    try:
        handle = os.add_dll_directory(capi_dir)
    except (AttributeError, OSError):
        return None
    _DLL_DIRECTORY_HANDLES.append(handle)
    _RESOLVED_CAPI_DIR = capi_dir
    return capi_dir
