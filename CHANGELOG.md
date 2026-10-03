# Changelog

本项目的更改记录在此文件。

All notable changes to this project are documented in this file.

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

本文件记录仓库根目录的 DSH 插件（`dsh-xiaoai-bridge`，版本取 `package.json` 的 `version`，从 `0.1.0` 起）。`bridge/` 下的 Python 桥接器 fork 自 [coderzc/open-xiaoai-bridge](https://github.com/coderzc/open-xiaoai-bridge)，保留它自己的上游历史、tag（`v1.0.0` … `v1.0.7`）与 [bridge/CHANGELOG.md](bridge/CHANGELOG.md)；上游那半**不是原样搬运**——`bridge/AGENTS.md`、`bridge/README.md`、`bridge/CHANGELOG.md` 在 `09ef117`（`refactor(bridge): drop legacy connectors and wire the DSH backend`）那次改写里被动过（品牌字样原位替换、删掉本 fork 不适用的章节），逐条改动见本文件与 [bridge/CHANGELOG.md](bridge/CHANGELOG.md)。插件版本以清单里的 `version` 为准发布，因此 `0.1.0` 从第一个带上插件骨架的提交算起；插件自己的版本**没有打 tag**——本仓库所有 tag（`v1.0.0` … `v1.0.7`、`baseline`、`vad-kws-asr-models`）都属于上游桥接器。

This file tracks the DSH plugin at the repository root (`dsh-xiaoai-bridge`, versioned by `version` in `package.json`, starting at `0.1.0`). The Python bridge under `bridge/` is forked from [coderzc/open-xiaoai-bridge](https://github.com/coderzc/open-xiaoai-bridge) and keeps its own upstream history, tags (`v1.0.0` … `v1.0.7`) and [bridge/CHANGELOG.md](bridge/CHANGELOG.md); the upstream half is **not** carried verbatim — `bridge/AGENTS.md`, `bridge/README.md` and `bridge/CHANGELOG.md` were rewritten in `09ef117` (`refactor(bridge): drop legacy connectors and wire the DSH backend`), with branding swapped in place and sections that do not apply to this fork removed; the per-file changes are listed here and in [bridge/CHANGELOG.md](bridge/CHANGELOG.md). The plugin version is published from `version` in the manifest, so `0.1.0` starts at the first commit that carried the plugin skeleton; the plugin's own releases are **not tagged** — every tag in this repository (`v1.0.0` … `v1.0.7`, `baseline`, `vad-kws-asr-models`) belongs to the upstream bridge.

## [Unreleased]

### 新增

- `README.md`：安装、快速上手、模型工具、设置项、数据位置、排错、卸载与仓库结构。
- `CONTRIBUTING.md`：环境要求、提交前要跑的自检、目录结构与文档约定。
- 设置项 `silentStart`（静默启动，默认关）：开启后桥接器连上音箱时不再播报「已连接」。桥接器侧由 `SILENT_START_ENABLE` 环境变量判断（`bridge/native/src/server.rs`）。
- 根级 `AGENTS.md`：给编码 agent 的硬规则（命令、模块边界、禁区、验收），并纳入 `package.json` 的 `files` 白名单。
- 第九个离线检查 `scripts/check-http.mjs`：把真路由挂进临时 `http.Server` 用真请求驱动，覆盖缺令牌 fail-closed 503、错误/缺失 bearer 401、正确 bearer 只投递一次、非 JSON 400、裸 socket 上超限体收到 400 而不是 `ECONNRESET`、跨源 403 且不带 CORS 头、未知路由 404、`/data/wipe` 缺 confirm 拒绝，以及 bridge 客户端拒绝恶意 host:port。
- 设置项 `speakFromAnySession`（任何会话都能让小爱说话，默认关）：关闭时 `xiaoai_speak` 只在音箱发起的会话里可用，电脑或网页的普通对话调用会被拒；改动前任何会话都能让小爱说话。

### 变更

- `CHANGELOG.md` 改成中英双语。
- `LICENSE` 追加本 fork 的版权行（`OMSociety`），上游版权行原样保留。
- `package.json`：`files` 纳入 `bridge/`；补上客户端实际 require 的 `@deepseek-ai/dsh-client-ui-primitives` peer 依赖。
- 新增 `.npmignore`：发布打包时排除虚拟环境、缓存与模型目录。
- `bridge/native/src/server.rs`：「已连接」播报改为可关闭（改动 Rust 后需重新 `uv sync` 编译原生扩展）。
- `lib/process.js`：子进程环境改由导出的纯函数 `bridgeChildEnv()` 生成；`scripts/check-config.mjs` 增加对应断言（设置项与环境变量的映射现在离线可测）。
- `README.md`：标题改为 `DSH XiaoAI Bridge`；安装命令由 `#v0.2.8` 改指分支 `#main`（`v0.2.8` 这个 ref 并不存在）；`sessionCwd` 行的默认值说明改为「第一个工作区」，`ttsProvider` 行的取值说明去掉「强制」。
- 八个离线检查有了聚合入口：新增 `scripts/check-all.mjs`（按序跑完八个、任一非 0 即整体非 0），`package.json` 的 `check` 改指它并新增 `check:client`；`files` 白名单纳入 `scripts/`，摘下 `docs/`（它含本机绝对路径与子代理会话 ID，不该随包发布），指向 `docs/deploy.md` 的链接一律改用绝对 GitHub URL。
- `package.json`：补上 `repository`、`bugs`、`homepage`、`author`，以及 `"private": true`（只挡 `npm publish`，不影响 `dsh plugin add github:…` 的安装方式）。
- `bridge/docker-compose.yml`：顶部加注说明它拉的是**不含本 fork bearer 鉴权**的上游镜像、不建议用于本插件，正式部署走 `uv sync` 本地运行；`bridge/README.md` 的 Docker Compose 与 Docker FAQ 两段同步提示。
- 更正 `bridge/AGENTS.md`、`bridge/README.md`、`bridge/CHANGELOG.md` 的对外说法：它们是**基于上游原文的 fork 增补版**（改写发生在 `09ef117`），不是「上游原文、未改」；`bridge/README.md` 里指向不存在文件的 `LICENSE`、`DISCLAIMER.md` 相对链接改指仓库根，上游作者的绝对路径死链改成仓库内相对链接。
- `.gitignore`：显式忽略 `.pytest_cache/`；给「有意入库」的 `bridge/Cargo.lock` 补否定规则与注释，消掉「忽略了却仍被跟踪」的倒挂读法。
- 看门狗的重启预算改成**滑动崩溃窗口**：`lib/process.js` 的 `stableMs`（活够 60 s 就清零）换成 `crashWindowMs`（默认 60 分钟），窗口内崩溃次数达到 `restartDelaysMs.length` 才放弃，日志写成 `the watchdog stopped after N restarts in M minutes`。周期性慢崩不再被当成「健康了一轮」而无休止重试；接管遗留进程也改成只认 pid 文件里的 pid + 命令行身份（不再是裸 pid）。
- 修复死键：日志级别设置此前被拼成 `LOG_LEVEL`，而桥接器读的是 `LOGLEVEL`（`bridge/core/utils/logger.py`），那个开关一直没生效；`lib/process.js` 的 `bridgeChildEnv()` 改用正确的键名，`scripts/check-config.mjs` 加断言。
- 文档与代码对齐：README 排错表的**八个**诊断码顺序改为与 `lib/diagnostics.js` 的 `DIAGNOSTIC_CODES` 一致（当时是八个；后来加了 `token-not-applied` 变成九个，顺序仍以数组为准）；「日志有三处」改为「日志与状态四处」并补上 `GET /plugin/xiaoai/bridge/logs`；补上 `autoStart` 关掉时 `ensureStarted()` 直接拒绝（`bridge is not running (autostart is off)`）的限制；`CONTRIBUTING.md` 的锁文件约定、`docs/deploy.md` 的取证口径与「同序」说法一并改成事实。
- 新增诊断码 `token-not-applied`（`warn`）：桥接器先于 API 令牌启动、只能停在 loopback 模式时，`collectFacts()` 记一次并提示重启桥接器（detail 固定为 `the bridge started before the API token existed; restart the bridge to apply it`）。
- `spoken.jsonl` 有了上限：超过 5 MiB 就整份轮转到**单槽** `spoken.jsonl.1`，所以历史只保留上一代；轮转失败只 warn 一次 `spoken log rotation failed` 并继续追加，不丢记录；`collectFacts()` 增加 `spokenLogBytes`。
- 配置校验分成两条路：载入路径 `configNow()` 走 `sanitizeConfig()` 逐键回退默认值、只告警一次 `unusable config repaired with defaults: …`，设置写入则在 revision 围栏之前用 `validateConfig()` 严格校验、不合法当场回 400；`wakeupTimeout` 必须是 `1`–`600` 的整数。
- teardown 收紧：只有 `stop()` 成功且 4399 与 `apiServerPort` 都释放才删 generated，否则保留 `bridge.pid` 并告警 `the next start adopts the leftover process`（`removeGenerated({ keep: [...] })` 是新签名，保留项同时出现在 `kept` 里）；端口探测地址也跟着 `apiServerHost` 走（`0.0.0.0`、`::` 或空串归一到 `127.0.0.1`）。
- `lib/render-config.js` 的原子替换加上有界重试：`RENAME_ATTEMPTS = 40` / `RENAME_RETRY_MS = 5`，只对 Windows 上会撞进热重载读窗口的 `EPERM`/`EACCES`/`EBUSY` 重试，其它错误立即抛出，失败时清掉半成品 `.tmp` 再 rethrow；`scripts/check-config.mjs` 补三条负路径断言。
- 文档补两条口径：仓库外的 `plugin-smoke.mjs` 是有用的端到端冒烟，但不在版本库内、不算既有 CI；并显式承认信任域是「本机所有本地用户会话」（Windows 上 loopback 整机可达，同机其它用户会话也能打插件路由）。
- `AGENTS.md` 的 pytest 基线从 90 抬到 **115 passed, 19 subtests**，并说明 `bridge/tests/conftest.py` 用 `collect_ignore` 把三个手动 TTS 脚本排除在收集之外（它们要真设备与模型，单独 `python tests/test_tts.py` 跑）。
- 文档写明语音会话的模型限制（R6-6）：会话路由在创建时钉死、本进程内不刷新，所以切换模型只对回复器即时生效，语音会话要等 DSH 重启；这是有意保留的取舍，理由与改法在 `docs/deploy.md` §12.31.7，README 的 `replyerProvider` / `replyerModel` 行同步标注。
- 文档写明语音指令的威胁模型（R3-5）：能触达 `POST /asr` 就等于拿到了 agent 输入通道，机械保障只有 bearer 门禁与宿主既有审批流，没有语音专用工具集、也没有逐句审批策略；收紧危险动作的旋钮在宿主侧的 approval policy，这是架构限制而非缺陷。README 增加「安全边界（限制）」段，展开见 `docs/deploy.md` §12.31.8。
- 修复令牌解析不同源：`/asr` 的门禁（`lib/http.js:536`）与桥接器子进程的环境（`lib/process.js` 的 `childEnv()`）原来各自调 `resolveToken()`，一旦凭据库落进「`describe` 说已配置、`resolve` 却给不出值」的状态，就会出现「门禁要令牌、子进程没令牌」——每一句语音都被 503 拒掉，看起来像音箱坏了。`lib/index.js` 新增 `currentToken()` 作为唯一入口（`:415` 给 supervisor、`:422` 给 bridge client、`:550` 给 HTTP 层）：`resolveToken()` 有值就以它为准（轮换仍生效），给不出时退回 `ensureToken()` 刚写入的值并在宿主进程内记住；三处改的是值、不是键名（这三个使用者读的都是 `resolveToken`）。`lib/process.js` 的 `childEnv()` 现在区分「没接解析器」与「解析器说没有」，前者 warn 一次而不是静默不带令牌启动。`scripts/check-supervisor.mjs` 新增 case I，用真子进程（回报自己的环境）断言「配了令牌就传下去、没配就不继承宿主环境里的同名变量」。展开见 `docs/deploy.md` §12.33.1。
- `xiaoai_speak` 增加作用域门禁：`lib/tools.js` 在占用回合之前用 `sessions.deviceForSession(sessionId)` 判断这条会话是不是音箱发起的，未绑定且 `speakFromAnySession` 不为 `true` 时直接返回 `isError`（不播报、不占回合、不写 `spoken.jsonl`），判真用严格 `!== true`。宿主侧没有「按工具开关」的配置（权限只有 sandbox 与 approval 预设，`tools.restrict`/`tools.guard` 是插件代码 API、`agentPresets` 是插件组合清单），所以逐工具控制落在本插件。设置页「播报」一节新增开关，中英文案与 README 配置表同步，`scripts/check-client.mjs` 的 Switch 计数断言由 6 改为 7。展开见 `docs/deploy.md` §12.34。
- 同批修掉复核者提出的三条必修与两条低优先级项：① `apiServerHost` 为通配填充（`::`、`0.0.0.0`、`[::]`）时客户端不再按「主机名形状」拒绝，`lib/bridge.js` 新增 `dialableHost()` 并由 `resolveTarget()`、`baseUrl()` 与 `lib/index.js` 的 `reportHeldPorts()` 共用（空串仍拒绝）；② 收养的桥接器死掉后立刻 start 不再残留 `adoptedPid`/`adoptedWatch`，避免下一次 5 秒轮询删掉新子进程的 pid 文件、抹掉 `startedAt` 并报一条并不存在的退出；③ `scripts/check-http.mjs` 里「大小写混合主机名」的恒真断言改为断言调用真的成功，并补 `::`/`0.0.0.0`/`[::]` 三个拼写；④ Windows 停桥不再先发一条对 console 子进程无效的 `taskkill`（白等满 3 秒）而直接 `/T /F`；⑤ `proc.on('exit')` 只在当前子进程仍是这一代时写 `exitCode`/`exitSignal`。展开见 `docs/deploy.md` §12.34.5。

### Added

- `README.md`: installation, quick start, model tool, settings, data locations, troubleshooting, uninstall and repository layout.
- `CONTRIBUTING.md`: environment requirements, the self-checks to run before committing, repository layout and documentation conventions.
- A `silentStart` setting (start silently, off by default): with it on, the bridge no longer speaks "已连接" when it connects to the speaker. The bridge reads it from the `SILENT_START_ENABLE` environment variable (`bridge/native/src/server.rs`).
- A root `AGENTS.md`: hard rules for coding agents (commands, module boundaries, forbidden operations, acceptance criteria), added to the `files` allowlist in `package.json`.
- A ninth offline check, `scripts/check-http.mjs`: it mounts the real routes into a throwaway `http.Server` and drives them with real requests, covering fail-closed 503 without a token, 401 for a wrong or missing bearer, exactly-once delivery with the right bearer, 400 for a non-JSON body, 400 (not `ECONNRESET`) for an over-limit body over a raw socket, 403 without CORS headers for a foreign origin, 404 for an unknown route, a refused `/data/wipe` without `confirm`, and the bridge client rejecting a hostile host:port.
- A `speakFromAnySession` setting (let any conversation speak, off by default): with it off, `xiaoai_speak` works only in conversations the speaker started, and a call from a desktop or web chat is refused; before this change any conversation could make the speaker talk.

### Changed

- `CHANGELOG.md` is now bilingual (Chinese first, English below).
- `LICENSE` gains this fork's copyright line (`OMSociety`); the upstream lines are kept as-is.
- `package.json`: `files` now includes `bridge/`; the `@deepseek-ai/dsh-client-ui-primitives` peer dependency the client really requires is declared.
- Added `.npmignore`, so a published tarball leaves out the virtualenv, the caches and the model package.
- `bridge/native/src/server.rs`: the "已连接" prompt can now be turned off (changing Rust means re-running `uv sync` to rebuild the native extension).
- `lib/process.js`: the child environment now comes from an exported pure function, `bridgeChildEnv()`; `scripts/check-config.mjs` asserts the mapping, so settings-to-environment stays testable offline.
- `README.md`: the heading is now `DSH XiaoAI Bridge`; the install command points at the `#main` branch instead of `#v0.2.8` (that ref never existed); the `sessionCwd` row now documents "the first workspace" and the `ttsProvider` row drops "force".
- The eight offline checks now have an aggregate entry point: `scripts/check-all.mjs` runs them in order and fails as a whole if any of them fails, `package.json`'s `check` points at it and `check:client` is new; `files` now ships `scripts/` and no longer ships `docs/` (it contains local absolute paths and subagent session ids), and every link to `docs/deploy.md` uses an absolute GitHub URL.
- `package.json`: added `repository`, `bugs`, `homepage`, `author`, and `"private": true` (which only blocks `npm publish`, not installation through `dsh plugin add github:…`).
- `bridge/docker-compose.yml`: a header note now states that it pulls the upstream image, which lacks this fork's bearer auth, and should not be used with this plugin; deploy from source with `uv sync` instead. The Docker Compose and Docker FAQ sections of `bridge/README.md` carry the same warning.
- Corrected how `bridge/AGENTS.md`, `bridge/README.md` and `bridge/CHANGELOG.md` are described: they are a **fork extension of the upstream text** (rewritten in `09ef117`), not untouched upstream files. The `LICENSE` and `DISCLAIMER.md` links in `bridge/README.md` that pointed at files that do not exist now point at the repository root, and the upstream author's absolute-path link became a relative in-repo link.
- `.gitignore`: `.pytest_cache/` is now ignored explicitly, and `bridge/Cargo.lock` (deliberately tracked) got a negation rule with a comment, so it no longer reads as ignored-yet-tracked.
- The watchdog restart budget is now a **rolling crash window**: `stableMs` in `lib/process.js` (reset the count after 60 s of health) became `crashWindowMs` (60 minutes by default), and the watchdog gives up once the crashes inside the window reach `restartDelaysMs.length`, logging `the watchdog stopped after N restarts in M minutes`. A bridge that dies slowly is no longer treated as healthy, so it cannot retry forever; adopting a leftover bridge now also requires the pid plus the command-line identity recorded in the pid file, not a bare pid.
- Fixed a dead knob: the log level setting was passed as `LOG_LEVEL`, while the bridge reads `LOGLEVEL` (`bridge/core/utils/logger.py`), so the switch never did anything; `bridgeChildEnv()` in `lib/process.js` now uses the correct name and `scripts/check-config.mjs` asserts it.
- Docs now match the code: the README troubleshooting table follows the order of `DIAGNOSTIC_CODES` in `lib/diagnostics.js` (**eight** codes at the time; a later code, `token-not-applied`, made it nine, and the array stays the source of order); "logs live in three places" became four log-and-status endpoints, including `GET /plugin/xiaoai/bridge/logs`; the README records that `ensureStarted()` refuses outright when `autoStart` is off (`bridge is not running (autostart is off)`); and the lockfile convention in `CONTRIBUTING.md` plus the evidence wording and the "same order" claim in `docs/deploy.md` were corrected.
- New diagnostic code `token-not-applied` (`warn`): when the bridge started before the API token existed and is stuck on loopback only, `collectFacts()` records it once and tells you to restart the bridge (the detail is fixed as `the bridge started before the API token existed; restart the bridge to apply it`).
- `spoken.jsonl` now has a cap: past 5 MiB the whole file rotates into the **single** slot `spoken.jsonl.1`, so only the previous generation is kept; a failed rotation warns once (`spoken log rotation failed`) and appends anyway, so nothing is lost; `collectFacts()` gained `spokenLogBytes`.
- Config validation now has two paths: the load path (`configNow()`) repairs bad keys through `sanitizeConfig()`, falling back to defaults with a single `unusable config repaired with defaults: …` warning, while settings writes are checked strictly by `validateConfig()` *before* the revision fence and answered with 400 when unusable; `wakeupTimeout` must be a whole number in `1`–`600`.
- Teardown is stricter: generated files are removed only when `stop()` succeeded and both 4399 and `apiServerPort` were released; otherwise `bridge.pid` is kept and the log warns `the next start adopts the leftover process` (`removeGenerated({ keep: [...] })` is the new signature, and kept entries also show up in `kept`). The held-port probe address follows `apiServerHost` too (`0.0.0.0`, `::` or an empty string all resolve to `127.0.0.1`).
- The atomic replace in `lib/render-config.js` gained a bounded retry: `RENAME_ATTEMPTS = 40` / `RENAME_RETRY_MS = 5`, retrying only the `EPERM`/`EACCES`/`EBUSY` refusals Windows raises when a rename lands inside the bridge's hot-reload read window, rethrowing anything else and clearing the half-written `.tmp` before rethrowing when the retries run out; `scripts/check-config.mjs` gained three negative-path assertions.
- Two wording fixes in the docs: `plugin-smoke.mjs` outside the repository is a useful end-to-end smoke test, but it is not in the repository and not existing CI; and the trust domain is now stated explicitly as "every local user session on this machine" (on Windows a loopback listener is reachable machine-wide, so other local sessions can call the plugin routes too).
- The pytest baseline in `AGENTS.md` moved from 90 to **115 passed, 19 subtests**, and now explains that `bridge/tests/conftest.py` uses `collect_ignore` to keep the three manual TTS scripts out of collection (they need real hardware and models; run them one by one with `python tests/test_tts.py`).
- Documented the voice-session model limitation (R6-6): the session route is pinned when the session is created and never refreshed inside this process, so a model switch only reaches the replyer immediately while the speaker's session waits for a DSH restart. That is a deliberate trade-off; the reasoning and the way to change it are in `docs/deploy.md` §12.31.7, and the `replyerProvider` / `replyerModel` rows in the README carry the same note.
- Documented the threat model for voice commands (R3-5): reaching `POST /asr` amounts to holding the agent's input channel, the only mechanical guarantees being the bearer gate and the host's existing approval flow (there is no voice-only tool set and no per-utterance approval policy); tightening the constraints on dangerous actions is a host-side approval-policy matter, an architectural limit rather than a defect. The README gained a "security boundary (limits)" paragraph and `docs/deploy.md` §12.31.8 carries the details.
- Fixed the two sides resolving the token separately: the `/asr` gate (`lib/http.js:536`) and the bridge child's environment (`childEnv()` in `lib/process.js`) each called `resolveToken()` on their own, so a credential store that answers `describe` ("configured") while `resolve` hands back nothing left the gate demanding a token the child never received — every utterance was refused with a 503 and the speaker simply looked broken. `lib/index.js` gained `currentToken()` as the single entry point (`:415` supervisor, `:422` bridge client, `:550` HTTP layer): a value from `resolveToken()` still wins, so rotation keeps working, and when the store stops answering it falls back to the value `ensureToken()` just stored and holds it for the life of the host process; the three call sites change the value, not the option name (all three consumers read `resolveToken`). `childEnv()` in `lib/process.js` now tells "no resolver was handed over" apart from "the resolver says there is none", warning once in the first case instead of starting silently without a token. `scripts/check-supervisor.mjs` case I runs a real child (which reports its own environment) and asserts both that a configured token is passed down and that a token sitting in the host environment is not inherited. Details in `docs/deploy.md` §12.33.1.
- `xiaoai_speak` gained a scope gate: before claiming a turn, `lib/tools.js` asks `sessions.deviceForSession(sessionId)` whether this conversation came from the speaker, and an unbound session whose `speakFromAnySession` is not exactly `true` gets an `isError` answer instead (nothing spoken, no turn claimed, nothing appended to `spoken.jsonl`). The host has no per-tool switch to configure (permissions are sandbox plus approval presets, `tools.restrict`/`tools.guard` are plugin-code APIs and `agentPresets` is a plugin composition list), so per-tool control lives in this plugin. The settings page gained a switch in the speak section, the Chinese and English labels and the README settings table were updated, and the Switch-count assertion in `scripts/check-client.mjs` moved from 6 to 7. Details in `docs/deploy.md` §12.34.
- Fixed the review's three must-fix findings plus two low-priority ones: (1) a wildcard `apiServerHost` (`::`, `0.0.0.0`, `[::]`) is no longer rejected by the client as a malformed host name -- `lib/bridge.js` gained `dialableHost()`, shared by `resolveTarget()`, `baseUrl()` and `reportHeldPorts()` in `lib/index.js` (an empty value is still refused); (2) a start that replaces an adopted bridge whose death the 5s poll has not seen yet no longer leaves `adoptedPid`/`adoptedWatch` armed, which used to delete the replacement's pid file, wipe `startedAt` and report an exit that never happened; (3) the tautological mixed-case-host assertion in `scripts/check-http.mjs` now asserts a successful call and covers the `::`/`0.0.0.0`/`[::]` spellings; (4) stopping the bridge on Windows no longer sends a `taskkill` that cannot stop a console child and waits out the full 3 seconds, going straight to `/T /F`; (5) `proc.on('exit')` records `exitCode`/`exitSignal` only while the child is still the current generation. Details in `docs/deploy.md` §12.34.5.

## [0.2.8] - 2026-10-03

### 新增

- `POST /plugin/xiaoai/data/wipe`：只有请求体是 `{"confirm":"wipe"}` 时才删除整个桥接器数据目录，其他一律 `400`。
- `lib/ports.js` 探测 loopback 端口；收尾时在停掉桥接器之后检查 `4399` 与 API Server 端口。
- 刚被停掉的监听仍在应答时，状态卡记一条 `port-held`。
- `scripts/check-cleanup.mjs`：覆盖数据目录切分、符号链接守卫，以及对着真实监听端口的探测。

### 变更

- 收尾（插件重载或卸载）只删除可重建的文件（`config.py`、`bridge.pid`、`*.tmp`、`__pycache__`），保留历史（`bridge.log`、`spoken.jsonl`、`devices.json`、`device.json`）；插件不认识的文件只上报、不动。

### Added

- `POST /plugin/xiaoai/data/wipe`: deletes the whole bridge data directory only when the request body is `{"confirm":"wipe"}`; anything else is `400`.
- `lib/ports.js` probes loopback ports; teardown checks `4399` and the API Server port after the bridge has been stopped.
- A listener that was just stopped but still answers records a `port-held` line on the status card.
- `scripts/check-cleanup.mjs`: covers the data directory split, the symlink guard and probing against a real listening port.

### Changed

- Teardown (plugin reload or uninstall) only deletes rebuildable files (`config.py`, `bridge.pid`, `*.tmp`, `__pycache__`) and keeps history (`bridge.log`, `spoken.jsonl`, `devices.json`, `device.json`); files the plugin does not recognise are reported and left alone.

## [0.2.7] - 2026-10-03

### 新增

- `lib/diagnostics.js`：把最近的故障记成「稳定 code + 原始 detail」，重复出现只累加次数。
- `/plugin/xiaoai/health` 实时探测被打印出来的 API Server，并给出 `bridgeApi = {state, url, auth, error, checkedAt}`。
- 设置页「运行状态」显示接口连通状态、鉴权方式、访问令牌是否配置、看门狗（重启次数 / 已放弃 / 下次重试）与最近错误。
- `scripts/check-diagnostics.mjs` 覆盖错误库与失败分类；冒烟测试证明被拒的 `/asr` 真的会落到卡片上。

### 变更

- 桥接器调用分别记为 `bridge-rejected` / `bridge-error` / `bridge-timeout` / `bridge-unreachable`；插件自己的 `/asr` 在收到错误 bearer 令牌时记 `plugin-rejected`。

### Added

- `lib/diagnostics.js`: records recent failures as a stable code plus the raw detail, and only bumps a count when the same failure repeats.
- `/plugin/xiaoai/health` probes the printed API Server live and returns `bridgeApi = {state, url, auth, error, checkedAt}`.
- The settings page shows API reachability, the auth mode, whether an access token is configured, the watchdog (restarts / gave up / next retry) and the most recent errors.
- `scripts/check-diagnostics.mjs` covers the error store and the failure classification; the smoke test proves a rejected `/asr` really lands on the card.

### Changed

- Bridge calls are recorded as `bridge-rejected` / `bridge-error` / `bridge-timeout` / `bridge-unreachable`; the plugin's own `/asr` records `plugin-rejected` when it receives a wrong bearer token.

## [0.2.6] - 2026-10-03

### 新增

- 设置项「语音合成方式」（`ttsProvider`）三个取值：跟随音色（默认）、小爱原生、MiMo。
- 四个 MiMo 占位字段（`mimoBaseUrl`、`mimoApiKeyCredential`、`mimoModel`、`mimoVoice`），形状按 OpenAI 兼容的 `POST /v1/audio/speech` 预留；凭据只存名字，且目前不向桥接器发送任何东西。

### 变更

- 「语音合成方式」只在选 `xiaoai` 时写 `dsh.tts_provider`——桥接器的 TTS 路由遇到不认识的 provider 会直接抛异常，所以 MiMo 只是被记住，播放路径不变。
- `ttsSpeaker` 的错标签「朗读音箱插件」改成「朗读音色」：它是音色 ID（`xiaoai` 为小爱原生，其他为豆包音色 ID）。

### Added

- The "Speech synthesis" setting (`ttsProvider`) with three values: follow the voice (default), XiaoAI native, MiMo.
- Four MiMo placeholder fields (`mimoBaseUrl`, `mimoApiKeyCredential`, `mimoModel`, `mimoVoice`), shaped after the OpenAI-compatible `POST /v1/audio/speech`; the credential stores a name only and nothing is sent to the bridge yet.

### Changed

- "Speech synthesis" writes `dsh.tts_provider` only when `xiaoai` is selected — the bridge's TTS router raises on an unknown provider, so MiMo is only remembered and the playback path is unchanged.
- The wrong `ttsSpeaker` label "Speaking plug-in" became "Reading voice": it is a voice id (`xiaoai` for XiaoAI native, anything else a Doubao voice id).

## [0.2.5] - 2026-10-03

### 新增

- 设置项 `approvalText`（默认 `需要你到电脑上确认一下`）与 `approval/asked` 处理：工具开始等你在屏幕上确认时只念这一句；同一回合的第二次审批保持沉默，审批正文永不出口。
- `scripts/check-speak.mjs` 新增 6 条审批用例。

### Added

- The `approvalText` setting (default `需要你到电脑上确认一下`) and `approval/asked` handling: when a tool starts waiting for you on screen, only that line is spoken; a second approval in the same turn stays silent, and the approval payload is never spoken.
- `scripts/check-speak.mjs` gains six approval cases.

## [0.2.4] - 2026-10-03

### 新增

- 设置项「连续对话」（`continuousConversation`，默认关）与桥接器侧 `keeps_listening()` 钩子：开关关闭时一次唤醒只对应一句，桥接器交完这轮就退出对话模式，且不播退出应答。

### 修复

- `tests/test_playback_gate.py` 不再依赖导入顺序：对在测试替换之前就绑定了 `PlaybackGate` 名字的模块重新绑定。

### Added

- The "Continuous conversation" setting (`continuousConversation`, off by default) and the bridge-side `keeps_listening()` hook: with the switch off one wake word covers one sentence, the bridge leaves conversation mode as soon as the turn is delivered, and it does not play the exit reply.

### Fixed

- `tests/test_playback_gate.py` no longer depends on import order: modules that bound the `PlaybackGate` name before the test replaced it are rebound.

## [0.2.3] - 2026-10-03

### 新增

- 看门狗：桥接器意外退出后按 2 秒、5 秒、15 秒、30 秒递增退避重启，最后放弃并把原因留在状态卡；一次活满一分钟的运行会把退避预算清零。
- `supervisor.ensureStarted()` 与 `speakWithRevive()`：请求根本没到桥接器时，`xiaoai_speak` 顺手把它拉起来；若桥接器答了 HTTP 错误，则上报错误而**不**重启。
- `state()` 增发 `restarts`、`watchdogGaveUp`、`nextRestartAt`。
- `xiaoai-speak` 技能新增「Speaking without being asked」一节。

### 修复

- `session/event` 监听器把设备记录当成设备键字符串用，日志因此打成 `[object Object]`。

### Added

- Watchdog: after an unexpected exit the bridge is restarted with 2s / 5s / 15s / 30s backoff, and the watchdog finally gives up with the reason left on the status card; a run that stays up for a minute resets the budget.
- `supervisor.ensureStarted()` and `speakWithRevive()`: when a request never reaches the bridge, `xiaoai_speak` starts it on the way; an HTTP error answer is reported and **not** restarted.
- `state()` now also returns `restarts`, `watchdogGaveUp` and `nextRestartAt`.
- The `xiaoai-speak` skill gains a "Speaking without being asked" section.

### Fixed

- The `session/event` listener used the device record as if it were the device key string, so the log said `[object Object]`.

## [0.2.2] - 2026-10-03

### 新增

- 桥接器 API Server 的 bearer 鉴权：loopback 调用被信任，其他来源必须带 `Authorization: Bearer <令牌>`；没配置令牌时远端直接 `401`。
- 插件在 DSH 凭据库里准备令牌，通过 `XIAOAI_API_TOKEN` 交给子进程，并在每个桥接器请求上带上它。
- `GET /api/health` 报告鉴权方式；`xiaoai-tts` 技能脚本从 `XIAOAI_API_TOKEN` 或渲染出的 `config.py` 读取令牌，并解释 `401` 的含义。

### Added

- Bearer auth for the bridge API Server: loopback calls are trusted, anything else must send `Authorization: Bearer <token>`; with no token configured remote callers get `401`.
- The plugin provisions the token in the DSH credential store, hands it to the child process through `XIAOAI_API_TOKEN`, and sends it on every bridge request.
- `GET /api/health` reports the auth mode; the `xiaoai-tts` skill script reads the token from `XIAOAI_API_TOKEN` or the rendered `config.py` and explains what a `401` means.

## [0.2.1] - 2026-10-03

### 变更

- 设置页的「会话工作区」改成从 DSH 工作区列表里选，而不再要求填写绝对路径。

### Changed

- The "Session workspace" setting now picks from the DSH workspace list instead of asking for an absolute path.

## [0.2.0] - 2026-10-03

### 新增

- 自动语音播报：本轮的意图交给回复器模型（默认跟随会话模型，可单独覆盖），念出来的话由它生成，每一句都记进 `spoken.jsonl`。
- 把 `model/selection` 转发给桥接器，会话可以跑在自己的模型路由上。
- 设置页重做（分区、重置、逐项提示），会话拿到真实工作目录，标题带上音箱名字。
- 桥接器配置改为按插件设置渲染，并在每次设置写入后热重载。

### 变更

- 半双工：喇叭播放期间麦克风保持关闭，插件不会回答自己。

### 修复

- 已经真正停下的进程不再报告为「正在停止」。
- DSH 轮次使用语音通道的规则提示词。

### Added

- Automatic speech: the turn's intent goes to the replyer model (session model by default, overridable) which writes what is spoken, and every line is recorded in `spoken.jsonl`.
- `model/selection` is forwarded to the bridge so a session can run on its own model route.
- The settings page was rebuilt (sections, reset, per-field hints); sessions get the real working directory and titles carry the speaker name.
- Bridge configuration is rendered from plugin settings and hot-reloaded after every settings write.

### Changed

- Half duplex: the microphone stays closed while the speaker plays, so the plugin never answers itself.

### Fixed

- A process that has really stopped is no longer reported as "stopping".
- DSH turns use the voice channel's rule prompt.

## [0.1.0] - 2026-10-02

### 新增

- 插件骨架：`apply` / `inject`、设置卡片、`GET /plugin/xiaoai/health` 与 `xiaoai-speak` 技能。
- Python 桥接器作为被托管的子进程（启动、停止、重启、日志、pid 文件、收养遗留进程），上面接 `xiaoai_speak` 工具。
- 桥接器的 `POST /api/play/text` 由宿主侧直连桥接器 API 调用（`lib/bridge.js` 的 `playText()`），**没有**走插件自己的 `/plugin/xiaoai` 路由：那些路由只服务状态、配置、语音提交、设备与擦除，且一律只允许同源。

### 变更

- 桥接器只保留 DSH 对话后端：删掉 OpenClaw 与 QwenPaw 连接器，加入 `core/dsh.py` 与 `core/dsh_conversation.py`，DSH 轮次走本地 ASR 路径。

### 修复

- bundle 配置注册到 `plugins.bundle.config`，设置卡片才真的可达。
- 不再收养正在跑旧代码的遗留桥接器；插件会替换它。
- 桥接器会话标题保留音箱名字。

### Added

- Plugin skeleton: `apply` / `inject`, the settings card, `GET /plugin/xiaoai/health` and the `xiaoai-speak` skill.
- The Python bridge as a supervised child process (start, stop, restart, logs, pid file, adopting leftovers), with the `xiaoai_speak` tool on top.
- The bridge's `POST /api/play/text` is called host-side, straight against the bridge API (`playText()` in `lib/bridge.js`); it is **not** proxied through the plugin's own `/plugin/xiaoai` routes, which only serve status, config, speech submission, devices and wipe, and are same-origin only.

### Changed

- The bridge keeps only the DSH conversation backend: the OpenClaw and QwenPaw connectors are gone, `core/dsh.py` and `core/dsh_conversation.py` are in, and DSH turns go through the local ASR path.

### Fixed

- The bundle config registers under `plugins.bundle.config`, so the settings card is actually reachable.
- A leftover bridge running old code is no longer adopted; the plugin replaces it.
- Bridge session titles keep the speaker name.
