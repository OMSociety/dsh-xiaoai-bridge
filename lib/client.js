/**
 * dsh-xiaoai-bridge browser half (hand-authored bundle, committed as a build
 * artifact — the format is the one DSH's module loader consumes, so there is no
 * bundler in the build path).
 *
 * Registers the "小爱音箱" tab under Settings -> 内置插件 and renders bridge
 * status read from `/plugin/xiaoai/health`. The full settings form arrives with
 * phase 3; this tab exists first to prove the card mechanism end to end.
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

		var HEALTH_URL = "/plugin/xiaoai/health";

		var BORDER = "1px solid rgba(127, 127, 127, 0.28)";
		var MUTED = "rgba(127, 127, 127, 0.95)";

		var wrapStyle = { padding: "4px 2px 24px", display: "flex", flexDirection: "column", gap: "16px", maxWidth: "720px" };
		var headerStyle = { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px" };
		var titleStyle = { fontSize: "16px", fontWeight: 600, margin: 0 };
		var subtitleStyle = { fontSize: "12px", color: MUTED, margin: 0, lineHeight: 1.6 };
		var cardStyle = { border: BORDER, borderRadius: "8px", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "8px" };
		var cardTitleStyle = { fontSize: "13px", fontWeight: 600, margin: "0 0 2px" };
		var rowStyle = { display: "flex", gap: "12px", alignItems: "baseline", fontSize: "12px", lineHeight: 1.7 };
		var labelStyle = { flex: "0 0 148px", color: MUTED };
		var valueStyle = { flex: "1 1 auto", wordBreak: "break-all", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" };
		var buttonStyle = {
			font: "inherit", fontSize: "12px", padding: "4px 10px", borderRadius: "6px",
			border: BORDER, background: "transparent", color: "inherit", cursor: "pointer"
		};
		var dotStyle = { display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", marginRight: "6px", verticalAlign: "middle" };
		var preStyle = { margin: 0, fontSize: "11px", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all", color: MUTED };

		function statusColor(state) {
			if (state === "ready") return "#22a06b";
			if (state === "error") return "#d9534f";
			return "#c79100";
		}

		function statusText(state) {
			if (state === "ready") return "桥接器插件已加载";
			if (state === "error") return "无法读取插件状态";
			return "正在读取插件状态...";
		}

		function Row(props) {
			return jsxs("div", {
				style: rowStyle,
				children: [
					jsx("span", { key: "label", style: labelStyle, children: props.label }),
					jsx("span", { key: "value", style: valueStyle, children: props.value }),
				],
			});
		}

		function Section(props) {
			return jsxs("div", {
				style: cardStyle,
				children: [
					jsx("div", { key: "title", style: cardTitleStyle, children: props.title }),
					props.children,
				],
			});
		}

		function XiaoaiSettingsTab() {
			var [state, setState] = useState({ status: "loading", data: null, error: null });

			var load = useCallback(function () {
				setState(function (prev) { return { status: prev.data ? prev.status : "loading", data: prev.data, error: null }; });
				return fetch(HEALTH_URL, { headers: { accept: "application/json" } })
					.then(function (res) {
						return res.json().then(function (body) { return { ok: res.ok, body: body }; });
					})
					.then(function (out) {
						if (!out.ok || !out.body || out.body.ok !== true) {
							var message = out.body && out.body.error ? out.body.error : "HTTP " + String(out.ok);
							setState({ status: "error", data: null, error: message });
							return;
						}
						setState({ status: "ready", data: out.body, error: null });
					})
					.catch(function (err) {
						setState({ status: "error", data: null, error: String(err && err.message ? err.message : err) });
					});
			}, []);

			useEffect(function () { load(); }, [load]);

			var health = state.data && state.data.health ? state.data.health : null;
			var checks = health && health.checks ? health.checks : {};
			var paths = health && health.paths ? health.paths : {};
			var keywords = health && health.wakeKeywords ? health.wakeKeywords : [];

			var rows = [];
			if (state.data) {
				rows.push(jsx(Row, { key: "plugin", label: "插件版本", value: String(state.data.version) }));
				rows.push(jsx(Row, { key: "ns", label: "设置命名空间", value: String(state.data.namespace) }));
			}
			if (health) {
				rows.push(jsx(Row, { key: "device", label: "音箱", value: String(health.deviceName) + "  (" + String(health.deviceHost) + ")" }));
				rows.push(jsx(Row, { key: "enabled", label: "插件启用", value: health.enabled ? "是" : "否" }));
				rows.push(jsx(Row, { key: "autostart", label: "随插件启动桥接器", value: health.autoStart ? "是" : "否" }));
				rows.push(jsx(Row, { key: "api", label: "API Server", value: health.apiServerEnabled ? String(health.apiServerUrl) : "未启用" }));
				rows.push(jsx(Row, { key: "asr", label: "语音识别后端", value: String(health.asrBackend) }));
				rows.push(jsx(Row, { key: "kw", label: "唤醒词", value: keywords.length > 0 ? keywords.join(" / ") : "（未配置）" }));
				rows.push(jsx(Row, { key: "cwd", label: "会话工作区", value: String(health.sessionCwd || "（DSH 默认）") }));
			}

			var checkRows = [];
			if (health) {
				var marks = [
					["桥接器目录", checks.bridgeDirIsDirectory],
					["Python 解释器", checks.pythonExists],
					["模型目录", checks.modelsDirExists],
					["技能文件", checks.skillFileExists],
				];
				for (var i = 0; i < marks.length; i += 1) {
					checkRows.push(jsx(Row, {
						key: "check-" + String(i),
						label: marks[i][0],
						value: marks[i][1] ? "已就绪" : "未就绪",
					}));
				}
			}

			var pathRows = [];
			if (health) {
				pathRows.push(jsx(Row, { key: "p1", label: "桥接器源代码", value: String(paths.bridgeDir) }));
				pathRows.push(jsx(Row, { key: "p2", label: "Python", value: String(paths.pythonPath) }));
				pathRows.push(jsx(Row, { key: "p3", label: "模型", value: String(paths.modelsDir) }));
			}

			return jsxs("div", {
				style: wrapStyle,
				children: [
					jsxs("div", {
						key: "header",
						style: headerStyle,
						children: [
							jsx("h2", { key: "t", style: titleStyle, children: "小爱音箱" }),
							jsx("button", { key: "b", type: "button", style: buttonStyle, onClick: load, children: "刷新" }),
						],
					}),
					jsxs("p", {
						key: "status",
						style: subtitleStyle,
						children: [
							jsx("span", { key: "dot", style: Object.assign({}, dotStyle, { background: statusColor(state.status) }) }),
							jsx("span", { key: "txt", children: statusText(state.status) }),
						],
					}),
					jsx("p", {
						key: "phase",
						style: subtitleStyle,
						children: "当前为第 1 期骨架：本页用于验证设置卡片与插件加载，完整设置表单、桥接器进程托管与语音闭环在后续阶段接入。",
					}),
					state.error
						? jsxs(Section, {
							key: "error",
							title: "错误",
							children: jsx("pre", { style: preStyle, children: String(state.error) }),
						})
						: null,
					health
						? jsxs(Section, { key: "config", title: "配置概览", children: rows })
						: null,
					health
						? jsxs(Section, { key: "checks", title: "环境自检", children: checkRows })
						: null,
					health
						? jsxs(Section, { key: "paths", title: "解析路径", children: pathRows })
						: null,
				],
			});
		}

		var inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("settings.plugins.tab", function () {
				return ctx.slots.register({
					name: "settings.plugins.tab",
					id: "xiaoai",
					order: 40,
					label: "小爱音箱",
				}, XiaoaiSettingsTab);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
