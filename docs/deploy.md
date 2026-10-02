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

## 9. 第 1 期实现决策

- **不引入打包器**：`lib/client.js` 手写为 `window.__ModuleLoader__.load({id, factory})` 形态，
  内部**只** `require("react")` 与 `require("react/jsx-runtime")`，不 require 任何 UI 包
  （直接把 UI 原语耦合降到零，白屏面最小）。依赖清单写在 `package.json` 的 `dsh.client.inject`。
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
- 延迟表 `DEFAULT_RESTART_DELAYS_MS = [2000, 5000, 15000, 30000]`，**表长同时就是重试预算**：
  `restarts >= restartDelaysMs.length` 时置 `gaveUp = true`，`lastError` 写成
  `bridge exited unexpectedly (code=…); the watchdog stopped after N restarts`。
  固定间隔重试会把「音箱没插电」变成每 2 秒一次的密集重启，退避不会。
- **预算重置规则**：进程活过 `stableMs`（默认 60 s）才算「健康了一轮」，此时退出把
  `restarts` 归零——否则「一天崩一次」会在几天后耗尽预算而永久闭嘴。
  watchdog 自己的重启**不**重置（否则崩循环里 `restarts` 永远是 0，等于无限重启）；
  用户显式 `start()` 才重置（`start({ fromWatchdog = false })` 里 `restarts = 0; gaveUp = false`）。
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

**四、`state()` 的新字段**（给 4.5 状态卡用）：`restarts`（本轮崩循环已用掉的重启次数）、
`watchdogGaveUp`（watchdog 是否已放弃）、`nextRestartAt`（下一次自动重启的 ISO 时间，或
`null`）。加上 §12.21 的 `auth`，状态卡要的三类信息（在跑没在跑 / 为什么不在跑 / 鉴权
形态）就齐了。

**测试**：`scripts/check-supervisor.mjs` 新增 case C（自然退出→重启成新 pid、日志有
`restart #1 in 120 ms`）、case D（已排队的重启被 `stop()` 取消，等过一个延迟也不再起）、
case E（`restartDelaysMs: [10, 20]` 的崩循环 → `watchdogGaveUp === true` 且日志写
`the watchdog stopped after 2 restarts`；随后显式 `start()` 清掉标记并真的跑起来）；
`scripts/check-speak.mjs` 新增「proactive speech」5 条（按需拉起后重试成功、拉起失败时
报原因、HTTP 错误不重启、超时到 `reviveWaitMs` 就收手、没有 `ensureBridge` 时行为不变）。

