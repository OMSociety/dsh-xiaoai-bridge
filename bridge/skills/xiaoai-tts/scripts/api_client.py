#!/usr/bin/env python3
"""
OpenXiaoAI API 配置和基础工具

自本 fork 起，API Server 在非 loopback 调用方上要求
`Authorization: Bearer <token>`（loopback 一律放行）。token 的取法与桥接器一致：
环境变量 `XIAOAI_API_TOKEN` 优先，其次配置文件里的 `dsh.token`。
"""

import os
import json
import importlib.util
import urllib.request
import urllib.error
from pathlib import Path


def get_api_config():
    """获取 API 配置"""
    base_url = os.environ.get("OPENXIAOAI_BASE_URL", "http://192.168.3.6:9092")
    # 移除末尾的斜杠
    return base_url.rstrip("/")


def _config_candidates():
    """按优先级列出可能的 config.py 路径。"""
    configured = os.environ.get("CONFIG_PATH", "").strip()
    if configured:
        yield Path(configured).expanduser()
    home = os.environ.get("DSH_HOME", "").strip() or os.path.join(os.path.expanduser("~"), ".dsh")
    yield Path(home) / "xiaoai-bridge" / "config.py"
    # .../bridge/skills/xiaoai-tts/scripts/api_client.py -> .../bridge/config.py
    yield Path(__file__).resolve().parents[3] / "config.py"


def _token_from_config():
    """从渲染后的 config.py 里读 dsh.token。"""
    for path in _config_candidates():
        try:
            if not path.is_file():
                continue
            spec = importlib.util.spec_from_file_location("xiaoai_tts_config", path)
            if spec is None or spec.loader is None:
                continue
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            token = ((getattr(module, "APP_CONFIG", None) or {}).get("dsh") or {}).get("token")
            token = str(token or "").strip()
            if token:
                return token
        except Exception:
            continue
    return ""


def get_api_token():
    """获取 API bearer token（可能为空：loopback 调用不需要）。"""
    token = os.environ.get("XIAOAI_API_TOKEN", "").strip()
    if token:
        return token
    return _token_from_config()


UNAUTHORIZED_HINT = (
    "HTTP 401：该地址不是 loopback，需要 bearer token。"
    "请设置环境变量 XIAOAI_API_TOKEN，或从 DSH 的 xiaoai 插件设置页/凭据里取出 token。"
)


def api_request(path, method="GET", data=None, headers=None):
    """发送 API 请求"""
    base_url = get_api_config()
    full_url = f"{base_url}{path}"
    
    default_headers = {
        "Content-Type": "application/json"
    }
    token = get_api_token()
    if token:
        default_headers["Authorization"] = f"Bearer {token}"
    if headers:
        default_headers.update(headers)
    
    req = urllib.request.Request(
        full_url,
        headers=default_headers,
        method=method
    )
    
    if data:
        req.data = json.dumps(data).encode("utf-8")
    
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_msg = f"HTTP 错误: {e.code} - {e.reason}"
        try:
            error_body = json.loads(e.read().decode("utf-8"))
            error_msg += f"\n详情: {error_body}"
        except:
            pass
        if e.code == 401:
            error_msg += f"\n{UNAUTHORIZED_HINT}"
        raise Exception(error_msg)
    except Exception as e:
        raise Exception(f"请求失败: {e}")


def check_health():
    """检查服务健康状态"""
    return api_request("/api/health")


def get_status():
    """获取音箱状态"""
    return api_request("/api/status")


def wakeup(silent=True):
    """唤醒小爱"""
    return api_request("/api/wakeup", method="POST", data={"silent": silent})


def interrupt():
    """打断当前播放"""
    return api_request("/api/interrupt", method="POST")
