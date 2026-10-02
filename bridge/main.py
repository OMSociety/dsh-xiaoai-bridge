import argparse
import os
import signal
import sys
import time

# Fix: Add onnxruntime library path for sherpa_onnx on Windows
# A machine-wide onnxruntime.dll (for example the one in C:\Windows\System32)
# would otherwise be loaded instead of the one from the onnxruntime wheel.
if sys.platform == "win32":
    from core.utils.ort_dll import ensure_onnxruntime_dll_path

    ensure_onnxruntime_dll_path()

# Fix: Add onnxruntime library path for sherpa_onnx on macOS/Linux
# This ensures sherpa_onnx can find libonnxruntime at runtime
if sys.platform in ("darwin", "linux"):
    try:
        import onnxruntime as ort
        ort_lib_dir = os.path.join(os.path.dirname(ort.__file__), "capi")
        if os.path.exists(ort_lib_dir):
            if sys.platform == "darwin":
                os.environ.setdefault("DYLD_LIBRARY_PATH", "")
                if ort_lib_dir not in os.environ["DYLD_LIBRARY_PATH"]:
                    os.environ["DYLD_LIBRARY_PATH"] = ort_lib_dir + ":" + os.environ["DYLD_LIBRARY_PATH"]
            else:  # linux
                os.environ.setdefault("LD_LIBRARY_PATH", "")
                if ort_lib_dir not in os.environ["LD_LIBRARY_PATH"]:
                    os.environ["LD_LIBRARY_PATH"] = ort_lib_dir + ":" + os.environ["LD_LIBRARY_PATH"]
    except ImportError:
        pass

from core.utils.config_loader import ensure_config_module_loaded

config_path = ensure_config_module_loaded()

from core.app import MainApp
from core.utils.logger import logger


main_app_instance = None

# 启动配置（从环境变量读取）
enable_api_server = False  # 是否开启 API Server


def setup_config():
    """解析命令行参数和环境变量"""
    global enable_api_server, enable_openai, enable_dsh

    parser = argparse.ArgumentParser(description="小爱音箱接入 Open XiaoAI")
    parser.parse_args()

    # 从环境变量读取配置
    enable_api_server = os.environ.get("API_SERVER_ENABLE", "").lower() in ("1", "true", "yes")
    enable_openai = os.environ.get("OPENAI_ENABLE", "").lower() in (
        "1",
        "true",
        "yes",
    )
    enable_dsh = os.environ.get("DSH_ENABLE", "").lower() in (
        "1",
        "true",
        "yes",
    )

    # 计算 AUDIO_INPUT_ENABLE 实际生效的值（默认 1/true）
    audio_input_enabled = os.environ.get("AUDIO_INPUT_ENABLE", "1").strip().lower() in ("1", "true", "yes", "on")
    
    logger.info(f"[Main] ENV: API_SERVER_ENABLE={os.environ.get('API_SERVER_ENABLE') or 'not set (disabled)'}, "
                f"OPENAI_ENABLE={os.environ.get('OPENAI_ENABLE') or 'not set (disabled)'}, "
                f"DSH_ENABLE={os.environ.get('DSH_ENABLE') or 'not set (disabled)'}, "
                f"AUDIO_INPUT_ENABLE={1 if audio_input_enabled else 0}")
    logger.info(f"[Main] Using config file: {config_path}")

    # 打印模块启用情况
    logger.info("[Main] 模块启用情况:")
    logger.info("小爱指令拦截器启用", module="Main")
    logger.info(
        f"OpenAI: {'启用' if enable_openai else '禁用'}",
        module="Main",
    )
    logger.info(
        f"DSH: {'启用' if enable_dsh else '禁用'}",
        module="Main",
    )
    logger.info(
        f"API Server: {'启用' if enable_api_server else '禁用'}",
        module="Main",
    )


def ensure_wakeup_keywords():
    """按 config.py 的 wakeup.keywords 重新生成 KWS 关键词文件。

    上游只在 scripts/start.sh 与 Dockerfile 的 CMD 里调用
    core/services/audio/kws/keywords.py，直接以 python main.py 启动时不会
    生成，config.py 里改唤醒词就不生效（仍读上一次甚至上游自带的
    core/models/keywords.txt）。这里把生成步骤收进进程自身，使 config.py
    成为唤醒词的唯一真相源。
    """
    if not (enable_openai or enable_dsh):
        return
    try:
        from core.services.audio.kws.keywords import main as generate_keywords

        generate_keywords()
    except Exception as exc:
        logger.error(
            f"[Main] 唤醒词文件生成失败: {type(exc).__name__}: {exc}",
            module="Main",
        )


def run_services():
    """统一的服务启动入口"""
    global main_app_instance, enable_api_server, enable_openai, enable_dsh

    ensure_wakeup_keywords()

    # 统一使用 MainApp 管理所有服务
    main_app_instance = MainApp.instance(
        enable_openai=enable_openai,
        enable_dsh=enable_dsh,
    )
    main_app_instance.run(enable_api_server=enable_api_server)

    # 主线程保持运行
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass


def main():
    run_services()
    return 0


def setup_graceful_shutdown():
    def signal_handler(_sig, _frame):
        global main_app_instance

        # 关闭 MainApp（包含 API Server）
        if main_app_instance:
            main_app_instance.shutdown()

        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)


if __name__ == "__main__":
    setup_config()
    setup_graceful_shutdown()
    sys.exit(main())
