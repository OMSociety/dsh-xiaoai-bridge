# DSH 0.2.0-rc.2 设置页/表单 API 核对结果（第 1 期 1.0 的产物）

来源：本机 DSH 安装目录下的 `resources/app.asar` 实际源码（不是二手结论；路径随安装位置而变，例如 `D:\Program Files\DeepSeek Harness\resources\app.asar`）。
提取工具：`tools/asar/asar-tool.mjs`（用法 `node tools/asar/asar-tool.mjs probe|find <substr>|extract <asar内路径> <输出目录>`；asar 路径默认按上面的安装位置，可用环境变量 `DSH_ASAR` 覆盖）。
解包产物**不进仓库**：那是一次性的临时目录，需要时用上面的工具现场重新提取。

## 1. app.asar 头部结构（实测，别再猜）

```
offset 0  UInt32LE = 4           (pickle payload size)
offset 4  UInt32LE = 3392056
offset 8  UInt32LE = 3392052
offset 12 UInt32LE = 3392048     ← JSON 索引长度
offset 16 起 = JSON 索引（3392048 字节）
文件内容起始 = 16 + 3392048 = 3392064
```
顶层 keys：`dsh, node_modules, lib, package.json, renderer`。
宿主包在 `dsh/node_modules/@deepseek-ai/<pkg>/`。

## 2. 设置表单组件清单（**权威**，来自 `@deepseek-ai/dsh-client-ui-primitives` 的 export 列表）

设置表单专用（只有这些）：

| 导出名 | 类型 | 说明 |
|---|---|---|
| `SettingsForm` | 组件 | 表单外壳。props：`labels`{unavailable,readOnly,saveFailed,save,saving}、`state`、`onSave`、`onDiscard`、`children` |
| `SettingsValueField` | 组件 | 文本/数字字段。props：`id`、`label`、`hint`、`overriddenLabel`、`resetLabel`、`invalidLabel`、`numeric`、`disabled`、展开的 field state、`onEdit(text)`、`onReset()` |
| `SettingsSecretField` | 组件 | 密钥字段（不显示明文）。props：`id`、`label`、`hint`、`disabled`、`text`、`configured`、`stateLabel`、`onEdit(text)` |
| `SettingsFormModel` | 类 | `new SettingsFormModel(scope, [fieldSpecs], [customFields])`；方法 `.bind(() => projection())` → store、`.shell()`、`.field(name)`、`.actions()`、`.dispose()` |
| `settingsTextField(name)` | 字段规格 | 文本字段规格 |
| `settingsNumberField(name)` | 字段规格 | 数字字段规格 |

**结论：没有布尔字段规格**（确认了此前"只有两个规格"的说法；布尔要用 `customFields` 或 `Switch` + 自定义字段自己接线）。
其他可复用 UI 原语（非设置专用）：`Switch`、`Checkbox`、`Input`、`Button`、`SegmentedControl`、`SegmentedTabs`、`Menu`/`MenuItemButton`/`MenuGroup`/`MenuSurface`、`Modal`、`Tag`、`Pill`、`StateDot`、`Tooltip`、`Toast`、`DisclosureRow`、`RiskConfirmation`、`PathLabel`、`HoverCard`、`ShortcutKeys`、`ConnectionIndicator`、`MarkdownText`。

## 3. 官方内置设置页的完整写法（0.2.0-rc.2 实证）

文件：`asar-out\dsh\node_modules\@deepseek-ai\dsh-client-ui-settings-web-search\lib\client.js`

```js
const inject = ["slots", "locale", "remote", "remote.credentials", "configForms"];

function apply(ctx) {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "…: dictionaries");
  const card = new WebSearchCardController(ctx.configForms.get("web-search-deepseek"), ctx);
  ctx.effect(() => () => card.dispose(), "…: form subscription");
  ctx.effect(() => ctx.configForms.whileServed([NS_OF_OWNER], () =>
    ctx.slots.inject("plugins.item", () => ctx.slots.register({
      name: "plugins.item", id: "web-search", order: 40,
      label: () => t("title"), locale: NS, inject: () => card.inject()
    }, WebSearchCard))), "…: page");
}
```

控制器骨架：
```js
this.form = new SettingsFormModel(scope, [settingsTextField("baseURL"), settingsNumberField("maxUses")],
                                  [{ field: "apiKey", write: (text) => this.writeKey(text) }]);
this.store = this.form.bind(() => this.projection());
projection() { return { ...this.form.shell(), baseURL: this.form.field("baseURL"), … }; }
inject() { return { hooks: { webSearchCard: this.store }, ...this.form.actions() }; }
```

要点：
- `scope = ctx.configForms.get(<设置命名空间>)`；`scope.getSnapshot()` 有 `{value, base, user, revision, writable, persistence}`。
- 组件用 `props.useXxx((s) => s)` 取快照，`props.view === "summary"` 时只渲染一行说明。
- 密钥走 **credentials 域**：`ctx.remote.credentials.describe([ref])` / `.set(ref, value)`，事件 `credentials/reference-updated`。

## 4. 两类 slot，别搞混

| slot 名 | 位置 | 注册形态 |
|---|---|---|
| `settings.plugins.tab` | 设置里「内置插件」分区的标签行 | `{ name, id, order, label }`，label 可以是字符串（mineru 用 `"MinerU 解析"`）也可 `() => t("title")`；只有 1 个贡献时直接当整页渲染 |
| `plugins.item` | 「插件」页里的条目 | `{ name, id, order, label, locale, inject }`；官方四个配置页 + web-search 走这条 |

`settings.plugins.tab` 是 root 级 list slot。**本项目的设置卡片按锁定决定注册 `settings.plugins.tab`**（dsh-mineru `lib/client.js:778-783` 就是这么做的：`ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({name:"settings.plugins.tab", id:"mineru", order:30, label:"MinerU 解析"}, MineruSettingsTab))`）。

## 5. 客户端插件必须是构建产物

`lib/client.js` 的形态是：
```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-settings-web-search",
  factory: (require) => { … var module={exports:{}}; … return module.exports; }
});
```
`require()` 拿到的模块名是 **完整 scoped 名**（如 `require("@deepseek-ai/dsh-client-ui-primitives")`）。dsh-mineru 的 `lib/client.js` 也是同一格式（第 800 行收尾）。

## 6. 宿主侧 peer 依赖线（dsh-mineru 是 0.1.5 线，仅作参考）

dsh-mineru `package.json`：peerDeps `@deepseek-ai/cordis ^4.0.1`、`schemastery ^3.18.0`、`dsh-tools/dsh-settings/dsh-credentials/dsh-skill/dsh-host-webserver/dsh-llm ^0.1.5-rc.1`；`dsh.bundle.patch=./cordis.patch.yml`；`dsh.client.inject=["slots","connection","sessions","conversation","locale"]`（裸名，非 scoped）。
**本项目按 handoff §7.1 走 0.2.x 线**（`@deepseek-ai/cordis ^4.0.4`＋`@deepseek-ai/dsh-* ^0.2.0-rc.1`），peer 名与 inject 名以 dsh-better-sidebar v0.24.1 为准。
