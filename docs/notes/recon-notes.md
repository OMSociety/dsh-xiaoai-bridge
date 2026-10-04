# dsh-xiaoai-bridge 实测侦察笔记（grill-me 阶段）

> 本文件记录 grill 阶段**实测**得到的事实，全部有命令/源码依据。用于写实施 plan 时对齐，**不是 plan 本身**。

## A. Windows 本机编译链（关闭开放项 #1、#4）

- 上游 GitHub 全部 9 个 release（v1.0.0–v1.0.7 + vad-kws-asr-models）资产**只有** `docker-compose.yml` 和 `models.zip`（470MB），**无任何 `.whl`**。
- PyPI `open-xiaoai-server` 0.1.0 只有 `manylinux_2_34_x86_64` 一个 wheel，**无 Windows、无 sdist**（pip 无法现编）。
- CI 只有 2 个 workflow，都只构建 Docker 镜像，不产 wheel。
- 本机实测工具链：`cmake/cargo/rustc/uv/cl/gcc/docker` 全 MISSING；`python`=3.13（仓库钉 3.12）；`node/pnpm` OK。
- **结论：Windows 本机跑桥接器必须现装 uv + Python 3.12 + Rust + cmake + MSVC Build Tools 编 `open_xiaoai_server`。** 用户已拍板：写进 plan，本机装。

## B. Windows 不需要声卡（推翻旧担忧）

- `core/services/audio/stream.py` 的 `MyAudio`/`MyStream` 是 **PyAudio 纯 Python 替代品**（注释：「使用小爱音箱音频（通过 Rust 补丁）」）。`pyaudio` 从未被真正 import，只是 `pyproject.toml` 遗留依赖。
- 音频全部走 Rust 扩展 WebSocket 与音箱收发，**不碰本机声卡**。
- fork 后 `open_xiaoai_server` 直接 git 依赖上游 `coderzc/open-xiaoai` 的 `client-rust`（纯转发 crate，无 host 音频绑定），Windows 上无需编声卡驱动。

## C. 音箱端实测（关闭 Q2 / 开放项 #5）

- 音箱 = **Xiaomi 智能音箱 Pro（OH2P）**，已刷机（dropbear SSH 在跑，`/bin/flash.sh` 存在），`root@192.168.1.191`，LEDE 系统，内核 4.9.61。
- **但 open-xiaoai Rust Client 未安装**：`/data/open-xiaoai/` 目录不存在，无 `server.txt`/`token.txt`/`client` 二进制，无相关进程，无 4399 连接。
- 音箱 `uname -m` = **aarch64**，但 CPU 是 ARMv8（implementer 0x41），有 32 位加载器 `/lib/ld-linux-armhf.so.3`。
- **实测**：上游预编译 ARMv7 客户端（`https://gitee.com/coderzc/open-xiaoai/releases/download/open-xiaoai-client/client`，851344 字节，ELF 32-bit machine 0x28=ARM）在音箱上**可直接运行**（输出 `✅ 已启动`）。
- 音箱资源：内存 241MB（可用 141MB），`/data` 分区 125.8MB（可用 116MB），有 `curl`/`wget`。
- 含义：第 0 期可在音箱上装预编译客户端，**无需交叉编译**；`server.txt` 指向 Windows 本机 LAN IP:4399。

## D. 桥接器 API Server 无鉴权（Q6 需在 fork 里补）

- `core/services/api_server.py` 9 个端点（`/api/play/text` 等）**全部无 token/中间件/IP 白名单校验**。
- `API_SERVER_HOST` 默认 `127.0.0.1`。
- Q6 要求 9092 鉴权 → fork 必须自加鉴权层（ bearer token 或 trustedHosts 校验）。

## E. DSH 插件侧可复用的已装实现（模板）

- 最贴近模板（host+client+设置卡片+HTTP 路由+内置技能+凭据托管）：`dsh-mineru`。
  - `lib/index.js`：`settingsNamespace(ctx)` 读 `ctx.fiber.entry.options.id`；volatile 字段是引用要 `.get()`；`configNow=()=>({...DEFAULTS,...plainConfig(config)})` 每次重投影热生效；`ctx.skills.register({name,description,source:'runtime',content})`；`ctx.credentials.resolve/describe`。
  - `lib/client.js:778`：`ctx.slots.inject("settings.plugins.tab", ...)` 注册自定义设置页签。
- 0.2.x peer 写法：`dsh-better-sidebar/package.json`。
- 会话写入：`dsh-better-sidebar/lib/index.js:3377` `agent.inject(createUserMessage({content, source:{kind:'plugin:dsh-better-sidebar'}}))` —— kind 必须 `plugin:<包名>`。

## F. 仓库/license

- `coderzc/open-xiaoai-bridge`：**MIT License**，默认分支 `main`，主语言 Python。fork/删除连接器/改名均合法，需保留 LICENSE 与署名。
