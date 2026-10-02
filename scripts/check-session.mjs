/**
 * Focused check for lib/session.js.
 *
 * The point of this script is the `{{model}}` regression: an agent created
 * without `agentOptions` and a model-selection `setup` never gets a
 * provider/model, the deployment persona's template then fails to assemble, and
 * the very first turn dies before any request is sent:
 *
 *   prompt variable "{{model}}" has no value for this assembly
 *   (section "deployment:persona-prefix")
 *
 * Nothing in the DSH UI shows that failure, so it is asserted here instead.
 *
 * Run: node scripts/check-session.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const { createSessionBridge, SOURCE_KIND } = await import(new URL('../lib/session.js', import.meta.url).href);

const warnings = [];
const logger = {
  info: () => {},
  warn: (msg) => { warnings.push(String(msg)); },
  error: () => {},
};

/** Build a host-shaped ctx whose single device is a live agent. */
function harness({ withDefaultModel = true, workspacePath } = {}) {
  const created = [];
  const inbox = [];
  const renames = [];
  const agentCtxHandlers = [];
  const attached = [];
  let live = null;
  let resumeCalls = 0;

  const agent = { session: { id: null }, followup: (message) => { inbox.push(message); } };
  const agents = {
    // The host's registry.get(id) returns the Agent, not the create handle.
    get: (id) => (live && live.agent.session.id === id ? live.agent : null),
    resume: async () => { resumeCalls += 1; throw new Error('no persisted session'); },
    create: async (options) => {
      created.push(options);
      agent.session.id = options.sessionId;
      live = { agent, dispose: async () => {} };
      return live;
    },
  };
  const ctx = {
    get(name) {
      if (name === 'agents') return agents;
      if (name === 'agentDefaultModel') {
        return withDefaultModel ? { currentSelection: () => ({ provider: 'stub-provider', model: 'stub-model' }) } : undefined;
      }
      if (name === 'sessionTitle') return { rename: (session, label) => { renames.push({ id: session?.id, label }); } };
      if (name === 'workspaceRegistry' && workspacePath !== undefined) {
        const entry = {
          path: workspacePath,
          attachSession: async (sessionId) => { attached.push({ path: workspacePath, sessionId }); },
        };
        return {
          list: () => [entry],
          // Async on the host (it canonicalizes the path first): a fake that
          // answers synchronously would hide a missing `await`.
          resolveByPath: async (path) => (path === workspacePath ? entry : undefined),
        };
      }
      return undefined;
    },
    on: () => () => {},
  };
  return {
    ctx, created, inbox, renames, agentCtxHandlers, attached,
    get live() { return live; },
    get resumeCalls() { return resumeCalls; },
  };
}

const dataDir = mkdtempSync(join(tmpdir(), 'xiaoai-session-check-'));
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${err?.message ?? err}`);
  }
}

// --- case 1: a normal host with a default model selection -------------------
console.log('case 1: host with a default model selection');
const h1 = harness();
const bridge1 = createSessionBridge({ ctx: h1.ctx, getConfig: () => ({}), dataDir, logger });
const result1 = await bridge1.deliver({ host: '192.168.1.191', name: '小爱音箱', text: '你好' });

check('deliver reports success', () => {
  assert.equal(result1.ok, true);
  assert.equal(result1.deviceKey, '192.168.1.191');
  assert.match(result1.sessionId, /^session-/);
});
check('agent is created with agentOptions provider/model', () => {
  assert.equal(h1.created.length, 1);
  assert.deepEqual(h1.created[0].agentOptions, { provider: 'stub-provider', model: 'stub-model' });
});
check('agent is created with a setup hook', () => {
  assert.equal(typeof h1.created[0].setup, 'function');
});
// DSH refuses to serve a session whose header has no `cwd` (the GUI then shows
// "历史加载失败"), and the deployment persona's `{{cwd}}` variable has no value.
// Both symptoms come from an empty `meta.cwd`, so it must never be empty.
check('agent is created with an absolute working directory', () => {
  const cwd = h1.created[0].meta?.cwd;
  assert.equal(typeof cwd, 'string');
  assert.ok(cwd.length > 0, 'meta.cwd was empty');
  assert.ok(isAbsolute(cwd), `meta.cwd is not absolute: ${cwd}`);
});
const setupHandlers = [];
h1.created[0].setup({ on: (event, handler) => { setupHandlers.push([event, handler]); return () => {}; } });
const assemblyListener = setupHandlers.find(([event]) => event === 'system-prompt/assemble');
const assembled = await assemblyListener[1](undefined, undefined, async () => ({ variables: {} }));
check('setup registers a system-prompt/assemble listener', () => {
  assert.ok(assemblyListener, 'no system-prompt/assemble listener was registered');
});
check('that listener injects provider/model so {{model}} renders', () => {
  assert.deepEqual(assembled.variables, { provider: 'stub-provider', model: 'stub-model' });
});
check('message carries the block content and the owned source kind', () => {
  assert.equal(h1.inbox.length, 1);
  const message = h1.inbox[0];
  assert.equal(message.role, 'user');
  assert.equal(SOURCE_KIND, 'plugin:dsh-xiaoai-bridge');
  assert.equal(message.source.kind, SOURCE_KIND);
  assert.deepEqual(message.content, [{ type: 'text', text: '你好' }]);
});
// The store is written on a 300 ms debounce, so let it land before asserting.
await new Promise((resolve) => { setTimeout(resolve, 400); });
check('device store records the session id', () => {
  const stored = JSON.parse(readFileSync(join(dataDir, 'devices.json'), 'utf8'));
  assert.equal(stored.version, 2);
  assert.equal(stored.devices.length, 1);
  assert.equal(stored.devices[0].sessionId, result1.sessionId);
  assert.equal(stored.devices[0].name, '小爱音箱');
});
const result1b = await bridge1.deliver({ host: '192.168.1.191', name: '小爱音箱', text: '再来一句' });
check('second utterance reuses the live agent instead of recreating it', () => {
  assert.equal(result1b.ok, true);
  assert.equal(h1.created.length, 1);
});
check('both utterances landed in the inbox', () => { assert.equal(h1.inbox.length, 2); });
// The bridge only learns the speaker's name from the plugin environment, which
// can arrive a turn later than session creation; the IP-only title must heal.
check('the device label titles the session', () => {
  assert.deepEqual(h1.renames, [{ id: result1.sessionId, label: '小爱音箱' }]);
});
check('a repeat delivery does not re-title', () => { assert.equal(h1.renames.length, 1); });

// --- case 2: a host without a default model selection -----------------------
console.log('case 2: host without a default model selection');
const h2 = harness({ withDefaultModel: false });
const bridge2 = createSessionBridge({ ctx: h2.ctx, getConfig: () => ({}), dataDir, logger });
const result2 = await bridge2.deliver({ host: '192.168.1.192', text: '你好' });
check('delivery still succeeds', () => { assert.equal(result2.ok, true); });
check('no agentOptions are invented', () => {
  assert.equal('agentOptions' in h2.created[0], false);
  assert.equal('setup' in h2.created[0], false);
});
check('a warning names the downgrade', () => {
  assert.ok(warnings.some((line) => line.includes('no default model selection')), warnings.join(' | '));
});

// --- case 3: empty text is rejected before touching the agent ---------------
console.log('case 3: empty text');
const h3 = harness();
const bridge3 = createSessionBridge({ ctx: h3.ctx, getConfig: () => ({}), dataDir, logger });
const result3 = await bridge3.deliver({ host: '192.168.1.191', text: '   ' });
check('empty text is refused', () => {
  assert.equal(result3.ok, false);
  assert.equal(h3.created.length, 0);
});

// --- case 4: a version 1 store points at a cwd-less session -----------------
// Such a session is on disk and valid, but the host's session controller
// refuses to serve it (`session/not-found`), so the old link must not be reused.
console.log('case 4: legacy device store');
const legacyDir = mkdtempSync(join(tmpdir(), 'xiaoai-session-legacy-'));
const legacySessionId = 'session-95b1abb2-f868-43a3-8ead-a3651adc44dd';
writeFileSync(join(legacyDir, 'devices.json'), `${JSON.stringify({
  version: 1,
  devices: [{
    key: '192.168.1.191',
    host: '192.168.1.191',
    name: '小爱音箱',
    sessionId: legacySessionId,
    utterances: 5,
    createdAt: 1,
    updatedAt: 2,
  }],
}, null, 2)}\n`, 'utf8');
const h4 = harness();
const bridge4 = createSessionBridge({ ctx: h4.ctx, getConfig: () => ({}), dataDir: legacyDir, logger });
const result4 = await bridge4.deliver({ host: '192.168.1.191', name: '小爱音箱', text: '你好' });
check('a legacy session id is retired instead of resumed', () => {
  assert.equal(result4.ok, true);
  assert.notEqual(result4.sessionId, legacySessionId);
  assert.match(result4.sessionId, /^session-/);
  assert.equal(h4.resumeCalls, 0);
  assert.equal(h4.created.length, 1);
});
await new Promise((resolve) => { setTimeout(resolve, 400); });
check('the upgraded store is written back as version 2', () => {
  const stored = JSON.parse(readFileSync(join(legacyDir, 'devices.json'), 'utf8'));
  assert.equal(stored.version, 2);
  assert.equal(stored.devices[0].sessionId, result4.sessionId);
});
check('a legacy record keeps its utterance count and name', () => {
  const stored = JSON.parse(readFileSync(join(legacyDir, 'devices.json'), 'utf8'));
  assert.equal(stored.devices[0].name, '小爱音箱');
  assert.equal(stored.devices[0].utterances, 6);
});

// --- case 5: the working directory falls back to a host workspace -----------
console.log('case 5: workspace directory fallback');
const workspaceDir = mkdtempSync(join(tmpdir(), 'xiaoai-session-workspace-'));
const h5 = harness({ workspacePath: workspaceDir });
const bridge5 = createSessionBridge({ ctx: h5.ctx, getConfig: () => ({}), dataDir, logger });
await bridge5.deliver({ host: '192.168.1.193', text: '你好' });
check('an unconfigured sessionCwd uses the host workspace', () => {
  assert.equal(h5.created[0].meta.cwd, workspaceDir);
});
// A sidebar group is a workspace plus the sessions explicitly attached to it:
// the host never infers membership from cwd, and it refuses to attach a session
// whose cwd is not exactly the workspace path.
check('a session created in a workspace directory is attached to it', () => {
  assert.deepEqual(h5.attached, [{ path: workspaceDir, sessionId: h5.created[0].sessionId }]);
});

// --- case 6: an explicit sessionCwd wins over the host workspace ------------
console.log('case 6: configured sessionCwd');
const configuredDir = mkdtempSync(join(tmpdir(), 'xiaoai-session-configured-'));
const h6 = harness({ workspacePath: workspaceDir });
const bridge6 = createSessionBridge({
  ctx: h6.ctx,
  getConfig: () => ({ sessionCwd: configuredDir }),
  dataDir,
  logger,
});
await bridge6.deliver({ host: '192.168.1.194', text: '你好' });
check('the configured sessionCwd is used verbatim', () => {
  assert.equal(h6.created[0].meta.cwd, configuredDir);
});
// Sub-directory of the workspace, or a directory nobody registered: the host
// would refuse the attach, so the plugin does not even try.
check('a session outside every workspace stays ungrouped', () => {
  assert.deepEqual(h6.attached, []);
});

// --- case 7: a relative sessionCwd is refused, not passed through -----------
console.log('case 7: relative sessionCwd');
const h7 = harness({ workspacePath: workspaceDir });
const bridge7 = createSessionBridge({
  ctx: h7.ctx,
  getConfig: () => ({ sessionCwd: 'relative/path' }),
  dataDir,
  logger,
});
await bridge7.deliver({ host: '192.168.1.195', text: '你好' });
check('a relative sessionCwd falls back instead of being handed to the host', () => {
  assert.equal(h7.created[0].meta.cwd, workspaceDir);
  assert.ok(warnings.some((line) => line.includes('sessionCwd must be an absolute path')), warnings.join(' | '));
});

await bridge1.dispose();
await bridge2.dispose();
await bridge3.dispose();
await bridge4.dispose();
await bridge5.dispose();
await bridge6.dispose();
await bridge7.dispose();
rmSync(dataDir, { recursive: true, force: true });
rmSync(legacyDir, { recursive: true, force: true });
rmSync(workspaceDir, { recursive: true, force: true });
rmSync(configuredDir, { recursive: true, force: true });

console.log(failures === 0 ? '\nsession check OK' : `\nsession check FAILED (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
