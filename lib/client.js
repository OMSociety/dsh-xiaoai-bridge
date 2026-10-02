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
		var SettingsSecretField = primitives.SettingsSecretField;
		var Switch = primitives.Switch;
		var SegmentedControl = primitives.SegmentedControl;
		var Tag = primitives.Tag;

		var BUNDLE_SLOT = "plugins.bundle.config";
		var BUNDLE_KEY = "dsh-xiaoai-bridge";
		var CONFIG_URL = "/plugin/xiaoai/config";
		var HEALTH_URL = "/plugin/xiaoai/health";

		/** Dictionary namespace for this page's copy (not the settings namespace). */
		var NS = "plugin.xiaoai";

		var MUTED = "rgba(127, 127, 127, 0.95)";
		var BORDER = "1px solid rgba(127, 127, 127, 0.28)";

		var pageStyle = { display: "flex", flexDirection: "column", gap: "20px" };
		var sectionStyle = { display: "flex", flexDirection: "column", gap: "12px" };
		var sectionTitleStyle = { fontSize: "13px", fontWeight: 600, margin: 0 };
		var leadStyle = { fontSize: "12px", color: MUTED, margin: 0, lineHeight: 1.7 };
		var fieldStyle = { display: "flex", flexDirection: "column", gap: "6px" };
		var headStyle = { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px" };
		var labelStyle = { fontSize: "12px", fontWeight: 500 };
		var badgesStyle = { display: "flex", alignItems: "center", gap: "8px" };
		var resetStyle = {
			font: "inherit", fontSize: "12px", padding: 0, border: 0, background: "transparent",
			color: "inherit", textDecoration: "underline", cursor: "pointer", opacity: 0.85,
		};
		var controlStyle = { display: "flex", alignItems: "center", gap: "10px", minHeight: "28px" };
		var textareaStyle = {
			font: "inherit", fontSize: "12px", lineHeight: 1.6, width: "100%", boxSizing: "border-box",
			minHeight: "68px", padding: "7px 9px", borderRadius: "6px", border: BORDER,
			background: "transparent", color: "inherit", resize: "vertical",
		};
		var hintStyle = { fontSize: "11px", color: MUTED, margin: 0, lineHeight: 1.6 };
		var invalidStyle = { fontSize: "11px", color: "#d9534f", margin: 0, lineHeight: 1.6 };
		var statusCardStyle = {
			border: BORDER, borderRadius: "8px", padding: "10px 12px",
			display: "flex", flexDirection: "column", gap: "6px",
		};
		var rowStyle = { display: "flex", gap: "12px", alignItems: "baseline", fontSize: "12px", lineHeight: 1.7 };
		var rowLabelStyle = { flex: "0 0 150px", color: MUTED };
		var rowValueStyle = { flex: "1 1 auto", wordBreak: "break-all" };
		var monoStyle = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" };
		var refreshStyle = {
			font: "inherit", fontSize: "12px", padding: "4px 10px", borderRadius: "6px",
			border: BORDER, background: "transparent", color: "inherit", cursor: "pointer", alignSelf: "flex-start",
		};
		var noticeStyle = { fontSize: "12px", color: "#22a06b", margin: 0 };
		var headerStyle = { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px" };
		var summaryStyle = { fontSize: "12px", color: MUTED, lineHeight: 1.6 };

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
				"section.reply": "应答与兜底",
				"section.speak": "播报与回复器",
				"section.persona": "人格与提示词",
				"section.process": "桥接器进程",
				"section.api": "本地 API 服务",
				"section.status": "运行状态",
				"field.enabled": "启用插件",
				"field.deviceName": "音箱名称",
				"field.deviceHost": "音箱地址",
				"field.wakeKeywords": "唤醒词",
				"field.wakeupTimeout": "对话保持时长（秒）",
				"field.asrBackend": "语音识别后端",
				"field.ttsSpeaker": "朗读音箱插件",
				"field.sessionCwd": "会话工作区",
				"field.wakeupReplyText": "唤醒应答",
				"field.exitReplyText": "退出应答",
				"field.exitKeywords": "退出词",
				"field.fallbackText": "兜底播报文本",
				"field.sessionKey": "会话键",
				"field.autoSpeak": "自动念出回复",
				"field.spokenMaxChars": "播报字数上限",
				"field.replyerProvider": "回复器提供商",
				"field.replyerModel": "回复器模型",
				"field.replyerHistoryTurns": "回复器参考轮数",
				"field.replyerFailureText": "回复器失败提示语",
				"field.personality": "人格设定",
				"field.replyStyle": "说话风格",
				"field.behaviorStyle": "行动准则",
				"field.outputLimits": "输出限制",
				"field.voiceRuleText": "语音消息附加提示",
				"field.bridgeDir": "桥接器目录",
				"field.pythonPath": "Python 解释器",
				"field.autoStart": "随插件启动桥接器",
				"field.logLevel": "日志级别",
				"field.apiServerEnabled": "启用本地 API 服务",
				"field.apiServerHost": "监听地址",
				"field.apiServerPort": "监听端口",
				"field.apiServerTokenCredential": "访问令牌凭据名",
				"hint.deviceName": "显示在会话标题里。",
				"hint.deviceHost": "音箱的局域网地址；留空则由桥接器上报。",
				"hint.wakeKeywords": "每行一个唤醒词，命中即进入 DSH 连续对话。",
				"hint.sessionCwd": "必需，且必须是绝对路径。留空时使用 DSH 当前工作区。",
				"hint.bridgeDir": "留空则使用包内的 bridge/ 目录。",
				"hint.pythonPath": "留空则使用 bridge/.venv 下的解释器。",
				"hint.logLevel": "桥接器进程的日志级别。",
				"hint.apiServerTokenCredential": "存放访问令牌的凭据名；桥接器用它调用本插件。",
				"hint.wakeupTimeout": "一次唤醒后的连续对话保持多久，单位秒（1–600）。",
				"hint.ttsSpeaker": "由哪个音箱插件朗读回复；留空使用桥接器默认值。",
				"hint.replyText": "听到唤醒词或退出词时说出的应答。",
				"hint.exitKeywords": "每行一个，说出任意一个即提前结束对话。",
				"hint.fallbackText": "桥接器在运行、但本插件联系不上时说出的话。",
				"hint.sessionKey": "音箱对话对应的 DSH 会话键；留空使用桥接器内置默认值。",
				"hint.autoSpeak": "关闭后只有模型主动调用 xiaoai_speak 工具才会发声。",
				"hint.spokenMaxChars": "一条播报最多多少字（40–2000）；超出会先让回复器精简一次，仍超就截断。",
				"hint.replyerModel": "留空则跟随该会话的默认模型；两者都填时按填写的路由调用。",
				"hint.replyerHistoryTurns": "回复器能看到最近多少轮对话（0–50）。",
				"hint.replyerFailureText": "回复器连续失败时改念这句，避免念出未经润色的原文。",
				"hint.personality": "回复器的人格设定，例如「你是一只叫小爱的猫娘助手」。只影响音箱念出来的话。",
				"hint.replyStyle": "回复器的说话风格，例如「简短口语，爱用语气词」。",
				"hint.behaviorStyle": "追加到音箱会话的系统提示里，只影响由音箱发起的那一个会话。",
				"hint.outputLimits": "写进回复器请求的硬性约束，例如禁止 emoji、颜文字、markdown、括号动作。",
				"hint.voiceRuleText": "桥接器会把它追加在每条语音输入后面。改了它，模型就会知道自己的回复会被念出来。",
				"hint.empty": "留空后保存等于恢复默认。",
				"invalid.port": "端口必须是 1 到 65535 之间的整数。",
				"invalid.seconds": "必须是允许范围内的整数。",
				"invalid.range": "超出允许范围，请填范围内的整数。",
				"invalid.identifier": "必须是字母或下划线开头的标识符。",
				"invalid.required": "不能为空。",
				"invalid.absolute": "必须是绝对路径。",
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
				"summary": "小爱音箱桥接器：唤醒词、桥接器进程与语音闭环设置",
			},
			en: {
				"page.title": "XiaoAI Speaker Bridge",
				"page.intro": "Wake words, the bridge process, and the voice loop. Changes are written only when you save.",
				"section.basic": "Basics",
				"section.voice": "Wake word and speech",
				"section.reply": "Replies and fallback",
				"section.speak": "Speaking and reply generator",
				"section.persona": "Persona and prompts",
				"section.process": "Bridge process",
				"section.api": "Local API server",
				"section.status": "Runtime status",
				"field.enabled": "Enable plugin",
				"field.deviceName": "Speaker name",
				"field.deviceHost": "Speaker address",
				"field.wakeKeywords": "Wake words",
				"field.wakeupTimeout": "Conversation timeout (s)",
				"field.asrBackend": "Speech recognition backend",
				"field.ttsSpeaker": "Speaking plug-in",
				"field.sessionCwd": "Session working directory",
				"field.wakeupReplyText": "Wake reply",
				"field.exitReplyText": "Exit reply",
				"field.exitKeywords": "Exit words",
				"field.fallbackText": "Fallback announcement",
				"field.sessionKey": "Session key",
				"field.autoSpeak": "Speak replies automatically",
				"field.spokenMaxChars": "Spoken characters",
				"field.replyerProvider": "Reply generator provider",
				"field.replyerModel": "Reply generator model",
				"field.replyerHistoryTurns": "Reply generator context turns",
				"field.replyerFailureText": "Reply generator failure line",
				"field.personality": "Persona",
				"field.replyStyle": "Speaking style",
				"field.behaviorStyle": "Action guidelines",
				"field.outputLimits": "Output limits",
				"field.voiceRuleText": "Voice-message instruction",
				"field.bridgeDir": "Bridge directory",
				"field.pythonPath": "Python interpreter",
				"field.autoStart": "Start the bridge with the plugin",
				"field.logLevel": "Log level",
				"field.apiServerEnabled": "Enable the local API server",
				"field.apiServerHost": "Listen address",
				"field.apiServerPort": "Listen port",
				"field.apiServerTokenCredential": "Access-token credential name",
				"hint.deviceName": "Shown as the session title.",
				"hint.deviceHost": "The speaker's LAN address; leave empty to use what the bridge reports.",
				"hint.wakeKeywords": "One wake word per line; a match enters DSH continuous conversation.",
				"hint.wakeupTimeout": "How long one wake session stays open, in seconds (1–600).",
				"hint.ttsSpeaker": "Which speaker plugin reads the reply aloud; empty uses the bridge default.",
				"hint.replyText": "Spoken when the wake word or the exit word is heard.",
				"hint.exitKeywords": "One per line; saying one ends the conversation early.",
				"hint.fallbackText": "Spoken when the bridge is up but this plugin cannot be reached.",
				"hint.sessionKey": "Which DSH session the speaker talks to; the bridge's own default names one.",
				"hint.sessionCwd": "Required, and it must be an absolute path. Empty uses the current DSH workspace.",
				"hint.bridgeDir": "Empty uses the bridge/ directory inside this package.",
				"hint.pythonPath": "Empty uses the interpreter under bridge/.venv.",
				"hint.logLevel": "Log level of the bridge process.",
				"hint.apiServerTokenCredential": "Credential holding the access token the bridge calls this plugin with.",
				"hint.autoSpeak": "Turn this off and the speaker only talks when the model calls xiaoai_speak.",
				"hint.spokenMaxChars": "Longest reply to speak, in characters (40–2000). Longer text is condensed once, then cut.",
				"hint.replyerModel": "Empty follows the session's default model; fill both to route it elsewhere.",
				"hint.replyerHistoryTurns": "How many recent exchanges the reply generator sees (0–50).",
				"hint.replyerFailureText": "Spoken when the reply generator keeps failing, instead of the raw text.",
				"hint.personality": "Persona for the reply generator, e.g. \"you are a cat-girl assistant called XiaoAi\".",
				"hint.replyStyle": "Speaking style for the reply generator, e.g. \"short and casual, fond of particles\".",
				"hint.behaviorStyle": "Appended to the system prompt of speaker-started sessions only.",
				"hint.outputLimits": "Hard constraints sent with every reply-generator request, e.g. no emoji, kaomoji, markdown or stage directions.",
				"hint.voiceRuleText": "The bridge appends this to every voice utterance, which is how the model learns its reply is read out loud.",
				"hint.empty": "Saving an empty field resets it to its default.",
				"invalid.port": "The port must be an integer between 1 and 65535.",
				"invalid.seconds": "Must be a whole number within the allowed range.",
				"invalid.range": "Out of range; enter a whole number inside the allowed range.",
				"invalid.identifier": "Must be an identifier starting with a letter or underscore.",
				"invalid.required": "This field cannot be empty.",
				"invalid.absolute": "Must be an absolute path.",
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
		 * back into a document value; the order of the array is the page order.
		 */
		var FIELDS = [
			{ key: "enabled", section: "basic", kind: "boolean" },
			{ key: "deviceName", section: "basic", kind: "text", hint: "hint.deviceName" },
			{ key: "deviceHost", section: "basic", kind: "text", hint: "hint.deviceHost" },
			{ key: "wakeKeywords", section: "voice", kind: "textarea", hint: "hint.wakeKeywords" },
			{ key: "wakeupTimeout", section: "voice", kind: "number", min: 1, max: 600, invalidReason: "invalid.seconds", hint: "hint.wakeupTimeout" },
			{ key: "asrBackend", section: "voice", kind: "enum", options: ["sense_voice", "paraformer", "fire_red_asr"] },
			{ key: "ttsSpeaker", section: "voice", kind: "text", hint: "hint.ttsSpeaker" },
			{ key: "sessionCwd", section: "voice", kind: "text", hint: "hint.sessionCwd", absolute: true },
			{ key: "wakeupReplyText", section: "reply", kind: "text", hint: "hint.replyText" },
			{ key: "exitReplyText", section: "reply", kind: "text", hint: "hint.replyText" },
			{ key: "exitKeywords", section: "reply", kind: "textarea", hint: "hint.exitKeywords" },
			{ key: "fallbackText", section: "reply", kind: "text", hint: "hint.fallbackText" },
			{ key: "sessionKey", section: "reply", kind: "text", hint: "hint.sessionKey" },
			{ key: "autoSpeak", section: "speak", kind: "boolean" },
			{ key: "spokenMaxChars", section: "speak", kind: "number", min: 40, max: 2000, invalidReason: "invalid.range", hint: "hint.spokenMaxChars" },
			{ key: "replyerProvider", section: "speak", kind: "text", hint: "hint.replyerModel" },
			{ key: "replyerModel", section: "speak", kind: "text", hint: "hint.replyerModel" },
			{ key: "replyerHistoryTurns", section: "speak", kind: "number", min: 0, max: 50, invalidReason: "invalid.range", hint: "hint.replyerHistoryTurns" },
			{ key: "replyerFailureText", section: "speak", kind: "text", hint: "hint.replyerFailureText" },
			{ key: "personality", section: "persona", kind: "textarea", hint: "hint.personality" },
			{ key: "replyStyle", section: "persona", kind: "textarea", hint: "hint.replyStyle" },
			{ key: "behaviorStyle", section: "persona", kind: "textarea", hint: "hint.behaviorStyle" },
			{ key: "outputLimits", section: "persona", kind: "textarea", hint: "hint.outputLimits" },
			{ key: "voiceRuleText", section: "persona", kind: "textarea", hint: "hint.voiceRuleText" },
			{ key: "bridgeDir", section: "process", kind: "text", hint: "hint.bridgeDir" },
			{ key: "pythonPath", section: "process", kind: "text", hint: "hint.pythonPath" },
			{ key: "autoStart", section: "process", kind: "boolean" },
			{ key: "logLevel", section: "process", kind: "enum", options: ["DEBUG", "INFO", "WARNING", "ERROR"] },
			{ key: "apiServerEnabled", section: "api", kind: "boolean" },
			{ key: "apiServerHost", section: "api", kind: "text", required: true },
			{ key: "apiServerPort", section: "api", kind: "number", port: true },
			{ key: "apiServerTokenCredential", section: "api", kind: "text", identifier: true, hint: "hint.apiServerTokenCredential" },
		];

		var SECTIONS = [
			{ id: "basic", title: "section.basic" },
			{ id: "voice", title: "section.voice" },
			{ id: "reply", title: "section.reply" },
			{ id: "speak", title: "section.speak" },
			{ id: "persona", title: "section.persona" },
			{ id: "process", title: "section.process" },
			{ id: "api", title: "section.api" },
		];

		var IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
		var ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

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
				if (!Number.isFinite(parsed)) return { kind: "invalid", reason: "invalid.port" };
				if (spec.port === true && (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)) {
					return { kind: "invalid", reason: "invalid.port" };
				}
				var low = spec.min === undefined ? -Infinity : spec.min;
				var high = spec.max === undefined ? Infinity : spec.max;
				if (parsed < low || parsed > high) {
					return { kind: "invalid", reason: spec.invalidReason || "invalid.port" };
				}
				return { kind: "set", value: parsed };
			}
			var body = spec.kind === "textarea" ? text.replace(/\r\n/g, "\n") : text.trim();
			if (body === "") return { kind: "unset" };
			if (spec.identifier === true && !IDENTIFIER.test(body)) return { kind: "invalid", reason: "invalid.identifier" };
			if (spec.absolute === true && !ABSOLUTE.test(body)) return { kind: "invalid", reason: "invalid.absolute" };
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

		/** A labelled row for a control that has no built-in label of its own. */
		function FieldShell(props) {
			return jsxs("div", {
				style: fieldStyle,
				children: [
					jsxs("div", {
						key: "head",
						style: headStyle,
						children: [
							jsx("span", { key: "label", style: labelStyle, children: props.label }),
							props.staged
								? jsxs("span", {
									key: "badges",
									style: badgesStyle,
									children: [
										jsx(Tag, { key: "tag", tone: "neutral", children: props.stagedLabel }),
										jsx("button", {
											key: "undo",
											type: "button",
											style: resetStyle,
											onClick: props.onUndo,
											children: props.undoLabel,
										}),
									],
								})
								: props.overridden
									? jsxs("span", {
										key: "badges",
										style: badgesStyle,
										children: [
											jsx(Tag, { key: "tag", tone: "neutral", children: props.overriddenLabel }),
											jsx("button", {
												key: "reset",
												type: "button",
												style: resetStyle,
												disabled: props.disabled,
												onClick: props.onReset,
												children: props.resetLabel,
											}),
										],
									})
									: null,
						],
					}),
					props.children,
					props.invalid
						? jsx("p", { key: "invalid", style: invalidStyle, children: props.invalidLabel })
						: props.hint
							? jsx("p", { key: "hint", style: hintStyle, children: props.hint })
							: null,
				],
			});
		}

		function Row(props) {
			return jsxs("div", {
				style: rowStyle,
				children: [
					jsx("span", { key: "label", style: rowLabelStyle, children: props.label }),
					jsx("span", {
						key: "value",
						style: props.mono ? Object.assign({}, rowValueStyle, monoStyle) : rowValueStyle,
						children: props.value,
					}),
				],
			});
		}

		function Section(props) {
			return jsxs("div", {
				style: sectionStyle,
				children: [
					jsx("h3", { key: "title", style: sectionTitleStyle, children: props.title }),
					props.children,
				],
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
				return jsx("span", { style: summaryStyle, children: translate("summary") });
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

			var fields = [];
			for (var s = 0; s < SECTIONS.length; s += 1) {
				var section = SECTIONS[s];
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
						controls.push(jsx(FieldShell, Object.assign({}, shell, {
							children: jsx("div", {
								style: controlStyle,
								children: jsx(Switch, {
									checked: draft[key] === true,
									onChange: function (chosen) { return function (next) { edit(chosen, next === true); }; }(key),
									label: translate("field." + key),
								}),
							}),
						}), key));
						continue;
					}

					if (spec.kind === "enum") {
						var options = [];
						for (var o = 0; o < spec.options.length; o += 1) {
							options.push({ value: spec.options[o], label: spec.options[o] });
						}
						controls.push(jsx(FieldShell, Object.assign({}, shell, {
							children: jsx("div", {
								style: controlStyle,
								children: jsx(SegmentedControl, {
									id: id,
									value: String(draft[key]),
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
								style: textareaStyle,
								value: String(draft[key]),
								disabled: false,
								"aria-invalid": fieldInvalid ? true : undefined,
								onChange: function (chosen) { return function (event) { edit(chosen, event.target.value); }; }(key),
							}),
						}), key));
						continue;
					}

					if (spec.kind === "secret") {
						controls.push(jsx(SettingsSecretField, {
							key: key,
							id: id,
							label: shell.label,
							configured: String(draft[key]).length > 0,
							stateLabel: String(draft[key]).length > 0 ? translate("form.overridden") : translate("form.resetStaged"),
							text: String(draft[key]),
							disabled: false,
							onEdit: function (chosen) { return function (next) { edit(chosen, next); }; }(key),
							hint: hint,
						}));
						continue;
					}

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
				fields.push(jsxs("div", {
					key: section.id,
					style: sectionStyle,
					children: [
						jsx("h4", { key: "title", style: sectionTitleStyle, children: translate(section.title) }),
						controls,
					],
				}));
			}

			var facts = health.data && health.data.health ? health.data.health : null;
			var bridge = facts && facts.bridge ? facts.bridge : null;
			var checks = facts && facts.checks ? facts.checks : null;
			var paths = facts && facts.paths ? facts.paths : null;

			var statusRows = [];
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
			}
			if (checks) {
				var checkKeys = ["bridgeDirIsDirectory", "pythonExists", "modelsDirExists", "skillFileExists"];
				for (var c = 0; c < checkKeys.length; c += 1) {
					statusRows.push(jsx(Row, {
						key: "check-" + checkKeys[c],
						label: translate("status.check." + checkKeys[c]),
						value: checks[checkKeys[c]] ? translate("status.ready") : translate("status.notReady"),
					}));
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

			var notices = [];
			if (save.notice) {
				notices.push(jsx("p", { key: "notice", style: noticeStyle, children: translate(save.notice) }));
			}
			if (snapshotState.status === "loading") {
				notices.push(jsx("p", { key: "loading", style: leadStyle, children: translate("state.loading") }));
			}

			return jsxs("div", {
				style: pageStyle,
				children: [
					jsxs("div", {
						key: "header",
						style: headerStyle,
						children: [
							jsx("h3", { key: "t", style: sectionTitleStyle, children: translate("page.title") }),
							jsx("button", {
								key: "refresh",
								type: "button",
								style: refreshStyle,
								onClick: function () { loadConfig(); loadHealth(); },
								children: translate("status.refresh"),
							}),
						],
					}),
					jsx("p", { key: "intro", style: leadStyle, children: translate("page.intro") }),
					snapshotState.error
						? jsx("p", {
							key: "loadError",
							style: invalidStyle,
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
						style: sectionStyle,
						children: [
							jsx("h4", { key: "title", style: sectionTitleStyle, children: translate("section.status") }),
							health.status === "loading"
								? jsx("p", { key: "loading", style: leadStyle, children: translate("status.loading") })
								: null,
							health.error
								? jsx("p", {
									key: "error",
									style: invalidStyle,
									children: translate("status.failed") + String(health.error),
								})
								: null,
							statusRows.length > 0
								? jsx("div", { key: "rows", style: statusCardStyle, children: statusRows })
								: null,
							pathRows.length > 0
								? jsxs("div", {
									key: "paths",
									style: statusCardStyle,
									children: [
										jsx("span", { key: "title", style: labelStyle, children: translate("status.paths") }),
										pathRows,
									],
								})
								: null,
						],
					}),
				],
			});
		}

		var inject = ["slots", "locale"];

		function apply(ctx) {
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
