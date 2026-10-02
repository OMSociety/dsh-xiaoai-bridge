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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createSessionBridge, SOURCE_KIND } = await import(new URL('../lib/session.js', import.meta.url).href);

const warnings = [];
const logger = {
  info: () => {},
  warn: (msg) => { warnings.push(String(msg)); },
  error: () => {},
};

/** Build a host-shaped ctx whose single device is a live agent. */
function harness({ withDefaultModel = true } = {}) {
  const created = [];
  const inbox = [];
  const agentCtxHandlers = [];
  let live = null;

  const agent = { session: { id: null }, followup: (message) => { inbox.push(message); } };
  const agents = {
    // The host's registry.get(id) returns the Agent, not the create handle.
    get: (id) => (live && live.agent.session.id === id ? live.agent : null),
    resume: async () => { throw new Error('no persisted session'); },
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
      return undefined;
    },
    on: () => () => {},
  };
  return { ctx, created, inbox, agentCtxHandlers, get live() { return live; } };
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

await bridge1.dispose();
await bridge2.dispose();
await bridge3.dispose();
rmSync(dataDir, { recursive: true, force: true });

console.log(failures === 0 ? '\nsession check OK' : `\nsession check FAILED (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
