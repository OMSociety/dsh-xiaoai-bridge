# AGENTS.md — 桥接器（bridge/）

适用范围：`bridge/` 全目录。与更靠近改动点的子目录文件冲突时以子目录为准；与仓库根 `AGENTS.md` 冲突时以本文件为准（根文件管仓库级纪律：版本号、提交、依赖与出版面；本文件管桥接器本身）。

桥接器是可以独立运行的进程，由 DSH 插件以子进程方式托管：它把音箱接进 DSH，也能脱离插件单独跑。

## 项目概览

小爱音箱的实时语音网关。Rust 扩展在 TCP `4399` 上接收设备音频，Python 侧做 VAD、唤醒词与 ASR，把一句话交给会话后端（DSH / OpenAI 兼容 / 小爱原生），再把回复经 TTS 播回音箱；播放期间半双工闸门关掉麦克风通路。

- 运行时：Python `>=3.12`；依赖与 Rust 扩展编译都走 `uv` + `maturin`（PyO3）
- 本地推理：`sherpa-onnx` + `onnxruntime`，配 `numpy` / `scipy` / `soundfile`
- HTTP：`aiohttp`（API Server）；设备侧命令面：`mphelper` / `miplayer` / `tts_play.sh`

文档索引：

- `bridge/README.md`：Docker Compose 与本地编译、环境变量表、API Server 端点、TTS provider 用法。其中一部分是搬运来的旧内容（快速开始的 clone 地址、`session_key` 示例），示例与代码冲突时以代码为准
- `bridge/docs/`：豆包克隆音色、豆包 TTS、小爱语音 API 的接口参考
- `bridge/CHANGELOG.md`：本桥接器进入本仓库之前的变更历史，最新条目 `v1.0.7`；本仓库对 `bridge/` 的改动记在根 `CHANGELOG.md`
- 根 `docs/deploy.md`：插件侧的实现决策与踩坑（§12.x）
- 根 `README.md` / `CONTRIBUTING.md`：整体用法与开发纪律

## 常用命令

除注明外都在 `bridge/` 下执行。

| 目的 | 命令 |
|---|---|
| 装依赖 / 重编译 Rust 扩展 | `uv sync`（改过 `native/**/*.rs` 或 `native/Cargo.toml` 必须重跑；先停桥接器） |
| 跑全部测试 | `.\.venv\Scripts\python.exe -m pytest -q` |
| 跑单个测试文件 | `.\.venv\Scripts\python.exe -m pytest -q tests/test_tts_router.py` |
| 要真设备、真凭据时才跑的手动脚本 | `.\.venv\Scripts\python.exe tests/test_tts.py` |
| 单独起桥接器 | `.\.venv\Scripts\python.exe main.py` |
| 只开 API Server | `$env:API_SERVER_ENABLE='1'; .\.venv\Scripts\python.exe main.py` |
| 确认 Rust 扩展能导入 | `.\.venv\Scripts\python.exe -c "import dsh_xiaoai_server"` |

`uv` 不在 PATH 时用绝对路径。没先 `uv sync` 就导入会报 `No module named 'dsh_xiaoai_server'`。`uv sync` 会把 pytest 一起清掉（它不在运行依赖里），所以每次 sync 之后、跑测试之前先 `uv pip install --python .venv\Scripts\python.exe pytest`。

## 架构边界

依赖方向（下层不认识上层）：

```
native/src（PyO3 模块 dsh_xiaoai_server）
    ↑ 只有 Python 调 Rust，Rust 不反向导入 Python 模块
core/utils  ←  core/services  ←  core/*.py（会话后端）  ←  main.py
```

- `main.py`：进程入口。按环境变量决定开哪些后端：`API_SERVER_ENABLE`、`OPENAI_ENABLE`、`DSH_ENABLE`、`AUDIO_INPUT_ENABLE`
- `core/app.py`：装配与生命周期；读 `API_SERVER_HOST`、`API_SERVER_PORT`（默认 `127.0.0.1:9092`）、`AUDIO_INPUT_ENABLE`
- `core/services/audio/`：`stream.py`，`asr/{service,sherpa,doubao}`，`kws/{keywords,sherpa}`，`vad/silero`
- `core/services/tts/`：`router.py` 是唯一入口（`TTSRouter`，`SUPPORTED_PROVIDERS = frozenset(("xiaoai", "doubao", "openai", "mlx_audio"))`），provider 实现在同目录 `doubao` / `openai` / `mlx_audio`
- `core/services/speaker.py`：设备命令面（`mphelper`、`miplayer -f`、`/usr/sbin/tts_play.sh`、打断）
- `core/services/api_server.py` + `api_auth.py`：HTTP 端点与统一 bearer 门禁
- `core/utils/`：`config.py`（`ConfigManager`）、`config_loader.py`（`CONFIG_PATH`）、`logger.py`（只读 `LOGLEVEL`）、`playback_gate.py`（半双工闸门 `PlaybackGate`），以及 `base` / `background` / `file` / `ort_dll`
- `core/*.py` 会话后端：`dsh.py`（DSH 后端）、`dsh_conversation.py`、`openai.py` / `openai_conversation.py`、`xiaoai.py` / `xiaoai_conversation.py`（小爱原生）、`external_conversation.py`（长连接外部网关）、`wakeup_session.py`（唤醒会话与打断）、`ref.py`（全局单例）
- `native/src/`：`lib.rs`（PyO3 导出）、`server.rs`（TCP `4399`）、`opus.rs`、`python.rs`、`macros.rs`、`tts/`
- `core/assets/sounds/`：提示音；`core/models/`：本地模型，不入库（安装见 `bridge/README.md` 的模型文件一节）

要守住的边界：

- Rust 导出面就是 Python 侧的契约。`lib.rs` 注册 `start_server` / `start_recording` / `stop_recording` / `start_playing` / `stop_playing` / `run_shell` / `on_output_data`；`native/src/tts/mod.rs` 另注册 `tts_play` / `tts_play_background` / `tts_stream_play` / `tts_stream_play_background` / `tts_stream_collect` / `begin_playback_session` / `stop_tts_playback` / `decode_audio` / `play_audio_file`。改名或改签名要同时改全部调用点，Python 侧没有任何类型检查兜底
- 环境变量分两侧读：Python 侧是 `main.py` / `core/app.py` / `core/utils/*`；Rust 侧 `native/src/server.rs` 读 `AUDIO_INPUT_ENABLE`、`SILENT_START_ENABLE`、`DSH_XIAOAI_TOKEN`（`4399` 的客户端鉴权，留空即不鉴权）。API Server 的开关与监听地址只由环境变量决定，`config.py` 里没有 `api_server` 段。另有 `core/dsh.py` 读 `XIAOAI_DEVICE_NAME` / `XIAOAI_DEVICE_HOST`（插件侧由 `lib/process.js` 按设置项写入）：它们是设备绑定随每次 `/asr` 提交的来源，改设备绑定要确认这两条没有被绕过
- 会话后端之间不互相调用；要出声一律走 `core/services/tts/router.py` 的 `TTSRouter`，不要在某个后端里直接实例化 provider
- 设备命令集中在 `core/services/speaker.py`，**新代码不要另拼 shell**。既存例外只有 `core/xiaoai.py` 里那一份打断命令串与 `run_shell` 直调（历史遗留，改打断路径时两处都要看），它不是可以照抄的范例。Rust 导出的播放类函数（`on_output_data` / `play_audio_file` / `start_playing` / `tts_play*`）是**不带闸门的底层出口**，现有调用点分布在 `speaker.py`、`core/xiaoai.py`、`core/wakeup_session.py`、`core/services/api_server.py` 与 TTS router；新代码要出声就走 `speaker.play(...)` 或 `TTSRouter`，新增直调就必须自己承担闸门责任（这条与下一条是同一件事：直接调那些导出等于绕过闸门）
- 任何播报路径都必须过 `core/utils/playback_gate.py` 的单例 `PlaybackGate`，不要自己另写一份计时。闸门由 `speaker.play()` 内部按 buffer 时长 `hold_for(...)` 关、放完自动放；`core/external_conversation.py` 里 `play(buffer=…)` 之后那个 `asyncio.sleep(len(_NOTIFY_PCM)/(24000*2))` 只是等这一句放完，**不是**闸门的替代品

## 修改契约

- 改配置项：改 `bridge/config.py` 的默认值与注释。插件渲染的 `<dataDir>/config.py` 以它为模板，所以还要确认插件侧 `lib/render-config.js` 的 `buildOverrides()` 会写这个键，否则设置页改了不生效。跑 `pytest -q tests/test_config_loader.py`
- 加 TTS provider：名字必须进 `core/services/tts/router.py` 的 `SUPPORTED_PROVIDERS`，否则会被当未知 provider **回退**（`logger.warning` 记一条 `Unknown tts_provider=`，再按 `tts_speaker` 选 xiaoai / doubao），**不报错**——所以「没报错」不等于「接上了」。跑 `pytest -q tests/test_tts_router.py`。还要动插件侧两张表：`lib/render-config.js` 的 `RENDERED_TTS_PROVIDERS`（不加就永远不把 `tts_provider` 写进渲染配置，设置页选中等于没选）与 `lib/config.js` 的 `TTS_PROVIDER_VALUES`（设置页能选什么，允许先于桥接器存在，那就是「预留」）
- 改 API Server：端点在 `core/services/api_server.py` 的 setup 里注册，鉴权由 `api_auth.py` 的 middleware 统一加，不要在 handler 里另判令牌。新增端点同步更新 `bridge/README.md` 的端点表，跑 `pytest -q tests/test_api_server_auth.py tests/test_api_server_playback_queue.py`
- 改 Rust 扩展：先停桥接器 → `uv sync` → 跑测试。`native/src/**/*.rs` 改过必须重编译，`pyproject.toml` 的 `tool.uv.cache-keys` 已声明触发路径
- 改音频链路（VAD / KWS / ASR）：代码在 `core/services/audio/`，模型放 `core/models/`（不入库）。牢记前提「设备说话时麦克风仍在往本进程送音频」。**配置热生效是契约**：`vad` / `kws` / `asr` 都靠 `ConfigManager.add_reload_listener` 在每秒的配置轮询里生效，别再引入「启动时读一次」的路径（`asr` 用 `_load_key()` 当载荷签名，签名变了才在后台线程重建，不能占住 watcher 线程）；ASR 还多一条要求——「切到本机没装模型的后端」不能把音箱弄哑：保留已装好的 recognizer、只警告一次、把原因写进 `_last_error` 与 `/api/health` 的 `data.asr`。改这三块后跑 `pytest -q tests/test_sherpa_asr_load.py`
- 新增播报点或提示音：照 `core/external_conversation.py` 的现成范例（`_NOTIFY_SOUND_PATH` / `_load_notify_sound()` / `_play_notify()` 一带；音频解码用 Rust 的 `decode_audio(..., format="mp3", sample_rate=24000)`，声音文件放 `core/assets/sounds/`），播放一律走 `speaker.play(...)` → 跑 `pytest -q tests/test_playback_gate.py`，并实机听一次有没有自问自答
- 改设备命令面：改 `core/services/speaker.py`，并保持「不打断 FileMonitor」的约束（见禁止操作）
- 改端口：`4399` 硬编码在**三处**——`native/src/server.rs`（`let addr`）、插件侧 `lib/ports.js`（`SPEAKER_PORT`）、`docker-compose.yml` 的端口映射；设备侧还有一处不在本仓库的拨号配置（音箱上 `/data/open-xiaoai/server.txt` 写 `ws://<host>:4399`）。漏改设备侧的现象是**音箱完全没反应**，本地不报任何错
- 改 PyO3 模块名（现在叫 `dsh_xiaoai_server`）：一次要改 `native/Cargo.toml` 的 `[package] name` 与 `[lib] name`、`native/src/lib.rs` 的 `#[pymodule] fn`、所有 Python 侧的 `import` 与 `sys.modules.setdefault` 测试桩、以及文档里的导入示例；site-packages 里的包装包目录名与 `Cargo.lock` 的包名跟着变，改完必须停桥接器 → `uv sync` → `import dsh_xiaoai_server` 验证

## 禁止操作

- 禁止把 `bridge/core/models/` 的模型文件入库。原因：数百 MB，而 `bridge/` 在 npm 包白名单（`package.json` 的 `files`）里，入库会把包与克隆一起撑爆。装模型照 `bridge/README.md` 的模型文件一节做
- 禁止改名、移走或当生成物删掉 `bridge/config.py`。原因：它是插件渲染运行时配置的模板，删了插件就渲染不出 `<dataDir>/config.py`。要改渲染逻辑去改插件侧 `lib/render-config.js`
- 禁止在 `core/external_conversation.py` 里调用 `speaker.abort_xiaoai()`。原因：会打断 FileMonitor 的唤醒通道（该文件顶部注释写明了这条）。要停播用播放闸门或 `stop_playing`。它的实现是设备侧的 `/etc/init.d/mico_aivs_lab restart`（不在本仓库）
- 禁止在业务代码里**新增**绕开 `core/services/speaker.py` 的设备命令。原因：打断语义（`killall tts_play.sh miplayer 2>/dev/null; mphelper pause`）集中在那里，散落会让某些路径打不断。`core/xiaoai.py` 里已经有一份同内容的副本与 `run_shell` 直调，那是有意保留的既存状态
- 禁止在播报路径上跳过 `PlaybackGate`。原因：麦克风一直在流，闸门没关时桥接器会听见自己并自问自答，实机日志里出现过整段「我说：…」。这不是理论风险
- 禁止手改 `bridge/uv.lock` / `bridge/Cargo.lock`。原因：用 `uv` 更新它们；两个锁文件有意入库，手改会与 `pyproject.toml` / `Cargo.toml` 漂移
- 禁止引入第二个日志级别环境变量（如 `LOG_LEVEL`）。原因：`core/utils/logger.py` 只读 `LOGLEVEL`，另一个名字看着生效其实是死键
- 禁止让需要真设备或真凭据的脚本进 pytest 收集。原因：pytest 只要导入模块就会连云端甚至让音箱出声，没设备时收集阶段就炸。这类脚本放 `tests/test_tts*.py` 并登记到 `tests/conftest.py` 的 `collect_ignore`
- 禁止自行改 `bridge/pyproject.toml` 的 `name` / `version`。原因：`name` 是分发名（dist-info 仍是 `open_xiaoai_bridge-1.0.0.dist-info`），改它要连带处理打包与安装；Rust 模块名与导入路径**不来自它**，而来自 `native/Cargo.toml` 的 `[package]` / `[lib] name` 与 `native/src/lib.rs` 的 `#[pymodule]`。版本号变动要先报备

## 验收标准

改动完成 = 下列全部通过：

1. `.\.venv\Scripts\python.exe -m pytest -q`：基线 `115 passed, 19 subtests passed`，只许升不许降
2. 改过 `.py`：桥接器真的起得来。停掉旧进程 → 起 `main.py` → 日志里没有 `Traceback`
3. 改过 `native/src/**/*.rs`：`uv sync` 编译通过，且 `import dsh_xiaoai_server` 成功
4. 仓库根 `npm run check` 全绿（九条离线检查）
5. 改过配置键、端点或 provider：`bridge/README.md` 与本文件同步更新

仓库没有 CI，上面这些只能在本地跑。

## 已知风险区

| 路径 | 风险 | 动作 |
|---|---|---|
| `core/utils/playback_gate.py` | 半双工闸门：引用计数或设备事件时序写错会自问自答；设备不上报播放事件时还可能把麦克风关死 | 改前读文件顶部 docstring；跑 `tests/test_playback_gate.py` |
| `native/src/server.rs` | `4399` 硬编码，与插件 `lib/ports.js`、`docker-compose.yml` 镜像；设备侧另有一份不在仓库内的拨号配置 | 三处一起改 + 人工改设备侧 `/data/open-xiaoai/server.txt` |
| `core/services/speaker.py` | 设备命令面与打断，写错在单测里看不出来 | 实机验证一次打断 |
| `core/services/api_server.py` + `api_auth.py` | 监听地址可被设成 `0.0.0.0`，等于把音箱的播放与唤醒交给整个局域网 | 新端点走既有 middleware，不要绕过 |
| `core/utils/config.py` + `config_loader.py` | 配置由插件渲染到 `<dataDir>/config.py` 并秒级热重载 | 不要在模块顶层缓存配置值（`api_auth.py` 就是每请求读） |
| `core/dsh.py` | 令牌来源（`XIAOAI_API_TOKEN` 优先、渲染配置的 `dsh.token` 兜底）与 `run_id` 关联 | 令牌单源；取不到值会让音箱每句被插件 503 |
| `bridge/README.md` 的示例 | 快速开始与配置示例还是旧值（`session_key` 写作 `agent:main:open-xiaoai-bridge`） | 默认值以 `bridge/config.py` 的 `dsh.session_key` / `openai.session_key` 为准 |
| `bridge/.venv` 里的 `.pyd` | Windows 上文件被占用就删不掉 | 改 Rust 前先停桥接器 |

## 出错怎么办

| 症状 | 处理 |
|---|---|
| `No module named 'dsh_xiaoai_server'`、`ImportError: DLL load failed` | Rust 扩展没编译好：停桥接器后 `uv sync`；`main.py` 会自动补 onnxruntime 的库路径 |
| `failed to remove file ...dsh_xiaoai_server.pyd: 拒绝访问 (os error 5)` | 桥接器还在跑，`.pyd` 被占用：停掉再 `uv sync` |
| 日志刷 `Unknown tts_provider=` | provider 名字没进 `SUPPORTED_PROVIDERS`，见修改契约 |
| 音箱自己接自己的话 | 有播报路径没过 `PlaybackGate`，或闸门提前放开 |
| 音箱完全没反应，日志里 `[DSH] Plugin not reachable at` | 桥接器连不上插件：确认 DSH 在跑，且 `base_url` 是 `http://127.0.0.1:19387/plugin/xiaoai` |
| 每一句都被拒 | 令牌没拿到：看插件 `/health` 的 `tokenConfigured` 与诊断里的 `token-not-applied` |
| `No module named pytest` | 刚跑过 `uv sync` 清掉了 dev 依赖：`uv pip install --python .venv\Scripts\python.exe pytest`；也可能是用了系统 Python，改用 `bridge/.venv` 的解释器 |

## 维护说明

改验收命令、模块边界、禁止项或风险区时，同一次提交里改本文件。`bridge/` 的结构与命令以代码和配置为准，本文件只写规则与结论，不复制代码细节。
