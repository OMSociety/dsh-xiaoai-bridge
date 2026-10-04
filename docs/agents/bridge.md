# 桥接器（bridge/）运行与配置参考

根 [AGENTS.md](../../AGENTS.md) 的外移章节。桥接器侧的**规则**（改动前后要做什么、禁止什么）在根文件的「修改契约」「禁止操作」「验收标准」与 [change-contract.md](./change-contract.md) 里；这里只放运行与配置参考：依赖方向与边界、模型文件、环境变量、API Server 端点、TTS provider、独立运行与 Docker。

## 依赖方向与边界

```text
native/src（PyO3 模块 dsh_xiaoai_server）
    ↑ 只有 Python 调 Rust，Rust 不反向导入 Python 模块
core/utils  ←  core/services  ←  core/*.py（会话后端）  ←  main.py
```

- `main.py`：进程入口。按环境变量决定开哪些后端：`API_SERVER_ENABLE`、`OPENAI_ENABLE`、`DSH_ENABLE`、`AUDIO_INPUT_ENABLE`。
- `core/app.py`：装配与生命周期；读 `API_SERVER_HOST`、`API_SERVER_PORT`（默认 `127.0.0.1:9092`）、`AUDIO_INPUT_ENABLE`。
- `core/services/audio/`：`stream.py`，`asr/{service,sherpa,doubao}`，`kws/{keywords,sherpa}`，`vad/silero`。
- `core/services/tts/`：`router.py` 是唯一入口（`TTSRouter`，`SUPPORTED_PROVIDERS = frozenset(("xiaoai", "doubao", "openai", "mlx_audio"))`），provider 实现在同目录 `doubao` / `openai` / `mlx_audio`。
- `core/services/speaker.py`：设备命令面（`mphelper`、`miplayer -f`、`/usr/sbin/tts_play.sh`、打断）。
- `core/services/api_server.py` + `api_auth.py`：HTTP 端点与统一 bearer 门禁。
- `core/utils/`：`config.py`（`ConfigManager`）、`config_loader.py`（`CONFIG_PATH`）、`logger.py`（只读 `LOGLEVEL`）、`playback_gate.py`（半双工闸门 `PlaybackGate`），以及 `base` / `background` / `file` / `ort_dll`。
- `core/*.py` 会话后端：`dsh.py`（DSH 后端）、`dsh_conversation.py`、`openai.py` / `openai_conversation.py`、`xiaoai.py` / `xiaoai_conversation.py`（小爱原生）、`external_conversation.py`（长连接外部网关）、`wakeup_session.py`（唤醒会话与打断）、`ref.py`（全局单例）。
- `native/src/`：`lib.rs`（PyO3 导出）、`server.rs`（TCP `4399`）、`opus.rs`、`python.rs`、`macros.rs`、`tts/`。
- `core/assets/sounds/`：提示音；`core/models/`：本地模型，不入库（安装见下）。

要守住的边界：

- Rust 导出面就是 Python 侧的契约。`lib.rs` 注册 `start_server` / `start_recording` / `stop_recording` / `start_playing` / `stop_playing` / `run_shell` / `on_output_data`；`native/src/tts/mod.rs` 另注册 `tts_play` / `tts_play_background` / `tts_stream_play` / `tts_stream_play_background` / `tts_stream_collect` / `begin_playback_session` / `stop_tts_playback` / `decode_audio` / `play_audio_file`；`native/src/python.rs` 的 `init_module` 还注册 `register_fn` / `unregister_fn`，`native/src/opus.rs` 注册 `OpusEncoder` / `OpusDecoder` 两个类（`lib.rs` 依次调 opus / python / tts 三个 `init_module`）。改名或改签名要同时改全部调用点，Python 侧没有任何类型检查兜底。
- 环境变量分两侧读：Python 侧是 `main.py` / `core/app.py` / `core/utils/*`；Rust 侧 `native/src/server.rs` 读 `AUDIO_INPUT_ENABLE`、`SILENT_START_ENABLE`、`DSH_XIAOAI_TOKEN`（`4399` 的客户端鉴权：设置项 `speakerAuth` 默认开时由 `lib/process.js` 写入同一枚访问令牌，留空即不鉴权；服务端同时接受 `Authorization: Bearer <token>` 与拨号 URL 里的 `?token=<token>`，后者是给不带任何请求头的官方客户端的唯一入口）。API Server 的开关与监听地址只由环境变量决定，`config.py` 里没有 `api_server` 段。
- 设备绑定来自 `core/dsh.py` 读的 `XIAOAI_DEVICE_NAME` / `XIAOAI_DEVICE_HOST`（插件侧由 `lib/process.js` 按设置项写入）：它们随每次 `/asr` 提交，改设备绑定要确认这两条没有被绕过。
- 会话后端之间不互相调用；要出声一律走 `core/services/tts/router.py` 的 `TTSRouter`，不要在某个后端里直接实例化 provider。
- 设备命令集中在 `core/services/speaker.py`，**新代码不要另拼 shell**。既存例外只有 `core/xiaoai.py` 里那一份打断命令串与 `run_shell` 直调（历史遗留，改打断路径时两处都要看），它不是可以照抄的范例。Rust 导出的播放类函数（`on_output_data` / `play_audio_file` / `start_playing` / `tts_play*`）是**不带闸门的底层出口**，现有调用点分布在 `speaker.py`、`core/xiaoai.py`、`core/wakeup_session.py`、`core/services/api_server.py` 与 TTS router；新代码要出声就走 `speaker.play(...)` 或 `TTSRouter`，新增直调就必须自己承担闸门责任。
- 任何播报路径都必须过 `core/utils/playback_gate.py` 的单例 `PlaybackGate`，不要自己另写一份计时。闸门由 `speaker.play()` 内部按 buffer 时长 `hold_for(...)` 关、放完自动放；`core/external_conversation.py` 里 `play(buffer=…)` 之后那个 `asyncio.sleep(len(_NOTIFY_PCM)/(24000*2))` 只是等这一句放完，**不是**闸门的替代品。

## 模型文件与资源

| 项 | 位置 / 来源 |
|---|---|
| 模型根目录 | `bridge/core/models/`（`bridge/core/utils/file.py` 的 `get_model_file_path()` 返回 `../models/<name>`） |
| 必装（VAD + KWS） | `silero_vad.onnx`、`keywords.txt`、`tokens.txt`、`bpe.model`、`encoder.onnx`、`decoder.onnx`、`joiner.onnx`，全部平铺在 `bridge/core/models/` 根下 |
| ASR 模型目录 | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/`（默认）、`sherpa-onnx-paraformer-trilingual-zh-cantonese-en/`；目录名必须含 `asr.model` 对应的 dir_keyword |
| 提示音 | `bridge/core/assets/sounds/` |
| 下载源 | 上游 release `https://github.com/coderzc/open-xiaoai-bridge/releases/tag/vad-kws-asr-models`（本 fork 的 release 页没有这份资产） |
| 与 git 的关系 | 全部未入库：`.gitignore` 的 `**/models` 覆盖（`git check-ignore -v bridge/core/models/silero_vad.onnx` 可验），`git ls-files bridge/core/models` 为 0 条 |
| 后端与模型 | `dsh.input_mode` / `openai.input_mode` = `local_asr` 用 VAD + KWS + ASR；`xiaoai_asr` 只用 VAD + KWS |

## 环境变量

| 变量 | 谁读它 | 用途 / 默认值 |
|---|---|---|
| `LOGLEVEL` | `bridge/core/utils/logger.py` | 日志级别，默认 `INFO`；`LOG_LEVEL` 是死键，别加 |
| `DSH_ENABLE` | `bridge/main.py`、`bridge/core/dsh.py` | 开 DSH 后端；未设或非 truthy 即关 |
| `OPENAI_ENABLE` | `bridge/main.py`、`bridge/core/openai.py` | 开 OpenAI 兼容后端，默认关；插件托管的子进程里永不设置（`lib/process.js` 显式删除） |
| `API_SERVER_ENABLE` | `bridge/main.py`、`bridge/core/app.py` | 开 API Server，默认关 |
| `AUDIO_INPUT_ENABLE` | `bridge/main.py`（默认 `"1"`）、`bridge/core/app.py`、`bridge/native/src/server.rs` | 音频输入；关掉后 KWS 与 `local_asr` 不可用 |
| `SILENT_START_ENABLE` | `bridge/native/src/server.rs` | Rust 侧静默启动，只有 `true` / `1` / `yes` / `on` 算开；插件由 `silentStart` 设置项路由 |
| `API_SERVER_HOST` | `bridge/core/app.py` | 默认 `127.0.0.1`；设成 `0.0.0.0` 等于把播放与唤醒交给整个局域网 |
| `API_SERVER_PORT` | `bridge/core/app.py` | 默认 `9092` |
| `XIAOAI_API_TOKEN` | `bridge/core/services/api_auth.py`、`bridge/core/dsh.py` | 两处都读：HTTP bearer 门禁 + DSH 后端令牌；为空时非回环对端一律拒绝 |
| `XIAOAI_DEVICE_NAME` / `XIAOAI_DEVICE_HOST` | `bridge/core/dsh.py` | 覆盖 `dsh.device_name` / `device_host`，由插件 `lib/process.js` 的 `bridgeChildEnv()` 按设置项写入，随每次 `/asr` 提交 |
| `DOUBAO_ACCESS_KEY` | `bridge/core/services/tts/router.py` | 豆包 TTS Access Key，优先于渲染配置的 `tts.doubao.access_key`；进程启动时读一次 |
| `CONFIG_PATH` | `bridge/core/utils/config_loader.py` | 自定义配置文件路径；插件下指向 `<dataDir>/config.py` |

插件侧唯一的设置项到环境变量映射是 `lib/process.js` 的 `bridgeChildEnv(cfg, configPath)`（写 `LOGLEVEL`、`DSH_ENABLE`、`AUDIO_INPUT_ENABLE`、`SILENT_START_ENABLE`、`API_SERVER_ENABLE`、`API_SERVER_HOST`、`API_SERVER_PORT`、`XIAOAI_DEVICE_NAME`、`XIAOAI_DEVICE_HOST`、`CONFIG_PATH`），随后从 DSH 凭据库注入 `XIAOAI_API_TOKEN` 与 `DOUBAO_ACCESS_KEY`（取不到就删掉同名变量）。

## API Server 端点

`API_SERVER_ENABLE=1` 时监听（默认 `127.0.0.1:9092`）。鉴权由 `bridge/core/services/api_auth.py` 的 `bearer_auth` 中间件统一加（`XIAOAI_API_TOKEN` 优先、`dsh.token` 兜底，每请求读一次）：回环对端免令牌，非回环必须带 bearer。

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/play/text` | 文字转语音播放；播放全程串行，队列满回 503 |
| POST | `/api/play/url` | 播放音频链接；上游遗留端点，本插件无调用点 |
| POST | `/api/play/file` | 上传并播放音频文件 |
| POST | `/api/tts/doubao` | 豆包 TTS 合成并播放（可覆盖 app_id / access_key / speaker_id / speed / emotion） |
| GET | `/api/tts/doubao_voices` | 可用音色列表，`version` = `1.0` / `2.0` / `all` |
| POST | `/api/wakeup` | 唤醒音箱，body `{"silent": false}` 可选 |
| POST | `/api/interrupt` | 打断当前播放并结束对话 |
| GET | `/api/status` | 播放状态：`playing` / `paused` / `idle` |
| GET | `/api/health` | 健康检查，含 `data.auth` 与 `data.asr` 实况 |

请求体字段、错误码与音色表见 `bridge/docs/openxiaoai-voice-api.md`（那份文档没有鉴权一节，鉴权口径以 `api_auth.py` 为准）。`bridge/config.py` 里没有 `api_server` 段，监听地址只来自环境变量。

## TTS provider

- `bridge/core/services/tts/router.py` 的 `SUPPORTED_PROVIDERS = frozenset(("xiaoai", "doubao", "openai", "mlx_audio"))`；未知名字只 warn 一条 `Unknown tts_provider=` 再按 `tts_speaker` 回退（`xiaoai` 到 xiaoai，否则 doubao），不报错。
- 设置页只渲染 `xiaoai` / `doubao`（`lib/render-config.js` 的 `RENDERED_TTS_PROVIDERS`、`lib/config.js` 的 `TTS_PROVIDER_VALUES`），`buildOverrides()` 总会写 `dsh.tts_provider`；`openai` / `mlx_audio` 只能手改渲染配置，`bridge/config.py` 里也没有 `tts.openai` / `tts.mlx_audio` 段。
- 豆包凭据：`_play_doubao` 先读环境变量 `DOUBAO_ACCESS_KEY`，取不到才用 `tts.doubao.access_key`；`app_id` / `access_key` 缺一即 `raise ValueError("Doubao TTS credentials are not configured")`，不会静默换 provider。
- `bridge/config.py` 的 `tts.doubao` 默认值：`default_speaker` = `zh_female_vv_uranus_bigtts`、`audio_format` = `pcm`、`stream` = `True`（`stream=True` 走 Rust 的 `tts_stream_play`，否则 `tts_play`）。
- OpenAI 兼容 / MLX-Audio 走 `_play_openai_compatible`：整段下载后经 `speaker.play_server_file()` 播出，**不支持 SSE 流式**；`response_format` 只接受 mp3 / flac / wav / ogg / pcm（`PLAYBACK_SUPPORTED_FORMATS`），其余抛 `is not supported by the Bridge playback decoder`；`tts_speaker` 非 `xiaoai` 时当 voice 覆盖。出错统一回退 xiaoai TTS。

## 独立运行与 Docker

- 正式部署走本地源码：在 `bridge/` 里 `uv sync`，再 `uv run main.py`（前置 `uv` 与 Rust 工具链，Linux 另需 `pkg-config` / `patchelf`）；`bridge/scripts/start.sh` 是本地辅助脚本（例：`API_SERVER_ENABLE=1 DSH_ENABLE=1 ./scripts/start.sh`）。只开 API Server：在 `bridge/` 里 `$env:API_SERVER_ENABLE='1'; .\.venv\Scripts\python.exe main.py`。
- 要真设备、真凭据时才跑的手动脚本：在 `bridge/` 里 `.\.venv\Scripts\python.exe tests/test_tts.py`。
- `bridge/docker-compose.yml` 头部自带 fork 警告：它拉的是上游镜像 `ghcr.io/coderzc/open-xiaoai-bridge:latest`，**不含本 fork 的 bearer 鉴权门禁与 DSH 后端接线**，照它部署会得到一个没有 bearer 门禁的桥接器，不要把 compose 当正式部署路径。
- Compose 事实（仅参考）：端口 `4399:4399` 与 `9092:9092`，`API_SERVER_HOST=0.0.0.0`，卷 `./config.py:/app/config.py` 与 `./models:/app/core/models`，`DSH_ENABLE=1`，网络需 `network_mode: host` 或把 `dsh.base_url` 指向宿主机局域网 IP。
