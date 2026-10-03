# 参与开发

这个仓库有两半：根目录的 **DSH 插件**（Node，`lib/`）与 `bridge/` 下的 **Python 桥接器**（fork 上游）。改动前先读 [README.md](README.md) 与 [docs/deploy.md](https://github.com/OMSociety/dsh-xiaoai-bridge/blob/main/docs/deploy.md)——后者按「期」记录了每个决策、踩过的坑与取证方式（这份不随包发布，只在仓库里存在，所以这里用绝对地址）。给编码 agent 的硬规则（命令、模块边界、禁区、验收）见 [AGENTS.md](AGENTS.md)。

## 环境

| 需要 | 版本 / 说明 |
| --- | --- |
| Node | 20 或更新（插件侧） |
| pnpm | 装依赖用（`@deepseek-ai/schemastery`） |
| Python | 3.12（`bridge/` 里的 `.venv` 由 `uv sync` 生成） |
| uv | 建桥接器虚拟环境；`uv sync` 会现场编译 Rust 扩展，需要 Rust 工具链 |
| DSH | `0.2.x` 插件线；本机用 `dsh plugin --profile desktop add <仓库路径>` 装载 |

模型包（VAD / KWS / ASR，约 470 MB）不随仓库走，按 [README 的快速开始](README.md#快速开始)下载到 `bridge/core/models/`。

## 改动之后要跑什么

```powershell
# 一次跑完九个（聚合入口，等价于下面逐条跑；任一非 0 即整体非 0）
npm run check

node scripts\check-client.mjs      # 客户端 bundle
node scripts\check-config.mjs      # 配置渲染
node scripts\check-keywords.mjs    # 唤醒词 / 退出词
node scripts\check-session.mjs     # 会话与设备路由
node scripts\check-supervisor.mjs  # 进程托管与看门狗
node scripts\check-speak.mjs       # 播报纪律与工具
node scripts\check-diagnostics.mjs # 错误库与失败分类
node scripts\check-http.mjs        # HTTP 层（鉴权、体积上限、同源、路由）
node scripts\check-cleanup.mjs     # 数据目录切分与端口探测

Set-Location bridge
.\.venv\Scripts\python.exe -m pytest -q
```

动了插件行为就补对应的 checker，动了桥接器就补 `bridge/tests/`；两边都改就都跑。`npm run check` 全绿加上 `pytest` 全绿是提交前的底线。

## 代码放在哪

```
lib/index.js        插件入口：设置卡片、生命周期、session/event 转发
lib/process.js      子进程托管：启动、停止、日志、看门狗、渲染配置
lib/tools.js        xiaoai_speak 工具
lib/auto-speak.js   播报纪律（谁在什么时候出声）
lib/bridge.js       桥接器 HTTP 客户端与失败分类
lib/diagnostics.js  错误库
lib/client.js       设置页与运行状态卡（客户端 bundle）
skills/xiaoai-speak/  模型用的技能
bridge/             Python 桥接器（上游 fork；DSH 后端在 core/dsh*.py）
scripts/            自检脚本（九个 check-*.mjs + 聚合入口 check-all.mjs）
docs/deploy.md      实施与验证记录（不随包发布）
```

## 约定

- **对外文档零 emoji**（箭头 `→`、`•`、`—` 这类符号不算），README 与 CHANGELOG 里不写 `---` 分隔线。
- 交付物只写最终采用的客观状态：被否方案、中间尝试不写进 README / CHANGELOG / 提交信息。
- **版本号变更先报备**：`package.json` 的 `version` 是唯一版本源，改完记得同步 README 徽章与 CHANGELOG。
- 配置与凭据**绝不入库**：`bridge/config.py` 是上游模板必须保留，渲染产物 `config.py.rendered`、`device.json`、`devices.json`、`*.token`、`credentials.json` 都已在 `.gitignore` 里（凭据一旦进了历史就得轮换，删文件没用）。
- `pnpm-lock.yaml` 也忽略，但**理由和凭据不同，别混为一谈**：它不是敏感文件，只是本插件用不上——消费者侧（DSH 用 pnpm 装包）从 `package.json` 解析依赖边，profile 里有自己的锁与闸门文件；`files` 白名单也不含它，装出来的副本里根本没有这份锁。入库的唯一收益是让贡献者复现插件侧那棵树，代价是锁文件长期在实际解析结果后面漂着。要复现就本地 `pnpm install --lockfile-only` 临时生成。对照：`bridge/uv.lock` 与 `bridge/Cargo.lock` 是**有意入库**的，因为桥接器就在这套源码上原地运行、依赖树必须可复现。
- PowerShell 不支持 `<<<`：提交信息先写临时文件，再 `git commit -F <文件>`。

## 同步上游

```powershell
git fetch upstream
git log --oneline upstream/main | Select-Object -First 20
```

`upstream` 指向 [coderzc/open-xiaoai-bridge](https://github.com/coderzc/open-xiaoai-bridge)。合上游改动时保留它的历史与 tag（本仓库所有 tag 都属于上游桥接器）。`bridge/` 那半**不是**原样搬运：`bridge/AGENTS.md`、`bridge/README.md`、`bridge/CHANGELOG.md` 在 `09ef117` 那次改写里被改过（品牌字样、删掉不适用章节），所以合上游时这三个文件必然要人工过一遍，别指望能直接取上游版本；除此之外的改动逐条记在 [CHANGELOG.md](CHANGELOG.md) 里，别顺手重排格式。

## 许可

[MIT](LICENSE)。上游版权行（`Del Wang`、`coderzc`）原样保留，本仓库新增部分的版权行追加在其后（`OMSociety`）。提交即表示你同意以同一许可分发你的改动；引用第三方代码前先确认许可证兼容。
