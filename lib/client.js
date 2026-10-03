/**
 * dsh-xiaoai-bridge browser half (hand-authored bundle, committed as a build
 * artifact — the format is the one DSH's module loader consumes, so there is no
 * bundler in the build path).
 *
 * Registers the bundle's own configuration page into `plugins.bundle.config`
 * with the key `dsh-xiaoai-bridge`. That slot is owned by
 * dsh-client-ui-plugin-manager and rendered on the bundle's own page inside the
 * 插件 (Plugins) view, between the bundle's description and its rows — the place
 * DSH reserves for a bundle's own configuration. It is NOT the Settings ->
 * 内置插件 tab strip (`settings.plugins.tab`), which is for the host's own
 * settings pages.
 *
 * The owner dispatches exactly `{ entryKey: <package name> }` and passes
 * `{ view: 'page' }`; `view: 'summary'` is handled defensively (the row-config
 * slot uses it as a fallback description). No `form` prop is supplied — the
 * plugin manager documents that a bundle-wide page "has no single form" and
 * owns its own draft and save — so this page keeps a staged draft and writes
 * through the plugin's own revision-fenced HTTP route:
 *
 *   GET  /plugin/xiaoai/config  -> { ok, descriptor: { ns, revision, value, base, user, secrets } }
 *   POST /plugin/xiaoai/config  -> { ops: [{ op: 'set'|'unset', path, value? }], revision }
 *
 * It always writes `ops` rather than `patch` because a merge cannot express a
 * reset, and the reset button is a first-class affordance here.
 *
 * The controls come from `@deepseek-ai/dsh-client-ui-primitives`, the same
 * package the host's own settings pages use, so the page matches them without
 * re-implementing their look. That package is a plain shared library rather
 * than a cordis service, which is why it is required here but absent from
 * `dsh.client.inject` (dsh-client-ui-settings-subagent does exactly the same).
 */
window.__ModuleLoader__.load({
	id: "dsh-xiaoai-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var jsx = require("react/jsx-runtime").jsx;
		var jsxs = require("react/jsx-runtime").jsxs;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useCallback = React.useCallback;

		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		var SettingsForm = primitives.SettingsForm;
		var SettingsValueField = primitives.SettingsValueField;
		var Switch = primitives.Switch;
		var SegmentedControl = primitives.SegmentedControl;
		var Tag = primitives.Tag;
		var DisclosureRow = primitives.DisclosureRow;
		var Button = primitives.Button;
		var IconChevronDownOutlineRegular = primitives.IconChevronDownOutlineRegular;
		var IconRefreshOutlineRegular = primitives.IconRefreshOutlineRegular;

		var BUNDLE_SLOT = "plugins.bundle.config";
		var BUNDLE_KEY = "dsh-xiaoai-bridge";
		var CONFIG_URL = "/plugin/xiaoai/config";
		var HEALTH_URL = "/plugin/xiaoai/health";
		// Mirrors SPOKEN_LOG_MAX_BYTES in lib/speech-log.js: the host rotates
		// spoken.jsonl past this size, and the card shows the fraction used.
		var SPOKEN_LOG_CAP_BYTES = 5 * 1024 * 1024;

		/** Dictionary namespace for this page's copy (not the settings namespace). */
		var NS = "plugin.xiaoai";

		/**
		 * The page draws itself with the host's theme tokens, so it follows the
		 * light and dark schemes without re-rendering, and it reuses the
		 * geometry the settings primitives already ship (13px labels, 34px
		 * controls, `--dsw-radius-md`, hairline separators between fields).
		 *
		 * The rules live in one stylesheet injected into the document instead
		 * of in inline styles: `:hover`, `:focus-visible`, a disabled control
		 * and the native `<select>`'s own chrome cannot be expressed inline at
		 * all. The primitives inject their CSS the same way, and a host page can
		 * mount this slot more than once, so the tag is keyed by id and inserted
		 * once.
		 */
		var CSS_TAG_ID = "dsh-xiaoai-bridge/client.css";
		var PLUGIN_CSS = [
			".xiaoai_page { display: flex; flex-direction: column; gap: 28px; }",
			".xiaoai_pageHead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }",
			".xiaoai_title { margin: 0; font-size: 15px; font-weight: 600; line-height: 22px; color: var(--dsw-alias-label-primary); }",
			".xiaoai_lead { margin: 0; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-tertiary); }",
			".xiaoai_notice { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-state-success-primary); }",
			// Settings stored, bridge config not rewritten: worth attention, not an error.
			".xiaoai_noticeWarn { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-state-warn-primary); }",
			".xiaoai_section { display: flex; flex-direction: column; min-width: 0; }",
			// The disclosure row ships a fixed 24px line; a section header needs
			// room for a 20px title and reads as a heading, not as one more row.
			".xiaoai_sectionRow { height: auto; min-height: 30px; }",
			".xiaoai_sectionTitle { font-size: 14px; font-weight: 500; line-height: 20px; color: var(--dsw-alias-label-primary); }",
			".xiaoai_subTitle { font-size: 13px; font-weight: 500; line-height: 20px; color: var(--dsw-alias-label-secondary); }",
			".xiaoai_fields { display: flex; flex-direction: column; min-width: 0; }",
			// The nested 高级 block lines its fields up under its title text:
			// 14px chevron + the 6px the disclosure row leaves after it.
			".xiaoai_fieldsNested { padding-left: 20px; }",
			// One wrapper per field: a gated field stays mounted (its draft and
			// its validation message must survive the toggle that hid it) and a
			// hidden wrapper still keeps the separator chain between the fields
			// that remain visible.
			".xiaoai_fieldWrap { min-width: 0; }",
			".xiaoai_fieldWrap + .xiaoai_fieldWrap { border-top: 0.5px solid var(--dsw-alias-border-l2); }",
			".xiaoai_field { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 12px 0; }",
			".xiaoai_head { display: flex; align-items: center; gap: 8px; }",
			".xiaoai_label { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }",
			".xiaoai_badges { display: inline-flex; align-items: center; gap: 8px; }",
			".xiaoai_reset { font: inherit; font-size: 12px; padding: 0; border: 0; background: none; color: var(--dsw-alias-label-secondary); cursor: pointer; }",
			".xiaoai_reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); text-decoration: underline; }",
			".xiaoai_reset:disabled { opacity: 0.5; cursor: default; }",
			".xiaoai_control { display: flex; align-items: center; gap: 10px; min-width: 0; }",
			".xiaoai_input { box-sizing: border-box; width: 100%; height: 34px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }",
			".xiaoai_input:hover { border-color: var(--dsw-alias-border-l3); }",
			".xiaoai_input:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }",
			'.xiaoai_input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }',
			".xiaoai_input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }",
			".xiaoai_textarea { height: auto; min-height: 68px; padding: 8px 12px; line-height: 1.6; resize: vertical; }",
			".xiaoai_selectWrap { position: relative; display: flex; align-items: center; width: 100%; }",
			// The native arrow cannot follow the theme, so it is replaced by the
			// host's own chevron glyph next to a reset appearance.
			".xiaoai_select { appearance: none; -webkit-appearance: none; padding-right: 32px; cursor: pointer; }",
			".xiaoai_selectChevron { position: absolute; right: 10px; display: inline-flex; align-items: center; color: var(--dsw-alias-label-tertiary); pointer-events: none; }",
			".xiaoai_selectWrap:hover .xiaoai_selectChevron { color: var(--dsw-alias-label-secondary); }",
			".xiaoai_hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }",
			".xiaoai_invalid { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }",
			".xiaoai_hidden { display: none; }",
			".xiaoai_card { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }",
			".xiaoai_cardTitle { font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }",
			".xiaoai_row { display: flex; align-items: baseline; gap: 12px; font-size: 12px; line-height: 1.7; }",
			".xiaoai_rowLabel { flex: 0 0 150px; color: var(--dsw-alias-label-secondary); }",
			".xiaoai_rowValue { flex: 1 1 auto; min-width: 0; word-break: break-all; color: var(--dsw-alias-label-primary); }",
			".xiaoai_mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }",
			".xiaoai_statusSection { display: flex; flex-direction: column; gap: 12px; }",
			".xiaoai_summary { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }",
		].join("\n");

		/** Insert this page's stylesheet once per document. */
		function ensureStyles() {
			if (typeof document === "undefined" || !document.head) return;
			if (document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') !== null) return;
			var tag = document.createElement("style");
			tag.dataset.plugin = BUNDLE_KEY;
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = PLUGIN_CSS;
			document.head.appendChild(tag);
		}

		/**
		 * Built-in copy. `ctx.locale` overrides it when the service is present,
		 * but the page must still read correctly on a host that does not expose
		 * it, so the Chinese strings double as the fallback dictionary.
		 */
		var COPY = {
			zh: {
				"page.title": "小爱音箱桥接器",
				"page.intro": "唤醒词、桥接器进程与语音闭环的设置。修改后点「保存」才会写入。",
				"section.basic": "基本",
				"section.voice": "唤醒与语音",
				"section.doubao": "豆包语音合成",
				"section.reply": "应答与兜底",
				"section.speak": "播报与回复器",
				"section.persona": "人格与提示词",
				"section.process": "桥接器进程",
				"section.api": "本地 API 服务",
				"section.advanced": "高级",
				"section.status": "运行状态",
				"field.enabled": "启用插件",
				"field.deviceName": "音箱名称",
				"field.deviceHost": "音箱地址",
				"field.wakeKeywords": "唤醒词",
				"field.wakeupTimeout": "对话保持时长（秒）",
				"field.continuousConversation": "连续对话",
				"field.asrBackend": "语音识别后端",
				"field.ttsProvider": "语音合成方式",
				"field.ttsSpeaker": "朗读音色",
				"field.doubaoAppId": "豆包 App ID",
				"field.doubaoAccessKeyCredential": "豆包访问令牌凭据名",
				"field.doubaoSpeaker": "豆包音色",
				"field.doubaoAudioFormat": "豆包音频格式",
				"field.doubaoStream": "边合成边播放",
				"field.ttsSpeed": "豆包语速",
				"option.ttsProvider.auto": "跟随音色",
				"option.ttsProvider.xiaoai": "小爱原生",
				"option.ttsProvider.doubao": "豆包",
				"option.doubaoAudioFormat.inherit": "沿用配置",
				"option.doubaoAudioFormat.auto": "自动",
				"option.doubaoAudioFormat.pcm": "PCM",
				"option.doubaoAudioFormat.mp3": "MP3",
				"option.doubaoAudioFormat.ogg_opus": "OGG Opus",
				"field.sessionCwd": "会话工作区",
				"field.sessionCwd.follow": "不指定（跟随默认工作区）",
				"field.sessionCwd.stale": "当前值（已不在工作区列表里）：",
				"field.wakeupReplyText": "唤醒应答",
				"field.exitReplyText": "退出应答",
				"field.exitKeywords": "退出词",
				"field.fallbackText": "兜底播报文本",
				"field.sessionKey": "会话键",
				"field.autoSpeak": "自动念出回复",
				"field.speakFromAnySession": "任何会话都能让小爱说话",
				"field.agentPreset": "音箱会话的 Agent 预设",
				"field.spokenMaxChars": "播报字数上限",
				"field.replyerProvider": "回复器提供商",
				"field.replyerModel": "回复器模型",
				"field.replyerHistoryTurns": "回复器参考轮数",
				"field.replyerFailureText": "回复器失败提示语",
				"field.approvalText": "审批等待提示语",
				"field.personality": "人格设定",
				"field.replyStyle": "说话风格",
				"field.behaviorStyle": "行动准则",
				"field.outputLimits": "输出限制",
				"field.voiceRuleText": "语音消息附加提示",
				"field.bridgeDir": "桥接器目录",
				"field.pythonPath": "Python 解释器",
				"field.autoStart": "随插件启动桥接器",
				"field.silentStart": "静默启动",
				"field.logLevel": "日志级别",
				"field.apiServerEnabled": "启用本地 API 服务",
				"field.apiServerHost": "监听地址",
				"field.apiServerPort": "监听端口",
				"field.apiServerTokenCredential": "访问令牌凭据名",
				"hint.deviceName": "显示在会话标题里。",
				"hint.deviceHost": "音箱的局域网地址；留空则由桥接器上报。",
				"hint.wakeKeywords": "每行一个唤醒词，命中即进入 DSH 连续对话。",
				"hint.sessionCwd": "从这台机器上已有的 DSH 工作区里挑一个：音箱会话会出现在那个分组里，agent 的工作目录也是它。留空则使用第一个工作区。",
				"hint.bridgeDir": "留空则使用包内的 bridge/ 目录。",
				"hint.pythonPath": "留空则使用 bridge/.venv 下的解释器。",
				"hint.silentStart": "开启后，桥接器连上音箱时不再播报「已连接」，启动过程不出声。",
				"hint.logLevel": "桥接器进程的日志级别。",
				"hint.apiServerTokenCredential": "存放访问令牌的凭据名；桥接器用它调用本插件。",
				"hint.wakeupTimeout": "一次唤醒后的连续对话保持多久，单位秒（1–600）。",
				"hint.continuousConversation": "开启后一次唤醒可以接着说下一句，直到静默超时或说出退出词；关闭（默认）则一句话一次唤醒。",
				"hint.ttsProvider": "用哪种方式合成语音。「跟随音色」由桥接器按音色判断（默认）；「小爱原生」强制用音箱自带合成；「豆包」强制用豆包语音合成，配合下面的豆包设置使用。",
				"hint.ttsSpeaker": "朗读用的音色：xiaoai 表示小爱原生音色，填豆包音色 ID 则改用豆包 TTS。",
				"hint.doubaoAppId": "火山引擎控制台里豆包语音服务的 App ID；留空沿用桥接器配置里的值。",
				"hint.doubaoAccessKeyCredential": "存放 Access Token 的 DSH 凭据名，令牌本身不写进设置；改这里之后要重启桥接器才会带上新令牌。",
				"hint.doubaoSpeaker": "强制用豆包时朗读的音色；留空沿用桥接器配置里的默认音色。",
				"hint.doubaoAudioFormat": "豆包返回的音频格式；「自动」按文本长短在 PCM 和 MP3 之间挑一个，留空沿用桥接器配置。",
				"hint.doubaoStream": "边合成边播放，首音更快；关闭则整段合成完再播。",
				"hint.ttsSpeed": "豆包朗读速度，0.5 到 2.0；留空恢复默认的 1.0。",
				"hint.replyText": "听到唤醒词或退出词时说出的应答。",
				"hint.exitKeywords": "每行一个，说出任意一个即提前结束对话。",
				"hint.fallbackText": "桥接器在运行、但本插件联系不上时说出的话。",
				"hint.sessionKey": "桥接器上报语音、挑选音色时用的会话键；留空则用桥接器内置默认值。插件按音箱设备区分 DSH 会话，所以改这里不会切换音箱对话所在的会话。",
				"hint.autoSpeak": "关闭后只有模型主动调用 xiaoai_speak 工具才会发声。",
				"hint.speakFromAnySession": "关闭（默认）时 xiaoai_speak 只在音箱发起的对话里可用；开启后电脑或网页的普通对话也能直接调用它。",
				"hint.agentPreset": "音箱那个对话按哪个预设组建（本仓库带一个「小爱模式」，需要先在插件市场里安装 preset/xiaoai）。留空用宿主默认预设；填了但没装不会报错，只会回落成宿主默认并留下一条诊断。默认 xiaoai。",
				"hint.spokenMaxChars": "一条播报最多多少字（40–2000）；超出会先让回复器精简一次，仍超就截断。",
				"hint.replyerModel": "留空则跟随该会话的默认模型；两者都填时按填写的路由调用。",
				"hint.replyerHistoryTurns": "回复器能看到最近多少轮对话（0–50）。",
				"hint.replyerFailureText": "回复器连续失败时改念这句，避免念出未经润色的原文。",
				"hint.approvalText": "工具需要你在屏幕上确认时念这句。审批请求的正文永远不会被念出来。",
				"hint.personality": "回复器的人格设定，只影响音箱念出来的话。",
				"hint.replyStyle": "回复器的说话风格。",
				"hint.behaviorStyle": "追加到音箱会话的系统提示里，只影响由音箱发起的那一个会话。",
				"hint.outputLimits": "写进回复器请求的硬性约束。",
				"hint.voiceRuleText": "桥接器会把它追加在每条语音输入后面。改了它，模型就会知道自己的回复会被念出来。",
				"hint.empty": "留空后保存等于恢复默认。",
				"invalid.port": "端口必须是 1 到 65535 之间的整数。",
				"invalid.seconds": "必须是允许范围内的整数。",
				"invalid.range": "超出允许范围，请填范围内的整数。",
				"invalid.rangeFloat": "超出允许范围，请填 0.5 到 2.0 之间的小数。",
				"invalid.number": "必须是一个整数。",
				"invalid.identifier": "必须是字母或下划线开头的标识符。",
				"invalid.required": "不能为空。",
				"form.unavailable": "设置暂不可用：插件的设置卡片未注册或未激活。",
				"form.readOnly": "当前为只读。",
				"form.save": "保存",
				"form.saving": "保存中…",
				"form.saveFailed": "保存失败，请重试。",
				"form.overridden": "已覆盖",
				"form.reset": "重置为默认",
				"form.resetStaged": "待重置",
				"form.undo": "撤销",
				"state.loading": "正在读取设置…",
				"state.loadFailed": "无法读取设置：",
				"state.saved": "已保存。",
				"state.renderFailed": "设置没能写入桥接器配置：config.py 渲染失败，桥接器仍在用旧配置。请再点一次保存重试。",
				"state.conflict": "设置在别处被修改了，已重新加载，请确认后再保存。",
				"status.loading": "正在读取插件状态…",
				"status.failed": "无法读取插件状态：",
				"status.refresh": "刷新",
				"status.running": "运行中",
				"status.stopped": "未运行",
				"status.adopted": "已接管遗留进程",
				"status.pid": "进程号",
				"status.process": "桥接器进程",
				"status.checks": "环境自检",
				"status.ready": "已就绪",
				"status.notReady": "未就绪",
				"status.check.bridgeDirIsDirectory": "桥接器目录",
				"status.check.pythonExists": "Python 解释器",
				"status.check.modelsDirExists": "模型目录",
				"status.check.skillFileExists": "技能文件",
				"status.paths": "解析路径",
				"status.path.bridgeDir": "桥接器源代码",
				"status.path.pythonPath": "Python",
				"status.path.modelsDir": "模型",
				"status.spokenLog": "播报日志",
				"status.spokenLogPath": "日志文件",
				"status.api": "桥接器接口",
				"status.api.connected": "已连接",
				"status.api.unreachable": "未连接",
				"status.api.unauthorized": "令牌被拒绝",
				"status.api.disabled": "已关闭",
				"status.apiUrl": "服务地址",
				"status.apiAuth": "鉴权方式",
				"status.auth.bearer": "需要令牌",
				"status.auth.loopback-only": "仅限本机",
				"status.token": "访问令牌",
				"status.tokenConfigured": "已配置",
				"status.tokenMissing": "未配置（本机可直连）",
				"status.doubaoKey": "豆包访问令牌",
				"status.doubaoKeyConfigured": "已配置",
				"status.doubaoKeyMissing": "未配置",
				"status.watchdog": "看门狗重启次数",
				"status.watchdogGaveUp": "已放弃重启",
				"status.nextRestart": "下次重启",
				"status.lastError": "最近错误",
				"status.noErrors": "没有记录到错误",
				"status.diagnostics": "错误记录",
				"status.preset": "音箱会话预设",
				"status.preset.hostDefault": "宿主默认",
				"status.preset.no-registry": "这台 DSH 没有预设注册表",
				"status.preset.missing": "没有安装",
				"status.preset.broken": "装不上",
				"status.errorCount": "重复次数",
				"diagnostic.bridge-unreachable": "桥接器没有响应",
				"diagnostic.bridge-rejected": "桥接器拒绝了令牌",
				"diagnostic.plugin-rejected": "有调用带着错误的令牌",
				"diagnostic.bridge-error": "桥接器返回了错误",
				"diagnostic.bridge-timeout": "请求超时",
				"diagnostic.start-failed": "桥接器启动失败",
				"diagnostic.watchdog-gave-up": "看门狗已放弃重启",
				"diagnostic.port-held": "端口在停止后仍被占用",
				"diagnostic.token-not-applied": "桥接器先于令牌启动，重启桥接器即可生效",
				"diagnostic.scope-registration-unavailable": "这台 DSH 不支持按会话注册工具，xiaoai_speak 没有注册",
				"diagnostic.scope-registration-failed": "把 xiaoai_speak 注册进会话作用域时出错",
				"diagnostic.agent-preset-missing": "配置的 Agent 预设没有安装，这次回落到宿主默认预设",
				"diagnostic.agent-preset-broken": "配置的 Agent 预设装不上（声明有错），这次回落到宿主默认预设",
				"diagnostic.agent-preset-mount-failed": "把 Agent 预设挂到音箱会话上失败，这次回落到宿主默认预设",
				"diagnostic.session-archived-rebound": "音箱绑定过的那个会话已被归档（归档的会话跑不了模型步），这次为它开了一个新会话",
				"diagnostic.asr-model-unavailable": "设置页选的语音识别后端用不了（模型没装或加载失败），桥接器仍在用原来那个",
				"summary": "小爱音箱桥接器：唤醒词、桥接器进程与语音闭环设置",
			},
			en: {
				"page.title": "XiaoAI Speaker Bridge",
				"page.intro": "Wake words, the bridge process, and the voice loop. Changes are written only when you save.",
				"section.basic": "Basics",
				"section.voice": "Wake word and speech",
				"section.doubao": "Doubao speech synthesis",
				"section.reply": "Replies and fallback",
				"section.speak": "Speaking and reply generator",
				"section.persona": "Persona and prompts",
				"section.process": "Bridge process",
				"section.api": "Local API server",
				"section.advanced": "Advanced",
				"section.status": "Runtime status",
				"field.enabled": "Enable plugin",
				"field.deviceName": "Speaker name",
				"field.deviceHost": "Speaker address",
				"field.wakeKeywords": "Wake words",
				"field.wakeupTimeout": "Conversation timeout (s)",
				"field.continuousConversation": "Continuous conversation",
				"field.asrBackend": "Speech recognition backend",
				"field.ttsProvider": "Speech synthesis",
				"field.ttsSpeaker": "Reading voice",
				"field.doubaoAppId": "Doubao App ID",
				"field.doubaoAccessKeyCredential": "Doubao access token credential",
				"field.doubaoSpeaker": "Doubao voice",
				"field.doubaoAudioFormat": "Doubao audio format",
				"field.doubaoStream": "Stream while synthesising",
				"field.ttsSpeed": "Doubao speaking speed",
				"option.ttsProvider.auto": "Follow the voice",
				"option.ttsProvider.xiaoai": "XiaoAI native",
				"option.ttsProvider.doubao": "Doubao",
				"option.doubaoAudioFormat.inherit": "Keep the config value",
				"option.doubaoAudioFormat.auto": "Auto",
				"option.doubaoAudioFormat.pcm": "PCM",
				"option.doubaoAudioFormat.mp3": "MP3",
				"option.doubaoAudioFormat.ogg_opus": "OGG Opus",
				"field.sessionCwd": "Session workspace",
				"field.sessionCwd.follow": "Not set (follow the default workspace)",
				"field.sessionCwd.stale": "Saved value (no longer in the workspace list): ",
				"field.wakeupReplyText": "Wake reply",
				"field.exitReplyText": "Exit reply",
				"field.exitKeywords": "Exit words",
				"field.fallbackText": "Fallback announcement",
				"field.sessionKey": "Session key",
				"field.autoSpeak": "Speak replies automatically",
				"field.speakFromAnySession": "Let any conversation speak",
				"field.agentPreset": "Agent preset for the speaker conversation",
				"field.spokenMaxChars": "Spoken characters",
				"field.replyerProvider": "Reply generator provider",
				"field.replyerModel": "Reply generator model",
				"field.replyerHistoryTurns": "Reply generator context turns",
				"field.replyerFailureText": "Reply generator failure line",
				"field.approvalText": "Approval waiting line",
				"field.personality": "Persona",
				"field.replyStyle": "Speaking style",
				"field.behaviorStyle": "Action guidelines",
				"field.outputLimits": "Output limits",
				"field.voiceRuleText": "Voice-message instruction",
				"field.bridgeDir": "Bridge directory",
				"field.pythonPath": "Python interpreter",
				"field.autoStart": "Start the bridge with the plugin",
				"field.silentStart": "Start silently",
				"field.logLevel": "Log level",
				"field.apiServerEnabled": "Enable the local API server",
				"field.apiServerHost": "Listen address",
				"field.apiServerPort": "Listen port",
				"field.apiServerTokenCredential": "Access-token credential name",
				"hint.deviceName": "Shown as the session title.",
				"hint.deviceHost": "The speaker's LAN address; leave empty to use what the bridge reports.",
				"hint.wakeKeywords": "One wake word per line; a match enters DSH continuous conversation.",
				"hint.wakeupTimeout": "How long one wake session stays open, in seconds (1–600).",
				"hint.continuousConversation": "On: one wake word covers the next sentences too, until it goes quiet or you say an exit word. Off (default): one wake word per sentence.",
				"hint.ttsProvider": "How the speech is synthesised. Follow the voice lets the bridge decide from the voice id (default); XiaoAI native forces the speaker's own TTS; Doubao forces the Doubao client and uses the Doubao settings below.",
				"hint.ttsSpeaker": "The voice used for speech: xiaoai is the speaker's own voice, and a Doubao voice id switches to Doubao TTS.",
				"hint.doubaoAppId": "The App ID of the Doubao speech service in the Volcengine console; leave empty to keep the bridge config value.",
				"hint.doubaoAccessKeyCredential": "The DSH credential name holding the Access Token; the token itself never reaches the settings. Restart the bridge after changing it.",
				"hint.doubaoSpeaker": "The voice Doubao reads with when it is forced; leave empty to keep the bridge config's default voice.",
				"hint.doubaoAudioFormat": "The audio format Doubao returns; Auto picks PCM or MP3 by text length, and empty keeps the bridge config value.",
				"hint.doubaoStream": "Play while the audio is still being synthesised, so the first sound arrives earlier; off waits for the whole line.",
				"hint.ttsSpeed": "Doubao speaking speed, 0.5 to 2.0; leave empty for the default 1.0.",
				"hint.replyText": "Spoken when the wake word or the exit word is heard.",
				"hint.exitKeywords": "One per line; saying one ends the conversation early.",
				"hint.fallbackText": "Spoken when the bridge is up but this plugin cannot be reached.",
				"hint.sessionKey": "Session key the bridge reports with each utterance and uses for its per-session voice lookup; empty means the bridge's built-in default. This plugin separates DSH sessions by speaker device, so changing it does not move the speaker's conversation to another session.",
				"hint.sessionCwd": "Pick one of the DSH workspaces already on this machine: the speaker session shows up in that group, and the agent works in that directory. Empty uses the first workspace.",
				"hint.bridgeDir": "Empty uses the bridge/ directory inside this package.",
				"hint.pythonPath": "Empty uses the interpreter under bridge/.venv.",
				"hint.silentStart": "On: the bridge no longer speaks the connect prompt, so a start stays quiet.",
				"hint.logLevel": "Log level of the bridge process.",
				"hint.apiServerTokenCredential": "Credential holding the access token the bridge calls this plugin with.",
				"hint.autoSpeak": "Turn this off and the speaker only talks when the model calls xiaoai_speak.",
				"hint.speakFromAnySession": "Off (default): xiaoai_speak works only in conversations the speaker started. On: desktop and web chats may call it too.",
				"hint.agentPreset": "Which preset the speaker conversation is composed from (this repository ships a \"Xiaoai mode\" under preset/xiaoai — install that bundle first). Empty uses the host default. A preset that is not installed is not an error: the session falls back to the host default and leaves one diagnostic. Default xiaoai.",
				"hint.spokenMaxChars": "Longest reply to speak, in characters (40–2000). Longer text is condensed once, then cut.",
				"hint.replyerModel": "Empty follows the session's default model; fill both to route it elsewhere.",
				"hint.replyerHistoryTurns": "How many recent exchanges the reply generator sees (0–50).",
				"hint.replyerFailureText": "Spoken when the reply generator keeps failing, instead of the raw text.",
				"hint.approvalText": "Spoken when a tool call needs your approval on screen. The approval request itself is never read aloud.",
				"hint.personality": "Persona for the reply generator, used only for what the speaker reads out.",
				"hint.replyStyle": "Speaking style for the reply generator.",
				"hint.behaviorStyle": "Appended to the system prompt of speaker-started sessions only.",
				"hint.outputLimits": "Hard constraints sent with every reply-generator request.",
				"hint.voiceRuleText": "The bridge appends this to every voice utterance, which is how the model learns its reply is read out loud.",
				"hint.empty": "Saving an empty field resets it to its default.",
				"invalid.port": "The port must be an integer between 1 and 65535.",
				"invalid.seconds": "Must be a whole number within the allowed range.",
				"invalid.range": "Out of range; enter a whole number inside the allowed range.",
				"invalid.rangeFloat": "Out of range; enter a decimal between 0.5 and 2.0.",
				"invalid.number": "Must be a whole number.",
				"invalid.identifier": "Must be an identifier starting with a letter or underscore.",
				"invalid.required": "This field cannot be empty.",
				"form.unavailable": "Settings are unavailable: this plugin's settings card is not registered or not active.",
				"form.readOnly": "Read-only right now.",
				"form.save": "Save",
				"form.saving": "Saving…",
				"form.saveFailed": "Saving failed. Please try again.",
				"form.overridden": "Overridden",
				"form.reset": "Reset to default",
				"form.resetStaged": "Reset staged",
				"form.undo": "Undo",
				"state.loading": "Loading settings…",
				"state.loadFailed": "Could not load settings: ",
				"state.saved": "Saved.",
				"state.renderFailed": "The settings did not reach the bridge config: rewriting config.py failed, so the bridge still runs the old config. Press save again to retry.",
				"state.conflict": "Settings changed elsewhere; they were reloaded. Review and save again.",
				"status.loading": "Loading plugin status…",
				"status.failed": "Could not read plugin status: ",
				"status.refresh": "Refresh",
				"status.running": "Running",
				"status.stopped": "Stopped",
				"status.adopted": "Adopted a leftover process",
				"status.pid": "PID",
				"status.process": "Bridge process",
				"status.checks": "Environment checks",
				"status.ready": "Ready",
				"status.notReady": "Not ready",
				"status.check.bridgeDirIsDirectory": "Bridge directory",
				"status.check.pythonExists": "Python interpreter",
				"status.check.modelsDirExists": "Model directory",
				"status.check.skillFileExists": "Skill file",
				"status.paths": "Resolved paths",
				"status.path.bridgeDir": "Bridge sources",
				"status.path.pythonPath": "Python",
				"status.path.modelsDir": "Models",
				"status.spokenLog": "Spoken log",
				"status.spokenLogPath": "Log file",
				"status.api": "Bridge API",
				"status.api.connected": "Connected",
				"status.api.unreachable": "Not reachable",
				"status.api.unauthorized": "Token rejected",
				"status.api.disabled": "Turned off",
				"status.apiUrl": "API URL",
				"status.apiAuth": "Authentication",
				"status.auth.bearer": "Token required",
				"status.auth.loopback-only": "Loopback only",
				"status.token": "API token",
				"status.tokenConfigured": "Configured",
				"status.tokenMissing": "Not configured (loopback stays open)",
				"status.doubaoKey": "Doubao access token",
				"status.doubaoKeyConfigured": "Configured",
				"status.doubaoKeyMissing": "Not configured",
				"status.watchdog": "Watchdog restarts",
				"status.watchdogGaveUp": "Gave up restarting",
				"status.nextRestart": "Next restart",
				"status.lastError": "Last error",
				"status.noErrors": "Nothing has gone wrong yet",
				"status.diagnostics": "Recent errors",
				"status.errorCount": "Repeats",
				"status.preset": "Speaker preset",
				"status.preset.hostDefault": "host default",
				"status.preset.no-registry": "this DSH has no preset registry",
				"status.preset.missing": "not installed",
				"status.preset.broken": "cannot be activated",
				"diagnostic.bridge-unreachable": "The bridge did not answer",
				"diagnostic.bridge-rejected": "The bridge rejected our token",
				"diagnostic.plugin-rejected": "A call arrived with the wrong token",
				"diagnostic.bridge-error": "The bridge returned an error",
				"diagnostic.bridge-timeout": "The request timed out",
				"diagnostic.start-failed": "The bridge could not be started",
				"diagnostic.watchdog-gave-up": "The watchdog stopped restarting",
				"diagnostic.port-held": "A port is still held after stopping",
				"diagnostic.token-not-applied": "The bridge started before the token existed; restart it to apply the token",
				"diagnostic.scope-registration-unavailable": "This DSH build cannot register a tool for one session, so xiaoai_speak was not registered",
				"diagnostic.scope-registration-failed": "Registering xiaoai_speak in a session scope failed",
				"diagnostic.agent-preset-missing": "The configured Agent preset is not installed; this session fell back to the host default",
				"diagnostic.agent-preset-broken": "The configured Agent preset cannot be activated (bad declaration); this session fell back to the host default",
				"diagnostic.agent-preset-mount-failed": "Binding the Agent preset to the speaker session failed; this session fell back to the host default",
				"diagnostic.session-archived-rebound": "The conversation the speaker was bound to is archived (an archived session runs no model step), so this utterance started a new one",
				"diagnostic.asr-model-unavailable": "The speech-to-text backend you picked cannot be used (its model is missing or failed to load), so the bridge kept running the previous one",
				"summary": "XiaoAI Speaker Bridge: wake words, the bridge process, and the voice loop",
			},
		};

		var translate = function (key) {
			var value = COPY.zh[key];
			return value === undefined ? key : value;
		};

		/** Bind the host dictionary once; fall back to the built-in copy. */
		function bindLocale(ctx) {
			try {
				var locale = ctx.locale;
				if (!locale || typeof locale.register !== "function") return translate;
				ctx.effect(function () {
					return locale.register(NS, COPY);
				}, "dsh-xiaoai-bridge: locale dictionaries");
				if (typeof locale.bind !== "function") return translate;
				var bound = locale.bind(NS);
				if (typeof bound !== "function") return translate;
				translate = function (key) {
					try {
						var out = bound(key);
						if (typeof out === "string" && out.length > 0) return out;
					} catch (err) {
						// Fall through to the built-in copy.
					}
					var value = COPY.zh[key];
					return value === undefined ? key : value;
				};
			} catch (err) {
				// A host without the locale service keeps the built-in copy.
			}
			return translate;
		}

		/**
		 * One configurable field. `kind` picks the control and how a draft turns
		 * back into a document value; `section` places it, and the order of the
		 * array is the page order inside that section.
		 *
		 * Two optional keys shape the page without touching the document:
		 * `show` gates the field on another field's current value (the gate
		 * object is `{key, in}` / `{key, notIn}` for a choice, `{key}` for a
		 * switch), and `advanced` moves a field into the section's 高级 fold.
		 */
		var FIELDS = [
			{ key: "enabled", section: "basic", kind: "boolean" },
			{ key: "deviceName", section: "basic", kind: "text", hint: "hint.deviceName" },
			{ key: "deviceHost", section: "basic", kind: "text", hint: "hint.deviceHost" },
			{ key: "sessionKey", section: "basic", kind: "text", hint: "hint.sessionKey" },
			{ key: "sessionCwd", section: "basic", kind: "workspace", hint: "hint.sessionCwd" },
			{ key: "agentPreset", section: "basic", kind: "text", hint: "hint.agentPreset" },
			{ key: "wakeKeywords", section: "voice", kind: "textarea", hint: "hint.wakeKeywords" },
			{ key: "wakeupTimeout", section: "voice", kind: "number", min: 1, max: 600, invalidReason: "invalid.seconds", hint: "hint.wakeupTimeout" },
			{ key: "continuousConversation", section: "voice", kind: "boolean", hint: "hint.continuousConversation" },
			{ key: "asrBackend", section: "voice", kind: "enum", options: ["sense_voice", "paraformer", "fire_red_asr"] },
			{ key: "ttsProvider", section: "voice", kind: "enum", options: ["", "xiaoai", "doubao"], optionLabels: { "": "option.ttsProvider.auto", xiaoai: "option.ttsProvider.xiaoai", doubao: "option.ttsProvider.doubao" }, hint: "hint.ttsProvider" },
			{ key: "ttsSpeaker", section: "voice", kind: "text", hint: "hint.ttsSpeaker" },
			{ key: "doubaoAppId", section: "doubao", kind: "text", hint: "hint.doubaoAppId" },
			{ key: "doubaoAccessKeyCredential", section: "doubao", kind: "text", identifier: true, hint: "hint.doubaoAccessKeyCredential" },
			{ key: "doubaoSpeaker", section: "doubao", kind: "text", hint: "hint.doubaoSpeaker" },
			{ key: "doubaoAudioFormat", section: "doubao", kind: "enum", options: ["", "auto", "pcm", "mp3", "ogg_opus"], optionLabels: { "": "option.doubaoAudioFormat.inherit", auto: "option.doubaoAudioFormat.auto", pcm: "option.doubaoAudioFormat.pcm", mp3: "option.doubaoAudioFormat.mp3", ogg_opus: "option.doubaoAudioFormat.ogg_opus" }, hint: "hint.doubaoAudioFormat" },
			{ key: "doubaoStream", section: "doubao", kind: "boolean", hint: "hint.doubaoStream" },
			{ key: "ttsSpeed", section: "doubao", kind: "number", min: 0.5, max: 2, invalidReason: "invalid.rangeFloat", hint: "hint.ttsSpeed" },
			{ key: "wakeupReplyText", section: "reply", kind: "text", hint: "hint.replyText" },
			{ key: "exitReplyText", section: "reply", kind: "text", hint: "hint.replyText" },
			{ key: "exitKeywords", section: "reply", kind: "textarea", hint: "hint.exitKeywords", show: { key: "continuousConversation" } },
			{ key: "fallbackText", section: "reply", kind: "text", hint: "hint.fallbackText" },
			{ key: "autoSpeak", section: "speak", kind: "boolean" },
			{ key: "speakFromAnySession", section: "speak", kind: "boolean", hint: "hint.speakFromAnySession" },
			{ key: "spokenMaxChars", section: "speak", kind: "number", min: 40, max: 2000, invalidReason: "invalid.range", hint: "hint.spokenMaxChars" },
			{ key: "approvalText", section: "speak", kind: "text", hint: "hint.approvalText" },
			{ key: "replyerProvider", section: "speak", kind: "text", hint: "hint.replyerModel", show: { key: "autoSpeak" } },
			{ key: "replyerModel", section: "speak", kind: "text", hint: "hint.replyerModel", show: { key: "autoSpeak" } },
			{ key: "replyerHistoryTurns", section: "speak", kind: "number", min: 0, max: 50, invalidReason: "invalid.range", hint: "hint.replyerHistoryTurns", show: { key: "autoSpeak" } },
			{ key: "replyerFailureText", section: "speak", kind: "text", hint: "hint.replyerFailureText", show: { key: "autoSpeak" } },
			{ key: "personality", section: "persona", kind: "textarea", hint: "hint.personality" },
			{ key: "replyStyle", section: "persona", kind: "textarea", hint: "hint.replyStyle" },
			{ key: "behaviorStyle", section: "persona", kind: "textarea", hint: "hint.behaviorStyle" },
			{ key: "outputLimits", section: "persona", kind: "textarea", hint: "hint.outputLimits" },
			{ key: "voiceRuleText", section: "persona", kind: "textarea", hint: "hint.voiceRuleText" },
			{ key: "autoStart", section: "process", kind: "boolean" },
			{ key: "silentStart", section: "process", kind: "boolean", hint: "hint.silentStart", show: { key: "autoStart" } },
			{ key: "logLevel", section: "process", kind: "enum", options: ["DEBUG", "INFO", "WARNING", "ERROR"] },
			{ key: "bridgeDir", section: "process", kind: "text", hint: "hint.bridgeDir", advanced: true },
			{ key: "pythonPath", section: "process", kind: "text", hint: "hint.pythonPath", advanced: true },
			{ key: "apiServerEnabled", section: "api", kind: "boolean" },
			{ key: "apiServerHost", section: "api", kind: "text", required: true, show: { key: "apiServerEnabled" } },
			{ key: "apiServerPort", section: "api", kind: "number", port: true, show: { key: "apiServerEnabled" } },
			{ key: "apiServerTokenCredential", section: "api", kind: "text", identifier: true, hint: "hint.apiServerTokenCredential", show: { key: "apiServerEnabled" } },
		];

		var SECTIONS = [
			{ id: "basic", title: "section.basic" },
			{ id: "voice", title: "section.voice" },
			{ id: "doubao", title: "section.doubao" },
			{ id: "reply", title: "section.reply" },
			{ id: "speak", title: "section.speak" },
			{ id: "persona", title: "section.persona" },
			{ id: "process", title: "section.process" },
			{ id: "api", title: "section.api" },
		];

		/**
		 * Which folds start open. Only the 高级 fold starts closed: its fields
		 * are the ones a working install never has to touch.
		 */
		var FOLD_DEFAULTS = {
			basic: true,
			voice: true,
			doubao: true,
			reply: true,
			speak: true,
			persona: true,
			process: true,
			"process.advanced": false,
			api: true,
		};

		/**
		 * Values a gate falls back to before `/config` answers, mirroring the
		 * same keys in `lib/config.js` DEFAULTS. Without them a gate would read
		 * `undefined` on first paint and hide a field that is on by default.
		 */
		var GATE_DEFAULTS = {
			continuousConversation: false,
			autoSpeak: true,
			autoStart: true,
			apiServerEnabled: true,
		};

		var IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

		/** Format a stored value the way its control wants to display it. */
		function formatValue(spec, value) {
			if (spec.kind === "boolean") return value === true;
			if (value === undefined || value === null) return "";
			return String(value);
		}

		/**
		 * Turn one draft into a document value.
		 * @returns {{kind: 'set', value: unknown}|{kind: 'unset'}|{kind: 'invalid', reason: string}}
		 */
		function parseField(spec, raw) {
			if (spec.kind === "boolean") return { kind: "set", value: raw === true };
			var text = String(raw === undefined || raw === null ? "" : raw);
			if (spec.kind === "number") {
				var trimmed = text.trim();
				if (trimmed === "") return { kind: "unset" };
				var parsed = Number(trimmed);
				// Field-agnostic: this branch only knows the text is not a number,
				// so it cannot name the field's own range. A port keeps its range
				// wording through the out-of-range branch below.
				if (!Number.isFinite(parsed)) return { kind: "invalid", reason: "invalid.number" };
				if (spec.port === true && (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)) {
					return { kind: "invalid", reason: "invalid.port" };
				}
				var low = spec.min === undefined ? -Infinity : spec.min;
				var high = spec.max === undefined ? Infinity : spec.max;
				if (parsed < low || parsed > high) {
					return { kind: "invalid", reason: spec.invalidReason || "invalid.range" };
				}
				return { kind: "set", value: parsed };
			}
			var body = spec.kind === "textarea" ? text.replace(/\r\n/g, "\n") : text.trim();
			if (body === "") {
				// The host's own validator refuses an empty required field
				// (`config.js`), and the API Server host is one: catching it here
				// turns a rejected save into a pointed message on the field.
				if (spec.required === true) return { kind: "invalid", reason: "invalid.required" };
				return { kind: "unset" };
			}
			if (spec.identifier === true && !IDENTIFIER.test(body)) return { kind: "invalid", reason: "invalid.identifier" };
			return { kind: "set", value: body };
		}

		/** Build the ordered `ops` a save would write, plus the invalid fields. */
		function buildOps(draft, resets, snapshot) {
			var saved = snapshot && snapshot.value && typeof snapshot.value === "object" ? snapshot.value : {};
			var ops = [];
			var invalid = [];
			for (var i = 0; i < FIELDS.length; i += 1) {
				var spec = FIELDS[i];
				var key = spec.key;
				if (resets[key] === true) {
					ops.push({ op: "unset", path: [key] });
					continue;
				}
				var parsed = parseField(spec, draft[key]);
				if (parsed.kind === "invalid") {
					invalid.push(key);
					continue;
				}
				if (parsed.kind === "unset") {
					if (saved[key] !== undefined) ops.push({ op: "unset", path: [key] });
					continue;
				}
				if (saved[key] !== parsed.value) ops.push({ op: "set", path: [key], value: parsed.value });
			}
			return { ops: ops, invalid: invalid };
		}

		/**
		 * A labelled row for a control that has no built-in label of its own.
		 * It mirrors the frame `SettingsValueField` draws for itself — label,
		 * control, then hint or validation message — so a hand-built row and a
		 * primitive row read as the same kind of thing. `trailing` puts a
		 * control on the label line itself, which is where a switch belongs.
		 */
		function FieldShell(props) {
			return jsxs("div", {
				className: "xiaoai_field",
				children: [
					jsxs("div", {
						key: "head",
						className: "xiaoai_head",
						children: [
							jsx("span", { key: "label", className: "xiaoai_label", children: props.label }),
							props.staged
								? jsxs("span", {
									key: "badges",
									className: "xiaoai_badges",
									children: [
										jsx(Tag, { key: "tag", tone: "neutral", children: props.stagedLabel }),
										jsx("button", {
											key: "undo",
											type: "button",
											className: "xiaoai_reset",
											onClick: props.onUndo,
											children: props.undoLabel,
										}),
									],
								})
								: props.overridden
									? jsxs("span", {
										key: "badges",
										className: "xiaoai_badges",
										children: [
											jsx(Tag, { key: "tag", tone: "neutral", children: props.overriddenLabel }),
											jsx("button", {
												key: "reset",
												type: "button",
												className: "xiaoai_reset",
												disabled: props.disabled,
												onClick: props.onReset,
												children: props.resetLabel,
											}),
										],
									})
									: null,
							props.trailing || null,
						],
					}),
					props.children,
					props.invalid
						? jsx("p", { key: "invalid", className: "xiaoai_invalid", children: props.invalidLabel })
						: props.hint
							? jsx("p", { key: "hint", className: "xiaoai_hint", children: props.hint })
							: null,
				],
			});
		}

		/**
		 * Format an ISO timestamp for the status card in the reader's own zone.
		 * @param {string} value ISO 8601 timestamp
		 * @returns {string} local time, or the raw value when it cannot be parsed
		 */
		function localTime(value) {
			var raw = String(value === undefined || value === null ? "" : value);
			if (raw.length === 0) return "—";
			var when = new Date(raw);
			return isNaN(when.getTime()) ? raw : when.toLocaleString();
		}

		/**
		 * Render a byte count for the spoken-log row. The cap it is compared
		 * against (5 MiB) is a binary one, so the unit is too.
		 * @param {number} value byte count reported by the plugin
		 * @returns {string} one decimal place, or an em dash when unknown
		 */
		function formatBytes(value) {
			if (typeof value !== "number" || !isFinite(value) || value < 0) return "—";
			if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KiB";
			return (value / (1024 * 1024)).toFixed(1) + " MiB";
		}

		function Row(props) {
			return jsxs("div", {
				className: "xiaoai_row",
				children: [
					jsx("span", { key: "label", className: "xiaoai_rowLabel", children: props.label }),
					jsx("span", {
						key: "value",
						className: props.mono ? "xiaoai_rowValue xiaoai_mono" : "xiaoai_rowValue",
						children: props.value,
					}),
				],
			});
		}

		/**
		 * One collapsible block. The owner holds `open`, so a section keeps its
		 * state across reloads and a save that re-renders the page. The
		 * disclosure primitive unmounts collapsed children, which is why every
		 * gated field above hides with `xiaoai_hidden` instead of being dropped:
		 * the draft lives in state and must come back untouched.
		 *
		 * `dense` is the nested 高级 fold: same disclosure, one step down in the
		 * type scale, so a fold inside a section does not read as a sibling
		 * section. The chevron is passed as the leading icon so it is always
		 * visible: the primitive's default shows one only on hover, which leaves
		 * a collapsed section looking like plain text.
		 */
		function Fold(props) {
			return jsx(DisclosureRow, {
				icon: jsx(IconChevronDownOutlineRegular, {}),
				title: props.title,
				open: props.open,
				expandable: true,
				expandOnRowClick: true,
				previewChevron: false,
				onToggle: props.onToggle,
				rowClassName: "xiaoai_sectionRow",
				titleClassName: props.dense === true ? "xiaoai_subTitle" : "xiaoai_sectionTitle",
				children: jsx("div", {
					className: props.dense === true ? "xiaoai_fields xiaoai_fieldsNested" : "xiaoai_fields",
					children: props.children,
				}),
			});
		}

		function XiaoaiBundleConfig(props) {
			// The owner renders `{ view: 'page' }` for this slot; anything else is
			// treated as the page so a missing prop can never blank the section.
			var isSummary = Boolean(props) && props.view === "summary";

			var configState = useState({ status: "loading", snapshot: null, error: null });
			var snapshotState = configState[0];
			var setConfigState = configState[1];
			var draftState = useState({});
			var draft = draftState[0];
			var setDraft = draftState[1];
			var resetState = useState({});
			var resets = resetState[0];
			var setResets = resetState[1];
			var saveState = useState({ saving: false, failed: false, notice: "", invalid: [] });
			var save = saveState[0];
			var setSave = saveState[1];
			var healthState = useState({ status: "loading", data: null, error: null });
			var health = healthState[0];
			var setHealth = healthState[1];
			// Which folds are open. Folding is presentation only: it never
			// touches the draft, so a collapsed section keeps its edits.
			var foldState = useState(function () { return Object.assign({}, FOLD_DEFAULTS); });
			var foldOpen = foldState[0];
			var setFoldOpen = foldState[1];

			function toggleFold(id) {
				setFoldOpen(function (prev) {
					var next = {};
					for (var name in prev) {
						if (Object.prototype.hasOwnProperty.call(prev, name)) next[name] = prev[name];
					}
					next[id] = !prev[id];
					return next;
				});
			}

			var snapshot = snapshotState.snapshot;

			var applySnapshot = useCallback(function (next) {
				var value = next && next.value && typeof next.value === "object" ? next.value : {};
				var seeded = {};
				for (var i = 0; i < FIELDS.length; i += 1) {
					var spec = FIELDS[i];
					seeded[spec.key] = formatValue(spec, value[spec.key]);
				}
				setDraft(seeded);
				setResets({});
			}, []);

			var loadConfig = useCallback(function () {
				setConfigState(function (prev) {
					return { status: prev.snapshot ? prev.status : "loading", snapshot: prev.snapshot, error: null };
				});
				return fetch(CONFIG_URL, { headers: { accept: "application/json" } })
					.then(function (res) {
						return res.json().then(function (body) { return { ok: res.ok, body: body }; });
					})
					.then(function (out) {
						if (!out.ok || !out.body || out.body.ok !== true) {
							var message = out.body && out.body.error ? out.body.error : "HTTP " + String(out.ok);
							setConfigState({ status: "error", snapshot: null, error: message });
							return;
						}
						applySnapshot(out.body.descriptor);
						setConfigState({ status: "ready", snapshot: out.body.descriptor, error: null });
					})
					.catch(function (err) {
						setConfigState({ status: "error", snapshot: null, error: String(err && err.message ? err.message : err) });
					});
			}, [applySnapshot]);

			var loadHealth = useCallback(function () {
				setHealth(function (prev) {
					return { status: prev.data ? prev.status : "loading", data: prev.data, error: null };
				});
				return fetch(HEALTH_URL, { headers: { accept: "application/json" } })
					.then(function (res) {
						return res.json().then(function (body) { return { ok: res.ok, body: body }; });
					})
					.then(function (out) {
						if (!out.ok || !out.body || out.body.ok !== true) {
							var message = out.body && out.body.error ? out.body.error : "HTTP " + String(out.ok);
							setHealth({ status: "error", data: null, error: message });
							return;
						}
						setHealth({ status: "ready", data: out.body, error: null });
					})
					.catch(function (err) {
						setHealth({ status: "error", data: null, error: String(err && err.message ? err.message : err) });
					});
			}, []);

			useEffect(function () {
				if (isSummary) return;
				loadConfig();
				loadHealth();
			}, [loadConfig, loadHealth, isSummary]);

			if (isSummary) {
				return jsx("span", { className: "xiaoai_summary", children: translate("summary") });
			}

			var computed = buildOps(draft, resets, snapshot);
			var invalid = computed.invalid;
			var dirty = computed.ops.length > 0;

			function edit(key, raw) {
				setDraft(function (prev) {
					var next = Object.assign({}, prev);
					next[key] = raw;
					return next;
				});
				// Typing into a field that was staged for reset is a fresh intent:
				// drop the staged flag so the save writes this value instead of
				// silently discarding it as a bare `unset`. Only the value the
				// staging itself put in the control keeps the reset alive.
				var spec = specOf(key);
				if (spec && resets[key] === true) {
					var base = snapshot && snapshot.base && typeof snapshot.base === "object" ? snapshot.base : {};
					var staged = parseField(spec, formatValue(spec, base[key]));
					var typed = parseField(spec, raw);
					if (staged.kind === "unset") {
						if (typed.kind !== "unset") clearReset(key);
					} else if (typed.kind !== "set" || typed.value !== staged.value) {
						clearReset(key);
					}
				}
			}
			function clearReset(key) {
				setResets(function (prev) {
					if (prev[key] !== true) return prev;
					var next = Object.assign({}, prev);
					delete next[key];
					return next;
				});
			}
			function specOf(key) {
				for (var i = 0; i < FIELDS.length; i += 1) {
					if (FIELDS[i].key === key) return FIELDS[i];
				}
				return null;
			}

			function stageReset(spec) {
				var base = snapshot && snapshot.base && typeof snapshot.base === "object" ? snapshot.base : {};
				setResets(function (prev) {
					var next = Object.assign({}, prev);
					next[spec.key] = true;
					return next;
				});
				setDraft(function (prev) {
					var next = Object.assign({}, prev);
					next[spec.key] = formatValue(spec, base[spec.key]);
					return next;
				});
			}

			function undoReset(key) {
				setResets(function (prev) {
					var next = Object.assign({}, prev);
					delete next[key];
					return next;
				});
				var saved = snapshot && snapshot.value && typeof snapshot.value === "object" ? snapshot.value : {};
				var spec = null;
				for (var i = 0; i < FIELDS.length; i += 1) {
					if (FIELDS[i].key === key) spec = FIELDS[i];
				}
				if (spec) edit(key, formatValue(spec, saved[key]));
			}

			function discard() {
				applySnapshot(snapshot);
				setSave({ saving: false, failed: false, notice: "", invalid: [] });
			}

			function commit() {
				var plan = buildOps(draft, resets, snapshot);
				if (plan.invalid.length > 0 || plan.ops.length === 0) {
					setSave({ saving: false, failed: false, notice: "", invalid: plan.invalid });
					return;
				}
				setSave({ saving: true, failed: false, notice: "", invalid: [] });
				var revision = snapshot && snapshot.revision;
				fetch(CONFIG_URL, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ ops: plan.ops, revision: revision }),
				})
					.then(function (res) {
						return res.json().catch(function () { return {}; }).then(function (body) {
							return { ok: res.ok, status: res.status, body: body };
						});
					})
					.then(function (out) {
						if (out.ok && out.body && out.body.ok === true) {
							if (out.body.config && out.body.config.ok === false) {
								// The host stored the settings but could not render
								// the bridge config file, so the bridge keeps
								// running the old one. Do not claim success and do
								// not reload: keeping the draft (and therefore the
								// dirty flag) lets the same ops be saved again.
								setSave({ saving: false, failed: false, notice: "state.renderFailed", invalid: [] });
								return;
							}
							setResets({});
							setSave({ saving: false, failed: false, notice: "state.saved", invalid: [] });
							loadConfig();
							loadHealth();
							return;
						}
						if (out.status === 409) {
							setSave({ saving: false, failed: false, notice: "state.conflict", invalid: [] });
							loadConfig();
							return;
						}
						setSave({ saving: false, failed: true, notice: "", invalid: [] });
					})
					.catch(function () {
						setSave({ saving: false, failed: true, notice: "", invalid: [] });
					});
			}

			var formState = {
				available: snapshot !== null,
				writable: true,
				dirty: dirty,
				invalid: invalid.length > 0,
				saving: save.saving,
				failed: save.failed,
			};
			var formLabels = {
				unavailable: translate("form.unavailable"),
				readOnly: translate("form.readOnly"),
				save: translate("form.save"),
				saving: translate("form.saving"),
				saveFailed: translate("form.saveFailed"),
			};

			/*
			 * The project groups the host reports through `/health`.
			 *
			 * They are offered as choices because the host groups a session only
			 * when its cwd is exactly a workspace path — a hand-typed path is a
			 * path that silently leaves the speaker in 未分组, with no later way
			 * to move it in. The list is empty on a host that has no workspaces
			 * (or has not answered `/health` yet); the field then offers only
			 * "not set", which falls back to the plugin's own default.
			 */
			var healthFacts = health.data && health.data.health ? health.data.health : null;
			var workspaceRows = healthFacts && Array.isArray(healthFacts.workspaces) ? healthFacts.workspaces : [];
			function workspaceOptions(current) {
				var options = [{ value: "", label: translate("field.sessionCwd.follow") }];
				for (var w = 0; w < workspaceRows.length; w += 1) {
					var row = workspaceRows[w] || {};
					var path = String(row.path === undefined || row.path === null ? "" : row.path).trim();
					if (path.length === 0) continue;
					var title = String(row.title === undefined || row.title === null ? "" : row.title).trim();
					options.push({ value: path, label: title.length > 0 ? title + " — " + path : path });
				}
				var stale = current.length > 0;
				for (var u = 0; stale && u < options.length; u += 1) {
					if (options[u].value === current) stale = false;
				}
				// A value saved before this picker existed (or one whose group was
				// deleted since) stays visible instead of silently disappearing on
				// the next save.
				if (stale) options.push({ value: current, label: translate("field.sessionCwd.stale") + current });
				return options;
			}

			/**
			 * Whether a gated field belongs on the page right now. The gate reads
			 * the value its own control would show — a staged draft first, then
			 * the stored snapshot, then the default — so a field is not hidden
			 * only because `/config` has not answered yet.
			 * @param {{key: string, in?: string[], notIn?: string[]}} gate
			 * @returns whether the gated field is shown
			 */
			function gateOpen(gate) {
				var value = draft[gate.key];
				if (value === undefined) {
					var saved = snapshot && snapshot.value ? snapshot.value[gate.key] : undefined;
					value = saved === undefined ? GATE_DEFAULTS[gate.key] : saved;
				}
				if (Array.isArray(gate.in)) return gate.in.indexOf(String(value)) >= 0;
				if (Array.isArray(gate.notIn)) return gate.notIn.indexOf(String(value)) < 0;
				return value === true || value === "true";
			}

			var fields = [];
			for (var s = 0; s < SECTIONS.length; s += 1) {
				var section = SECTIONS[s];
				// The inner loop pushes exactly one control per matching FIELDS
				// entry, in order, so the partition below can pair them back by
				// position instead of rebuilding each control.
				var specs = FIELDS.filter(function (item) { return item.section === section.id; });
				var controls = [];
				for (var f = 0; f < FIELDS.length; f += 1) {
					var spec = FIELDS[f];
					if (spec.section !== section.id) continue;

					var key = spec.key;
					var id = "xiaoai-" + key;
					var staged = resets[key] === true;
					var overridden = !staged && Boolean(snapshot && snapshot.user && snapshot.user[key] !== undefined);
					var fieldInvalid = invalid.indexOf(key) >= 0;
					var parsedNow = parseField(spec, draft[key]);
					var invalidLabel = parsedNow.kind === "invalid" ? translate(parsedNow.reason) : "";
					var hint = spec.hint ? translate(spec.hint) : "";
					if (!hint && (spec.kind === "text" || spec.kind === "textarea" || spec.kind === "number")) {
						hint = translate("hint.empty");
					}
					var shell = {
						key: key,
						label: translate("field." + key),
						overridden: overridden,
						overriddenLabel: translate("form.overridden"),
						resetLabel: translate("form.reset"),
						onReset: function (chosen) { return function () { stageReset(chosen); }; }(spec),
						staged: staged,
						stagedLabel: translate("form.resetStaged"),
						undoLabel: translate("form.undo"),
						onUndo: function (chosen) { return function () { undoReset(chosen); }; }(key),
						disabled: false,
						invalid: fieldInvalid,
						invalidLabel: invalidLabel,
						hint: hint,
					};

					if (spec.kind === "boolean") {
						// The switch sits on the label line: a boolean row reads as
						// "this thing, on or off", and its hint stays underneath.
						controls.push(jsx(FieldShell, Object.assign({}, shell, {
							trailing: jsx(Switch, {
								checked: draft[key] === true,
								onChange: function (chosen) { return function (next) { edit(chosen, next === true); }; }(key),
								label: translate("field." + key),
							}),
						}), key));
						continue;
					}

					if (spec.kind === "workspace") {
						// A draft entry that is not there yet means "no value"; it must
						// never turn into the string "undefined" and be offered back as
						// a saved group.
						var wsCurrent = draft[key] === undefined || draft[key] === null ? "" : String(draft[key]);
						var wsChoices = workspaceOptions(wsCurrent);
						var wsNodes = [];
						for (var n = 0; n < wsChoices.length; n += 1) {
							wsNodes.push(jsx("option", {
								key: wsChoices[n].value,
								value: wsChoices[n].value,
								children: wsChoices[n].label,
							}));
						}
						controls.push(jsx(FieldShell, Object.assign({}, shell, {
							children: jsxs("div", {
								className: "xiaoai_selectWrap",
								children: [
									jsx("select", {
										key: "select",
										id: id,
										className: "xiaoai_input xiaoai_select",
										value: wsCurrent,
										disabled: false,
										"aria-invalid": fieldInvalid ? true : undefined,
										onChange: function (chosen) { return function (event) { edit(chosen, event.target.value); }; }(key),
										children: wsNodes,
									}),
									// The native arrow cannot follow the theme, so it is
									// replaced by the host's own chevron glyph.
									jsx(IconChevronDownOutlineRegular, { key: "chevron", className: "xiaoai_selectChevron" }),
								],
							}),
						}), key));
						continue;
					}

					if (spec.kind === "enum") {
						var options = [];
						var optionLabels = spec.optionLabels || {};
						for (var o = 0; o < spec.options.length; o += 1) {
							var optionValue = spec.options[o];
							// Most enums show the raw value, which is the technical name
							// the bridge reads; optionLabels translates the ones where the
							// page wording matters (for example an empty "follow the
							// voice" choice).
							options.push({
								value: optionValue,
								label: optionLabels[optionValue] === undefined ? optionValue : translate(optionLabels[optionValue]),
							});
						}
						controls.push(jsx(FieldShell, Object.assign({}, shell, {
							children: jsx("div", {
								className: "xiaoai_control",
								children: jsx(SegmentedControl, {
									id: id,
									value: draft[key] === undefined || draft[key] === null ? "" : String(draft[key]),
									options: options,
									onChange: function (chosen) { return function (next) { edit(chosen, next); }; }(key),
									label: translate("field." + key),
								}),
							}),
						}), key));
						continue;
					}

					if (spec.kind === "textarea") {
						controls.push(jsx(FieldShell, Object.assign({}, shell, {
							children: jsx("textarea", {
								id: id,
								className: "xiaoai_input xiaoai_textarea",
								value: String(draft[key]),
								disabled: false,
								"aria-invalid": fieldInvalid ? true : undefined,
								onChange: function (chosen) { return function (event) { edit(chosen, event.target.value); }; }(key),
							}),
						}), key));
						continue;
					}

					// No FIELDS entry uses kind "secret": the API token lives in a
					// credential and is edited in the credentials UI. The secret
					// branch (and its SettingsSecretField binding) was deleted
					// rather than kept as unreachable code. If a secret-typed
					// field is ever added, note that an unseeded draft holds
					// undefined, which must count as "not configured" instead of
					// being stringified into a configured-looking value.

					controls.push(jsx(SettingsValueField, {
						key: key,
						id: id,
						label: shell.label,
						help: undefined,
						overridden: shell.overridden,
						overriddenLabel: shell.overriddenLabel,
						resetLabel: shell.resetLabel,
						onReset: shell.onReset,
						disabled: false,
						text: String(draft[key]),
						placeholder: "",
						numeric: spec.kind === "number",
						invalid: fieldInvalid,
						invalidLabel: invalidLabel,
						hint: hint,
						onEdit: function (chosen) { return function (next) { edit(chosen, next); }; }(key),
					}));
				}
				var visibleControls = [];
				var advancedControls = [];
				for (var c = 0; c < controls.length; c += 1) {
					var itemSpec = specs[c];
					var gated = itemSpec.show !== undefined && !gateOpen(itemSpec.show);
					// One wrapper per field keeps the separator chain intact: a
					// gated field stays mounted (its draft and its validation
					// message must survive the toggle that hid it), and the field
					// after it still draws its hairline against the wrapper before
					// it rather than against nothing.
					var wrapped = jsx("div", {
						key: itemSpec.key,
						className: gated ? "xiaoai_fieldWrap xiaoai_hidden" : "xiaoai_fieldWrap",
						children: controls[c],
					});
					if (itemSpec.advanced === true) advancedControls.push(wrapped);
					else visibleControls.push(wrapped);
				}
				if (advancedControls.length > 0) {
					visibleControls.push(jsx("div", {
						key: section.id + "-advanced",
						className: "xiaoai_fieldWrap",
						children: jsx(Fold, {
							dense: true,
							title: translate("section.advanced"),
							open: foldOpen[section.id + ".advanced"] === true,
							onToggle: function (chosen) { return function () { toggleFold(chosen); }; }(section.id + ".advanced"),
							children: advancedControls,
						}),
					}));
				}
				fields.push(jsx("div", {
					key: section.id,
					className: "xiaoai_section",
					children: jsx(Fold, {
						title: translate(section.title),
						open: foldOpen[section.id] === true,
						onToggle: function (chosen) { return function () { toggleFold(chosen); }; }(section.id),
						children: visibleControls,
					}),
				}));
			}

			var facts = health.data && health.data.health ? health.data.health : null;
			var bridge = facts && facts.bridge ? facts.bridge : null;
			var checks = facts && facts.checks ? facts.checks : null;
			var paths = facts && facts.paths ? facts.paths : null;

			var bridgeApi = facts && facts.bridgeApi ? facts.bridgeApi : null;
			var diagnostics = facts && Array.isArray(facts.diagnostics) ? facts.diagnostics : [];

			var statusRows = [];
			// The environment checks sit in their own card: they answer "is this
			// install complete", not "is the bridge running", and the rows below
			// are the live process state.
			var checkRows = [];
			if (bridge) {
				statusRows.push(jsx(Row, {
					key: "bridge",
					label: translate("status.process"),
					value: bridge.running
						? translate("status.running") + (bridge.adopted ? " · " + translate("status.adopted") : "")
						: translate("status.stopped"),
				}));
				statusRows.push(jsx(Row, {
					key: "pid",
					label: translate("status.pid"),
					value: bridge.pid === null || bridge.pid === undefined ? "—" : String(bridge.pid),
					mono: true,
				}));
				if (bridge.restarts || bridge.watchdogGaveUp || bridge.nextRestartAt) {
					statusRows.push(jsx(Row, {
						key: "watchdog",
						label: translate("status.watchdog"),
						value: String(bridge.restarts === undefined || bridge.restarts === null ? 0 : bridge.restarts),
					}));
					if (bridge.watchdogGaveUp) {
						statusRows.push(jsx(Row, {
							key: "watchdogGaveUp",
							label: translate("status.watchdogGaveUp"),
							value: bridge.lastError ? String(bridge.lastError) : "—",
						}));
					}
					if (bridge.nextRestartAt) {
						statusRows.push(jsx(Row, {
							key: "nextRestart",
							label: translate("status.nextRestart"),
							value: localTime(bridge.nextRestartAt),
							mono: true,
						}));
					}
				}
			}
			if (bridgeApi) {
				statusRows.push(jsx(Row, {
					key: "api",
					label: translate("status.api"),
					value: translate("status.api." + String(bridgeApi.state || "unreachable")),
				}));
				statusRows.push(jsx(Row, {
					key: "apiUrl",
					label: translate("status.apiUrl"),
					value: bridgeApi.url ? String(bridgeApi.url) : "—",
					mono: true,
				}));
				statusRows.push(jsx(Row, {
					key: "apiAuth",
					label: translate("status.apiAuth"),
					value: bridgeApi.auth ? translate("status.auth." + String(bridgeApi.auth)) : "—",
				}));
			}
			if (facts) {
				statusRows.push(jsx(Row, {
					key: "token",
					label: translate("status.token"),
					value: facts.tokenConfigured ? translate("status.tokenConfigured") : translate("status.tokenMissing"),
				}));
				// Whether Doubao has an Access Token to read is the difference
				// between a spoken line and "credentials are not configured" in
				// the bridge log, and the value itself never leaves DSH.
				statusRows.push(jsx(Row, {
					key: "doubaoKey",
					label: translate("status.doubaoKey"),
					value: facts.doubaoKeyConfigured ? translate("status.doubaoKeyConfigured") : translate("status.doubaoKeyMissing"),
				}));
				// The configured preset and what it actually resolved to: the arrow
				// is the whole answer to "did my preset take effect", and a reason
				// only appears when it did not.
				var presetFacts = facts.preset && typeof facts.preset === "object" ? facts.preset : null;
				if (presetFacts && presetFacts.configured) {
					var presetReason = presetFacts.reason ? " · " + translate("status.preset." + String(presetFacts.reason)) : "";
					statusRows.push(jsx(Row, {
						key: "preset",
						label: translate("status.preset"),
						value: String(presetFacts.configured) + " → " + (presetFacts.resolved ? String(presetFacts.resolved) : translate("status.preset.hostDefault")) + presetReason,
						mono: true,
					}));
				}
			}
			if (checks) {
				var checkKeys = ["bridgeDirIsDirectory", "pythonExists", "modelsDirExists", "skillFileExists"];
				for (var c = 0; c < checkKeys.length; c += 1) {
					checkRows.push(jsx(Row, {
						key: "check-" + checkKeys[c],
						label: translate("status.check." + checkKeys[c]),
						value: checks[checkKeys[c]] ? translate("status.ready") : translate("status.notReady"),
					}));
				}
			}
			// The newest error is the one the user came here to read; a few older
			// ones stay listed so a fixed problem does not vanish unexplained.
			var errorRows = [];
			if (facts) {
				if (diagnostics.length === 0) {
					errorRows.push(jsx(Row, {
						key: "none",
						label: translate("status.lastError"),
						value: translate("status.noErrors"),
					}));
				} else {
					var shown = diagnostics.slice(0, 3);
					for (var d = 0; d < shown.length; d += 1) {
						var entry = shown[d] || {};
						// The code is the actionable half of the line: a repeat
						// counter alone leaves the user to decode "bridge-rejected".
						// An unknown code must not surface as a bare "diagnostic.x".
						var code = String(entry.code === undefined || entry.code === null ? "" : entry.code);
						var reason = translate("diagnostic." + code);
						if (reason === "diagnostic." + code) reason = code;
						var times = entry.count > 1 ? " · " + translate("status.errorCount") + " " + String(entry.count) : "";
						errorRows.push(jsx(Row, {
							key: "error-" + String(d),
							label: (d === 0 ? translate("status.lastError") : translate("status.diagnostics")) + times,
							value: localTime(entry.time)
								+ (reason.length > 0 ? " · " + reason : "")
								+ (entry.detail ? " · " + String(entry.detail) : ""),
							mono: true,
						}));
					}
				}
			}
			var pathRows = [];
			if (paths) {
				var pathKeys = ["bridgeDir", "pythonPath", "modelsDir"];
				for (var p = 0; p < pathKeys.length; p += 1) {
					pathRows.push(jsx(Row, {
						key: "path-" + pathKeys[p],
						label: translate("status.path." + pathKeys[p]),
						value: String(paths[pathKeys[p]] === undefined ? "—" : paths[pathKeys[p]]),
						mono: true,
					}));
				}
			}

			var spokenRows = [];
			if (facts && facts.spokenLogPath) {
				spokenRows.push(jsx(Row, {
					key: "spokenSize",
					label: translate("status.spokenLog"),
					// The cap is enforced by rotation on the host, so what the card
					// answers is "how full is it", not "how big did it get".
					value: formatBytes(facts.spokenLogBytes) + " / " + formatBytes(SPOKEN_LOG_CAP_BYTES),
				}));
				spokenRows.push(jsx(Row, {
					key: "spokenPath",
					label: translate("status.spokenLogPath"),
					value: String(facts.spokenLogPath),
					mono: true,
				}));
			}

			var notices = [];
			if (save.notice) {
				// A save whose bridge-config render failed is not a failure of the
				// save itself, but it must not read as success either.
				var noticeTone = save.notice === "state.renderFailed" ? "xiaoai_noticeWarn" : "xiaoai_notice";
				notices.push(jsx("p", { key: "notice", className: noticeTone, children: translate(save.notice) }));
			}
			if (snapshotState.status === "loading") {
				notices.push(jsx("p", { key: "loading", className: "xiaoai_lead", children: translate("state.loading") }));
			}

			return jsxs("div", {
				className: "xiaoai_page",
				children: [
					jsxs("div", {
						key: "header",
						className: "xiaoai_pageHead",
						children: [
							jsx("h3", { key: "t", className: "xiaoai_title", children: translate("page.title") }),
							jsx(Button, {
								key: "refresh",
								size: "sm",
								icon: jsx(IconRefreshOutlineRegular, {}),
								onClick: function () { loadConfig(); loadHealth(); },
								children: translate("status.refresh"),
							}),
						],
					}),
					jsx("p", { key: "intro", className: "xiaoai_lead", children: translate("page.intro") }),
					snapshotState.error
						? jsx("p", {
							key: "loadError",
							className: "xiaoai_invalid",
							children: translate("state.loadFailed") + String(snapshotState.error),
						})
						: null,
					notices,
					jsx(SettingsForm, {
						key: "form",
						state: formState,
						labels: formLabels,
						onSave: commit,
						onDiscard: discard,
						children: fields,
					}),
					jsxs("div", {
						key: "status",
						className: "xiaoai_statusSection",
						children: [
							jsx("h4", { key: "title", className: "xiaoai_sectionTitle", children: translate("section.status") }),
							health.status === "loading"
								? jsx("p", { key: "loading", className: "xiaoai_lead", children: translate("status.loading") })
								: null,
							health.error
								? jsx("p", {
									key: "error",
									className: "xiaoai_invalid",
									children: translate("status.failed") + String(health.error),
								})
								: null,
							statusRows.length > 0
								? jsx("div", { key: "rows", className: "xiaoai_card", children: statusRows })
								: null,
							checkRows.length > 0
								? jsxs("div", {
									key: "checks",
									className: "xiaoai_card",
									children: [
										jsx("span", { key: "title", className: "xiaoai_cardTitle", children: translate("status.checks") }),
										checkRows,
									],
								})
								: null,
							errorRows.length > 0
								? jsxs("div", {
									key: "errors",
									className: "xiaoai_card",
									children: [
										jsx("span", { key: "title", className: "xiaoai_cardTitle", children: translate("status.diagnostics") }),
										errorRows,
									],
								})
								: null,
							pathRows.length > 0
								? jsxs("div", {
									key: "paths",
									className: "xiaoai_card",
									children: [
										jsx("span", { key: "title", className: "xiaoai_cardTitle", children: translate("status.paths") }),
										pathRows,
									],
								})
								: null,
							spokenRows.length > 0
								? jsx("div", { key: "spoken", className: "xiaoai_card", children: spokenRows })
								: null,
						],
					}),
				],
			});
		}

		var inject = ["slots", "locale"];

		function apply(ctx) {
			ensureStyles();
			bindLocale(ctx);
			ctx.slots.inject(BUNDLE_SLOT, function () {
				return ctx.slots.register({ name: BUNDLE_SLOT, key: BUNDLE_KEY }, XiaoaiBundleConfig);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
