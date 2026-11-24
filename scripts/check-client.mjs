/**
 * Offline component check for the hand-authored browser half (`lib/client.js`).
 *
 * The client half is a committed build artifact in DSH's module-loader format,
 * so there is no bundler to catch mistakes. This script evaluates the bundle in
 * a sandbox with stubbed `react` / `react/jsx-runtime`, then asserts that the
 * module id matches the package name, that the plugin exports `apply`/`inject`,
 * and that applying it registers the bundle's configuration under the slot the
 * plugin manager actually dispatches. It renders both slot views, then mounts the page with
 * stateful hooks and a revision-fenced in-memory config endpoint.
 *
 * Run: node scripts/check-client.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { DEFAULTS } from '../lib/config.js';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT_FILE = join(PACKAGE_ROOT, 'lib', 'client.js');
const MANIFEST_FILE = join(PACKAGE_ROOT, 'package.json');

/**
 * dsh-client-ui-plugin-manager owns `plugins.bundle.config` and dispatches it
 * with `{ entryKey: pkg.name }`, so the cell key must be the package name.
 */
const EXPECTED_SLOT = Object.freeze({ name: 'plugins.bundle.config', keyProperty: 'key' });

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const pkg = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
const source = readFileSync(CLIENT_FILE, 'utf8');

// 1. Envelope: exactly one load() call carrying the package name.
let captured = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (mod) => { captured = mod; } } },
  console,
  Symbol,
  Object,
  Array,
  String,
  Boolean,
  Number,
  JSON,
  Math,
  Error,
};
vm.createContext(sandbox);
try {
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' });
} catch (err) {
  failures.push('bundle threw while evaluating: ' + String(err?.message ?? err));
}

check(captured !== null, 'bundle did not call window.__ModuleLoader__.load(...)');
if (captured !== null) {
  check(captured.id === pkg.name, `module id ${JSON.stringify(captured.id)} != package name ${JSON.stringify(pkg.name)}`);
  check(typeof captured.factory === 'function', 'load() was called without a factory function');

  // 2. The factory requires react plus the shared primitives library. It may
  //    NOT require a cordis service package: those belong in `dsh.client.inject`.
  const requested = [];
  const seen = { forms: [], valueFields: [], switches: [], segments: [], selects: [], folds: [], hidden: [] };
  const hooks = createHookDriver();
  const buttons = [];
  const element = (type, props, key) => {
    // Native controls are not stubbed components, so capture the one the page
    // builds by hand: the project-group picker.
    if (type === 'button' || type === primitivesStub.Button) buttons.push(props);
    if (type === 'select') seen.selects.push(props ?? {});
    // Gated fields and gated sections stay mounted behind `xiaoai_hidden`, so
    // the class list is what says whether a group is on the page right now.
    const className = props && typeof props.className === 'string' ? props.className : '';
    if (className.includes('xiaoai_hidden')) seen.hidden.push(className);
    return { type, props: props ?? {}, key: key ?? null };
  };
  const text = (children) => children;
  const primitivesStub = {
    Button: (props) => element('button', props),
    SettingsForm: (props) => {
      seen.forms.push(props);
      return element('div', { children: [props.labels?.unavailable, props.children, props.labels?.save] });
    },
    SettingsValueField: (props) => {
      seen.valueFields.push(props);
      return element('div', { children: [props.label, props.invalid ? props.invalidLabel : props.hint] });
    },
    SettingsSecretField: (props) => {
      seen.valueFields.push(props);
      return element('div', { children: [props.label, props.hint] });
    },
    Switch: (props) => {
      seen.switches.push(props);
      return element('div', { children: props.label });
    },
    SegmentedControl: (props) => {
      seen.segments.push(props);
      return element('div', { children: props.label });
    },
    Tag: (props) => element('span', { children: text(props.children) }),
    // The real component mounts collapsed content only while `open`, so a
    // section that starts collapsed is genuinely absent from this render. The
    // page text below therefore describes the default view, and the two fields
    // behind the collapsed 高级 fold are asserted at source level instead.
    DisclosureRow: (props) => {
      seen.folds.push(props);
      const head = element('div', { children: props.title });
      if (!props.open) return element('div', { children: [head, props.collapsedContent] });
      return element('div', { children: [head, props.children] });
    },
  };
  const shim = (specifier) => {
    requested.push(specifier);
    if (specifier === 'react') {
      return {
        ...hooks.api,
        createElement: element,
        Fragment: Symbol('Fragment'),
      };
    }
    if (specifier === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: Symbol('Fragment') };
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub;
    throw new Error('unexpected require(' + JSON.stringify(specifier) + ')');
  };

  const ALLOWED_REQUIRES = new Set(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']);

  let mod = null;
  if (typeof captured.factory === 'function') {
    try {
      mod = captured.factory(shim);
    } catch (err) {
      failures.push('factory threw: ' + String(err?.message ?? err));
    }
  }
  check(
    requested.every((s) => ALLOWED_REQUIRES.has(s)),
    'factory required undeclared modules: ' + JSON.stringify(requested.filter((s) => !ALLOWED_REQUIRES.has(s))),
  );

  if (mod) {
    check(typeof mod.apply === 'function', 'bundle does not export apply');
    check(Array.isArray(mod.inject), 'bundle does not export an inject array');
    check(
      Array.isArray(mod.inject) && mod.inject.includes('slots'),
      'bundle inject must include the "slots" service, got ' + JSON.stringify(mod.inject),
    );
    check(
      Array.isArray(mod.inject) && mod.inject.includes('locale'),
      'bundle inject must include the "locale" service, got ' + JSON.stringify(mod.inject),
    );
    // The model catalogue behind the reply-generator picker is a remote call:
    // it is reached in apply(), so the two remotes must be injected too.
    check(
      Array.isArray(mod.inject) && mod.inject.includes('remote'),
      'bundle inject must include the "remote" service, got ' + JSON.stringify(mod.inject),
    );
    check(
      Array.isArray(mod.inject) && mod.inject.includes('remote.session'),
      'bundle inject must include the "remote.session" service, got ' + JSON.stringify(mod.inject),
    );

    // 3. Applying the plugin must register the bundle-configuration cell the
    //    plugin manager dispatches by package name.
    const registrations = [];
    let localeRegistrations = 0;
    const dictionaries = new Map();
    const ctx = {
      slots: {
        inject(name, callback) { callback(); return () => {}; },
        register(options, component) { registrations.push({ options, component }); return () => {}; },
      },
      locale: {
        // Mirror the real service: register() takes the dictionaries, bind()
        // resolves a key through the active language. Returning the key itself
        // (an identity bind) would hide every copy mistake from this check.
        register(ns, copy) { localeRegistrations += 1; dictionaries.set(ns, copy); return () => {}; },
        bind: (ns) => (key) => dictionaries.get(ns)?.zh?.[key] ?? key,
      },
      remote: { session: { modelCatalog: async () => ({ groups: [{ id: 'openai', models: [{ id: 'gpt-5' }] }] }) } },
      effect: (fn) => fn(),
    };
    try {
      if (typeof mod.apply === 'function') mod.apply(ctx);
    } catch (err) {
      failures.push('apply threw: ' + String(err?.message ?? err));
    }

    check(registrations.length === 1, `expected exactly 1 slot registration, got ${registrations.length}`);
    check(localeRegistrations === 1, `expected exactly 1 locale dictionary registration, got ${localeRegistrations}`);
    const first = registrations[0];
    if (first) {
      check(first.options.name === EXPECTED_SLOT.name, `slot name ${JSON.stringify(first.options.name)} != ${JSON.stringify(EXPECTED_SLOT.name)}`);
      check(first.options.key === pkg.name, `slot key ${JSON.stringify(first.options.key)} != package name ${JSON.stringify(pkg.name)}`);
      check(first.options.id === undefined, 'bundle-config slot takes "key", not "id"');
      check(typeof first.component === 'function', 'slot registration needs a component function');

      // 4. The component must build both views without throwing.
      if (typeof first.component === 'function') {
        try {
          // collectText() returns the text nodes; join them before substring checks.
          const page = collectText(first.component({ view: 'page' })).join('');
          const summary = collectText(first.component({ view: 'summary' })).join('');
          check(summary.includes('小爱音箱'), 'summary view does not name the plugin');

          // Every configurable field must reach a control, so a field added to
          // lib/config.js without a client entry fails this check. The list
          // covers what the default view shows; the advanced pair is checked
          // below, because its fold starts collapsed.
          const configFields = [
            '启用插件', '音箱名称', '音箱地址', '音箱连接鉴权', '唤醒词', '语音识别后端', '会话工作区',
            '随插件启动桥接器', '日志级别',
            '启用本地 API 服务', '监听地址', '监听端口', '访问令牌凭据名',
            '对话保持时长（秒）', '连续对话', '语音合成方式', '豆包 App ID', '豆包访问令牌', '豆包音色', '豆包音频格式', '边合成边播放', '豆包语速', '唤醒应答', '退出应答', '退出词',
            '兜底播报文本', '会话键',
            '自动念出回复', '任何会话都能让小爱说话', '播报字数上限', '回复器模型', '回复器参考轮数',
            '回复器失败提示语', '审批等待提示语', '人格设定', '说话风格', '行动准则', '输出限制', '语音消息附加提示',
          ];
          for (const label of configFields) {
            check(page.includes(label), `page view is missing the field ${JSON.stringify(label)}`);
          }
          check(page.includes('自动念回复和 xiaoai_speak 都只用这里选的音色'), 'the TTS setting must identify both speech paths');
          check(page.includes('查看诊断后手动重试'), 'the TTS setting must explain what to do after a failed announcement');
          // Inside the 高级 fold: the fold must exist (asserted below) and keep
          // carrying these two labels.
          for (const label of ['桥接器目录', 'Python 解释器']) {
            check(source.includes(label), `the 高级 fold is missing the field ${JSON.stringify(label)}`);
          }
          // Seven sections fold, plus the nested 高级 fold; the Doubao group is
          // rendered as a bare group of fields and is asserted below.
          check(
            seen.folds.length === 8,
            `the page should fold its 7 sections plus the 高级 fold, got ${seen.folds.length} DisclosureRow renders`,
          );
          for (const heading of ['基本', '唤醒与语音', '应答与兜底', '播报与回复器', '人格与提示词', '桥接器进程', '本地 API 服务', '运行状态']) {
            check(page.includes(heading), `page view is missing the section ${JSON.stringify(heading)}`);
          }
          // The Doubao group is mounted but hidden while the provider is not
          // Doubao: hiding rather than dropping keeps its drafts and validation
          // messages, the same rule the gated fields follow.
          check(
            seen.hidden.includes('xiaoai_section xiaoai_hidden'),
            'the Doubao section should carry xiaoai_hidden while the provider is not Doubao',
          );
          // And it is not collapsible: its fields have to reach the page on their
          // own, so no DisclosureRow may carry it, and -- because the provider
          // option right above already reads 豆包语音合成 -- the group draws no
          // heading of its own either, which is a source-level fact: the entry in
          // SECTIONS has no `title`.
          check(
            !seen.folds.some((fold) => fold.title === '豆包语音合成'),
            'the Doubao group should render its fields straight into the page, not as a fold',
          );
          check(
            !/id: "doubao",[^}]*title:/.test(source),
            'the Doubao group should carry no section title of its own',
          );
          check(
            page.includes('豆包语音合成'),
            'the Doubao provider option should be labelled 豆包语音合成',
          );

          // Every settings key the host can store must have a control here;
          // otherwise a value exists that the user can only change by hand.
          for (const key of Object.keys(DEFAULTS)) {
            check(source.includes(`key: "${key}"`), `lib/config.js defines ${JSON.stringify(key)} but lib/client.js renders no control for it`);
          }

          // 5. The official form frame must be driven with the shape SettingsForm
          //    documents, or the page renders its "unavailable" line instead.
          const form = seen.forms[seen.forms.length - 1];
          check(Boolean(form), 'page view did not render SettingsForm');
          if (form) {
            check(form.state && typeof form.state.available === 'boolean', 'SettingsForm.state.available is missing');
            check(form.state && typeof form.state.dirty === 'boolean', 'SettingsForm.state.dirty is missing');
            check(form.state && typeof form.state.invalid === 'boolean', 'SettingsForm.state.invalid is missing');
            check(form.state && typeof form.state.saving === 'boolean', 'SettingsForm.state.saving is missing');
            check(form.state && typeof form.state.failed === 'boolean', 'SettingsForm.state.failed is missing');
            for (const label of ['unavailable', 'readOnly', 'save', 'saving', 'saveFailed']) {
              check(typeof form.labels?.[label] === 'string', `SettingsForm.labels.${label} is missing`);
            }
            check(typeof form.onSave === 'function', 'SettingsForm.onSave is missing');
            check(typeof form.onDiscard === 'function', 'SettingsForm.onDiscard is missing');
          }

          // 6. Each control must receive the props its implementation reads.
          const valueFields = seen.valueFields;
          check(valueFields.length > 0, 'no text field was rendered through SettingsValueField');
          for (const field of valueFields) {
            check(typeof field.id === 'string' && field.id.startsWith('xiaoai-'), 'a value field has no id');
            check(typeof field.label === 'string' && field.label.length > 0, 'a value field has no label');
            check(typeof field.text === 'string', `value field ${field.id} has no staged text`);
            check(typeof field.onEdit === 'function', `value field ${field.id} has no onEdit`);
            check(typeof field.resetLabel === 'string', `value field ${field.id} has no resetLabel`);
            check(typeof field.overriddenLabel === 'string', `value field ${field.id} has no overriddenLabel`);
          }
          // One switch per `kind: "boolean"` field (enabled, speakerAuth,
          // continuousConversation, autoSpeak, speakFromAnySession, autoStart,
          // silentStart, apiServerEnabled, doubaoStream).
          check(seen.switches.length === 9, `expected 9 Switch controls, got ${seen.switches.length}`);
          for (const control of seen.switches) {
            check(typeof control.checked === 'boolean', 'a Switch has no checked value');
            check(typeof control.onChange === 'function', 'a Switch has no onChange');
          }
          check(seen.segments.length === 4, `expected 4 SegmentedControl controls, got ${seen.segments.length}`);
          for (const control of seen.segments) {
            check(Array.isArray(control.options) && control.options.length >= 2, `SegmentedControl ${control.id} needs at least 2 options`);
            check(typeof control.onChange === 'function', `SegmentedControl ${control.id} has no onChange`);
          }

          // 6b. The TTS provider control carries its own option wording: both
          //     choices are translated rather than shown raw. Nothing is staged
          //     before `/config` answers, so the control starts unselected; the
          //     value it lands on is DEFAULTS.ttsProvider (`xiaoai`), which
          //     check-config.mjs holds down on the rendering side.
          const provider = seen.segments.find((control) => control.id === 'xiaoai-ttsProvider');
          check(Boolean(provider), 'page view did not render the TTS provider control');
          if (provider) {
            check(provider.value === '', `the TTS provider control should start unselected, got ${JSON.stringify(provider.value)}`);
            const options = (provider.options ?? []).map((option) => `${option.value}=${option.label}`);
            check(
              JSON.stringify(options) === JSON.stringify(['xiaoai=小爱原生', 'doubao=豆包语音合成']),
              `unexpected TTS provider options: ${JSON.stringify(options)}`,
            );
          }
          // 6b-2. The Doubao audio format offers the four formats the API can
          //       return plus "keep the config value", each translated.
          const format = seen.segments.find((control) => control.id === 'xiaoai-doubaoAudioFormat');
          check(Boolean(format), 'page view did not render the Doubao audio format control');
          if (format) {
            check(format.value === '', `the audio format control should default to the empty choice, got ${JSON.stringify(format.value)}`);
            const options = (format.options ?? []).map((option) => `${option.value}=${option.label}`);
            check(
              JSON.stringify(options) === JSON.stringify(['=沿用配置', 'auto=自动', 'pcm=PCM', 'mp3=MP3', 'ogg_opus=OGG Opus']),
              `unexpected Doubao audio format options: ${JSON.stringify(options)}`,
            );
          }
          // 6c. The other two enums keep the raw value as their label.
          const backend = seen.segments.find((control) => control.id === 'xiaoai-asrBackend');
          check(Boolean(backend), 'page view did not render the ASR backend control');
          if (backend) {
            check(
              (backend.options ?? []).every((option) => option.value === option.label),
              'an enum without optionLabels must show its raw value',
            );
          }

          // 7. Two hand-built native <select> controls. The first is the
          //    project-group picker, populated from GET /health, not a free-text
          //    path: the host groups a session only when its cwd is exactly a
          //    workspace path, so a typed path would silently leave the speaker
          //    ungrouped. The initial render precedes the /health response, which is
          //    exactly the empty-list case. The second is the reply-generator
          //    route: one picker over the pair of stored keys (provider and
          //    model), filled from the host's model catalogue. Before effects run,
          //    the catalogue stays idle and only the
          //    "follow the session's default model" option can render.
          check(seen.selects.length === 2, `expected 2 native <select>, got ${seen.selects.length}`);
          const workspacePicker = seen.selects.find((control) => control.id === 'xiaoai-sessionCwd');
          const routePicker = seen.selects.find((control) => control.id === 'xiaoai-replyerRoute');
          check(workspacePicker !== undefined, 'the project-group picker is gone');
          check(routePicker !== undefined, 'the reply-generator route picker is gone');
          for (const control of seen.selects) {
            check(typeof control.onChange === 'function', `<select> ${JSON.stringify(control.id)} has no onChange`);
          }
          if (workspacePicker) {
            const values = (workspacePicker.children ?? []).map((option) => option.props.value);
            check(
              values.length === 1 && values[0] === '',
              `a host that reports no workspaces must offer only "not set", got ${JSON.stringify(values)}`,
            );
          }
          if (routePicker) {
            const values = (routePicker.children ?? []).map((option) => option.props.value);
            check(
              values.length === 1 && values[0] === '',
              `an unloaded catalogue must offer only "follow the session's default", got ${JSON.stringify(values)}`,
            );
          }
          check(source.includes('healthFacts.workspaces'), 'the picker must read the workspace list out of the /health facts');
          check(source.includes('field.sessionCwd.follow'), 'the picker needs a "follow the default" option label');

          // The catalogue wiring itself: the remote call is made in apply()
          // (assert the service wiring by name), the picker reads
          // it through the module-level snapshot, and the failing case offers a
          // retry rather than an empty list.
          check(
            source.includes('ctx.remote.session.modelCatalog()'),
            'the route picker must read the model catalogue from remote.session.modelCatalog()',
          );
          check(source.includes('routeChoices'), 'the route picker must build its options from the catalogue');
          check(source.includes('"route.follow"'), 'the route picker needs a "follow the session default" option');
          check(source.includes('"optgroup"') && source.includes('label: choice.group'), 'the route picker must group models by provider');
          check(source.includes('"route.stale"'), 'a stored route that left the catalogue must stay selectable');
          check(source.includes('"route.retry"') && source.includes('reloadCatalog()'), 'a failed catalogue read must offer a retry');
          check(
            source.includes('edit(chosen[0],') && source.includes('edit(chosen[1],') && source.includes('}(routeKeys)'),
            'one pick must write both keys of the route pair',
          );

          // The Doubao token row replaces the credential-name text field: the
          // name is fixed by the plugin now, and the value goes to the host
          // credential store through the plugin's own route instead of into the
          // settings document.
          check(source.includes('"/plugin/xiaoai/credential/doubao"'), 'the token row must post to the plugin credential route');
          check(source.includes('type: "password"'), 'the token row must not show the token in clear text');
          check(
            source.includes('{ key: "doubaoAccessKeyCredential", section: "doubao", kind: "text", identifier: true, hint: "hint.doubaoAccessKeyCredential", hidden: true }'),
            'the credential-name field must stay stored but hidden, not be dropped',
          );
          check(source.includes('{ key: "replyerRoute", section: "speak", kind: "route", composite: true, pairs: ["replyerProvider", "replyerModel"]'), 'the route row must declare the pair it writes');
          check(page.includes('豆包访问令牌'), 'the token row must be labelled 豆包访问令牌');
          check(
            !seen.valueFields.some((field) => field.id === 'xiaoai-doubaoAccessKeyCredential'),
            'the hidden credential-name field must not draw a control',
          );
          check(
            !seen.valueFields.some((field) => field.id === 'xiaoai-replyerProvider' || field.id === 'xiaoai-replyerModel'),
            'the two keys behind the route picker must not draw controls of their own',
          );
          check(
            source.includes('{ key: "replyerProvider", section: "speak", kind: "text", render: false }')
              && source.includes('{ key: "replyerModel", section: "speak", kind: "text", render: false }'),
            'the pair behind the route picker must draw nothing yet still produce ops (render: false, not hidden)',
          );

          const seam = mod.__check;
          check(typeof seam?.routeChoices === 'function', 'the bundle must expose routeChoices to this check');
          if (seam && typeof seam.routeChoices === 'function') {
            const pickedRoute = seam.routeChoices(
              { status: 'ready', groups: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] }] },
              'openai',
              'gpt-5',
            );
            check(
              pickedRoute.value === 'openai/gpt-5',
              `the picker must select the stored pair, got ${JSON.stringify(pickedRoute.value)}`,
            );
            check(
              JSON.stringify(pickedRoute.options[1]) === JSON.stringify({
                group: 'OpenAI',
                children: [{ value: 'openai/gpt-5', label: 'GPT-5', parts: ['openai', 'gpt-5'] }],
              }),
              `every option must carry the pair it writes, got ${JSON.stringify(pickedRoute.options[1])}`,
            );
            const staleRoute = seam.routeChoices({ status: 'ready', groups: [] }, 'gone', 'model/x');
            const lastOption = staleRoute.options[staleRoute.options.length - 1];
            check(
              lastOption?.value === 'gone/model/x'
                && JSON.stringify(lastOption.parts) === JSON.stringify(['gone', 'model/x']),
              `a route that left the catalogue must keep its own pair, got ${JSON.stringify(lastOption)}`,
            );
          }

          // 8. The single-shot switch is a plain checkbox with an explanation
          //    on both languages; the page itself has no conditional logic, so
          //    the wording is what tells the user what it does.
          check(
            source.includes('{ key: "continuousConversation", section: "voice", kind: "boolean", hint: "hint.continuousConversation" }'),
            'the continuous-conversation switch is not wired into the voice section',
          );
          check(source.includes('field.continuousConversation'), 'the switch has no field label');
          check(source.includes('hint.continuousConversation'), 'the switch has no hint');

          // 9. The status card reports the API Server probe and the diagnostics
          //    list. The initial render precedes the /health response,
          //    so the rows themselves cannot render here: assert the wiring by name, and assert separately that every
          //    diagnostic code the host can store has wording in both languages.
          for (const needle of [
            'status.api',
            'status.apiUrl',
            'status.apiAuth',
            'status.token',
            'status.watchdog',
            'status.lastError',
            'status.diagnostics',
            'status.noErrors',
            'facts.bridgeApi',
            'facts.diagnostics',
            'diagnostic.',
          ]) {
            check(source.includes(needle), `the status card never mentions ${JSON.stringify(needle)}`);
          }
          const diagnosticSource = readFileSync(join(PACKAGE_ROOT, 'lib', 'diagnostics.js'), 'utf8');
          const codes = [...diagnosticSource.matchAll(/'([a-z][a-z-]*[a-z])'/g)]
            .map((match) => match[1])
            .filter((value) => value.includes('-'));
          check(codes.length >= 5, `expected the diagnostics module to list its codes, found ${codes.length}`);
          for (const code of codes) {
            check(
              source.includes(`"diagnostic.${code}"`),
              `lib/diagnostics.js reports ${JSON.stringify(code)} but the page has no wording for it`,
            );
          }

          // 11. The catalogue's degraded states: a failed read disables the
          //     picker (the list on screen is not a list of what can be picked)
          //     while the idle/loading state stays selectable, and the line
          //     under it is picked by the bundle's own `routeHintFor`, driven
          //     here with stand-in catalogues so every branch is exercised
          //     rather than grepped for.
          const copy = dictionaries.get('plugin.xiaoai');
          check(
            source.includes('var routeDisabled = catalog.status === "error" || catalog.status === "unavailable";')
              && source.includes('disabled: routeDisabled,'),
            'a failed catalogue read must disable the route picker',
          );
          check(
            source.includes('var routeHint = routeHintFor(catalog, hint);'),
            'the route row must draw the line routeHintFor picks',
          );
          check(
            typeof seam?.routeHintFor === 'function',
            'the bundle must expose its catalogue hint selector to this check',
          );
          if (typeof seam?.routeHintFor === 'function') {
            const zh = copy?.zh ?? {};
            check(
              ['route.loading', 'route.failed', 'route.empty', 'route.partial'].every(
                (key) => typeof zh[key] === 'string' && zh[key].length > 0,
              ),
              'the zh dictionary must carry every catalogue wording this check drives',
            );
            const hintFor = (catalog) => seam.routeHintFor(catalog, 'FIELD-HINT');
            const ready = (groups, failures) => ({ status: 'ready', groups: groups, failures: failures, error: null });
            check(
              hintFor(ready([{ models: [{ id: 'm' }] }], [])) === 'FIELD-HINT',
              'a healthy catalogue must leave the field hint alone',
            );
            check(
              hintFor(ready([{ models: [{ id: 'm' }] }], ['openai'])) === zh['route.partial'],
              'a catalogue read that lost a provider group must say so in the picker',
            );
            check(
              hintFor(ready([], [])) === zh['route.empty'],
              'a catalogue with no models at all must say so',
            );
            check(
              hintFor(ready([], ['openai'])) === zh['route.empty'],
              'an empty catalogue must say there is no model even when a provider also failed, not merely that the list may be incomplete',
            );
            check(
              hintFor({ status: 'loading', groups: [], failures: [], error: null }) === zh['route.loading'],
              'a catalogue still loading must say so',
            );
            check(
              hintFor({ status: 'error', groups: [], failures: [], error: 'boom' }) === zh['route.failed'] + 'boom',
              'a failed read must append its error text to the failed wording',
            );
            check(
              hintFor({ status: 'error', groups: [], failures: [], error: '' }) === 'FIELD-HINT',
              'a failed read with no error text must not render the failed wording with nothing after the colon',
            );
            check(
              hintFor({ status: 'unavailable', groups: [], failures: [], error: null }) === 'FIELD-HINT',
              'an unavailable catalogue with no error text must keep the field hint',
            );
          }
          check(
            routePicker?.disabled === false,
            'the route picker must stay selectable while the catalogue is idle or loading',
          );

          // 12. Copy parity and the dead-hint guard. Every user-visible string
          //     lives in the two inline dictionaries, and a key that only one
          //     language carries (or that no control ever shows) is invisible
          //     until someone reads the page in that language.
          const zhKeys = Object.keys(copy?.zh ?? {}).sort();
          const enKeys = Object.keys(copy?.en ?? {}).sort();
          check(zhKeys.length > 0, 'the bundle must register its zh dictionary');
          check(
            JSON.stringify(zhKeys) === JSON.stringify(enKeys),
            'the zh and en dictionaries must carry the same keys',
          );
          // Structural rather than counted: `fields` is the bundle's own FIELDS
          // table, so a hint whose only reference moved behind `render: false`
          // (or was deleted outright) shows up here even though the rendered
          // snapshot never mentions the field. A hint key is live when a drawn
          // field asks for it, or when a component translates it by name: the
          // Doubao token row lives in a `hidden: true` entry and the empty-field
          // fallback is rendered from code, so both are reached that way.
          const fieldSpecs = Array.isArray(seam?.fields) ? seam.fields : [];
          check(fieldSpecs.length > 0, 'the bundle must expose its field table to this check');
          const drawnHints = new Set(
            fieldSpecs
              .filter((spec) => spec.render !== false && typeof spec.hint === 'string')
              .map((spec) => spec.hint),
          );
          const translatedHints = new Set(
            [...source.matchAll(/translate\("(hint\.[A-Za-z0-9]+)"\)/g)].map((match) => match[1]),
          );
          const deadHints = zhKeys.filter(
            (key) => key.startsWith('hint.') && !drawnHints.has(key) && !translatedHints.has(key),
          );
          check(
            deadHints.length === 0,
            `settings wording exists but no drawn control can show it: ${JSON.stringify(deadHints)}`,
          );
          const missingHints = [
            ...new Set(fieldSpecs.filter((spec) => typeof spec.hint === 'string').map((spec) => spec.hint)),
          ].filter((key) => !zhKeys.includes(key) || !enKeys.includes(key));
          check(
            missingHints.length === 0,
            `a control asks for wording the dictionaries do not carry: ${JSON.stringify(missingHints)}`,
          );
          // The autoSpeak hint has to stay true to what that switch silences.
          // lib/auto-speak.js speaks the approval line even with autoSpeak off
          // (the switch only suppresses the assistant's own reply), and
          // scripts/check-speak.mjs pins that behaviour, so a hint promising a
          // silent speaker would be contradicted by the same release.
          check(
            /审批/.test(String(copy?.zh?.['hint.autoSpeak'] ?? ''))
              && /approval/i.test(String(copy?.en?.['hint.autoSpeak'] ?? '')),
            'the autoSpeak hint must say that the approval line is spoken whether the switch is on or off',
          );
          // translate() falls back to the key itself when the zh dictionary has
          // no wording for it, so a raw "hint." on the page means a control is
          // showing a key instead of an explanation.
          check(!page.includes('hint.') && !summary.includes('hint.'), 'a control shows a hint key instead of its wording');
          for (const key of zhKeys) {
            check(String(copy.en[key] ?? '').length > 0, `the en dictionary is missing wording for ${JSON.stringify(key)}`);
          }
          await verifyEditor({ first, seen, hooks, buttons, copy });
        } catch (err) {
          failures.push('component check failed: ' + String(err?.stack ?? err));
        }
      }
    }
  }
}

/** Persist hook slots between renders and run committed effects in dependency order. */
function createHookDriver() {
  let mounted = false, cursor = 0;
  const cells = [], effects = [];
  const slot = () => cells[cursor++] ??= {};
  const changed = (prev, deps) => !prev || !deps || deps.some((v, i) => !Object.is(v, prev[i]));
  const api = {
    useState(initial) {
      const cell = mounted ? slot() : {};
      if (!('value' in cell)) cell.value = typeof initial === 'function' ? initial() : initial;
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next; }];
    },
    useRef(initial) { return mounted ? (slot().ref ??= { current: initial }) : { current: initial }; },
    useCallback(fn, deps) {
      if (!mounted) return fn;
      const cell = slot();
      if (changed(cell.deps, deps)) { cell.fn = fn; cell.deps = deps; }
      return cell.fn;
    },
    useEffect(fn, deps) {
      if (!mounted) return;
      const cell = slot();
      if (changed(cell.deps, deps)) {
        cell.deps = deps;
        effects.push(() => { cell.cleanup?.(); cell.cleanup = fn(); });
      }
    },
  };
  return { api, mount() { mounted = true; }, begin() { cursor = 0; }, commit() { effects.splice(0).forEach((run) => run()); } };
}

async function verifyEditor({ first, seen, hooks, buttons, copy }) {
  let revision = 1, readError = false;
  const user = { deviceName: 'kitchen', apiServerPort: 9092, replyerProvider: 'acme', replyerModel: 'm1' };
  const posts = [];
  const response = (status, body) => ({ ok: status === 200, status, json: async () => body });
  sandbox.fetch = async (url, init) => {
    if (url !== '/plugin/xiaoai/config') return response(200, { ok: true });
    if (init.method !== 'POST') return readError ? response(503, { ok: false, error: 'offline' })
      : response(200, { ok: true, descriptor: { value: { ...DEFAULTS, ...user }, base: DEFAULTS, user: { ...user }, revision } });
    const request = JSON.parse(init.body);
    posts.push(request);
    if (request.revision !== revision) return response(409, { ok: false });
    for (const op of request.ops) {
      if (op.op === 'unset') delete user[op.path[0]];
      else user[op.path[0]] = op.value;
    }
    revision++;
    return response(200, { ok: true });
  };
  hooks.mount();
  const render = () => {
    hooks.begin();
    for (const rows of Object.values(seen)) rows.length = 0;
    buttons.length = 0;
    const text = collectText(first.component({ view: 'page' })).join('');
    hooks.commit();
    return text;
  };
  const tick = async () => { await new Promise(setImmediate); return render(); };
  const field = (key) => seen.valueFields.find((row) => row.id === 'xiaoai-' + key);
  const form = () => seen.forms[0];
  const action = (label) => buttons.find((button) => button.children === label).onClick();
  const rename = (text) => { field('deviceName').onEdit(text); render(); };
  const writeName = (value) => ({ op: 'set', path: ['deviceName'], value });
  render();
  assert.equal(form().state.available, false);
  await tick();
  assert.equal(form().state.available, true);
  assert.equal(field('deviceName').text, 'kitchen');
  assert.equal(field('apiServerPort').text, '9092');
  assert.equal(form().state.dirty, false);
  assert.equal(form().state.invalid, false);
  form().onSave(); assert.equal(posts.length, 0);

  rename('office'); user.apiServerPort = 9100; revision++;
  form().onSave(); await tick();
  assert.equal(field('apiServerPort').text, '9100');
  assert.equal(field('deviceName').text, 'office');
  form().onSave(); await tick();
  assert.deepEqual(posts.slice(-2), [1, 2].map((revision) => ({ revision, ops: [writeName('office')] })));
  assert.equal(form().state.dirty, false);

  for (const keep of [false, true]) {
    rename('local'); user.deviceName = 'remote-' + keep; revision++;
    form().onSave(); await tick();
    assert.equal(form().state.invalid, true);
    const count = posts.length;
    form().onSave(); assert.equal(posts.length, count);
    action(keep ? '保留我的修改' : '采用已保存值'); render();
    assert.equal(form().state.invalid, false);
    assert.equal(field('deviceName').text, keep ? 'local' : user.deviceName);
    assert.equal(form().state.dirty, keep);
    if (keep) { form().onSave(); await tick(); assert.deepEqual(posts.at(-1).ops, [writeName('local')]); }
  }
  field('apiServerPort').onEdit('oops'); render();
  action(copy.zh['status.refresh']); await tick();
  assert.equal(field('apiServerPort').text, 'oops');
  assert.equal(form().state.invalid, true);
  form().onDiscard(); render();
  field('apiServerPort').onReset(); render();
  assert.equal(field('apiServerPort').text, String(DEFAULTS.apiServerPort));
  form().onSave(); await tick();
  assert.deepEqual(posts.at(-1).ops, [{ op: 'unset', path: ['apiServerPort'] }]);

  const pick = (value) => { seen.selects.find((s) => s.id === 'xiaoai-replyerRoute').onChange({ target: { value } }); render(); };
  pick('openai/gpt-5'); form().onSave(); await tick();
  assert.deepEqual(posts.at(-1).ops, [
    { op: 'set', path: ['replyerProvider'], value: 'openai' }, { op: 'set', path: ['replyerModel'], value: 'gpt-5' },
  ]);
  pick(''); form().onSave(); await tick();
  assert.deepEqual(posts.at(-1).ops, ['replyerProvider', 'replyerModel'].map((key) => ({ op: 'unset', path: [key] })));
  rename('study'); readError = true; action(copy.zh['status.refresh']);
  assert.ok((await tick()).includes('offline'));
  assert.equal(field('deviceName').text, 'study');
  assert.equal(form().state.available, true);
}

/** Flatten the stubbed element tree into its visible text. */
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out; }
  if (typeof node === 'object' && node.props) {
    // Function elements are our primitives stubs: render them so their own
    // labels (passed as props, not children) join the visible text.
    if (typeof node.type === 'function') return collectText(node.type(node.props), out);
    if (node.props.children !== undefined) collectText(node.props.children, out);
    return out;
  }
  return out;
}

// 7. Package display name and description are localized through locale/*.json:
//    dsh-app-boot resolves `<specifier>/locale/en.json` through the Node
//    resolver, then reads every sibling `*.json` as one language dictionary.
//    Without the exports entry the resource is invisible and the Plugins page
//    falls back to the raw package name.
const LOCALE_DIR = join(PACKAGE_ROOT, 'locale');
let localeNames = [];
try {
  localeNames = readdirSync(LOCALE_DIR).filter((name) => name.endsWith('.json')).sort();
} catch {
  failures.push('locale/ directory is missing (the Plugins page will show the raw package name)');
}
check(localeNames.includes('en.json'), 'locale/en.json is the anchor dsh-app-boot resolves first');
check(localeNames.includes('zh.json'), 'locale/zh.json is missing the Chinese display name');
for (const name of localeNames) {
  const language = name.slice(0, -5);
  check(
    /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language),
    `locale/${name} must use a language id as its filename`,
  );
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(join(LOCALE_DIR, name), 'utf8'));
  } catch (err) {
    failures.push(`locale/${name} is not valid JSON: ` + String(err?.message ?? err));
    continue;
  }
  const meta = parsed && typeof parsed === 'object' ? parsed.meta : undefined;
  check(meta && typeof meta === 'object', `locale/${name} must carry a "meta" object`);
  for (const field of ['title', 'description']) {
    const value = meta?.[field];
    check(
      typeof value === 'string' && value.trim() !== '',
      `locale/${name}: meta.${field} must be a non-empty string`,
    );
  }
}
check(
  typeof pkg.exports?.['./locale/*'] === 'string',
  'package.json exports must expose "./locale/*" or the resolver cannot reach the dictionaries',
);
check(
  Array.isArray(pkg.files) && pkg.files.includes('locale/'),
  'package.json files must include "locale/" so the dictionaries ship',
);

if (failures.length > 0) {
  console.error('client bundle check FAILED:');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}
console.log('client bundle check OK: id=' + pkg.name + ', slot=' + EXPECTED_SLOT.name + ' key=' + pkg.name);
