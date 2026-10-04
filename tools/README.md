# tools/ — 开发期工具（不随包发布）

这里放的是**维护这个仓库时用的工具**，不参与插件运行，也**不在** `package.json` 的 `files` 白名单里：npm 包里没有 `tools/`，装出来的副本也不依赖它。

与 `scripts/` 的区别：`scripts/check-*.mjs` 是每次提交前必跑的九条离线检查（`npm run check`，见 [AGENTS.md](../AGENTS.md) 的验收标准），这里的脚本是**按需**用的辅助工具，不属于 CI 口径。跑过文档或 CHANGELOG 改动时建议顺手跑前两条。

所有脚本都按「从仓库任意位置跑」写（路径相对脚本自身解析），只有个别参数需要自己给。

| 工具 | 用途 | 用法 |
|---|---|---|
| `doc-check.mjs` | 对外文档 QA：README / CHANGELOG / CONTRIBUTING 里的 emoji、`---` 分隔线、表格列数是否一致，以及 README 内部锚点是否都能落到标题上 | `node tools/doc-check.mjs` |
| `changelog-check.mjs` | CHANGELOG 结构 QA：版本标题格式（非 `Unreleased` 必须有 `- YYYY-MM-DD`）、中文类别必须排在英文之前、中英两侧类别与条目数一一对应、类别名在白名单内 | `node tools/changelog-check.mjs` |
| `drive-client.mjs` | 离线驱动 `lib/client.js`：自带真的 `useState` / `useEffect` / `useCallback` 语义，能跑「用户手势之后」的流程（保存后重载、409 保草稿、刷新按钮），并核对中英文案表的键是否对齐。`scripts/check-client.mjs` 只渲染一次且 hook 是空实现，看不到这些 | `node tools/drive-client.mjs` |
| `plugin-smoke.mjs` | 宿主侧端到端冒烟：用假 cordis 上下文加载 `lib/index.js` 并应用插件，然后直接驱动挂上的 `/plugin/xiaoai` handler，覆盖 `/asr` 鉴权、`/config` revision 冲突与 `POST /data/wipe` 的拒绝路径 | `node tools/plugin-smoke.mjs` |
| `render-outline.mjs` | 用 `check-client.mjs` 的那套桩渲染 `lib/client.js`，打印页面大纲（折叠区、隐藏字段、控件种类），改设置页时不用重启 DSH 就能看结构 | `node tools/render-outline.mjs` |
| `asar/asar.mjs` | 只读 asar：列目录 / 打印单个文件 / 在内层路径里按正则搜 | `node tools/asar/asar.mjs list\|cat\|grep <asar> <内层路径> [正则]` |
| `asar/asar-tool.mjs` | DSH 安装目录的 `app.asar` 快速体检：`probe` 看头部结构、`find <substr>` 找文件、`extract <内层路径> <输出目录>` 提取到磁盘 | `node tools/asar/asar-tool.mjs probe`；asar 路径默认取本机 DSH 安装位置，用环境变量 `DSH_ASAR` 覆盖 |
| `asar/asar-list.mjs` | 列出（或 `--extract` 提取）asar 里匹配某个正则的条目 | `node tools/asar/asar-list.mjs <archive> <regex> [--extract <outDir> <regex>]` |
| `asar/asar-dump-presets.mjs` | 从 asar 里取出 `presets/*.patch.yml`，用大括号配平扫描直接定位头部 JSON（不依赖 pickle 细节） | `node tools/asar/asar-dump-presets.mjs [asar] [outDir]`，默认输出到当前目录的 `asar-presets/` |
| `session/zstd-jsonl.mjs` | 解 DSH 的会话文件：它是**拼接的 zstd 帧流**（每批追加一帧），Node 的 `zstdDecompressSync` 只认第一帧，这个脚本按帧头逐段解 | 供下面两个脚本 import |
| `session/dump-session.mjs` | 把 `session.v4.jsonl.zstd` 转成纯文本 JSONL，并打印工具调用事实 | `node tools/session/dump-session.mjs <path-to-.jsonl.zstd> [outFile] [regex]` |
| `session/dump-convo.mjs` | 从 dump 出来的 JSONL 打印可读对话记录 | `node tools/session/dump-convo.mjs <session.jsonl> [maxChars]` |
| `probes/` | **历史一次性探针**，写于具体某次排查，保留是为了留下取证手段，不当作维护中的工具 | 见下 |

`probes/` 里各一条：

- `probe-asr-load.py`：分别计时每个本机 ASR 后端的加载与一次解码（每个子命令单独起进程，`.cpu_seconds` 与页缓存状态才诚实）。用 `bridge/.venv` 的解释器跑，模型目录可用 `XIAOAI_MODELS` 覆盖。
- `probe_server.py`：隔离验证 `start_server()` 是否真的绑到了 `0.0.0.0:4399`。
- `probe_banner.py`：打印 `stdout.encoding` / `PYTHONIOENCODING` 与桥接器启动横幅，排查 Windows 控制台编码把横幅打成乱码的问题。
- `probe-prompts.mjs`：打印回复器提示词、`composeVoiceRule()` 与 `buildOverrides()` 的实际产物（核对默认提示词是否与配置一致）。
- `probe-rev.mjs`：算出本机 `lib/client.js` 的 artifact revision，再向运行中的 DSH 请求 `/plugins/dsh-xiaoai-bridge/client.js?rev=…`，看宿主发的是不是当前工作树那一份。
- `probe-rev2.mjs`：同一套 rev 计算，但遍历 profile 的 `node_modules` 里若干插件的 `./client` 导出（profile 路径用 `DSH_PROFILE_NODE_MODULES` 覆盖）。

## 笔记

- [../docs/notes/recon-notes.md](../docs/notes/recon-notes.md)：早期侦察阶段的**实测**事实（Windows 本机编译链、设备侧行为等），全部带命令或源码依据。
- [../docs/notes/dsh-settings-api.md](../docs/notes/dsh-settings-api.md)：DSH `0.2.0-rc.2` 设置页 / 表单 API 的核对结果，源码取自本机 `app.asar`。

## 已知状态

- `drive-client.mjs` 的**机器**仍然可用（真的 hook 语义 + 直接调 handler），但它的**断言写于客户端半上一轮返工之前**，对着现在的工作树跑会报若干 `FAILED`（字段取了 `props.text` 而现在的 primitive 传的是别的键、几处文案已经改过）。它只作探索用，**不要**把它当通过与否的门槛；客户端半的门槛是 `scripts/check-client.mjs`（在 `npm run check` 里）。要重新拿它当验收工具，得先按当前 `lib/client.js` 把断言刷新一遍。
- `probes/` 里的探针保留原样，路径按当时的机器写（能改的已经改成相对脚本自身解析）；找不到目标文件时它们会直接报错，这是预期行为。

