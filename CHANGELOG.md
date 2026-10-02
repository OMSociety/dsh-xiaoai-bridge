# Changelog

本项目的更改记录在此文件。

All notable changes to this project are documented in this file.

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

本文件记录仓库根目录的 DSH 插件（`dsh-xiaoai-bridge`，版本取 `package.json` 的 `version`，从 `0.1.0` 起）。`bridge/` 下的 Python 桥接器 fork 自 [coderzc/open-xiaoai-bridge](https://github.com/coderzc/open-xiaoai-bridge)，保留它自己的上游历史、tag（`v1.0.0` … `v1.0.7`）与 [bridge/CHANGELOG.md](bridge/CHANGELOG.md)；上游文件除本文件列出的改动外均原样保留。插件版本以清单里的 `version` 为准发布，因此 `0.1.0` 从第一个带上插件骨架的提交算起；插件自己的版本**没有打 tag**——本仓库所有 tag（`v1.0.0` … `v1.0.7`、`baseline`、`vad-kws-asr-models`）都属于上游桥接器。

This file tracks the DSH plugin at the repository root (`dsh-xiaoai-bridge`, versioned by `version` in `package.json`, starting at `0.1.0`). The Python bridge under `bridge/` is forked from [coderzc/open-xiaoai-bridge](https://github.com/coderzc/open-xiaoai-bridge) and keeps its own upstream history, tags (`v1.0.0` … `v1.0.7`) and [bridge/CHANGELOG.md](bridge/CHANGELOG.md); upstream files are kept as-is apart from the changes listed here. The plugin version is published from `version` in the manifest, so `0.1.0` starts at the first commit that carried the plugin skeleton; the plugin's own releases are **not tagged** — every tag in this repository (`v1.0.0` … `v1.0.7`, `baseline`, `vad-kws-asr-models`) belongs to the upstream bridge.

## [Unreleased]

### 新增

- `README.md`：安装、快速上手、模型工具、设置项、数据位置、排错、卸载与仓库结构。
- `CONTRIBUTING.md`：环境要求、提交前要跑的自检、目录结构与文档约定。

### 变更

- `CHANGELOG.md` 改成中英双语。
- `LICENSE` 追加本 fork 的版权行（`OMSociety`），上游版权行原样保留。
- `package.json`：`files` 纳入 `bridge/`；补上客户端实际 require 的 `@deepseek-ai/dsh-client-ui-primitives` peer 依赖。
- 新增 `.npmignore`：发布打包时排除虚拟环境、缓存与模型目录。

### Added

- `README.md`: installation, quick start, model tool, settings, data locations, troubleshooting, uninstall and repository layout.
- `CONTRIBUTING.md`: environment requirements, the self-checks to run before committing, repository layout and documentation conventions.

### Changed

- `CHANGELOG.md` is now bilingual (Chinese first, English below).
- `LICENSE` gains this fork's copyright line (`OMSociety`); the upstream lines are kept as-is.
- `package.json`: `files` now includes `bridge/`; the `@deepseek-ai/dsh-client-ui-primitives` peer dependency the client really requires is declared.
- Added `.npmignore`, so a published tarball leaves out the virtualenv, the caches and the model package.

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
- 桥接器的 `POST /api/play/text` 可通过插件自己的 `/plugin/xiaoai` 路由访问，这些路由只允许同源。

### 变更

- 桥接器只保留 DSH 对话后端：删掉 OpenClaw 与 QwenPaw 连接器，加入 `core/dsh.py` 与 `core/dsh_conversation.py`，DSH 轮次走本地 ASR 路径。

### 修复

- bundle 配置注册到 `plugins.bundle.config`，设置卡片才真的可达。
- 不再收养正在跑旧代码的遗留桥接器；插件会替换它。
- 桥接器会话标题保留音箱名字。

### Added

- Plugin skeleton: `apply` / `inject`, the settings card, `GET /plugin/xiaoai/health` and the `xiaoai-speak` skill.
- The Python bridge as a supervised child process (start, stop, restart, logs, pid file, adopting leftovers), with the `xiaoai_speak` tool on top.
- The bridge's `POST /api/play/text` is reachable through the plugin's own `/plugin/xiaoai` routes, which are same-origin only.

### Changed

- The bridge keeps only the DSH conversation backend: the OpenClaw and QwenPaw connectors are gone, `core/dsh.py` and `core/dsh_conversation.py` are in, and DSH turns go through the local ASR path.

### Fixed

- The bundle config registers under `plugins.bundle.config`, so the settings card is actually reachable.
- A leftover bridge running old code is no longer adopted; the plugin replaces it.
- Bridge session titles keep the speaker name.
