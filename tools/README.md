# tools/ — 开发期工具（不随包发布）

这里放的是**维护这个仓库时用的工具**，不参与插件运行，也**不在** `package.json` 的 `files` 白名单里：npm 包里没有 `tools/`，装出来的副本也不依赖它。

与 `scripts/` 的区别：`scripts/check-*.mjs` 是每次提交前必跑的九条离线检查（`npm run check`，见 [AGENTS.md](../AGENTS.md) 的验收标准），这里的脚本是**按需**用的辅助工具，不属于 CI 口径。跑过文档或 CHANGELOG 改动时建议顺手跑前两条。

所有脚本都按「从仓库任意位置跑」写（路径相对脚本自身解析），只有个别参数需要自己给。

| 工具 | 用途 | 用法 |
|---|---|---|
| `doc-check.mjs` | 对外文档 QA：README / CHANGELOG / CONTRIBUTING 里的 emoji、`---` 分隔线、表格列数是否一致，以及 README 内部锚点是否都能落到标题上 | `node tools/doc-check.mjs` |
| `changelog-check.mjs` | CHANGELOG 结构 QA：版本标题格式（非 `Unreleased` 必须有 `- YYYY-MM-DD`）、中文类别必须排在英文之前、中英两侧类别与条目数一一对应、类别名在白名单内 | `node tools/changelog-check.mjs` |
| `plugin-smoke.mjs` | 宿主侧端到端冒烟：用假 cordis 上下文加载 `lib/index.js` 并应用插件，然后直接驱动挂上的 `/plugin/xiaoai` handler，覆盖 `/asr` 鉴权、`/config` revision 冲突与 `POST /data/wipe` 的拒绝路径 | `node tools/plugin-smoke.mjs` |
| `render-outline.mjs` | 用 `check-client.mjs` 的那套桩渲染 `lib/client.js`，打印页面大纲（折叠区、隐藏字段、控件种类），改设置页时不用重启 DSH 就能看结构 | `node tools/render-outline.mjs` |

## 已知状态

- `plugin-smoke.mjs` 的断言跟着 `/plugin/xiaoai` 的现有路由写；路由或拒绝路径改名时要同步它，否则会报 `FAILED`。
- 其余脚本没有已知失败项；它们只读仓库文件，不改工作树。
