# Changelog

本项目的更改记录在此文件。

All notable changes to this project are documented in this file.

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

本文件记录仓库根目录的 DSH 插件（`dsh-xiaoai-bridge`，版本取 `package.json` 的 `version`，从 `0.1.0` 起）。`bridge/` 下的 Python 桥接器源码来自 [coderzc/open-xiaoai-bridge](https://github.com/coderzc/open-xiaoai-bridge)（MIT），本仓库**独立演进、不跟进上游**。插件版本以清单里的 `version` 为准发布，因此 `0.1.0` 从第一个带上插件骨架的提交算起；插件自己的版本**没有打 tag**——本仓库所有 tag（`v1.0.0` … `v1.0.7`、`baseline`、`vad-kws-asr-models`）都属于上游桥接器。

This file tracks the DSH plugin at the repository root (`dsh-xiaoai-bridge`, versioned by `version` in `package.json`, starting at `0.1.0`). The Python bridge under `bridge/` comes from [coderzc/open-xiaoai-bridge](https://github.com/coderzc/open-xiaoai-bridge) (MIT); this repository evolves independently and does not track upstream. The plugin version is published from `version` in the manifest, so `0.1.0` starts at the first commit that carried the plugin skeleton; the plugin's own releases are **not tagged** — every tag in this repository (`v1.0.0` … `v1.0.7`, `baseline`, `vad-kws-asr-models`) belongs to the upstream bridge.

## [Unreleased]

### 新增

- `README.md`：安装、快速上手、模型工具、设置项、数据位置、排错、卸载与仓库结构。
- `CONTRIBUTING.md`：环境要求、提交前要跑的自检、目录结构与文档约定。
- 设置项 `silentStart`（静默启动，默认关）：开启后桥接器连上音箱时不再播报「已连接」；桥接器侧由 `SILENT_START_ENABLE` 判断（`bridge/native/src/server.rs`）。
- 根级 `AGENTS.md`：给编码 agent 的硬规则（命令、模块边界、禁区、验收），并纳入 `package.json` 的 `files` 白名单。
- 第九个离线检查 `scripts/check-http.mjs`：把真路由挂进临时 `http.Server` 用真请求驱动，覆盖缺令牌 fail-closed 503、错误或缺失 bearer 401、正确 bearer 只投递一次、非 JSON 400、裸 socket 上超限体收到 400 而不是 `ECONNRESET`、跨源 403 且不带 CORS 头、未知路由 404、`/data/wipe` 缺 confirm 拒绝，以及 bridge 客户端拒绝恶意 host:port。
- 设置项 `speakFromAnySession`（任何会话都能让小爱说话，默认关）：关闭时 `xiaoai_speak` 只在音箱发起的会话里可用，电脑或网页的普通对话调用会被拒。
- 随插件发布「小爱模式」Agent 预设（`id: xiaoai`、`order: 5`，写在插件的 `cordis.patch.yml` 里）：音箱那个会话按它组建——会说话，能读写文件、查资料、跑命令，也有待办；没有子代理、计划模式，也没有要点选的界面（终端与待办后来按用户要求补了回来，见「预设补回终端与待办」那条）。配套设置项 `agentPreset`（默认 `xiaoai`，留空用宿主默认）。
- 插件有了自己的图标：包根 `icon.svg`（36×36，对称声波柱），由 `package.json` 顶层 `icon` 字段声明并列入 `files`。插件列表里不再显示 DSH 的默认图形。
- 豆包访问令牌可以直接在设置页填：卡片上多一个密码式输入框与「保存令牌 / 清除」两个动作，凭据名固定在 `doubaoAccessKeyCredential`（默认 `DOUBAO_ACCESS_KEY`，页面不再让人填它）。配套新增插件路由 `GET/POST /plugin/xiaoai/credential/doubao`：GET 只回报「是否已配置 / 是否可写 / 凭据名」而不回报令牌，POST `{value}` 写入、`{clear:true}` 走 `unset` 清除；空值在碰存储之前就被 400 拒掉，只读来源（环境变量等）回 403。令牌不进设置文件、不进草稿、不进日志，卡片上只有「已配置 / 未配置」。
- 回复器的「提供商」与「模型」两个文本框合并成一个模型下拉（`replyerProvider` / `replyerModel` 两个设置键照旧，页面只画一个控件）：选项来自 DSH 的模型目录 `ctx.remote.session.modelCatalog()`（客户端 `inject` 增加 `remote`、`remote.session`，`package.json` 的 `dsh.client.inject` 增加 `@deepseek-ai/dsh-api-remotes`），按 provider 分组，选中值写成「provider/model」；目录加载失败、目录为空、当前值已不在目录里各有提示，「跟随会话默认模型」即把两项留空。

### 变更

- `CHANGELOG.md` 改成中英双语。
- `LICENSE` 追加本仓库的版权行（`OMSociety`），上游版权行原样保留。
- `package.json`：`files` 纳入 `bridge/`；补上客户端实际 require 的 `@deepseek-ai/dsh-client-ui-primitives` peer 依赖。
- 新增 `.npmignore`：发布打包时排除虚拟环境、缓存与模型目录。
- `bridge/native/src/server.rs`：「已连接」播报改为可关闭（改动 Rust 后需重新 `uv sync` 编译原生扩展）。
- `lib/process.js`：子进程环境改由导出的纯函数 `bridgeChildEnv()` 生成，设置项与环境变量的映射从此离线可测（`scripts/check-config.mjs` 有断言）。
- `README.md`：标题改为 `DSH XiaoAI Bridge`；安装命令由不存在的 `#v0.2.8` 改指分支 `#main`；`sessionCwd` 与 `ttsProvider` 两行的说明改成事实。
- 八个离线检查有了聚合入口 `scripts/check-all.mjs`（按序跑完、任一非 0 即整体非 0），`package.json` 的 `check` 改指它并新增 `check:client`；`files` 白名单纳入 `scripts/`（`docs/` 不入包）。
- `package.json`：补上 `repository`、`bugs`、`homepage`、`author` 与 `"private": true`（只挡 `npm publish`，不影响 `dsh plugin add github:…`）。
- `bridge/docker-compose.yml`：顶部加注说明它拉的是不含本 fork bearer 鉴权的上游镜像、不建议用于本插件，正式部署走 `uv sync` 本地运行。
- 更正三份 bridge 文档的对外说法：它们是基于上游原文的 fork 增补版（改写发生在 `09ef117`），不是「上游原文、未改」；指向不存在文件的相对链接改指仓库根。
- `.gitignore`：显式忽略 `.pytest_cache/`；给有意入库的 `bridge/Cargo.lock` 补否定规则与注释，消掉「忽略了却仍被跟踪」的倒挂读法。
- 看门狗的重启预算改成滑动崩溃窗口：`lib/process.js` 的 `stableMs`（活够 60 s 就清零）换成 `crashWindowMs`（默认 60 分钟），窗口内崩溃次数达到 `restartDelaysMs.length` 才放弃；接管遗留进程也改成只认 pid 文件里的 pid + 命令行身份。
- 修复死键：日志级别设置此前被拼成 `LOG_LEVEL`，而桥接器读的是 `LOGLEVEL`（`bridge/core/utils/logger.py`），那个开关一直没生效。
- 文档与代码对齐：README 排错表的诊断码顺序改为与 `lib/diagnostics.js` 的 `DIAGNOSTIC_CODES` 一致；「日志有三处」改为「日志与状态四处」并补 `GET /plugin/xiaoai/bridge/logs`；补上 `autoStart` 关掉时 `ensureStarted()` 直接拒绝的限制。
- 新增诊断码 `token-not-applied`（`warn`）：桥接器先于 API 令牌启动、只能停在 loopback 模式时，`collectFacts()` 记一次并提示重启桥接器。
- `spoken.jsonl` 有了上限：超过 5 MiB 整份轮转到单槽 `spoken.jsonl.1`（历史只保留上一代）；轮转失败只 warn 一次并继续追加；`collectFacts()` 增加 `spokenLogBytes`。
- 配置校验分成两条路：载入路径 `sanitizeConfig()` 逐键回退默认值、只告警一次；设置写入用 `validateConfig()` 严格校验、不合法当场 400；`wakeupTimeout` 必须是 `1`–`600` 的整数。
- teardown 收紧：只有 `stop()` 成功且 `4399` 与 `apiServerPort` 都释放才删 generated，否则保留 `bridge.pid` 并告警；端口探测地址跟着 `apiServerHost` 归一。
- `lib/render-config.js` 的原子替换加上有界重试（`RENAME_ATTEMPTS = 40` / `RENAME_RETRY_MS = 5`，只对 Windows 上会撞进热重载读窗口的 `EPERM` / `EACCES` / `EBUSY` 重试）。
- 文档补两条口径：仓库外的 `plugin-smoke.mjs` 不在版本库内、不算既有 CI；信任域是本机所有本地用户会话。
- `AGENTS.md` 的 pytest 基线从 90 抬到 115，并说明 `bridge/tests/conftest.py` 用 `collect_ignore` 排除三个手动 TTS 脚本。
- 文档写明语音会话的模型限制：会话路由在创建时钉死、本进程内不刷新，切换模型只对回复器即时生效，语音会话要等 DSH 重启。
- 文档写明语音指令的威胁模型：能触达 `POST /asr` 就等于拿到了 agent 输入通道，机械保障只有 bearer 门禁与宿主既有审批流。
- 修复令牌解析不同源：`/asr` 的门禁与桥接器子进程的环境原来各自调 `resolveToken()`，一旦凭据库落进「`describe` 说已配置、`resolve` 却给不出值」的状态，每一句语音都会被 503 拒掉。`lib/index.js` 新增 `currentToken()` 作为唯一入口（supervisor、bridge client、HTTP 层共用），`resolveToken()` 给不出值时退回 `ensureToken()` 刚写入的值；`childEnv()` 区分「没接解析器」与「解析器说没有」；`check-supervisor` 新增 case I 用真子进程断言令牌传递。
- `xiaoai_speak` 增加作用域门禁：`lib/tools.js` 在占用回合之前判断这条会话是不是音箱发起的，未绑定且 `speakFromAnySession` 不为 `true` 时直接返回 `isError`（不播报、不占回合、不写 `spoken.jsonl`）；设置页新增开关，`check-client` 的 Switch 计数 6 → 7。
- 同批修掉复核者提出的三条必修与两条低优先级项：通配 `apiServerHost`（`::`、`0.0.0.0`、`[::]`）不再被客户端按主机名形状拒绝（新增 `dialableHost()`，空串仍拒绝）；收养的桥接器死掉后立刻 start 不再残留 `adoptedPid` / `adoptedWatch`；`check-http` 里那条恒真断言改为断言调用真的成功并补三个通配拼写；Windows 停桥直接 `/T /F`，不再白等 3 秒；`proc.on('exit')` 只在当前子进程仍是这一代时写 `exitCode` / `exitSignal`。
- `xiaoai_speak` 改成按作用域注册，不再进普通会话的工具表：新的 `lib/exposure.js` 在音箱会话的 agent ctx 上注册（`lib/session.js` 新增 `onAgentScope` 钩子）；宿主没有作用域 seam 时什么都不注册并记一条 `scope-registration-unavailable`，只有 `speakFromAnySession` 显式为 `true` 才注册回全局层，并随设置更新实时跟随。
- `sessionKey` 的 fork 默认值由 `agent:main:open-xiaoai-bridge` 改为 `agent:main:dsh-xiaoai-bridge`（`lib/config.js` 与桥接侧四处）。这个字段只喂桥接器（日志前缀、按会话覆盖音色、`/asr` 载荷回显），DSH 侧没有读取者，所以不会丢音箱会话。
- 音箱会话可以挂 Agent 预设：`lib/session.js` 新增 `openPreset()` / `closePreset()` / `bindPreset()`（`resolve` → `acquireScope` 拿 revision 租约 → create 时把 `agentPreset` 写进 header、`setup` 里 `mount`）；`/health` 增加 `preset`，设置页增加 `agentPreset` 与状态卡一行；没装、激活失败或 `mount` 抛错都是软降级（`agent-preset-missing` / `agent-preset-broken` / `agent-preset-mount-failed`），诊断码计数 11 → 14。
- 重写两份 `AGENTS.md`（仓库根与 `bridge/`）：章节按「修改契约 / 禁止操作 / 验收标准 / 已知风险区 / 出错怎么办」重排，删掉会漂的行号锚点改为按符号名检索，去掉本机路径；`bridge/AGENTS.md` 从 375 行压到 131 行（根文件 140 行）。复查后回改了与代码不符的断言（`TTSService` 实为 `TTSRouter`、Rust 播放导出的调用点、设备命令副本、端点清单补 `/bridge/status|health|restart`、`pyproject.toml` 的 `name` 只是分发名、`sanitizeConfig` 告警按坏值集合去重、补 `XIAOAI_DEVICE_NAME` / `XIAOAI_DEVICE_HOST` 与 `uv sync` 会卸载 pytest 的前置）。
- 口径更正：`bridge/` 不再被描述成「基于上游原文的 fork 增补版」——本仓库按自有项目维护、不合并上游改动；`CONTRIBUTING.md` 的「同步上游」改成「与上游的关系」，`README.md`、`.gitignore` 与本文件抬头同步改写。
- 桥接器去品牌化改名：环境变量 `OPEN_XIAOAI_TOKEN` → `DSH_XIAOAI_TOKEN`（`bridge/native/src/server.rs` 读的那个）；PyO3 模块名 `open_xiaoai_server` → `dsh_xiaoai_server`（`Cargo.toml` 的包名与库名、`lib.rs` 的 `#[pymodule]`、20 个 Python 文件的 import 与测试桩）。外部 crate 与设备端路径不变；改完必须停桥接器再 `uv sync` 重编译（`uv sync` 会顺手卸掉 pytest）。
- 新增仓库内 `TODO.md`：发布前待办清单（版本与 CHANGELOG 收口、发布前全绿、push 归用户；可选项；需要用户动手的实机项），不随包发布；`README.md`、`CONTRIBUTING.md` 的目录树与 `AGENTS.md` 的文档索引各加一行指向它。
- 设置页重新排版：配置区从平铺的 7 段改成 7 个可折叠分区，排障项 `bridgeDir` 与 `pythonPath` 收进「桥接器进程」下的「高级」；`FIELDS` 表增加 `show` 门与 `advanced` 标记，字段归属一并整理；折叠用宿主的受控 `DisclosureRow`，联动只改显示（被门挡住的控件仍然渲染、套 `display:none`，草稿与校验提示不丢）；`check-client` 加了忠实的 `DisclosureRow` stub 与「至少 7 个折叠」断言，README 的配置项章节按新分区重排。
- 设置页视觉重做：`lib/client.js` 的内联 style 常量整块换成注入式样式表（`PLUGIN_CSS` + `ensureStyles()`，按 `data-plugin-css` 去重），颜色与圆角全部改取宿主变量，表单几何照抄宿主，删掉 520px 宽度上限，折叠头改传 `icon` 让箭头常显，下拉框改 `appearance: none` 加主题箭头，分隔线统一由一个包装类画，状态卡刷新按钮改用宿主 `Button`；功能、字段归属与联动规则未动。
- 提示词口径统一：本仓库维护、面向模型或用户可见的提示词里的「主人」全部改成「用户」（`DEFAULT_VOICE_RULE_TEXT`、`xiaoai_speak` 的描述、`REPLYER_IDENTITY` / `USER_LABEL`、`bridge/config.py` 的 `exit_prompt` 与两处 `rule_prompt_for_skill`）；回复器人格示例里的「猫娘」改成「鲸鱼娘」。
- 提示词默认值进配置：`personality` / `replyStyle` / `behaviorStyle` 的默认值不再是空串，而是原先只写在代码里的兜底文本（`REPLYER_IDENTITY`、新增导出 `DEFAULT_REPLY_STYLE` 与 `DEFAULT_BEHAVIOR_STYLE`），设置页看得见也能改；`buildReplyerPrompts()` 只在这个人格不等于默认身份句时才追加「关于你自己：…」；`DEFAULT_VOICE_RULE_TEXT` 缩短为通道说明、规则由 `composeVoiceRule()` 追加，渲染产物的默认内容仍是「通道说明 + 规则」两段。示例文案去掉「例如」，长度口径改成「一般 50 字以内，只有确实需要长回复时才展开，最多不超过 300 字」。
- 修掉「归档音箱会话以后音箱不对接任何会话」：宿主的 `ArchivedSessionGate` 会静默拒掉为归档会话提出的每一个模型步，而 `agent.followup()` 又不抛错，于是插件一直往死会话里投递。`lib/session.js` 新增 `isArchived(sessionId)`，在复用或恢复会话之前先查：命中的设备绑定就地退役并在这一句开新会话、记一条 `session-archived-rebound`（诊断码 14 → 15）；旧 handle 不 `dispose()`、也不替用户取消归档；`notePreset()` 随之改名 `noteWarn()`；`check-session` 新增 case 12 / 12b。
- 语音识别后端改成热生效：设置页切了原先不生效（`_ensure_loaded()` 见到已有识别器就返回，而配置文件 watcher 一直在重载配置），旧识别器会一直用到进程重启。`bridge/core/services/audio/asr/sherpa.py` 照 KWS 的做法挂 `ConfigManager.add_reload_listener`，以「后端 + `asr.int8` + `asr.model_dir`」当作载荷签名，签名变了才在后台线程重建；三层防呆是「名字不认识就退回在用的那个」「认识但装不上就继续用旧识别器并把原因记进 `_last_error`、只警告一次」「一个都没装好才抛」；`/api/health` 的 `data.asr` 报 `{requested, known, active, available, error}`，插件据此记 `asr-model-unavailable`（诊断码 15 → 16）。`bridge/tests/test_sherpa_asr_load.py` 新增 12 条（桥接器侧 127 passed, 19 subtests）。
- 语音识别锁定中文、唤醒提示音对准收音起点：SenseVoice 的 `extra_kwargs` 由 `{"language": "auto", "use_itn": True}` 改成 `{"language": "zh", "use_itn": True}`——多语种自动检测在极短音频上会把中文判成日文；不新增 `asr.language` 配置键，也不加设置项。提示音原先在关麦时播放、放完还要等一次设备往返，紧跟提示音开口的头几个字会被截掉；三处入口统一成 `_stop_recording()` → [`_play_tts()`] → `_start_recording()` → `_play_notify()`，提示音结束时麦克风已经在跑，提示音本身按 buffer 时长过 `PlaybackGate`、不会进用户语句。
- 「小爱模式」预设补回终端与待办：根 `cordis.patch.yml` 里 `preset-xiaoai` 那条的 `plugins` 清单新增 `@deepseek-ai/dsh-tool-pwsh`（非 Windows 上是 `@deepseek-ai/dsh-tool-bash`，两行都带 `!!js` 平台门控）、`@deepseek-ai/dsh-tool-jobs` 与 `@deepseek-ai/dsh-tool-todo`。沙箱与审批不在这份清单里（它们在宿主侧，预设里再声明一遍是错的）；仍然不加回子代理与工作流、计划模式、`dsh-tool-ask-user` 与 `dsh-tool-present`。改完要重启 DSH 才会被新会话读到。
- 砍掉从未接线的 MiMo 预留、补全豆包语音合成：`ttsProvider` 的选项改成「跟随音色 / 小爱原生 / 豆包」，四个只存不写的 `mimo*` 占位字段连同名字一并删掉；腾出的位置给豆包六项（`doubaoAppId`、`doubaoAccessKeyCredential`、`doubaoSpeaker`、`doubaoAudioFormat`、`doubaoStream`、`ttsSpeed`）与「豆包语音合成」分区。渲染规则：`tts_provider` 只在真选中时才写，`tts.doubao` 的空字符串字段不写，`stream` 与 `dsh.tts_speed` 是页面独占项、取默认值也照写；凭据只存凭据名，真值由插件从 DSH 凭据库取出后写进子进程环境变量 `DOUBAO_ACCESS_KEY`，桥接器的 `_play_doubao` 先读环境变量、取不到才回退配置。`bridge/tests/test_tts_router.py` 新增三个用例（桥接器侧 127 → 130 passed, 19 subtests）。
- 默认的唤醒词与两句应答改成「肥鱼」一套：`wakeKeywords` 默认 `你好肥鱼`、`wakeupReplyText` 默认 `肥鱼来了`、`exitReplyText` 默认 `肥鱼走了`；`bridge/config.py` 里这两句的兜底值与 `dsh` 段的模板值同步改，桥接器不经插件单独跑时默认一致；README 的配置表与最小可用配置 JSON 跟着改。`exitKeywords` 本来就不含「小爱」，未动；指硬件本身的「小爱音箱」与音箱自带的唤醒词保持原样。
- 「豆包语音合成」分区只在 `ttsProvider` 选「豆包」时显示：`lib/client.js` 的 `SECTIONS` 条目也能带同一个 `show` 门（复用 `gateOpen()`），关上门时整组套 `xiaoai_hidden`——只改显示、不卸载，草稿与校验提示不丢；`GATE_DEFAULTS` 补回 `ttsProvider: ""`（`/config` 还没答之前不预选）。代价：「跟随音色」配上豆包音色 ID 仍会走豆包合成，但那时这一组不显示，只能用桥接器配置里的值。
- 设置页收尾四项（用户原话：「不能不显示或者并入插件配置里吗」「豆包配置选项改名「豆包 TTS」」「豆包配置项无需折叠」「“朗读音色”功能和语音合成方式重复，考虑砍掉“朗读音色”配置项」）。① 「小爱模式」预设并进插件的 bundle：根 `cordis.patch.yml` 的一次 `- insert:` 下两条（插件本体 `id: xiaoai` 与预设 `id: preset-xiaoai`），`preset/` 目录整个删除；预设仍叫 `xiaoai`、`agentPreset` 默认值不变，附带收获是预设从此随包发布，代价是它不再单独可关。② 分区名先改成「豆包 TTS」又按要求改回，最终与改动前逐字一致，没有净变化。③ 豆包那一组不再折叠（`SECTIONS` 新增可选的 `fold: false`，渲染成 `h4` 加 `div`，`FOLD_DEFAULTS` 里的 `doubao` 删掉）。④ 删掉「朗读音色」（`ttsSpeaker`）与它的页面控件：`TTS_PROVIDER_VALUES` 从 `['', 'xiaoai', 'doubao']` 收成 `['xiaoai', 'doubao']`、`DEFAULTS.ttsProvider` 由 `''` 改成 `'xiaoai'`、`buildOverrides()` 不再写 `dsh.tts_speaker` 而总是写 `dsh.tts_provider`；老配置里残留的 `ttsSpeaker` 从此没有任何消费者（`sanitizeConfig()` 是 `{...DEFAULTS, ...config}` 合并、不会删键，但它既不上设置页也不再写进桥接器配置）。桥接器侧一行未改：`tts_speaker` 仍是它自己的配置键，手工改 `bridge/config.py` 仍可走旧规则。
- `bridge/` 下的文档收口：删掉 `bridge/README.md`、`bridge/AGENTS.md`、`bridge/CHANGELOG.md`，把仍然有用且与代码相符的内容并进根 `AGENTS.md`（新增「桥接器（bridge/）」一节，其余小节并集去重）。搬运时按代码更正了 README 的旧说法（`session_key` 两条真实默认值、删掉并不存在的 `openai.tts_provider`、`tts.openai` 与 `tts.mlx_audio` 降级为说明、豆包兜底音色 `zh_female_vv_uranus_bigtts`、端点表补鉴权列），Rust 导出面补上原先漏掉的 `register_fn` / `unregister_fn` 与 `OpusEncoder` / `OpusDecoder`。同时删掉 `bridge/.github/workflows/` 的两份 workflow：仓库根没有 `.github/`，GitHub 只读根目录，这两个文件从来没有运行过。四处免责句按用户要求只删不加，指向被删文档的引用改指新位置，`TODO.md` 里那条「搬来的旧内容有意保留」与 `CHANGELOG.md` 抬头那半句一并删掉。顺带修掉 `bridge/docs/openxiaoai-voice-api.md` 与代码不符的默认值（`/api/wakeup` 的 `silent` 默认 `false`、`/api/play/text` 与 `/api/play/url` 的 `timeout` 是 10 分钟、`/api/health` 的 `status` 目前只会是 `healthy`），`bridge/skills/xiaoai-tts/SKILL.md` 补上 `XIAOAI_API_TOKEN` 与情感列表的正确指针并删掉文件末尾多余的代码围栏，`bridge/skills/xiaoai-tts/scripts/play_file.py` 的 multipart 请求按 `api_client` 的口径带上 `Authorization: Bearer`、401 时追加 `UNAUTHORIZED_HINT`。根 `AGENTS.md` 因此从 140 行涨到 271 行，会触发 `check_agents_md.py` 一条「超过 200 行建议预算」的 info。
- 删掉 `docs/deploy.md`：仓库里不再有独立的实施与验证记录文件，架构上的偏离与取舍从此写进本文件的版本条目（`AGENTS.md` 的修改契约已改指这里）。所有指向它的引用一并清掉（`README.md`、`CONTRIBUTING.md`、`TODO.md`、`cordis.patch.yml` 的注释、`lib/bridge.js`、`lib/cleanup.js`、`lib/index.js`、`scripts/check-config.mjs`），本文件 `Unreleased` 一节里那批冗长的条目同时压缩成摘要。
- 补齐两条此前漏记的改动：`b7b3358` 修掉了几处真机上会犯的问题——`/api/play/text` 串行化（模块级锁加 `MAX_PENDING_PLAYS = 8` 的有界队列，满队列回 503 而不是阻塞）、后台任务改由 `bridge/core/utils/background.py` 持强引用以免中途被回收、`_wait_response_and_release()` 在 `finally` 里清掉本轮的音色登记、配置热重载失败时把上一份模块放回并只 warn 一次、`/api/play/url` 的闸门改成等设备真的停下（原来按估算时长猜），并补上播报队列、后台引用、配置装载与 DSH 记忆四组测试；`c351ff5` 把「`link:` 改动立即生效」写进 `AGENTS.md`（改完重启桥接器管插件清单与环境变量，只有新增工具才需要重启 DSH 并开新会话）。
- 更正 `0.2.6` 里的一句说法：那条写着「桥接器的 TTS 路由遇到不认识的 provider 会直接抛异常」，实际实现是记一条 warning 后回退到按音色判断的 provider（`bridge/core/services/tts/router.py`），播放路径当时就能用；「`ttsProvider` 只在选 `xiaoai` 时写 `dsh.tts_provider`」这一行为本身没有变。
- 凭据读取不再假设只有一种形状：DSH 凭据 seam 声明 `resolve()` 返回 `{value, source}` 记录，而插件原来只接受裸字符串，于是「已配置」的令牌在启动桥接器时被读成空——访问令牌靠 `currentToken()` 的进程内兜底侥幸自洽，豆包令牌则会连 `DOUBAO_ACCESS_KEY` 都拿不到，卡片刚说保存成功、音箱就报缺 Access Key。新增导出的纯函数 `credentialText()`（`lib/process.js`）：字符串与 `{value}` 都取文本，空串、缺 `value`、非字符串一律算没有；`resolveToken()` / `resolveDoubaoKey()` 改走它，子进程环境构建处再兜一次。豆包令牌另加 `currentDoubaoKey()` 的进程内回退（写入成功后记住，`unset` 后丢掉，凭据名变了失效），与访问令牌的 `currentToken()` 同形。
- 豆包凭据的文档口径改成与实现一致：`README.md` 的豆包表格把「豆包访问令牌凭据名」一行换成「豆包访问令牌」（密码框 + 保存 / 清除），「凭据怎么放」一段讲清两枚秘密来源相反（访问令牌填凭据名、豆包令牌直接填值），回复器两行合并成一行下拉。
- `scripts/check-supervisor.mjs` 新增 case M（九种凭据形状）并给 case I 加一条真子进程断言：`resolveDoubaoKey` 返回记录时，`DOUBAO_ACCESS_KEY` 必须是记录里的文本而不是对象。
- 桥接器的播报队列改成有界名额制：`bridge/core/services/api_server.py` 用 `_reserve_play_slot()` / `_release_play_slot()`（上限 `MAX_PENDING_PLAYS`，满了回 503 而不是阻塞）计数，名额的唯一归还点是 `_finalize_play_task()` 的 done 回调——协程可能还没跑第一步就被取消，那时协程体连同 `finally` 根本不执行，名额会永久漏掉，攒满之后所有播报都会被判「队列满」；后台任务经 `_spawn_play_task()` 持强引用并登记进 `_play_tasks`，`cancel_pending_plays()` 让 `POST /api/interrupt` 与原生唤醒打断把还在排队的那几句一起取消；建任务失败时立刻归还名额并回 503。
- 播报期间的原生 ASR 结果只丢弃「回声形状」：`bridge/core/xiaoai.py` 的门禁收窄成 `is_playback_active() and (bool(text) or is_vad_begin is not False)` —— 带文本的回声与监听超时形状一律丢弃，但音箱本机识别到的唤醒（无文本 + `is_vad_begin=False`）照旧放行，用户喊唤醒词仍能打断自己的播报。此前这段判断插在设备原生打断分支之前，播报期的唤醒词会被一起吞掉。`bridge/tests/test_xiaoai_playback_echo.py` 补两条反向用例。
- ASR 装载失败不再终身拒绝：`bridge/core/services/audio/asr/sherpa.py` 把「装不上就再也不试」改成按「后端 + `asr.int8` + `asr.model_dir`」的载荷签名判断、失败后进冷却，`_model_files_ready()` 补齐文件即可重试；唤醒词的暂停与恢复覆盖正常、抛错、被取消三条路径（`bridge/core/wakeup_session.py` 新增 `is_playback_active()`）。`bridge/core/dsh.py` 与 `bridge/core/openai.py` 只在等待方还在时回填 `_response_texts`，不再留下永远没人取的 uuid。
- 4399 端口的鉴权与播放器就绪状态收紧：`bridge/native/src/server.rs` 补 `expected_token()` / `percent_decode()` / `query_token()` / `tokens_match()`，空 `Bearer ` 不再让正确的 `?token=` 失效，单次 accept 失败改成指数退避（上限 6.4 s）而不是每秒刷 10 条日志，令牌为空时启动打醒目告警；`bridge/native/src/lib.rs` 用三态 `PLAYER_STATE`（IDLE / STARTING / READY）加 `PlayerStartGuard` 取代「先置 ready 再发 RPC 且丢结果」的布尔量，`start_play` 往返期间被打断不再留下「Rust 以为就绪、设备其实已经停了」的静音状态；`bridge/native/src/tts/decoder.rs` 的全量重解码搬进 `spawn_blocking`，`bridge/native/src/tts/mod.rs` 对「零音频」流报错（前台与后台孪生都报）。
- 进程留痕与身份判定：`lib/process.js` 新增导出的 `credentialText()`，pid 文件经 `.tmp` 原子改名，日志轮转保留一代 `bridge.log.1`（`lib/cleanup.js` 的 `HISTORY_FILES` 同步），接管遗留进程改成命令行整词匹配（`commandLineRuns()`）加 5 秒身份读取上限（`IDENTITY_TIMEOUT_MS`），身份读不到时报 `verified: false`；teardown 只在 `stop()` 真的失败时保留 `bridge.pid`，`stop()` 已完成但端口仍被占时不再承诺接管。
- 修掉设置页「合并的下拉选了存不进」：`lib/client.js` 的 `buildOps()` 原来跳过所有 `hidden` 条目，而被合并下拉编辑的 `replyerProvider` / `replyerModel` 正是 `hidden`，于是它们永远不产生 op —— 保存按钮不亮、选了也写不进设置。这两个键改用新标记 `render: false`（不画控件但仍参与保存），`hidden` 保持「完全不属于表单」的语义；豆包分区的隐藏令牌行不再让 `specs` 与 `controls` 错位一位；模型下拉的选项值带上显式 `parts`（provider id 含 `/` 时不再切错键）、按值去重、`optgroup` 用序号当 key。`scripts/check-client.mjs` 新增运行时接缝 `exports.__check`，真跑 `buildOps()` 与 `routeChoices()` 并回放一次下拉选择。
- 凭据写入的失败不再一律报「只读」：`lib/index.js` 的 `writeDoubaoKey()` / `clearDoubaoKey()` 先 `describe`，只有 `writable === false` 才回 403 的 `credential is read-only`，其余存储故障回 503 的 `credential write failed`（宿主原文只进日志）。`package.json` 的 `peerDependencies` 补上 `@deepseek-ai/dsh-api-remotes`，与客户端的 `dsh.client.inject` 对齐。

### Added

- `README.md`: installation, quick start, model tool, settings, data locations, troubleshooting, uninstall and repository layout.
- `CONTRIBUTING.md`: environment requirements, the self-checks to run before committing, repository layout and documentation conventions.
- A `silentStart` setting (start silently, off by default): with it on, the bridge no longer speaks "已连接" when it connects to the speaker; the bridge reads `SILENT_START_ENABLE` (`bridge/native/src/server.rs`).
- A root `AGENTS.md`: hard rules for coding agents (commands, module boundaries, forbidden operations, acceptance criteria), added to the `files` allowlist in `package.json`.
- A ninth offline check, `scripts/check-http.mjs`: it mounts the real routes into a throwaway `http.Server` and drives them with real requests, covering fail-closed 503 without a token, 401 for a wrong or missing bearer, exactly-once delivery with the right bearer, 400 for a non-JSON body, 400 (not `ECONNRESET`) for an over-limit body over a raw socket, 403 without CORS headers for a foreign origin, 404 for an unknown route, a refused `/data/wipe` without `confirm`, and the bridge client rejecting a hostile host:port.
- A `speakFromAnySession` setting (let any conversation speak, off by default): with it off, `xiaoai_speak` works only in conversations the speaker started.
- An "小爱模式" (Xiaoai mode) agent preset now ships with the plugin (declaring `id: xiaoai` at `order: 5` in the plugin's `cordis.patch.yml`): the speaker's conversation is composed from it -- it talks, can read and write files, look things up and run commands, and has a to-do list; it has no subagents, no plan mode and nothing that pops up a picker (the terminal and the to-do list were added back at the user's request, see the "preset got its terminal and to-do tools back" entry). A matching `agentPreset` setting (default `xiaoai`, empty means the host default) joins it.
- The plugin now ships its own icon: `icon.svg` at the package root (36×36, symmetric sound-wave bars), declared through the top-level `icon` field in `package.json` and listed in `files`. The plugin list no longer falls back to the default DSH artwork.
- The Doubao access token can be pasted straight into the settings page: the card gained a password-style input plus "save token" / "clear" actions, and the credential name is fixed at `doubaoAccessKeyCredential` (default `DOUBAO_ACCESS_KEY`, no longer an editable field). It comes with a new plugin route, `GET/POST /plugin/xiaoai/credential/doubao`: GET reports only whether the credential is configured, whether it is writable and its ref (never the token), POST `{value}` writes it and `{clear:true}` unsets it; an empty value is answered with 400 before the store is touched and a read-only source (environment variable and the like) with 403. The token never reaches the settings file, a draft or a log, and the card only shows "configured / not configured".
- The reply generator's provider and model text boxes are now a single model dropdown (the two settings keys `replyerProvider` / `replyerModel` stay as they are; only the page control merged): the choices come from DSH's model catalogue through `ctx.remote.session.modelCatalog()` (the client's `inject` gained `remote` and `remote.session`, and `package.json`'s `dsh.client.inject` gained `@deepseek-ai/dsh-api-remotes`), they are grouped by provider, and a choice is written as "provider/model"; a load failure, an empty catalogue and a current value that is no longer in the catalogue each say so, and "follow the session's default model" is what you get by leaving both keys empty.

### Changed

- `CHANGELOG.md` is now bilingual (Chinese first, English below).
- `LICENSE` gains this repository's copyright line (`OMSociety`); the upstream lines are kept as-is.
- `package.json`: `files` now includes `bridge/`; the `@deepseek-ai/dsh-client-ui-primitives` peer dependency the client really requires is declared.
- Added `.npmignore`, so a published tarball leaves out the virtualenv, the caches and the model package.
- `bridge/native/src/server.rs`: the "已连接" prompt can now be turned off (changing Rust means re-running `uv sync`).
- `lib/process.js`: the child environment comes from an exported pure function, `bridgeChildEnv()`, so the settings-to-environment mapping is testable offline (`scripts/check-config.mjs` asserts it).
- `README.md`: the heading is now `DSH XiaoAI Bridge`; the install command points at the `#main` branch instead of the non-existent `#v0.2.8`; the `sessionCwd` and `ttsProvider` rows now state the facts.
- The eight offline checks now have an aggregate entry point, `scripts/check-all.mjs`; `package.json`'s `check` points at it and `check:client` is new; `files` now ships `scripts/` (`docs/` was never shipped).
- `package.json`: added `repository`, `bugs`, `homepage`, `author` and `"private": true` (which only blocks `npm publish`, not installation through `dsh plugin add github:…`).
- `bridge/docker-compose.yml`: a header note states that it pulls the upstream image, which lacks this fork's bearer auth, and should not be used with this plugin; deploy from source with `uv sync` instead.
- Corrected how the three bridge documents are described: they are a fork extension of the upstream text (rewritten in `09ef117`), not untouched upstream files; links that pointed at files that do not exist now point at the repository root.
- `.gitignore`: `.pytest_cache/` is ignored explicitly, and `bridge/Cargo.lock` (deliberately tracked) got a negation rule with a comment.
- The watchdog restart budget is now a rolling crash window: `stableMs` in `lib/process.js` became `crashWindowMs` (60 minutes by default), and the watchdog gives up once the crashes inside the window reach `restartDelaysMs.length`; adopting a leftover bridge also requires the pid plus the command-line identity recorded in the pid file.
- Fixed a dead knob: the log level setting was passed as `LOG_LEVEL`, while the bridge reads `LOGLEVEL` (`bridge/core/utils/logger.py`), so the switch never did anything.
- Docs now match the code: the README troubleshooting table follows `DIAGNOSTIC_CODES` in `lib/diagnostics.js`; "logs live in three places" became four log-and-status endpoints, including `GET /plugin/xiaoai/bridge/logs`; and the README records that `ensureStarted()` refuses outright when `autoStart` is off.
- New diagnostic code `token-not-applied` (`warn`): when the bridge started before the API token existed and is stuck on loopback only, `collectFacts()` records it once and tells you to restart the bridge.
- `spoken.jsonl` now has a cap: past 5 MiB the whole file rotates into the single slot `spoken.jsonl.1` (only the previous generation is kept); a failed rotation warns once and appends anyway; `collectFacts()` gained `spokenLogBytes`.
- Config validation has two paths: loading goes through `sanitizeConfig()`, which falls back per key and warns once; writes are strictly validated by `validateConfig()` and rejected with a 400; `wakeupTimeout` must be an integer between `1` and `600`.
- Teardown is stricter: generated files are deleted only when `stop()` succeeded and both `4399` and `apiServerPort` were released, otherwise `bridge.pid` is kept and a warning is logged; the port probe follows `apiServerHost`.
- The atomic replace in `lib/render-config.js` retries a bounded number of times (`RENAME_ATTEMPTS = 40`, `RENAME_RETRY_MS = 5`), only for the `EPERM` / `EACCES` / `EBUSY` errors Windows can raise inside the hot-reload read window.
- Documented two boundaries: the out-of-tree `plugin-smoke.mjs` is useful but not in the repository and not CI; the trust domain is every local user session on this machine.
- `AGENTS.md`'s pytest baseline moved from 90 to 115, and it now says `bridge/tests/conftest.py` excludes three manual TTS scripts through `collect_ignore`.
- Documented the voice-session model limitation: the session route is pinned at creation and never refreshed in this process, so switching models takes effect immediately for the replyer only.
- Documented the threat model for voice commands: reaching `POST /asr` amounts to holding the agent's input channel, and the only mechanical guarantees are the bearer gate and the host's approval flow.
- Fixed the two sides resolving the token separately: the `/asr` gate and the bridge child's environment each called `resolveToken()`, so a credential store that reports "configured" but resolves to nothing rejected every spoken sentence with a 503. `lib/index.js` gained `currentToken()` as the single entry point (used by the supervisor, the bridge client and the HTTP layer), falling back to the value `ensureToken()` just wrote; `childEnv()` distinguishes "no resolver" from "resolver says none"; `check-supervisor` gained case I, which asserts token propagation with a real child process.
- `xiaoai_speak` gained a scope gate: `lib/tools.js` asks whether the conversation came from the speaker before claiming a turn, and returns `isError` when it is unbound and `speakFromAnySession` is not `true` (no speech, no turn, no `spoken.jsonl` entry); the settings page gained the switch and `check-client`'s Switch count went 6 → 7.
- Fixed the review's three must-fix findings plus two low-priority ones: a wildcard `apiServerHost` (`::`, `0.0.0.0`, `[::]`) is no longer rejected by shape (new `dialableHost()`, an empty string is still refused); a freshly started bridge no longer keeps a stale `adoptedPid` / `adoptedWatch`; a tautological assertion in `check-http` now asserts the call really succeeds and covers the three wildcard spellings; stopping the bridge on Windows goes straight to `/T /F`; and `proc.on('exit')` only writes `exitCode` / `exitSignal` for the current generation.
- `xiaoai_speak` is now registered per scope instead of globally: the new `lib/exposure.js` registers it on the speaker conversation's agent ctx (`lib/session.js` gained the `onAgentScope` hook); with no scoped seam on the host nothing is registered and `scope-registration-unavailable` is recorded, and only an explicit `speakFromAnySession: true` registers it back on the global layer, following the setting live.
- `sessionKey`'s fork default changed from `agent:main:open-xiaoai-bridge` to `agent:main:dsh-xiaoai-bridge` (`lib/config.js` plus four places in the bridge). Only the bridge reads this field (log prefix, per-session voice override, `/asr` payload echo), so no speaker conversation can be lost.
- The speaker's conversation can now be created inside an agent preset: `lib/session.js` gained `openPreset()` / `closePreset()` / `bindPreset()` (`resolve` → `acquireScope` for a revision lease → `agentPreset` in the create header, `mount` in `setup`); `/health` reports `preset` and the settings page gained `agentPreset` plus a status row; a missing preset, a failed activation or a throwing `mount` all degrade softly (`agent-preset-missing` / `agent-preset-broken` / `agent-preset-mount-failed`), and the diagnostic-code count went 11 → 14.
- Rewrote both `AGENTS.md` files (repository root and `bridge/`): sections rearranged around "modification contract / forbidden operations / acceptance criteria / known risks / what to do when it breaks", line-number anchors replaced by symbol lookups, local paths removed; `bridge/AGENTS.md` shrank from 375 to 131 lines (root file: 140). A review pass corrected claims that did not match the code (`TTSService` is really `TTSRouter`, the Rust playback exports have more call sites, the device-command copy, the endpoint list gained `/bridge/status|health|restart`, `pyproject.toml`'s `name` is only a distribution name, `sanitizeConfig` deduplicates warnings by bad-value set, plus the `XIAOAI_DEVICE_NAME` / `XIAOAI_DEVICE_HOST` and `uv sync` uninstalls pytest prerequisites).
- Wording correction: `bridge/` is no longer described as "a fork extension of the upstream text" -- this repository maintains it as its own project and does not merge upstream changes; `CONTRIBUTING.md`'s "Syncing upstream" became "Relationship with upstream", and `README.md`, `.gitignore` and this file's header follow.
- De-branded the bridge: the environment variable `OPEN_XIAOAI_TOKEN` became `DSH_XIAOAI_TOKEN` (the one read in `bridge/native/src/server.rs`); the PyO3 module name `open_xiaoai_server` became `dsh_xiaoai_server` (`Cargo.toml` package and lib names, the `#[pymodule]` in `lib.rs`, 20 Python files' imports and test stubs). External crates and device-side paths are unchanged; the bridge must be stopped before `uv sync` rebuilds (which also uninstalls pytest).
- Added `TODO.md`, a pre-release checklist kept in the repository (version and CHANGELOG wrap-up, all checks green, pushing left to the user; optional items; things the user must do on the device), not published in the package; the trees in `README.md` / `CONTRIBUTING.md` and the doc index in `AGENTS.md` each link to it.
- Rearranged the settings page: the config area went from seven flat sections to seven collapsible ones, with the `bridgeDir` and `pythonPath` troubleshooting fields tucked into an "advanced" fold inside the bridge-process section; the `FIELDS` table gained `show` gates and `advanced` markers, and field ownership was tidied; folding uses the host's controlled `DisclosureRow` and gating only changes visibility (gated controls still render with `display: none`, so drafts and validation messages survive); `check-client` gained a faithful `DisclosureRow` stub and an "at least 7 folds" assertion, and the README's settings chapter follows the new sections.
- Redid the settings page visuals: the inline style constants in `lib/client.js` became an injected stylesheet (`PLUGIN_CSS` plus `ensureStyles()`, deduplicated by `data-plugin-css`), colors and radii now use host variables, form geometry is copied from the host, the 520px width cap is gone, fold headers pass `icon` so the arrow is always visible, the select got `appearance: none` with a themed chevron, separators are drawn by one wrapper class, and the status card's refresh button uses the host `Button`; behavior, field ownership and gating rules are untouched.
- Unified the prompt wording: "主人" is now "用户" in every prompt this repository maintains that reaches the model or the user (`DEFAULT_VOICE_RULE_TEXT`, the `xiaoai_speak` description, `REPLYER_IDENTITY` / `USER_LABEL`, `bridge/config.py`'s `exit_prompt` and both `rule_prompt_for_skill` places); the replyer persona example changed from a catgirl to a whale girl.
- Shipped the prompt defaults in the configuration: `personality` / `replyStyle` / `behaviorStyle` no longer default to empty strings but to the fallback text that used to live only in code (`REPLYER_IDENTITY`, plus the new exports `DEFAULT_REPLY_STYLE` and `DEFAULT_BEHAVIOR_STYLE`), so the settings page shows and edits them; `buildReplyerPrompts()` only appends "关于你自己：…" when the persona differs from the default identity line; `DEFAULT_VOICE_RULE_TEXT` shrank to the channel note and `composeVoiceRule()` appends the rules, keeping the rendered default at "channel note plus rules". The example sentences lost their "例如" prefix and the length rule became "usually within 50 characters, expand only when a long answer is really needed, never more than 300".
- Fixed "the speaker stops talking to any conversation once its session is archived": the host's `ArchivedSessionGate` silently rejects every model step proposed for an archived conversation, and `agent.followup()` does not throw, so the plugin kept delivering into a dead session. `lib/session.js` gained `isArchived(sessionId)`, checked before reusing or resuming: a matching device binding is retired in place, a new conversation is opened for that sentence and `session-archived-rebound` is recorded (diagnostic codes 14 → 15); the old handle is not disposed and the user's archive is not undone; `notePreset()` became `noteWarn()`; `check-session` gained cases 12 / 12b.
- The speech-to-text backend is now hot-swapped: switching it in the settings page used to do nothing (`_ensure_loaded()` returned when a recognizer existed, while the config watcher kept reloading the file), so the old recognizer lived until a process restart. `bridge/core/services/audio/asr/sherpa.py` now attaches a `ConfigManager.add_reload_listener` like KWS does, keyed on "backend + `asr.int8` + `asr.model_dir`", and rebuilds in a background thread only when the signature changes; three fail-safes keep the speaker audible (an unknown name falls back to the one in use, a known but unloadable one keeps the working recognizer, records the reason in `_last_error` and warns once, and only a total failure raises). `/api/health`'s `data.asr` now reports `{requested, known, active, available, error}` and the plugin records `asr-model-unavailable` from it (diagnostic codes 15 → 16). `bridge/tests/test_sherpa_asr_load.py` gained 12 cases (bridge side: 127 passed, 19 subtests).
- Pinned speech recognition to Chinese and made the wake cue the point where listening starts: SenseVoice's `extra_kwargs` went from `{"language": "auto", "use_itn": True}` to `{"language": "zh", "use_itn": True}`, because auto-detection reads very short clips as Japanese; no `asr.language` key and no setting were added. The cue used to play with the microphone closed and one more device round-trip before recording, which clipped the first words spoken right after it; all three entry points now run `_stop_recording()` → [`_play_tts()`] → `_start_recording()` → `_play_notify()`, so the microphone is already running when the cue ends, and the cue itself is held by `PlaybackGate` for its buffer length so it never becomes user speech.
- Gave the "Xiaoai mode" preset its terminal and to-do tools back: `preset-xiaoai`'s `plugins` list in the root `cordis.patch.yml` gained `@deepseek-ai/dsh-tool-pwsh` (or `@deepseek-ai/dsh-tool-bash` off Windows, both behind a `!!js` platform gate), `@deepseek-ai/dsh-tool-jobs` and `@deepseek-ai/dsh-tool-todo`. The sandbox and the approval service stay out of this list (they live on the host side and re-declaring them here would be wrong), and subagents and workflows, plan mode, `dsh-tool-ask-user` and `dsh-tool-present` are still excluded. A DSH restart is needed before new conversations see it.
- Dropped the never-wired MiMo reservation and finished the Doubao speech synthesis settings: `ttsProvider` now offers "follow the voice / native XiaoAi / Doubao", the four write-only `mimo*` fields are gone, and six Doubao fields took their place (`doubaoAppId`, `doubaoAccessKeyCredential`, `doubaoSpeaker`, `doubaoAudioFormat`, `doubaoStream`, `ttsSpeed`) together with their section. Rendering rules: `tts_provider` is written only when really chosen, empty strings inside `tts.doubao` are skipped, and `stream` plus `dsh.tts_speed` are page-owned and always written. Credentials are stored as a name only; the plugin resolves the real value from the DSH credential store into the child's `DOUBAO_ACCESS_KEY`, and `_play_doubao` prefers the environment over the rendered config. `bridge/tests/test_tts_router.py` gained three cases (bridge side: 127 → 130 passed, 19 subtests).
- The default wake word and the two canned replies now use "肥鱼": `wakeKeywords` defaults to `你好肥鱼`, `wakeupReplyText` to `肥鱼来了` and `exitReplyText` to `肥鱼走了`; the fallbacks in `bridge/config.py` and the template values under `dsh` follow, so a standalone bridge has the same defaults; the README's settings table and minimal config JSON follow too. `exitKeywords` never contained "小爱" and is unchanged, and so are the hardware name and the speaker's own wake word.
- The 「豆包语音合成」 group is shown only while `ttsProvider` is Doubao: a `SECTIONS` entry can carry the same `show` gate (reusing `gateOpen()`), and a closed gate puts `xiaoai_hidden` on the whole group -- display only, nothing unmounted, so drafts and validation messages survive; `GATE_DEFAULTS` regained `ttsProvider: ""` so the group does not flash before `/config` answers. The trade-off: "follow the voice" plus a Doubao voice id still synthesizes with Doubao, but the group is hidden then and the bridge config's values apply.
- Four settings-page cleanups, all asked for by the user (「不能不显示或者并入插件配置里吗」「豆包配置选项改名「豆包 TTS」」「豆包配置项无需折叠」「“朗读音色”功能和语音合成方式重复，考虑砍掉“朗读音色”配置项」). ① The 「小爱模式」 preset folded into the plugin's bundle: one `- insert:` in the root `cordis.patch.yml` now carries both entries (the plugin itself as `id: xiaoai` and the preset as `id: preset-xiaoai`) and the `preset/` directory is gone; the preset is still called `xiaoai` and `agentPreset` keeps its default, the preset now really ships with the package, and the price is that it can no longer be turned off on its own. ② The section name was changed to 「豆包 TTS」 and then changed back on request, so it is byte-for-byte what it was: no net change. ③ The Doubao group no longer collapses (`SECTIONS` entries may carry `fold: false`, rendering as `h4` plus `div`, and `doubao` left `FOLD_DEFAULTS`). ④ The 「朗读音色」 setting (`ttsSpeaker`) and its control are gone: `TTS_PROVIDER_VALUES` went from `['', 'xiaoai', 'doubao']` to `['xiaoai', 'doubao']`, `DEFAULTS.ttsProvider` from `''` to `'xiaoai'`, and `buildOverrides()` stopped writing `dsh.tts_speaker` and always writes `dsh.tts_provider`; a leftover `ttsSpeaker` in an old config now has no consumer at all (`sanitizeConfig()` merges `{...DEFAULTS, ...config}` and does not delete keys, but the field is neither rendered nor written to the bridge config any more). The bridge itself was not touched: `tts_speaker` is still its own config key and editing `bridge/config.py` by hand still works.
- Closed out the documentation under `bridge/`: `bridge/README.md`, `bridge/AGENTS.md` and `bridge/CHANGELOG.md` are deleted, and everything still useful and true is merged into the root `AGENTS.md` (a new "桥接器（bridge/）" section plus a deduplicated union of the rest). The README's stale claims were corrected against the code (`session_key`'s two real defaults, the non-existent `openai.tts_provider` removed, `tts.openai` and `tts.mlx_audio` demoted to notes, the Doubao fallback voice `zh_female_vv_uranus_bigtts`, an auth column on the endpoint table), and the Rust export surface gained the missing `register_fn` / `unregister_fn` and `OpusEncoder` / `OpusDecoder`. Both workflows under `bridge/.github/workflows/` are deleted too: the repository root has no `.github/`, GitHub only reads the root, and those two files never ran. The four disclaimer sentences were deleted and not replaced, pointers to the deleted documents were redirected, and the "old content deliberately kept" item in `TODO.md` and the half-sentence in this file's header went with them. Three documentation defects were fixed along the way: the defaults in `bridge/docs/openxiaoai-voice-api.md` that contradicted the code (`/api/wakeup`'s `silent` defaults to `false`, `/api/play/text` and `/api/play/url` wait 10 minutes, `/api/health`'s `status` is only ever `healthy`), plus `XIAOAI_API_TOKEN` and the correct pointer for the emotion list in `bridge/skills/xiaoai-tts/SKILL.md` and a stray code fence at its end, and `bridge/skills/xiaoai-tts/scripts/play_file.py` now sends `Authorization: Bearer` like `api_client` does and adds `UNAUTHORIZED_HINT` on a 401. The root `AGENTS.md` grew from 140 to 271 lines, which makes `check_agents_md.py` report one info about the 200-line suggestion budget.
- Deleted `docs/deploy.md`: the repository no longer keeps a separate implementation and verification log, and architectural deviations and trade-offs now go into this file's version entries (the modification contract in `AGENTS.md` points here). Every reference to it was cleaned up (`README.md`, `CONTRIBUTING.md`, `TODO.md`, the comment in `cordis.patch.yml`, `lib/bridge.js`, `lib/cleanup.js`, `lib/index.js`, `scripts/check-config.mjs`), and the long entries in this file's `Unreleased` section were compressed into summaries.

- Recorded two changes that had been missing from this file: `b7b3358` fixed several things that went wrong on real devices -- `/api/play/text` is now serialised (a module-level lock plus a bounded queue, `MAX_PENDING_PLAYS = 8`, answering 503 instead of blocking when full), background tasks are held by a strong reference in the new `bridge/core/utils/background.py` so they cannot be collected mid-flight, `_wait_response_and_release()` clears the run's voice entries in a `finally`, a failed config hot reload puts the previous module back and warns once, and `/api/play/url`'s gate waits for the device to stop instead of estimating the duration; tests were added for the playback queue, background references, the config loader and DSH memory. `c351ff5` wrote into `AGENTS.md` that a `link:` change takes effect immediately (restart the bridge for the plugin list and environment variables; only a new tool needs a DSH restart and a fresh conversation).
- Corrected a claim in `0.2.6`: it said the bridge's TTS router raises on an unknown provider, while the implementation logs a warning and falls back to the provider inferred from the voice (`bridge/core/services/tts/router.py`), so the playback path worked at the time; the behaviour of writing `dsh.tts_provider` only when `xiaoai` is selected is unchanged.
- Credential reads no longer assume a single shape: DSH's credential seam declares that `resolve()` answers with a `{value, source}` record, while the plugin only accepted a bare string, so a token that really was configured read as empty when the bridge started -- the API token got away with it thanks to `currentToken()`'s in-process fallback, but the Doubao token would not even reach `DOUBAO_ACCESS_KEY` (the card had just said the save succeeded while the speaker reported a missing Access Key). A new exported pure function, `credentialText()` (`lib/process.js`), takes the text out of either a string or a `{value}` record and treats an empty string, a missing `value` and a non-string as nothing; `resolveToken()` and `resolveDoubaoKey()` go through it, and the child-environment build falls back once more. The Doubao token also gained `currentDoubaoKey()`'s in-process fallback (remembered after a successful write, dropped on `unset`, no longer valid once the credential name changes), mirroring `currentToken()`.
- The Doubao credential documentation now matches the implementation: the Doubao table in `README.md` replaced its "Doubao access token credential name" row with "Doubao access token" (a password field plus save / clear), the "how credentials are stored" paragraph explains that the two secrets come from opposite directions (the API token is a credential name whose value the plugin generates, the Doubao token is pasted in directly), and the two reply-generator rows merged into one dropdown row.
- `scripts/check-supervisor.mjs` gained case M (nine credential shapes) and a real child-process assertion in case I: when `resolveDoubaoKey` returns a record, `DOUBAO_ACCESS_KEY` must be the record's text rather than the serialized object.
- The bridge's playback queue is now a bounded slot count: `bridge/core/services/api_server.py` counts with `_reserve_play_slot()` / `_release_play_slot()` (`MAX_PENDING_PLAYS`, answering 503 instead of blocking when full), and the only place that gives a slot back is the done callback in `_finalize_play_task()` -- a coroutine can be cancelled before it runs its first step, in which case its body and `finally` never execute and the slot leaks until every playback is refused as "queue is full". Background tasks are held through `_spawn_play_task()` and registered in `_play_tasks`, so `cancel_pending_plays()` lets `POST /api/interrupt` and a native wakeup cancel the lines still waiting; a failed spawn gives the slot back immediately and answers 503.
- Native ASR results during playback now drop only the echo shape: the gate in `bridge/core/xiaoai.py` narrowed to `is_playback_active() and (bool(text) or is_vad_begin is not False)`, so text echoes and the listening-timeout shape are still discarded, but the wakeup the speaker itself recognises (no text plus `is_vad_begin=False`) passes through and a spoken wake word can still interrupt our own playback. The check used to sit in front of the device's native interrupt branch and swallowed wake words during playback. `bridge/tests/test_xiaoai_playback_echo.py` gained two cases for the other direction.
- A failed ASR load is no longer a life sentence: `bridge/core/services/audio/asr/sherpa.py` keys its retry on the payload signature (backend plus `asr.int8` plus `asr.model_dir`) and cools down instead of refusing forever, and `_model_files_ready()` lets it retry once the files are complete; pausing and resuming the wake word now covers the normal, the raising and the cancelled path (`bridge/core/wakeup_session.py` gained `is_playback_active()`). `bridge/core/dsh.py` and `bridge/core/openai.py` only fill `_response_texts` while a waiter is still there, so a timed-out wait no longer leaves a uuid nobody will ever read.
- The 4399 port tightened its auth and its player readiness: `bridge/native/src/server.rs` gained `expected_token()` / `percent_decode()` / `query_token()` / `tokens_match()`, an empty `Bearer ` no longer disables a correct `?token=`, a failed accept backs off exponentially (capped at 6.4 s) instead of logging ten lines a second forever, and an empty token warns loudly at startup; `bridge/native/src/lib.rs` replaced "set ready, then send the RPC and drop the result" with the three-state `PLAYER_STATE` (IDLE / STARTING / READY) and `PlayerStartGuard`, so an interruption during the `start_play` round trip can no longer leave Rust believing the device is ready while it is silent; `bridge/native/src/tts/decoder.rs` moved the full re-decode into `spawn_blocking` and `bridge/native/src/tts/mod.rs` reports a stream that produced no audio (both the foreground and the background twin).
- Process traces and identity checks: `lib/process.js` exports `credentialText()`, the pid file is renamed atomically through `.tmp`, log rotation keeps one generation (`bridge.log.1`, mirrored in `lib/cleanup.js`'s `HISTORY_FILES`), adopting a leftover bridge now matches the command line word by word (`commandLineRuns()`) under a 5-second identity timeout (`IDENTITY_TIMEOUT_MS`) and reports `verified: false` when the identity cannot be read; teardown keeps `bridge.pid` only when `stop()` really failed, and no longer promises to adopt a port that is still taken after a successful `stop()`.
- Fixed "the merged dropdown cannot be saved": `buildOps()` in `lib/client.js` skipped every `hidden` entry, and the two keys the merged dropdown edits (`replyerProvider` / `replyerModel`) were exactly that, so a pick produced no op at all -- the save button never lit up and the choice never reached the settings. Those two keys now use a new `render: false` flag (no control, still saved) while `hidden` keeps meaning "not part of the form at all"; the hidden token row in the Doubao section no longer shifts `specs` against `controls` by one; the model dropdown's option values carry explicit `parts` (a provider id containing `/` no longer splits the wrong key), are de-duplicated, and its `optgroup`s key on their index. `scripts/check-client.mjs` gained the runtime seam `exports.__check` and now really runs `buildOps()` and `routeChoices()` and replays one dropdown pick.
- A failed credential write no longer always reports "read-only": `writeDoubaoKey()` / `clearDoubaoKey()` in `lib/index.js` describe first, and only `writable === false` answers the 403 `credential is read-only`; any other store failure answers the 503 `credential write failed` (the host's own text goes to the log only). `package.json`'s `peerDependencies` gained `@deepseek-ai/dsh-api-remotes` to match the client's `dsh.client.inject`.

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
