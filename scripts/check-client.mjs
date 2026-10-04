/**
 * Structural check for the hand-authored browser half (`lib/client.js`).
 *
 * The client half is a committed build artifact in DSH's module-loader format,
 * so there is no bundler to catch mistakes. This script evaluates the bundle in
 * a sandbox with stubbed `react` / `react/jsx-runtime`, then asserts that the
 * module id matches the package name, that the plugin exports `apply`/`inject`,
 * and that applying it registers the bundle's configuration under the slot the
 * plugin manager actually dispatches. It also renders the component once with
 * stubbed hooks to prove the tree builds in both the `page` and `summary` views.
 *
 * Run: node scripts/check-client.mjs
 */
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
  // Every `setState` updater the page calls while this check drives it. The stub
  // never re-renders, so recording them is the only way to observe what a
  // control such as the route picker puts into the draft.
  const stateWrites = [];
  const element = (type, props, key) => {
    // Native controls are not stubbed components, so capture the one the page
    // builds by hand: the project-group picker.
    if (type === 'select') seen.selects.push(props ?? {});
    // Gated fields and gated sections stay mounted behind `xiaoai_hidden`, so
    // the class list is what says whether a group is on the page right now.
    const className = props && typeof props.className === 'string' ? props.className : '';
    if (className.includes('xiaoai_hidden')) seen.hidden.push(className);
    return { type, props: props ?? {}, key: key ?? null };
  };
  const text = (children) => children;
  const primitivesStub = {
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
        useState: (initial) => [
          typeof initial === 'function' ? initial() : initial,
          (next) => { stateWrites.push(next); },
        ],
        useEffect: () => {},
        useCallback: (fn) => fn,
        useMemo: (fn) => fn(),
        useRef: (initial) => ({ current: initial }),
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
          //    ungrouped. The harness never lets /health answer, which is
          //    exactly the empty-list case. The second is the reply-generator
          //    route: one picker over the pair of stored keys (provider and
          //    model), filled from the host's model catalogue. The harness never
          //    runs effects, so the catalogue stays idle and only the
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
            // The other half of the write path: the ops are only as good as the
            // draft the control puts them in, so drive the real change handler
            // and replay the updater it recorded.
            stateWrites.length = 0;
            routePicker.onChange({ target: { value: 'openai/gpt-5' } });
            check(stateWrites.length >= 1, 'one pick must touch the draft');
            let replayed = {};
            for (const update of stateWrites) replayed = typeof update === 'function' ? update(replayed) : update;
            check(
              replayed.replyerProvider === 'openai' && replayed.replyerModel === 'gpt-5',
              `one pick must fill both keys of the pair, got ${JSON.stringify(replayed)}`,
            );
            stateWrites.length = 0;
            routePicker.onChange({ target: { value: '' } });
            let cleared = { replyerProvider: 'openai', replyerModel: 'gpt-5' };
            for (const update of stateWrites) cleared = typeof update === 'function' ? update(cleared) : update;
            check(
              cleared.replyerProvider === '' && cleared.replyerModel === '',
              `"follow the session's default" must clear both keys, got ${JSON.stringify(cleared)}`,
            );
          }
          check(source.includes('healthFacts.workspaces'), 'the picker must read the workspace list out of the /health facts');
          check(source.includes('field.sessionCwd.follow'), 'the picker needs a "follow the default" option label');

          // The catalogue wiring itself: the remote call is made in apply()
          // (the harness never calls it, so assert it by name), the picker reads
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

          // 7d. The card's write path, exercised rather than grepped: a control
          //     that draws but writes nothing is invisible until someone saves,
          //     which is how the route picker shipped once already. `__check` is
          //     the bundle's own buildOps/routeChoices, so what is asserted here
          //     is what a save would really send.
          const seam = mod.__check;
          check(seam && typeof seam.buildOps === 'function', 'the bundle must expose its ops builder to this check');
          check(seam && typeof seam.routeChoices === 'function', 'the bundle must expose routeChoices to this check');
          if (seam && typeof seam.buildOps === 'function') {
            const routePaths = ['replyerProvider', 'replyerModel'];
            const routeOnly = (plan) => plan.ops.filter((op) => routePaths.includes(op.path[0]));
            const written = seam.buildOps(
              { replyerProvider: 'openai', replyerModel: 'gpt-5' },
              {},
              { value: { replyerProvider: 'old', replyerModel: 'old' } },
            );
            check(
              JSON.stringify(routeOnly(written)) === JSON.stringify([
                { op: 'set', path: ['replyerProvider'], value: 'openai' },
                { op: 'set', path: ['replyerModel'], value: 'gpt-5' },
              ]),
              `a picked route must write both stored keys, got ${JSON.stringify(routeOnly(written))}`,
            );
            const followed = seam.buildOps(
              { replyerProvider: '', replyerModel: '' },
              {},
              { value: { replyerProvider: 'openai', replyerModel: 'gpt-5' } },
            );
            check(
              JSON.stringify(routeOnly(followed)) === JSON.stringify([
                { op: 'unset', path: ['replyerProvider'] },
                { op: 'unset', path: ['replyerModel'] },
              ]),
              `"follow the session default" must clear both keys, got ${JSON.stringify(routeOnly(followed))}`,
            );
            const untouched = seam.buildOps({}, {}, { value: { doubaoAccessKeyCredential: 'DOUBAO_ACCESS_KEY' } });
            check(
              !untouched.ops.some((op) => op.path[0] === 'doubaoAccessKeyCredential'),
              `a save must not touch the credential name the plugin owns, got ${JSON.stringify(untouched.ops)}`,
            );
          }
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
          //    list. The harness never lets /health answer (useEffect is a no-op,
          //    useState never updates), so the rows themselves cannot render
          //    here: assert the wiring by name, and assert separately that every
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
        } catch (err) {
          failures.push('component render threw: ' + String(err?.message ?? err));
        }
      }
    }
  }
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
