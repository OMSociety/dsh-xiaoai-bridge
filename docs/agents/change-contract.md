# 改动契约（详版）

根 [AGENTS.md](../../AGENTS.md) 的外移章节。动手前先按改动内容读对应的一节；每节给的是「要一起改什么、跑什么」。总入口仍是根文件的「验收标准」与 [risks.md](./risks.md)。

过去的取舍与踩过的坑在 [CHANGELOG.md](../../CHANGELOG.md) 的版本条目里（搜关键词比重新试一遍便宜）。

## 总则

- 一次改动跨了多节时，相关检查**全跑**（例如既加配置项又改界面 = `check-config` + `check-client`），这里只有并集，没有优先级。
- 运行时有一层自愈：`configNow()` 走 `lib/config.js` 的 `sanitizeConfig()`，坏键逐条回退 `DEFAULTS`，并按坏值集合去重告警 `unusable config repaired with defaults: …`（同一组坏值只告警一次，不同坏值各告警一次）；写路由那边用 `validateConfig()` 严格 throw `dsh-xiaoai-bridge config: …`。所以别把「坏值不报错」当成校验通过。
- `wakeupTimeout` 必须是 `1`–`600` 的整数（`Number.isInteger`）。

## 改配置项

- 动手前先确认这个键**是否已经存在**（`logLevel`、`ttsSpeed`、`doubao*` 这几组早就在），别重复新增。
- `lib/config.js` 的 `DEFAULTS` 与 `CONFIG_SCHEMA` 两处一起改。
- `lib/client.js` 的中英两张文案表都要补。
- 值到桥接器有**两条通道**，按桥接器读它的方式选一条或两条都走：环境变量通道 = `lib/process.js` 的 `bridgeChildEnv()`（设置项到环境变量的唯一映射处；键名必须是桥接器**真正读**的那个，`LOG_LEVEL` 曾经是个看着生效的死键，桥接器读的是 `LOGLEVEL`）；渲染配置通道 = `lib/render-config.js` 的 `buildOverrides()`（写进 `<dataDir>/config.py`，键名对应 `bridge/config.py` 里的同名项）。
- [README.md](../../README.md) 的配置表同步。
- 跑 `node scripts\check-config.mjs` 与 `node scripts\check-client.mjs`。开关类控件会让 `check-client` 的 Switch 计数变化，那是断言在提醒你确认。

## 加 TTS provider

- 桥接器侧名字必须进 `bridge/core/services/tts/router.py` 的 `SUPPORTED_PROVIDERS`；不在集合里只会 warn 一条 `Unknown tts_provider=` 再按 `tts_speaker` 回退（不报错，所以容易看着没事其实没生效）。
- 插件侧还要把名字加进 `lib/render-config.js` 的 `RENDERED_TTS_PROVIDERS`，否则 `buildOverrides()` 永远不写 `dsh.tts_provider`，设置页选中等于没选。
- 两张表不是同一张：`lib/config.js` 的 `TTS_PROVIDER_VALUES` 是设置页能选什么（只有 `xiaoai` 与 `doubao`，没有「留空跟随」这一档，所以 `buildOverrides()` 总会写 `dsh.tts_provider`），桥接器的 `SUPPORTED_PROVIDERS` 是真正支持什么。桥接器那条「空值就按 `tts_speaker` 回退」的旧规则还在，只是设置页不再产出空值。
- 断言会一起动：`scripts/check-config.mjs`（`tts_provider` 连默认值也照写、豆包四值按需写进 `tts.doubao`）、`scripts/check-client.mjs`（`ttsProvider` 选项文案逐字断言）。
- 跑 `check-config`、`check-client` 与 `pytest -q tests/test_tts_router.py`。

## 改界面

- 直接改 `lib/client.js`（没有 bundler 兜底），中英两张表都要改。
- 核一下 [README.md](../../README.md) 的配置项与排错表有没有要同步的行。
- 跑 `node scripts\check-client.mjs`：它在沙箱里求值 bundle，断言 module id、`apply`/`inject`、席位注册并渲染一次组件；能拦住语法、模块形态与席位写错，**拦不住**真机上的交互与桥接器进程行为。
- 改的若是用户看得见的行为，还要按验收标准第 5 条重启 DSH 核对。

## 加/改诊断码

- `lib/diagnostics.js` 的 `DIAGNOSTIC_CODES`（**数组顺序就是展示顺序**，新码加在语义相邻处）。
- `lib/client.js` 中英文案。
- README 排错表（顺序以代码里的数组为准，别按严重程度自己排）。
- 跑 `node scripts\check-diagnostics.mjs`。
- `token-not-applied` 是 `warn` 不是错误：`collectFacts()` 在 `bridgeApi.auth === 'loopback-only' && tokenConfigured` 时记一次（detail `the bridge started before the API token existed; restart the bridge to apply it`）。

## 改 Agent 预设

- 预设声明就在根 `cordis.patch.yml` 的第二条 insert（`id: preset-xiaoai` / `name: '@deepseek-ai/dsh-agent-preset'`，与插件本体那条在同一个 bundle 里）。
- `plugins` 清单是 **standard 减掉一部分**：清单里**可以有终端与待办**，但**不要加回子代理/工作流、计划模式与 `dsh-tool-ask-user`**，那几样会让语音这一轮卡在没人看的界面上；沙箱与审批在宿主侧，别在预设里再声明一遍。
- profile 里是 `link:`，改完不用重装；**新增工具**要重启 DSH 并让音箱会话新建一个（已存在的会话保留它启动时的 revision）。
- 宿主没有 `agentPresets` 注册表、或 `agentPreset` 留空时**完全不碰注册表**；预设没装/激活失败/挂载抛错都只软降级 + 一条 `warn`（`agent-preset-missing` / `agent-preset-broken` / `agent-preset-mount-failed`），绝不因此让音箱会话不说话。
- 跑 `node scripts\check-session.mjs`（case 11 覆盖预设解析、软降级与 resume 路径）。

## 改会话记录与历史

- `lib/session.js`，跑 `node scripts\check-session.mjs`（它覆盖会话读写与 `SOURCE_KIND`）。

## 改主动说话与播报

- `lib/auto-speak.js`（触发条件与默认文案）、`lib/replyer.js`（回复路由与提示词拼装）、`lib/speech-log.js`。
- `spoken.jsonl` 的轮转：超过 `SPOKEN_LOG_MAX_BYTES = 5 * 1024 * 1024` 就整体轮转到**单槽** `spoken.jsonl.1`，也就是历史只保留上一代，旧的一代会被下次轮转覆盖；轮转失败只 warn 一次 `spoken log rotation failed` 并继续追加，不丢记录；`createSpokenLog(...).size()` 就是 `collectFacts()` 里 `spokenLogBytes` 的来源。
- 跑 `node scripts\check-speak.mjs`。

## 改端口

- `4399` 在仓库里是**三处**硬编码：`bridge/native/src/server.rs` 的 `let addr`、`lib/ports.js` 的 `SPEAKER_PORT`、`bridge/docker-compose.yml` 的端口映射，必须同时改。
- 设备侧还有一处**不在仓库内**的拨号配置（音箱上 `/data/open-xiaoai/server.txt` 写着 `ws://<host>:4399`），改端口要人工改那一份。漏改设备侧的现象是**音箱完全没反应**（本地不报任何端口错误）；漏改插件侧才会让「端口仍被占用」的诊断误报或漏报、并让 teardown 的删/留判断出错。
- 「端口仍被占用」的探测地址跟着 `apiServerHost` 走：`0.0.0.0`、`::` 或空串都落到 `127.0.0.1`，实现是 `lib/index.js` 的 `reportHeldPorts()`。
- 跑 `check-cleanup` 与 `check-supervisor`。

## 改进程托管（接管遗留进程 / watchdog / 进程树清理）

- 代码在 `lib/process.js`。
- 接管要**认身份**，不是只认 pid：pid 文件里存的是 pid + 命令行身份，win32 用 `Get-CimInstance Win32_Process` 取命令行比对解释器与 `main.py`（旧版裸数字 pid 文件的记录退回只比对 `main.py`）。
- 看门狗的重启预算是**滑动崩溃窗口**（`crashWindowMs`，默认 60 分钟）里的崩溃计数，不是「连续崩了几次」。别引入「活够久就清零」的规则（那会让周期性慢崩永远重试下去），只有用户显式 `start()` 才清空。
- spawn 失败也要进看门狗（否则一次失败就再也不重启），start/stop 要有并发守卫。
- 跑 `node scripts\check-supervisor.mjs`。

## 改 HTTP 路由

- `lib/http.js`：前缀 `ROUTE_PREFIX = '/plugin/xiaoai'`；`/health`、`/config` GET 与 POST、`/bridge/logs`、`/bridge/start`、`/bridge/stop`、`/bridge/status`、`/bridge/health`、`/bridge/restart`、`/asr`、`/devices`、`/data/wipe`。
- 请求体一律 `JSON.parse(await readBody(req))`，设置写入要处理 revision 冲突；同源校验（`Origin` 检查）在同一个文件里，**不要加 CORS 头**。
- 跑 `node scripts\check-http.mjs`：它是唯一直接碰 HTTP 层的离线检查，覆盖缺令牌 fail-closed 503、错误/缺失 bearer 401、正确 bearer 只投递一次、非 JSON 400、真实 socket 上超限体收到 400 而不是 `ECONNRESET`、跨源 403 且不带 CORS 头、未知路由 404、`/data/wipe` 缺 confirm 拒绝、bridge 客户端拒绝恶意 host:port。
- 它拦不住的是真机 socket 时序与设备侧行为，改协议语义时仍要拿真实请求把改动的路由打通一遍（含拒绝路径）。

## 改 teardown / 卸载

- 动 `lib/cleanup.js`，跑 `node scripts\check-cleanup.mjs`。
- 只有「`stop()` 成功且占用的端口都释放」时才删 generated；否则保留 `bridge.pid`（`removeGenerated({ keep: [...] })` 是新签名，保留项同时出现在返回值的 `kept` 里）并告警 `keeping generated files in <dataDir> (…); the next start adopts the leftover process`。

## 改 4399 的客户端鉴权

- 设置项在 `lib/config.js` 的 `DEFAULTS.speakerAuth` / `CONFIG_SCHEMA`，路由在 `lib/process.js` 的 `childEnv()`（开着才写 `DSH_XIAOAI_TOKEN`，关掉时必须 `delete`，否则交互式 shell 里的残留值会把校验偷偷武装起来），校验在 `bridge/native/src/server.rs` 的 `expected_token()` / `query_token()` / `tokens_match()`。
- 401 的日志要把可操作的三条提示写全：设备加 `OPEN_XIAOAI_TOKEN`、把 `server.txt` 写成 `?token=`、或关掉这个开关。
- 断言会一起动：`scripts/check-config.mjs`（默认 `true`）、`scripts/check-supervisor.mjs` case I（真子进程读环境变量，外加 `speakerAuth: false` 的子场景）、`scripts/check-client.mjs`（Switch 计数 9）。文档要同步 README 的「音箱连接鉴权」与设备侧 `server.txt` 的 `?token=` 写法。
- 跑 `check-config`、`check-supervisor`、`check-client`。

## 改桥接器配置模板

- 改 `bridge/config.py` 的默认值与注释。`<dataDir>/config.py` 是插件以它为模板渲染出来的，所以还要确认 `lib/render-config.js` 的 `buildOverrides()` 会写这个键，否则设置页改了不生效。
- 跑 `pytest -q tests/test_config_loader.py`。

## 改豆包语音合成

- 播放路径在 `bridge/core/services/tts/router.py` 的 `_play_doubao`（凭据 `DOUBAO_ACCESS_KEY` 优先、`tts.doubao.access_key` 兜底；`app_id` / `access_key` 缺一即抛 `Doubao TTS credentials are not configured`）。
- 合成客户端在 `bridge/core/services/tts/doubao.py`（`resource_id` 按音色前缀自动判定、`audio_format = auto` 时按字数在 pcm / mp3 之间选）。
- 配置键的默认值与注释在 `bridge/config.py` 的 `tts.doubao`，插件侧设置项与渲染在 `lib/config.js` / `lib/render-config.js`。
- 跑 `pytest -q tests/test_tts_router.py`。

## 改 API Server

- 端点在 `bridge/core/services/api_server.py` 的 setup 里注册，鉴权由 `api_auth.py` 的 middleware 统一加，不要在 handler 里另判令牌。
- 新增端点同步更新 `bridge/docs/openxiaoai-voice-api.md` 的端点表。
- 跑 `pytest -q tests/test_api_server_auth.py tests/test_api_server_playback_queue.py`。

## 改音频链路（VAD / KWS / ASR）

- 代码在 `bridge/core/services/audio/`，模型放 `bridge/core/models/`（不入库）。牢记前提「设备说话时麦克风仍在往本进程送音频」。
- **配置热生效是契约**：`vad` / `kws` / `asr` 都靠 `ConfigManager.add_reload_listener` 在每秒的配置轮询里生效，别再引入「启动时读一次」的路径（`asr` 用 `_load_key()` 当载荷签名，签名变了才在后台线程重建，不能占住 watcher 线程）。
- ASR 还多两条要求：切到本机没装模型的后端不能把音箱弄哑（保留已装好的 recognizer、只警告一次、把原因写进 `_last_error` 与 `/api/health` 的 `data.asr`）；SenseVoice 的 `language` 固定 `"zh"`（本项目只服务中文用户，`auto` 会把短音频判成日文），不要重新暴露成配置项。
- 跑 `pytest -q tests/test_sherpa_asr_load.py`。

## 新增播报点或提示音

- 照 `bridge/core/external_conversation.py` 的现成范例（`_NOTIFY_SOUND_PATH` / `_load_notify_sound()` / `_play_notify()` 一带；音频解码用 Rust 的 `decode_audio(..., format="mp3", sample_rate=24000)`，声音文件放 `bridge/core/assets/sounds/`），播放一律走 `speaker.play(...)`。
- **提示音是「现在开始收音」的信号，开麦必须排在它之前**（`_stop_recording()` 到 `_start_recording()` 再到 `_play_notify()`；提示音本身由 `PlaybackGate` 丢掉），别把开麦留到提示音之后——那样提示音就不是准的，紧跟提示音开口的头几个字会被截掉。
- 跑 `pytest -q tests/test_playback_gate.py`，并实机听一次有没有自问自答。

## 改设备命令面

- 改 `bridge/core/services/speaker.py`，并保持「不打断 FileMonitor」的约束（见根文件的禁止操作）。

## 改 bridge/native/src/*.rs

- Rust 扩展要重编译才生效，且**必须先让桥接器停下来**（否则 `.pyd` 被占用，`uv sync` 报 `failed to remove file …dsh_xiaoai_server.pyd: 拒绝访问 (os error 5)`）。
- 顺序：`POST http://127.0.0.1:19387/plugin/xiaoai/bridge/stop`（该路由不要凭据）→ 在 `bridge/` 里 `uv sync` → 确认 `bridge\.venv\Lib\site-packages\dsh_xiaoai_server\dsh_xiaoai_server.pyd` 的修改时间就是刚才 → `POST …/bridge/start`。
- `bridge/pyproject.toml` 的 `tool.uv.cache-keys` 已声明触发路径。

## 改 PyO3 模块名（现在叫 dsh_xiaoai_server）

- 一次要改 `bridge/native/Cargo.toml` 的 `[package] name` 与 `[lib] name`、`bridge/native/src/lib.rs` 的 `#[pymodule] fn`、所有 Python 侧的 `import` 与 `sys.modules.setdefault` 测试桩、以及文档里的导入示例。
- site-packages 里的包装包目录名与 `bridge/Cargo.lock` 的包名跟着变；改完必须停桥接器，再 `uv sync`，再 `import dsh_xiaoai_server` 验证。

## 改版本号与对外文档

- 改版本号：**先报备用户**（仓库既有纪律，见 [CONTRIBUTING.md](../../CONTRIBUTING.md)）。
- 改对外文档：零 emoji、不写 `---`、只写最终状态；架构上的偏离与取舍写进 [CHANGELOG.md](../../CHANGELOG.md) 的版本条目（当前是 `## [1.0.0] - 2026-10-04`），不要写进 README 或提交信息。
- 文档改完跑 `node tools\doc-check.mjs` 与 `node tools\changelog-check.mjs`（这两个不属于那九条离线检查）。
