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
  const element = (type, props, key) => ({ type, props: props ?? {}, key: key ?? null });
  const seen = { forms: [], valueFields: [], switches: [], segments: [] };
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
  };
  const shim = (specifier) => {
    requested.push(specifier);
    if (specifier === 'react') {
      return {
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
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
          // lib/config.js without a client entry fails this check.
          const configFields = [
            '启用插件', '音箱名称', '音箱地址', '唤醒词', '语音识别后端', '会话工作区',
            '桥接器目录', 'Python 解释器', '随插件启动桥接器', '日志级别',
            '启用本地 API 服务', '监听地址', '监听端口', '访问令牌凭据名',
          ];
          for (const label of configFields) {
            check(page.includes(label), `page view is missing the field ${JSON.stringify(label)}`);
          }
          for (const heading of ['基本', '唤醒与语音', '桥接器进程', '本地 API 服务', '运行状态']) {
            check(page.includes(heading), `page view is missing the section ${JSON.stringify(heading)}`);
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
          check(seen.switches.length === 3, `expected 3 Switch controls, got ${seen.switches.length}`);
          for (const control of seen.switches) {
            check(typeof control.checked === 'boolean', 'a Switch has no checked value');
            check(typeof control.onChange === 'function', 'a Switch has no onChange');
          }
          check(seen.segments.length === 2, `expected 2 SegmentedControl controls, got ${seen.segments.length}`);
          for (const control of seen.segments) {
            check(Array.isArray(control.options) && control.options.length >= 2, `SegmentedControl ${control.id} needs at least 2 options`);
            check(typeof control.onChange === 'function', `SegmentedControl ${control.id} has no onChange`);
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
