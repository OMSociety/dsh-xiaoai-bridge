# AGENTS.md — dsh-xiaoai-bridge Agent 宪法

适用范围：本仓库全部目录。`bridge/` 另有 [bridge/AGENTS.md](./bridge/AGENTS.md)——那半是**基于上游原文的 fork 增补版**（Python/Rust 桥接器的边界与雷区），
改动落在哪个目录就以更接近改动点的那份为准。
最后更新：2026-10-03

## 项目概览

- 一句话定位：把小米小爱音箱接入 DeepSeek Harness 的插件——宿主侧托管一个本地 Python 桥接器进程，跑通「唤醒词 → 说话 → DSH 会话 → 音箱播报」，全部配置走 DSH 官方插件设置页。
- 技术栈：Node >= 20（ESM，**无构建步骤**）；DSH 插件 = 宿主半 `lib/index.js` + 浏览器半 `lib/client.js`；Python >= 3.12 桥接器在 `bridge/`（uv 管理，含 maturin/PyO3 编译的 Rust 扩展）；测试 = `scripts/check-*.mjs` 九个 node 脚本 + `bridge/` 的 pytest；`dsh plugin` 是 pnpm 的透传，本机 profile 用 `desktop`。
- 文档索引：
  - 用法、配置项、排错表：[README.md](./README.md)
  - 环境要求、提交前要跑什么、写作约定：[CONTRIBUTING.md](./CONTRIBUTING.md)
  - 决策与实测记录（按 §12.x 编号，含取证命令原文）：[docs/deploy.md](https://github.com/OMSociety/dsh-xiaoai-bridge/blob/main/docs/deploy.md)——这份**不随包发布**（`package.json` 的 `files` 白名单没有它，因为它含本机绝对路径与子代理会话 ID），所以仓库内、装包副本里都只能点上面的绝对 URL。
  - 变更历史（中英双语）：[CHANGELOG.md](./CHANGELOG.md)
  - 许可链与免责：[DISCLAIMER.md](./DISCLAIMER.md)
  - 桥接器（Python/Rust）的规则：[bridge/AGENTS.md](./bridge/AGENTS.md)

## 常用命令

命令按 PowerShell 写（本仓库的文档与实测都用 PowerShell）。

| 目的 | 命令 |
|---|---|
| 把本机 checkout 装进 profile（软链） | `dsh plugin --profile desktop add D:\WorkSpace\Github\dsh-xiaoai-bridge` |
| 看 profile 里装了什么、什么版本 | `dsh plugin --profile desktop list` |
| 跑全部离线检查（九个，聚合入口） | `npm run check`（= `node scripts\check-all.mjs`） |
| 跑单个离线检查 | `node scripts\check-config.mjs` |
| 装桥接器依赖（Rust 扩展现场编译，首次约十几分钟） | `uv sync --no-install-project`（在 `bridge/` 里）；再 `uv sync` |
| 跑桥接器测试（工作目录 `bridge/`） | `.\.venv\Scripts\python.exe -m pytest -q` |
| 给桥接器 venv 装 pytest（`uv sync` 会把它清掉） | `uv pip install --python bridge\.venv\Scripts\python.exe pytest` |

`npm run check` 会按下面的顺序逐个 spawn 九个检查、透传输出，任一非 0 即整体非 0；逐条命令仍然保留，**工作目录都是仓库根**（用相对路径，在别处跑会直接报找不到文件）：

```powershell
node scripts\check-client.mjs
node scripts\check-config.mjs
node scripts\check-keywords.mjs
node scripts\check-session.mjs
node scripts\check-supervisor.mjs
node scripts\check-speak.mjs
node scripts\check-diagnostics.mjs
node scripts\check-http.mjs
node scripts\check-cleanup.mjs
```

跑完再进 `bridge/` 跑上表倒数第二行那条 pytest，两半都绿才算过。

## 架构边界

```text
浏览器半 lib/client.js ──┐
                        ├─ DSH 宿主 lib/index.js ── Python 桥接器进程 bridge/ ── 小爱音箱
插件 HTTP /plugin/xiaoai/*（lib/http.js） ──┘        （桥接器回调 127.0.0.1:19387/plugin/xiaoai）
```

- 宿主半用导出声明依赖：`lib/index.js` 里的 `inject = ['tools','skills','settings','credentials','agents']`（约 `:43`）；`webServer` 是软依赖，走同一个文件里的 `ctx.inject(['webServer'], …)` 再 `mountHttp`（约 `:479`）。
- 浏览器半是**手写的已构建产物**：`lib/client.js` 开头的 `window.__ModuleLoader__.load({…})` 形态（约 `:33`），注册到席位 `plugins.bundle.config` / key `dsh-xiaoai-bridge`（= 包名，`BUNDLE_SLOT`/`BUNDLE_KEY`，约 `:55-56`），导出的服务依赖是 `var inject = ["slots","locale"]`（约 `:1259`）。
- 这里的行号只是"当时在那儿"的近似锚点（`lib/client.js` 是手写产物、随时会被别的批次改动），**找东西请以符号名为主**：`inject`、`ctx.inject`、`DATA_DIR_NAME`、`SPEAKER_PORT`、`DIAGNOSTIC_CODES` 都是唯一的，搜符号比信行号可靠。
- 配置只有一个来源：`lib/config.js` 的 `DEFAULTS` + Schemastery schema。`<DSH_HOME>/xiaoai-bridge/config.py` 是 `lib/render-config.js` 用 `bridge/config.py` 当模板渲染出来的（原子写：临时文件 + `renameSync`），**不是**手改的对象。
- 端口：`4399` 是 Rust 扩展里硬编码的（`bridge/native/src/server.rs` 的 `let addr = "0.0.0.0:4399";`，约 `:105`；插件侧镜像是 `lib/ports.js` 的 `SPEAKER_PORT`，约 `:17`）；`9092` 是桥接器 API Server 的默认端口（`apiServerPort`）。插件自己不开端口，路由挂在 DSH 的 webServer 上。
- 数据目录 `<DSH_HOME>/xiaoai-bridge/`（`lib/index.js` 的 `DATA_DIR_NAME`，约 `:48`）；删哪些、留哪些是设计决策，见 `lib/cleanup.js` 的 `GENERATED_FILES` / `GENERATED_SUFFIXES`（约 `:29-38`）。

## 修改契约

动手前先按改动内容读对应的一份：[README.md](./README.md) 的配置项与排错表、[CONTRIBUTING.md](./CONTRIBUTING.md) 的约定，以及 [docs/deploy.md](https://github.com/OMSociety/dsh-xiaoai-bridge/blob/main/docs/deploy.md) 里相关的 §12.x（那里有别人踩过的坑，搜关键词比重新试一遍便宜）。

- 改配置项：`lib/config.js` 的 `DEFAULTS` 与 schema 两处一起改 → `lib/client.js` 的中英两张文案表（中文约 `:261`、英文约 `:412`）→ 若这项要改变桥接器进程行为，改 `lib/process.js` 的 `bridgeChildEnv()`（设置项 → 环境变量的唯一映射处；键名必须是桥接器**真正读**的那个——`LOG_LEVEL` 曾经是个看着生效的死键，桥接器读的是 `LOGLEVEL`，见 `docs/deploy.md` §12.31.1）→ [README.md](./README.md) 的配置表 → 跑 `node scripts\check-config.mjs` 与 `node scripts\check-client.mjs`（开关类控件会让 `check-client` 的 Switch 计数变化，那是断言在提醒你确认）。运行时还有一层自愈：`configNow()` 走 `lib/config.js` 的 `sanitizeConfig()`，坏键逐条回退 `DEFAULTS` 并用 `unusable config repaired with defaults: …` **只告警一次**（写路由那边用 `validateConfig()` 严格 throw `dsh-xiaoai-bridge config: …`），所以别把「坏值不报错」当成校验通过；`wakeupTimeout` 必须是 `1`–`600` 的整数（`Number.isInteger`）。
- 改界面：直接改 `lib/client.js`（没有 bundler 兜底），中英两张表都要改 → 核一下 [README.md](./README.md) 的配置项与排错表有没有要同步的行 → 跑 `node scripts\check-client.mjs`（它在沙箱里求值 bundle，断言 module id、`apply`/`inject`、席位注册并渲染一次组件；能拦住语法、模块形态与席位写错，**拦不住**真机上的交互与桥接器进程行为）→ 改的若是用户看得见的行为，还要按验收标准第 3 条重启 DSH 核对。
- 加/改诊断码：`lib/diagnostics.js` 的 `DIAGNOSTIC_CODES`（当前 14 个，约 `:24`；**数组顺序就是展示顺序**，末尾三个是 `agent-preset-missing`、`agent-preset-broken`、`agent-preset-mount-failed`）→ `lib/client.js` 中英文案 → README 排错表（**顺序以代码里的数组为准**，别按严重程度自己排）→ 跑 `node scripts\check-diagnostics.mjs`。`token-not-applied` 是 `warn` 不是错误：`collectFacts()` 在 `bridgeApi.auth === 'loopback-only' && tokenConfigured` 时记一次（detail `the bridge started before the API token existed; restart the bridge to apply it`）。
- 改 Agent 预设（`preset/xiaoai/`）：那两个文件是**随仓库发布的 bundle**（`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` 里那一条 `preset-xiaoai` 声明），改完要重装才会生效（`plugin_manager` 的 `install_bundle`，`list_plugins` 看 `preset-xiaoai` 行）；`plugins` 清单是 **standard 减掉一部分**，改动前先读 `docs/deploy.md` §12.36，并跑 `node scripts\check-session.mjs`（case 11a–11f 覆盖预设解析、软降级、resume 路径）。宿主没有 `agentPresets` 注册表、或 `agentPreset` 留空时**完全不碰注册表**；预设没装/激活失败/挂载抛错都只软降级 + 一条 `warn`，绝不因此让音箱会话不说话。
- 改会话记录与历史：`lib/session.js` → 跑 `node scripts\check-session.mjs`（它覆盖会话读写与 `SOURCE_KIND`）。
- 改主动说话：`lib/auto-speak.js`（触发条件与默认文案）、`lib/replyer.js`（回复路由与提示词拼装）、`lib/speech-log.js`（`spoken.jsonl`：超过 `SPOKEN_LOG_MAX_BYTES = 5 * 1024 * 1024` 就整体轮转到**单槽** `spoken.jsonl.1`，也就是历史只保留上一代，旧的一代会被下次轮转覆盖；轮转失败只 warn 一次 `spoken log rotation failed` 并继续追加，不丢记录；`createSpokenLog(...).size()` 就是 `collectFacts()` 里 `spokenLogBytes` 的来源）→ 跑 `node scripts\check-speak.mjs`。
- 改端口：`lib/ports.js` 与 `bridge/native/src/server.rs` 必须同时改 → 跑 `check-cleanup` 与 `check-supervisor`。「端口仍被占用」的探测地址跟着 `apiServerHost` 走：`0.0.0.0`、`::` 或空串都落到 `127.0.0.1`，实现是 `lib/index.js` 的 `reportHeldPorts()`（约 `:540`）。
- 改进程托管（接管遗留进程 / watchdog / 进程树清理）：`lib/process.js`。接管要**认身份**，不是只认 pid：pid 文件里存的是 pid + 命令行身份，win32 用 `Get-CimInstance Win32_Process` 取命令行比对解释器与 `main.py`（旧版裸数字 pid 文件的记录退回只比对 `main.py`）。看门狗的重启预算是**滑动崩溃窗口**（`crashWindowMs`，默认 60 分钟）里的崩溃计数，不是「连续崩了几次」——别引入「活够久就清零」的规则（那会让周期性慢崩永远重试下去），只有用户显式 `start()` 才清空。spawn 失败也要进看门狗（否则一次失败就再也不重启），start/stop 要有并发守卫。→ 跑 `node scripts\check-supervisor.mjs`（九个 case，覆盖 pid 身份匹配/不匹配、旧版裸数字 pid 文件、接管、看门狗退避与放弃、`stop()` 取消排队重启、解释器 spawn 失败、并发 `start()` 只 spawn 一次）。
- 改 HTTP 路由：`lib/http.js`（前缀 `ROUTE_PREFIX = '/plugin/xiaoai'`，约 `:41`；`/health`、`/config` GET 与 POST、`/bridge/logs`、`/asr`、`/devices`、`/data/wipe`）。请求体一律 `JSON.parse(await readBody(req))`，设置写入要处理 revision 冲突；同源校验（`Origin` 检查）在同一个文件里，约 `:158-174`，**不要加 CORS 头**。→ 跑 `node scripts\check-http.mjs`：它是唯一直接碰 HTTP 层的离线检查，覆盖缺令牌 fail-closed 503、错误/缺失 bearer 401、正确 bearer 只投递一次、非 JSON 400、真实 socket 上超限体收到 400 而不是 `ECONNRESET`、跨源 403 且不带 CORS 头、未知路由 404、`/data/wipe` 缺 confirm 拒绝、bridge 客户端拒绝恶意 host:port。它拦不住的是真机 socket 时序与设备侧行为——改协议语义时仍要拿真实请求把改动的路由打通一遍（含拒绝路径）。
- 改 teardown / 卸载：先读 [docs/deploy.md](https://github.com/OMSociety/dsh-xiaoai-bridge/blob/main/docs/deploy.md) §12.27，再动 `lib/cleanup.js`，跑 `node scripts\check-cleanup.mjs`。只有「`stop()` 成功且占用的端口都释放」时才删 generated；否则保留 `bridge.pid`（`removeGenerated({ keep: [...] })` 是新签名，保留项同时出现在返回值的 `kept` 里）并告警 `keeping generated files in <dataDir> (…); the next start adopts the leftover process`。
- 改 `bridge/` 下任何文件：先读 [bridge/AGENTS.md](./bridge/AGENTS.md)；`bridge/config.py` 是上游模板，必须留在版本库里。
- 改 `bridge/native/src/*.rs`：Rust 扩展要重编译才生效，且**必须先让桥接器停下来**（否则 `.pyd` 被占用，`uv sync` 报 `failed to remove file …open_xiaoai_server.pyd: 拒绝访问 (os error 5)`）——`POST http://127.0.0.1:19387/plugin/xiaoai/bridge/stop`（该路由不要凭据）→ 在 `bridge/` 里 `uv sync` → 确认 `bridge\.venv\Lib\site-packages\open_xiaoai_server\open_xiaoai_server.pyd` 的修改时间就是刚才 → `POST …/bridge/start`。`uv` 不在 PATH，本机在 `C:\Users\Administrator\.local\bin\uv.exe`。
- 改版本号：**先报备用户**（仓库既有纪律，见 [CONTRIBUTING.md](./CONTRIBUTING.md)）。
- 改对外文档：零 emoji、不写 `---`、只写最终状态；架构上的偏离与取舍追加到 `docs/deploy.md` 的 §12.x，不要写进 README 或提交信息。
- 一次改动跨了上面多条（例如既加配置项又改界面）：相关检查**全跑**（配置项 + 界面 = `check-config` + `check-client`），这里只有并集，没有优先级。

## 禁止操作

- 禁止为了「顺手」改 `bridge/README.md`、`bridge/CHANGELOG.md`、`bridge/AGENTS.md` 的既有内容。原因：这三个文件是**基于上游 `coderzc/open-xiaoai-bridge` 原文的 fork 增补版**——上游原文在 `09ef117` 那次改写里被动过（AGENTS.md 72 insertions / 85 deletions，388 行 → 375 行；CHANGELOG.md 12/12，品牌字样原位替换；README.md 108 insertions / 528 deletions），所以"未改"是假的，署名链已经靠那次提交和本文件说明白了。禁改的理由是**避免二次改写**（上游同步时容易冲突、署名容易再次失真），不是"它还是原文"。要改上游行为先读 `bridge/AGENTS.md` 的边界约束，并确认这是插件侧该管的事。
- 禁止把 `bridge/config.py` 移出版本库。原因：它是桥接器模板，`lib/render-config.js` 靠它生成真正生效的配置，删了桥接器起不来（`.gitignore` 里 `bridge/config.py` 那段注释写着这句，约 `:74`）。
- 禁止提交 `bridge/config.py.rendered`、`**/device.json`、`**/devices.json`、`*.token`、`credentials.json`、`bridge/.venv/`、`bridge/core/models/`、`__pycache__`、`.pytest_cache/`。原因：`.gitignore` 末尾那段运行时产物与凭据规则已经挡住（约 `:77-86`），用 `git add -f` 只会把凭据与大文件带进历史。
- 禁止用 `pnpm pack` / `npm publish` 的结果判断包干净不干净。原因：本机实测 pnpm 12.6.0 在 `files` 白名单下产出 753,788,062 字节的 tarball（含 `.venv` 与模型目录），且**不读** `.npmignore`；这条陷阱的取证在 `docs/deploy.md` §12.28.6。
- 禁止把服务名写进 `package.json` 的 `dsh.client.inject`。原因：那里声明的必须是「包依赖边」（先生成的包行），服务依赖由客户端 bundle 导出的 `inject` 决定；写服务名会被**静默忽略**，看起来生效其实没有。
- 禁止手改 `%USERPROFILE%\.dsh\profiles\desktop\node_modules` 里的东西。原因：那是指向本仓库的 `link:` 软链，改那边等于改一份没人维护的副本；装卸一律走 `dsh plugin --profile desktop add|remove`。
- 禁止把提交推到 `upstream`。原因：`upstream` 是 `coderzc/open-xiaoai-bridge`，只用来 `git fetch` 同步上游；我们的提交去 `origin`（`OMSociety` 的 fork）。
- 禁止自行 bump `package.json` 的版本号。原因：版本是用户可见契约，改前先报备。

## 验收标准

改动完成 = 下列全部通过：

1. 九个离线检查全绿：在仓库根跑 `npm run check`（或上面「常用命令」里那九条 `node scripts\check-*.mjs` 逐条跑完），全部 exit 0。
2. 桥接器测试：在 `bridge/` 里跑 `.\.venv\Scripts\python.exe -m pytest -q`，当前基线是 **115 passed, 19 subtests**。基线只许升：数字变大是新增测试，变小说明有测试被删或被跳过，要查清再提交。`bridge/tests/conftest.py` 用 `collect_ignore` 把 `test_tts.py`、`test_tts_latency.py`、`test_tts_stream.py` 三个**手动脚本**排除在 pytest 收集之外：它们模块级就会 `import open_xiaoai_server`、加载真 `config`、连豆包 TTS 甚至让音箱出声，需要真设备与模型，要跑就按文件头单独 `python tests/test_tts.py`。
3. 改了宿主/客户端行为时，重启 DSH 后在真机上核对：插件在 profile 里是 `link:` 指向本仓库，重启即载入当前工作树，不需要重新安装。

仓库**没有 CI**（`bridge/.github/workflows/` 是上游的，管 Docker 与发布，不跑插件侧）；改动只碰文档时，第 1、2 条仍要跑一遍。

本机另有一个未入库的宿主侧端到端冒烟脚本 `plugin-smoke.mjs`（在仓库外的 `D:\WorkSpace\_oxb-wheels\`），覆盖 `/asr` 鉴权、`/config` 冲突与 `POST /data/wipe`。它是有用的端到端冒烟，可以顺手当回归用，但**不在版本库内、不算既有 CI**——别在文档里当既成事实引用。

## 已知风险区

| 路径 | 风险 | 改动前后置动作 |
|---|---|---|
| `lib/client.js` | 手写产物、没有 bundler，语法或席位写错只有运行时才炸 | 改完必跑 `node scripts\check-client.mjs`；可见行为还要按验收标准第 3 条重启后核对 |
| `lib/config.js` | `DEFAULTS` 与 schema 是两处，漂移后设置页显示的值与桥接器实际读到的值不一致；运行时坏值靠 `sanitizeConfig` 逐键回退（只告警一次），静默漂移看不出来 | 两处一起改，跑 `check-config` 与 `check-client` |
| `lib/http.js` | 路由、请求体解析与同源校验错了会直接动到鉴权边界（缺令牌必须 fail-closed），真机 socket 行为离线也测不全 | 跑 `node scripts\check-http.mjs`；协议语义变动再用真实请求打通一遍（含拒绝路径） |
| `lib/exposure.js` | `xiaoai_speak` 与其技能注册到哪一层（音箱会话的 agent 作用域，或逃生门打开时的全局层）；注册错层会让普通会话也看得见工具，或让音箱会话里反而没有工具 | 跑 `node scripts\check-session.mjs`（case 9/9b/10 覆盖作用域注册、无模型选择那一路、exposureState 的降级与逃生门）；宿主没有 scoped `tools`/`skills` 时必须**不注册**并记一条 `scope-registration-unavailable`，绝不偷偷退回全局 |
| `preset/xiaoai/` | 随仓库发布的「小爱模式」预设声明（`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` 里那一条 `preset-xiaoai`）；声明写坏会让预设装上却激活失败（`agent-preset-broken`），`plugins` 清单里误留终端或子代理则等于把语音会话又交回给需要审批的工具 | 改动前读 `docs/deploy.md` §12.36，改完重装（`plugin_manager` 的 `install_bundle`）并跑 `node scripts\check-session.mjs`（case 11a–11f）；宿主没有 `agentPresets` 注册表或 `agentPreset` 留空时**完全不碰注册表** |
| `lib/cleanup.js` | GENERATED/HISTORY 划分错了，会在每次 DSH 关闭时删掉 `spoken.jsonl`（用户明确要留的历史）；teardown 只在「stop 成功且端口都释放」时才删 generated，否则要 `removeGenerated({ keep: ['bridge.pid'] })` | 先读 `docs/deploy.md` §12.27，跑 `check-cleanup` |
| `lib/ports.js` + `bridge/native/src/server.rs` | `4399` 是硬编码的，两边不同步会让「端口仍被占用」的诊断误报或漏报 | 同时改，跑 `check-cleanup`、`check-supervisor` |
| `lib/process.js` | 接管 DSH 异常退出后遗留的桥接器进程（按 pid 文件里的 **pid + 命令行身份**）与 Windows 下的进程树清理；看门狗的重启预算按**滑动崩溃窗口**算（`crashWindowMs`）；改错会留下孤儿进程占着 4399/9092，或把「一天崩一次」误判成崩溃循环 | 跑 `node scripts\check-supervisor.mjs`（九个 case：pid 身份匹配与不匹配、旧版裸数字 pid 文件、接管遗留进程、看门狗退避与放弃、`stop()` 取消排队重启、解释器 spawn 失败、并发 `start()` 只 spawn 一次）；真机验收里核对卸载后无残留 |
| `locale/zh.json`、`locale/en.json` 与 `lib/client.js` | 插件标题/描述在 json 里，其余界面文案在 `client.js` 的两张内联表里，中英 parity 没有工具守着 | 三处一起改 |

## 出错怎么办

| 症状（可检索片段） | 处理 |
|---|---|
| 装 GitHub 版本时报 `no matching ref` | README 的安装命令用的是分支 `#main`——插件的版本从来没有打 tag；要按版本固定就先打 tag 再改那一行 |
| `config render failed: ENOENT` 且路径里有 `config.py.tmp` | 数据目录还没建（`autoStart` 关着，或在临时 `DSH_HOME` 里跑）——不是渲染器坏了 |
| `No module named pytest` | `uv sync` 清掉了 dev 依赖：`uv pip install --python bridge\.venv\Scripts\python.exe pytest` |
| `failed to remove file …open_xiaoai_server.pyd: 拒绝访问 (os error 5)` | 桥接器正在跑，`.pyd` 被占用：先 `POST http://127.0.0.1:19387/plugin/xiaoai/bridge/stop` 再 `uv sync`，装完 `POST …/bridge/start` |
| 改了 `bridge/native/src/*.rs` 但行为没变 | 扩展没重编译：停桥接器后 `uv sync`，核对 `.pyd` 的文件时间戳 |
| `[WARN] Failed to replace env in config: ${NPM_TOKEN}` | `dsh plugin`（pnpm）打印的无关警告，忽略 |
| 卸载后仍有进程或端口没释放 | 读 `docs/deploy.md` §12.27；这条决策由 `check-cleanup` 与 `check-supervisor` 覆盖 |
| 状态卡上出现 `port-held` / `watchdog-gave-up` / `start-failed` / `token-not-applied` | 编码含义见 README 排错表；实时状态看 `GET /plugin/xiaoai/health` 的 `bridgeApi.state` |
| 设置页存了值但行为没变 | 先看日志里有没有 `unusable config repaired with defaults:`——坏值会被逐键回退成默认值，存的不是你写的那份 |

## 维护

本文件与代码同 PR 更新。改动以下内容时必须同步本文件：验收命令（`scripts/check-*.mjs` 的增删）、模块边界与端口、
`.gitignore` 的禁区、profile 的安装方式。发现内容与代码不符时，先改本文件再继续改代码。
`bridge/` 侧的规则在 `bridge/AGENTS.md`，两边冲突时以更接近改动点的那份为准。
