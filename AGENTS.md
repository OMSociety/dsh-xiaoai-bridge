# AGENTS.md — dsh-xiaoai-bridge Agent 宪法

适用范围：本仓库全部目录。`bridge/` 另有上游那半的 [bridge/AGENTS.md](./bridge/AGENTS.md)（Python/Rust 桥接器的边界与雷区），
改动落在哪个目录就以更接近改动点的那份为准。
最后更新：2026-10-03

## 项目概览

- 一句话定位：把小米小爱音箱接入 DeepSeek Harness 的插件——宿主侧托管一个本地 Python 桥接器进程，跑通「唤醒词 → 说话 → DSH 会话 → 音箱播报」，全部配置走 DSH 官方插件设置页。
- 技术栈：Node >= 20（ESM，**无构建步骤**）；DSH 插件 = 宿主半 `lib/index.js` + 浏览器半 `lib/client.js`；Python >= 3.12 桥接器在 `bridge/`（uv 管理，含 maturin/PyO3 编译的 Rust 扩展）；测试 = `scripts/check-*.mjs` 八个 node 脚本 + `bridge/` 的 pytest；`dsh plugin` 是 pnpm 的透传，本机 profile 用 `desktop`。
- 文档索引：
  - 用法、配置项、排错表：[README.md](./README.md)
  - 环境要求、提交前要跑什么、写作约定：[CONTRIBUTING.md](./CONTRIBUTING.md)
  - 决策与实测记录（按 §12.x 编号，含取证命令原文）：[docs/deploy.md](./docs/deploy.md)
  - 变更历史（中英双语）：[CHANGELOG.md](./CHANGELOG.md)
  - 许可链与免责：[DISCLAIMER.md](./DISCLAIMER.md)
  - 桥接器（Python/Rust）的规则：[bridge/AGENTS.md](./bridge/AGENTS.md)

## 常用命令

命令按 PowerShell 写（本仓库的文档与实测都用 PowerShell）。

| 目的 | 命令 |
|---|---|
| 把本机 checkout 装进 profile（软链） | `dsh plugin --profile desktop add D:\WorkSpace\Github\dsh-xiaoai-bridge` |
| 看 profile 里装了什么、什么版本 | `dsh plugin --profile desktop list` |
| 跑单个离线检查 | `node scripts\check-config.mjs` |
| 装桥接器依赖（Rust 扩展现场编译，首次约十几分钟） | `uv sync --no-install-project`（在 `bridge/` 里）；再 `uv sync` |
| 跑桥接器测试（工作目录 `bridge/`） | `.\.venv\Scripts\python.exe -m pytest -q` |
| 给桥接器 venv 装 pytest（`uv sync` 会把它清掉） | `uv pip install --python bridge\.venv\Scripts\python.exe pytest` |

八个检查没有聚合入口（`package.json` 的 `check` 只跑 client）。下面八条**工作目录都是仓库根**（用相对路径，在别处跑会直接报找不到文件），任何一条非 0 即失败：

```powershell
node scripts\check-client.mjs
node scripts\check-config.mjs
node scripts\check-keywords.mjs
node scripts\check-session.mjs
node scripts\check-supervisor.mjs
node scripts\check-speak.mjs
node scripts\check-diagnostics.mjs
node scripts\check-cleanup.mjs
```

跑完再进 `bridge/` 跑上表倒数第二行那条 pytest，两半都绿才算过。

## 架构边界

```text
浏览器半 lib/client.js ──┐
                        ├─ DSH 宿主 lib/index.js ── Python 桥接器进程 bridge/ ── 小爱音箱
插件 HTTP /plugin/xiaoai/*（lib/http.js） ──┘        （桥接器回调 127.0.0.1:19387/plugin/xiaoai）
```

- 宿主半用导出声明依赖：`lib/index.js:43` 的 `inject = ['tools','skills','settings','credentials','agents']`；`webServer` 是软依赖，走 `lib/index.js:479` 的 `ctx.inject(['webServer'], …)` 再 `mountHttp`。
- 浏览器半是**手写的已构建产物**：`lib/client.js:33` 的 `window.__ModuleLoader__.load({…})` 形态，注册到席位 `plugins.bundle.config` / key `dsh-xiaoai-bridge`（= 包名，`lib/client.js:55-56`），导出的服务依赖在 `lib/client.js:1254`（`["slots","locale"]`）。
- 配置只有一个来源：`lib/config.js` 的 `DEFAULTS` + Schemastery schema。`<DSH_HOME>/xiaoai-bridge/config.py` 是 `lib/render-config.js` 用 `bridge/config.py` 当模板渲染出来的（原子写：临时文件 + `renameSync`），**不是**手改的对象。
- 端口：`4399` 是 Rust 扩展里硬编码的（`bridge/native/src/server.rs:89` 的 `"0.0.0.0:4399"`，插件侧镜像在 `lib/ports.js:17` 的 `SPEAKER_PORT`）；`9092` 是桥接器 API Server 的默认端口（`apiServerPort`）。插件自己不开端口，路由挂在 DSH 的 webServer 上。
- 数据目录 `<DSH_HOME>/xiaoai-bridge/`（`lib/index.js:48` 的 `DATA_DIR_NAME`）；删哪些、留哪些是设计决策，见 `lib/cleanup.js:29-38`。

## 修改契约

动手前先按改动内容读对应的一份：[README.md](./README.md) 的配置项与排错表、[CONTRIBUTING.md](./CONTRIBUTING.md) 的约定，以及 [docs/deploy.md](./docs/deploy.md) 里相关的 §12.x（那里有别人踩过的坑，搜关键词比重新试一遍便宜）。

- 改配置项：`lib/config.js` 的 `DEFAULTS` 与 schema 两处一起改 → `lib/client.js` 的中英两张文案表（中文约 `:261`、英文约 `:412`）→ 若这项要改变桥接器进程行为，改 `lib/process.js` 的 `bridgeChildEnv()`（设置项 → 环境变量的唯一映射处）→ [README.md](./README.md) 的配置表 → 跑 `node scripts\check-config.mjs` 与 `node scripts\check-client.mjs`（开关类控件会让 `check-client` 的 Switch 计数变化，那是断言在提醒你确认）。
- 改界面：直接改 `lib/client.js`（没有 bundler 兜底），中英两张表都要改 → 核一下 [README.md](./README.md) 的配置项与排错表有没有要同步的行 → 跑 `node scripts\check-client.mjs`（它在沙箱里求值 bundle，断言 module id、`apply`/`inject`、席位注册并渲染一次组件；能拦住语法、模块形态与席位写错，**拦不住**真机上的交互与桥接器进程行为）→ 改的若是用户看得见的行为，还要按验收标准第 3 条重启 DSH 核对。
- 加/改诊断码：`lib/diagnostics.js:24` 的 `DIAGNOSTIC_CODES`（当前 8 个）→ `lib/client.js` 中英文案 → README 排错表 → 跑 `node scripts\check-diagnostics.mjs`。
- 改端口：`lib/ports.js` 与 `bridge/native/src/server.rs` 必须同时改 → 跑 `check-cleanup` 与 `check-supervisor`。
- 改 HTTP 路由：`lib/http.js`（前缀 `:27` 的 `/plugin/xiaoai`；`/health`、`/config`、`/bridge/logs`、`/data/wipe`）。请求体一律 `JSON.parse(await readBody(req))`，设置写入要处理 revision 冲突；同源校验在 `lib/http.js:158-174`，**不要加 CORS 头**。
- 改 teardown / 卸载：先读 [docs/deploy.md](./docs/deploy.md) §12.27，再动 `lib/cleanup.js`，跑 `node scripts\check-cleanup.mjs`。
- 改 `bridge/` 下任何文件：先读 [bridge/AGENTS.md](./bridge/AGENTS.md)；`bridge/config.py` 是上游模板，必须留在版本库里。
- 改 `bridge/native/src/*.rs`：Rust 扩展要重编译才生效，且**必须先让桥接器停下来**（否则 `.pyd` 被占用，`uv sync` 报 `failed to remove file …open_xiaoai_server.pyd: 拒绝访问 (os error 5)`）——`POST http://127.0.0.1:19387/plugin/xiaoai/bridge/stop`（该路由不要凭据）→ 在 `bridge/` 里 `uv sync` → 确认 `bridge\.venv\Lib\site-packages\open_xiaoai_server\open_xiaoai_server.pyd` 的修改时间就是刚才 → `POST …/bridge/start`。`uv` 不在 PATH，本机在 `C:\Users\Administrator\.local\bin\uv.exe`。
- 改版本号：**先报备用户**（仓库既有纪律，见 [CONTRIBUTING.md](./CONTRIBUTING.md)）。
- 改对外文档：零 emoji、不写 `---`、只写最终状态；架构上的偏离与取舍追加到 `docs/deploy.md` 的 §12.x，不要写进 README 或提交信息。
- 一次改动跨了上面多条（例如既加配置项又改界面）：相关检查**全跑**（配置项 + 界面 = `check-config` + `check-client`），这里只有并集，没有优先级。

## 禁止操作

- 禁止为了「顺手」改 `bridge/README.md`、`bridge/CHANGELOG.md`、`bridge/AGENTS.md` 的既有内容。原因：那是上游 `coderzc/open-xiaoai-bridge` 的原文，本仓库只做 fork 与增补，改它们会让上游同步与署名链失真。要改上游行为先读 `bridge/AGENTS.md` 的边界约束，并确认这是插件侧该管的事。
- 禁止把 `bridge/config.py` 移出版本库。原因：它是桥接器模板，`lib/render-config.js` 靠它生成真正生效的配置，删了桥接器起不来（`.gitignore:74` 写着这句）。
- 禁止提交 `bridge/config.py.rendered`、`**/device.json`、`**/devices.json`、`*.token`、`credentials.json`、`bridge/.venv/`、`bridge/core/models/`、`__pycache__`。原因：`.gitignore:77-86` 已经挡住，用 `git add -f` 只会把凭据与大文件带进历史。
- 禁止用 `pnpm pack` / `npm publish` 的结果判断包干净不干净。原因：本机实测 pnpm 12.6.0 在 `files` 白名单下产出 753,788,062 字节的 tarball（含 `.venv` 与模型目录），且**不读** `.npmignore`；这条陷阱的取证在 `docs/deploy.md` §12.28.6。
- 禁止把服务名写进 `package.json` 的 `dsh.client.inject`。原因：那里声明的必须是「包依赖边」（先生成的包行），服务依赖由客户端 bundle 导出的 `inject` 决定；写服务名会被**静默忽略**，看起来生效其实没有。
- 禁止手改 `%USERPROFILE%\.dsh\profiles\desktop\node_modules` 里的东西。原因：那是指向本仓库的 `link:` 软链，改那边等于改一份没人维护的副本；装卸一律走 `dsh plugin --profile desktop add|remove`。
- 禁止把提交推到 `upstream`。原因：`upstream` 是 `coderzc/open-xiaoai-bridge`，只用来 `git fetch` 同步上游；我们的提交去 `origin`（`OMSociety` 的 fork）。
- 禁止自行 bump `package.json` 的版本号。原因：版本是用户可见契约，改前先报备。

## 验收标准

改动完成 = 下列全部通过：

1. 八个离线检查全绿：上面「常用命令」里那八条 `node scripts\check-*.mjs` 在仓库根逐条跑完，全部 exit 0。
2. 桥接器测试：在 `bridge/` 里跑 `.\.venv\Scripts\python.exe -m pytest -q`，当前基线是 **90 passed, 19 subtests**。基线只许升：数字变大是新增测试，变小说明有测试被删或被跳过，要查清再提交。
3. 改了宿主/客户端行为时，重启 DSH 后在真机上核对：插件在 profile 里是 `link:` 指向本仓库，重启即载入当前工作树，不需要重新安装。

仓库**没有 CI**（`bridge/.github/workflows/` 是上游的，管 Docker 与发布，不跑插件侧）；改动只碰文档时，第 1、2 条仍要跑一遍。

本机另有一个未入库的宿主侧端到端冒烟脚本 `plugin-smoke.mjs`（在仓库外的 `D:\WorkSpace\_oxb-wheels\`），覆盖 `/asr` 鉴权、`/config` 冲突与 `POST /data/wipe`；它不在版本库里，别在文档里当既成事实引用。

## 已知风险区

| 路径 | 风险 | 改动前后置动作 |
|---|---|---|
| `lib/client.js` | 手写产物、没有 bundler，语法或席位写错只有运行时才炸 | 改完必跑 `node scripts\check-client.mjs`；可见行为还要按验收标准第 3 条重启后核对 |
| `lib/config.js` | `DEFAULTS` 与 schema 是两处，漂移后设置页显示的值与桥接器实际读到的值不一致 | 两处一起改，跑 `check-config` 与 `check-client` |
| `lib/cleanup.js` | GENERATED/HISTORY 划分错了，会在每次 DSH 关闭时删掉 `spoken.jsonl`（用户明确要留的历史） | 先读 `docs/deploy.md` §12.27，跑 `check-cleanup` |
| `lib/ports.js` + `bridge/native/src/server.rs` | `4399` 是硬编码的，两边不同步会让「端口仍被占用」的诊断误报或漏报 | 同时改，跑 `check-cleanup`、`check-supervisor` |
| `lib/process.js` | 接管 DSH 异常退出后遗留的桥接器进程（按 pid 文件）与 Windows 下的进程树清理；改错会留下孤儿进程占着 4399/9092 | 跑 `check-supervisor`；真机验收里核对卸载后无残留 |
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
| 状态卡上出现 `port-held` / `watchdog-gave-up` / `start-failed` | 编码含义见 README 排错表；实时状态看 `GET /plugin/xiaoai/health` 的 `bridgeApi.state` |

## 维护

本文件与代码同 PR 更新。改动以下内容时必须同步本文件：验收命令（`scripts/check-*.mjs` 的增删）、模块边界与端口、
`.gitignore` 的禁区、profile 的安装方式。发现内容与代码不符时，先改本文件再继续改代码。
`bridge/` 侧的规则在 `bridge/AGENTS.md`，两边冲突时以更接近改动点的那份为准。
