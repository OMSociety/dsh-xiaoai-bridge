import asyncio
import socket
import subprocess
import sys
import time
import uuid

import requests


# 每次唤醒生成独立 Session，对话互不干扰
# 适合以下场景：
#   - "提问 → 回答"式交互，不需要 Agent 记住上下文
#   - 长期使用同一 Session 导致 Agent 上下文窗口堆积过长，影响响应质量和速度
# def new_session_key():
#     return f"agent:main:session-{uuid.uuid4().hex[:8]}"


async def before_wakeup(speaker, text, source, app):
    """
    处理收到的用户消息，并决定是否唤醒 AI。

    参数：
        speaker : SpeakerManager，可调用 play/abort_xiaoai/wake_up 等方法
        text    : 识别到的文字内容
        source  : 唤醒来源
                    'kws'    — 本地关键词唤醒（用户说了唤醒词）
                    'xiaoai' — 小爱同学收到用户语音指令
        app     : MainApp 实例，可调用 send_to_dsh / send_to_openai 等方法

    返回值：
        "dsh"      — 进入 DSH 连续对话流程
        "openai"   — 进入 OpenAI 兼容服务连续对话流程（例如 Hermes Agent API Server）
        None       — 不做额外处理（可在此自行调用 app.send_to_dsh 等）

    ---
    动态切换 session_key：
        每次进入此函数前，框架会自动将 session_key 重置为配置文件中的默认值。
        如需路由到其他 Agent，在 return "dsh" 之前调用：
            app.set_dsh_session_key("agent:main:xxx")
        不调用则自动使用 dsh.session_key 的默认值，无需手动重置。
    """
    if source == "kws":
        # --- 示例一：按唤醒词路由到不同 Agent ---
        # AGENT_SESSIONS = {
        #     "小美": "agent:xiaomei:dsh-xiaoai-bridge",    # 说"你好小美" → 路由到 xiaomei Agent
        #     "管家": "agent:butler:dsh-xiaoai-bridge",     # 说"你好管家" → 路由到 butler Agent
        # }
        # for keyword, session_key in AGENT_SESSIONS.items():
        #     if keyword in text:
        #         app.set_dsh_session_key(session_key)
        #         await speaker.play(text=f"{keyword}来了")
        #         return "dsh"

        # --- 示例二：每次唤醒生成独立 Session ---
        # if "小爱小爱" in text:
        #     app.set_dsh_session_key(new_session_key())
        #     await speaker.play(text="来了")
        #     return "dsh"

        # --- 示例三：进入 DSH 前播放服务端本地开场白 ---
        # if "小爱小爱" in text:
        #     await speaker.play(server_file="/path/to/dsh_intro.wav")
        #     return "dsh"

        if "小黑" in text:
            await speaker.play(text="小黑来了")
            return "openai"

        # dsh 唤醒词由下方 APP_CONFIG 的 dsh.wakeup_keywords 配置
        dsh_config = APP_CONFIG.get("dsh", {})
        for keyword in dsh_config.get("wakeup_keywords", []):
            if keyword and keyword in text:
                await speaker.play(text=dsh_config.get("wakeup_reply") or "小爱来了")
                return "dsh"

        return None

    if source == "xiaoai":
        # --- 示例四：小爱指令按用户名路由到不同 Session ---
        # if text == "召唤小美":
        #     app.set_dsh_session_key("agent:xiaomei:dsh-xiaoai-bridge")
        #     await speaker.abort_xiaoai()
        #     return "dsh"

        if text == "召唤小黑":
            await speaker.abort_xiaoai()
            return "openai"  # OpenAI-compatible service continuous conversation

        if "让小黑" in text:
            await speaker.abort_xiaoai()
            await app.send_to_openai_and_play_reply(text.replace("让小黑", ""))
            return None

        # dsh 唤醒词由下方 APP_CONFIG 的 dsh.wakeup_keywords 配置
        for keyword in APP_CONFIG.get("dsh", {}).get("wakeup_keywords", []):
            if keyword and text == keyword:
                await speaker.abort_xiaoai()
                return "dsh"

    return None


async def after_wakeup(speaker, source=None, session_key=None):
    """
    退出唤醒状态

    - source: 退出来源
        - 'dsh': DSH 连续对话退出
        - 'openai': OpenAI 兼容服务连续对话退出
    - session_key: 当前 DSH/OpenAI 后端 session_key
        可据此区分是哪个 Agent 退出，例如播放不同的退出提示语
    """
    if source == "openai":
        await speaker.play(text="小黑，再见")
    if source == "dsh":
        # 示例：按 agentId 区分退出提示语
        # 所有后端的 session_key 已统一为 agent:<agentId>:<rest> 格式，第二段即 agentId。
        # 仍建议做越界防护，以兼容自定义的非标准 session_key。
        # parts = session_key.split(":") if session_key else []
        # agent_id = parts[1] if len(parts) > 1 else None
        # if agent_id == "assistant":
        #     await speaker.play(text="助手，再见")
        # else:
        #     await speaker.play(text="小爱，再见")
        await speaker.play(
            text=APP_CONFIG.get("dsh", {}).get("exit_reply") or "小爱，再见"
        )


APP_CONFIG = {
    "wakeup": {
        # 自定义唤醒词列表（英文字母要全小写）
        "keywords": [
            "你好小黑",
            "小黑你好",
            "小爱小爱",
        ],
        # 静音多久后自动退出唤醒（秒）
        "timeout": 20,
        # 语音识别结果回调
        "before_wakeup": before_wakeup,
        # 退出唤醒时的提示语（设置为空可关闭）
        "after_wakeup": after_wakeup,
    },
    "kws": {
        # 唤醒词置信度加成（越高越难误触发，越低越灵敏）
        "keywords_score": 2.0,
        # 唤醒词检测阈值（越低越灵敏，越高越难触发）
        "keywords_threshold": 0.2,
        # 唤醒词检测时的最小静默时长（ms），静默超过该时长则判定为说完
        "min_silence_duration": 480,
    },
    "vad": {
        # 语音检测阈值（0-1，越小越灵敏）
        "threshold": 0.10,
        # 最小语音时长（ms）
        "min_speech_duration": 250,
        # 最小静默时长（ms）
        "min_silence_duration": 500,
    },
    "audio_input": {
        # Input gain multiplier before VAD/KWS/ASR. Use 1.0 to disable.
        "gain": 1.0,
    },
    "asr": {
        # 支持 "sense_voice"（默认）、"paraformer"、"fire_red_asr" 或 "doubao"
        "model": "sense_voice",
        # 是否优先使用 INT8 量化模型（仅本地模型生效）
        "int8": True,
        # 可选：显式指定 core/models/ 下的模型目录名（仅本地模型生效）
        # "model_dir": "",
        "doubao": {
            # "standard": 录音文件识别标准版，调用 /submit + /query
            # "flash": 录音文件极速版，调用 /recognize/flash
            "mode": "standard",
            "app_key": "你的 App Key",
            "access_key": "你的 Access Key",
            # 火山 X-Api-Resource-Id：
            # standard 可选：
            #   "volc.bigasr.auc"  - 豆包录音文件识别模型 1.0
            #   "volc.seedasr.auc" - 豆包录音文件识别模型 2.0
            # flash 可选：
            #   "volc.bigasr.auc_turbo" - 录音文件极速版
            "resource_id": "volc.seedasr.auc",
            "language": "",
            "submit_timeout": 10,
            "query_timeout": 10,
            "poll_interval": 0.5,
            "max_wait_seconds": 20,
        },
    },
    "xiaoai": {
        "continuous_conversation_mode": True,
        "exit_command_keywords": ["停止", "退下", "退出", "下去吧"],
        "max_listening_retries": 2,  # 最多连续重新唤醒次数
        "exit_prompt": "再见，主人",
        "continuous_conversation_keywords": ["开启连续对话", "启动连续对话", "我想跟你聊天"]
    },
    # TTS (Text-to-Speech) Configuration
    "tts": {
        "doubao": {
            # 豆包语音合成 API 配置
            # 文档地址: https://www.volcengine.com/docs/6561/1598757?lang=zh
            # 产品地址: https://www.volcengine.com/docs/6561/1871062
            "app_id": "xxxx",         # 你的 App ID
            "access_key": "xxxxxx",       # 你的 Access Key
            "default_speaker": "zh_female_vv_uranus_bigtts",  # 音色 https://www.volcengine.com/docs/6561/1257544?lang=zh
            "audio_format": "pcm",  # 推荐默认值：局域网稳定环境下首音更快、播放更顺
            "stream": True,  # 推荐默认值：边合成边播放，首音延迟更低
        }
    },
    # DSH (DeepSeek Harness) Bridge Configuration
    # 由 DSH 桌面端的 dsh-xiaoai-bridge 插件托管，端点始终是本机回环地址。
    # 语音回复由 DSH 侧主动调用 API Server 播放，桥接器不会自行播放回复。
    "dsh": {
        "base_url": "http://127.0.0.1:19387/plugin/xiaoai",  # DSH 插件 HTTP 端点
        "token": "",  # API Token；运行时优先使用环境变量 XIAOAI_API_TOKEN
        # session_key 格式：agent:<agentId>:<rest>
        "session_key": "agent:main:dsh-xiaoai-bridge",
        "device_name": "",  # 可选：上报给 DSH 的设备名
        "response_timeout": 120,
        "tts_provider": None,  # None = 交给 tts.router 选择默认 provider
        "tts_speaker": "xiaoai",  # "xiaoai" = 小爱原生 TTS；填豆包音色 ID 则用豆包 TTS
        "session_tts_speakers": {},  # 按 session_key 覆盖音色
        "tts_speed": 1.0,  # TTS 语速 (0.5-2.0)，仅豆包 TTS 生效
        # 输入模式：
        #   - "local_asr": 使用本地 VAD + SherpaASR
        #   - "xiaoai_asr": 接管小爱原生 ASR 结果
        "input_mode": "local_asr",
        "exit_keywords": ["退出", "停止", "再见"],  # 退出连续对话的关键词
        # 一次唤醒之后听多久：
        #   - False（默认）：只听一句，说完就退出，下句要重新唤醒
        #   - True：一直听着，直到静默超时或说出退出词
        "continuous_conversation": False,
        "rule_prompt": "注意：将结果处理成纯文字版，不要返回任何 markdown 格式，也不要包含任何代码块，并将字数控制在300字以内",
        "rule_prompt_for_skill": "注意：这条消息是主人通过小爱音箱发来的语音。你的回复正文会被自动念出来（念之前会先做一次口语化润色），所以直接把要说的话写成回复正文就好：不要包含 markdown、代码、emoji、颜文字、括号里的动作或心理描写、URL，尽量 300 字以内。只有当你要逐字念出、不要润色的内容时，才调用 xiaoai_speak 工具",  # 追加在每条语音输入后面；插件设置页可覆盖
        "wakeup_keywords": ["小爱小爱"],  # 命中即路由到 DSH 连续对话
        "wakeup_reply": "小爱来了",  # 唤醒成功后的播报语；留空用默认值
        "exit_reply": "小爱，再见",  # 退出连续对话时的播报语；留空用默认值
        "fallback_text": "连不上电脑，请稍后再试",  # 桥接器在跑、但 DSH 插件联系不上时的播报语；留空用默认值
    },
    # OpenAI-compatible Service Configuration
    # 可接入 Hermes Agent API Server、OpenAI、Ollama、LM Studio 等兼容 /v1/chat/completions 的服务
    "openai": {
        "base_url": "http://127.0.0.1:8000/v1",
        "api_key": "",
        "model": "gpt-4o-mini",
        # 输入模式：
        #   - "local_asr": 使用本地 VAD + SherpaASR
        #   - "xiaoai_asr": 接管小爱原生 ASR 结果
        "input_mode": "local_asr",
        # session_key 统一采用 agent:<agentId>:<rest> 格式，便于 after_wakeup 解析
        "session_key": "agent:default:dsh-xiaoai-bridge",
        # 可选：把 session_key 作为请求头发给服务端，用于服务端长期记忆作用域。
        # 默认设为 Hermes 的 "X-Hermes-Session-Key"；它只用于长期记忆作用域，
        # chat/completions 仍是无状态（历史仍由 messages 携带），不会重复。
        # 接标准 OpenAI/Ollama/LM Studio 时该头会被忽略（无害），如需彻底关闭可留空。
        "session_header": "X-Hermes-Session-Key",
        "system_prompt": "",
        "temperature": 0.7,
        "max_tokens": 512,
        "history_max_messages": 20,
        "response_timeout": 120,
        "tts_speed": 1.0,
        "tts_speaker": "xiaoai",
        "session_tts_speakers": {},
        "exit_keywords": ["退出", "停止", "再见"],
        "rule_prompt": "注意：将结果处理成纯文字版，不要返回任何 markdown 格式，也不要包含任何代码块，并将字数控制在300字以内",
        "rule_prompt_for_skill": "注意：这条消息是主人通过小爱音箱发送的，他看不到你回复的文字。字数控制在300字以内",
        "extra_body": {},
    },
}
