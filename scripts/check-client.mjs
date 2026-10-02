/**
 * Structural check for the hand-authored browser half (`lib/client.js`).
 *
 * The client half is a committed build artifact in DSH's module-loader format,
 * so there is no bundler to catch mistakes. This script evaluates the bundle in
 * a sandbox with stubbed `react` / `react/jsx-runtime`, then asserts that the
 * module id matches the package name, that the plugin exports `apply`/`inject`,
 * and that applying it registers the expected settings tab. It also renders the
 * tab once with stubbed hooks to prove the component tree builds.
 *
 * Run: node scripts/check-client.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT_FILE = join(PACKAGE_ROOT, 'lib', 'client.js');
const MANIFEST_FILE = join(PACKAGE_ROOT, 'package.json');

const EXPECTED_TAB = Object.freeze({ name: 'settings.plugins.tab', id: 'xiaoai', label: '小爱音箱' });

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

  // 2. The factory only needs react and react/jsx-runtime; anything else means
  //    the bundle grew a dependency the manifest does not declare.
  const requested = [];
  const element = (type, props, key) => ({ type, props: props ?? {}, key: key ?? null });
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
    throw new Error('unexpected require(' + JSON.stringify(specifier) + ')');
  };

  let mod = null;
  if (typeof captured.factory === 'function') {
    try {
      mod = captured.factory(shim);
    } catch (err) {
      failures.push('factory threw: ' + String(err?.message ?? err));
    }
  }
  check(
    requested.every((s) => s === 'react' || s === 'react/jsx-runtime'),
    'factory required undeclared modules: ' + JSON.stringify(requested),
  );

  if (mod) {
    check(typeof mod.apply === 'function', 'bundle does not export apply');
    check(Array.isArray(mod.inject), 'bundle does not export an inject array');
    check(
      Array.isArray(mod.inject) && mod.inject.includes('slots'),
      'bundle inject must include the "slots" service, got ' + JSON.stringify(mod.inject),
    );

    // 3. Applying the plugin must register the settings tab we advertise.
    const registrations = [];
    const ctx = {
      slots: {
        inject(name, callback) { callback(); return () => {}; },
        register(options, component) { registrations.push({ options, component }); return () => {}; },
      },
      effect: (fn) => fn(),
    };
    try {
      if (typeof mod.apply === 'function') mod.apply(ctx);
    } catch (err) {
      failures.push('apply threw: ' + String(err?.message ?? err));
    }

    check(registrations.length === 1, `expected exactly 1 slot registration, got ${registrations.length}`);
    const first = registrations[0];
    if (first) {
      check(first.options.name === EXPECTED_TAB.name, `slot name ${JSON.stringify(first.options.name)} != ${JSON.stringify(EXPECTED_TAB.name)}`);
      check(first.options.id === EXPECTED_TAB.id, `slot id ${JSON.stringify(first.options.id)} != ${JSON.stringify(EXPECTED_TAB.id)}`);
      check(first.options.label === EXPECTED_TAB.label, `slot label ${JSON.stringify(first.options.label)} != ${JSON.stringify(EXPECTED_TAB.label)}`);
      check(typeof first.options.order === 'number', 'slot registration needs a numeric order');
      check(typeof first.component === 'function', 'slot registration needs a component function');

      // 4. The component must build its initial (loading) tree without throwing.
      if (typeof first.component === 'function') {
        try {
          const tree = first.component();
          const text = collectText(tree);
          check(text.includes('小爱音箱'), 'tab does not render its title');
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
    if (node.props.children !== undefined) collectText(node.props.children, out);
    return out;
  }
  return out;
}

if (failures.length > 0) {
  console.error('client bundle check FAILED:');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}
console.log('client bundle check OK: id=' + pkg.name + ', tab=' + EXPECTED_TAB.id + ' (' + EXPECTED_TAB.label + ')');
