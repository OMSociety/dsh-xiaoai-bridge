/**
 * Offline driver for lib/client.js.
 *
 * check-client.mjs renders the component exactly once with no-op state hooks,
 * so it cannot see anything that happens after a user gesture. This harness
 * implements real useState/useEffect/useCallback semantics for a single
 * component instance, captures the props handed to the primitive components,
 * and calls their handlers directly.
 *
 * Run from anywhere: node tools/drive-client.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const CLIENT_FILE = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const source = readFileSync(CLIENT_FILE, 'utf8');

// ---------------------------------------------------------------- react stub
let current = null;
let pending = false;
let currentComp = null;
let currentProps = null;
let renderRoot = null;
const pendingEffects = [];

let DEBUG = false;
let hookStore = [];
let renderCount = 0;

function scheduleRender() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    if (current !== null) return;
    renderOnce();
  });
}

// Mirrors check-client.mjs:347: the primitives are plain function elements, so
// calling them records the props the host would receive. Nested components get a
// hook frame of their own here (keyed by their position in the tree), because the
// client half does define nested components that call hooks (DoubaoTokenRow).
const nestedStores = new Map();

function nestedFrame(path, type) {
  let frame = nestedStores.get(path);
  if (!frame) { frame = { hooks: [], type }; nestedStores.set(path, frame); }
  if (frame.type !== type) { frame.hooks = []; frame.type = type; }
  return frame;
}

function expand(node, path = 'root') {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') return;
  if (Array.isArray(node)) { node.forEach((child, i) => expand(child, `${path}[${i}]`)); return; }
  if (typeof node === 'object' && node.props) {
    if (typeof node.type === 'function') {
      const frame = nestedFrame(`${path}/C`, node.type);
      const outer = current;
      current = { hooks: frame.hooks, index: 0 };
      let rendered;
      try { rendered = node.type(node.props); } finally { frame.hooks = current.hooks; current = outer; }
      expand(rendered, `${path}/C`);
      return;
    }
    expand(node.props.children, `${path}>`);
  }
}

function renderOnce() {
  if (renderCount > 200) throw new Error('render loop');
  renderCount += 1;
  current = { hooks: hookStore, index: 0 };
  try {
    renderRoot = currentComp(currentProps);
    hookStore = current.hooks;
  } finally {
    current = null;
  }
  expand(renderRoot);
  if (DEBUG) console.log('  render#' + renderCount + ' state=' + JSON.stringify(hookStore[0] && typeof hookStore[0].value === 'object' ? hookStore[0].value.status : String(hookStore[0]?.value)));
  return renderRoot;
}


function active() {
  if (current === null) throw new Error('hook called outside a render');
  return current;
}

function useState(initial) {
  const self = active();
  const slot = self.index;
  self.index += 1;
  if (self.hooks.length <= slot) {
    self.hooks[slot] = { value: typeof initial === 'function' ? initial() : initial, kind: 'state' };
  }
  const hook = self.hooks[slot];
  if (hook.kind !== 'state') throw new Error('hook order changed between renders');
  hook.setter = (next) => {
    const resolved = typeof next === 'function' ? next(hook.value) : next;
    if (Object.is(resolved, hook.value)) return; // React bails out on an unchanged state
    hook.value = resolved;
    scheduleRender();
  };
  return [hook.value, hook.setter];
}

let effectCount = 0;

function useEffect(fn, deps) {
  const self = active();
  const slot = self.index;
  self.index += 1;
  const previous = self.hooks[slot];
  if (previous && previous.kind === 'effect') {
    if (Array.isArray(deps) && Array.isArray(previous.deps) && deps.length === previous.deps.length
      && deps.every((value, i) => Object.is(value, previous.deps[i]))) {
      return;
    }
  }
  effectCount += 1;
  self.hooks[slot] = { kind: 'effect', deps: Array.isArray(deps) ? deps.slice() : null };
  pendingEffects.push(fn);
}

function useCallback(fn, deps) {
  const self = active();
  const slot = self.index;
  self.index += 1;
  const previous = self.hooks[slot];
  if (previous && previous.kind === 'callback' && Array.isArray(deps) && Array.isArray(previous.deps)
    && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) {
    return previous.fn;
  }
  self.hooks[slot] = { kind: 'callback', deps: Array.isArray(deps) ? deps.slice() : null, fn };
  return fn;
}

function useMemo(fn) {
  const self = active();
  const slot = self.index;
  self.index += 1;
  self.hooks[slot] = { kind: 'memo' };
  return fn();
}

function useRef(initial) {
  const self = active();
  const slot = self.index;
  self.index += 1;
  if (self.hooks.length <= slot) self.hooks[slot] = { kind: 'ref', current: initial };
  return self.hooks[slot];
}

const React = {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol('Fragment'),
};

// ------------------------------------------------------------------- capture
const created = [];

const record = (type, props, key) => {
  const el = { type, props: props ?? {}, key: key ?? null };
  created.push(el);
  return el;
};

const primitives = {
  SettingsForm: (props) => { if (DEBUG) console.log('    PRIM SettingsForm'); created.push({ type: 'SettingsForm', props, key: null }); return record('div', { children: props.children }); },
  SettingsValueField: (props) => { created.push({ type: 'SettingsValueField', props, key: null }); return record('div', { children: [props.label, props.invalid ? props.invalidLabel : props.hint] }); },
  SettingsSecretField: (props) => { created.push({ type: 'SettingsSecretField', props, key: null }); return record('div', { children: [props.label, props.hint] }); },
  Switch: (props) => { created.push({ type: 'Switch', props, key: null }); return record('div', { children: props.label }); },
  SegmentedControl: (props) => { created.push({ type: 'SegmentedControl', props, key: null }); return record('div', { children: props.label }); },
  Tag: (props) => record('span', { children: props.children }),
};

const jsxRuntime = { jsx: record, jsxs: record, Fragment: Symbol('Fragment') };

// --------------------------------------------------------------------- fetch
let descriptorFor = null;
const posts = [];
let healthFor = { ok: true, status: 200, body: { ok: true, health: null } };
let postResponse = { ok: true, revision: 99 };

const fetchStub = (url, options) => {
  const opts = options ?? {};
  if (opts.method === 'POST') {
    posts.push({ url, body: JSON.parse(opts.body) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(postResponse) });
  }
  if (String(url).includes('/health')) {
    return Promise.resolve({ ok: healthFor.ok, status: healthFor.status, json: () => Promise.resolve(healthFor.body) });
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, descriptor: descriptorFor }) });
};

// ------------------------------------------------------------- bundle loading
let captured = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (mod) => { captured = mod; } } },
  console, Symbol, Object, Array, String, Boolean, Number, JSON, Math, Error, Date, Promise,
  setTimeout, clearTimeout, queueMicrotask, fetch: fetchStub,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'lib/client.js' });

const shim = (specifier) => {
  if (specifier === 'react') return React;
  if (specifier === 'react/jsx-runtime') return jsxRuntime;
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error('unexpected require(' + JSON.stringify(specifier) + ')');
};
const mod = captured.factory(shim);

let registered = null;
let dictionaries = null;
const ctx = {
  slots: { inject: (_name, cb) => { cb(); return () => {}; }, register: (_options, component) => { registered = component; return () => {}; } },
  locale: {
    register: (_ns, copy) => { dictionaries = copy; return () => {}; },
    bind: (_ns) => (key) => dictionaries?.zh?.[key] ?? key,
  },
  effect: (fn) => fn(),
};
mod.apply(ctx);

const flush = async () => {
  effectCount = 0;
  for (let i = 0; i < 40; i += 1) {
    while (pendingEffects.length > 0) {
      const fn = pendingEffects.shift();
      fn();
    }
    effectCount = 0;
    await new Promise((resolve) => setImmediate(resolve));
    if (effectCount === 0 && pendingEffects.length === 0) break;
  }
};

const byTypeAndId = (type, id) => created.filter((e) => e.type === type && e.props && e.props.id === id);
const byType = (type) => created.filter((e) => e.type === type);
const lastByTypeAndId = (type, id) => byTypeAndId(type, id).slice(-1)[0];

// The reset button lives inside the FieldShell whose element key is the field
// key, so pick the shell first and then the first button in its own subtree.
function firstButton(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) { const found = firstButton(child); if (found) return found; }
    return null;
  }
  if (node.type === 'button' && typeof node.props?.onClick === 'function') return node;
  return firstButton(node.props?.children);
}

// Value fields (text/number/identifier) are rendered as the SettingsValueField
// primitive and carry onReset themselves; the other kinds go through FieldShell,
// whose reset control is a <button> in the shell subtree.
const resetButtonFor = (key) => {
  const valueField = lastByTypeAndId('SettingsValueField', 'xiaoai-' + key);
  if (valueField) return { props: { onClick: () => valueField.props.onReset() } };
  const shell = created
    .filter((e) => typeof e.type === 'function' && e.type.name === 'FieldShell')
    .find((e) => e.key === key);
  if (!shell) throw new Error('no reset control for ' + key);
  const button = firstButton(shell.type(shell.props));
  if (!button) throw new Error('no reset button in shell for ' + key);
  return button;
};

const literalText = () => created
  .flatMap((e) => (typeof e.props?.children === 'string' ? [e.props.children] : []))
  .join('|');

function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((child) => textOf(child, out)); return out; }
  if (typeof node === 'object') textOf(node.props?.children, out);
  return out;
}

async function scenario(setup) {
  created.length = 0;
  posts.length = 0;
  hookStore = [];
  descriptorFor = setup.descriptor;
  healthFor = setup.health ?? { ok: true, status: 200, body: { ok: true, health: null } };
  postResponse = setup.postResponse ?? { ok: true, revision: 99 };
  currentComp = registered;
  currentProps = { view: 'page' };
  renderCount = 0;
  pending = false;
  DEBUG = true;
  renderOnce();
  await flush();
  created.length = 0; // drop the loading render; keep the settled one
  renderOnce();
  DEBUG = false;
  console.log('DEBUG settle: created=' + created.length + ' vf=' + created.filter((e) => e.type === 'SettingsValueField').length + ' form=' + created.filter((e) => e.type === 'SettingsForm').length + ' switch=' + created.filter((e) => e.type === 'Switch').length);
  return setup.run();
}

// ------------------------------------------------------------------ fixtures
const baseDescriptor = {
  value: {
    wakeupTimeout: 30, wakeupReplyText: 'user-wake', sessionKey: 'agent:main:bridge',
    apiServerHost: '127.0.0.1', apiServerPort: 9092, spokenMaxChars: 300,
    enabled: true, deviceName: 'x', deviceHost: '', wakeKeywords: '', continuousConversation: false,
    autoSpeak: true, personality: '', replyStyle: '', behaviorStyle: '', outputLimits: '', voiceRuleText: '',
    bridgeDir: '', pythonPath: '', autoStart: true, silentStart: false, apiServerEnabled: false,
    apiServerTokenCredential: '', replyerProvider: '', replyerModel: '', replyerHistoryTurns: 6,
  },
  user: { wakeupReplyText: 'user-wake', wakeupTimeout: 30 },
  base: { wakeupTimeout: 30, wakeupReplyText: 'base-wake' },
  revision: 7,
};

const results = [];
const record2 = (name, ok, detail) => results.push({ name, ok, detail });

// 1. R1-5
await scenario({
  descriptor: baseDescriptor,
  async run() {
    lastByTypeAndId('SettingsValueField', 'xiaoai-wakeupTimeout').props.onEdit('abc');
    await flush();
    let field = lastByTypeAndId('SettingsValueField', 'xiaoai-wakeupTimeout');
    record2('R1-5 number field flags the text', field.props.invalid === true, `invalid=${field.props.invalid}`);
    record2('R1-5 number field names the rule', field.props.invalidLabel === '必须是一个整数。', JSON.stringify(field.props.invalidLabel));

    lastByTypeAndId('SettingsValueField', 'xiaoai-wakeupTimeout').props.onEdit('9999');
    await flush();
    field = lastByTypeAndId('SettingsValueField', 'xiaoai-wakeupTimeout');
    record2('R1-5 out-of-range names its own rule', field.props.invalidLabel === '必须是允许范围内的整数。', JSON.stringify(field.props.invalidLabel));

    lastByTypeAndId('SettingsValueField', 'xiaoai-apiServerPort').props.onEdit('70000');
    await flush();
    field = lastByTypeAndId('SettingsValueField', 'xiaoai-apiServerPort');
    record2('R1-5 port keeps port wording', field.props.invalidLabel === '端口必须是 1 到 65535 之间的整数。', JSON.stringify(field.props.invalidLabel));

    lastByTypeAndId('SettingsValueField', 'xiaoai-apiServerPort').props.onEdit('abc');
    await flush();
    field = lastByTypeAndId('SettingsValueField', 'xiaoai-apiServerPort');
    record2('R1-5 port non-numeric says integer', field.props.invalidLabel === '必须是一个整数。', JSON.stringify(field.props.invalidLabel));

    lastByTypeAndId('SettingsValueField', 'xiaoai-apiServerHost').props.onEdit('');
    await flush();
    field = lastByTypeAndId('SettingsValueField', 'xiaoai-apiServerHost');
    record2('R4-9 required host rejects blank', field.props.invalid === true && field.props.invalidLabel === '不能为空。', `invalid=${field.props.invalid} label=${JSON.stringify(field.props.invalidLabel)}`);
  },
});

// 2. R7-2-2
await scenario({
  descriptor: baseDescriptor,
  async run() {
    const buttons = created.filter((el) => el.type === 'button' && typeof el.props.onClick === 'function');
    record2('R7-2-2 reset control rendered', buttons.length >= 1, `buttons=${buttons.length}`);
    record2('R7-2-2 draft seeds the override', lastByTypeAndId('SettingsValueField', 'xiaoai-wakeupReplyText').props.text === 'user-wake',
      JSON.stringify(lastByTypeAndId('SettingsValueField', 'xiaoai-wakeupReplyText').props.text));

    resetButtonFor('wakeupReplyText').props.onClick();
    await flush();
    record2('R7-2-2 staging shows the default', lastByTypeAndId('SettingsValueField', 'xiaoai-wakeupReplyText').props.text === 'base-wake',
      JSON.stringify(lastByTypeAndId('SettingsValueField', 'xiaoai-wakeupReplyText').props.text));

    lastByTypeAndId('SettingsValueField', 'xiaoai-wakeupReplyText').props.onEdit('typed-after-reset');
    await flush();
    record2('R7-2-2 typed value visible', lastByTypeAndId('SettingsValueField', 'xiaoai-wakeupReplyText').props.text === 'typed-after-reset',
      JSON.stringify(lastByTypeAndId('SettingsValueField', 'xiaoai-wakeupReplyText').props.text));

    const form = byType('SettingsForm').slice(-1)[0];
    record2('R7-2-2 form rendered', Boolean(form), form ? 'present' : 'missing');
    if (form) form.props.onSave();
    await flush();
    record2('R7-2-2 a save request was sent', posts.length === 1, `posts=${posts.length}`);
    const ops = posts.length > 0 ? posts[0].body.ops : [];
    record2('R7-2-2 typed value not silently dropped', !ops.some((op) => op.op === 'unset' && op.path[0] === 'wakeupReplyText'), JSON.stringify(ops));
    record2('R7-2-2 typed value is written',
      ops.some((op) => op.op === 'set' && op.path[0] === 'wakeupReplyText' && op.value === 'typed-after-reset'),
      JSON.stringify(ops));
  },
});

// 3. R7-2-2 control case: staging without typing still unsets.
await scenario({
  descriptor: baseDescriptor,
  async run() {
    resetButtonFor('wakeupReplyText').props.onClick();
    await flush();
    const form = byType('SettingsForm').slice(-1)[0];
    form.props.onSave();
    await flush();
    const ops = posts.length > 0 ? posts[0].body.ops : [];
    record2('R7-2-2 untyped staged field still unsets',
      ops.some((op) => op.op === 'unset' && op.path[0] === 'wakeupReplyText'), JSON.stringify(ops));
  },
});

// 4. R4-3 / R4-9 status card
await scenario({
  descriptor: baseDescriptor,
  health: {
    ok: true,
    status: 200,
    body: {
      ok: true,
      health: {
        bridge: { running: true, pid: 1234, adopted: false, restarts: 0 },
        checks: { bridgeDirIsDirectory: true, pythonExists: true, modelsDirExists: false, skillFileExists: true },
        paths: { bridgeDir: 'D:\\b', pythonPath: 'D:\\p', modelsDir: 'D:\\m' },
        bridgeApi: null,
        spokenLogPath: 'D:\\DSH\\xiaoai-bridge\\spoken.jsonl',
        spokenLogBytes: 1536 * 1024,
        diagnostics: [
          { time: '2026-10-03T10:00:00.000Z', code: 'bridge-rejected', detail: 'auth failed', count: 3 },
          { time: '2026-10-03T09:00:00.000Z', code: 'mystery-code', detail: '', count: 1 },
          { time: '2026-10-03T08:00:00.000Z', code: 'token-not-applied', detail: 'the bridge started before the API token existed', count: 1 },
        ],
      },
    },
  },
  async run() {
    // Row() is a local function component, so its label/value never appear as
    // children text; read the props the status card handed to it.
    const joined = created.filter((e) => typeof e.type === 'function' && e.type.name === 'Row')
      .map((e) => String(e.props.label) + ' ' + String(e.props.value)).join('|');
    record2('R4-3 known code shows its copy', joined.includes('桥接器拒绝了令牌'), joined.slice(0, 400));
    record2('R4-3 repeat count is labelled', joined.includes('重复次数 3'), '');
    record2('R4-3 unknown code falls back to raw code', joined.includes('mystery-code') && !joined.includes('diagnostic.mystery-code'), '');
    record2('R4-9 checks heading renders', literalText().includes('环境自检'), '');
    record2('R4-9 failing check is visible', joined.includes('未就绪'), '');
    record2('R3-6 token-not-applied has wording', joined.includes('桥接器先于令牌启动，重启桥接器即可生效'), '');
    record2('spoken log size row renders', joined.includes('播报日志') && joined.includes('1.5 MiB / 5.0 MiB'), joined.slice(-300));
    record2('spoken log path row renders', joined.includes('日志文件') && joined.includes('spoken.jsonl'), '');
    console.log('---- status card text ----');
    console.log(joined.replace(/\|+/g, ' | '));
    console.log('--------------------------');
  },
});

// 5. R1-2: the host stored the settings but could not rewrite config.py.
await scenario({
  descriptor: baseDescriptor,
  postResponse: { ok: true, result: { applied: 1 }, config: { ok: false, error: 'EPERM: operation not permitted, rename config.py.tmp -> config.py' } },
  async run() {
    lastByTypeAndId('SettingsValueField', 'xiaoai-wakeupReplyText').props.onEdit('edited');
    await flush();
    byType('SettingsForm').slice(-1)[0].props.onSave();
    await flush();
    const text = literalText();
    record2('R1-2 render failure is not reported as saved', !text.includes('已保存。'), text.slice(0, 200));
    record2('R1-2 render failure names the bridge config', text.includes('设置没能写入桥接器配置'), '');
    record2('R1-2 render failure is not a save failure', !text.includes('保存失败，请重试。'), '');
    record2('R1-2 render failure still offers a retry', posts.length === 1, `posts=${posts.length}`);
    byType('SettingsForm').slice(-1)[0].props.onSave();
    await flush();
    record2('R1-2 retry resends the ops', posts.length === 2, `posts=${posts.length} ops=${JSON.stringify(posts[1]?.body.ops ?? [])}`);
  },
});

// 6. R1-2 control: a host that does not report the render outcome (no config field).
await scenario({
  descriptor: baseDescriptor,
  postResponse: { ok: true, revision: 99 },
  async run() {
    lastByTypeAndId('SettingsValueField', 'xiaoai-wakeupReplyText').props.onEdit('edited');
    await flush();
    byType('SettingsForm').slice(-1)[0].props.onSave();
    await flush();
    record2('R1-2 legacy response keeps the saved path', literalText().includes('已保存。'), literalText().slice(0, 160));
  },
});

// 7. R1-2 control: config.ok === true stays on the saved path.
await scenario({
  descriptor: baseDescriptor,
  postResponse: { ok: true, result: {}, config: { ok: true } },
  async run() {
    lastByTypeAndId('SettingsValueField', 'xiaoai-wakeupReplyText').props.onEdit('edited');
    await flush();
    byType('SettingsForm').slice(-1)[0].props.onSave();
    await flush();
    record2('R1-2 rendered config keeps the saved path', literalText().includes('已保存。'), literalText().slice(0, 160));
  },
});

// 8. NOTE-1: the dead secret branch is gone, not merely unreachable. The copy
// comment may still name the primitive; what must be absent is the wiring.
{
  record2('NOTE-1 no secret branch or binding left',
    !/var SettingsSecretField\s*=/.test(source)
    && !/jsx\(SettingsSecretField/.test(source)
    && !/kind === "secret"/.test(source), '');
}
// 9. Chinese/English copy parity: no tool guards this in check-client.
{
  const zhKeys = Object.keys(dictionaries?.zh ?? {}).sort();
  const enKeys = Object.keys(dictionaries?.en ?? {}).sort();
  record2('zh/en copy tables cover the same keys', zhKeys.length > 0 && JSON.stringify(zhKeys) === JSON.stringify(enKeys),
    `zh=${zhKeys.length} en=${enKeys.length} zhOnly=${JSON.stringify(zhKeys.filter((k) => !enKeys.includes(k)))} enOnly=${JSON.stringify(enKeys.filter((k) => !zhKeys.includes(k)))}`);
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
