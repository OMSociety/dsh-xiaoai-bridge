# Changelog

本项目的更改记录在此文件。

All notable changes to this project are documented in this file.

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-04

### 新增

- 插件本体：唤醒词收音 → DSH 会话 → 回复念回音箱的完整链路；设置页可调唤醒词、退出语、回复器提供商与模型、TTS 提供商与音色、语速、会话工作目录、日志级别等，并带一张运行状态卡与最近的错误码。
- `xiaoai_speak` 工具与播报纪律：模型可以主动开口；音箱发起的对话自动把回复正文念出来；工具卡在审批上时只念一句固定提示，审批请求的正文永远不会被念出来；每句真正念出去的话追加进 `spoken.jsonl`。
- 豆包 TTS 与凭据：Access Token 存在 DSH 凭据仓的固定凭据名 `DOUBAO_ACCESS_KEY` 下，在设置卡片里粘贴保存即可，令牌不进设置文件、不进日志。
- 桥接器：插件托管的本地 Python 子进程，负责设备那侧（TCP 音频、VAD、sherpa-onnx 唤醒词、语音识别、语音合成、播放闸门）与 API Server；Rust 原生侧完成 4399 握手与播放器状态三态；崩溃按滑动窗口重启，插件退出时先停它。
- 随包资产与验收底线：`skills/xiaoai-speak` 技能、音箱会话专用的 Agent 预设、`locale/` 中英文案，以及仓库根的 `npm run check`（九条）与 `bridge/tests/`（pytest）作为提交前底线。

### 变更

- 版本从 `1.0.0` 起算，本文件从这个版本开始记录。
- `xiaoai_speak` 的发言权交还收紧：只有桥接器明确答复（HTTP 非 2xx，如 503/401）才把本回合交还给自动播报；超时、连不上、抛异常都保持占用本回合——宁可这一轮不响，也不冒同一轮播两次的风险。
- 作用域注册（`registerScoped`）与全局逃逸门一样收集 disposer：中途失败会回滚已经注册的那一层，不再留半注册状态。
- 设置卡片的模型列表提示分层：「列表为空」优先于「部分条目读取失败」，只有确实读到部分条目时才说列表可能不完整。

### 修复

- 播放链路：后台播报任务创建失败会释放队列槽位并返回 503；`/api/interrupt` 同时取消排队与在播任务；原生唤醒词在播放期间仍能打断。
- 回复器：流中断（aborted 或超时）时不再丢掉已经生成、且已经说完一句的文本，并把 `degraded` 记进播报记录。
- 配置层：校验覆盖 `DEFAULTS` 的全部 44 个键（原先只有 12 条显式规则，其余键的坏类型会原样进运行时）；空串仍然表示「用内置默认」。
- 暴露层：把「宿主没有 scoped seam」这个事实与告警去重拆成两个闩锁，逃逸门开关不再谎报 seam 是否存在。
- 设置卡片：保存遇到 409 冲突时保留草稿、只换版本号；取回配置失败不再丢已有快照；挂载与刷新按钮在草稿脏时不再悄悄重播表单。
- 桥接器：Rust TTS 拿到空音频流时按错误处理（不再静默成功）；ASR 模型加载与 4399 握手加固（鉴权提示、重试退避、超时可配）。

### Added

- The plugin itself: wake word capture → DSH session → reply spoken back to the speaker, with a settings page for the wake word, the exit phrase, the replyer provider and model, the TTS provider and voice, the speaking rate, the session working directory and the log level, plus a status card with the most recent diagnostic codes.
- The `xiaoai_speak` tool and the speaking discipline: the model can speak on its own; speaker-initiated turns have their reply text spoken automatically; a tool card waiting on approval speaks one fixed line and never the approval text itself; every line that was really spoken is appended to `spoken.jsonl`.
- Doubao TTS and its credential: the access token lives under the fixed DSH credential name `DOUBAO_ACCESS_KEY` and is pasted straight into the settings card, so the token never reaches the settings file or the logs.
- The bridge: a local Python child process hosted by the plugin for the device side (TCP audio, VAD, sherpa-onnx wake word, speech recognition, speech synthesis, playback gate) and its API server; the native Rust side does the 4399 handshake and the tri-state player state; crashes restart on a sliding window and the plugin stops it on exit.
- Shipped assets and the acceptance floor: the `skills/xiaoai-speak` skill, the speaker-session agent preset, the `locale/` Chinese and English copy, and `npm run check` (nine checks) plus `bridge/tests/` (pytest) as the pre-commit floor.

### Changed

- Versions start at `1.0.0`; this file is recorded from this release on.
- Handing the turn back from `xiaoai_speak` is now narrower: only an explicit bridge answer (an HTTP non-2xx status such as 503 or 401) gives the turn back to automatic speaking; timeouts, unreachable bridges and exceptions keep owning the turn — better a silent turn than two spoken lines in one.
- Scoped registration (`registerScoped`) collects disposers like the global hatch does, so a failure halfway unwinds the layer it had already registered instead of leaving it half open.
- The settings card's model-list hint is layered: "the list is empty" wins over "some entries failed to load", and it only says the list may be incomplete when some entries really were read.

### Fixed

- Playback: a background speak task that cannot be created releases its queue slot and returns 503; `/api/interrupt` cancels queued and playing tasks alike; a native wake word can still interrupt playback.
- The replyer: a stream that ends early (aborted or timed out) no longer throws away text that was already generated and already finished a sentence, and `degraded` is recorded with the spoken line.
- Configuration: validation now covers all 44 `DEFAULTS` keys (it used to cover only the 12 keys with explicit rules, so a bad type elsewhere reached the runtime unchanged); an empty string still means "use the built-in default".
- Exposure: "the host has no scoped seam" is now a fact separate from the warning dedupe latch, so opening the hatch no longer claims a seam the host does not have.
- The settings card: a 409 conflict keeps the draft and only refreshes the revision; a failed reload keeps the snapshot it had; mounting and the refresh button no longer silently re-seed the form while the draft is dirty.
- The bridge: the Rust TTS path treats an empty audio stream as an error instead of a silent success; ASR model loading and the 4399 handshake were hardened (authentication hints, retry backoff, configurable timeout).
