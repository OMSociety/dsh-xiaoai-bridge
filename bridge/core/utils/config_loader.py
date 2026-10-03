import importlib.util
import os
import sys
from pathlib import Path


CONFIG_ENV_VAR = "CONFIG_PATH"


def get_config_path() -> Path:
    """Resolve config.py path from environment or project root."""
    configured_path = os.environ.get(CONFIG_ENV_VAR)
    if configured_path:
        return Path(configured_path).expanduser().resolve()
    return Path(__file__).resolve().parents[2] / "config.py"


def ensure_config_module_loaded() -> Path:
    """Load the config module from CONFIG_PATH when provided."""
    return load_config_module(force_reload=False)


def load_config_module(force_reload: bool = False):
    """Load the config module from the resolved config path."""
    config_path = get_config_path()

    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    existing_module = sys.modules.get("config")
    if not force_reload and existing_module is not None:
        existing_file = getattr(existing_module, "__file__", None)
        if existing_file and Path(existing_file).resolve() == config_path:
            return existing_module

    spec = importlib.util.spec_from_file_location("config", config_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Failed to load config module from: {config_path}")

    module = importlib.util.module_from_spec(spec)
    # 只有 exec 成功后才把模块对象登记进 sys.modules：exec 中途抛异常时它是个
    # 半成品（属性可能只定义了一半），先塞进去会让别处 `import config` 拿到它。
    # 失败时保留原来的模块 —— 热重载失败要继续用旧配置。
    previous_module = sys.modules.get("config")
    try:
        spec.loader.exec_module(module)
    except Exception:
        if previous_module is not None:
            sys.modules["config"] = previous_module
        else:
            sys.modules.pop("config", None)
        raise
    sys.modules["config"] = module
    return module
