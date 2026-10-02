import json
import os
import re
import socket
import threading
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from core.utils.config_loader import (
    ensure_config_module_loaded,
    get_config_path,
    load_config_module,
)

MAC_PATTERN = re.compile(r"^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$")


class ConfigManager:
    """配置管理器 - 单例模式"""

    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        """确保单例模式"""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        """初始化配置管理器"""
        if hasattr(self, "_initialized"):
            return
        self._initialized = True
        self._state_lock = threading.RLock()
        self._reload_listeners: list[Callable[[dict[str, Any], dict[str, Any]], None]] = []
        self._config_path = get_config_path()
        self._config_module_name = "config"

        ensure_config_module_loaded()
        self._app_config = self._load_app_config()

        # 运行时配置槽位。DEVICE_ID / NETWORK 为历史遗留键名，
        # 保留是为了兼容 get_device_id() / get_network_config() 等既有访问器。
        self._config = {
            "CLIENT_ID": None,
            "DEVICE_ID": None,
            "NETWORK": {},
        }

        self._initialize_client_id()
        self._initialize_device_id()

    def _load_app_config(self) -> dict[str, Any]:
        """加载 config.py 中的 APP_CONFIG。"""
        module = ensure_config_module_loaded()
        app_config = getattr(module, "APP_CONFIG", None)
        if not isinstance(app_config, dict):
            raise ValueError("config.APP_CONFIG must be a dict")
        return app_config

    def get_config_path(self) -> Path:
        """返回配置文件路径。"""
        return self._config_path

    def get_app_config(self, path: str | None = None, default: Any = None) -> Any:
        """获取运行时 APP_CONFIG。"""
        with self._state_lock:
            if not path:
                return self._app_config

            value: Any = self._app_config
            for key in path.split("."):
                if not isinstance(value, dict):
                    return default
                value = value.get(key, default)
                if value is default:
                    return default
            return value

    def add_reload_listener(
        self, callback: Callable[[dict[str, Any], dict[str, Any]], None]
    ) -> None:
        """注册配置重载监听器。"""
        with self._state_lock:
            if callback not in self._reload_listeners:
                self._reload_listeners.append(callback)

    def reload_app_config(self) -> bool:
        """重新加载 config.py，并同步运行时配置。"""
        with self._state_lock:
            module = load_config_module(force_reload=True)
            next_config = getattr(module, "APP_CONFIG", None)
            if not isinstance(next_config, dict):
                raise ValueError("config.APP_CONFIG must be a dict")

            previous_config = self._app_config
            self._app_config = next_config

            self._initialize_device_id()

            listeners = list(self._reload_listeners)

        for listener in listeners:
            try:
                listener(previous_config, next_config)
            except Exception:
                continue

        return True

    def get_client_id(self) -> str:
        """获取客户端ID"""
        with self._state_lock:
            return self._config["CLIENT_ID"]

    def get_device_id(self) -> Optional[str]:
        """获取设备ID"""
        with self._state_lock:
            return self._config.get("DEVICE_ID")

    def get_network_config(self) -> dict:
        """获取网络配置"""
        with self._state_lock:
            return self._config["NETWORK"]

    def get_config(self, path: str, default: Any = None) -> Any:
        """
        通过路径获取配置值
        """
        with self._state_lock:
            try:
                value = self._config
                for key in path.split("."):
                    value = value[key]
                return value
            except (KeyError, TypeError):
                return default

    def update_config(self, path: str, value: Any) -> bool:
        """
        更新特定配置项
        """
        with self._state_lock:
            try:
                current = self._config
                *parts, last = path.split(".")
                for part in parts:
                    current = current.setdefault(part, {})
                current[last] = value
                return True
            except Exception:
                return False

    def device_file_path(self) -> Path:
        """DEVICE_ID 的持久化文件位置。

        历史上设备 ID 是被回写进 `config.py` 的，但 `config.py` 现在由
        DSH 插件渲染生成：回写会同时改写生成文件与模板文件的 mtime，
        前者触发 `_watch_config_file` 反复重载，后者让插件误判源码已更新。
        所以改为写在配置文件同目录的 `device.json` 里。
        """
        return get_config_path().parent / "device.json"

    def read_persisted_device_id(self) -> Optional[str]:
        """读取持久化的设备 ID，失败返回 None。"""
        try:
            data = json.loads(self.device_file_path().read_text(encoding="utf-8"))
        except Exception:
            return None
        value = data.get("device_id") if isinstance(data, dict) else None
        return value if isinstance(value, str) and value else None

    def persist_device_id(self, value: str) -> None:
        """原子写入设备 ID（临时文件 + rename）。"""
        path = self.device_file_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(f"{path.name}.tmp")
            tmp.write_text(
                json.dumps({"device_id": value}, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            os.replace(tmp, path)
        except Exception:
            pass

    @classmethod
    def instance(cls):
        """获取配置管理器实例（线程安全）"""
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
        return cls._instance

    def get_mac_address(self):
        mac = uuid.UUID(int=uuid.getnode()).hex[-12:]
        return ":".join([mac[i : i + 2] for i in range(0, 12, 2)])

    def generate_uuid(self) -> str:
        return str(uuid.uuid4())

    def get_local_ip(self):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            return ip
        except Exception:
            return "127.0.0.1"

    def _initialize_client_id(self):
        """确保存在客户端ID"""
        if not self._config["CLIENT_ID"]:
            client_id = self.generate_uuid()
            self.update_config("CLIENT_ID", client_id)

    def _initialize_device_id(self):
        """确保存在设备ID"""
        # 先从 device.json 恢复（config.py 是插件渲染的生成物，不再被回写）
        if not self._config["DEVICE_ID"]:
            persisted = self.read_persisted_device_id()
            if persisted:
                self._config["DEVICE_ID"] = persisted

        if self._config["DEVICE_ID"]:
            # 检查设备 ID 是否符合 MAC 地址格式(如 a6:85:b4:9c:09:66)
            if not MAC_PATTERN.match(self._config["DEVICE_ID"]):
                self._config["DEVICE_ID"] = None

        if not self._config["DEVICE_ID"]:
            try:
                device_hash = self.get_mac_address()
                self.update_config("DEVICE_ID", device_hash)
                self.persist_device_id(device_hash)
            except Exception:
                pass
