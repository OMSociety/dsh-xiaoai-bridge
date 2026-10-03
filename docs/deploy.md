# deploy.md — 部署基线与执行断点

本文件是 dsh-xiaoai-bridge 的**部署基线记录**与**可重入断点**。执行任何一步之前先读「进度」一节，
不要在已完成的步骤上重来。

版本：v1（第 1 期验收通过：插件可加载、配置段渲染正确、等第 2 期接线）

---

## 1. 宿主（本机 Windows）

| 项 | 值 |
|---|---|
| DSH 版本 | `0.2.0-rc.2` |
| DSH_HOME | `C:\Users\Administrator\.dsh` |
| DSH_PROFILE | `desktop` |
| DSH_PROFILE_DIR | `C:\Users\Administrator\.dsh\profiles\desktop` |
| DSH_WEB_URL | `http://127.0.0.1:19387` |
| DSH CLI | `D:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` |
| 宿主源码 | `D:\Program Files\DeepSeek Harness\resources\app.asar`（读法见 §5） |
| shell | pwsh |
| node / pnpm | `v24.16.0` / 已装 |
| git | `2.55.0.windows.5`（scoop） |
| 本机 LAN IP | `192.168.1.150`（WLAN） |
| 代理 | Clash，混合端口 `127.0.0.1:7897`；出网前先跑 `pwsh -File ~\.dsh\skills\dsh-env\scripts\clashctl.ps1 ensure` |

## 2. 音箱（小米智能音箱 Pro OH2P）

| 项 | 值 |
|---|---|
| SSH 主机 id | `bc418e05-0ba9-45d2-86d4-deb143a73ea5`（DSH SSH Tunnel 里名为「小爱音箱」） |
| 地址 | `root@192.168.1.191:22`，password 认证，credential=saved |
| 系统 | `Linux OH2P 4.9.61 #1 SMP PREEMPT Tue Mar 11 03:06:03 2025 aarch64 GNU/Linux` |
| 网络 | `wlan0 = 192.168.1.191/24` |
| 存储 | `/data` = `/dev/ubi0_0` 125.8M（可用 116.9M）；`/` = `/dev/mtdblock4` 28.9M，已 100% 满；`/tmp` tmpfs 118.8M |
| 内存 | total 241MB / available 138MB |
| 可用命令 | `curl` `wget` `sha256sum` `md5sum`（**无 openssl**）；`/bin/flash.sh` 存在 |
| 开机服务 | `/etc/init.d/` 下有 `dropbear` `mibrain_service` `mediaplayer` `mico_aivs_lab` 等 |
| 当前状态 | **未安装 open-xiaoai Client**（`/data/open-xiaoai` 不存在）；无进程监听 4399/9092 |

> SSH 首次 `exec` 可能报 `Timed out while waiting for handshake`，用 `session_strategy=new` 重试即可。

### 音箱端客户端（第 0 期 0.10 用）

| 项 | 值 |
|---|---|
| 下载 URL | `https://gitee.com/coderzc/open-xiaoai/releases/download/open-xiaoai-client/client` |
| 本地副本 | `D:\WorkSpace\_oxb-wheels\speaker-client\client` |
| 大小 | `851344` 字节 |
| sha256 | `bcf065e3809913f0dc7708c7487f91e31bc83e27b01f36b914f76fe6825876b5` |
| md5 | `b12ebe6e8289de3adcdba6b5641eb843` |
| 格式 | ELF 32-bit LSB，`e_machine=0x28`（ARM），可直接在音箱上跑，无需交叉编译 |

安装流程（来自上游 client-rust README）：

```sh
mkdir /data/open-xiaoai
echo 'ws://192.168.1.150:4399' > /data/open-xiaoai/server.txt
chmod +x /data/open-xiaoai/client
/data/open-xiaoai/client ws://192.168.1.150:4399
```

开机自启：把上游 `boot.sh` 放到 `/data/init.sh`。

## 3. 上游仓库与基线 tag

| 项 | 值 |
|---|---|
| 上游 | `https://github.com/coderzc/open-xiaoai-bridge`（MIT） |
| 本地 | `D:\WorkSpace\Github\dsh-xiaoai-bridge` |
| 克隆方式 | 完整克隆（**保留上游 157 条提交历史**，不 depth=1） |
| baseline 提交 | `b2d8384b44788a5376aa5eb5c4224ff503f4b746`（2026-09-24，`feat: 添加 OpenAI-compatible TTS / MLX-Audio TTS provider (#28)`） |
| baseline tag | `baseline`，注释 `upstream coderzc/open-xiaoai-bridge @ b2d8384 (pre-fork baseline)` |

## 4. 模型包

| 项 | 值 |
|---|---|
| 来源 | `https://github.com/coderzc/open-xiaoai-bridge/releases/download/vad-kws-asr-models/models.zip` |
| 大小 | `493248891` 字节（约 470MB） |
| 目标位置 | `core/models/`（该目录已被 `.gitignore` 忽略） |
| 解压后需 | `silero_vad.onnx`、`encoder.onnx`、`decoder.onnx`、`joiner.onnx`、`tokens.txt`、`bpe.model`、`sherpa-onnx-sense-voice-*/model.int8.onnx` |

## 5. 读取宿主源码（app.asar）

asar 头部实测结构：

```
offset 0  UInt32LE = 4
offset 4  UInt32LE = 3392056
offset 8  UInt32LE = 3392052
offset 12 UInt32LE = 3392048   ← JSON 索引长度
offset 16 起 = JSON 索引；文件内容起始 = 16 + 3392048 = 3392064
```

工具：`D:\WorkSpace\_oxb-wheels\asar-tool.mjs`

```powershell
node D:\WorkSpace\_oxb-wheels\asar-tool.mjs probe
node D:\WorkSpace\_oxb-wheels\asar-tool.mjs find "ui-settings"
node D:\WorkSpace\_oxb-wheels\asar-tool.mjs extract "dsh/node_modules/@deepseek-ai/dsh-client-ui-settings" "D:\WorkSpace\_oxb-wheels\asar-out"
```

已提取物：`D:\WorkSpace\_oxb-wheels\asar-out\`；核对结论：`D:\WorkSpace\_oxb-wheels\DSH_SETTINGS_API.md`。

## 6. 已核对的宿主契约（0.2.0-rc.2）

设置卡片与设置读写（源码依据：`dsh-settings/lib/types/schema.js`、`dsh-client-ui-settings-plugins`）：

- 设置卡片注册：`ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({name:"settings.plugins.tab", id:"xiaoai", order:40, label:"小爱音箱"}, Tab))`。
- 宿主从插件的 `Config`（schemastery schema）派生可编辑表单：`volatileForm(schema)` →
  先判 `schema.meta.volatile`，再递归 `schema.dict`，最后 `new z(schema.toJSON())` 用**宿主自己那份**
  schemastery 重建。→ 插件携带独立 schemastery 副本是安全的（靠 `toJSON()` 序列化，不做 `instanceof`）。
- 只有「至少一个字段（或其祖先节点）带 volatile 标记」时表单才非空，否则卡片渲染出零字段。
  本插件 `lib/config.js` 的 `live()` 给每个字段都套了 `.volatile()`，因此 14 个字段全部可见。
- 判 volatile 用的是 `@deepseek-ai/cosmokit` 的 `Symbol.for("cosmokit.volatile.write")`（**注册符号，跨副本安全**），
  宿主 `plainConfig()` 靠它解引用；插件侧必须用 `unwrapField()` 自行解引用后才能读值。
- `Config({})` 的返回值不是普通对象，而是 **volatile 引用**（`{get(), [Symbol.for("cosmokit.volatile.write")]}`）。
- `SettingsForms` 只有 `configure/describe/update/replace/mutate/write`，**没有 `register`**；
  `write()` 按 `options.id === ns` 在 `configEditor.entries()` 里找条目，找不到抛
  `No configurable plugin entry "<ns>"`。→ 命名空间就是 `cordis.patch.yml` 里的 `id`，一旦发布不可改。
- 客户端半侧 `lib/client.js` 必须是 `window.__ModuleLoader__.load({ id: <包名>, factory })` 形态，
  末尾 `exports.apply = apply; exports.inject = inject;`。

插件清单与装载（源码依据：`dsh-app-boot/lib/index.js`、`dsh-plugin-manager/lib/types/operations.js`）：

- 兼容闸 `evaluatePluginCompatibility` 只读 `peerDependencies` 里 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`
  这两类名字，用 `semver.satisfies(runtime, range, {includePrerelease:true})` 判定；
  `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`react` 等**不参与判定**。
  失败时该 bundle 在启动阶段被**跳过**（stderr 打 `dsh: skipping profile bundle "<名字>": <原因>`），不是硬崩。
- `dsh.manifestVersion` 与 `engines.dsh` **当前安装器与装载器都不强制**（只做声明）。
- `dsh.bundle.patch` 可以是单个路径，也可以是**有序路径数组**（按序叠加为同一层）。
- `dsh plugin --profile desktop <args>` = 在 profile 目录里跑安装方自带的 pnpm（实测 `v11.7.0`），
  结束后 `reconcile()` 把**新增的、且声明了 `dsh.bundle` 的直接依赖**追加进 `dsh.profile.bundles`；
  没声明 `dsh.bundle` 的只当普通依赖并告警。安装前会先用 `namedSpecManifest` 读盘做一次兼容预检，
  不通过则**不安装**。

## 7. 工具链（第 0 期 0.2–0.5）

| 组件 | 状态 | 落点 |
|---|---|---|
| uv | 已装（`C:\Users\Administrator\.local\bin\uv.exe`，`0.12.17`） | — |
| Python 3.12 | 已装（uv 托管，`3.12.14`） | `C:\Users\Administrator\AppData\Roaming\uv\python\cpython-3.12.14-windows-x86_64-none\` |
| 项目 venv | 已建 | `D:\WorkSpace\Github\dsh-xiaoai-bridge\.venv`（Python 3.12.14） |
| cmake | 已装 `4.4.3`（scoop） | `C:\Users\Administrator\scoop\apps\cmake`；shim 在 `C:\Users\Administrator\scoop\shims` |
| rustup + Rust | 已装 `rustc 1.99.0 (b940084d7 2026-09-28)` / `cargo 1.99.0 (5f94df478 2026-08-27)`，默认 host `x86_64-pc-windows-msvc` | `C:\Users\Administrator\scoop\persist\rustup-msvc\.cargo` `…\.rustup` |
| MSVC Build Tools 2022 | 已装（winget，v17.14.41，workload `Microsoft.VisualStudio.Workload.VCTools`）；MSVC 工具集 `14.44.35207`，Windows SDK `10.0.26100.0`；`link.exe` 在 `…\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\link.exe` | `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools` |

> **编译环境（已验证可用的最小集合）**
> ```powershell
> $env:RUSTUP_HOME = "C:\Users\Administrator\scoop\persist\rustup-msvc\.rustup"   # 见下方坑
> $env:CARGO_HOME  = "C:\Users\Administrator\scoop\persist\rustup-msvc\.cargo"
> $env:PATH = "$env:CARGO_HOME\bin;C:\Users\Administrator\.local\bin;C:\Users\Administrator\scoop\shims;$env:PATH"
> $env:CMAKE_POLICY_VERSION_MINIMUM = "3.5"     # cmake 4.x 兼容 audiopus_sys
> $env:HTTP_PROXY = $env:HTTPS_PROXY = "http://127.0.0.1:7897"   # cargo 拉 open-xiaoai git 依赖
> ```
> **坑**：scoop 的 `rustup-msvc` 只写了用户级 `CARGO_HOME`，**漏写 `RUSTUP_HOME`**，rustup 会去找空的
> `C:\Users\Administrator\.rustup` 并报 `error: rustup could not choose a version of rustc to run, because one
> wasn't specified explicitly, and no default is configured.`（toolchain 其实已装在 persist 目录里）。
> 已用 `[Environment]::SetEnvironmentVariable("RUSTUP_HOME", "<persist>\.rustup", "User")` 持久修复。

## 8. 进度（可重入断点）

- [x] 0.0 记录宿主版本
- [x] 0.1 代理就绪
- [x] 0.2 装 uv（本机已有）
- [x] 0.3 装 Python 3.12（uv 已托管）
- [x] 0.4 装 Rust（scoop `rustup-msvc`，rustc 1.99.0；RUSTUP_HOME 已修复）
- [x] 0.5 装 cmake（4.4.3）+ MSVC Build Tools（14.44.35207 + SDK 10.0.26100.0）
- [x] 0.6 克隆上游并打 `baseline` tag
- [x] 0.7 下载模型包 —— `models.zip` 493,248,891 字节，sha256 `8E8A709D6EA011F644F3C5055F536D5E6EB363EEAFBA53CC3232398FD636D273`；
      解压后置入 `core/models/`（zip 内顶层是 `models/`，需搬到 `core/models/`），zip 已删除
- [x] 0.8 编译 Rust 扩展 —— `uv sync --no-install-project`（37 个包，7m46s）后 `uv sync`（build 6m25s）全部 exit 0；
      产物 `.venv\Lib\site-packages\open_xiaoai_server\open_xiaoai_server.pyd`，
      `import open_xiaoai_server` 成功，导出符号：`OpusDecoder/OpusEncoder/begin_playback_session/decode_audio/
      on_output_data/play_audio_file/register_fn/run_shell/start_playing/start_recording/start_server/stop_playing/
      stop_recording/stop_tts_playback/tts_play/tts_play_background/tts_stream_collect/tts_stream_play/
      tts_stream_play_background/unregister_fn`
- [x] 0.9 上音箱核对 Client 配置（SSH 会话 `2eea39e1-326b-4b4e-9250-8badc9933e8b` 复用成功；
      `/data` 可写 116.9M 可用；`curl/wget/sha256sum/md5sum/aplay/miplayer` 齐全；
      busybox ash **无 `/dev/tcp`、无 `whoami`、无 `nohup`、无 `setsid`**；有 `start-stop-daemon`。
      音箱掉线/`/tmp` 为空的一次现象 = 音箱自己重启过，重连即可）
- [x] 0.10 安装音箱端 Client（见 §2；`/data/open-xiaoai/client`，sha256 与本地副本一致，`chmod +x` 完成；
      `server.txt` = `ws://192.168.1.150:4399`；用 `start-stop-daemon -S -b -m -p /var/run/oxa-client.pid
      -x /data/open-xiaoai/client -- ws://192.168.1.150:4399` 常驻，日志重定向到 `/data/open-xiaoai/client.log`）
- [x] 0.11 跑通桥接器（见 §10「第 0 期验收」）
- [x] 1.0 核对宿主设置表单 API（结论见 §6 与 `DSH_SETTINGS_API.md`）
- [x] 1.1 仓库改造成 `bridge/` 布局（上游代码整体 `git mv`，历史保留；root 只留 DSH 插件面）
- [x] 1.2 `package.json`（照 dsh-better-sidebar 0.2.x 线，peer 天然满足，无需豁免）
- [x] 1.3 `cordis.patch.yml`（`id: xiaoai` / `name: 'dsh-xiaoai-bridge'`）
- [x] 1.4 `lib/config.js`（14 字段，全部 `live()`）
- [x] 1.5 `lib/index.js`（技能注册 + 自检 + HTTP 挂载）
- [x] 1.6 `lib/http.js`（`/plugin/xiaoai/health`、`/config` GET/POST、同源校验）
- [x] 1.7 `lib/client.js` + `scripts/check-client.mjs`（结构自检通过）
- [x] 1.8 注册 `xiaoai-speak` 技能（`resourceBase: {kind:'directory'}`）
- [x] 1.9 装进 desktop profile（见 §11.2；**踩到 pnpm 供应链策略，绕过方式见 §11.3**）
- [x] 1.10 **断点已通过（2026-10-02 22:54，用户重启 DSH 后截图确认）**：
      `插件 → dsh-xiaoai-bridge` 页面在**描述与组件列表之间**渲染出「配置概览」段；
      `GET /plugin/xiaoai/health` → 200、`/plugin/xiaoai/config` → 200、无 `Failed to load plugins`。
      槽位修正过程与正确契约见 §11.6（第一次落在 `settings.plugins.tab`，位置错误）
- [x] 2.0 核实 TTS 耦合点（`TTSRouter.play(...)` 是唯一入口，`SUPPORTED_PROVIDERS` 无后端专属项）
- [x] 2.1 删旧连接器（`xiaozhi.py` / `openclaw*.py` / `qwenpaw*.py` / `services/protocols/{protocol,websocket_protocol}.py`
      / `services/audio/codec.py` + 3 个测试；残留 grep 0 命中，`pytest` 41 passed）
- [x] 2.2 `core/dsh.py`（已存在，本段补 `device_host` 透传）
- [x] 2.3 `core/dsh_conversation.py`（已存在，`_run_one_turn_with_local_asr` 为「提交即返回」变体）
- [x] 2.4 不自动 TTS（播报只由插件的 `xiaoai_speak` 工具触发，天然防重复播报）
- [x] 2.5 `core/app.py`（`enable_dsh` + `DshManager` 生命周期 + `send_to_dsh*` + `set_dsh_session_key`）
- [x] 2.6 `core/wakeup_session.py`（`_dsh_controller` / `_dsh_task` / `_start_dsh_conversation` / 路由 `"dsh"`）
- [x] 2.7 `config.py`（`before_wakeup` 读 `APP_CONFIG["dsh"]["wakeup_keywords"]`，新增完整 `dsh` 段）
- [x] 2.8 `main.py`（`DSH_ENABLE`）—— 另新增启动时重新生成 `core/models/keywords.txt`，见 §12.3
- [x] 2.9 `kws/keywords.py`（`should_generate_keywords()` 只认 `OPENAI_ENABLE` / `DSH_ENABLE`）
- [x] 2.10 `xiaoai_speak` 工具（`ctx.tools.register` 裸 JSON Schema + `POST /api/play/text`）
- [x] 2.11 `/plugin/xiaoai/asr` 路由（唯一带 bearer 鉴权的路由）
- [x] 2.12 会话管理（每台音箱一个会话，`<dataDir>/devices.json`，`agents.resume` 优先）
- [x] 2.13 事件订阅（`ctx.on('session/event', ...)`，只读观察，异常被吞掉不影响 append）
- [x] 2.14 闭环联调 —— **待用户重启 DSH 后实机验证**（说唤醒词 → 说话 → 看会话 → 听播报）
- [x] 2.15 插件托管桥接器进程（计划未排期，作为插入任务实现；`lib/process.js` + `lib/bridge.js`）
- [x] 2.16 修 `meta.cwd`（会话 header 无 `cwd` → `{{cwd}}` 渲染失败 + GUI「历史加载失败」，
      见 §12.9；`sessionCwd()` 四级兜底 + `DEVICE_STORE_VERSION` 1→2 退役旧会话）
- [x] 2.17 设置页重写 + 插件名 i18n（原生表单件 + `{ops,revision}` 写路由 + 包内 `locale/*.json`，
      见 §12.10；待用户重启 DSH 后在插件页确认渲染与保存）
- [x] 3.0 字段→组件映射（新增 `wakeupTimeout` / `ttsSpeaker` / `wakeupReplyText` / `exitReplyText` /
      `exitKeywords` / `fallbackText` / `sessionKey` 七个字段与「应答与兜底」分区；
      `scripts/check-client.mjs` 现在断言 `lib/config.js` 的每个键在客户端都有控件）
- [x] 3.1 设备/会话相关项进入设置页（名称、地址、唤醒词、退出词、会话键、工作区、音色、兜底文本）
- [x] 3.2 全局项（API Server 端口、鉴权凭据名、日志级别 —— 均已在页面上）
- [x] 3.3 凭据托管（`apiServerTokenCredential` 只存**凭据名**、首启动自动签发 token，见 §12.4）
- [x] 3.4 `lib/render-config.js` 渲染 `config.py`（覆盖层 + 临时文件 + `renameSync` 原子替换，见 §12.12）
- [x] 3.5 托管进程传 `CONFIG_PATH=<dataDir>/config.py`（`lib/process.js` 的 `childEnv()`）
- [x] 3.6 热生效单一路径（设置页写入 → 原子替换 → 桥接器 1s 轮询 mtime → `reload_app_config()`）
- [x] 3.7 唤醒词变化 → 重生成 `keywords.txt` 并重建 spotter（`scripts/check-keywords.mjs` 全绿）
- [x] 3.8 降级层一：音箱侧「自定义训练」固定答复（与 DSH 生命周期解耦，仅文档化，见 §12.13）
- [x] 3.9 降级层二：桥接器活着但插件不可达 → 播兜底文本（`dsh.fallback_text`，4 个单测，见 §12.13）
- [x] 3.12 半双工闸门：播报期间不听自己（`core/utils/playback_gate.py` + 7 个调用点 +
      `tests/test_playback_gate.py` 15 条，见 §12.16）
- [ ] 3.10 多设备设计验证（`device_host` 已全链路透传，多台实机验证待用户有第二台音箱）
- [x] 3.11 fork 自加 API Server bearer 鉴权（`core/services/api_auth.py` 的 aiohttp
      中间件；loopback 放行、远端必须带 token、没配 token 时远端 fail closed，
      见 §12.21）
- [x] 3.13 人格提示词 + replyer 模型（三个字段 + 回复器 + 自动接管播报 + `spoken.jsonl` 留痕，
      见 §12.17/§12.18/§12.19；`scripts/check-speak.mjs` 约 40 条断言，**实机待验证**）
- [x] 3.14 会话分组：按工作区登记音箱会话（`attachToWorkspace()`，见 §12.20）；
      `sessionCwd` 改成从宿主已有工作区里选（`workspaceGroups()` + `/health` 的
      `workspaces` facts，不再手输绝对路径）
- [ ] 3.15 实机验收（用户重启 DSH 后）：语音一轮 → 听到口语化播报、`spoken.jsonl` 落一行、
      音箱会话出现在工作区分组里
- [x] 4.1 主动说话 + API Server 常开（`lib/process.js` 的 watchdog：退避重启→放弃、
      `ensureStarted()` 按需拉起；`lib/tools.js` 的 `speakWithRevive()`；见 §12.22；
      `scripts/check-supervisor.mjs` case C–E 与 `scripts/check-speak.mjs`
      的「proactive speech」5 条）
- [x] 4.2 连续对话开关（设置页「连续对话」，默认关闭 = 一句话一次唤醒；
      `lib/render-config.js` 渲染 `dsh.continuous_conversation`；桥接器侧
      `keeps_listening()`；见 §12.23；`tests/test_dsh_single_turn.py` 7 条）
- [x] 4.3 审批提示语（`approval/asked` → 只念「需要你到电脑上确认一下」，
      审批正文永不出口；设置项 `approvalText`；见 §12.24；
      `scripts/check-speak.mjs` 的「approvals」6 条）
- [x] 4.4 MiMo TTS 预留（设置页「语音合成方式」：跟随音色 / 小爱原生 / MiMo（预留）；
      MiMo 四个占位字段只存不写；见 §12.25；`scripts/check-config.mjs` 与
      `scripts/check-client.mjs` 的新断言）
- [x] 4.5 状态卡（`lib/diagnostics.js` 记录最近错误；`/health` 增发实时探测的
      `bridgeApi` 与 `diagnostics`；设置页「运行状态」显示接口连通、鉴权方式、
      令牌是否配置、看门狗重启次数与最近错误；见 §12.26；
      `scripts/check-diagnostics.mjs` 与 `plugin-smoke.mjs` 的新断言）
- [x] 4.6 卸载与回滚（teardown 删除可重建文件、保留 `bridge.log`/`spoken.jsonl`
      等历史、未知文件只上报；`lib/ports.js` 探测 4399/9092 是否真的释放；
      `POST /data/wipe` 用 `{"confirm":"wipe"}` 显式清空；见 §12.27；
      `scripts/check-cleanup.mjs` 的新断言）
- [x] 4.7 README（**单一中文 README.md**，按 github-dev §3.1 与 dsh-fishpai 的写法：
      Hero + 5 枚可点盾牌 + 锚点导航、这是什么 / 核心特性 / 工作原理（Mermaid）/
      快速开始（方式一 clone、方式二 GitHub 装）/ 模型工具 / 配置项 / 数据放在哪 /
      排错 / 开发，底部三节；零 emoji、不写 `---`；见 §12.28）
- [x] 4.8 CHANGELOG（`CHANGELOG.md` 改成 github-dev §3.2 的中英双语：
      标准长式头部、版本标题中英共用、中文分类在上英文分类在下、逐条 1:1 直译；
      见 §12.28）
- [x] 4.9 许可证与署名（`LICENSE` 保留上游 `Del Wang` / `coderzc` 两行并追加
      `Copyright (c) 2026 OMSociety`；README 底部「支持与致谢」「许可证与作者」
      两节点明上游链路；`DISCLAIMER.md` 原样保留；见 §12.28）
- [x] 4.10 合规自查（`package.json` 补 `@deepseek-ai/dsh-client-ui-primitives`
      peer、`files` 纳入 `bridge/` 与三份文档；确认 `pnpm-lock.yaml`、
      `bridge/device.json`、渲染产物与凭据都不入库；见 §12.28）
- [x] 4.11 通读 + 子代理复核（README / CHANGELOG / CONTRIBUTING 十类事实逐条对照源码，
      8 类全对；1 处真问题与 2 处措辞已改、1 条误报经复核后不改；见 §12.28.8）
- [x] 4.12 给编码 agent 的 AGENTS.md（计划外增补：根 `AGENTS.md` 128 行；
      `CONTRIBUTING.md` 加一行指向它、`package.json` 的 `files` 纳入它；见 §12.29）
- [x] 4.13 静默启动（计划外增补：用户实机反馈「连上小爱会播『已连接』提示音，
      希望做成可配置项」；`silentStart` 设置项 → 桥接器读 `SILENT_START_ENABLE`，
      Rust 侧 `bridge/native/src/server.rs` 改写 + `lib/process.js` 抽出
      `bridgeChildEnv()`；见 §12.30）
- [x] 4.13-1 文档与打包收口（计划外增补：`check-all.mjs` 聚合入口、死键
      `LOG_LEVEL` → `LOGLEVEL`、文档改认符号名、Windows 上 `config.py` 原子替换
      撞热重载读窗口；见 §12.31）
- [x] 4.13-2 实现与文档的第二轮收口（新诊断码 `token-not-applied`、`spoken.jsonl`
      单槽轮转、配置的两条校验路径、teardown 收紧、端口探测跟 `apiServerHost`、
      第九个检查 `check-http.mjs`；见 §12.32）
- [x] 4.13-3 令牌单源（`lib/index.js` 的 `currentToken()` 成为唯一取令牌入口，
      子进程环境与 `/asr` 门禁必然同源；见 §12.33）
- [x] 4.13-4 播报的作用域门禁（`xiaoai_speak` 默认只在音箱会话里可用，
      逃生门 `speakFromAnySession`；见 §12.34）
- [x] 4.13-5 工具按作用域注册（宿主没有 scoped seam 时**不注册也不退回全局**，
      记一条 `scope-registration-unavailable`；见 §12.35）
- [x] 4.13-6 「小爱模式」Agent 预设（`preset/xiaoai/` bundle + 插件侧挂载与软降级；
      见 §12.36）
- [x] 4.14 两份 AGENTS.md 重写 + 桥接器去品牌化改名（口径改为「不追上游」；
      `OPEN_XIAOAI_TOKEN` → `DSH_XIAOAI_TOKEN`、`open_xiaoai_server` →
      `dsh_xiaoai_server`；见 §12.37）
- [x] 4.15 发布前清单与小尾巴（新增仓库内 `TODO.md`；本清单回填 4.13 各批与 4.14；
      §12.33 补父标题；见 §12.38）
- [x] 4.16 设置页重新排版（7 个可折叠分区 + 「高级」折叠 + 联动显隐；
      隐藏而不是卸载，草稿不丢；见 §12.39）
- [x] 4.17 设置页按官方插件的写法重做视觉（改用宿主 `DisclosureRow` 的折叠行几何、
      注入式样式表 + `--dsw-*` 主题变量、控件几何对齐宿主字段；见 §12.40）
- [x] 4.18 提示词口径统一（「主人」→「用户」、回复器人格示例改成「鲸鱼娘」，
      含 `bridge/config.py` 模板里的默认值；见 §12.41）
- [x] 4.19 提示词默认值进配置（`personality` / `replyStyle` / `behaviorStyle`
      三格从空串改成代码里原本兜底的文本，设置页看得见也能改；语音规则拆成
      「通道说明 + 行动准则」；并随用户当天追加的口径收短为「一般 50 字以内、
      长回复最多 300 字」，设置页说明去掉「例如」；见 §12.42、§12.42.7）
- [x] 4.20 归档会话自动重开（DSH 只有归档、没有删除，而宿主的 archived-session-gate
      会静默拒掉归档会话的每一个模型步，于是音箱看起来「谁也不连」；插件在复用前
      先查归档，命中就换新会话并记一条 `session-archived-rebound`；见 §12.43）

## 9. 第 1 期实现决策

- **不引入打包器**：`lib/client.js` 手写为 `window.__ModuleLoader__.load({id, factory})` 形态，
  内部**只** `require("react")` 与 `require("react/jsx-runtime")`，不 require 任何 UI 包
  （当时的想法是把 UI 原语耦合降到零、白屏面最小；4.16 的排版改版后改成 require `@deepseek-ai/dsh-client-ui-primitives` 里的 `DisclosureRow` 等原语，见 §12.39）。依赖清单写在 `package.json` 的 `dsh.client.inject`。
  与官方构建产物形态一致，省掉 tsc + tsdown；正确性由 `scripts/check-client.mjs` 兜底
  （在 `node:vm` 沙箱里加载 bundle、断言 module id/导出/页签注册/首帧渲染）。
- 插件走 0.2.x peer 线：`@deepseek-ai/cordis ^4.0.4` + `@deepseek-ai/dsh-* ^0.2.0-rc.1`，
  该区间天然满足运行时 `0.2.0-rc.2`，**不需要** `dsh plugin allow-version` 豁免。
- **唯一外部运行时依赖是 `@deepseek-ai/schemastery`**。`@deepseek-ai/dsh-settings` 等宿主内部包
  **不能 import**：它们不在 profile 的 `node_modules` 里（由 app.asar 提供），插件副本里的
  `instanceof` 会因类对象不同而失效。冲突判定因此改为结构化（比 `err.name`/`constructor.name`）。
- 第 1 期**只注册技能，不注册工具**：`xiaoai_speak` 到第 2 期才能真正说话，提前注册一个必然失败的工具
  会误导模型。这是对计划 §五 1.5 的显式收窄。

---

## 10. 第 0 期验收（0.11 跑通桥接器）

### 10.1 已验证可用的启动方式

```powershell
$env:PATH = "C:\Users\Administrator\.local\bin;$env:PATH"     # uv
$env:PYTHONUTF8      = "1"      # 必须，见 10.2 坑二
$env:PYTHONIOENCODING = "utf-8" # 同上的加强
# 可选：$env:API_SERVER_ENABLE = "1"   → 开 127.0.0.1:9092
Set-Location D:\WorkSpace\Github\dsh-xiaoai-bridge
uv run --no-sync python -u main.py
```

启动成功日志（实测）：

```
[Main] 模块启用情况: ...
[XiaoAI] 启动小爱音箱服务...
（ASCII banner 正常打印）
[APIServer] HTTP server started at http://127.0.0.1:9092
[AppServer] ✅ 已启动: "0.0.0.0:4399"
[AppServer] ✅ 已连接: 192.168.1.191:40114
```

音箱端 client 具备**断线自动重连**（重启桥接器后它自己重新连上，端口号改变）。

### 10.2 第 0 期发现的两个致命坑

**坑一：scoop `rustup-msvc` 漏设 `RUSTUP_HOME`** —— 见 §7。

**坑二（上游 Windows 致命 bug，必须每处都规避）：`core/xiaoai.py:311` 的 `print(ASCII_BANNER)` 在 GBK 控制台下抛异常，
且异常被静默吞掉，导致 4399 永不监听。**

- 现象：进程活着、有内存占用、日志停在 `[XiaoAI] 启动小爱音箱服务...`，但 `netstat` 里 **没有** 4399；音箱端 client 连不上。
- 实测异常原文：`UnicodeEncodeError: 'gbk' codec can't encode character '\u2596' in position 3: illegal multibyte sequence`
  （banner 里有 `▖` 等制表块字符）。
- 为什么没人看得见：`core/app.py:182` 用 `asyncio.run_coroutine_threadsafe(XiaoAI.init_xiaoai(), self.loop)` 派发，
  **没有挂 done-callback**，协程里的异常被丢弃；`print` 的 stdout 还被块缓冲，banner 也不会落盘。
- 规避（零改码，已验证）：spawn 桥接器时设 `PYTHONUTF8=1`（`sys.stdout.encoding` 变 `utf-8`，banner 正常打印，
  `[AppServer] ✅ 已启动: "0.0.0.0:4399"` 立即出现）。
- 复核用探针：`D:\WorkSpace\_oxb-wheels\probe_banner.py`（banner 编码复现）与
  `D:\WorkSpace\_oxb-wheels\probe_server.py`（隔离验证 Rust `start_server()` 能绑定 4399）。
- **fork 里应当顺手加固**（第 2 期）：给 `core/app.py:182` 的 future 加错误日志回调，并给 `print(ASCII_BANNER)` 兜底，
  免得下一台机器再踩同一颗雷。

### 10.3 API Server 冒烟（`API_SERVER_ENABLE=1`）

| 调用 | 结果 |
|---|---|
| `GET /api/health` | `{"success": true, "data": {"status": "healthy", "speaker_ready": true}}` |
| `GET /api/status` | `{"success": true, "data": {"status": "idle"}}` |
| `POST /api/play/text` `{"text": "...", "blocking": false}` | `{"success": true, "message": "Playing text in background"}`（走 `ubus call mibrain text_to_speech`，小爱原生音色） |
| `POST /api/play/text` `{"text": "...", "blocking": true}` | `{"success": false}` —— **假失败**，见下 |

> 上表是第 1 期从 loopback 打的原始记录。自 3.11 起，**非 loopback** 调用方还要带
> `Authorization: Bearer <token>`，`/api/health` 的 data 里也多了 `auth` 字段（见 §12.21）。

**坑三：`blocking=true` 恒报失败（上游 bug）。** `core/services/speaker.py:71-78` 走
`/usr/sbin/tts_play.sh '<text>'` 并要求 `res.exit_code == 0`；但该脚本最后一句是
`[ x"$player_stat" == x"1" ] && { /usr/bin/mphelper play; }`——当播放器没被静音（`player_stat != 1`）时整条复合语句返回 1，
脚本 `exit code` 就是 1。**实测设备上音频确实正常播放完了**（miplayer 日志 `notify PLAYER STARTED` → `EndReached`），
只是退出码骗人。另外脚本里用的 `my_log` 在裸 ssh shell 下是 `line 1: my_log: not found`（LEDE 运行时才有该函数）。
→ 音箱设备控制与 `run_shell` RPC 链路是通的；结论：**主动播报一律走非阻塞路径**（Q5 也是这个方向）。

已验证可用的设备侧原语（在音箱上直接执行）：

```
ubus call mibrain text_to_speech '{"text":"...","save":0}'   # 返回 {"code": 0, "info": "{ \"path\": \"/tmp/tts/...mp3\" }"}
```

必须存在：`/usr/sbin/tts_play.sh`、`/usr/bin/miplayer`、`/usr/bin/mphelper`、`/usr/bin/arecord`（均已确认存在）。

---

## 11. 第 1 期验收（插件骨架）

### 11.1 仓库外形

```
D:\WorkSpace\Github\dsh-xiaoai-bridge\        # 2026-10-03 从 D:\WorkSpace\dsh-xiaoai-bridge 迁移到此
  package.json          cordis.patch.yml      LICENSE        DISCLAIMER.md
  lib\index.js          # 插件主体：设置命名空间、token 签发、工具/技能注册、生命周期
  lib\config.js         # Schemastery 配置 schema + 双层覆盖解析
  lib\http.js           # /plugin/xiaoai/* 宿主路由（health/config/devices/asr/bridge/*）
  lib\skill.js          # 加载 skills\xiaoai-speak\SKILL.md
  lib\client.js         # 客户端 bundle：plugins.bundle.config 设置页
  lib\bridge.js         # 桥接器 HTTP 客户端（/api/play/text 等）
  lib\process.js        # 桥接器子进程托管 + pidfile 收养
  lib\session.js        # 设备→DSH 会话桥（agents.create/resume、设备库落盘）
  lib\tools.js          # xiaoai_speak 工具定义
  lib\render-config.js  # 设置 → 桥接器 config.py（覆盖层 + 原子替换）
  lib\types\*.d.ts
  locale\{zh,en}.json   # 插件名 i18n，由 dsh-app-boot 的 readPluginMeta 解析
  skills\xiaoai-speak\SKILL.md
  scripts\{check-client,check-session,check-supervisor,check-config,check-keywords}.mjs
  docs\deploy.md
  bridge\               # fork 后的上游桥接器（含 core\models\、target\，均被 gitignore）
```

`git remote`：只有 `upstream = https://github.com/coderzc/open-xiaoai-bridge`（**没有 origin**，
等用户提供 fork URL）。基线 tag：`baseline`；HEAD 已在 fork 之后的本地提交线上。

### 11.2 安装记录

```powershell
# 先在插件仓库里准备好唯一的外部依赖（pnpm 会把本地目录装成 link:，不代装它的依赖）
Set-Location D:\WorkSpace\Github\dsh-xiaoai-bridge
pnpm add "@deepseek-ai/schemastery@^3.18.4"

# 再装进 desktop profile
dsh plugin --profile desktop add D:\WorkSpace\Github\dsh-xiaoai-bridge
```

实测落点：

| 项 | 值 |
|---|---|
| profile 依赖 | `"dsh-xiaoai-bridge": "link:D:/WorkSpace/Github/dsh-xiaoai-bridge"` |
| `dsh.profile.bundles` | 已追加 `"dsh-xiaoai-bridge"`（末位） |
| `node_modules\dsh-xiaoai-bridge` | SymbolicLink → `D:\WorkSpace\Github\dsh-xiaoai-bridge` |
| 依赖解析 | 仓库内 `node_modules\@deepseek-ai\schemastery\package.json` 存在（`link:` 语义要求插件自带依赖） |

三个位置都要一起改，少一个就从旧路径加载（或直接报模块不存在）：

| 位置 | 迁移前 | 迁移后 |
|---|---|---|
| profile 依赖（`package.json` 的 `dependencies`） | `link:D:/WorkSpace/dsh-xiaoai-bridge` | `link:D:/WorkSpace/Github/dsh-xiaoai-bridge` |
| `node_modules\dsh-xiaoai-bridge` 符号链接 | `D:\WorkSpace\dsh-xiaoai-bridge` | `D:\WorkSpace\Github\dsh-xiaoai-bridge` |
| 运行中的宿主进程 | 旧路径 | **必须重启 DSH 才会重新加载** |

**移动仓库前必须先停桥接器**（Windows 不允许移动被占用目录）：

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:19387/plugin/xiaoai/bridge/stop
# → {"ok":true,"result":{"ok":true,"stopped":true}}；接着 bridge 状态应为 running:false
```

`Move-Item` 之后 `bridge\.venv` **不需要重建**：`pyvenv.cfg` 的 `home` 指向 uv 的基础解释器
（`%APPDATA%\uv\python\cpython-3.12-windows-x86_64-none`），与项目路径无关；实测搬移后
`import open_xiaoai_server, sherpa_onnx, numpy` 与 `pytest`（41 passed）全部照常。

拿安装前备份：`D:\WorkSpace\_oxb-wheels\profile-backup\{package.json,pnpm-lock.yaml,pnpm-workspace.yaml,compatibility.json}.bak`。

### 11.3 坑四：pnpm 供应链策略会拦下**与本次安装无关**的旧锁文件条目

首次 `dsh plugin add` 失败：

```
✗ Lockfile failed supply-chain policy check (277 entries in 1.7s)
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:
  billion-context@0.1.180 was published at 2026-10-02T08:09:06.988Z, within the minimumReleaseAge cutoff
dsh: plugin command failed
```

- 该条目是 profile 里**早就存在**的依赖；`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里
  明明已经写了 `billion-context@0.1.180`，本次校验仍拒绝，且 `minimumReleaseAgeStrict: false` 没起作用。
- 失败是**干净的**：`package.json` / `pnpm-lock.yaml` 被自动回滚，`dsh.profile.bundles` 未被改写。
- 绕过（已验证）：给这一次安装关掉时效策略即可。

```powershell
dsh plugin --profile desktop add D:\WorkSpace\Github\dsh-xiaoai-bridge --config.minimum-release-age=0
```

- 这条策略是**profile 级、长期存在**的：以后任何 `dsh plugin add` 都可能再撞上，除非把新条目补进
  `minimumReleaseAgeExclude` 或放宽 `pnpm-workspace.yaml`。记录在此，避免下次误判成插件自身的问题。

### 11.4 装载前的离线自测（重启前的证据）

两个自测脚本都在仓库外，不随包发布：

| 脚本 | 作用 | 结果 |
|---|---|---|
| `D:\WorkSpace\_oxb-wheels\plugin-smoke.mjs` | 用假 cordis ctx 加载 `lib/index.js` 并驱动 HTTP 层五连测 | 通过 |
| `D:\WorkSpace\Github\dsh-xiaoai-bridge\scripts\check-client.mjs` | `node:vm` 里加载 `lib/client.js`，断言 id/导出/页签注册/首帧 | 通过 |

`plugin-smoke.mjs` 实测输出要点：

- exports = `Config, PLUGIN_VERSION, apply, defaultPythonPath, inject, name, parseWakeKeywords, settingsNamespace`
- `inject = ["tools","skills","settings","credentials","agents"]`；apply 后 effects=2、`webServer` 已注入
- 技能注册为 `xiaoai-speak (runtime, 1862 chars, resourceBase=directory)`；工具数 0（本期有意）
- `GET /plugin/xiaoai/health` → **200**，`checks` 四项全 true（bridgeDir/python/modelsDir/skillFile）
- `GET /config` → 200；`POST /config` → 200；跨域 origin → **403**；未知路由 → 404

### 11.5 尚未验证

- 重启后 bundle 是否仍在 `dsh.profile.bundles` 里被正常装载（不以 `dsh plugin list` 为加载证据）。
- 主界面「插件」→ 本 bundle 页面上是否真的渲染出「配置概览」一段（§11.6 修正后的判据）。

### 11.6 首次尝试放错了槽位（已修正）

第一次把页面注册进 `settings.plugins.tab`，重启后**页签确实出现了，但位置错了**——它落在
「设置 → 内置插件」的标签条里，与「MinerU 解析」并列，而那是**宿主自己的设置页**待的地方。

官方技能 `C:\Users\Administrator\.dsh\skills\dsh-plugin-creator` 的
`check-mounts.mjs --explain` 直接给了答案；`plugins.item` 的槽位说明原文就写着：

> OCCUPIED by the official settings pages, one companion package per host-plane
> namespace; **a bundle's configuration belongs in `plugins.bundle.config` or
> `plugins.row.config` instead**.

正确落点与契约（`--explain` 给出 source
`packages/client/ui-plugin-manager/src/client/slot-contract.ts:94`，分发代码见 asar 内
`@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js`）：

| 项 | 值 |
|---|---|
| 槽位 | `plugins.bundle.config`（keyed / root / `shadows-shipped-ui`） |
| key | **bundle 的包名**，即 `dsh-xiaoai-bridge` |
| 声明者 | `main` 里的 `client-ui-plugin-manager` → `dsh.client.inject` 写 `["@deepseek-ai/dsh-client-ui-plugin-manager"]` |
| ownerProps | `{ view: 'summary' \| 'page' }`（本槽位只按 `view: 'page'` 渲染，**不传 `form`**） |
| 渲染位置 | 主界面「插件」→ 该 bundle 自己的页面里，**描述与行列表之间** |

宿主的分发代码原文（决定「注册了为什么没出现」）：

```js
configured: ledger.bundles.has(openPkg.name)   // ledger.bundles = plugins.bundle.config 的 key 集合
...
configured ? renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name }) : null
```

即：**注册的 key 就是包名**，页面按包名分发；`configured` 为真才渲染这一段，所以 key 写错就等于隐身。
`plugins.row.config` 的 key 是 `` `${bundle}#${rowId}` ``（本插件为 `dsh-xiaoai-bridge#xiaoai`），
且那一侧**会**传 `form`；本插件只声明一行，故配置段走 `plugins.bundle.config`。

**教训（并入本仓库工作规则）**：

1. `dsh.client.inject` 填**声明者的包名**（`--explain` 输出里的「声明者」），
   `lib/client.js` 导出的 `inject` 填**服务名**（如 `slots`）——两者不是一回事。
2. 选槽位先跑 `check-mounts.mjs --explain <key>` 读 purpose，**不要照抄别的插件的写法**：
   MinerU 用 `settings.plugins.tab` 是因为它要在设置区里加一个页面，不是 bundle 配置。
3. 改完跑 `check-mounts.mjs --check <插件目录>` 静态核对字面量 slot key（本仓库当前 0 error）。

## 12. 第 2 期实现（dsh 连接器与语音闭环）

### 12.1 两个仓库面的分工

| 面 | 位置 | 职责 |
|---|---|---|
| 桥接器 | `bridge/` | 接管音箱音频，KWS 唤醒、VAD、ASR，把用户语句 POST 到插件 `/asr` |
| 插件 | `lib/` | 托管桥接器进程，把语句投进 DSH 会话，提供 `xiaoai_speak` 工具让模型开口 |

关键设计：**桥接器不做 TTS**。播报只由模型的 `xiaoai_speak` 工具触发，
所以「模型没说话」和「重复播报」这两个问题在结构上就不存在。

### 12.2 插件侧新增模块

| 文件 | 作用 |
|---|---|
| `lib/process.js` | 托管 `python main.py` 子进程；注入环境变量、日志环形缓冲 + `<dataDir>/bridge.log`、`taskkill /T` 杀进程树、pidfile 收养 |
| `lib/bridge.js` | 带 token 的桥接器 REST 客户端；`playText()` 走 `/api/play/text` 且 `blocking:false` |
| `lib/session.js` | 一台音箱一个会话；`agents.resume` 优先、`agents.create` 兜底；**投递用 `agent.followup()`** |
| `lib/tools.js` | `xiaoai_speak` 工具（裸 JSON Schema，走 `ctx.tools.register`，不用 `defineTool`） |
| `lib/http.js` | 新增 `POST /asr`（唯一要 bearer 的路由）、`GET /devices`、`/bridge/status|logs|health|start|stop|restart` |
| `lib/render-config.js` | 把设置渲染成桥接器读的 `config.py`；**覆盖层 + 原子替换**（见 §12.11） |
| `scripts/check-session.mjs` | 会话桥接单测（宿主形状假 ctx，7 组 23 项断言，含 §12.6 坑三与 §12.9 坑六的回归） |
| `scripts/check-supervisor.mjs` | 进程收养单测（12 项断言：同代码收养 / 代码已换则替换，见 §12.8） |
| `scripts/check-client.mjs` | 客户端 bundle 校验（`id` / `slot` / `key` / 官方表单件形状 / 21 个字段与 6 个分区 / `lib/config.js` 每个键都有控件 / `locale/*.json` 契约） |
| `scripts/check-config.mjs` | 渲染器单测 + **真机验证**：用 `bridge/.venv` 的解释器加载渲染结果，断言覆盖值与两个钩子（见 §12.11） |
| `scripts/check-keywords.mjs` | 唤醒词热重载验收：换 `CONFIG_PATH` → `reload_app_config()` → 断言 `keywords.txt` 重编码 + spotter 重建（见 §12.12） |

五个必须记住的宿主契约（细节见 `docs/deploy.md` §6 与实施计划 §7.5）：

1. **投递必须用 `agent.followup(message)`**。`agent.inject()` 不唤醒 agent，
   空闲 agent 收到消息后一动不动。
2. **`createUserMessage` 的 `content` 只接受数组** `[{type:'text',text}]`，裸字符串不是该形状。
   插件用惰性 `import('@deepseek-ai/dsh-llm')`，解析不到时手搓同形状对象兜底。
3. **`source.kind` 不能是裸 `'plugin'`**。我们写 `plugin:dsh-xiaoai-bridge`
   （裸值会让会话当场可写、之后永久不可读）。
4. **`agents.create` / `agents.resume` 必须带 `agentOptions` + `setup`**，
   否则第一条消息会以 `prompt variable "{{model}}" has no value` 收尾（§12.6 坑三）。
5. **`meta.cwd` 必须是绝对路径且不能省略**。省略它不会当场报错，而是让宿主
   **拒绝服务这个会话**（GUI「历史加载失败」）且 `{{cwd}}` 无值（§12.9 坑六）。

### 12.3 两个真坑（重启前修掉）

**坑一：`core/models/keywords.txt` 不会被重新生成。**
上游只在 `scripts/start.sh:126` 与 `Dockerfile:64` 的 CMD 里调用
`core/services/audio/kws/keywords.py`；以 `python main.py` 直接启动（插件的托管方式）
时**从不生成**，`config.py` 里改唤醒词不生效，甚至会一直用上游自带的
`你好小智 / 小智小智 / 貌似貌似 / ...`——说「小爱小爱」根本唤不醒。
修法：`bridge/main.py` 新增 `ensure_wakeup_keywords()`，在 `MainApp` 启动前调用生成器，
让 `config.py` 的 `wakeup.keywords` 成为唤醒词唯一真相源。

实测（`DSH_ENABLE=1`）：

```
core/models/keywords.txt  181 字节 → 93 字节
你 好 小 黑 @你好小黑
小 黑 你 好 @小黑你好
小 爱 小 爱 @小爱小爱
```

**坑二：`/asr` 的 body 契约不匹配。**
`core/dsh.py:_submit_utterance` 原本只发 `{text, session_key, device_name, source}`，
而插件读 `device_host` 与 `device_name`，`host` 为 `undefined` → 设备键回落 `default`。
单设备能跑，多设备设计失效。修法：`dsh.py` 增加 `_device_host`，优先读环境变量
`XIAOAI_DEVICE_HOST`（插件 spawn 时注入），并在请求体里带上。

### 12.4 已验证（离线）

- `bridge\.venv\Scripts\python.exe -m pytest -q` → `60 passed`
  （`test_dsh_fallback.py` 4 条见 §12.13，`test_playback_gate.py` 15 条见 §12.16）。
  **配方变了**：pytest 现在装在桥接器自己的 venv 里
  （`uv pip install --python bridge\.venv\Scripts\python.exe pytest`；注意 `uv sync` 会把它清掉，
  重装一次即可）。旧的「系统 python + `PYTHONPATH` 指 venv 的 site-packages」只在纯 Python
  模块上成立：本机系统 python 是 3.13、venv 是 3.12，测试一旦 import numpy / onnxruntime 就会
  以 `No module named 'numpy._core._multiarray_umath'` 死在导入阶段。
- 桥接器冷启动冒烟（`DSH_ENABLE=1 API_SERVER_ENABLE=1 AUDIO_INPUT_ENABLE=1`，带
  `XIAOAI_DEVICE_HOST=192.168.1.191` / `XIAOAI_API_TOKEN=smoke-test-token`）：
  `0.0.0.0:4399 LISTENING`、`127.0.0.1:9092 LISTENING`、
  `192.168.1.150:4399 ← 192.168.1.191:54816 ESTABLISHED`（音箱端 client 自动连上）、
  `GET /api/health` → `{"success": true, "data": {"status": "healthy", "speaker_ready": true}}`、
  `GET /api/status` → `{"success": true, "data": {"status": "idle"}}`。
- 插件烟测（`_oxb-wheels/plugin-smoke.mjs`，已加 `autoStart:false` 以免真的拉起桥接器）：
  `effects: 5`、`tools: 1`、`skills: xiaoai-speak (2086 chars)`、`GET /health` 200、
  `GET/POST /config` 200、`GET /bridge/status` 200、
  `POST /asr` 无 bearer → 401、空文本 → 400、无 agents 服务 → 503、
  跨域 → 403、未知路由 → 404。
- 配置写路由两种形态都对：`{patch,revision}` → 200、`{ops,revision}` → 200；
  两者都返回 `config: {ok:true, path:"<dataDir>\\config.py"}`（写路由顺带渲染，见 §12.11）；
  `{patch,ops}` 同时给 → 400、空 `ops` → 400、非法 op → 400、过期 revision → 409。
- 会话桥接单测（`scripts/check-session.mjs`，7 组 23 项）：交付结果、`source.kind`、
  content 数组形状、`meta.cwd` 为绝对路径、设备库落盘（`version: 2`）、第二次投递复用活 agent、
  无默认模型时的降级告警、空文本拒绝、**v1 遗产设备库退役重建**、
  工作区兜底 / 配置生效 / 相对路径回退三条 `sessionCwd` 路径。
- 进程收养单测（`scripts/check-supervisor.mjs`，12 项）、渲染器单测 + 真机加载
  （`scripts/check-config.mjs`，含「钩子看到的是覆盖值」与「未拥有的键保持模板默认」）、
  唤醒词热重载（`scripts/check-keywords.mjs`，见 §12.12）与客户端 bundle 校验
  （`scripts/check-client.mjs`：官方表单件形状、21 个字段与 6 个分区标题、
  `lib/config.js` 每个键都有控件、`locale/*.json` 的存在性/语言 id/`meta.title|description` 非空、
  `exports` 与 `files` 是否放行 locale）。
- 兜底播报（`bridge/tests/test_dsh_fallback.py`，4 项，见 §12.13）。
- locale 解析实测（在 profile 目录里跑）：
  `require.resolve('dsh-xiaoai-bridge/locale/en.json')` → `D:\WorkSpace\Github\dsh-xiaoai-bridge\locale\en.json`，
  即 `exports` 的 `"./locale/*"` 已生效（`readPluginMeta` 走的就是同一个 Node 解析器）。

### 12.5 未验证（需要用户重启 DSH）

第 2 期验收的实机部分（计划 §五 行 308–313）：

1. 说唤醒词「小爱小爱」，听到「小爱来了」；
2. 说一句话，DSH 里出现对应的用户消息（`source.kind = plugin:dsh-xiaoai-bridge`）；
3. 模型调用 `xiaoai_speak`，音箱念出该文本；
4. 说退出词「退出」/「停止」/「再见」能打断并恢复监听；
5. 无重复播报。

### 12.6 第 1 次实机联调（2026-10-02 23:20）

链路的前半段**一次通过**：`bridge.log` 依次出现

```
[KWS] 🔥 触发唤醒: 小爱小爱
[Wakeup] before_wakeup returned: dsh
[DSH Conv] 🎙️ 进入 DSH 连续对话模式
[DSH(agent:main:open-xiaoai-bridge)] 💬 我说：你是多。
[DSH Conv] 👋 退出 DSH 连续对话模式
```

`GET /plugin/xiaoai/health` 显示 `bridge.running = true / pid = 8668 / managed = true`，
`GET /devices` 显示设备键 `192.168.1.191`（说明 §12.3 的坑二已修好）与会话 id。
这段日志里的 `agent:main:open-xiaoai-bridge` 是**当时的默认值**：§12.35.5 把这支 fork 的默认改成了
`agent:main:dsh-xiaoai-bridge`，历史摘录保持原样不改。
解开会话落盘（`session.v4.jsonl.zstd`，4 个 zstd frame 串接；Node 的
`zstdDecompressSync` 只解第一个 frame，需要 `_oxb-wheels/zstd-jsonl.mjs` 手工逐 frame 解）
后看到事件序列：

```
seq 4  agent/inbox/spliced  { target: "next-turn", inserted: [{ role: "user",
         content: [{type:"text",text:"你是多。\n注意：…"}],
         source: { kind: "plugin:dsh-xiaoai-bridge" } }] }
seq 5  turn/start
seq 6  agent/inbox/spliced  { removedCount: 1 }        ← 消息被消费
seq 7  step/start
seq 8  step/end
seq 9  turn/end  reason: { kind: "error", error: {
         message: 'prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")' } }
```

即：**投递链路完全正确**（`followup` 唤醒、inbox 被消费、`source.kind` 合规），
失败发生在第一条 LLM 请求之前。原因是 `agents.create({sessionId, meta})` 没传
`agentOptions`，agent 没有 provider/model，部署人设的 `{{model}}` 变量无法填充
（`sessionStats.llmMs = 0`，请求根本没发出去）。

**坑三（最隐蔽的一个）：`agents.create` / `agents.resume` 必须带
`agentOptions` + `setup`。**

- `agentOptions: {provider, model}` 只解决**路由**。`dsh-agent-loop/lib/index.js:1185`
  的守卫是
  `if (!proposedConfig.provider || !proposedConfig.model) throw new Error('agent "..." has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall')`。
- 提示词变量 `{{model}}` / `{{provider}}` 另有人提供：全仓库**只有**
  `installModelSelection`（`@deepseek-ai/dsh-agent` 导出；定义在
  `dsh-agent/lib/types/model-selection.js:45`，打包副本在 `dsh-agent/lib/index.js:166`）
  的 `system-prompt/assemble` 监听器会写入
  `variables: { ...assembled.variables, provider, model }`。不装它，人设段就渲染不出来。
- 宿主权威配方在 `dsh-headless/lib/index.js:302-321`：
  `const selection = ctx.agentDefaultModel.currentSelection();`
  → `agentOptions = {provider: selection.provider, model: selection.model}`
  → `setup = (agentCtx) => installModelSelection(agentCtx, {current: selection, assembled: void 0})`。
- `setup` 由 `dsh-agent-loop/lib/index.js:1889`
  `(await raceAbort(setup?.(prepared.agent.ctx, prepared.agent), prepared.signal, id))?.commit()` 调用，
  返回值可以是 disposer 也可以是 `undefined`。
- 另有一条**只有实机才踩得到的坑**：插件进程（就是 DSH 宿主本身）没重启时，
  `agents.get(sessionId)` 仍会返回**用旧参数创建的活 agent**，改代码不生效。
  必须重启 DSH（重启后走 `agents.resume` + 新参数），或删掉
  `<dataDir>/devices.json` 让它新建会话。

修法落在 `lib/session.js`：`currentSelection(ctx)` 每次投递都重读
`ctx.get('agentDefaultModel').currentSelection()`（用户可能中途换模型），
`resolveModelInstaller()` 只缓存一次 `import('@deepseek-ai/dsh-agent')` 的结果；
两者拼成 `factoryOptions()`，同时展开进 `agents.resume({resumeSessionId, ...factory})`
与 `agents.create({sessionId, meta, ...factory})`。宿主包解析不到时退回一个只注册
`system-prompt/assemble` 的最小兜底（`{{model}}` 正是致命的那一半，路由另有 `agentOptions`）。

### 12.7 坑四：模型不知道自己在跟「看不见屏幕的人」说话

同一次联调还暴露出一个语义缺口（不是崩溃，是「跑通了但用户什么都听不到」）：
`core/dsh_conversation.py` 提交语音识别结果时用的是 `DshManager._rule_prompt`
——「将结果处理成纯文字版，不要返回任何 markdown 格式，并将字数控制在300字以内」。
这是**文字频道**的话术。语音频道里模型把答案写成文字等于没说：桥接器按设计不做 TTS，
用户听到的是沉默，而日志里一切正常。`bridge.log` 那一行
`注意：将结果处理成纯文字版…` 就是现场证据。

DSH 侧另有 `_rule_prompt_for_skill`（「主人看不到你回复的文字」），才是这个频道该用的。
修法两处：

- `core/dsh_conversation.py` 优先取 `_rule_prompt_for_skill`，为空才退回 `_rule_prompt`：

  ```python
  # The voice channel needs the skill variant: it is the text that tells
  # the model the user cannot read its reply, which is what pushes it to
  # speak through the plugin's `xiaoai_speak` tool.
  rule = (
      getattr(self.backend, "_rule_prompt_for_skill", "")
      or self.backend._rule_prompt
  )
  full_text = text if not rule else text + "\n" + rule
  ```

- `config.py` 的 **`dsh` 段**把 `rule_prompt_for_skill` 改成显式点名工具（`openai` 段有同名
  键，编辑时要带上同段的 `"wakeup_keywords": ["小爱小爱"]` 才能唯一定位）：

  ```
  注意：这条消息是主人通过小爱音箱发来的语音，他看不到你回复的文字。
  你必须调用 xiaoai_speak 工具把要说的内容念出来，否则主人什么都听不到。
  字数控制在300字以内
  ```

改 `.py` 需要桥接器进程重启才生效（`config.py` 有热重载，模块代码没有）。
注意这不是它的职责：`lib/tools.js` 里 `xiaoai_speak` 的 description 也写了同样的引导，
但**提示词里的话术比工具描述更能决定模型是否调工具**，两处都要保留。

### 12.8 坑五：收养孤儿进程会连它的旧代码一起收养

`lib/process.js` 的 pidfile 收养是为了「DSH 崩溃退出后不再撞端口」，但收养的代价是
**连带收养它的 Python 模块**——`.py` 代码不热重载（只有 `config.py` 会）。结果是：
改了代码、重启 DSH、看起来一切正常，实际跑的还是旧模块。

修法是给收养加一个前置判据 `adoptedCodeIsStale()`：把 pidfile 的 mtime 和
`bridge/main.py` + `bridge/core/**/*.py`（跳过 `.venv` / `models` / `__pycache__`
/ `logs`）里最新的 mtime 比一比，源码更新就说明磁盘上的代码已经不是它跑的那份 ——
此时不走收养，改为 `killTree(stale)` 杀掉再重新 spawn，日志会留下
`bridge sources changed since pid=<n> started; replacing it`。

回归测试 `node scripts/check-supervisor.mjs`（12 项）在临时目录里各起一个假
`main.py`（`pythonPath` 指向 node 自身）覆盖两条分支，不会碰到真实的音箱连接。

### 12.9 坑六：会话 header 里没有 `cwd`，一个原因两个症状

首次实机联调（§12.6）之后暴露了两个看似无关的问题：

1. 每一轮的 `deployment:persona-suffix` 都渲染失败（`{{cwd}}` 无值）；
2. GUI 打开那个会话时报「历史加载失败：session "session-95b1abb2-…" not found
   （session/not-found）」。

**它们同一个根因，而且不是本地 DSH 损坏。** 取证：

- `C:\Users\Administrator\.dsh\sessions` 下只有两个桶：`--D-WorkSpace--`（407 个会话）
  与 `_no-cwd`（**1 个，就是我们那个**）。全机不存在第二个没有 `cwd` 的会话，
  所以原有会话无一受影响；两边的 `session.v4.jsonl.zstd` 结构完全一致（能正常解开）。
- 两份 header 的差别只有一个键：

  ```
  我们的： {"type":"session","version":4,"id":"session-95b1abb2-…","createdAt":…,"isSeeded":false,"delegationDepth":0}
  健康的： {… , "cwd":"D:\\WorkSpace", "parentSession":"…", "origin":"subagent", "agentPreset":"cordis"}
  ```

- 持久化层本身**支持** `_no-cwd`：`dsh-session-persistence-jsonl/lib/index.js:902`
  `projectDir(root, cwd)` 在 `cwd === undefined` 时就是 `join(root,'_no-cwd')`，
  且 `:3359-3373 findLog(id)` 会遍历所有 project dir，按 id 找得到。
- 拒绝发生在 **API 层**：`dsh-api-session-controller/lib/index.js:1566-1587`
  `sourceFor()` 取到 observation 后第一件事就是

  ```js
  if (observation.header.cwd === void 0) {
      observation[Symbol.dispose]();
      rejectNotFound(address);
  }
  ```

  `rejectNotFound`（`:1645-1651`）抛 `session/not-found`「session "<id>" not found」，
  由 `dsh-client-ui-chat/lib/client.js:5444` 的 `"chat.loadError": "历史加载失败：{message}（{code}）"`
  渲染成用户看到的那行红字。

**结论**：文件读写没问题，是**宿主策略拒绝服务任何 header 里没有绝对 `cwd` 的会话**。
插件的错：`lib/session.js` 在 `sessionCwd()` 为空时省略了 `meta.cwd`。

修法（两处）：

- `sessionCwd()` **永不返回空串**：配置值（须绝对）→ 宿主第一个工作区
  （`ctx.get('workspaceRegistry')?.list?.()?.[0]?.path`）→ `process.cwd()` → `homedir()`。
- `ensureAgent` 的 create 分支固定 `const meta = { cwd: sessionCwd() };`。

另外 `DEVICE_STORE_VERSION` 从 1 升到 **2**：v1 记录指向的会话 header 里没有 `cwd`，
**永远救不回来**，所以载入时直接退役它的 `sessionId`（历史文件留在磁盘上不动），
并立刻回写设备库，避免崩溃后把旧链接复活。日志会留
`device store v1 has no working directory on its sessions; starting fresh sessions`。

`scripts/check-session.mjs` 的 case 4 就是这条回归：写一个 v1 设备库 → 断言它**不 resume**
而是新建、`resumeCalls === 0`、去抖后回写成 `version: 2`、`name` 与 `utterances` 保留。

### 12.10 设置页重写（第 2 期 UI 收尾）

原来的 `lib/client.js` 是只读的「配置概览 / 环境自检 / 解析路径」三张卡片，
用户评价「胡乱拼凑」。现在换成**与官方「子智能体」设置页同构的可编辑表单**：
同一套 `@deepseek-ai/dsh-client-ui-primitives` 组件（`SettingsForm` /
`SettingsValueField` / `Switch` / `SegmentedControl` / `Tag`），同样的「暂存草稿、
点保存才写、离开丢弃」语义，14 个字段按 基本 / 唤醒与语音 / 桥接器进程 / 本地 API 服务
四个分区排布，另附只读的运行状态区。

三条关键决策：

1. **不走 `ctx.configForms`**，改用现有 `/plugin/xiaoai/config` HTTP 路由自持草稿。
   理由：① plugin-manager README `:108` 明说 bundle 级页面「can contain several entries
   and have no single form」，自持草稿是官方认可的写法；② `configForms.whileServed`
   要求登记前就知道命名空间，而我们要先问 `/health` 才知道（鸡生蛋）；
   ③ 宿主已有的路由带 revision 围栏，不必再依赖一个客户端服务。
2. **一次保存只发 `ops`，从不发 `patch`**。因为一次保存里可能同时有「改值」和「重置」，
   而 `settings.update` 是合并语义、表达不了「还原到继承值」。
   为此 `lib/http.js` 的 `POST /config` 增加了 `{ops, revision}` → `settings.mutate(...)`
   （`{op:'unset', path:[field]}` 才会回到 base 层）。
3. **`apiServerTokenCredential` 用普通文本框而不是 `SettingsSecretField`**：
   它存的是凭据**名**（`XIAOAI_API_TOKEN`），不是密钥本身。

插件显示名的 i18n 走**包内 `locale/*.json`**，不需要写代码：
`dsh-app-boot/lib/index.js:1969-1985 readPluginMeta()` 用 Node 模块解析器取
`<包名>/locale/en.json`，再扫同目录的兄弟 `*.json` 作为各语言词典
（文件名即语言 id，内容 `{"meta":{"title":…,"description":…}}`）。
两个前提缺一不可：`package.json` 的 `exports` 放行 `"./locale/*"`（`readPluginMeta`
走的就是那个解析器）、`files` 包含 `locale/`。
中文名「小爱音箱桥接器」，英文名「XiaoAI Speaker Bridge」。

`scripts/check-client.mjs` 现在同时守住两件事：客户端 bundle 的槽位/表单件形状，
以及 locale 文件的存在性、语言 id 合法性、`meta.title|description` 非空、
`exports`/`files` 是否放行。

**设置写入的校验（R1-1，4.13）**：`POST /plugin/xiaoai/config` 在落盘前用
`lib/config.js` 的 `validateConfig()` 严格校验草稿（草稿 = `DEFAULTS` → 当前 section →
本次的 `patch` 或按序应用的 `set` ops），不合法就回 400、错误信息里带字段名，
且**不碰**设置 seam；`unset` 不入校验，因为它只是删键、露出来的是继承的默认值。
校验跑在 revision 围栏之前，所以「既过期又不合法」回 400 而不是 409。
载入路径是另一套：`lib/index.js` 的 `configNow()` 走 `sanitizeConfig()` 逐键回退、
只告警一次。两半的分工见 §12.32.3。

### 12.11 第 3 期：生成的 `config.py` 是**覆盖层**，不是副本

设置页不再只写 DSH 的 settings，它同时把配置渲染成桥接器能读的 `config.py`
（`lib/render-config.js`，写 `<dataDir>/config.py`，`lib/process.js` 用
`CONFIG_PATH` 把它交给子进程）。**关键决策**：生成的文件不是模板的拷贝，而是

```python
_template = _load_template(...)          # 用 importlib 加载仓库里的 bridge/config.py
APP_CONFIG = _template.APP_CONFIG        # 共用同一个 dict 对象
before_wakeup = _template.before_wakeup  # 两个钩子直接复用上游定义
after_wakeup = _template.after_wakeup
_deep_merge(APP_CONFIG, { ...overrides })  # 只覆盖插件拥有的键
```

理由（三条，缺一不可）：

1. **默认值只有一份**。上游 200+ 行默认值不会被复制进插件，也就不会悄悄过期；
   「清空某个字段」= 不写该键 = 用上游默认，而不是写一个空值。
2. **钩子必须看到覆盖值**。`before_wakeup` / `after_wakeup` 直接读模块级
   `APP_CONFIG`，所以生成文件必须让 `APP_CONFIG` 就是被覆盖的那个对象；
   拷贝一份再改，钩子看到的还是原值（`scripts/check-config.mjs` 里
   `the hooks see the overridden values` 一项就是钉这个的）。
3. **写盘必须原子**。桥接器每秒轮询 mtime，半写文件会让它 `reload` 到语法错误；
   写入走「临时文件 + `renameSync`」。

`wakeup.timeout` 是唯一**恒定写入**的键 —— 它是插件拥有的字段且有具体默认值
（20 秒，与模板默认相同），所以「全部字段清空」时仍会写出 `{wakeup:{timeout:20}}`。
这不是 bug，`check-config.mjs` 里连这条都断言了。

### 12.12 唤醒词热生效（硬需求①的可执行验收）

链路：设置页保存 → `lib/http.js` 写回 → `afterConfigWrite()` 调
`supervisor.renderConfig()` → `<dataDir>/config.py` 原子替换 → 桥接器
`_watch_config_file()` 1s 轮询发现 mtime 变化 → `reload_app_config()` →
`ConfigManager` 的监听器 → `_KWS._on_config_reload()`：先 `apply_runtime_config()`，
**指纹（唤醒词 + kws 两个阈值）没变就返回**，变了才 `refresh_keywords()` ——
先进程内调用 `core/services/audio/kws/keywords.py:main()` 重新编码
`core/models/keywords.txt`，再 `SherpaOnnx.reload()` 在锁内重建
`KeywordSpotter` + stream。

**为什么必须有 `reload()`**：`_SherpaOnnx.start()` 只在 `_detection_loop` 里调用一次，
唤醒词文件于是只在进程启动时读一次 —— 光重生成 `keywords.txt` 不重启进程是**不生效**的。

`scripts/check-keywords.mjs` 用桥接器自己的解释器跑真链路：渲染 A（`小爱小爱`）→
加载 → `SherpaOnnx.start()` → 把 `CONFIG_PATH` 换成渲染 B（`你好小智` + `测试唤醒词`）→
`reload_app_config()`，断言编码后的 `keywords.txt` 是

```
你 好 小 智 @你好小智
测 试 唤 醒 词 @测试唤醒词
```

（新词在、旧词 `@小爱小爱` 已消失）、spotter 对象被重建、`applied_keywords` 跟着换，
并在 `finally` 里还原仓库里的 `keywords.txt`（生成物，gitignore）。

### 12.13 两层降级（3.8 / 3.9）

- **层一（音箱侧，与 DSH 生命周期无关）**：小爱 App 里对这台音箱的「自定义训练」
  可以把某个词绑到一句固定答复。电脑关机、DSH 没开、桥接器没跑时它都还能响。
  这层**不写代码**，只存在于音箱固件/App 里，所以在此文档化即可。
- **层二（桥接器活着、插件不可达）**：`DshManager._play_fallback()` 说
  `dsh.fallback_text`（设置页「兜底播报文本」渲染，留空用内置默认），
  `bridge/tests/test_dsh_fallback.py` 四条覆盖「用了配置里的词 / 空设置用内置 / 没有
  speaker 不报错 / speaker 抛异常不外溢」。

**一个容易看错的点**：DSH 这轮对话是 fire-and-forget 的，`DshManager.send()` 在
`wait_response=False` 时**投递前**就返回 `run_id`，所以
`dsh_conversation.py:78` 的 `if run_id is None` 只管「后端被禁用」这一种情况，
HTTP 失败时它**已经返回 "continue" 了**。因此兜底必须由唯一知道投递失败的
`_submit_utterance()` 触发 —— 它 `except` 分支里调 `_play_fallback()`。

### 12.14 烟测抓到的一个作用域 bug（教训）

`lib/http.js` 里新加的 `afterConfigWrite()` 一开始定义在 `mountHttp()` 内部，
而两处调用点在模块级的 `handle()` 里 —— 于是**每次保存设置都 500**
（`internal error: afterConfigWrite is not defined`）。`node --check` 通过、
`check-client.mjs` 通过、`check-config/keywords/session/supervisor` 全通过，
**只有 `plugin-smoke.mjs` 打到了这条**（它真的发 `POST /config`）。
修法是把 helper 提到模块级并显式收 `deps`。

**教训：新增的 HTTP 路径改动，`plugin-smoke.mjs` 不是可选项。** 离线单测各自只覆盖
自己那一层，作用域/装配类错误只有端到端那一条能看见。

### 12.15 已知遗留

- `lib/process.js` 的 `childEnv()` 会 `delete env.OPENAI_ENABLE`：OpenAI 兼容后端
  代码保留但插件托管下不可达（它只是可被手工启动的参考实现）。这是刻意的，
  写在此处以免日后误判为 bug。
- `core/utils/config.py` 的 `_initialize_device_id()` 现在**不再回写 `config.py`**：
  设备 ID 落到 `<CONFIG_PATH 同目录>/device.json`（临时文件 + `os.replace`），
  旧的 `update_config_file()` 已删除。原先它即使 `re.sub` 空操作也会抬高模板 mtime，
  可能让「源码比 pidfile 新」的判定误报。
- 桥接器的 API Server（9092）的九个端点自 3.11 起统一走 bearer 中间件：
  **loopback 调用方放行，其他地址必须带 token**（见 §12.21）。
- `afterConfigWrite()` 在**设置页保存时**渲染（保存即生效）；桥接器启动时也会渲染一次
  （`supervisor.renderConfig()`），所以手工删掉 `<dataDir>/config.py` 后重启插件能自愈。
- 烟测 `plugin-smoke.mjs` 会真的渲染一次 `<dataDir>/config.py`（用的是桩里的默认值），
  跑它等于把用户当前的设置覆盖成默认值。默认值本身是可用配置，但**跑完烟测值得提醒用户**。

### 12.16 半双工闸门：播报期间不听自己

**症状（2026-10-03 实机）**：`bridge.log` 里出现 `我说：你好，我是小爱，是小爱音箱的智能助手…`
—— 那是音箱把**自己刚播出去的开场白**又识别了一遍；紧接着还有 TTS 与人声混叠的乱码句。
DSH 会话里也能看到模型在**同一轮**里连调约 6 次 `xiaoai_speak`（自问自答的产物）。

**根因**：DSH 的回合是**提交型**的 —— `core/dsh_conversation.py` 把语句投给插件就立刻
`return "continue"`，`_conversation_loop` 随即把 VAD 重新武装；而回复是插件异步反调
`POST /api/play/text {text, blocking:false}` 播出去的。于是**播报期间麦克风是开着的**，
听到的是我们自己。

**设计**：新增 `bridge/core/utils/playback_gate.py` —— 一个跨线程的关闸信号
（`threading.Lock` + `time.monotonic()` 截止时刻），模块级单例 `PlaybackGate`。

| 机制 | 语义 |
|---|---|
| `hold()` / `release()` / `with PlaybackGate:` | 引用计数式占用。一次播放可能嵌套多层（回复 + 提示音），少释放一层都不能提前开闸 |
| `hold_for(seconds)` | 按预计时长关闸，到期自开。用于「调用立刻返回、声音还在后面放」的路径 |
| `set_device_playing(bool)` | 同步音箱 `AudioPlayer` 事件（`core/xiaoai.py` 的 `playing` 分支）。**只用来延长，从不用来提前打开** —— 设备可能在播放刚开始时报一次 `idle` |
| `closed` | `计数 > 0` 或 `设备在播` 或 `距上次释放不足 RELEASE_TAIL_SECONDS(0.5s)` |

时长估算只能按文本：`ubus call mibrain text_to_speech` 在设备**收下**文本后就返回。
`estimate_speech_seconds(text)` = `字数 / 4.0` 夹在 `[1.5s, 180s]`，**故意往长了估**
（关久一点只是少听一会儿，开早了回声就回来了）。

**七个调用点（缺一个就漏回声）**：

1. `core/services/tts/router.py` 的 `TTSRouter.play()`：整个 provider 分派（含豆包的
   `open_xiaoai_server.tts_play`，它绕过了 SpeakerManager）包在 `with PlaybackGate:` 里。
   这是**所有回复播报的收口点**（DSH 与 OpenAI 两条链都走它）。
2. `core/services/speaker.py` 的 `play()`：`blocking=True` 用 `with PlaybackGate:` 包住
   `run_shell(tts_play.sh ...)`（脚本活到放完）；`blocking=False` 用
   `hold_for(estimate_speech_seconds(text))`；`buffer=` 按 PCM 长度估
   （`len/2/24000`，int16 24kHz）；`play_server_file(blocking=True)` 同样用 `with`。
3. `core/services/api_server.py` 的 `/api/tts/doubao`：外部客户端也能让音箱说话，
   同样开合闸门（阻塞分支用 `with`，异步分支用 `hold_for`）。
4. `core/services/audio/vad/__init__.py`：`_detection_loop` 拆出 `_process_frames()` ——
   **关闸期间整帧丢弃**（不跑 Silero、不进入检测状态），并在进入/离开静音时各
   `stream.clear_input()` 一次，把攒下的回声与半截录音清干净（`playback_muted` 保证日志与清理各只发生一次）。
5. `core/wakeup_session.py` 的 `consume_xiaoai_asr_result()`：**小爱自己的识别**同样会听到
   我们刚播出去的话，所以关闸期间的识别结果直接 `return False` 丢掉。
6. `core/xiaoai.py`：把设备的 `playing/paused/idle` 事件喂给 `set_device_playing()`。
7. `core/external_conversation.py` 的 `_await_utterance()`（新，替掉原来的
   `asyncio.wait_for(self._vad_future, timeout=self.timeout)`）：**播报期间不消耗用户的聆听窗口**，
   音箱闭嘴后才给一整个 `timeout`（否则一段长回复会在自己念到一半时把对话等超时）。
   延长总量封顶 `MAX_ASYNC_HOLD_SECONDS`，避免「设备永远报 playing」把会话挂死。

**测试**：`bridge/tests/test_playback_gate.py`（15 条）—— 闸门自身的引用计数/到期/尾音、
设备事件只延长、估算边界、VAD 关闸丢帧且只清一次、在途 ASR 结果被丢、
`SpeakerManager` 的 blocking/async/PCM 三条路径确实关闸、聆听窗口不被播报吃掉但仍会超时。

**未覆盖**：`bridge/core/xiaoai_conversation.py`（音箱原生对话）与 `external_conversation._play_tts`
的兜底分支走的是 `speaker.play(text=...)` 默认 `blocking=True`，由第 2 条天然覆盖；
但**真正判断「音箱还在响吗」只有设备事件与估算两种间接证据**，没有拿到 Rust 侧播放结束回调。
如果实机上仍有回声，第一个要调的是 `RELEASE_TAIL_SECONDS` 与 `SPEAKING_RATE_CPS`。

### 12.17 自动接管播报：回复正文本身就是要说的话

**症状（2026-10-03 实机）**：音箱里的回答又长又念不出口 —— 模型把屏幕上的排版
（标题、列表、`**加粗**`）照样写进回复，然后因为旧的规则文本「你必须调用
`xiaoai_speak` 工具」而**每条回复都只走工具**，工具文本也就等于那条长文本。
另一端更糟：规则把模型训练成「永远不会直接回答」，replyer 这类后处理根本没上线。

**设计**：播报不再依赖模型记得调工具，而是**接在回合结束上**。新增三个模块：

| 文件 | 职责 |
|---|---|
| `lib/auto-speak.js` | 按会话跟踪一「轮」：`POST /asr` 开轮 → `assistant/message` 记草稿（**最新一条胜出**）→ `turn/end` 才真正播报 |
| `lib/replyer.js` | 把「要表达的意图」改写成口语（人格 + 风格 + 输出限制组 system 提示，历史 + 意图组 user 消息），走 `ctx.llm.stream` |
| `lib/speech-log.js` | 追加写 `<dataDir>/spoken.jsonl`，只落盘不参与决策 |

**为什么只在 `turn/end` 播报**：DSH 的回合是提交型的（§12.16），`assistant/message`
可能来好几条（中间步骤、工具前的铺垫）。等到回合结束再取「最后一条最终文本」，
就不会把半句话念出去，也不需要去抖定时器。

**工具仍是逐字逃生舱**：一轮里模型调了 `xiaoai_speak`，就**只念工具文本**、不过
回复器，本轮正文丢弃；同一轮第二次调用被忽略（`claimToolSpeak` 先到先得）。
「工具优先、照原样念」是刻意的：调用工具本身就是在说「这句话要逐字念」。

**失败与超长**：
- 回复器失败（含 `NO_ADAPTER` / `RATE_LIMIT` 等终结 chunk）→ 念
  `replyerFailureText`（默认「回复器调用失败」），**绝不把未润色的原文当正常回复念出去**。
- 会话没选模型（`no-route`）→ 这是配置缺失，不是回复器故障，念截断后的 agent 原文。
- 超过 `spokenMaxChars` → 让回复器**精简一次**，仍超则在最后一个句号/问号/叹号处截断。
- 消息形状兜底：system+user 两条消息失败时，重试一次合成单条 user 消息。

**规则文本反转**：`dsh.rule_prompt_for_skill` 的默认文本不再要求「必须调用工具」，
改成「正文会被自动念出来，直接写要说的话就好；只有要逐字念的内容才调工具」。
这句话现在由**插件拥有**（`lib/render-config.js` 渲染），所以老部署不用手改；
桥接器模板里的同名字符串也已同步（`bridge/config.py`）。

**离线测试**：`scripts/check-speak.mjs`（约 40 条）覆盖留痕、截断、路由解析、提示词
组装、重试/精简/失败/无路由，以及 auto-speak 的「最新草稿胜出」「工具轮不重复播报」
「一轮只认一次 claim」「历史裁剪」「失败念提示语」。六个 checker 全绿：
`check-client` / `check-config` / `check-keywords` / `check-session` /
`check-supervisor` / `check-speak`。

**仍未实机验证**：真实模型下 replyer 的改写质量与 800ms 级别的感知延迟、音箱念出
超 300 字时的截断手感。

### 12.18 人格三层：谁说的话归谁管

设置页把人格拆成三个字段，**只有前两个进回复器**：

| 字段 | 注入位置 | 影响范围 |
|---|---|---|
| `personality`（人格设定） | 回复器 system：「关于你自己：…」 | 只有被念出来的那句话 |
| `replyStyle`（说话风格） | 回复器 system：「说话风格：…」 | 同上 |
| `behaviorStyle`（行动准则） | **语音规则文本**，作为 `行动准则：…` 追加 | 音箱会话的 agent（思考与行动），不影响桌面会话 |

`behaviorStyle` 拼在规则文本里，而不是走 `system-prompt/assemble`，理由是宿主自带的
插件开发规范逐字写着「**Do not listen to `system-prompt/assemble` to add or remove
tools or text.**」（`cordis-plugin-development/references/practices.md`），而且
profile 级的 `ctx.systemPrompt.section()` 会漏进**所有**桌面会话 —— 语音规则文本由
桥接器每轮追加在语音输入后面，天然只作用于音箱会话。实现见 `lib/render-config.js`
的 `composeVoiceRule()`。

### 12.19 播报留痕：`spoken.jsonl`

每次真的念出去一句，就追加一行 JSON 到 `<dataDir>/spoken.jsonl`：

```json
{"time":"2026-10-03T01:12:44.190Z","device":"192.168.1.191","intent":"回合结束时的最终文本","spoken":"实际念出来的口语化句子","provider":"deepseek","model":"deepseek-chat","source":"replyer"}
```

`source` ∈ `replyer`（回复器改写）/ `tool`（逐字工具）/ `failure`（失败提示语）/
`raw`（无路由时念的原文）。用途是回答「音箱刚才到底念了什么」——实机排查回声、
串词、答非所问时，`bridge.log` 只有「我说：」的粗粒度记录，这一行才是原文对照。
写入是尽力而为：目录不存在就建、失败只 warn 一次，绝不让留痕拖垮回合。

`dataDir` = `<DSH_HOME>/xiaoai-bridge`（没有 `DSH_HOME` 时 `~/.dsh/xiaoai-bridge`），
和 `devices.json`、`bridge.pid`、`config.py` 同一个目录。

**上限与轮转（R6-1，4.13）**：文件超过 `SPOKEN_LOG_MAX_BYTES = 5 * 1024 * 1024`（5 MiB）
时，整份轮转到**单槽** `spoken.jsonl.1`——Windows 的 `rename` 覆盖不了已存在的目标，
所以轮转是「先删旧槽再改名」，也就是**只保留上一代**，下一次轮转会把上一代顶掉，
真正的长期留痕得用户自己另存。轮转失败（文件被占用、权限等）只 warn 一次
`dsh-xiaoai-bridge: spoken log rotation failed: …`，然后**继续往原文件追加**，不丢记录。
`createSpokenLog(...).size()` 返回当前可见文件的字节数，是 `collectFacts()` 里
`spokenLogBytes` 的来源（轮转前的写入按 `size() + 本次长度` 判断是否该轮）。
`spoken.jsonl.1` 已在 `lib/cleanup.js` 的 `HISTORY_FILES` 里，卸载时与 `spoken.jsonl`
同等对待；只有显式的 `POST /data/wipe` 会连它一起删。

### 12.20 会话分组：为什么音箱会话显示「未分组」

**症状（m04179）**：`sessionCwd` 指的是工作区里的子目录（`D:\WorkSpace\XiaoAI`），
会话却落在侧栏的「未分组」里。

**机制**（读 `@deepseek-ai/dsh-workspace/lib/index.js`，宿主源码）：
- 一个分组 = 一条 workspace 记录（`path` / `title` / `sessionIds` 有序账本）。
- `WorkspaceEntity.sessionIds` 的 getter **按 cwd 过滤**：
  `this.record.sessionIds.filter((id) => this.host.sessionPath(id) === this.record.path)`。
- `attachSession(sessionId)` 会先 realpath 归一化会话 header 里的 cwd，然后逐字
  `if (cwd !== this.record.path) throw` —— **cwd 必须正好等于工作区目录**，子目录不行。
- **没有任何隐式attach**：宿主的 session controller 只在调用方传了 `workspaceId`
  时才 `attachSession`。插件用 `agents.create` 建会话，不经过那条路径，所以从来没人
  把它登记进账本。
- `insertSessionBefore` 对没登记过的会话直接抛 `WorkspaceMoveInvalidError`
  （`the session is not accounted`），所以「事后拖进分组」不是可用的修法。

**修法**（`lib/session.js` 的 `attachToWorkspace()`）：建完会话后拿 cwd 去
`workspaceRegistry.resolveByPath(cwd)` 查工作区，查到就 `attachSession`；
查不到就什么都不做（宿主反正会拒，何必抛一次）。resume 分支也尽力附一次，
用来治愈「会话建在工作区之前」的老会话。
`scripts/check-session.mjs` 的 case 5/6 各加了一条断言（落地即成组 / 子目录不硬塞）。

**设置页不再让人手输路径**（m04557）：既然「cwd 必须正好等于工作区目录」，
让用户自己敲一个绝对路径就是把一个他无法验证的前提交给他 —— 敲错了不会报错，
只会永远显示「未分组」，而事后又没有补救手段（`insertSessionBefore` 见上）。
所以 `sessionCwd` 的控件从文本框换成了一个原生 `<select>`：

- 候选来自宿主自己的工作区清单：`lib/session.js` 的 `workspaceGroups()` 读
  `ctx.get('workspaceRegistry').list()`，只保留 `path` 非空的记录，规整成
  `{id, path, title}`（`title` trim 后可为空，页面回退显示纯路径）。
- 清单经 `GET /plugin/xiaoai/health` 的 facts 下发（`state.collectFacts()` 新增
  `workspaces`，`lib/index.js` 的 `state.workspaces()` 只是转调
  `sessions.workspaceGroups()`），客户端读 `health.data.health.workspaces`。
- 第一项是「不指定（跟随默认工作区）」，值为空串 —— 保存即 unset，
  回落到「宿主第一个工作区」的既有兜底。
- 已保存但已不在清单里的值（工作区被删、或值来自旧版本的手输）会**多出一条**
  「当前值（已不在工作区列表里）：<路径>」的选项，避免它在下一次保存时**静默消失**。
- `/health` 还没答复时清单为空，控件只剩「不指定」——不会渲染出半截列表。

**代价**：插件不再自动建工作区。用户要一个「音箱专用」分组，就得先在侧栏把那个
目录建成工作区，然后在这里选中它 —— 这正是 m04557 否掉「没有就自动注册」的原因。

### 12.21 API Server 的鉴权：loopback 信任 + 远端 bearer

上游的九个端点（`/api/health`、`/api/status`、`/api/play_text|url|file`、
`/api/wakeup`、`/api/interrupt`、`/api/tts/doubao`、`/api/tts/voices`）**一个都不鉴权**，
唯一的防线是监听地址（`API_SERVER_HOST`，默认 `127.0.0.1`，但它是设置项，可以改成
`0.0.0.0`）。

**规则**（`bridge/core/services/api_auth.py`，作为 aiohttp 中间件装在
`web.Application(middlewares=[bearer_auth])` 上，所以**没有路由能绕过去**）：

- peer 是 loopback（`ipaddress.ip_address(peer).is_loopback`）→ 放行，不需要 token；
- 非 loopback → `Authorization: Bearer <token>`，与配置的 token 用
  `hmac.compare_digest` 比对（防时序侧信道）；
- **没配 token 时非 loopback 一律 401**：fail closed。没有可比对的秘密，放行就是裸奔。

**为什么不对 loopback 也强制 token**：能连 `127.0.0.1` 的本机进程本来就能读到凭据库，
强制只会打断那些学不到秘密的本地脚本（`skills/xiaoai-tts` 里那几个），而安全边界一点
没变。真正的威胁面是「监听地址被改成 `0.0.0.0`」，那条路已经被堵住了。插件自己走
loopback 且**本来就带 token**（`lib/bridge.js` 从第 2 期起就带），所以常态是已鉴权。

**但 loopback 不等于「只有我」**：Windows 上 `127.0.0.1` 是**整机可达**的，同一台机器的
其他本地用户会话也能连上来，插件路由（`POST /plugin/xiaoai/config`、`POST /plugin/xiaoai/data/wipe`、
`/bridge/start|stop`）都在这个信任域里。这是**显式承认**的边界，不是没注意到——
展开与收紧方案见 §12.32.7。

**token 从哪来**（**每次请求现读**，改配置不必重启）：环境变量 `XIAOAI_API_TOKEN`
优先，其次渲染后的 `config.py` 的 `dsh.token` —— 与 `core/dsh.py` 的既有惯例一致
（env 优先、config 兜底）。插件托管时 `lib/process.js` 会把 `ensureToken()` 供给的
token 塞进子进程 env，所以正常安装就是「已配置 token」。

**失败形态**：只回 `{"success": false, "error": "unauthorized"}`（401），
**原因只进日志**：

```
[APIServer] refused POST /api/play_text from 192.168.3.9:39120: no API token is configured (XIAOAI_API_TOKEN or dsh.token)
```

`GET /api/health` 的 data 多一个 `auth` 字段（`bearer` / `loopback-only`），
启动日志也带（`HTTP server started at http://127.0.0.1:9092 (auth: bearer)`），
给第 4 期的状态卡用。

**刻意没做的事**：插件**不把**自己供给的 token 渲染进 `config.py`。秘密只留在 DSH
凭据库里；`dsh.token` 仍然只服务手工场景（模板里的值不会被覆盖层抹掉，见 §12.11）。
理由是渲染器 `lib/render-config.js` 是纯函数、`renderConfig()` 是同步的，为了把同一个
秘密多写一份而把整条渲染链改成异步不划算。

**测试**：`tests/test_api_server_auth.py` 12 条（决策表 / header 解析 / token 来源 /
中间件确实挂在真 `APIServer` 上且九条路由都在门后）、`tests/test_skill_api_client.py`
11 条（环境变量优先、配置文件兜底、坏配置不致命、401 提示）。

### 12.22 主动说话：watchdog 保活 + 按需拉起（4.1）

「API Server 常开」在第 4 期之前是句空话：桥接器进程崩了就**再也不会起来**——
`lib/process.js` 的退出处理器只写一行 `lastError`，然后什么也不做。定时提醒、长任务
跑完这类「没有人正在看着窗户」的场景全靠它，所以 4.1 的一半工作在进程侧。

**一、watchdog：退避重启，然后放弃**（`lib/process.js`）

- 退出处理器（`child.on('exit')`）在 `!stopping` 时调 `scheduleRestart('exited unexpectedly (code=…)')`。
- 延迟表 `DEFAULT_RESTART_DELAYS_MS = [2000, 5000, 15000, 30000]`，**表长同时就是崩溃预算**：
  窗口内崩溃次数达到 `restartDelaysMs.length` 时置 `gaveUp = true`，`lastError` 写成
  `bridge exited unexpectedly (code=…); the watchdog stopped after N restarts in M minutes`。
  固定间隔重试会把「音箱没插电」变成每 2 秒一次的密集重启，退避不会。
- **预算是滑动崩溃窗口，不是「连续崩了几次」**：`scheduleRestart()` 先
  `crashTimes = crashTimes.filter((at) => now - at < windowMs)`（`crashWindowMs`，默认
  `DEFAULT_CRASH_WINDOW_MS = 60 * 60 * 1000`），只有窗口内的崩溃才算数；本次尝试的延迟取
  `restartDelaysMs[crashTimes.length]`，再把 `Date.now()` push 进 `crashTimes`。因此
  「一天崩一次」在窗口里永远只有 1 次、不会耗尽预算，而「一分钟崩一次」和「一秒崩一次」
  一样会把四次额度用完。
- 旧口径的 `stableMs`（「活够 60 s 就算健康一轮、把计数清零」）**已删除**：它让周期性慢崩
  永远重试下去。现在没有「活够久就重置」，只有用户显式 `start()` 才清空
  （`start({ fromWatchdog = false })` 里的 `crashTimes = []; gaveUp = false`）；
  watchdog 自己发起的重启**不**清（否则崩循环里计数永远是 0，等于无限重启）。
- `stop()` 在最早的 `if (!running()) return` **之前**调 `clearRestartTimer()`：桥接器已经
  宕机时点的「停止」如果不清计时器，一秒后到期的重启会把它又拉起来。
- 只在插件自己管进程时才重试（`watchdogActive()`：`cfg.enabled !== false &&
  cfg.autoStart !== false && !gaveUp && !stopping`）。`autoStart` 关掉意味着用户自己
  管桥接器，插件不该跟用户抢。

**二、按需拉起：`ensureStarted()`**（供工具用）

`running()` → `{ok:true, already:true}`；`cfg.enabled === false` → `plugin disabled`；
`cfg.autoStart === false` → `bridge is not running (autostart is off)`；`gaveUp` → 上次的
`lastError`；否则 `start({ fromWatchdog: true })`。最后一条分支写 `fromWatchdog` 是有意的：
工具触发的启动不该把「已经放弃重试」的预算清掉。

**三、工具侧的重启判定线**（`lib/tools.js` 的 `speakWithRevive()`）

`bridge.playText()` 的失败分两类，只有第一类值得重启：

| 失败形态 | 含义 | 动作 |
| --- | --- | --- |
| `{ok:false}` 且**无 `status`**（连不上 / 超时） | 请求根本没到 API Server，桥接器没在跑 | 调 `ensureBridge()`，成功后按 `revivePollMs`（默认 1500 ms）重试到 `reviveWaitMs`（默认 12000 ms） |
| `{ok:false, status: 4xx/5xx}` | 桥接器活着并且答了话 | 直接上报，**不重启**（重启一个会说话的进程是错的） |

`ensureBridge()` 失败时返回 `桥接器没在运行，自动启动也失败了：<原因>` 并 `isError`，
**不做第二次尝试**（对着同一个死端口重试没有意义）。`ensureBridge` 是可选注入项：
`check-speak.mjs` 里没有它的用例仍然只播一次。

**四、`state()` 的新字段**（给 4.5 状态卡用）：`restarts`（崩溃窗口内已计数的崩溃次数，
= `crashTimes.length`）、
`watchdogGaveUp`（watchdog 是否已放弃）、`nextRestartAt`（下一次自动重启的 ISO 时间，或
`null`）。加上 §12.21 的 `auth`，状态卡要的三类信息（在跑没在跑 / 为什么不在跑 / 鉴权
形态）就齐了。

**测试**：`scripts/check-supervisor.mjs` 的 4.1 部分新增 case C（自然退出→重启成新 pid、
日志有 `restart #1 in 120 ms`）、case D（已排队的重启被 `stop()` 取消，等过一个延迟也不再
起）、case E（`restartDelaysMs: [10, 20]` 的崩循环 → `watchdogGaveUp === true` 且日志写
`the watchdog stopped after 2 restarts`；随后显式 `start()` 清掉标记并真的跑起来）；
`scripts/check-speak.mjs` 新增「proactive speech」5 条（按需拉起后重试成功、拉起失败时
报原因、HTTP 错误不重启、超时到 `reviveWaitMs` 就收手、没有 `ensureBridge` 时行为不变）。
该 checker 后来长到九个 case（A 身份匹配的遗留进程被接管、A2 旧版裸数字 pid 文件仍能接管、
B 遗留进程跑的是被替换过的代码则重启、C、D、E、F 身份不匹配被拒绝、G 解释器 spawn 不出来
不算成功、H 并发 `start()` 只 spawn 一次），列表以脚本里的 `console.log('case …')` 为准。

### 12.23 连续对话开关：默认一句话一次唤醒（4.2）

设置页的「连续对话」是一个布尔开关，默认**关闭**。关闭时一次唤醒只对应一句话：桥接器把
这轮语音交给插件后立刻退出对话模式，想再说一句要重新喊唤醒词。打开后才回到上游那种
「一直听着，直到静默超时或说出退出词」的行为。

**为什么默认是单次**：DSH 的回复是异步来的（桥接器只提交，插件稍后通过 API Server
播报，见 §12.5），提交完这一轮之后麦克风其实无事可做。上游要它继续听，是因为上游在
同一个循环里等待并播放回复；我们不需要，让麦克风一直开着只会多一份「听到自己刚播出去
的话」的风险（`PlaybackGate` 只在**播放期间**抑制识别，等待回复的那段时间并没有闸门）。

**插件侧**：`lib/config.js` 的 `DEFAULTS.continuousConversation = false` 与同名 schema
字段；`lib/client.js` 把它放在「唤醒与语音」区，中英标签 + 提示各一条；`lib/render-config.js`
把它渲染成 `dsh.continuous_conversation`。这一项**总是**写进生成的 `config.py`（包括
`False`），因为它有明确的插件侧默认值——不写就等于「模板说什么就是什么」，而模板的
默认值只是给不用插件的裸跑用户看的。

**桥接器侧**：`core/external_conversation.py` 新增钩子

```python
def keeps_listening(self) -> bool:
    return True
```

`_conversation_loop()` 在 `result == "continue"` 之后问它一次：返回 False 就 `break`，
**不播退出应答**。这一点是有意的——每说完一句就听见「小爱，再见」很荒唐；退出应答只留给
真正的退出路径（说退出词 / 静默超时）。`core/dsh_conversation.py` 覆盖它：

```python
@property
def continuous_conversation(self) -> bool:
    return bool(self._cfg("continuous_conversation", False))

def keeps_listening(self) -> bool:
    return self.continuous_conversation
```

基类默认 True，所以共用一个循环的 OpenAI 兼容后端不受影响；`dsh.continuous_conversation`
在模板 `config.py` 里的默认值也是 `False`，裸跑桥接器（不经插件）同样是一句一次唤醒。

**测试**：`tests/test_dsh_single_turn.py` 7 条 —— 模板默认值是 `False`、默认单次、开关打开
后继续听、手改的 `"yes"` 也算真；再用探针驱动**真实**的 `_conversation_loop()`：单次模式下
第一轮 `continue` 就离开（`_call_after_wakeup` 不触发、`_stop_recording` 恰好一次），
连续模式下说完三轮才因 `exit` 退出并播一次退出应答，基类默认仍是 `True`。
`scripts/check-config.mjs` 断言默认渲染出 `{"continuous_conversation": False}` Python 字面量、
打开时桥接器加载到的是真正的布尔值；`scripts/check-client.mjs` 断言补上「连续对话」标签、
`kind: "boolean"` + hint 的接线，以及开关数量从 4 变 5。

**顺带修掉一个测试顺序坑**：`bridge/core/external_conversation.py:25` 是
`from core.utils.playback_gate import PlaybackGate`——导入期就把名字绑死在本模块里，
而 `tests/test_playback_gate.py` 原来只替换 gate 模块自己的那个名字；这招只对「在这之后才
导入」的模块有效。新的 `tests/test_dsh_single_turn.py` 字母序在前、先把
`core.external_conversation` 导入了，于是监听窗口测试读回真的单例、窗口按 0.3s 正常过期，
表现成「单跑绿、全量跑必红」（`core/external_conversation.py:430` 的 `TimeoutError`）。
修法是在 `_GateTestCase.setUp()` 里把**已经**导入过该名字的模块一并换掉、`tearDown()`
还原；两个方向的文件顺序都验证通过。

### 12.24 审批提示语：只说去哪儿，不念正文（4.3）

工具调用需要用户在屏幕上点了才继续时，音箱只出一句「需要你到电脑上确认一下」
（设置项 `approvalText`，`lib/config.js` 的 `DEFAULTS.approvalText` 与
`lib/auto-speak.js` 的 `DEFAULT_APPROVAL_TEXT` 都写死这一句，设置留空即回到它）。

**触发点是 `approval/asked`，不是 `turn/end` 的 `reason.kind === 'blocked'`。**
会话事件表（`dsh-api-session-controller` 的 `lib/typert.host.js` 里 `SessionEventMap`）把
审批拆成三条：`approval/asked: { id, toolName, callId?, reason? }`、`approval/decided:
{ id, outcome }`、`approval/policy: { policy, source? }`。而 `TurnEndReasonMap` 里的
`blocked` 还包含「循环没法继续」这种根本没有请求的情况（归档会话闸门：
`which the loop ends as blocked without a request`），对着它念「到电脑上确认」是错的。
`reason` 字段里就是审批正文（命令、路径之类），**一个字都不进音箱**，只进日志。

**为什么不等 `approval/decided` 再念。** 决定可能在片刻之后才来，而用户此刻可能不在电脑
前；报错的代价是「多提醒一次」，沉默的代价是「这一轮永远卡着，而房间里一点动静都没有」。
如果策略替用户直接批了，确实会白念一句——这是选定的牺牲。

**一句话最多一次。** 同一个回合里两个工具同时等审批（不同 `id`），也只需要用户走一趟，
所以用 `state.approvalAnnounced` 标记：回合内的第二次审批只记日志不发声。标记在
`onUtterance()` 与 `onTurnEnd()` 复位（后者在读 `awaiting` 之前复位，这样没被唤醒的会话
也会在回合边界重新获得一次机会）。

**序与竞态。** 审批行走的是和回合末播报同一条队列（`state.pending`，新覆盖旧），
`drain()` 里按 `job.verbatim` 分流：审批行**逐字念**，不经过回复器（回复器是给「话」润色的，
不是给提示语润色的），`noteSpoken()` 记 `source: 'approval'`。因为审批行不是「回答」，
排队时顺手清掉 `state.draft`：审批之前写的那段文字（很可能正是「我要执行 X，请批准」）
不会被念出来；审批之后模型再写的话会重新填进 `draft`，在 `turn/end` 正常播报。
`autoSpeak` 关闭时整条路径同样安静（判断仍在 `drain()` 里），而桌面会话在
`lib/index.js` 的监听器里就因为「没有设备」被跳过了——坐在电脑前的人不需要被告知去电脑前。

**测试**：`scripts/check-speak.mjs` 的「approvals」6 条 —— 只念提示语且带 `source:
'approval'`、`calls` 为空（没过回复器）；同回合同一 session 的第二次审批不重复；关掉
`autoSpeak` 全静默；审批前的草稿被丢弃、审批后写的话照常播报；设置留空时用
`DEFAULT_APPROVAL_TEXT`；插件从未见过的 session 不发声。


### 12.25 语音合成方式与 MiMo 预留：只写桥接器认得的 provider（4.4）

设置页「唤醒与语音」里新增**语音合成方式**（`ttsProvider`）三选一，以及四个 **MiMo 占位
字段**（`mimoBaseUrl` / `mimoApiKeyCredential` / `mimoModel` / `mimoVoice`，全部默认空）。

**桥接器其实早就有 provider 抽象。** `bridge/core/services/tts/router.py` 的
`TTSRouter.SUPPORTED_PROVIDERS = {"xiaoai", "doubao", "openai", "mlx_audio"}`，
`resolve_provider(configured_provider, tts_speaker)` 的规则是：配置了就用配置，**不认识的值直接抛**
`Unknown tts_provider=...`；没配置则按音色判断 —— `tts_speaker == "xiaoai"` 用 `_play_xiaoai`
（音箱自带合成），其他音色 ID 当豆包音色走 `_play_doubao`。`bridge/config.py` 里
`dsh.tts_provider` 默认 `None`，就是这个「没配置」的旧规则。

**三个选项各自写什么：**

| 选项 | 渲染到桥接器 | 结果 |
| --- | --- | --- |
| 跟随音色（`''`，默认） | 什么都不写 | 保留上面那条按音色判断的旧规则，豆包音色 ID 照常可用 |
| 小爱原生（`xiaoai`） | `dsh.tts_provider = "xiaoai"` | 强制音箱自带合成，即使音色字段填的是豆包音色 |
| MiMo（预留，`mimo`） | **什么都不写** | 只记住这个选择，播放方式不变 |

**为什么 MiMo 只存不写。** 桥接器没有 MiMo 客户端，把 `tts_provider = "mimo"` 写进去不是
「预留」，而是让 TTS 路由在播放那一刻抛异常——从一个不生效的选项变成一个不出声的音箱。
所以选择留在设置里（将来接上就能直接生效，不用让用户重选一遍），映射表
`lib/render-config.js` 的 `RENDERED_TTS_PROVIDERS = { xiaoai: 'xiaoai' }` 里没有它，
`buildOverrides()` 也就永远不发生成 `mimo` 的文件。选中的后果写在页面提示里
（「选中只会记住这个选择，播放仍是当前方式」）。

**MiMo 占位字段的形状。** 四个字段对应一次 OpenAI 兼容的语音合成请求
（`POST /v1/audio/speech`：endpoint + 凭据 + model + voice），这正是桥接器**已经**支持的那条
`openai` 通道的形状，所以将来接入时只需把字段接到 `tts.openai` 上，页面不会再变。凭据字段
存的是**凭据名**（DSH 凭据库里的引用，同「访问令牌凭据名」的约定），明文永远不进设置、
不进生成的文件——第 4.10 项「无真实凭据入库」在预留字段上同样成立。

**顺手改掉一个错标签。** `ttsSpeaker` 原来写的是「朗读音箱插件」/「Speaking plug-in」，
但桥接器把 `tts_speaker` 当**音色 ID** 解析（`xiaoai` = 小爱原生，其他值 = 豆包音色），
跟「音箱插件」没有关系。现在叫「朗读音色」/「Reading voice」，提示词也照实说：
`xiaoai` 用音箱自带的，填豆包音色 ID 才走豆包。

**枚举要能显示中文，所以加了 `optionLabels`。** `lib/client.js` 的 enum 分支原来把选项值
直接当标签（`options.push({ value: v, label: v })`），三选一的空值会渲染成空白段。现在
spec 可以带 `optionLabels: { 值: i18n key }`，取值时 `translate()`，没有映射就退回原始值——
`asrBackend`（`sense_voice` 等）和 `logLevel`（`DEBUG` 等）保持原样，它们显示的就是技术值。
同一个分支的 `value` 也补上了和会话工作区 `<select>` 一样的兜底：
`draft[key] === undefined || null ? "" : String(...)`，否则未播种的草稿会渲染成 `"undefined"`。

**测试**：`scripts/check-config.mjs` —— 空选择不写 `tts_provider`、选 `xiaoai` 时写成字符串、
选 `mimo` 时不写、四个 MiMo 字段一个都不进 `dsh`、稀疏文件里既没有 `tts_provider` 也没有
`mimo`，并且用真 Python 加载渲染结果确认 `APP_CONFIG["dsh"]["tts_provider"]` 真是 `"xiaoai"`。
`scripts/check-client.mjs` —— 段控件数量 2 → 3，`xiaoai-ttsProvider` 的选项值/标签是
`["=跟随音色", "xiaoai=小爱原生", "mimo=MiMo（预留）"]` 且未播种时 `value` 是空串，
没有 `optionLabels` 的枚举仍然用原始值当标签。


### 12.26 状态卡：看得见连接、鉴权与最近错误（4.5）

设置页「运行状态」原来只答「进程在不在」。可语音链路的失败恰好都发生在没人看的地方：
桥接器起来了但没在服务、令牌换了、有人拿着旧令牌调 `/asr`、看门狗已经放弃重启。
第 4.5 项补三样东西：**实时探测、错误记忆、以及把两者画到卡片上**。

**一、`lib/diagnostics.js`：最近错误的记忆。** `createDiagnostics({ logger, limit = 20, now })`
返回 `{ note, recent, last, clear }`。条目只有两段信息：

| 字段 | 是什么 |
| --- | --- |
| `code` | 稳定标识（`DIAGNOSTIC_CODES` 七个之一），由页面翻译成中英文本 |
| `detail` | 原始技术串（截 300 字），原样显示 |
| `time` / `count` | ISO 时间；同一 `code + detail` 重复出现时收敛成一条并累加 `count` |

**为什么是「代码 + 原文」而不是直接存一句中文。** 页面本来就有中英两套文案，写死中文等于
在英文界面里塞中文；而 `detail` 是给人看的现场证据（`POST /api/play/text: HTTP 401:
unauthorized`），翻译它只会丢信息。收敛成一条是给播放循环准备的：每句都失败时，卡片应该
说「桥接器没有响应（×37）」而不是把 37 条相同的行灌满、把真正的第一条错误挤出去。
`note()` 与 `recent()` 都**不抛**（`recent()` 返回逐条拷贝）：描述故障的代码不能成为新的故障。

**二、谁往里写。** 四个位置，都是已经知道答案的地方：

| 位置 | 代码 | 触发 |
| --- | --- | --- |
| `lib/bridge.js` 的 `request()` | `bridge-rejected` | 桥接器答了 401/403（令牌不被接受） |
| 同上 | `bridge-error` | 其他非 2xx |
| 同上 | `bridge-unreachable` | 连不上（进程没跑、地址端口不对） |
| 同上 | `bridge-timeout` | 请求发出去了但没回来 |
| `lib/http.js` 的 `/asr` | `plugin-rejected` | 有人用错令牌调本插件（**bearer 不匹配的现场**） |
| `lib/index.js` 自动启动 | `start-failed` | `supervisor.start()` 失败或被抛异常 |
| `lib/index.js` 收集事实时 | `watchdog-gave-up` | 看门狗把退避预算用完了（§12.22） |

**三、`/health` 增发 `bridgeApi` 与 `diagnostics`。** 连接状态不是「进程在不在」而是
**当场问一次**：`collectFacts()` 调 `bridge.health({ timeoutMs: 1500 })`，得到

```
bridgeApi = { state, url, auth, error, checkedAt }
state = connected | unauthorized | unreachable | disabled
```

`connected` 就是 `/api/health` 回了 200（`auth` 取桥接器自报的 `bearer` / `loopback-only`，
见 §12.21），`unauthorized` 是 401/403，`unreachable` 是其余，`disabled` 是设置里关掉了
API Server（此时根本不探测）。探测超时特意收紧到 1500 ms：卡片回答的是「在不在」，
不该让人对着设置页等满一个播放超时（15 s）。**进程活着 ≠ 在服务** —— 还在 import 的
Python 半边、fork 之后崩掉的半边，都会显示成「进程在、接口不答」，这正是要区分的那一幕。

**卡片新增行**：桥接器接口（已连接/未连接/令牌被拒绝/已关闭）、服务地址、鉴权方式
（需要令牌/仅限本机）、访问令牌（已配置/未配置）、看门狗重启次数（仅在非零或已放弃时出现）、
已放弃重启时的 `lastError`、下次重启时间，以及**最近错误**块（最多三条，最新一条带
`status.lastError` 标签，重复的带 `×N`），没有错误时明确写「没有记录到错误」而不是留白。
目前跑着的桥接器进程是 3.11 之前启动的，所以 `auth` 会显示 `—`：重启一次即带上该字段。

**测试**：`scripts/check-diagnostics.mjs`（32 条）—— 存储、时间戳、镜像日志、收敛重复、
上限截断、长 detail 截断、空 code 不存、`clear()`、`recent()` 返回拷贝；再用假 `fetch`
分别喂 401 / 500 / 200 / `ECONNREFUSED` / 永不返回（靠 `AbortError` 结束），断言四种
code 与「探测成功时不记录」；最后断言七种 code 都在 `DIAGNOSTIC_CODES` 里。
`scripts/check-client.mjs` 新增第 9 组：源码级断言卡片确实引用了 `facts.bridgeApi`、
`facts.diagnostics`、每个 `status.*` 与 `diagnostic.*` 文案，并把 `lib/diagnostics.js` 里
列出的每个 code 与页面文案对账（漏一个就红）。`plugin-smoke.mjs` 则在**打过一次无令牌
`/asr` 之后**再拉 `/health`，断言 `bridgeApi` 四个取值之一 + `diagnostics` 里出现
`plugin-rejected`，也就是「bearer 不匹配真的会在卡片上留下痕迹」。

## 12.27 卸载与回滚：删掉能重建的，留下历史（4.6）

计划里 4.6 的原话是「`dsh plugin remove` 后收尾：`ctx.effect` 里 `kill` 进程树、
释放 4399/9092、清理插件数据目录」。前两件是行为，最后一件是**判断**——判断错了
就会毁掉用户的东西，所以这一节写清为什么这样切。

### 12.27.1 宿主不给「卸载」信号

查过 `dsh-plugin-manager`（`D:\WorkSpace\_oxb-wheels\asar-out\dsh\node_modules\`
与 `_oxb-wheels\x-plugin-manager`），只有 UI 包与类型文件，没有 removal 事件或
hook。插件被移除、DSH 正常退出、插件被重载，跑的都是同一段 `ctx.effect` teardown。
于是「卸载时清空」只能靠推测，而推测的代价是：**每次重启都删掉 `spoken.jsonl`**
——那正是第 3 期需求⑤「播报留痕」要求跨重启保留的文件。

### 12.27.2 按「能不能重建」切分

数据目录 `%USERPROFILE%\.dsh\xiaoai-bridge`（`lib/index.js:46 DATA_DIR_NAME`）：

| 条目 | 类别 | 谁写的 | teardown 处理 |
| --- | --- | --- | --- |
| `config.py` | generated | `supervisor.renderConfig()`，每次启动重渲染 | 删 |
| `bridge.pid` | generated | 启动时写、退出时清；teardown 发现进程没停干净就**保留**它 | 删（没收干净时留） |
| `render.py.tmp` | generated | `lib/render-config.js:197-205` 的临时文件（异常退出的残片） | 删 |
| `__pycache__/` | generated | Python 自己生成 | 删 |
| `bridge.log` | history | 桥接器 stdout/stderr，`lib/process.js:134` | 留 |
| `spoken.jsonl` | history | `lib/speech-log.js` 的播报留痕 | 留 |
| `devices.json` / `device.json` | history | 设备发现结果 | 留 |
| 其他任何文件 | other | 我们不知道是谁的 | 留，并写进 `kept` |

`lib/cleanup.js` 就是这张表：`classify(name)` 返回 `generated` / `history` /
`other`，`removeGenerated()` 只删第一类并返回 `{removed, kept, failed}`（4.13 起还接受
`{ keep: [...] }`，把指定条目排除在删除目标之外，保留项同时出现在 `kept` 里；teardown 只在
「`stop()` 成功且 4399 与 `apiServerPort` 都释放」时才不带 keep，否则保留 `bridge.pid` 并告警
`dsh-xiaoai-bridge: keeping generated files in <dataDir> (…); the next start adopts the leftover process`
——下一次启动靠 pid 文件里的 pid + 命令行身份把遗留进程接管回来，见 §12.22 与 §12.32.4），
`list()` 给目录不存在返回 `[]`，两种清理都**永不抛**（失败逐条 `logger.warn`）。
删目录用 `rmSync(path, { recursive: true })`，删其他条目用
`rmSync(path, { force: true })`：**不带 `recursive` 的 `rm` 只移除链接本身**，
所以一个名叫 `__pycache__` 的 junction 不会把它指向的目录一起带走
（`scripts/check-cleanup.mjs` 真的建了一个 junction 来验这件事）。

### 12.27.3 端口：证明它真的松手了

4399 是桥接器里 Rust `open_xiaoai_server` 的 AppServer（端口不可配，日志行
`[AppServer] ✅ 已启动: "0.0.0.0:4399"`）；9092 是插件自己的 API Server
（`apiServerPort`）。进程树由 `lib/process.js:562-576 killTree()` 收：Windows 上
`taskkill /pid <pid> /T /F`，其他平台先 `kill(-pid, SIGTERM)`。`stop()` 本来就会
先清掉看门狗的重启计时器、对被收养的进程轮询存活、超时后强杀。

teardown 之后新增 `reportHeldPorts(stopped)`：探测 `[4399, apiServerPort]`，
**探测地址跟着配置走**（4.13，R2-7）：取 `apiServerHost`，`0.0.0.0`、`::` 或空串都归一到
`127.0.0.1`（`0.0.0.0` 不是一个能连的地址），其余原样用；实现是 `lib/index.js` 的
`reportHeldPorts()`（约 `:540`），不是 `lib/ports.js`。若刚停过一个进程
（`stopped.stopped === true`）则等 200 ms 再探一次，然后
- 仍在应答 → `diagnostics.note({ code: 'port-held', detail: 'port N still accepts connections after the bridge was stopped (…)' })`，卡片上显示「端口在停止后仍被占用」；
- 插件这一轮**什么都没停** → 只写 `debug: port N is served by a process outside this plugin`，不记诊断（别人家的监听不是我们的错误）。

### 12.27.4 真要清空时：`POST /data/wipe`

`cleanup.wipe()` 是这个判断的另一半：它删**全部**条目，包括历史。它由一个显式
路由调用，body 必须是 `{"confirm":"wipe"}`，否则 400：

```powershell
# 卸载前（或卸载后目录还在时）清空播报留痕与日志
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<webServer 端口>/plugin/xiaoai/data/wipe `
  -ContentType 'application/json' -Body '{"confirm":"wipe"}'
```

路由沿用既有的 same-origin 白名单（`lib/http.js:159-171`：只放行
`http://<webServer.host>:<port>`、`localhost`、`127.0.0.1`；没有 Origin 的 curl
直接放行），因此页面上的任何一次设置保存都碰不到它——要删历史必须写明这句话。
返回 `{ok:true, dataDir, removed, failed}`：`removed` 是删掉的条目名，`failed`
是删不掉的，`ok:true` 不代表每一项都成功。

### 12.27.5 测试

`scripts/check-cleanup.mjs`（40 条断言）：分类表与不重叠、`removeGenerated()` 恰好删
`['__pycache__','bridge.pid','config.py','render.py.tmp']` 且历史与陌生文件都在、
`result.kept` 里报告了留下的那些、**keep 语义**（`removeGenerated({ keep: ['bridge.pid'] })`
后 `bridge.pid` 还在磁盘上、既不在 `removed` 里又在 `kept` 里，下一次不带 keep 的调用
仍然会删掉它）、二次调用无事可做、`wipe()` 清空整目录、目录不存在时两种清理都是 no-op、
junction 守卫（链接消失、被指向的 `precious.txt` 还在；无权限则打印 skip）、
端口探测（0 / 70000 非法；真起一个 `net.createServer().listen(0)` 断言绑定端口为
`true`、`server.close()` 后为 `false`；`heldPorts` 去重并过滤非法值）。
`plugin-smoke.mjs` 另加两条：`{"confirm":"please"}` → 400，
`{"confirm":"wipe"}` → 200 且 `removed` 是数组（临时 `DSH_HOME` 里没有残片，
所以为空数组）。

## 12.28 README / CHANGELOG / 署名 / 合规自查（4.7–4.10）

### 12.28.1 一份中文 README，不是双语

用户原话（m06364）：「就一个中文readme就行了。这插件外国人谁用啊」——因此放弃
「`README.md` + `README.zh.md` + 语言导航」的双语方案，只保留根目录一份中文
`README.md`。写法按 `github-dev` 技能的 §3.1 与同伴仓库 `D:\WorkSpace\Github\dsh-fishpai\README.md`
（用户点名参考）：Hero（`<div align="center">` + `<h1>` + 两行标语 + 5 枚可点盾牌 +
`•` 分隔的锚点导航）、`## 这是什么`、`## 核心特性`（两列表，首列纯加粗）、
`## 工作原理`、`## 快速开始`、`## 模型工具`、`## 配置项`、`## 数据放在哪`、
`## 排错`、`## 开发`，底部收成恰好三节（更新日志 / 支持与致谢 / 许可证与作者）。
全文零 emoji、不写 `---`（GitHub 给 h2 自带下边框，写了反而多一条横线）。

### 12.28.2 图片：只有徽章，原理图用 Mermaid

用户选择「不要图片文件：架构图用 Mermaid」，所以仓库里没有 logo、没有截图：
`## 工作原理` 用 Mermaid flowchart（GitHub 原生渲染）。Hero 按 §3.1 本该放 logo
（fishpai 放的是 `raw.githubusercontent.com/OMSociety/dsh-fishpai/main/logo.png`），
本仓库跳过——没有可指向的图片，也不为一张 logo 往仓库塞二进制；要补就是加一个
`docs/logo.svg` 再把绝对 raw URL 写进 Hero。

5 枚盾牌的取舍：Version / DSH / License 用 `img.shields.io/badge/...` **静态**徽章
（与仓库是否存在无关，版本号与 `package.json` 手写同步）；Stars / Issues 用
`github/stars`、`github/issues` 动态徽章指向 `OMSociety/dsh-xiaoai-bridge`。
写这一节时该仓库还不存在（2026-10-03 实测 404，`img.shields.io` 对不存在的仓库
返回 `stars: repo not found` 的兜底徽章——是图不是破图），随后**用户手动 fork
并脱离了 fork 网络**，仓库现在是 public、默认分支 `main`、`isFork = false`；
本地 `main` 的基点 `b2d8384`（上游 `feat: 添加 OpenAI-compatible TTS / MLX-Audio
TTS provider (#28)`）正是该仓库 `main` 的当前提交，本地领先 26 个提交，
推送即快进。DSH 徽章写 `>=0.2.0-rc.1`，对齐 `package.json` 的 `peerDependencies` 线。

### 12.28.3 快速开始的两条路

- **方式一（推荐）clone 到本地再装**：Python 那一半需要一份可写 checkout——
  `bridge/.venv` 与 `bridge/core/models/` 都落在里面。命令是
  `uv sync --no-install-project` + `uv sync`（Rust 扩展现场编译，本机第一次约十几分钟，
  见 §5.0 的 0.8 记录）。
- **方式二 `dsh plugin --profile desktop add "github:OMSociety/dsh-xiaoai-bridge#main"`**：
  只装插件那一半。为了让这条真的可用，`package.json` 的 `files` 补了 `bridge/`
  （92 个 tracked 文件、约 1 MB）；git 路径只取 tracked 的文件，所以 `.venv` 与
  `**/models` 不会跟着走（打包那条路的实测与陷阱见 12.28.6）。
  否则 GitHub 装出来的插件永远起不了桥接器。虚拟环境与模型包仍需自行准备。
  **ref 用分支 `#main` 而不是 `#v0.2.8`**：仓库里唯一的 tag 全是上游的
  （`v1.0.0`…`v1.0.7`、`baseline`、`vad-kws-asr-models`），插件的版本从来没有打过 tag
  （`CHANGELOG.md` 头部明说），写一个不存在的 ref 会直接报 no matching ref。
  将来要按版本固定安装，就先给插件版本打 tag，再改这一行。
- profile 一律写 `desktop`：本机 `%USERPROFILE%\.dsh\profiles\desktop\node_modules`
  下确实装着 `dsh-xiaoai-bridge`（`headless` 没有）。

### 12.28.4 CHANGELOG 改成中英双语

按 `github-dev` §3.2：标准长式头部（`# Changelog` + 中英各一句 + 中英格式说明，
链到 keepachangelog 的 zh-CN / en 与 semver 的 zh-CN / en 页），版本标题
`## [x.y.z] - YYYY-MM-DD` 中英共用，`## [Unreleased]` 不带日期，**中文分类在上、
英文分类在下**，不加 `### 中文` / `### English` 包裹标题，英文与中文逐条 1:1。
头部另保留两段项目事实（中英各一段）：本文件只记根目录的插件（版本从 `0.1.0` 起）、
`bridge/` 是上游 fork 并保留上游历史与 tag、**插件自己的版本没有打 tag**。
历史版本（0.1.0–0.2.8）的英文是从既有中文条目直译补的，事实与日期不动。

### 12.28.5 署名与许可

`LICENSE` 的上游两行（`Copyright (c) 2024 Del Wang`、`Copyright (c) 2025-present
coderzc`）原样保留，第 5 行追加 `Copyright (c) 2026 OMSociety`。README 底部
「支持与致谢」列三个上游（coderzc/open-xiaoai-bridge、idootop/open-xiaoai、
deepseek-ai/dsh），「许可证与作者」点明三行版权各自的归属。`DISCLAIMER.md`
不改（中文免责 + License Notice），Hero 下方保留一条引用块指向它。

### 12.28.6 合规自查（4.10）

- **依赖对齐**：`lib/client.js:47` 真的 `require("@deepseek-ai/dsh-client-ui-primitives")`，
  此前该包只在宿主运行时里存在、清单里没声明 → 补进 `peerDependencies`
  （`^0.2.0-rc.1`）。宿主侧 `lib/index.js:43` 的 `inject`（tools / skills / settings /
  credentials / agents）加上 `lib/index.js:479` 的 `ctx.inject(['webServer'])`，
  与实际调用一致；`workspaceRegistry` 与 `llm` 是软查找（`ctx.get`），故意不进 `inject`。
- **包内容**：`files` 纳入 `bridge/`、`CONTRIBUTING.md`、`DISCLAIMER.md`
  （README 链到的文档必须随包走）。
- **打包实测（新加 `.npmignore`）**：`files` 白名单只保证「列了什么」，
  不保证「列进去的目录里被 `.gitignore` 挡掉的东西不进来」。2026-10-03 实测：
  `pnpm pack`（12.6.0）在本仓库产出的 tarball 是 **753,788,062 字节**，
  含 `bridge/.venv`（6,654 项）、`__pycache__`（784 项）与 `bridge/core/models`；
  加 `.npmignore` 之后**数值一模一样**（pnpm 在 `files` 白名单下不读它）。
  本机 `npm pack` 直接坏掉（`Exit handler never called!`），没法用 npm 复核。
  两条文档化的安装路径都不经过打包：本地安装记成
  `"dsh-xiaoai-bridge": "link:D:/WorkSpace/Github/dsh-xiaoai-bridge"`（软链，不复制），
  GitHub 安装取的是 git 树里 tracked 的文件。`.npmignore` 留着是给
  npm 侧打包/发布用的守卫（npm 的 packlist 读它），注释里写明了这次实测。
- **不入库复核**：`git ls-files` 里没有 `bridge/device.json`（`.gitignore:79`）、
  `pnpm-lock.yaml`（`.gitignore:69`）、渲染产物 `config.py.rendered`、`*.token`
  与任何凭据文件；`bridge/config.py` 是上游模板，必须入库。
- 新增 `CONTRIBUTING.md`（计划目录树里列了它）：环境、提交前要跑的八个 checker 与
  pytest、改东西去哪、文档纪律（零 emoji、不写 `---`、只写最终状态、版本号变更先报备）
  与上游同步方式。

### 12.28.7 验证

文档类改动不动代码，回归仍以离线检查与 `bridge` 的 pytest 为准，结果记在提交信息里。
（当时是八个 checker；4.13 第二批加到九个，见 §12.32.6。）仓库外的
`D:\WorkSpace\_oxb-wheels\plugin-smoke.mjs` 覆盖 `/asr` 鉴权、`/config` 冲突与
`POST /data/wipe`，可以顺手当回归用，但**它不在版本库内、不算既有 CI**，也别在文档里
当既成事实引用——口径与根 `AGENTS.md` 的「验收标准」末段一致。README 的锚点按 §3.1 的
`id="user-content-([^"]+)"` 逐个核对（中文标题的锚点就是标题本身，如 `#排错`）。
另有两个一次性脚本做过机器校验（放在仓库外的 `D:\WorkSpace\_oxb-wheels\`）：
`doc-check.mjs`（emoji、独立 `---`、表格列数、README 锚点与标题对照）与
`changelog-check.mjs`（版本标题与日期格式、中文分类必须在英文分类之前、
中英条目数 1:1）。

### 12.28.8 子代理复核（4.11）

README / CHANGELOG / CONTRIBUTING 三份文档交给一个只做事实核对、不改文件的子代理，
按十类逐条对代码与 git 历史：配置键与默认值（对 `lib/config.js:98-177` 的 `DEFAULTS`
与 `lib/config.js:189+` 的 schema）、四组 HTTP 路由（`lib/http.js:184` / `:196` /
`:211` / `:374` / `:334-360`）、诊断编码（`lib/diagnostics.js:24-41`，当时八个；**当时的
README 排错表顺序与代码数组相反**，这一条复核没看出来，4.13 批次才改正，见 §12.31.2，
同一批的第二段又加了 `token-not-applied` 变成九个，见 §12.32.1）、
checker（当时八个，`package.json` 的 `scripts.check` 只跑 client，文档逐条列是对的；
4.13 批次加了聚合入口，第二批加到九个，见 §12.31.4 与 §12.32.6）、
模型工具（`lib/tools.js:12` 的 `SPEAK_TOOL_NAME` 只声明 `text`）、端口与数据位置
（`lib/ports.js:17` `SPEAKER_PORT = 4399` 与 `bridge/native/src/server.rs:89` 的
`"0.0.0.0:4399"`、`lib/cleanup.js` 的 GENERATED/HISTORY 切分）、零 emoji 与无 `---`、
相对链接存在性、版本标题与提交映射（0.2.8 对 80d8df2 … 0.1.0 对 `9ddb541` 等三个提交）。

**8/10 类干净，报了两条 minor、两条 nit**，逐条落地如下：

- **`#v0.2.8` 这个 ref 不存在（真问题，已改）**：见 12.28.3，改成 `#main`。
- **「`scripts/check-speak.mjs` 记错版本」（复核实为误报，不改）**：复核说 0.2.7 那条
  把 checker 归错了版本。实测 `git show --stat 057afba` 只动了
  `scripts/check-client.mjs` 与 `scripts/check-diagnostics.mjs`，而 `CHANGELOG.md`
  的 0.2.7 段写的是 `check-diagnostics.mjs`（正确）；提到 `check-speak.mjs` 的只有
  0.2.5 段，`git log -- scripts/check-speak.mjs` 恰好是 `0724a0f`（0.2.5）、
  `b782e93`（0.2.3）、`a9929dd`（0.2.0）——与文档一致。故不改。
- **`sessionCwd` 的措辞（nit，已改）**：实际回退链是
  `lib/session.js:285-304`（配置值 → `workspaceRegistry.list()[0].path` →
  `process.cwd()` → `homedir()`），README 原写「空则用 DSH 默认」；改成与插件设置页
  提示一致的说法「空则用第一个工作区」（`lib/client.js:178`）。
- **`ttsProvider` 的选项文案（nit，已改）**：改成与 `lib/client.js:144-146` 相同的
  「跟随音色 / 小爱原生 / MiMo（预留，暂不生效）」。

### 12.28.9 推送与实机验收的状态

`OMSociety/dsh-xiaoai-bridge` 由用户手动 fork 并脱离 fork 网络（public、默认分支
`main`、`isFork = false`）。本地 `main` 的基点 `b2d8384` 与之相同、领先 26 个提交，
所以第一次推送是快进（实测 `b2d8384..391ae8b main -> main`，远端 `main` 与本地
一致，`git ls-remote … refs/heads/main` 也解析到同一个提交——README 的 `#main`
因此真的可装）。推送后 Issues 徽章立即变成真实数值；Stars 徽章因为 shields 把
「仓库不存在」这个负结果缓存了一段时间，仍旧显示 `repo not found`（用
`&cacheSeconds=1` 实测已经不是负结果），等缓存过期自会恢复，不必改 URL。
**实机验收（第 4 期那六条）仍待用户重启 DSH**：插件在 profile 里是
`link:D:/WorkSpace/Github/dsh-xiaoai-bridge`，重启即载入当前工作树，无需重新安装。

### 12.29 写给编码 agent 的 AGENTS.md（4.12，计划外增补）

#### 12.29.1 为什么加

仓库此前没有根级 `AGENTS.md`，只有 `bridge/AGENTS.md`（**基于上游原文的 fork 增补版**，375 行，
管 Python/Rust 侧），但它不是「上游原文」——经 `git diff` 核对：`git cat-file -p
upstream/main:AGENTS.md` 是 388 行、`git diff --stat upstream/main:AGENTS.md
HEAD:bridge/AGENTS.md` 是 72 insertions / 85 deletions（同一次核对里 `bridge/CHANGELOG.md`
12/12 品牌字样原位替换、`bridge/README.md` 108 insertions / 528 deletions）。改写发生在
`09ef117 refactor(bridge): drop legacy connectors and wire the DSH backend`，**不是** fork 的
初始提交（`00089e1` 是原样搬移，`git diff b2d8384:AGENTS.md 00089e1:bridge/AGENTS.md` 为空），
所以「未改」的说法不成立，文档一律按上面这组数字写。根目录这一半（Node 插件）的命令、模块边界与禁区没有任何机器可读的入口——README
讲的是「怎么用」，CHANGELOG 讲的是「改过什么」，都不是「你该怎么做改」。当前会话里由
用户点名要这份文件。

#### 12.29.2 按哪个技能写

本机技能 `C:\Users\Administrator\.dsh\skills\agent-md-creator\`（`SKILL.md` 147 行，另有
`references/section-guide.md`、`references/anti-patterns.md`、`references/ci-check.md`、
`assets/{AGENTS.md,module-AGENTS.md}.tmpl`、`scripts/check_agents_md.py`；本会话的工具面板
没装载这个技能，直接读盘上的文件照做）。三条硬原则：机器可读、渐进式披露（目标 ≤200 行、
硬上限 500 行）、规范行为而非描述状态；只写工具管不住的东西——八个 checker 已经守住的
事实不重复描述，只写「改哪类东西要跑哪个检查」。

#### 12.29.3 机器校验

```powershell
python C:\Users\Administrator\.dsh\skills\agent-md-creator\scripts\check_agents_md.py --root D:\WorkSpace\Github\dsh-xiaoai-bridge
```

第一版报 1 条 warn：把 `Get-ChildItem scripts\check-*.mjs | ForEach-Object { … }` 那行当
命令解析，`Get-ChildItem` 既不在仓库配置里也不在 PATH 上（PowerShell 内建命令本来就不是
可执行文件）。改成八条逐行 `node scripts\check-*.mjs` 后 **error 0 / warn 0**；唯一的
info 是 `bridge/AGENTS.md` 375 行超过 200 行的建议预算——它是基于上游原文的 fork 增补版
（见 §12.29.1），本批次不动它的既有内容。
成文 128 行（4.13 时又补了「改 Rust」链与两条排错，见 §12.30.3）。

#### 12.29.4 盲测与它抓出来的四处缺口

派了一个只拿到这份 `AGENTS.md` 的子代理（`6ea8b41d-786d-4078-9486-fd31200fc91b`，明确
不许读仓库里其它文件），问三个问题：怎么跑测试、改 `lib/client.js` 前后必须做什么、
三条禁令与理由。三问都答得出，但它报出四处缺口，都已补进成文：

1. 八条 node 检查用的是相对路径，却没说工作目录 → 补「工作目录都是仓库根，在别处跑会
   直接报找不到文件」。
2. `90 passed, 19 subtests` 是「必须等于」还是「不许低于」没定义 → 补「基线只许升：变大
   是新增测试，变小说明有测试被删或被跳过，要查清」。
3. 「改界面」这条链没写动手前读什么，而它旁边的「改 teardown」「改 `bridge/`」都写了 →
   在「修改契约」开头补一段通用必读（README 配置项与排错表、CONTRIBUTING 约定、
   `docs/deploy.md` 相关 §12.x）。
4. 风险区说 `lib/client.js` 「改完必跑 `check-client`」，验收标准第 3 条却要求真机核对，
   两处口径不一致 → 风险区那行补「可见行为还要按验收标准第 3 条重启后核对」，并写明
   `check-client` 能拦住什么（语法、模块形态、席位注册）、拦不住什么（真机交互与桥接器
   进程行为）。另外补一条优先级规则：一次改动跨多条链时相关检查取并集。

#### 12.29.5 随附改动

- `CONTRIBUTING.md` 开头一句话后加「给编码 agent 的硬规则（命令、模块边界、禁区、验收）
  见 [AGENTS.md](AGENTS.md)」——`CONTRIBUTING.md` 是给人看的流程，`AGENTS.md` 是给 agent
  看的判据，互相指一下。
- `package.json` 的 `files` 纳入 `"AGENTS.md"`（与 `CHANGELOG.md`/`CONTRIBUTING.md`/
  `DISCLAIMER.md` 同一处理），`node -e` 校验 JSON 合法。
- 纯文档改动，版本仍为 `0.2.8`（沿用仓库既有习惯：文档提交不 bump）。

#### 12.29.6 维护

`AGENTS.md` 末尾写明与代码同 PR 更新，并点出四类「必须同步」的改动：验收命令
（`scripts/check-*.mjs` 的增删）、模块边界与端口、`.gitignore` 的禁区、profile 的安装
方式。`bridge/` 侧规则仍归 `bridge/AGENTS.md`，冲突时以更接近改动点的那份为准。

### 12.30 静默启动：让「已连接」提示音可关（4.13，计划外增补）

#### 12.30.1 需求与取证

用户重启 DSH 实机试用后反馈：桥接器连上音箱时会播一句「已连接」，希望做成可配置项。全仓搜这四个字，只有一处会出声：`bridge/native/src/server.rs` 里 `async fn test()` 的 `SpeakerManager::play_text("已连接").await?;`——由同一个文件里 `tokio::spawn` 延迟 1 秒调起的那段（`TaskManager::instance().add("test", test)`），错误用 `let _ =` 吞掉，所以**这句提示音不写任何日志**：A/B 实测两轮日志一模一样，出不出声只能靠耳朵。同文件的 `pylog!("[AppServer] ✅ 已连接: {:?}", addr)` 只是设备接入日志，与提示音无关。

**行号取证口径**：本小节的行号是**改动前**（HEAD `7aa3595~1`）的值——上面的播报在那时是 `server.rs:34`、`tokio::spawn` 那段是 `:134-137`、`pylog!` 是 `:113`、拉起子进程是 `lib/process.js:482`；在 HEAD 上同一处已经漂移（分别约 `:49`、约 `:137-140`、约 `:129`、约 `:500`，最后一个还正被进程托管批次改着）。引用时以符号为准（`play_text`、`pylog!`、`spawn`），别照抄裸行号。

链路位置：插件侧 `lib/process.js` 里以 `python main.py`（cwd = `bridge/`）拉起桥接器的那次 `spawn(...)`（取证时 `:482`，HEAD 约 `:500`）拼子进程环境；「设置项 → 环境变量」这条链此前没有集中点。

#### 12.30.2 怎么关

- Rust：新增 `is_silent_start()` 读 `SILENT_START_ENABLE`，真值表与既有的 `is_audio_input_enabled()`（`:20-31` 读 `AUDIO_INPUT_ENABLE`）一致，接受 `true`/`1`/`yes`/`on`；区别是**未设或非法一律 false**——默认照旧出声，升级前后行为不变。播报包进 `if !is_silent_start() { … }`。
- 插件：`lib/config.js` 的 `DEFAULTS` 与 schema 两处加 `silentStart`（默认 `false`，`live(z.boolean())`，与 `autoStart` 同段 `process`）；`lib/client.js` 中英两张表加「静默启动 / Start silently」与提示语，FIELD 表加一条布尔控件；`lib/process.js` 把子进程环境抽成导出的纯函数 `bridgeChildEnv(cfg, configPath)`，`SILENT_START_ENABLE` 在其中（`cfg.silentStart ? '1' : '0'`），凭据注入仍在它之后单独追加。
- 为什么抽纯函数：环境映射从此能被离线断言，不必起进程。

#### 12.30.3 改 Rust 的代价：`.pyd` 被占用

`bridge/pyproject.toml` 的 `[tool.uv] cache-keys` 含 `native/src/**/*.rs`，改 `.rs` 后 `uv sync` 会重编译。第一次失败：

```text
error: failed to remove file D:\WorkSpace\Github\dsh-xiaoai-bridge\bridge\.venv\Lib\site-packages\open_xiaoai_server\open_xiaoai_server.pyd: 拒绝访问。 (os error 5)
```

原因：桥接器正在跑，`.pyd` 被占用（wheel 其实已编译成功，只是装不进去）。解法：`POST http://127.0.0.1:19387/plugin/xiaoai/bridge/stop`（这条路由不要凭据，只有 `/asr` 校验 bearer）→ `uv sync`（复用缓存，18 ms）→ `POST …/bridge/start`。`uv` 不在 PATH，本机在 `C:\Users\Administrator\.local\bin\uv.exe`。这条坑已进 `AGENTS.md` 的「改 Rust」链与「出错怎么办」表。

#### 12.30.4 验证

- 装上了没有：`bridge\.venv\Lib\site-packages\open_xiaoai_server\open_xiaoai_server.pyd` 的 LastWriteTime = 2026/10/3 02:55:47、7,668,224 字节，二进制里能搜到 ASCII 串 `SILENT_START_ENABLE`（同处还有 `AUDIO_INPUT_ENABLE`）。
- A/B 实测：同一份配置各跑 11 秒（`Start-Process … python -u main.py`，env `DSH_ENABLE=1`/`API_SERVER_ENABLE=1`/`AUDIO_INPUT_ENABLE=1`/`LOG_LEVEL=INFO`/`CONFIG_PATH=<数据目录>\config.py`，跑完 `taskkill /T /F`；**这一行照抄当时真实跑过的命令，不改写历史**：其中的 `LOG_LEVEL` 是死键，桥接器读的是 `LOGLEVEL`，见 §12.31.1）：第一轮不设 `SILENT_START_ENABLE`，第二轮设 `SILENT_START_ENABLE=1`。两轮都在建服后 0.3–0.7 秒接入设备（`[AppServer] ✅ 已连接: 192.168.1.191:56304` / `:56312`），而 `test()` 在 +1 秒才执行——**日志证明不了是否出声**，听觉结论以用户为准。
- 离线断言：`scripts/check-config.mjs` 现在同时覆盖 `lib/process.js`，断言默认 `SILENT_START_ENABLE === '0'`、`silentStart: true` 时 `'1'`、`CONFIG_PATH` 原样透传、`API_SERVER_PORT` 仍是字符串、且环境里**不含** `XIAOAI_API_TOKEN`（凭据只走 `childEnv()` 的后追加）。
- 回归：八个 checker 全绿（`check-client` 的 Switch 计数须从 5 改成 6 才过——新增布尔控件会让它失败，这是提醒不是 bug）；`uv sync` 清掉了 pytest，重装后 `90 passed, 19 subtests passed`；未入库的冒烟脚本 exit 0。

#### 12.30.5 版本与生效条件

版本仍是 `0.2.8`，没有 bump（仓库纪律：改版本号先报备）。宿主半的 `lib/*.js` 改动要**重启 DSH** 才生效——本次作业结束时桥接器已恢复运行（pid 45628），但 DSH 仍是改代码之前启动的，所以设置页暂时看不到「静默启动」，且旧代码不传 `SILENT_START_ENABLE`，启动仍会播提示音；重启后可在设置页开「静默启动」。

### 12.31 文档与打包收口（4.13，计划外增补）

#### 12.31.1 死键 `LOG_LEVEL` → `LOGLEVEL`（R7-2-1）

设置页的「日志级别」此前被拼成 `LOG_LEVEL`，而桥接器读的是 `bridge/core/utils/logger.py` 里的
`os.environ.get("LOGLEVEL", "INFO").upper()`——那个开关看起来生效、实际什么都没做（§12.30.4 的
A/B 记录里那条 `LOG_LEVEL=INFO` 就是死键的现场证据）。修法：`lib/process.js` 的
`bridgeChildEnv()` 改成 `LOGLEVEL: String(cfg.logLevel ?? 'INFO')`（注释里写明旧键是死的），
`scripts/check-config.mjs` 加断言。历史命令**不改写**，只在 §12.30.4 那一行加括注指到这里。

#### 12.31.2 行号漂移：文档改认符号

外部复核指出两处裸行号已经漂了：根 `AGENTS.md` 说导出服务依赖在 `lib/client.js:1254`，实际
`var inject = ["slots","locale"]` 在 `:1259`（`:1254` 是状态卡 JSX）；说 `"0.0.0.0:4399"` 在
`bridge/native/src/server.rs:89`，实际在 `:105`（`:89` 是 `.status(401)`）。同类裸行号在根
`AGENTS.md` 里还有七处。**改法**：契约定成「符号 + 近似行号」，逐条换成 `inject` /
`ctx.inject` / `BUNDLE_SLOT` / `DATA_DIR_NAME` / `SPEAKER_PORT` / `DIAGNOSTIC_CODES` 这类全仓唯一的
符号——`lib/client.js` 是手写产物、随时会被别的批次改动，行号只能当锚点。诊断码顺序以
`lib/diagnostics.js` 的 `DIAGNOSTIC_CODES` 数组为准（README 排错表原来把 `bridge-timeout` 和
`bridge-error` 写反了，已按代码顺序重排）。

#### 12.31.3 Windows 上 `config.py` 的原子替换会撞热重载读窗口（R1-2）

- **现象**：设置页保存后，`lib/render-config.js` 用「临时文件 + `renameSync`」原子替换
  `<DSH_HOME>/xiaoai-bridge/config.py`，而桥接器每秒轮询该文件的 mtime 做热重载。Windows 上
  如果 rename 正好落进那次读的窗口，`renameSync` 抛 `EPERM`；旧实现不重试，于是宿主回 200 而
  `body.config.ok === false`，页面当时只看 `body.ok`，结果显示「已保存」但磁盘上还是旧配置。
- **修法**：`lib/render-config.js:33` 新增 `export const RENAME_ATTEMPTS = 40;`、`:36`
  `export const RENAME_RETRY_MS = 5;`，`:55` 的内部函数 `installAtomically(from, to)` 只对
  `EPERM` / `EACCES` / `EBUSY` 三个瞬时码做有界重试，其它错误立即抛出；睡眠用同步
  `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)`（调用方本身就同步），失败时
  先清掉半成品 `.tmp` 再 rethrow，清理失败不掩盖原错误。**计时口径**：Windows 的定时器粒度让
  整整 40 轮实际约 **0.6 s**，不是 40×5 ms = 200 ms——本机实测 **614 ms**。
- **取证（本机 Windows，2026-10-03，只记方法与结果）**：用一个**不共享 DELETE** 的外来句柄打开
  目标文件（`[System.IO.File]::Open($target,'Open','Read','None')`，等价于「不共享 DELETE 的
  读者」），在锁被持有期间——无锁对照写入 `ok in 2 ms`；旧路径裸 `renameSync(tmp, target)`
  **抛 `EPERM`**；新路径 `installAtomically`（锁在写入过程中约 110 ms 时释放）**`ok in 165 ms`**；
  事后 `tmp left behind: false`，目标文件内容已是新值。取证脚本是仓库外一次性的，不属版本库。
- **离线兜底**：`scripts/check-config.mjs:185-205` 补三条断言——把目的地做成**目录**（原子替换
  永远无法成功）时 `writeConfig` **必须抛错**（`an uninstallable destination fails loudly (…)`）、
  **必须清掉自己的 `.tmp`**（`a failed install cleans up its own temp file`）、**必须不动既有路径**
  （`a failed install leaves the existing path alone`）；该负路径跑满 40 轮才抛，本机实测约
  **614 ms**。跨进程的文件锁无法在单进程 checker 里复现，所以 checker 守负路径、正路径靠上面
  这份取证（checker 的注释里也写明指向本节）。

#### 12.31.4 聚合入口与发布面

- `package.json` 的 `scripts.check` 此前只跑 `check-client.mjs`，且 `files` 白名单不含
  `scripts/`——装包副本里 `npm run check` 直接 ENOENT。新增 `scripts/check-all.mjs`
  （`spawnSync(process.execPath, …)` 按序跑八个、`stdio: 'inherit'`、任一非 0 即整体非 0），
  `check` 改指它并保留 `check:client`，`files` 纳入 `scripts/`。
- `docs/deploy.md` 从 `files` 里摘掉（它含本机绝对路径与子代理会话 ID），README / AGENTS.md /
  CONTRIBUTING.md 中指向它的链接改成绝对 GitHub URL——仓库内与装包副本里都能点。
- `package.json` 补 `repository` / `bugs` / `homepage` / `author` 与 `"private": true`。
  `private` 只挡 `npm publish`，不影响 `dsh plugin add github:…`（那条路径是 pnpm 的 git 依赖，
  不经过 registry 发布）。
- `bridge/docker-compose.yml` 随包发布，但拉的是上游镜像
  （`ghcr.io/coderzc/open-xiaoai-bridge:latest`，没有 `build:`）——照它部署拿到的是**没有 bearer
  门禁**的上游桥接器，与本插件「默认带鉴权」的承诺脱节。文件顶部加 YAML 注释写明这点并指向
  `uv sync` 本地运行，`bridge/README.md` 的 Docker Compose 与 Docker FAQ 两段同步提示。没改成
  `build: .` 是因为本轮无法验证 fork 的 Dockerfile 能构建出带鉴权与 DSH 接线的镜像。

#### 12.31.5 口径更正：`bridge/` 那三个文件不是「上游原文」

根 `AGENTS.md` 与 §12.29.1 曾把 `bridge/AGENTS.md` / `bridge/README.md` / `bridge/CHANGELOG.md`
说成「上游原文、未改」，并据此写了禁改令。经 `git diff` 核对这是假的（数字见 §12.29.1），
三份文件一律改写成「基于上游原文的 fork 增补版」，禁改的理由改成**避免二次改写**（上游同步时
容易冲突、署名容易再次失真），不是「它还是原文」。同时修掉 `bridge/README.md` 里指向不存在的
`bridge/LICENSE`、`bridge/DISCLAIMER.md` 的相对链接（改指仓库根）与上游作者的绝对路径死链。

#### 12.31.6 验证

`node scripts/check-all.mjs`（当时是八个 checker 的聚合入口；同一批的第二段加到九个，
见 §12.32.6）、`node scripts/check-config.mjs`
（`LOGLEVEL` 断言）、`bridge/` 里的 pytest；仓库外的 `doc-check.mjs`（零 emoji、无独立 `---`、
表格列数、README 锚点对标题）与 `changelog-check.mjs`（版本节与日期、中英条目 1:1）各跑一遍
都必须过。文档类改动不动代码，回归口径见 §12.28.7。

#### 12.31.7 语音会话的模型在创建时钉死（R6-6，有意保留的取舍）

- **事实**：语音会话的 agent 路由在**会话创建时**捕获一次——`lib/session.js:430` 的
  `setup: modelSelectionSetup(await resolveModelInstaller(), selection)`，而 `modelSelectionSetup()`
  （`:164`）把 `selection` 放进 `const mutable = { current: selection, assembled: undefined }`，
  此后**本插件没有任何地方写它**（宿主 installer 每次拼 prompt 读 `current`，`:158-159` 的注释
  写明这一点）；`deliver()` 的复用路径 `:441-444` 命中 live agent 就直接 `return live`，不会重新
  解析模型。
- **对照**：回复器半边每次调用都重新解析——`lib/replyer.js` 的 `resolveReplyerRoute(cfg, fallback)`
  （`:159-171`）先读设置里的 `replyerProvider` / `replyerModel`，为空才回落到会话路由。
- **因此**：改默认模型（或会话的模型选择）**立刻**对回复器生效，但语音会话要**重启 DSH** 之后
  才用上新模型。README 的 `replyerProvider` / `replyerModel` 行也写了这条限制。
- **为什么保留**：这与 DSH 自己的会话语义一致（一场会话的模型在它开始时就定了），把路由做成本
  进程内可变会和 DSH 的会话模型打架；而且「换模型」的正确姿势本来就是开一场新会话。将来真要
  改，动的是 `lib/session.js`：让复用路径也重新解析并写 `mutable.current`（并在 `mutable` 上
  暴露 setter）——那是一次行为变更，不是补一个小功能。

#### 12.31.8 语音指令的威胁模型：能到 `/asr` 就等于拿到了 agent 输入通道（R3-5）

- **事实**：`/asr` 的正文是识别出来的语音，也就是**不可信输入**，它会被当成 DSH 会话里的一条
  user message。`lib/http.js` 的 `/asr` 路由上有一段 `THREAT MODEL (R3-5)` 注释（`:506-518`）
  写明：谁能到这个路由，谁就能用「用户自己的声音」要求 agent 做事。
- **机械保障只有两条**（`:509-513`）：(1) bearer 门禁；(2) 宿主既有的审批流——审批门槛上的
  工具运行时，音箱只会念一句固定的「需要你到电脑上确认一下」（`approvalText`，默认值在
  `lib/config.js`，播报逻辑在 `lib/auto-speak.js:311-325`），**审批请求正文从不念出来**，真正
  决定工具调用的是宿主。
- **缺的是什么**（`:514-518`）：没有语音专用工具集，也没有逐句审批策略，这是**架构性的**——
  一句话拿到的权限就是它落进的那场会话的权限。`agents.create` 在这里也**没有**设 approval
  policy 或受限工具集（`lib/session.js:465` 的 `agents.create({ sessionId, meta, ...factory })`，
  该文件里搜 `approval` / `permission` 零命中）。所以危险动作的约束基本上只靠提示词 + 宿主既有
  审批流。
- **因此这是架构限制、不是缺陷**：本插件不在语义层拦指令；能收紧的旋钮在宿主侧——对本插件
  agent 生效的 approval policy，以及「哪些工具允许免审批」。
- 顺带：`/asr` 故意不看 `req.socket.remoteAddress`（`:526-529`）——本机进程本来就在插件的信任
  边界里（`POST /config`、`/bridge/start`、`/data/wipe` 都按设计不鉴权），加 loopback 判断不增加
  安全性反而会破坏桥接器调用；信任域的显式说明见 §12.32.7。README 里有面向使用者的同一段
  「安全边界（限制）」。

### 12.32 实现与文档的第二轮收口（4.13 第二批）

#### 12.32.1 新诊断码 `token-not-applied`（R3-6）

`lib/diagnostics.js:24-43` 的 `DIAGNOSTIC_CODES` 从八个变成九个，新码排在 `port-held`（`:40`）
之后（`:42`）。触发点是 `collectFacts()`（`lib/index.js` 约 `:322`）：先 `tokenReady = await
tokenConfigured()` 与 `bridgeApi = await state.probeBridgeApi()`，若
`bridgeApi.auth === 'loopback-only' && tokenReady`，说明**桥接器先于 API 令牌启动**，只能停在
无令牌的 loopback 模式，于是记一条 detail 固定的诊断——
`the bridge started before the API token existed; restart the bridge to apply it`，level 是
`warn`（`lib/diagnostics.js:92`：`level === 'warn'` 走 `logger.warn`）。同一码用
`diagnostics.recent().some(...)` 去重，不会每次轮询都刷一条。选 `warn` 而不是 `error`：
桥接器功能正常，缺的只是一次重启。

#### 12.32.2 `spoken.jsonl` 的上限与单槽轮转（R6-1）

`lib/speech-log.js:34` `SPOKEN_LOG_MAX_BYTES = 5 * 1024 * 1024`（5 MiB）、`:31`
`SPOKEN_LOG_ROTATED_FILE = 'spoken.jsonl.1'`（**单槽**）。写入前按 `bytes = await size() + length`
判断，超限就把整份留痕轮转过去。Windows 的 `rename` 覆盖不了已存在的目标，所以实现是「先删旧槽
再改名」——结果是**只保留上一代**：上一次的 `spoken.jsonl.1` 会被这一次覆盖。轮转失败只 warn
一次（`:59` `let warnedRotation = false`，文案 `dsh-xiaoai-bridge: spoken log rotation failed: …`），
然后继续追加，不丢记录。`collectFacts()` 新增的 `spokenLogBytes` 就是
`createSpokenLog(...).size()`。`spoken.jsonl.1` 已列入 `lib/cleanup.js:39` 的 `HISTORY_FILES`
（`['bridge.log', 'spoken.jsonl', 'spoken.jsonl.1', 'devices.json', 'device.json']`），和其余
历史一样只在显式 `POST /data/wipe` 时删。README 的配置/数据表与 §12.19 都写明「历史只保留上一代，
长期留痕要自己另存」。

#### 12.32.3 配置的两条校验路径（R1-1 / R1-1b）

`lib/config.js` 里 **`CONFIG_RULES` 是模块私有**（`:319`，没有 export），九条规则：
`asrBackend`、`logLevel`、`ttsProvider`、`apiServerPort`（整数 1–65535）、
`apiServerTokenCredential`（`/^[A-Za-z_][A-Za-z0-9_]*$/`）、`apiServerHost`（非空字符串）、
`wakeupTimeout`（必须是整数且在 1–600，message
`wakeupTimeout must be a whole number of seconds in [1, 600]`）、`replyerHistoryTurns`（整数 0–50）、
`spokenMaxChars`（整数 40–2000）。对外三个新导出 + 一个保留旧签名的包装：`:384`
`configProblems(value)`（只收集问题，不抛）、`:403` `validateConfig(value)`（严格，抛
`new Error('dsh-xiaoai-bridge config: ' + first.message)`）、`:424` `sanitizeConfig(config)`
（从 `{ ...DEFAULTS, ...(config ?? {}) }` 起手逐键回退，返回
`{ value, repairs: [{ key, bad, message }] }`，**永不抛**）、`:440` `resolveLoadConfig(config)`
（= sanitize 后的值）。两条路分工：**载入**走 `configNow()`（`lib/index.js` 约 `:165`）的自愈，
有 repairs 时只用一次 `dsh-xiaoai-bridge: unusable config repaired with defaults: …` 告警；**在途
写入**走 `lib/http.js:305-334` 的 `validateDraft()`，在 revision 围栏**之前**跑 `validateConfig`，
不合法回 400 并在 error 里点名出错的字段。因此「既过期又不合法」是 400 而不是 409。为什么不能
只留一条：盘上的坏值没有「谁」可以问，只能自愈；在途写入有明确的请求方，静默替换默认值会让页面
和用户的要求不一致。`wakeupTimeout` 从「只查范围」变成必须 `Number.isInteger`——小数在写入路径
被拒，在载入路径被回退成默认值（README 的配置表与 §12.10 都写了）。

#### 12.32.4 teardown 收紧：没收干净就不删 generated（R2-5）

`lib/cleanup.js:127` 的 `removeGenerated({ keep = [] } = {})`（JSDoc 在 `:124`）会把 `keep` 里的
条目排除在删除目标外（`:129` 的 `spared` Set），并把它们放进返回值的 `kept`
（`:132` `result.kept = names.filter((name) => !targets.includes(name))`）。teardown（`lib/index.js`
约 `:602`）据此改成：`const unreleased = held.length > 0 || stopped?.ok === false;`——只有
`supervisor.stop()` 成功**且** 4399 与 `apiServerPort` 都释放，才
`cleanup.removeGenerated({ keep: [] })`；否则 `keep: ['bridge.pid']`，并告警
`dsh-xiaoai-bridge: keeping generated files in ${dataDir} (${reason}); the next start adopts the
leftover process`（reason 是 `port(s) … still answer` 或 `stop failed (…)`）。理由：pid 文件一删，
下一次启动就认不出还在跑的遗留进程、会再 spawn 一个；留着它加上命令行身份核对（§12.22）才能
接管。`scripts/check-cleanup.mjs` 现有 **40 条**断言，其中 keep 语义一整组：`keep: ['bridge.pid']`
之后文件仍在磁盘、既不在 `removed` 又在 `kept`、下一次不带 keep 仍会删。

#### 12.32.5 端口探测跟着 `apiServerHost`（R2-7）

实现是 `lib/index.js` 的 `reportHeldPorts()`（约 `:540`），**不是** `lib/ports.js`。探测地址取
`apiServerHost`：`0.0.0.0`、`::` 或空串都归一到 `127.0.0.1`，其余原样使用；探测的端口是
`[SPEAKER_PORT(4399), cfg.apiServerPort]`。若第一次探到占用且 `stopped?.stopped === true`，
等 200 ms 再探一次，避开刚退出还没松手的抖动。以前写死 `127.0.0.1`：把桥接器配成监听别的本机
地址时探测会永远报「已释放」，teardown 就会误删 pid 文件。

#### 12.32.6 第九个离线检查 `scripts/check-http.mjs`

`scripts/check-all.mjs` 现在是九个，顺序：client / config / keywords / session / supervisor /
speak / diagnostics / **http** / cleanup。新 checker 存在的理由写在文件头：此前八个 checker
从不 import `lib/http.js`（在 `scripts/` 里 grep `http.js` 零命中），路由、请求体解析、同源检查与
`/asr` 鉴权**没有任何离线信号**；它盯住两个真实发生过的回归——`/asr` 曾经 **fail OPEN**（没有
令牌也把话投递进会话，而且从不看 peer 地址），现在 fail **CLOSED**（503）；`readBody` 曾在超限时
立刻 `req.destroy()` 再回 400，真实客户端看到的是 ECONNRESET，所以超限用例走**裸 socket**（`fetch`
会掩盖差异）。它不启动桥接器、不碰 9092、不碰 `<DSH_HOME>`、不请求运行中的插件，而是把真路由挂进
一个临时 `http.Server`（loopback 随机端口）用真请求驱动，收尾全关掉。断言按 `section(...)` 分组：
mount（前缀只注册一次、注册发生在 `webCtx.effect` 里、handler 可调用）、origin（同源 200；外部
`Origin` 403 且**不带** `Access-Control-Allow-Origin`；外部 preflight 403 而不是 204；同源
preflight 204 且仍不带 CORS 头）、routes（未知路由 404 且 error 以 `no such route` 开头、
`GET /asr` 方法不对也是 404）、asr 无令牌（503，`deliver`/`utterance` 都没被调用，body 说明
no API token 与 fail closed；连没接 `resolveToken` 钩子的构建也 503）、asr bearer（无
`Authorization` 401、错误 bearer 401、正确 bearer 200 且 `deliver` 恰好一次、`utterance` 拿到
session id、响应回 `session_id` 与 `reply`；投递失败是 503 不是 200；`resolveToken` 抛异常是 500
且**不回显**凭据库消息、只进日志）、body（非 JSON 400 且 error 以 `invalid JSON body` 开头、空
utterance 400，都不触达 handler；超限体在裸 socket 上收到 HTTP 400 状态行而不是裸 reset；正常体
不受影响）、data/wipe（无 body 400、confirm 写错 400、写对 200 且 wipe 恰好一次）、config（越界
`apiServerPort` 400 且 `settings.update` 未调用、响应里没有 result/config 字段、error 点名字段；
小数 `wakeupTimeout` 400；`ops` 把 `apiServerHost` 设成空串 400 且 `settings.mutate` 未调用；
合法 ops 200 且 `mutate` 一次——`unset` 不需要校验；合法 patch 200 且 `update` 一次）、errors
（宿主异常 500、body 固定 `internal error`、不回显 host 错误码/路径/用户名、完整异常进日志；
stale revision 仍是 409）、bridge client（bearer 只跟随**经校验的** host:port：合法 loopback 目标
带 `Bearer secret-token-abc123`；凭据为空或空串时**不发** `Authorization`；恶意 host 被拒、凭据
一次都不读、拒绝报 `bridge-unreachable`、被拒目标永不到达 recorder；`[::1]` 的 `baseUrl()` 保留
配置拼写；大小写混合的主机名不被当敌意）。**仍然拦不住的**：真机 socket 的 OS 级行为、桥接器
真实 9092 的行为、设备侧——那些只能靠端到端冒烟（仓库外的 `plugin-smoke.mjs`，口径见 §12.28.7）。
风格与 `check-config.mjs` 一致：一行一条 `ok`/`FAIL`，收尾 `http check OK`，有失败就非 0 退出。

#### 12.32.7 信任域是「本机所有本地用户会话」（NOTE-6）

插件路由挂在 DSH 的 webServer 上，监听 `127.0.0.1:19387`。§12.21 的论证（「能连 loopback 的
本机进程本来就能读到凭据库」）隐含了「只有当前用户会话能连」，而这条假设在 Windows 上**不成立**：
TCP loopback 是**整机可达**的，同一台机器的其它本地用户会话照样能打进来（这里没有 per-user 的
socket 隔离）。因此信任域应当明确写成「**本机所有本地用户会话**」。落在这个域里的路由：
`POST /plugin/xiaoai/config`（改设置，包括指向 `apiServerTokenCredential` 的**凭据名**）、
`POST /plugin/xiaoai/data/wipe`（删日志与留痕）、`POST /plugin/xiaoai/bridge/start|stop|restart`
（起停桥接器），以及各个 `GET`（状态、配置、设备、`/bridge/logs`）。`/asr` 有令牌闸门：没有令牌时
fail-closed 503（`lib/http.js:512`）、令牌不对 401（`:522`）；其余路由靠同源校验（`Origin`
白名单，不匹配 403，`lib/http.js:376`）与 loopback 假设。同源校验**挡不住非浏览器客户端**——
不带 `Origin` 的 `curl` 是直接放行的（§12.27.4 已记）。为什么当前接受：单用户工作站；DSH 自己的
webServer 已经处在同一个信任域里，插件路由不比它更宽；而且除 `/asr` 外这些路由不返回凭据**明文**
（设置页读的是凭据**名**，真正的令牌在 DSH 凭据库里，插件不落盘），所以最坏影响是「同机另一个
本地用户能改设置、删留痕、起停桥接器」，不是「读走秘密」。要收紧的话（本批次只文档化，不动
`lib/http.js`）：给插件路由加一层 per-user 或令牌闸门（属代码改动）；把 DSH 装进独立的 Windows
用户账户或容器，让「本机其它用户」根本不成立；或改用带 ACL 的命名管道替代 TCP loopback
（架构级）。注意 Windows 防火墙默认不过滤 loopback，「加一条防火墙规则」不是可选项。

#### 12.32.8 验证

`node scripts/check-all.mjs`（九个；`check-client` 若还红，是客户端文案批次在途）、仓库外的
`doc-check.mjs`（零 emoji、无独立 `---`、表格列数、README 锚点）与 `changelog-check.mjs`
（版本节与日期、中英条目 1:1）都必须过；口径见 §12.28.7。

### 12.33 令牌单源（4.13 第三批）

子进程与 `/asr` 门禁必须拿到**同一个**秘密，否则现象是「音箱没反应」而本地不报错。这一批把取令牌收敛到一个入口。

#### 12.33.1 子进程与 `/asr` 门禁共用一个令牌（令牌单源）

事出两条线：`/asr` 的门禁在 `lib/http.js:536` 取 `deps.resolveToken()`，取不到就 503 fail-closed
（§12.31 那一批改的）；桥接器子进程的环境由 `lib/process.js:577-598` 的 `childEnv()` 生成，解析到
非空令牌才写 `XIAOAI_API_TOKEN`，否则显式 `delete`。两处必须拿到**同一个**秘密，否则桥接器发来的
语音请求会被自己的门禁拒掉 —— 现象是「音箱没反应」，而不是报错弹窗。

改之前两处各自调 `resolveToken()`。凭据库允许「`describe` 说已配置、`resolve` 却给不出值」这种
状态（`@deepseek-ai/dsh-credentials` 的文档写明：空的存储值处处视为不存在，`resolve` 跳过它、
`describe` 报未配置），一旦落进这个状态，子进程没有令牌、门禁却仍然要令牌，每一句都被 503 拒掉。

改法：`lib/index.js` 新增 `currentToken()`（紧跟 `ensureToken()` 之后），作为唯一的取令牌入口，
三处接线都从 `resolveToken` 换成它 —— `lib/index.js:415`（传给 `createBridgeSupervisor`）、
`lib/index.js:422`（传给 `createBridgeClient`）、`lib/index.js:550`（传给 `mountHttp`）。语义：

1. `resolveToken()` 有值就以它为准，凭据轮换因此仍然立刻生效；
2. `resolveToken()` 给不出时退回 `ensureToken()`（缺失就生成、写入凭据库并返回值），把这个值记在
   `heldToken` 里，宿主进程生命周期内稳定，不会每个请求重新生成；
3. 凭据名（`apiServerTokenCredential`）变了就作废上面的缓存，不会把旧名字下的值喂给新名字。

`lib/index.js:591` 那句 `await ensureToken();` 保留：加载时就落库，凭据库写不进去的话早暴露。

离线取证在 `scripts/check-supervisor.mjs` 的 case I：把伪造的 `bridgeDir\main.py` 写成一个三行的
node 脚本（node 以 CJS 执行未知扩展名），它把自己看到的 `process.env.XIAOAI_API_TOKEN` 写进 marker
文件 —— 于是「子进程到底有没有令牌」变成可断言的。两条断言：

- `resolveToken` 返回 `probe-token-32-hex` 时，marker 里就是它（`XIAOAI_API_TOKEN is passed to the
  bridge`）；
- `resolveToken` 返回 null 时，即便宿主环境里先塞了 `XIAOAI_API_TOKEN=leaked-from-the-host`，子进程
  看到的也是 null（`an unconfigured token is not inherited from the host`）。

这段是「离线检查不启动桥接器、不出声」的例外说明：它只 spawn 一个三行的 node 脚本，不碰设备、
不碰 9092，也不写用户的 `DSH_HOME`。

取舍：`heldToken` 是插件自己生成的值，只在这一种状态（存储答不出）下兜底；用户随后手工把凭据库里
的值换成别的、而 `resolve` 又能答了，下一句就用新值，符合第 1 条优先级，无需额外处理。

接线时**改的是值、不是键名**：`createBridgeSupervisor`（`lib/process.js:152`）、`createBridgeClient`
（`lib/bridge.js:53`）与 `mountHttp` 的 `deps`（`lib/http.js:536`）读的都是 `resolveToken`，所以三处
一律写成 `resolveToken: currentToken`。这批修复的第一版把键名也改成了 `currentToken`，结果是两个使用者
拿到 `undefined`：子进程不带令牌、`/asr` 直接 fail-closed 503，实机表现为「对着音箱说话没反应」。为了
不再静默，`lib/process.js` 的 `childEnv()` 现在区分「没接解析器」与「解析器说没有」：前者 warn 一次
`no token resolver was handed to the supervisor; the bridge will start without XIAOAI_API_TOKEN`。
仓库外的 `plugin-smoke.mjs` 也补了一条断言：假凭据库里明明有令牌时，不带 bearer 的 `POST /asr` 必须
是 401，出现 503 就说明宿主没把解析器交给门禁。

### 12.34 `xiaoai_speak` 的作用域门禁：谁能让小爱说话

#### 12.34.1 DSH 的权限模型里没有「按工具开关」

现象是「电脑/网页的普通对话里也会调用 `xiaoai_speak`」。查过两条线之后确认这是**插件侧**的问题，
不是设置没找对：

- 设置页的权限只有 sandbox 与 approval 预设（用户 patch 层 `cordis.patch.yml` 的 `permission.presets`
  里只有 `read-only`/`workspace-write`/`danger-full-access` 三种组合，字段就是 `sandbox` + `approval`），
  没有任何「允许/禁止某个工具」的界面或配置项；
- 宿主确实提供逐工具的机制 —— `tools` 服务的 `restrict(filter)`（限制调用方 agent 作用域里可见的全局
  工具）与 `guard(guard)`（按调用拒绝，且谁也不能把别人拒掉的调用强行放行）—— 但它们是**插件代码 API**，
  不是配置项；`agentPresets` 是「插件组合清单」（`PresetDefinition.plugins`），也不是工具白名单。

所以插件自己必须决定：**默认只在音箱发起的会话里允许**，再用一个显式开关放开。这一轮工具仍然全局注册
（`lib/index.js:462`），可见性交给门禁判断，也不依赖当时还没取证的宿主作用域语义；**下一轮改成按作用域
注册，见 §12.35**，门禁保留下来当第二道闸（开关中途关掉、子代理等边界仍靠它 fail-closed）。

#### 12.34.2 实现

新增配置项 `speakFromAnySession`（`lib/config.js` 的 `DEFAULTS` 与 `CONFIG_SCHEMA` 各一处，默认
`false`）。`lib/tools.js` 的 `execute` 在拿到 `sessionId` 之后、占用回合（`claimToolSpeak`）之前判断
`const bound = sessions.deviceForSession(sessionId);`：

- 有绑定（音箱发起的会话）：照旧，`device` 就是它；
- 没有绑定且 `speakFromAnySession !== true`：直接返回 `isError` 与文案「xiaoai_speak 只能在小爱音箱
  发起的对话里用……」，**不占用回合、不播报、不写 `spoken.jsonl`**；
- 没有绑定但开关为 `true`：维持改动前的行为，回退到 `sessions.primaryDevice()`（只用于给
  `spoken.jsonl` 记 `deviceKey`）。

`sessionId` 来自 `exec.agent.session.id`，而 `deviceForSession`（`lib/session.js:544-551`）只在「这条
会话由桥接器投递的语音创建」时才有记录（记录随 `deliver()` 建会话写入），所以它正好是「音箱那一路」
的判据。判真用严格比较 `!== true`：只有布尔 `true` 放开，字符串 `"true"`、数字 `1` 之类都算关闭。

门禁只能放在插件侧：`lib/bridge.js` 的 `playText()` 不带设备参数，播报目标是桥接器当前连着的那只
音箱，插件并不控制它 —— `device` 只影响日志与留痕。

#### 12.34.3 用户怎么设置

设置页「播报」一节多一个开关「**任何会话都能让小爱说话**」（`lib/client.js` 的 `FIELDS`，默认关）：

- 保持关闭（默认）：只有小爱音箱发起的对话能调用 `xiaoai_speak`；电脑/网页的普通对话调用会被拒，
  模型会看到拒绝理由，不会出声。
- 打开：任何会话都能调用它。想从桌面对话「主动说一句」时才需要打开；代价是模型在普通对话里也可能
  顺手调用。

这批代码要**重启 DSH** 才载入（宿主 JS 与设置页 bundle 都在启动时读取）。

#### 12.34.4 这一轮的离线检查

- `scripts/check-speak.mjs` 新增三条：未绑定会话被拒（`isError`、文案点名「小爱音箱发起的对话」、
  没有播报也没有占用回合）、`speakFromAnySession: true` 时回退 `primaryDevice()` 并照常留痕、
  非布尔值（`"true"`）仍然关闭；原先「播放失败」那条用例改成绑定会话，否则会先被门禁拦下而测不到
  桥接器拒绝的路径。
- `scripts/check-client.mjs` 的 Switch 计数断言从 6 改成 7（七个布尔项：`enabled`、
  `continuousConversation`、`autoSpeak`、`speakFromAnySession`、`autoStart`、`silentStart`、
  `apiServerEnabled`），并把这个开关的中文标签加进 `configFields`。
- `scripts/check-http.mjs` 见 §12.34.5 的 M1/M3；`scripts/check-supervisor.mjs` 见 M2。

#### 12.34.5 同批修掉的缺陷，以及记录下来不修的

一位只读复核者逐行看过 `7aa3595..099b5a5`，给出三条「需要立即修」与若干低优先级项。修掉的：

- **M1 通配绑定拨号**：`apiServerHost` 为 `::` 时，配置层与文档都当它合法（探测时归一成
  `127.0.0.1`），`lib/bridge.js` 的 `resolveTarget()` 却按「主机名形状」拒掉，于是 `playText`/`health`/
  `interrupt` 全部报 `apiServerHost is not a plain host name: "::"`。现在 `lib/bridge.js` 导出
  `dialableHost()`（`0.0.0.0`、`::`、`[::]` 归一到 `127.0.0.1`），`resolveTarget()`、`baseUrl()` 与
  `lib/index.js` 的 `reportHeldPorts()` 都用它，这条规则只剩一处实现。空串**故意不在**归一表里：
  `validateConfig` 本来就是拒的，客户端跟着拒。
- **M2 收养状态残留**：收养的桥接器自己死掉后，如果在下一次 5s 轮询之前来一次 start，`doStart()` 会
  照常 spawn 并写 pid 文件，却不清 `adoptedPid`/`adoptedWatch`；随后那次轮询认定收养的 pid 已死，
  于是删掉**新**子进程刚写的 pid 文件、抹掉 `startedAt`、报一条并不存在的 `adopted bridge ... exited
  unexpectedly`，并在滑动崩溃窗口里多记一次假退出。现在 `doStart()` 在写新 pid 文件之前统一清掉收养
  状态；`scripts/check-supervisor.mjs` 的 case J 复现这条时间线（先收养、原地杀掉、立刻 start），
  断言新进程拥有 pid 文件、`startedAt` 是新值、`adopted === false`、日志无幻影退出、`restarts === 0`，
  再等满一个轮询周期复核一次。用未修复的版本跑过 case J：正是「pid 文件存活」与「无幻影退出」两条
  FAIL，断言确实拦得住回归。
- **M3 恒真断言**：`check-http.mjs` 里「大小写混合的主机名不被当敌意」原本断言 `typeof ok === 'boolean'`，
  而 `request()` 每条路径都返回布尔 `ok`，所以主机名真被拒掉也照样通过。现在断言 `ok === true`，
  并补 `::`/`0.0.0.0`/`[::]` 三个通配拼写的拨号断言。`[::1]` 只断言 `baseUrl()` 的拼写：测试用的
  recorder 只监听 IPv4，拨 `[::1]` 物理上到不了。
- **L1 Windows 停桥**：`killTree()` 原来先发一次不带 `/F` 的 `taskkill /pid X /T` 再等
  `KILL_GRACE_MS`。对 console 子进程这条命令根本不生效（`can only be terminated forcefully`），
  白等满 3 秒。现在 Windows 直接 `/T /F` 一次到位；进程被系统收回时 socket 也随之释放，正是 9092
  与音箱 WebSocket 需要的效果。
- **L2 陈旧退出写状态**：`proc.on('exit')` 原来先写 `exitCode`/`exitSignal` 再判断 `child !== proc`，
  与紧邻注释矛盾。现在只在「这一代仍然是当前子进程」时才写。

记录在案、这一批不修的（多为上游既有行为或已文档化的取舍）：

- L3 `lib/process.js` 等待 `spawn` 事件的 Promise 没有超时；按 libuv 语义「要么 spawn 要么 error」，
  构造不出卡住的路径，加超时属于防御性冗余。
- L4 播放闸门：设备报 idle 时 `_until = now`，而重新放行要求 `now - _until >= RELEASE_TAIL_SECONDS`，
  于是每条非阻塞 `/api/play/text` 之后下一条要多等约 0.5 秒；桥接器自己的测试用 `tail_seconds=0.0`，
  CI 看不见这个延迟。
- L5/L6 播报锁 `_playback_lock()` 覆盖「播报 + 等闸」且等闸上限取请求方可放松的 `timeout`；设备若
  永不报 playing/idle，后续 `text` 会堵在锁上（名额满后 503）。另外登记 hold 时若设备正在放别的
  声音，新 hold 会被预标「已开始」，`set_device_playing(True)` 更会一次性标记所有在飞 hold，可能
  提前开闸。这两条属于桥接器的播报串行化设计，改动会牵动设备时序，需要实机复现再动。
- L7 `wakeupTimeout` 收紧成整数后，配置里已有的小数会在加载时被 `sanitizeConfig` 静默修回默认值
  （只写一行 warn），文档只写了 ops 路径的 400。
- L8 `/api/play/url` 与 `/api/play/file` 既不占名额也不上锁：`serialized: true` 只对 `text` 成立。
  插件不调用这两条（`lib/` 里没有对应调用点），所以对本插件只是潜在风险。
- 观察项：`SPOKEN_LOG_CAP_BYTES` 与 `SPOKEN_LOG_MAX_BYTES` 两处手抄同一常量；`lib/config.js` 的
  `resolveLoadConfig` 已无调用点；`currentToken()` 会在只读路径上写凭据，使「无令牌 503」在真实接线
  里几乎不可达（离线用例靠注入 stub 覆盖）；`/bridge/start|stop|restart` 无鉴权是 §12.27 已写明的
  信任边界；`lib/render-config.js` 的 `sleepSync` 用 `Atomics.wait` 阻塞事件循环（至多 40 乘 5 毫秒）；
  `bridge/tests/conftest.py` 的 `collect_ignore` 排除 `test_tts*.py`。

### 12.35 工具只出现在音箱那个会话里：按作用域注册

#### 12.35.1 门禁管「能不能调」，不管「看不看得见」

门禁（§12.34）只拦调用，工具仍然写在每个会话的工具表里：普通对话的模型看得见 `xiaoai_speak`，
看得见就可能顺手调一次，被拒之后它才知道不行。用户要的是「**别提供给它**」，那就得让这个条目根本不
进那些会话的注册表。

`agentPresets` 不是工具白名单（§12.34.1 已经确认过：它只有 `plugins` 清单），所以「把小爱模式做成一种
预设」解决不了可见性；能做的是**按作用域注册**。

#### 12.35.2 宿主的分层注册语义（读自 Inspect，不是猜的）

- `tools` 服务自述：「Scoped registrations shadow globals; one visibility resolver feeds presentation,
  lookup, and dispatch.」`register()` 的说明是「Register globally **or in the calling agent scope**」——
  落哪一层由**调用方上下文**决定：从 agent 自己的 ctx 调就进那个 agent 的层，从插件 ctx 调就进全局层；
  同一层里重名会失败。
- `skills` 服务是同一个形状：「A registration files into the layer of its calling context's scope
  (`scopeOf`)… A read merges the global layer with the viewing scope's chain — the nearest layer's entry
  wins a duplicate name outright.」
- 生命周期：`agent/disposed` 的说明写明它在「driver quiescence and **scoped-registration unwind**」之后
  发出 —— 作用域里的注册由宿主随后收掉，插件不需要记 handle。
- agent 自己的 ctx 从哪来：`agents.create`/`agents.resume` 的 `setup(agentCtx, agent)` 钩子（`resume` 也吃
  `setup`）；已经在跑的 agent 可以从 `agents.get(id)` 拿到，`Agent` 带自己的 `.ctx`。

#### 12.35.3 实现

新增 `lib/exposure.js`（`createExposure`），把「谁注册、注册到哪一层」收在一处：

- `attach(agentCtx)`：从 agent ctx 取 `tools`/`skills`（先看属性，再看 `get()`），两个都在就把工具与技能
  注册进**这一层**；同一个 ctx 只注册一次（`WeakSet`，因为同层重名会失败）。缺其中任何一个就**什么都
  不注册**，记一条 `scope-registration-unavailable` 诊断加一行 warn（文案写明它不会偷偷退回全局层）。
- `syncGlobal()`：只有 `speakFromAnySession === true` 时把两个条目注册进**全局**层（也就是改动前的
  `ctx.tools.register` 行为），关掉时把两个 disposer 都跑掉。作用域注册与这个开关无关，所以用户中途关掉
  开关，正在跑的音箱会话不会失能。
- `state()` → `{ mode, scoped, scopeSeam }`，接在 `/health` 的 `exposure` 字段上（界面没有单独一行展示它，
  缺 seam 时用户看到的是诊断列表里那条中文说明）。

`lib/session.js` 新增 `onAgentScope` 选项：`factoryOptions()` 把作用域钩子与既有的 model-selection
`setup` 组合到一个函数里（**没有**默认模型选择的宿主也要留下钩子，否则最容易漏注册的那台宿主反而会丢掉
注册），`ensureAgent()` 在 create、resume 之后以及复用已在跑的 agent 时各通知一次。
`lib/index.js` 删掉两处全局 `ctx.tools.register` / `ctx.skills.register`，改成建一个 exposure、在
`settings/document-updated` 上 `syncGlobal()`、并在插件卸载时 `dispose()`。

#### 12.35.4 降级行为（有意的）

宿主没给作用域 seam（或只给了一半）时，插件**不注册**并报一条诊断：宁可语音会话里少一个工具，也不能
因为「反正要能用」把工具塞回全局层 —— 那正是这一轮要修的问题本身。开着逃生门时全局层已经有两个条目，
这种宿主不再报诊断（没有缺失可言）。

#### 12.35.5 顺带改名：`sessionKey` 的 fork 默认值

`sessionKey` 默认值从 `agent:main:open-xiaoai-bridge` 改成 `agent:main:dsh-xiaoai-bridge`（`lib/config.js`
的默认值与 schema，以及桥接侧的 `bridge/config.py`（`dsh`/`openai` 两个默认 + 两处示例注释）、
`bridge/core/dsh.py`、`bridge/core/wakeup_session.py`、`bridge/core/openai.py`）。这个字段只喂桥接器
（日志前缀、按会话覆盖音色、`/asr` 载荷回显），DSH 侧没有读取者，会话路由按音箱设备（`devices.json`），
所以改默认值**不会丢音箱会话**。上游两份禁改文档（`bridge/AGENTS.md`、`bridge/README.md`）与 §12.6 的历史
日志摘录里仍是旧值，CHANGELOG 里注明了「fork 默认值与上游文档不同」。

#### 12.35.6 这一轮的离线检查

- `scripts/check-session.mjs`：case 9/9b（钩子确实拿到 agent ctx、与模型钩子组合后
  `system-prompt/assemble` 监听仍在、复用已在跑的 agent 会再通知一次、没有默认模型的宿主也留着 setup
  钩子）与 case 10（exposure 管理器：作用域里两条、同一个 ctx 不重复、第二个 agent 另有注册、缺 seam 时
  只报一次且不进全局层、逃生门开/关/重开、`dispose` 撤掉全局层、registry 抛错只报不抛、只有严格 `true`
  才开门）。
- `scripts/check-diagnostics.mjs`：两个新诊断码进 `used` 表。
- `scripts/check-config.mjs`：fixture 里的旧 sessionKey 一并改名（那几处是任意 `agentId` 的样例，不是默认值
  断言）。

这批改动同样要**重启 DSH** 才载入（新模块 + 设置页 bundle 都在启动时读取）。

### 12.36 「小爱模式」：给音箱那个会话一个 Agent 预设

#### 12.36.1 用户要的是什么

用户（m09163）问「小爱模式你打算如何做预设」。要的不是再收紧权限——工具可见性已经在 §12.35 解决——
而是让**音箱那个会话**换一副「人格与能力」：会说话、能查资料、能读写文件，但没有终端、没有子代理、
不会弹出要点选的界面。语音这条链路读的是念出来的文字，一旦 agent 手里有 shell 或子代理，它很容易
去做一件几十秒才回来、中间还要审批的事，而音箱那头只会沉默。

预设正是宿主为这件事准备的机制：`plugins` 决定一个会话由哪些插件组建，且「Plugin registrations inherit
the preset scope, and the Agent scope's parent link controls visibility」——我们注册进音箱 agent 作用域的
`xiaoai_speak` 落在预设层的子层，普通会话依旧看不到（§12.35 的结论不受影响）。

#### 12.36.2 宿主侧语义（读自 Inspect + asar，不是猜的）

- **声明**：`@deepseek-ai/dsh-agent-preset` 的 Loader 行，`config` = `id`（必填，小写字母/数字/连字符）
  + `plugins`（必填的 Cordis 行清单）+ 可选 `name` / `description` / `order`；Loader 行 id 习惯写
  `preset-<id>`。注册表是 `@deepseek-ai/dsh-agent-preset-registry`（`default` / `selectedDefault`）。
- **内置四个**（`standard`/`ptc`/`minimal`/`cordis`）来自 `@deepseek-ai/dsh-web-app` bundle 的
  `presets/<id>.patch.yml`，装在最外层 `app.asar` 里：`resources/app.asar` 的头部 JSON 从 offset 16 开始
  （`D:\WorkSpace\_oxb-wheels\asar-dump-presets.mjs` 按大括号配平扫出来，数据区起点 `ceil(end/4)*4`）。
  四份已抽到 `_oxb-wheels\asar-presets\`，order 分别是 1/2/3/4，所以这份留 **order 5**。
  用 host Inspect 的 `Config.listConfigs`（`name: '@deepseek-ai/dsh-agent-preset'`）只能拿到
  `include:preset-*` 这些目录项、**拿不到 config 值**，清单只能从 asar 取。
- **旧目录已废弃**：`$DSH_HOME/.agent-presets/<id>/{preset.yml, agent.cordis.yml}`——上游 SKILL.md 原话
  「Nothing reads that directory any more」。别照那条老路写文件。
- **挂会话**：`resolve(id)`（未知 id 抛 `agent-preset/not-found`）→ `acquireScope(id)` 拿 revision 租约 →
  `agents.create({ sessionId, meta: { cwd, agentPreset }, agentOptions, setup })`，`setup` 里
  `await agentPresets.mount(agentCtx, id)`。`ResumeAgentOptions` **没有 `meta`**，所以 resume 只能在
  `setup` 里挂。`select()` 在第一轮之后会抛 `agent-preset/locked`。

#### 12.36.3 这份 bundle（`preset/xiaoai/`）

两个文件，随仓库发布，用户在插件市场里点一次安装：

- `preset/xiaoai/package.json`：`@local/dsh-xiaoai-preset`，`private`，`dsh.bundle.patch` 指向
  `./cordis.patch.yml`。
- `preset/xiaoai/cordis.patch.yml`：`- insert: - id: preset-xiaoai / name: '@deepseek-ai/dsh-agent-preset' /
  config: { id: xiaoai, name: 小爱模式, description: …, order: 5 }`。

`plugins` 是 **standard 减掉一部分**（standard 的 146 行清单是从 asar 抽出来逐条读的）：

| 保留 | 为什么 |
| --- | --- |
| `dsh-agent-instructions`(maxBytes 65536) | 没有它，`AGENTS.md` 一类的仓库约定就进不了提示词 |
| `dsh-tool-fs`、`dsh-tool-fs-search` | 音箱会话要能读文件、查资料（`sampleOverCapGlobResults: false` 与 standard 一致） |
| `dsh-skill-filesystem`、`dsh-tool-skill` | Skills 与音箱会话里那张 `xiaoai_speak` 技能卡 |
| `dsh-tool-web`（`fetch: true`，`searchTimeoutMs: 60000`） | 「帮我查一下」是音箱最常见的正经请求 |
| `dsh-persona`（换成语音人格） | prefix 明确写「你写的一切都会被念出来、用短句、不要 emoji」 |
| compaction 组（`compaction-basic` / `command-compact` / `tool-result-pruner`） | 长对话要能自己压；`isolate` 与 standard 一致 |

| 有意去掉 | 为什么 |
| --- | --- |
| `dsh-tool-bash` / `dsh-tool-pwsh`、`dsh-tool-jobs` | 语音会话里跑终端＝几十秒沉默 + 审批弹窗 |
| delegation 组（`dsh-tool-subagent*` / `dsh-agent-*` 子代理、`dsh-tool-workflow`、workflow-ptc、ralph） | 同上，且子代理的输出没有人读 |
| `dsh-plan-mode` 与 planning 组 | 计划模式要人看着点 |
| `dsh-tool-ask-user` | 音箱那一头没有点选界面，选了就会卡住这一轮 |
| `dsh-tool-todo`、`dsh-tool-present`、`dsh-tool-plugin-manager` | 对语音闭环没有正面作用（plugin-manager 在 standard 里本来也是 disabled） |

persona prefix 有意用英文：「You are the assistant behind a Xiaomi Xiaoai smart speaker. The speaker reads
everything you write aloud…short spoken sentences…never use emoji.」——这份文本会进系统提示词，英文模板
在跨模型上更稳。suffix 与 standard 一样是 `Your working directory is {{cwd}}.`。

#### 12.36.4 插件侧接线

- `lib/config.js`：`agentPreset` 默认 **`xiaoai`**（注释写明「空值 = 宿主默认；没装则回落 + 一条诊断」）。
- `lib/session.js`：
  - `openPreset()`：读配置 → 空则完全不碰注册表；`ctx.get('agentPresets')` 不存在 →
    `presetState.reason = 'no-registry'`；`resolve` 抛 → `'missing'` + `agent-preset-missing`；
    `preset.broken` → `'broken'` + `agent-preset-broken`；成功则 `acquireScope` 拿租约。
  - `closePreset()`：`finally` 里释放租约（一次解析对应一次创建/恢复）。
  - `bindPreset()`：`mount(agentCtx, preset.id)`，按 `agent.session.id` 去重——`setup` 每次 create/resume
    都会跑，而复用已在跑的 agent 那条路每句话都会跑，重复挂只会白白 churn generation；抛错 →
    `agent-preset-mount-failed`。
  - `factoryOptions()` 现在拼三条钩子：**preset → 模型选择 → 作用域注册**。三条互不依赖是故意的：
    没有默认模型的宿主仍然能注册工具（§12.35），预设没装的宿主仍然能用上模型。
  - create 时 `meta = { cwd, agentPreset }`（header 记录这次会话启动时的 revision，重启/恢复都靠它）。
- `lib/index.js`：`/health` 的 facts 里多一个 `preset: sessions.presetState()`，设置页状态卡据此显示
  「`xiaoai` → `xiaoai`」或「`xiaoai` → 宿主默认 · 没有安装」。

#### 12.36.5 降级与诊断（有意的）

| 情况 | 行为 | 诊断 |
| --- | --- | --- |
| 没装 | 回落宿主默认预设，**照常说话** | `agent-preset-missing`（`warn`，一条） |
| 装了但激活失败 | 同上 | `agent-preset-broken`（`warn`） |
| `mount` 抛错 | 同上 | `agent-preset-mount-failed`（`warn`） |
| 宿主没有预设注册表 | 完全不用预设，**不报诊断** | 无（状态卡显示 `no-registry`） |
| `agentPreset` 留空 | 完全不碰注册表 | 无 |

「装不上就少说话」是比「装不上就不说话」更糟的取舍：音箱那头只会表现为沉默，而沉默没有错误信息。

#### 12.36.6 用户怎么装

1. 在 DSH 里把这个目录装成 bundle：`plugin_manager` 的 `install_bundle`，`target` = 仓库里的
   `preset/xiaoai`（绝对路径），或在插件市场里安装本地 bundle 目录。
2. 装完 `plugin_manager list_plugins` 里应看到 `preset-xiaoai` 行；`plugin_manager list_bundles` 里有
   `@local/dsh-xiaoai-preset`。
3. 设置页的 `agentPreset` 保持默认 `xiaoai` 即可。**已经存在的音箱会话保留它启动时的 revision**，
   要看新预设得让它新建一个会话（删掉 `devices.json` 里那条记录，或换一台设备）——这是宿主语义，
   不是插件能改的。

#### 12.36.7 这一轮的离线检查

- `scripts/check-session.mjs` case 11（a–f）：成功路径（header 里的 `agentPreset`、`setup` 里 mount、
  租约释放、`/health` 的 `presetState`、无诊断、同一 agent 不重复挂）、没装（无 header、模型选项仍在、
  一条 `agent-preset-missing`、状态含 `missing`）、声明坏了（`agent-preset-broken` + 原文进 detail）、
  宿主没有注册表（`no-registry` 且**不报**诊断）、留空（`presetState()` 为 `null`）、
  **resume 路径**（`resumeSessionId` 带上、`meta` 不出现、`setup` 里照样 mount）。
- `scripts/check-diagnostics.mjs`：三个新码进 `used` 表。
- `scripts/check-client.mjs`：`agentPreset` 控件按 `DEFAULTS` 键自动被要求存在；开关计数仍是 7
  （这一项是文本框，不是 `Switch`）。
- `AGENTS.md` 里的诊断码数量 11 → 14。

**重启 DSH** 才载入：新模块、设置页 bundle、以及刚安装的那个预设 bundle，都是启动时读取的。

### 12.37 两份 AGENTS.md 重写 + 桥接器去品牌化改名（4.14，文档与命名）

#### 12.37.1 用户要的是什么

用户原文：「第一个任务，重写agenrt.md，并子代理复查质量。」重写对象是**两份**：仓库根 `AGENTS.md` 与 `bridge/AGENTS.md`（后者是根文件指向的子目录文件）。随后用户发现文档里仍有 `OPEN_XIAOAI` 字样，追问「照理来说不应该能替换成DSH_就替换了吗，除非涉及小爱音响上的客户端不能换」；在给出「哪些能换、哪些是硬边界」的分类后，用户选择**环境变量与 Rust 扩展模块名一起换成 DSH 前缀**。

#### 12.37.2 重写做了什么

根 `AGENTS.md` 最终 140 行（旧版 139 行，规则全部保留但重排）；`bridge/AGENTS.md` 从 375 行压到 131 行。两份共同点：

- 章节按「项目概览 / 常用命令 / 架构边界 / 修改契约 / 禁止操作 / 验收标准 / 已知风险区 / 出错怎么办 / 维护」组织；修改契约按**改动类型**写（触发条件 → 先做什么 → 命令 → 完成标准），每条禁令都带**原因**与**正确路径**。
- 删掉全部行号锚点（`lib/client.js:205-206` 这类），改为「搜符号名」：行号必然漂，符号名不会。根文件在架构边界里列了最常用的唯一符号（`inject`、`ctx.inject(['webServer'], …)`、`DATA_DIR_NAME`、`reportHeldPorts`、`BUNDLE_SLOT` / `BUNDLE_KEY`、`SPEAKER_PORT`、`DIAGNOSTIC_CODES`）。
- 只写与仓库有关的事实。本机绝对路径、`~/.dsh/profiles` 的 junction、cp936 控制台乱码这类**本机环境**问题不进文档（用户明确要求「agent.md 不应该有本机环境的问题」）。
- 删除「合上游时必须人工复核 `bridge/AGENTS.md` / `bridge/README.md`」这条义务，理由见 12.37.4。

#### 12.37.3 子代理双通道复查

- 盲测：一个只读子代理拿四个改动任务（加 TTS provider、把 4399 改成 4390、给音频链路加提示音、调整日志级别），只许依据两份 `AGENTS.md` 与仓库代码推演，报执行步骤、文档充分度与缺陷。
- 事实核查：另一个只读子代理逐条核查两份文件里所有可核查断言（出处 / 证据 / 判定）。

盲测发现的缺陷已全部回改进文档：

- TTS provider 契约点名插件侧 `lib/render-config.js` 的 `RENDERED_TTS_PROVIDERS`（不加它就永远不写 `dsh.tts_provider`）与 `lib/config.js` 的 `TTS_PROVIDER_VALUES`（设置页能选什么，允许先于桥接器存在），并说明未知 provider 是**回退**不是报错。
- 端口从「两处」改成仓库内**三处**（补 `bridge/docker-compose.yml`），并补上**设备侧**不在仓库内的 `/data/open-xiaoai/server.txt`（`ws://<host>:4399`）与漏改它的后果（音箱完全没反应，本地不报错）。
- 「设备命令只经 `core/services/speaker.py` 或 Rust 导出函数」与「禁止跳过 `PlaybackGate`」自相矛盾：改成「Rust 播放类导出（`on_output_data` / `play_audio_file` / `start_playing` / `tts_play*`）是不带闸门的底层出口，只允许 `speaker.py` 与 TTS router 调」。
- 补上提示音范例的落点（`core/external_conversation.py` 的 `_load_notify_sound()` / `_play_notify()` 一带，解码走 `decode_audio`），并说明 `play()` 之后的 `asyncio.sleep(时长)` 只是等放完，**不是** `PlaybackGate` 的替代品。
- 根文件补上 `PlaybackGate` 这条最硬的约束（原来通篇没提）。

事实核查（逐条判「对 / 错 / 拿不到证据」）又回改了一批**文档与代码不符**的地方：

- `TTSService` 是凭空写的符号：`core/services/tts/router.py` 里的类叫 `TTSRouter`，全仓没有 `TTSService`。
- 「Rust 播放类导出只允许 `speaker.py` 与 TTS router 调」与代码不符：`core/wakeup_session.py`（start_recording / stop_playing）、`core/xiaoai.py`（on_output_data）、`core/services/api_server.py`（tts_stream_play*）都在直调；改成「现有调用点分布在这几处，新代码要出声就走 `speaker.play(...)` 或 `TTSRouter`，新增直调要自己承担闸门责任」。
- 「设备命令只经 `speaker.py`」有既存反例：`core/xiaoai.py` 里另有同一份打断命令串与 `run_shell` 直调（有意保留的既存状态），规则改成「不要**新增**绕开它的设备命令」。
- 根文件的 HTTP 端点清单漏了 `/bridge/status`、`/bridge/health`、`/bridge/restart`——其中 `/bridge/health` 与插件自身 `/health` 是两个东西，正是容易混的地方。
- `core/utils/` 的模块地图写了不存在的 `playback`（真实文件是 `playback_gate.py`）且漏 `base.py`；`native/src/` 漏 `macros.rs`。
- 「禁止改 `bridge/pyproject.toml` 的 `name`」理由写错了：Rust 模块名与导入路径来自 `native/Cargo.toml` 的 `[package]` / `[lib] name` 与 `native/src/lib.rs` 的 `#[pymodule]`，`pyproject.toml` 的 `name` 只是分发名（dist-info 至今仍是 `open_xiaoai_bridge-1.0.0.dist-info`）。
- `sanitizeConfig` 的告警不是「只告警一次」，而是**按坏值集合去重**：同一组坏值一次，不同组各一次。
- 两份文件都没写 `XIAOAI_DEVICE_NAME` / `XIAOAI_DEVICE_HOST`（`core/dsh.py` 读、插件侧 `lib/process.js` 写、随每次 `/asr` 提交）与 `abort_xiaoai` 的实际实现 `/etc/init.d/mico_aivs_lab restart`；`bridge/AGENTS.md` 也缺「`uv sync` 会卸载 pytest」这条前置。
- 一处**不采信**：事实核查子代理读 `bridge/.venv` 的快照早于本轮的 `uv sync`，因此报「venv 里仍是旧模块名」；实测那时已经换成 `dsh_xiaoai_server/`。并发窗口下拿到的快照要按现状复核再用。

#### 12.37.4 口径更正：本仓库不追上游

早期文档（`README.md`、`CONTRIBUTING.md` 的「同步上游」一节、`.gitignore` 抬头）把 `bridge/` 描述成「基于上游原文的 fork 增补版」，还要求合上游时人工过一遍那三个文件。用户明确：**「我虽然是fork，但已经脱离上游了，是自有项目，不考虑合上游啊。文档里也不应过量强调我们是fork，误导agent」**。据此：

- `bridge/` 源码仍源自 [coderzc/open-xiaoai-bridge](https://github.com/coderzc/open-xiaoai-bridge)（MIT，署名保留），但本仓库**独立演进**：不合并上游改动、不需要保留上游 tag、没有「合上游要人工过一遍」的义务。
- `CONTRIBUTING.md` 的 `## 同步上游` 改为 `## 与上游的关系`（只陈述事实，不写合并流程）；`README.md` 与 `.gitignore` 的「fork 增补版」措辞一并改成「源码来自上游、本仓库自行演进」。
- `bridge/README.md`、`bridge/CHANGELOG.md` 里搬来的旧内容（快速开始的 clone 地址、旧 `session_key` 示例、`v1.0.7` 历史条目）**有意保留**：那是历史与出处，不是本仓库的承诺；示例与代码冲突时以代码为准（`bridge/AGENTS.md` 已写明这条）。

#### 12.37.5 改名：`OPEN_XIAOAI_TOKEN` → `DSH_XIAOAI_TOKEN`，`open_xiaoai_server` → `dsh_xiaoai_server`

- 环境变量：`bridge/native/src/server.rs` 读的那个（4399 的客户端鉴权，留空即不鉴权）改名为 `DSH_XIAOAI_TOKEN`，文档同步。
- PyO3 模块名：`native/Cargo.toml` 的 `[package] name` 与 `[lib] name`、`native/src/lib.rs` 的 `#[pymodule] fn`、20 个 Python 文件的 `import` 与 `sys.modules.setdefault` 测试桩、以及四份文档里的导入示例，一起改成 `dsh_xiaoai_server`。
- **不能改的硬边界**：Rust crate `open-xiaoai`（`native/Cargo.toml` 的 git 依赖与 `use open_xiaoai::…`）、设备端 `/data/open-xiaoai/` 路径（含客户端补丁目录）与设备命令 `tts_play.sh` / `miplayer` / `mphelper` / `mico_aivs_lab`。
- **有意不改的历史**：`bridge/CHANGELOG.md` 的 `v1.0.7` 条目、本文件早期 §12.x 里的旧名字——改写历史会让取证不可信。
- 本轮未动的可选外观项（用户没要求）：`bridge/pyproject.toml` 的分发名 `open-xiaoai-bridge`、`docker-compose.yml` 的服务名 / 镜像名、豆包 TTS 用的 uid。
- 实测：停桥接器 → `uv sync`（22.85 s，重编译 1 个包）→ `import dsh_xiaoai_server` 成功；site-packages 里只剩 `dsh_xiaoai_server/` 与 `open_xiaoai_bridge-1.0.0.dist-info/`（分发名未改，故 dist-info 仍是旧的），旧 `open_xiaoai_server/` 目录被替换。顺带记一条：`uv sync` 会卸载 pytest，跑测试前要 `uv pip install --python .venv\Scripts\python.exe pytest`。

#### 12.37.6 与早期记录不一致的一处（以代码为准）

本文件早前与 `CHANGELOG.md` 有一条说法是未知 `tts_provider` 会「直接抛异常」。实际 `bridge/core/services/tts/router.py` 的 `resolve_provider()` 是 `logger.warning` 记一条 `Unknown tts_provider=` 后**回退**（`"xiaoai" if tts_speaker == "xiaoai" else "doubao"`），不抛异常。历史条目不改，这里更正口径。

#### 12.37.7 这一轮的检查

- 仓库根 `npm run check`（九条离线检查）全绿；`bridge/` 的 pytest 基线是 `115 passed, 19 subtests`，只许升不许降。
- 仓库外的 `agent-md-creator` 校验器（`check_agents_md.py`）对两份文件报 error 0 / warn 0。
- `bridge/AGENTS.md` 的行数预算（建议 ≤200 行）已从 375 行降到 131 行（根文件 140 行）。
- 事实核查回改之后又跑了一轮：九条检查绿、`doc-check.mjs` 报 `anchors in README: 10, headings: 17`、`changelog-check.mjs` 报 `versions: 11`、校验器 0 / 0 / 0、pytest 仍 `115 passed, 19 subtests`。

### 12.38 发布前清单与本清单自身的收口（4.15，计划外增补）

#### 12.38.1 用户要的是什么

用户原文：「建一个仓库内的TODO.md提醒我，作为发布前需做。mimotts也包括在里面」以及「低优先小尾巴做了」。于是这一批做两件事：新增仓库内 `TODO.md`（发布前待办，MiMo TTS 接线是其中第一条）；把 §8「进度」回填到当前（它从 4.13 静默启动之后就停了，后面 §12.31 至 §12.37 各批都没进清单），并修掉 §12.33.1 缺父标题这个编号瑕疵。

#### 12.38.2 `TODO.md` 的定位

- 放在仓库根，是**给维护者的发布前清单**，不是功能文档：功能看 `README.md`，纪律看 `AGENTS.md`，决策看本文件的 §12.x。
- **不进 `package.json` 的 `files` 白名单**：清单是仓库内的维护物件，装包副本里不需要它（与 `docs/` 同样的理由，但 `TODO.md` 里没有本机路径，所以它留了个绝对 GitHub URL 只为本文件的一致性）。
- 条目分三类：**必须在发布前做完**（MiMo TTS 接线、版本与 CHANGELOG 收口、发布前全绿、push 归用户）、**可选**（`bridge/pyproject.toml` 分发名 / docker-compose 服务名与镜像名 / 豆包 uid 这三处外观项；上游搬来的旧内容去留）、**需要用户动手**（重启 DSH、实机验收 3.13 / 3.15、第二台音箱验 3.10）。
- MiMo TTS 那条写成了可执行的四步：桥接器加 OpenAI 兼容客户端并进 `SUPPORTED_PROVIDERS`；密钥只存凭据名、真令牌走 credentials seam；`lib/render-config.js` 的 `RENDERED_TTS_PROVIDERS` 与 `buildOverrides()` 才允许写 `dsh.tts_provider = "mimo"`；检查与文档（`scripts/check-config.mjs` 的「预留 provider 不写进渲染配置」断言、`scripts/check-client.mjs` 的逐字文案断言、README 配置表、§12.25）同步改。

#### 12.38.3 §8 回填

§8 原有条目停在 4.13 静默启动（§12.30），此后 §12.31 至 §12.37 的记录都没回填，清单不再是完整断点。这次补 4.13-1 到 4.13-6（文档与打包收口、第二轮收口、令牌单源、播报作用域门禁、按作用域注册、「小爱模式」预设）、4.14（两份 AGENTS.md 重写 + 去品牌化改名）与 4.15（本批）。保留 3.10 与 3.15 两条未勾选项（它们的阻塞条件是**实机**，不是代码）。

#### 12.38.4 编号修正：§12.33 的父标题

`#### 12.33.1`（令牌单源）此前直接跟在 §12.32.8 后面，没有 §12.33 这个父标题。这次补上 `### 12.33 令牌单源（4.13 第三批）` 与一句导语，保留 `#### 12.33.1` 这个子标题编号 —— `CHANGELOG.md` 里两处「展开见 §12.33.1」的指针因此继续有效，不用改。

#### 12.38.5 这一轮的检查

`npm run check`（九条）绿、`doc-check.mjs` 与 `changelog-check.mjs` 绿、`check_agents_md.py` 0 / 0 / 0；`TODO.md` 的加入没有触碰任何断言（它不在 `files` 白名单里，也不参与 README 锚点）。

### 12.39 设置页重新排版：折叠分区与联动显隐（4.16，UI 重排）

#### 12.39.1 用户要的是什么

用户原文：「重新排版一下配置页面，整理一下配置项的位置。用好排版折叠和出现逻辑（某些功能只有开启XX功能才会出现）」。改动只落在浏览器半（`lib/client.js`）、它的检查（`scripts/check-client.mjs`）与 `README.md` 的配置项章节；宿主半、桥接器、配置键名与默认值一律不动。

#### 12.39.2 折叠用宿主的 `DisclosureRow`

从 asar 取到的实现（`node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js:3156`）是**受控**组件：`open` 由父级持有、`onToggle` 必传，`expandable && expandOnRowClick` 时整行可点、可键盘触发，展开态用 `IconChevronUpOutlineRegular`；关键一行是 `:3203` 的 `}), open && children]` —— **收起时 children 根本不挂载**。所以组件里用 `foldState = useState(function () { return Object.assign({}, FOLD_DEFAULTS); })` 持有每段的开合，`toggleFold(id)` 拷贝旧 map 再取反（不可变），`Fold()` 只是 `DisclosureRow` 的一层包装（补 `foldBodyStyle` 的纵向间距）。`FOLD_DEFAULTS` 里 `process.advanced` 默认 `false`（排障项默认收起），其余 7 段默认展开。

段落 id 与标题一字未动（`basic` / `voice` / `reply` / `speak` / `persona` / `process` / `api`），因为 `scripts/check-client.mjs:199` 断言渲染文本里必须有那 8 个标题（含「运行状态」）；换标题会连带改检查，而标题本身没有重排的必要。

#### 12.39.3 联动为什么用 `display:none`（隐藏）而不是不渲染（卸载）

`scripts/check-client.mjs` 的三条计数断言（40 个中文标签出现在渲染文本里、`Switch` 恰好 7 个、`SegmentedControl` 恰好 3 个、原生 `<select>` 恰好 1 个）都建立在「控件在渲染树里」这个前提上。如果按开关把字段整段卸载，`autoSpeak` / `apiServerEnabled` / `autoStart` / `continuousConversation` 默认值一关，对应控件立刻从渲染树消失，计数断言与标签断言都会挂。更重要的是产品行为：卸载会丢掉这一项**暂存的草稿与校验提示**，用户把开关来回拨一次就得重填。

所以门挡住的控件**照常渲染**，只是外面套一层 `jsx("div", { key: spec.key + "-hidden", style: hiddenStyle, children: control })`（`hiddenStyle = { display: "none" }`）—— 与设置页其它部分一致：`buildOps()` 本来就按 `FIELDS` 全表生成 ops，隐藏与否不影响保存什么。

门外值 `gateOpen(gate)` 取值的优先级是 `draft[gate.key]` → `snapshot.value[gate.key]` → `GATE_DEFAULTS`。最后一层的存在是必要的：`/config` 还没答上来时 `snapshot` 是空的，没有 `GATE_DEFAULTS` 就会把「默认开启」的开关（`autoSpeak`、`autoStart`、`apiServerEnabled`）看成关，于是首帧把它们的子项全藏起来、加载完再突然冒出来。`GATE_DEFAULTS` 镜像 `lib/config.js` 的 `DEFAULTS` 里那几个布尔值（`ttsProvider: ""`、`continuousConversation: false`、`autoSpeak: true`、`autoStart: true`、`apiServerEnabled: true`），**两边要一起改**。

联动规则（不改键名、不改默认值，只改显示）：

| 门 | 只看这一个键 | 被它管的字段 |
| --- | --- | --- |
| TTS provider | `ttsProvider` | `in: ["mimo"]` → `mimoBaseUrl` / `mimoApiKeyCredential` / `mimoModel` / `mimoVoice`；`notIn: ["mimo"]` → `ttsSpeaker` |
| 连续对话 | `continuousConversation` | `exitKeywords` |
| 自动播报 | `autoSpeak` | `replyerProvider` / `replyerModel` / `replyerHistoryTurns` / `replyerFailureText` |
| 桥接器托管 | `autoStart` | `silentStart` |
| 本地 API 服务 | `apiServerEnabled` | `apiServerHost` / `apiServerPort` / `apiServerTokenCredential` |

#### 12.39.4 字段重新归属

`FIELDS` 表整表重写（每条多两个可选属性：`show` 门与 `advanced: true`），分区顺序与归属：

- 基本：`enabled`、`deviceName`、`deviceHost`、`sessionKey`、`sessionCwd`、`agentPreset`（`sessionKey` 从「回复」搬来 —— 它只喂给桥接器；`sessionCwd` 与 `agentPreset` 是「这个音箱会话归到哪、按哪套预设建」，也归这里）
- 唤醒与语音：`wakeKeywords`、`wakeupTimeout`、`continuousConversation`、`asrBackend`、`ttsProvider`、`ttsSpeaker`、MiMo 四项
- 应答与兜底：`wakeupReplyText`、`exitReplyText`、`exitKeywords`、`fallbackText`（前三项原来散在「语音」里，`fallbackText` 从「回复」搬来）
- 播报与回复器：`autoSpeak`、`speakFromAnySession`、`spokenMaxChars`、`approvalText`、回复器四项（`spokenMaxChars` 与 `approvalText` 从「播报」与「回复」合并进来，回复器不再单列）
- 人格与提示词：`personality`、`replyStyle`、`behaviorStyle`、`outputLimits`、`voiceRuleText`（原来混在「播报」里）
- 桥接器进程：`autoStart`、`silentStart`、`logLevel`，加「高级」折叠里的 `bridgeDir`、`pythonPath`
- 本地 API 服务：`apiServerEnabled` + host / port / 凭据（原来叫「进程与接口」，把桥接器托管和 API 混在一起）

`SECTIONS` 的 id 与 `section.*` 标题键沿用旧值（`reply` 现在渲染成「应答与兜底」、`speak` 渲染成「播报与回复器」、`api` 渲染成「本地 API 服务」），`COPY.zh` / `COPY.en` 只加了 `section.advanced`（「高级」/「Advanced」）一条。

#### 12.39.5 `scripts/check-client.mjs` 的两处期望变更与理由

1. **`'桥接器目录'` 与 `'Python 解释器'` 从「渲染文本必须含」改成「源码必须含」**。它们现在默认收在「高级」折叠里，而 `DisclosureRow` 收起时不渲染 children —— stub 忠实地照做后，这两个标签就不在渲染文本里了。改检查而不是改产品：折叠正是用户要的效果，而这两条断言原本要防的是「加了配置项忘了加控件」，源码级断言同样能防住（`FIELDS` 里仍有这两条、`configFields` 的 40 个标签里其余 38 个仍在渲染文本里）。stub 与宿主一致这一点是刻意的：如果 stub 收起时也渲染 children，检查就会在一个真实浏览器里不成立的假设上通过。
2. **新增 `seen.folds.length >= 7`**：断言 7 个分区确实走的是折叠容器，而不只是内容好看。stub 的 `DisclosureRow` 会把每次渲染的 `title` 推进 `seen.folds`，`title` 始终进 children（与宿主实现一致：`title` 在 `.row` 里，不受 `open` 影响）。

`collectText`（`scripts/check-client.mjs:341-354`）只收 `props.children`、不收 `title` / `label` 这类 props，所以折叠标题不能靠 props 过标签断言 —— 这也是 stub 要把 `title` 放进 children 的原因。

#### 12.39.6 这一轮的检查

`npm run check`（九条，含改动后的 `check-client.mjs`）绿；`doc-check.mjs`（README 锚点只有 `#排错` 与 `#快速开始`，配置项章节的重排没动它们）与 `changelog-check.mjs` 绿；`check_agents_md.py` 0 / 0 / 0；`bridge` 侧 pytest 未受影响（这一批不动 Python）。仓库外另有一个不入库的临时脚本 `render-outline.mjs`（`D:\WorkSpace\_oxb-wheels\`），用同一套 vm + stub 渲染一次设置页并打印折叠 / 隐藏 / 控件大纲，用来在改检查之前先肉眼确认结构。

### 12.40 设置页视觉重做：照官方插件的写法（4.17，UI 精修）

#### 12.40.1 用户要的是什么

原话：「折叠的有点难看，下拉列表也写的不好看，看看官方插件的写作：@deepseek-ai/dsh-experimental-voice-input-bundle 和 /impeccable」。功能与结构一律不动（4.16 的分区、折叠、联动、字段归属全部保留），只重做视觉与控件写法。判定基准是官方 `dsh-experimental-client-ui-voice-input` 的客户端半，以及宿主 `@deepseek-ai/dsh-client-ui-primitives` 各 `*.module.css`。

#### 12.40.2 为什么不再用内联 style

内联 style 表达不了 `:hover`、`:focus-visible`，也没法制服原生 `<select>` 自带的那套 chrome；4.16 的代码因此在每个控件上摆一堆常量（`MUTED`、`BORDER`、`selectStyle`…）。改成**一个 CSS 字符串 + 注入一次 `<style>`**，与官方客户端半同构：官方 `VoiceInput.module.css` 就是建 `style` 标签、写 `tag.dataset.plugin = "<包名>"` 与 `tag.dataset.pluginCss = "<包名>/<文件>.module.css"`、再 `document.head.appendChild`。我们的 `ensureStyles()`：

- 在 `apply(ctx)` 里调一次；`apply` 在 `check-client.mjs` 的沙箱里也会跑，所以第一行是 `typeof document === "undefined" || !document.head` 守卫；
- 用 `document.querySelector('style[data-plugin-css="dsh-xiaoai-bridge/client.css"]')` 去重（宿主可能把同一个席位挂两次，样式表只该进一次）。

#### 12.40.3 颜色与几何全部取宿主的值

- 颜色只用 `--dsw-alias-*`、圆角只用 `--dsw-radius-sm|-md`。这套 token 是逐条对着宿主的 `*.module.css` 核过的；注意警告色叫 `--dsw-alias-state-warn-primary`，**没有** `state-warning-primary`。
- 表单几何照抄 `settings-form/fields.module.css`：字段 `padding: 12px 0`、`gap: 6px`、字段之间 `0.5px solid var(--dsw-alias-border-l2)`、标签 13px/500、控件高 34px、`border-radius: var(--dsw-radius-md)`、底色 `--dsw-alias-bg-layer-3`、焦点换 `--dsw-alias-state-business-primary`。**这不是抄着好看，是为了和同一页里宿主自己渲染的 `SettingsValueField` 严丝合缝**：我们自画的控件（下拉、多行文本、分段控件）与宿主画的文本框并排放，任何一处差 2px 或差一档灰都会看得出来。
- 同一理由，这一轮**去掉了原先 520px 的宽度上限**：宿主的输入框占满整栏（`.field` 是纵向 flex，子项默认 stretch），自画控件跟着占满才对齐。

#### 12.40.4 折叠头：`DisclosureRow` + 常显箭头

`Fold()` 传 `icon: IconChevronDownOutlineRegular` 与 `previewChevron: false`。原语的默认行为是「收起时箭头只在悬停出现、展开时换成向上箭头」，收起态看起来就是一行纯文本 —— 用户嫌难看的正是这个。传了 `icon` 之后：收起态显示向下箭头，展开态原语自己渲染 `IconChevronUpOutlineRegular`（这是原语内部的逻辑，`previewChevron` 只作用于收起态）。行高与字号用 `rowClassName` / `titleClassName` 覆盖：`.xiaoai_sectionRow` 把固定的 24px 放开成 `min-height: 30px`，分区头 14px/500 一级色，嵌套的「高级」13px/500 二级色并让内容左缩进 20px（正好对齐父级标题文字）。

#### 12.40.5 下拉框：去掉原生箭头，换宿主自己的箭头图标

`<select>` 用 `appearance: none` + `.xiaoai_selectChevron`（`IconChevronDownOutlineRegular`，绝对定位在右侧、`pointer-events: none`、悬停随 `.xiaoai_selectWrap:hover` 变二级色）。官方 voice-input 的做法是留着原生箭头只给它上色；我们换成主题图标，因为同一页里的折叠箭头就是这套图标，两种箭头并排会很杂。`scripts/check-client.mjs` 的「原生 `<select>` 恰好 1 个且 `id === "xiaoai-sessionCwd"`」断言不受影响 —— 控件种类没变，只是 className 变了。

#### 12.40.6 每个字段一个 `.xiaoai_fieldWrap`

宿主的字段分隔线是 `.field + .field`（相邻兄弟选择器）。4.16 给每个字段套 wrapper 之后，宿主的相邻选择器再也匹配不上（字段之间永远隔着一层），分隔线统一由 `.xiaoai_fieldWrap + .xiaoai_fieldWrap` 画：**被联动隐藏的字段也占着这一层，所以它前后的线不会塌**（隐藏用的是 `.xiaoai_hidden`，见 §12.39.3）。同一轮还修掉了 `summary` 视图里最后一处 `style: summaryStyle` —— 常量块被 CSS 取代后它成了未定义变量，`check-client` 立刻报 `component render threw: summaryStyle is not defined`，这条报错就是这个检查的意义。

#### 12.40.7 这一轮的检查

`node scripts/check-client.mjs` 绿，且这一批**没有改检查的任何期望值**（视觉与 className 的重做不动渲染文本、也不动控件计数 —— 这正是 12.39.5 那两条断言的边界）；`npm run check` 九条绿；`doc-check.mjs` / `changelog-check.mjs` / `check_agents_md.py` 绿；`bridge` 侧未动（pytest 基线 115 passed, 19 subtests）。结构另用仓库外不入库的 `render-outline.mjs` 复核了一遍（7 个折叠 + 高级折叠 + 各字段归属）。

**这一轮没有真机截图**：`127.0.0.1:19387` 的浏览器界面要求 `dsh web` 打印的进程令牌，桌面壳里的会话拿不到（`GET /` 回 `dsh web authentication required`），所以视觉是按官方 CSS 逐条复刻的，最终以用户刷新页面后所见为准。

### 12.41 提示词口径统一：主人 → 用户、猫娘 → 鲸鱼娘（4.18，文案）

#### 12.41.1 用户要的是什么

原话：「提示词“主人”全面替换成“用户”。“猫娘”替换成“大肥鱼”」，随后更正：「不要写你是一只叫小爱的大肥鱼助手，可以写“你是一只叫DeepSeek的鲸鱼娘助手。」，以及一句补充：「DeepSeek前后加空格」。看过第一版之后，用户又定了两处收尾：「就念「再见」，中性化成「对方」」。最终口径四条：

- 称呼统一成「用户」（不再用「主人」）；
- 回复器人格示例改写为「你是一只叫 DeepSeek 的鲸鱼娘助手」，拉丁字母前后各留一个半角空格（中英混排的排版习惯，也是对上面那句补充的执行）；
- 退出提示语只念「再见」（不写「再见，用户」——念出来像客服）；
- 「他」改成「对方」，不再默认用户是男性。

#### 12.41.2 改了哪些提示词

| 位置 | 键 / 常量 | 新文本 |
|---|---|---|
| `lib/config.js` | `DEFAULT_VOICE_RULE_TEXT` | 「注意：这条消息是用户通过小爱音箱发来的语音。…」 |
| `lib/tools.js` | `xiaoai_speak` 的两处描述 | 「当用户通过小爱音箱跟你说话时…」「不必等用户先唤醒音箱…」 |
| `lib/replyer.js` | `REPLYER_IDENTITY` / `USER_LABEL` / system 提示 | 「你是一个通过小爱音箱和用户说话的语音助手…」「用户」「就像对着用户说话一样。」 |
| `lib/client.js` | `hint.personality` | 「回复器的人格设定，例如「你是一只叫 DeepSeek 的鲸鱼娘助手」。只影响音箱念出来的话。」 |
| `bridge/config.py` | `dsh.exit_prompt`、`dsh.rule_prompt_for_skill`、`openai.rule_prompt_for_skill` | 「再见」；两处说明改成「这条消息是用户通过小爱音箱发送的，对方看不到你回复的文字。」 |
| `bridge/core/xiaoai_conversation.py` | `self.exit_prompt` 初值与 `apply_runtime_config()` 的兜底默认值 | 「再见」 |
| `bridge/README.md` | 示例配置里的 `rule_prompt_for_skill` | 同 `bridge/config.py` 的 `openai` 段 |

`scripts/check-speak.mjs` 里 `assert.match(prompts.user, /主人：一个问题/)` 跟着改成 `/用户：一个问题/`——它断言的是回复器拼出来的 user 消息里带不带「<称呼>：<原话>」，改称呼就必须改它，否则这条检查会假红。

#### 12.41.3 什么没改，为什么

`docs/deploy.md` 与 `bridge/CHANGELOG.md` 里出现的「主人」是**历史取证**（当时提示词原文的摘录、以及早先 §12.x 的引用），按本仓库「只写最终状态、不改写历史条目」的约定保持原样；这一轮的口径变更记在本节。设备端命令、`bridge/core/models/` 里的模型资产同理不动。

#### 12.41.4 运行时要重新渲染才会改口

桥接器真正读的是渲染产物 `<DSH 家目录>\xiaoai-bridge\config.py`，它由 `lib/render-config.js` 生成：**不是模板的副本，而是一层覆盖** —— 生成的文件在导入时用 `_load_template()` 把仓库里的 `bridge/config.py` 当模块加载（`APP_CONFIG = _template.APP_CONFIG`），再把插件设置 `_deep_merge()` 上去，所以它引用的始终是仓库里那份模板。据此，本轮改的文本分两类生效：

- **模板侧的键**（`dsh.exit_prompt`、`openai` 段的 `rule_prompt_for_skill`）：覆盖里根本不写它们，所以下次**加载**渲染产物时重新执行 `_load_template()` 就拿到新值 —— 也就是重启桥接器（或任何一次重新渲染）后生效，不需要重装插件。
- **渲染产物侧的 `dsh.rule_prompt_for_skill`**：它来自插件设置（`voiceRuleText` 默认取 `DEFAULT_VOICE_RULE_TEXT`，非空即写进覆盖），要等**重新渲染**才会更新。渲染有三个触发点：插件加载时（`lib/index.js` 的 `supervisor.renderConfig()`）、每次启动桥接器（`lib/process.js` 的 `doStart()` 里 `renderConfig()`）、设置页保存后（`lib/index.js` 的 `onConfigWritten` 回调）。

两条合起来的结论：**在设置页里停止再启动一次桥接器**（或保存一次设置、重启 DSH）即可让音箱改口；桥接器自己每秒轮询渲染产物的 mtime 并热重载，但那是重读同一个文件，不会替我们重新渲染。这不是缓存，是「插件生成配置、桥接器只读生成物」的架构使然（`bridge/config.py` 是模板，禁止移出版本库，见 `bridge/AGENTS.md`）。

#### 12.41.5 这一轮的检查

`npm run check` 九条绿（含 `scripts/check-speak.mjs`）；`doc-check.mjs`、`changelog-check.mjs`、`check_agents_md.py --root .` 均绿；`bridge` 侧 `pytest -q` 仍是 **115 passed, 19 subtests**（b 侧没有断言这些默认文本，所以只改了值、没动测试）。

### 12.42 提示词默认值进配置：人格 / 说话风格 / 行动准则（4.19，设置项）

#### 12.42.1 用户要的是什么

原话：「有默认提示词的就把默认提示词写到配置中。」当时的实情是：设置页「人格设定 / 说话风格 / 行动准则」三格在 `lib/config.js` 的 `DEFAULTS` 里都是 `''` —— 配置里没有任何文案，三格的「默认提示词」只活在代码里（人格是 `lib/replyer.js` 的 `REPLYER_IDENTITY`，风格拼在任务行尾巴上，规则是 `DEFAULT_VOICE_RULE_TEXT` 的后半段）。给用户看过三种读法（把代码里的兜底文案填进三格 / 只把模板里的说明抄进配置 / 只记账不改代码）之后，用户选定：**把空白的三格填上代码里的兜底文案**，设置页看得见、也能改。

#### 12.42.2 三处默认文本的来源

| 配置项 | 新默认值 | 原来藏在哪 |
|---|---|---|
| `personality` | `lib/replyer.js` 的 `REPLYER_IDENTITY`：「你是一个通过小爱音箱和用户说话的语音助手，你的回答会被直接念出来。」 | `buildReplyerPrompts()` 里 system 的第一行（常量） |
| `replyStyle` | 新增导出 `DEFAULT_REPLY_STYLE`：「用日常、口语化的说法讲出来，就像对着用户说话一样。」 | 原先拼在任务行 `…把【要表达的意图】用日常、口语化的说法讲出来，就像对着用户说话一样。` 的尾巴上 |
| `behaviorStyle` | 新增导出 `DEFAULT_BEHAVIOR_STYLE`：「不要包含 markdown、代码、emoji、颜文字、括号里的动作或心理描写、URL；一般 50 字以内、一两句话讲完，只有确实需要长回复时才展开，最多不超过 300 字。只有当你要逐字念出、不要润色的内容时，才调用 xiaoai_speak 工具。」（长度口径见 §12.42.7） | `DEFAULT_VOICE_RULE_TEXT` 的后半段 |

`personality` 与 `replyStyle` 两个常量定义在 `lib/replyer.js`（提示词的真正使用者旁边），`lib/config.js` 从那里导入；`behaviorStyle` 与缩短后的 `DEFAULT_VOICE_RULE_TEXT` 相邻定义在 `lib/config.js`。schema 里这五项本来就写 `.default(DEFAULTS.<key>)`，所以只改 `DEFAULTS` 一处，设置页与文档自动跟着走。

#### 12.42.3 人格那一格为什么要加守卫

默认值现在**就是**身份句，而 `buildReplyerPrompts()` 原来的规则是「`personality` 非空就追加一行「关于你自己：…」」——两句相加会把同一句话写两遍。守卫改成 `personality.length > 0 && personality !== REPLYER_IDENTITY`：默认（或用户手打一句完全一样的）不再重复追加，默认配置下的人格部分与改动前**逐字一致**（system 的第一行仍是 `REPLYER_IDENTITY`，不多不少）；用户写了自己的人格仍照旧多出一行。`replyStyle` 走的是同一条路：默认值非空，所以「说话风格：…」这行在默认配置下就会出现，任务行里的风格子句因此删掉 —— 用词不变、只是从任务行尾挪到了独立一行，语义等价且不重复。

#### 12.42.4 语音规则为什么拆成两段

`lib/render-config.js` 的 `composeVoiceRule()` 会把 `behaviorStyle` 以「行动准则：」追加在 `voiceRuleText` 后面。原来这两段是**同一个** `DEFAULT_VOICE_RULE_TEXT` 常量：若把它整段填进 `behaviorStyle`，设置页与渲染产物里就会各出现一遍；拆开后默认渲染结果是「通道说明 + 空行 + 行动准则：+ 规则子句」——与改动前的「通道说明：规则子句」相比，用词一字未改，只是把原来的冒号连接改成了空行 + 「行动准则：」小标题（`composeVoiceRule()` 本来就是这么拼的，`behaviorStyle` 一旦非空就会有这个小标题）。

取舍要写明：**已经手改过 `voiceRuleText` 的安装**升级后，覆盖里会多出默认的行动准则一段。若用户当时只写了自己版本的通道说明（没写规则），这正好补上；若用户把规则也抄进了 `voiceRuleText`，就会重复一次——把「行动准则」那一格清空即可回到旧行为。本机 `C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml` 的插件 `config` 只存了 6 个与提示词无关的键（`silentStart`、`wakeKeywords`、`wakeupReplyText`、`exitReplyText`、`ttsProvider`、`sessionCwd`），所以这台机器不会重复。

#### 12.42.5 断言与检查

- `scripts/check-config.mjs`：`bare` 的清空列表补上 `behaviorStyle: ''`（否则默认行动准则非空，`bare` 只等于唤醒超时与连续对话两条的断言会假红）；`dsh.rule_prompt_for_skill` 的期望值由 `DEFAULTS.voiceRuleText` 改成 `composeVoiceRule(DEFAULTS)`（新增从 `lib/render-config.js` 导入 `composeVoiceRule`），并加两条固化拆分语义的断言：它等于 `` `${DEFAULTS.voiceRuleText}\n\n行动准则：${DEFAULTS.behaviorStyle}` ``，且 `DEFAULTS.voiceRuleText` 本身不含「行动准则」。
- `scripts/check-speak.mjs`：新增一条以 `DEFAULTS` 作 `cfg` 的断言（`the shipped defaults carry the identity, the speaking style and the limits`）——system 里要有「语音助手」、`说话风格：用日常、口语化的说法讲出来`、「不要 emoji」，且**不含**「关于你自己：」。原有两条断言不动：自定义人格 `你很耐心` 仍要求出现「关于你自己：」，`cfg: {}` 的 condense 仍靠 `REPLYER_IDENTITY` 兜底。
- 检查：`npm run check` 九条绿；`doc-check.mjs`、`changelog-check.mjs`、`check_agents_md.py --root .` 绿；`bridge` 侧 `pytest -q` 仍是 **115 passed, 19 subtests**（桥接器只读渲染产物，模板没改）。`README.md` 的「人格与提示词」表三行默认值由「空」改为「内置」。

#### 12.42.6 怎么生效，「留空」是什么意思

改的是插件侧默认值，所以必须**重新渲染**渲染产物：在设置页保存一次（写配置 + 渲染），或在设置页里停止再启动一次桥接器，或重启 DSH —— 三条渲染触发点见 §12.41.4。

「清空」与「恢复默认」现在是两件事（`hint.empty` 那句兜底文案只出现在**没有**自带说明的字段上，三格各有自己的说明，所以界面上没有新旧矛盾）：

- **清空某一格再保存**，存进去的是空串，含义是「这类指令不再注入」：`personality` 空 → 不再有「关于你自己：…」（system 开头的身份句是硬编码的，仍在）；`replyStyle` 空 → 不再有「说话风格：…」，而任务行也不带风格子句，所以这一格是默认配置下**唯一**的风格来源，清空等于放弃风格引导；`behaviorStyle` 空 → 渲染产物里不再有「行动准则：…」这一段（这是拆分后新出现的「能关掉规则」的能力）。
- **想拿回出厂文本**，用字段自带的**重置**：`stageReset()` 会把这一项从保存的配置里删掉（`lib/client.js` 的 `delete next[key]`），`DEFAULTS` 随即生效；或者把默认文本粘回框里。

空串不会被 `sanitizeConfig()` 当成坏值回退（它只管类型/取值域），所以清空就是清空，不会被悄悄改回默认——这一点与 `voiceRuleText` 的「空则用桥接器模板里的默认值」不同（那里是 `buildOverrides()` 跳过空值、模板兜底），是本轮的取舍。

#### 12.42.7 收短口径与说明文案（同日追加）

用户看过改完的设置页截图后又提了两条（原话：「已经有默认文本就不用“例如”了。」「300字不太好，一般50 字以内，一两句话即可。必须长回复的时候用300字以内」）。

**说明文案去掉「例如」。** 三格现在自带默认文本，说明里的示例句只会把同一件事说两遍；而且 `hint.personality` 的示例从 §12.41 起就与默认人格不一致（那一轮把它换成了「鲸鱼娘」，默认人格却是「语音助手」）。改成：

| i18n 键 | 现在的中文说明 |
|---|---|
| `hint.personality` | 「回复器的人格设定，只影响音箱念出来的话。」 |
| `hint.replyStyle` | 「回复器的说话风格。」 |
| `hint.outputLimits` | 「写进回复器请求的硬性约束。」 |

英文侧同一批改，`hint.personality` 的 `e.g. "you are a cat-girl assistant called XiaoAi"` 一并删掉（那个示例比中文侧还旧）。§12.41.2 表格里 `hint.personality` 那一行记的是**那一轮**的措辞，属历史取证，按本仓库约定不回改。

**长度口径改成两档。** 统一成「一般 50 字以内，一两句话讲完，只有确实需要长回复时才展开，最多不超过 300 字」，落在四处：`DEFAULT_OUTPUT_LIMITS`（回复器请求的硬性约束）、`DEFAULT_BEHAVIOR_STYLE`（渲染成「行动准则：」）、`lib/tools.js` 里 `xiaoai_speak` 的 description，以及桥接器模板的两个 `rule_prompt_for_skill`（`dsh` 段与 `openai` 段；后者不被插件覆盖，会真的发给模型，`bridge/README.md` 的示例配置同步）。**刻意不动**的是 `dsh` / `openai` 两段的 `rule_prompt`：「将结果处理成纯文字版…字数控制在300字以内」是**处理指令**，300 在那里是播报上限而不是回复风格；`spokenMaxChars` 的默认值也保持 300，它是硬上限（超了先精简一次、再截断），不是模型该瞄准的目标。50 这个数字只写在提示词里，配置里没有对应开关。

**检查。** `npm run check` 九条绿（没有断言引用这几段文本，所以只改了值）；`bridge` 侧 `pytest -q` 仍是 **115 passed, 19 subtests**（`tests/test_config_loader.py` 只断言键与合并语义，不比对提示词原文）；`doc-check.mjs`、`changelog-check.mjs`、`check_agents_md.py --root .` 绿。

### 12.43 归档过的音箱会话：宿主门禁与自动重开

用户报的现象（原话）：「由于dsh目前只有归档，没有删除会话，如果我把旧小爱的会话关了，它好像会直接不对接任何会话，你有什么维修法吗」。

#### 12.43.1 根因：归档不是删除，是一道静默的门禁

DSH 现在只提供归档：`workspaceRegistry.archiveSession(sessionId)` 把会话加进注册表的持久显示集合（`C:\Users\Administrator\.dsh\storages\workspace.json` 的 `global.archivedSessionIds`，每台机器上已有两百多条），`session.v4.jsonl.zstd` 原样留在 `.dsh\sessions\` 下不动，取消归档还能回到原位（宿主注释原文：`Archiving never touches workspace accounting — an archived session keeps its sessionIds slot so unarchiving restores its position`）。

真正的变化在**准入门禁**上：`dsh-api-session-controller` 的 `lib/types/archived-session-gate.js` 里有一个 `ArchivedSessionGate`（`inject: ['agents','sessions','workspaceRegistry']`），它挂在 `agent/pre-step`，用 `underArchivedSession(ctx, agent)` 沿 subagent 血缘查 `ctx.workspaceRegistry.archivedSessionIds`，命中就 `return Promise.resolve({ kind: 'reject' })`。宿主自己的注释把这个后果写得最清楚：

> A late waking delivery to an archived Session — … a queued follow-up — proposes a step the gate rejects, which the loop ends as `blocked` without a request.

对上插件的形状就是：`ensureAgent()` 复用旧会话 → `agent.followup(...)` **不抛错也不返回失败**（消息真的进了 store）→ 宿主在 `pre-step` 把这一步拒掉、循环以 `blocked` 收尾、一个请求都不发 → 没有回复、没有任何日志。插件于是永远以为会话还在，每一句都往一个死会话里投递，用户看到的就是「关了旧会话以后音箱谁也不连」。

#### 12.43.2 修法：复用之前先问一句

`lib/session.js` 新增 `isArchived(sessionId)`（放在 `track()` 之前）：

```js
function isArchived(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
  try {
    const archived = ctx.get?.('workspaceRegistry')?.archivedSessionIds;
    if (!archived) return false;
    return [...archived].some((id) => String(id) === sessionId);
  } catch {
    return false;
  }
}
```

宿主那个属性是**活的 getter**（不是快照），用户可能在插件运行期间归档，所以每次投递都要重新读，不能缓存到进程变量里；注册表没起来或这台宿主不提供时当作「没有意见」，绝不因此拦住一句话。

`ensureAgent(record)` 里在 `factoryOptions()` 之后、原有 `if (record.sessionId)` 复用/恢复块之前插入退役逻辑：命中归档就把绑定作废（`sessionId = null`、`titleLabel = ''`、`updatedAt = Date.now()`、`schedulePersist()`），再往下自然走新建会话那条路——**触发这一切的就是本来要被丢掉的那一句**，不需要用户额外操作，新会话还会重新拿到设备标题（`titleLabel` 清空就是为这个）。

两件刻意**不**做的事：

- 不 `dispose()` 旧 handle：会话文件留着，用户在界面上取消归档后那份历史仍可继续用，插件卸载时才统一收 handle。
- 不替用户 `unarchiveSession()`：归档是用户的决定，插件只负责不往死会话里说话。

#### 12.43.3 可观测性：`session-archived-rebound`

`notePreset()` 改名 `noteWarn()`（`warn` 这一级现在覆盖两种「音箱能绕着走」的状况：预设回落、归档会话），三个调用点照旧；`DIAGNOSTIC_CODES` 由 14 条变成 **15** 条，末位新增 `session-archived-rebound`，中英标签在 `lib/client.js` 里跟在 `agent-preset-mount-failed` 之后，README 排错表加一行（顺序仍以数组为准）。detail 写成 `session <旧 id> is archived, so this utterance starts a new conversation`，用户拿着状态卡就能确认「不是音箱坏了，是我归档了那个会话」。

#### 12.43.4 检查与生效

`scripts/check-session.mjs` 新增 case 12：把设备记录指向一个**在 `archivedSessionIds` 里**的会话，并在假宿主上给 `resumable: true`（能恢复却选择不恢复，才能证明检查真的生效），断言不复用也不恢复、只有一条 `session-archived-rebound`（`level === 'warn'`、detail 含旧 id）、落盘 `devices.json` 指向新会话、新会话重新被命名；case 12b 用 `archivedSessionIds: ['session-somebody-else']` 断言**未归档的照样恢复**，避免把「偏好新会话」当成归档检查。`harness()` 因此多收一个 `archivedSessionIds` 参数，假 `workspaceRegistry` 也改成能只提供归档集合（`list()` 返回空）。`scripts/check-diagnostics.mjs` 的 `used` 表加该码。

改动落在 `lib/` 里，要**重启 DSH** 才生效；本机当前设备记录指向的 `session-56293798-4c38-4efb-9ce8-1b73a46e7cca` 就在归档集合里（`updatedAt` 一直在涨，说明归档后插件仍在投递），所以用户重启后的下一句语音会自动开一个新会话。







