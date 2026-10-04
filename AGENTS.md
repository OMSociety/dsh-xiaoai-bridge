# AGENTS.md — dsh-xiaoai-bridge

适用范围：本仓库全部目录（含 `bridge/`）。本文件只放定位、命令、硬边界与验收口径；按主题拆出去的详版见「文档索引」。
最后更新：2026-10-04

## 项目概览

- 一句话定位：把小米小爱音箱接入 DeepSeek Harness 的插件。宿主侧托管一个本地 Python 桥接器进程，跑通「唤醒词 → 说话 → DSH 会话 → 音箱播报」，全部配置走 DSH 官方插件设置页。
- 技术栈：Node >= 20（ESM，**无构建步骤**）；DSH 插件 = 宿主半 `lib/index.js` + 浏览器半 `lib/client.js`；桥接器在 `bridge/`（Python >= 3.12，uv 管理，含 maturin/PyO3 编译的 Rust 扩展）；测试 = `scripts/check-*.mjs` 九个 node 检查 + `bridge/` 的 pytest。
- 桥接器运行时：Rust 扩展在 TCP `4399` 上收设备音频，Python 侧做 VAD、唤醒词与 ASR，把一句话交给会话后端（DSH / OpenAI 兼容 / 小爱原生），回复经 TTS 播回音箱；播放期间半双工闸门关掉麦克风通路。本地推理用 `sherpa-onnx` + `onnxruntime`，HTTP 用 `aiohttp`，设备命令面是 `mphelper` / `miplayer` / `tts_play.sh`。

## 文档索引

- 用法、配置项、排错表：[README.md](./README.md)
- 环境要求、提交前要跑什么、写作约定：[CONTRIBUTING.md](./CONTRIBUTING.md)
- 按改动类型查「一起改什么、跑什么」：[docs/agents/change-contract.md](./docs/agents/change-contract.md)
- 高风险路径与症状处置：[docs/agents/risks.md](./docs/agents/risks.md)
- 桥接器运行与配置参考（边界、模型、环境变量、端点、TTS、Docker）：[docs/agents/bridge.md](./docs/agents/bridge.md)
- 桥接器 API Server 端点表：[bridge/docs/openxiaoai-voice-api.md](./bridge/docs/openxiaoai-voice-api.md)；豆包语音合成与声音复刻的上游接口参考：[bridge/docs/doubao-tts-api.md](./bridge/docs/doubao-tts-api.md)、[bridge/docs/doubao-clone-api.md](./bridge/docs/doubao-clone-api.md)
- 变更历史（中英双语，`bridge/` 的改动也记在这里）：[CHANGELOG.md](./CHANGELOG.md)
- 许可与免责：[DISCLAIMER.md](./DISCLAIMER.md)

## 常用命令

命令按 PowerShell 写；注明「在 `bridge/` 里」的行工作目录是 `bridge/`，其余在仓库根。

| 目的 | 命令 |
|---|---|
| 全部离线检查（九个，聚合入口，提交前底线） | `npm run check` |
| 跑单个离线检查 | `node scripts\check-config.mjs` |
| 文档 QA（emoji / `---` / 表格列数 / README 锚点） | `node tools\doc-check.mjs` |
| CHANGELOG 结构 QA（标题日期、中英类别与条目 1:1） | `node tools\changelog-check.mjs` |
| 宿主侧端到端冒烟（假 cordis 上下文驱动 `/plugin/xiaoai`） | `node tools\plugin-smoke.mjs` |
| 桥接器测试（提交前底线，基线 157 passed / 19 subtests） | 在 `bridge/` 里：`.\.venv\Scripts\python.exe -m pytest -q` |
| 跑单个测试文件 | 在 `bridge/` 里：`.\.venv\Scripts\python.exe -m pytest -q tests/test_tts_router.py` |
| 把本机 checkout 装进 profile（软链） | `dsh plugin --profile desktop add <仓库绝对路径>` |
| 装桥接器依赖（Rust 扩展现场编译，首次约十几分钟） | 在 `bridge/` 里：`uv sync --no-install-project`，再 `uv sync` |
| 确认 Rust 扩展能导入 | 在 `bridge/` 里：`.\.venv\Scripts\python.exe -c "import dsh_xiaoai_server"` |
| 给桥接器 venv 装 pytest（`uv sync` 会把它清掉） | `uv pip install --python bridge\.venv\Scripts\python.exe pytest` |
| 单独起桥接器、只开 API Server、跑真设备手动脚本 | 见 [docs/agents/bridge.md](./docs/agents/bridge.md) |

`npm run check` 依次 spawn 九个检查并透传输出，任一非 0 即整体非 0，工作目录都是仓库根（用相对路径，在别处跑会直接报找不到文件）：`check-client`、`check-config`、`check-keywords`、`check-session`、`check-supervisor`、`check-speak`、`check-diagnostics`、`check-http`、`check-cleanup`。跑完再进 `bridge/` 跑上表那条 pytest，两半都绿才算过。

profile 名以你的 DSH 安装为准（上表按 `desktop` 写）；`uv` 不在 PATH 时用它的绝对路径调用。没先 `uv sync` 就导入会报 `No module named 'dsh_xiaoai_server'`。

## 架构边界

```text
浏览器半 lib/client.js ──┐
                        ├─ DSH 宿主 lib/index.js ── Python 桥接器进程 bridge/ ── 小爱音箱
插件 HTTP /plugin/xiaoai/*（lib/http.js） ──┘        （桥接器回调 127.0.0.1:19387/plugin/xiaoai）
```

- **找东西搜符号名，不要信行号**：`lib/client.js` 是手写产物、随时会被别的批次改动，行号锚点必然烂掉。常用的唯一符号：宿主半的 `inject`、`ctx.inject(['webServer'], …)`、`DATA_DIR_NAME`、`reportHeldPorts`；浏览器半的 `window.__ModuleLoader__.load({…})`、`BUNDLE_SLOT` / `BUNDLE_KEY`、`var inject = ["slots","locale"]`；端口的 `SPEAKER_PORT`；诊断码表的 `DIAGNOSTIC_CODES`。
- 宿主半用导出声明依赖：`lib/index.js` 的 `export const inject = ['tools', 'skills', 'settings', 'credentials', 'agents']`；`webServer` 是软依赖，走同一个文件里的 `ctx.inject(['webServer'], …)` 再 `mountHttp`。浏览器半注册到席位 `plugins.bundle.config` / key `dsh-xiaoai-bridge`（= 包名）。
- 配置只有一个来源：`lib/config.js` 的 `DEFAULTS` + `CONFIG_SCHEMA`（Schemastery）。`<DSH_HOME>/xiaoai-bridge/config.py` 是 `lib/render-config.js` 用 `bridge/config.py` 当模板渲染出来的（原子写：临时文件 + `renameSync`），**不是**手改的对象。
- 端口：`4399` 是 Rust 扩展里硬编码的（`bridge/native/src/server.rs` 的 `let addr = "0.0.0.0:4399";`；插件侧镜像是 `lib/ports.js` 的 `SPEAKER_PORT`）；`9092` 是桥接器 API Server 的默认端口（设置项 `apiServerPort`）。插件自己不开端口，路由挂在 DSH 的 webServer 上。
- 设备绑定走两条环境变量：设置项 `deviceName` / `deviceHost` → `lib/process.js` 的子进程环境 → `bridge/core/dsh.py` 读的 `XIAOAI_DEVICE_NAME` / `XIAOAI_DEVICE_HOST`，设备名与 IP 随每次 `/asr` 提交回插件。改设备绑定要顺着这条链一起看，别在某一侧写死。
- 数据目录 `<DSH_HOME>/xiaoai-bridge/`（`lib/index.js` 的 `DATA_DIR_NAME`）；删哪些、留哪些是设计决策，见 `lib/cleanup.js` 的 `GENERATED_FILES` / `GENERATED_SUFFIXES` / `HISTORY_FILES`。

桥接器侧的依赖方向（下层不认识上层），模块清单见 [docs/agents/bridge.md](./docs/agents/bridge.md)：

```text
native/src（PyO3 模块 dsh_xiaoai_server）
    ↑ 只有 Python 调 Rust，Rust 不反向导入 Python 模块
core/utils  ←  core/services  ←  core/*.py（会话后端）  ←  main.py
```

- Rust 导出面就是 Python 侧的契约，改名或改签名要同时改全部调用点，Python 侧没有任何类型检查兜底。
- 会话后端之间不互相调用；要出声一律走 `core/services/tts/router.py` 的 `TTSRouter`。
- 设备命令集中在 `core/services/speaker.py`，新代码不要另拼 shell。Rust 导出的播放类函数是不带闸门的底层出口，新增直调必须自己承担闸门责任。
- 任何播报路径都必须过 `core/utils/playback_gate.py` 的单例 `PlaybackGate`，不要自己另写一份计时。

## 改动契约（速查）

细版（每类要一起改的文件、断言联动与命令）在 [docs/agents/change-contract.md](./docs/agents/change-contract.md)。

| 改动 | 一起改 | 必跑 |
|---|---|---|
| 配置项 | `lib/config.js`（`DEFAULTS` + `CONFIG_SCHEMA`）、`lib/client.js` 中英文案、`lib/process.js` 的 `bridgeChildEnv()` 或 `lib/render-config.js` 的 `buildOverrides()`、README 配置表 | `check-config`、`check-client` |
| 界面 | `lib/client.js` 中英两张表、README | `check-client` |
| 诊断码 | `lib/diagnostics.js` 的 `DIAGNOSTIC_CODES`（数组顺序即展示顺序）、`lib/client.js` 文案、README 排错表 | `check-diagnostics` |
| Agent 预设 | 根 `cordis.patch.yml` 第二条 insert（`preset-xiaoai`）；`plugins` 清单不加子代理/计划模式/`dsh-tool-ask-user` | `check-session` |
| HTTP 路由 | `lib/http.js`（不加 CORS 头） | `check-http` |
| 端口 | `bridge/native/src/server.rs`、`lib/ports.js`、`bridge/docker-compose.yml`，外加设备侧 `server.txt` | `check-cleanup`、`check-supervisor` |
| 进程托管 | `lib/process.js`（接管认 pid + 命令行身份；重启预算按滑动崩溃窗口） | `check-supervisor` |
| teardown | `lib/cleanup.js`（只在 stop 成功且端口释放时删 generated） | `check-cleanup` |
| 主动说话 | `lib/auto-speak.js`、`lib/replyer.js`、`lib/speech-log.js` | `check-speak` |
| 会话记录 | `lib/session.js` | `check-session` |
| TTS provider | 桥接器 `SUPPORTED_PROVIDERS` + 插件 `RENDERED_TTS_PROVIDERS` | `check-config`、`check-client`、`pytest -q tests/test_tts_router.py` |
| 音频链路 | `bridge/core/services/audio/`（配置热生效是契约） | `pytest -q tests/test_sherpa_asr_load.py` |
| `.rs` | 先停桥接器（`.pyd` 被占用就删不掉）再 `uv sync` | 编译通过 + `import dsh_xiaoai_server` |
| 版本号 | 先报备用户 | 无 |
| 对外文档 | 零 emoji、不写 `---`、只写最终状态；取舍写进 CHANGELOG | `node tools\doc-check.mjs`、`node tools\changelog-check.mjs` |

一次改动跨了多行时，相关检查**全跑**（并集，没有优先级）。

## 禁止操作

- 禁止改名、移走或当生成物删掉 `bridge/config.py`。原因：它是桥接器模板，`lib/render-config.js` 靠它生成真正生效的配置，删了桥接器起不来、插件也渲染不出 `<dataDir>/config.py`。
- 禁止提交 `bridge/config.py.rendered`、`**/device.json`、`**/devices.json`、`*.token`、`credentials.json`、`bridge/.venv/`、`bridge/core/models/`、`__pycache__`、`.pytest_cache/`。原因：`.gitignore` 已挡住这些运行时产物与凭据，`git add -f` 只会把凭据与大文件带进历史。
- 禁止把 `bridge/core/models/` 的模型文件入库。原因：数百 MB，而 `bridge/` 在 npm 包白名单里，入库会把包与克隆一起撑爆。
- 禁止用 `pnpm pack` / `npm publish` 的结果判断包干净不干净。原因：它不读 `.npmignore`，会把 `bridge/` 的 venv 与模型一起打进 tarball（实测到过数百 MB）；判断白名单用 `npm pack --dry-run` 看清单。
- 禁止把服务名写进 `package.json` 的 `dsh.client.inject`。原因：那里声明的必须是包依赖边，服务依赖由客户端 bundle 导出的 `inject` 决定，写服务名会被静默忽略。
- 禁止手改 profile 的 `node_modules`。原因：那里是指向本仓库的 `link:` 软链，改那边等于改一份没人维护的副本；装卸走 `dsh plugin --profile <name> add|remove`。
- 禁止把提交推到 `origin` 之外的任何远端。原因：本仓库的提交只去 `origin`，另一个远端（`upstream`）是别人的项目，只读参考。
- 禁止自行 bump `package.json` 的版本号。原因：版本是用户可见契约，改前先报备。
- 禁止在 `bridge/core/external_conversation.py` 里调用 `speaker.abort_xiaoai()`。原因：会打断 FileMonitor 的唤醒通道（该文件顶部注释写明了这条），要停播用播放闸门或 `stop_playing`。
- 禁止在桥接器业务代码里新增绕开 `bridge/core/services/speaker.py` 的设备命令。原因：打断语义集中在那里，散落会让某些路径打不断；`bridge/core/xiaoai.py` 里那份同内容副本是有意保留的既存状态。
- 禁止在播报路径上跳过 `PlaybackGate`。原因：麦克风一直在流，闸门没关时桥接器会听见自己并自问自答，实机日志里出现过整段「我说：…」。
- 禁止手改 `bridge/uv.lock` / `bridge/Cargo.lock`。原因：用 `uv` 更新它们，手改会与 `pyproject.toml` / `Cargo.toml` 漂移。
- 禁止引入第二个日志级别环境变量（如 `LOG_LEVEL`）。原因：`bridge/core/utils/logger.py` 只读 `LOGLEVEL`，另一个名字看着生效其实是死键。
- 禁止让需要真设备或真凭据的脚本进 pytest 收集。原因：pytest 只要导入模块就会连云端甚至让音箱出声；这类脚本放 `bridge/tests/test_tts*.py` 并登记到 `bridge/tests/conftest.py` 的 `collect_ignore`。
- 禁止自行改 `bridge/pyproject.toml` 的 `name` / `version`。原因：`name` 是分发名，改它要连带处理打包与安装；Rust 模块名来自 `native/Cargo.toml` 与 `native/src/lib.rs`，不来自它。版本号变动先报备。

## 验收标准

改动完成 = 下列全部通过：

1. 九个离线检查全绿：仓库根跑 `npm run check`，全部 exit 0。
2. 桥接器测试：在 `bridge/` 里跑 `.\.venv\Scripts\python.exe -m pytest -q`，当前基线 **157 passed, 19 subtests**。基线只许升：数字变大是新增测试，变小说明有测试被删或被跳过，要查清再提交。
3. 改过桥接器的 `.py`：桥接器真的起得来，停掉旧进程、起 `main.py`、日志里没有 `Traceback`。
4. 改过 `bridge/native/src/**/*.rs`：`uv sync` 编译通过，且 `import dsh_xiaoai_server` 成功。
5. 改了宿主/客户端行为时，重启 DSH 后在真机上核对：插件在 profile 里是 `link:` 指向本仓库的 checkout，重启即载入当前工作树，不需要重新安装。
6. 改过配置键、端点或 provider：[bridge/docs/openxiaoai-voice-api.md](./bridge/docs/openxiaoai-voice-api.md)（端点）与本文件同步更新。

仓库**没有 CI**（仓库根没有 `.github/`），上面这些只能在本地跑；改动只碰文档时，第 1、2 条仍要跑一遍。

`tools/plugin-smoke.mjs` 可以顺手当回归跑，但它是 `tools/` 下的按需工具，**不算那九条检查、也不算 CI**。

## 开工前必看

- 改 `lib/client.js` 前想清楚：手写产物、没有 bundler，语法或席位写错只有运行时才炸。
- 改 `lib/config.js` 时两处（`DEFAULTS` 与 `CONFIG_SCHEMA`）一起改，运行时坏值会被 `sanitizeConfig` 静默回退成默认值。
- 改 `lib/http.js` 等于动鉴权边界：缺令牌必须 fail-closed，离线检查也测不全真机 socket 行为。
- 改 `lib/exposure.js` 时，宿主没有 scoped `tools`/`skills` 就必须不注册并记 `scope-registration-unavailable`，绝不退回全局。
- 动 `4399`、`lib/process.js`、`PlaybackGate` 或豆包凭据前，先读 [docs/agents/risks.md](./docs/agents/risks.md) 对应那一行。

## 维护

本文件与代码同 PR 更新。改动以下内容时必须同步本文件：验收命令（`scripts/check-*.mjs` 的增删）、`tools/` 下工具的增删（同步 [tools/README.md](./tools/README.md)：`doc-check.mjs`、`changelog-check.mjs`、`render-outline.mjs`、`plugin-smoke.mjs`）、模块边界与端口、`.gitignore` 的禁区、profile 的安装方式。拆出去的详版（[change-contract.md](./docs/agents/change-contract.md)、[risks.md](./docs/agents/risks.md)、[bridge.md](./docs/agents/bridge.md)）也要跟着改，别让两边说法不一致。

发现内容与代码不符时，先改本文件再继续改代码。`bridge/` 侧的规则也在本文件与上述详版里；文档索引里没有 `bridge/` 单独的 README / AGENTS / CHANGELOG，桥接器的改动逐条记在根 [CHANGELOG.md](./CHANGELOG.md)，进本仓库之前的上游历史在上游仓库里。
