// Dev-only: render lib/client.js with the check-client stubs and print the
// resulting page outline (folds, hidden fields, control kinds) so the rework
// can be reviewed without restarting DSH.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(REPO + '/lib/client.js', 'utf8');

let captured = null;
const sandbox = {
  console,
  window: { __ModuleLoader__: { load(spec) { captured = spec; } } },
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'lib/client.js' });

const element = (type, props) => ({ type, props: props ?? {} });
const primitives = {
  SettingsForm: function SettingsForm(props) { return element('div', { children: props.children }); },
  SettingsValueField: function SettingsValueField(props) { return element('ValueField', { children: props.label }); },
  SettingsSecretField: function SettingsSecretField(props) { return element('SecretField', { children: props.label }); },
  Switch: function Switch(props) { return element('Switch', { children: props.label }); },
  SegmentedControl: function SegmentedControl(props) { return element('SegmentedControl', { children: props.label }); },
  Tag: function Tag(props) { return element('span', { children: props.children }); },
  DisclosureRow: function DisclosureRow(props) {
    return element('div', {
      children: props.open ? [props.title, props.children] : [props.title, '  (collapsed)'],
    });
  },
};
const shim = (spec) => {
  if (spec === 'react') {
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
  if (spec === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: Symbol('Fragment') };
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error('unexpected require ' + spec);
};

const mod = captured.factory(shim);
const registrations = [];
mod.apply({
  slots: { inject: (n, cb) => cb(), register: (o, c) => { registrations.push({ o, c }); return () => {}; } },
  locale: { register: () => {}, bind: (ns) => (key) => key },
  effect: (fn) => fn(),
});

const Component = registrations[0].c;
const tree = Component({ view: 'page' });

const skip = new Set(['span', 'p', 'option', 'button', 'h3', 'h4']);
function walk(node, depth) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') return;
  if (Array.isArray(node)) { for (const child of node) walk(child, depth); return; }
  if (typeof node !== 'object' || !node.props) return;
  const pad = '  '.repeat(depth);
  if (typeof node.type === 'function') {
    const name = node.type.name;
    if (name === 'Fold') {
      console.log(`${pad}[fold] ${node.props.title}  open=${node.props.open}`);
      return walk(node.type(node.props), depth + 1);
    }
    if (name === 'FieldShell') {
      console.log(`${pad}- ${node.props.label}${node.props.hidden ? '  [HIDDEN]' : ''}`);
      return;
    }
    return walk(node.type(node.props), depth);
  }
  const hidden = node.props.style && node.props.style.display === 'none';
  if (node.type === 'select') { console.log(`${pad}- <select id=${node.props.id}>`); return; }
  if (node.type === 'textarea') { console.log(`${pad}- <textarea>`); return; }
  if (typeof node.type === 'string' && skip.has(node.type)) {
    if (hidden) console.log(`${pad}[hidden wrapper]`);
    return walk(node.props.children, depth);
  }
  if (typeof node.type === 'string' && node.type !== 'div') {
    console.log(`${pad}[${node.type}]${hidden ? '  [HIDDEN]' : ''} ${typeof node.props.children === 'string' ? node.props.children : ''}`);
    return;
  }
  if (typeof node.type === 'string' && node.type === 'div' && hidden) {
    console.log(`${pad}[hidden wrapper]`);
    return walk(node.props.children, depth + 1);
  }
  walk(node.props.children, depth);
}
walk(tree, 0);
