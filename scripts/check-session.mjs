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
const { createExposure, SCOPE_UNAVAILABLE_CODE, SCOPE_FAILED_CODE } = await import(
  new URL('../lib/exposure.js', import.meta.url).href
);

const warnings = [];
const logger = {
  info: () => {},
  warn: (msg) => { warnings.push(String(msg)); },
  error: () => {},
};

/** Build a host-shaped ctx whose single device is a live agent. */
function harness({ withDefaultModel = true, workspacePath, presetRegistry, resumable = false, archivedSessionIds } = {}) {
  const created = [];
  const inbox = [];
  const renames = [];
  const agentCtxHandlers = [];
  const attached = [];
  const resumed = [];
  let live = null;
  let resumeCalls = 0;

  // A real Agent carries its own `ctx`; the bridge hands that context to the
  // scope hook so an agent that is already running still gets its registration.
  const agentCtx = { on: () => () => {} };
  const agent = { session: { id: null }, ctx: agentCtx, followup: (message) => { inbox.push(message); } };
  const agents = {
    // The host's registry.get(id) returns the Agent, not the create handle.
    get: (id) => (live && live.agent.session.id === id ? live.agent : null),
    resume: async (options) => {
      resumeCalls += 1;
      if (!resumable) throw new Error('no persisted session');
      resumed.push(options);
      agent.session.id = options.resumeSessionId;
      live = { agent, dispose: async () => {} };
      return live;
    },
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
      if (name === 'agentPresets') return presetRegistry;
      if (name === 'agentDefaultModel') {
        return withDefaultModel ? { currentSelection: () => ({ provider: 'stub-provider', model: 'stub-model' }) } : undefined;
      }
      if (name === 'sessionTitle') return { rename: (session, label) => { renames.push({ id: session?.id, label }); } };
      if (name === 'workspaceRegistry' && (workspacePath !== undefined || archivedSessionIds !== undefined)) {
        const entry = {
          path: workspacePath,
          attachSession: async (sessionId) => { attached.push({ path: workspacePath, sessionId }); },
        };
        return {
          list: () => (workspacePath === undefined ? [] : [entry]),
          // Async on the host (it canonicalizes the path first): a fake that
          // answers synchronously would hide a missing `await`.
          resolveByPath: async (path) => (path === workspacePath ? entry : undefined),
          // A live getter on the host, not a snapshot: the plugin must read it
          // at reuse time, because the user can archive a conversation while the
          // plugin is running.
          archivedSessionIds: archivedSessionIds ?? [],
        };
      }
      return undefined;
    },
    on: () => () => {},
  };
  return {
    ctx, created, inbox, renames, agent, agentCtx, agentCtxHandlers, attached, resumed,
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

// --- case 8: the project groups the settings page offers --------------------
// The page lists these instead of accepting a typed path, because the host
// groups a session only when its cwd is exactly a workspace path.
console.log('case 8: project groups for the settings page');
function bridgeWithRegistry(registry) {
  const ctx = {
    get(name) {
      return name === 'workspaceRegistry' ? registry : undefined;
    },
    on: () => () => {},
  };
  return createSessionBridge({ ctx, getConfig: () => ({}), dataDir, logger });
}

check('the registry rows are reduced to id/path/title', () => {
  const bridge = bridgeWithRegistry({
    list: () => [
      { id: 'w1', path: 'D:\\WorkSpace', title: 'WorkSpace' },
      { id: 'w2', path: '  D:\\Other  ', title: '   ' },
      { id: 'w3', path: '   ', title: 'no path at all' },
      { id: 'w4' },
      null,
      'not a row',
    ],
  });
  assert.deepEqual(bridge.workspaceGroups(), [
    { id: 'w1', path: 'D:\\WorkSpace', title: 'WorkSpace' },
    { id: 'w2', path: 'D:\\Other', title: '' },
  ]);
});

check('a host without a workspace registry offers no groups', () => {
  assert.deepEqual(bridgeWithRegistry(undefined).workspaceGroups(), []);
});

check('a registry that throws does not break the settings page', () => {
  const bridge = bridgeWithRegistry({
    list: () => {
      throw new Error('registry is not ready');
    },
  });
  assert.deepEqual(bridge.workspaceGroups(), []);
});

// --- case 9: the speaker agent's own scope carries the registration ---------
// A voice conversation and a desktop chat share one tool registry, so the tool
// belongs in the speaker agent's layer, which the bridge reaches through the
// agent setup hook. Both the create path and the reused-agent path must announce
// that context.
console.log('case 9: agent scope hook');
const h9 = harness();
const scoped9 = [];
const bridge9 = createSessionBridge({
  ctx: h9.ctx,
  getConfig: () => ({}),
  dataDir,
  logger,
  onAgentScope: (agentCtx, agent) => { scoped9.push({ agentCtx, agent }); },
});
await bridge9.deliver({ host: '192.168.1.196', text: '你好' });
check('a freshly created agent is announced to the scope hook', () => {
  assert.equal(scoped9.length, 1);
  assert.equal(scoped9[0].agentCtx, h9.agentCtx);
});
const setup9 = [];
const joinCtx = { on: (event, handler) => { setup9.push([event, handler]); return () => {}; } };
// `setup` is async because a preset mount is awaited in it (lib/session.js), so
// the hook is awaited here the way the host awaits it.
await h9.created[0].setup(joinCtx);
check('setup hands the agent context to the scope hook', () => {
  assert.equal(scoped9.length, 2);
  assert.equal(scoped9[1].agentCtx, joinCtx);
});
check('adding the scope hook keeps the model listener', () => {
  assert.ok(
    setup9.some(([event]) => event === 'system-prompt/assemble'),
    setup9.map(([event]) => event).join(' | '),
  );
});
await bridge9.deliver({ host: '192.168.1.196', text: '再来一句' });
check('a reused live agent is announced again', () => {
  assert.equal(h9.created.length, 1);
  assert.equal(scoped9.length, 3, `scope hook ran ${scoped9.length} times`);
  assert.equal(scoped9[2].agentCtx, h9.agentCtx);
});

// The scope hook must not depend on the model-selection seam: a host that
// offers no default model is exactly where a dropped registration would hide.
console.log('case 9b: no default model, scope hook still installed');
const h9b = harness({ withDefaultModel: false });
const scoped9b = [];
const bridge9b = createSessionBridge({
  ctx: h9b.ctx,
  getConfig: () => ({}),
  dataDir,
  logger,
  onAgentScope: (agentCtx) => { scoped9b.push(agentCtx); },
});
await bridge9b.deliver({ host: '192.168.1.197', text: '你好' });
check('the setup hook survives the missing model selection', () => {
  assert.equal(typeof h9b.created[0].setup, 'function');
  assert.equal('agentOptions' in h9b.created[0], false);
});
const probe = { on: () => () => {} };
await h9b.created[0].setup(probe);
check('the scope hook ran for the model-less host', () => {
  assert.ok(scoped9b.includes(probe), 'the scope hook was not called');
});

// --- case 10: the exposure manager itself -----------------------------------
// The host decides which layer a registration lands in from the *calling*
// context, so this is unit-tested with a plugin context and an agent context
// that both record what they are asked to register.
console.log('case 10: exposure manager');
function exposureHarness({ speakFromAnySession = false, seam = true, failRegister = false } = {}) {
  const globals = [];
  const env = { scoped: [], notes: [], warnings: [] };
  let config = { speakFromAnySession };
  const sink = (target) => ({
    register: (definition) => {
      if (failRegister) throw new Error('registry refused');
      const entry = { name: definition.name };
      target.push(entry);
      return () => {
        const at = target.indexOf(entry);
        if (at >= 0) target.splice(at, 1);
      };
    },
  });
  const exposure = createExposure({
    ctx: { tools: sink(globals), skills: sink(globals) },
    getConfig: () => config,
    logger: { info: () => {}, warn: (line) => { env.warnings.push(String(line)); } },
    diagnostics: { note: (entry) => { env.notes.push(entry); } },
    tool: () => ({ name: 'xiaoai_speak' }),
    skill: () => ({ name: 'xiaoai-speak' }),
  });
  env.exposure = exposure;
  env.globals = globals;
  env.agentCtx = seam ? { tools: sink(env.scoped), skills: sink(env.scoped) } : { on: () => () => {} };
  env.otherCtx = seam ? { tools: sink(env.scoped), skills: sink(env.scoped) } : { on: () => () => {} };
  env.setConfig = (next) => { config = next; };
  env.codes = () => env.notes.map((entry) => entry.code);
  env.names = () => env.scoped.map((row) => row.name).sort();
  return env;
}

const e1 = exposureHarness();
e1.exposure.attach(e1.agentCtx);
check('a scoped host registers both entries in the agent layer', () => {
  assert.deepEqual(e1.names(), ['xiaoai-speak', 'xiaoai_speak']);
  assert.deepEqual(e1.globals, []);
  assert.equal(e1.exposure.state().mode, 'scoped');
  assert.equal(e1.exposure.state().scoped, 1);
  assert.equal(e1.exposure.state().scopeSeam, true);
});
e1.exposure.attach(e1.agentCtx);
check('the same agent context is never registered twice', () => {
  assert.equal(e1.scoped.length, 2);
  assert.equal(e1.exposure.state().scoped, 1);
});
e1.exposure.attach(e1.otherCtx);
check('a second agent gets its own registration', () => {
  assert.equal(e1.scoped.length, 4);
  assert.equal(e1.exposure.state().scoped, 2);
});

const e2 = exposureHarness({ seam: false });
e2.exposure.attach(e2.agentCtx);
check('a host without the seam is reported instead of silently going global', () => {
  assert.deepEqual(e2.globals, []);
  assert.deepEqual(e2.scoped, []);
  assert.equal(e2.exposure.state().mode, 'unavailable');
  assert.equal(e2.exposure.state().scopeSeam, false);
  assert.deepEqual(e2.codes(), [SCOPE_UNAVAILABLE_CODE]);
  assert.ok(e2.warnings.some((line) => line.includes('cannot scope a registration')), e2.warnings.join(' | '));
});
e2.exposure.attach(e2.otherCtx);
check('the missing-seam notice is reported once, not per session', () => {
  assert.deepEqual(e2.codes(), [SCOPE_UNAVAILABLE_CODE]);
});

const e3 = exposureHarness({ speakFromAnySession: true });
e3.exposure.attach(e3.agentCtx);
e3.exposure.syncGlobal();
check('the escape hatch registers both entries globally', () => {
  assert.deepEqual(e3.globals.map((row) => row.name).sort(), ['xiaoai-speak', 'xiaoai_speak']);
  assert.equal(e3.exposure.state().mode, 'global');
});
e3.setConfig({ speakFromAnySession: false });
e3.exposure.syncGlobal();
check('turning the hatch off drops the global entries only', () => {
  assert.deepEqual(e3.globals, []);
  assert.deepEqual(e3.names(), ['xiaoai-speak', 'xiaoai_speak']);
  assert.equal(e3.exposure.state().mode, 'scoped');
});
e3.setConfig({ speakFromAnySession: true });
e3.exposure.syncGlobal();
check('the hatch reopens without tripping over a duplicate name', () => {
  assert.equal(e3.globals.length, 2);
});
e3.exposure.dispose();
check('dispose leaves the global layer', () => {
  assert.deepEqual(e3.globals, []);
});

const e4 = exposureHarness({ speakFromAnySession: true, seam: false });
e4.exposure.syncGlobal();
e4.exposure.attach(e4.agentCtx);
check('with the hatch open a missing seam is not reported', () => {
  assert.equal(e4.globals.length, 2);
  assert.deepEqual(e4.notes, []);
  assert.deepEqual(e4.warnings, []);
});

const e5 = exposureHarness({ failRegister: true });
e5.exposure.attach(e5.agentCtx);
check('a refusing registry is reported and never thrown', () => {
  assert.deepEqual(e5.scoped, []);
  assert.deepEqual(e5.codes(), [SCOPE_FAILED_CODE]);
});
const e6 = exposureHarness();
e6.setConfig({ speakFromAnySession: 'yes' });
e6.exposure.syncGlobal();
check('only an explicit true opens the escape hatch', () => {
  assert.deepEqual(e6.globals, []);
  assert.equal(e6.exposure.state().mode, 'scoped');
});

// --- case 11: the Agent preset ----------------------------------------------
// The speaker conversation can be composed from a host preset (this repository's
// own bundle declares one, 「小爱模式」). Two halves have to hold: the session is
// really created and bound inside the preset, and a preset that is not there
// degrades to the host default instead of costing the utterance.
console.log('case 11: agent preset');
const presetDir = mkdtempSync(join(tmpdir(), 'xiaoai-preset-check-'));

/** A preset registry shaped like the host's; records what it is asked to do. */
function presetRegistry({ behavior = 'ok' } = {}) {
  const mounts = [];
  const leases = [];
  return {
    mounts,
    leases,
    registry: {
      resolve: async (id) => {
        if (behavior === 'missing') throw new Error(`unknown agent preset "${id}"`);
        if (behavior === 'broken') return { id, broken: { message: 'row 3 has no bundle' } };
        return { id };
      },
      acquireScope: async (id) => ({ id, [Symbol.asyncDispose]: async () => { leases.push(id); } }),
      mount: async (agentCtx, id) => { mounts.push({ agentCtx, id }); },
    },
  };
}

// 11a: a working preset — header, mount, lease, and what /health reports.
const notes11 = [];
const r11 = presetRegistry();
const h11 = harness({ presetRegistry: r11.registry });
const bridge11 = createSessionBridge({
  ctx: h11.ctx,
  getConfig: () => ({ agentPreset: 'xiaoai' }),
  dataDir: presetDir,
  logger,
  diagnostics: { note: (entry) => { notes11.push(entry); } },
});
await bridge11.deliver({ host: '192.168.1.198', text: '你好' });
check('the conversation is created inside the configured preset', () => {
  assert.equal(h11.created.length, 1);
  assert.equal(h11.created[0].meta.agentPreset, 'xiaoai');
  assert.ok(typeof h11.created[0].meta.cwd === 'string' && h11.created[0].meta.cwd.length > 0);
});
await h11.created[0].setup(h11.agentCtx, h11.agent);
check('the preset is mounted onto the agent scope', () => {
  assert.deepEqual(r11.mounts, [{ agentCtx: h11.agentCtx, id: 'xiaoai' }]);
});
check('the revision lease is released once the agent exists', () => {
  assert.deepEqual(r11.leases, ['xiaoai']);
});
check('health reports what the preset resolved to', () => {
  assert.deepEqual(bridge11.presetState(), { configured: 'xiaoai', resolved: 'xiaoai', reason: null });
});
check('a preset that works reports no diagnostic', () => {
  assert.deepEqual(notes11, []);
});
await h11.created[0].setup(h11.agentCtx, h11.agent);
check('the same agent is never mounted twice', () => {
  assert.equal(r11.mounts.length, 1);
});

// 11b: not installed — the session is still created, on the host default.
const notes11b = [];
const r11b = presetRegistry({ behavior: 'missing' });
const h11b = harness({ presetRegistry: r11b.registry });
const bridge11b = createSessionBridge({
  ctx: h11b.ctx,
  getConfig: () => ({ agentPreset: 'xiaoai' }),
  dataDir: presetDir,
  logger,
  diagnostics: { note: (entry) => { notes11b.push(entry); } },
});
await bridge11b.deliver({ host: '192.168.1.199', text: '你好' });
check('a missing preset still creates a session, without a preset header', () => {
  assert.equal(h11b.created.length, 1);
  assert.equal('agentPreset' in h11b.created[0].meta, false);
  assert.deepEqual(h11b.created[0].agentOptions, { provider: 'stub-provider', model: 'stub-model' });
});
check('a missing preset is reported once, as a warning', () => {
  assert.equal(notes11b.length, 1);
  assert.equal(notes11b[0].code, 'agent-preset-missing');
  assert.equal(notes11b[0].level, 'warn');
  assert.match(notes11b[0].detail, /"xiaoai" is not installed/);
});
check('health says why the preset did not apply', () => {
  assert.deepEqual(bridge11b.presetState(), { configured: 'xiaoai', resolved: null, reason: 'missing' });
});

// 11c: declared but broken — the same soft landing, its own code.
const notes11c = [];
const r11c = presetRegistry({ behavior: 'broken' });
const h11c = harness({ presetRegistry: r11c.registry });
const bridge11c = createSessionBridge({
  ctx: h11c.ctx,
  getConfig: () => ({ agentPreset: 'xiaoai' }),
  dataDir: presetDir,
  logger,
  diagnostics: { note: (entry) => { notes11c.push(entry); } },
});
await bridge11c.deliver({ host: '192.168.1.201', text: '你好' });
check('a broken preset falls back with its own diagnostic', () => {
  assert.equal('agentPreset' in h11c.created[0].meta, false);
  assert.deepEqual(notes11c.map((entry) => entry.code), ['agent-preset-broken']);
  assert.match(notes11c[0].detail, /row 3 has no bundle/);
  assert.deepEqual(bridge11c.presetState(), { configured: 'xiaoai', resolved: null, reason: 'broken' });
});

// 11d: a host that keeps no preset registry at all.
const notes11d = [];
const h11d = harness();
const bridge11d = createSessionBridge({
  ctx: h11d.ctx,
  getConfig: () => ({ agentPreset: 'xiaoai' }),
  dataDir: presetDir,
  logger,
  diagnostics: { note: (entry) => { notes11d.push(entry); } },
});
await bridge11d.deliver({ host: '192.168.1.202', text: '你好' });
check('a host without a preset registry is reported, not diagnosed', () => {
  assert.deepEqual(notes11d, []);
  assert.deepEqual(bridge11d.presetState(), { configured: 'xiaoai', resolved: null, reason: 'no-registry' });
});

// 11e: an empty setting never touches the registry.
const r11e = presetRegistry();
const h11e = harness({ presetRegistry: r11e.registry });
const bridge11e = createSessionBridge({
  ctx: h11e.ctx,
  getConfig: () => ({ agentPreset: '   ' }),
  dataDir: presetDir,
  logger,
});
await bridge11e.deliver({ host: '192.168.1.203', text: '你好' });
check('an empty preset name keeps the host default and says nothing', () => {
  assert.equal('agentPreset' in h11e.created[0].meta, false);
  assert.equal(bridge11e.presetState(), null);
});

// 11f: resume attaches the preset too. `ResumeAgentOptions` carries no `meta`,
// so `setup` is the only place a resumed conversation can get its composition.
const resumeHost = '192.168.1.204';
writeFileSync(join(presetDir, 'devices.json'), JSON.stringify({
  version: 2,
  devices: [{
    key: resumeHost,
    host: resumeHost,
    sessionId: 'session-preset-resume',
    name: '小爱音箱',
    utterances: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }],
}));
const r11f = presetRegistry();
const h11f = harness({ presetRegistry: r11f.registry, resumable: true });
const bridge11f = createSessionBridge({
  ctx: h11f.ctx,
  getConfig: () => ({ agentPreset: 'xiaoai' }),
  dataDir: presetDir,
  logger,
});
await bridge11f.deliver({ host: resumeHost, text: '你好' });
check('a resumed conversation carries the preset through setup', () => {
  assert.equal(h11f.created.length, 0);
  assert.equal(h11f.resumed.length, 1);
  assert.equal(h11f.resumed[0].resumeSessionId, 'session-preset-resume');
  assert.equal('meta' in h11f.resumed[0], false);
  assert.equal(typeof h11f.resumed[0].setup, 'function');
});
await h11f.resumed[0].setup(h11f.agentCtx, h11f.agent);
check('the resumed agent gets the mount too', () => {
  assert.deepEqual(r11f.mounts, [{ agentCtx: h11f.agentCtx, id: 'xiaoai' }]);
});

// --- case 12: a bound conversation the user archived ------------------------
// DSH archives a conversation instead of deleting it, and the host's
// archived-session gate then refuses every model step proposed for it: a
// follow-up is accepted by `agent.followup()` and the loop ends `blocked`
// without a request, so the speaker goes silent while the plugin keeps believing
// it still has a conversation. The binding has to be retired on the next
// delivery, and the archive reported instead of swallowed.
console.log('case 12: archived conversation');
const archivedDir = mkdtempSync(join(tmpdir(), 'xiaoai-session-archived-'));
const archivedSessionId = 'session-3d0f1e6c-7a41-4c62-9c1f-2f6a3f6f9c11';
writeFileSync(join(archivedDir, 'devices.json'), `${JSON.stringify({
  version: 2,
  devices: [{
    key: '192.168.1.205',
    host: '192.168.1.205',
    name: '小爱音箱',
    sessionId: archivedSessionId,
    utterances: 3,
    createdAt: 1,
    updatedAt: 2,
    titleLabel: '小爱音箱',
  }],
}, null, 2)}\n`, 'utf8');
const notes12 = [];
// `resumable: true` on purpose: a resume would succeed, so a resumed session
// here would prove the archive check was skipped rather than that it failed.
const h12 = harness({ archivedSessionIds: [archivedSessionId], resumable: true });
const bridge12 = createSessionBridge({
  ctx: h12.ctx,
  getConfig: () => ({}),
  dataDir: archivedDir,
  logger,
  diagnostics: { note: (entry) => { notes12.push(entry); } },
});
const result12 = await bridge12.deliver({ host: '192.168.1.205', name: '小爱音箱', text: '你好' });
check('an archived conversation is neither reused nor resumed', () => {
  assert.equal(result12.ok, true);
  assert.equal(h12.resumeCalls, 0);
  assert.equal(h12.created.length, 1);
  assert.notEqual(result12.sessionId, archivedSessionId);
  assert.match(result12.sessionId, /^session-/);
});
check('the archive is reported once, as a warning naming the old conversation', () => {
  assert.deepEqual(notes12.map((entry) => entry.code), ['session-archived-rebound']);
  assert.equal(notes12[0].level, 'warn');
  assert.match(notes12[0].detail, new RegExp(archivedSessionId));
});
await new Promise((resolve) => { setTimeout(resolve, 400); });
check('the store points at the new conversation', () => {
  const stored = JSON.parse(readFileSync(join(archivedDir, 'devices.json'), 'utf8'));
  assert.equal(stored.devices[0].sessionId, result12.sessionId);
  assert.equal(stored.devices[0].utterances, 4);
});
check('the new conversation is titled again', () => {
  assert.deepEqual(h12.renames, [{ id: result12.sessionId, label: '小爱音箱' }]);
});
// A conversation that is *not* archived still resumes: the check is about the
// archive, not about preferring a fresh session.
writeFileSync(join(archivedDir, 'devices.json'), `${JSON.stringify({
  version: 2,
  devices: [{
    key: '192.168.1.205',
    host: '192.168.1.205',
    name: '小爱音箱',
    sessionId: 'session-still-here',
    utterances: 4,
    createdAt: 1,
    updatedAt: 2,
    titleLabel: '小爱音箱',
  }],
}, null, 2)}\n`, 'utf8');
const h12b = harness({ archivedSessionIds: ['session-somebody-else'], resumable: true });
const bridge12b = createSessionBridge({ ctx: h12b.ctx, getConfig: () => ({}), dataDir: archivedDir, logger });
const result12b = await bridge12b.deliver({ host: '192.168.1.205', name: '小爱音箱', text: '你好' });
check('an unarchived conversation is still resumed', () => {
  assert.equal(result12b.sessionId, 'session-still-here');
  assert.equal(h12b.resumeCalls, 1);
  assert.equal(h12b.created.length, 0);
});

await bridge1.dispose();
await bridge2.dispose();
await bridge3.dispose();
await bridge4.dispose();
await bridge5.dispose();
await bridge6.dispose();
await bridge7.dispose();
await bridge9.dispose();
await bridge9b.dispose();
await bridge11.dispose();
await bridge11b.dispose();
await bridge11c.dispose();
await bridge11d.dispose();
await bridge11e.dispose();
await bridge11f.dispose();
await bridge12.dispose();
await bridge12b.dispose();
rmSync(dataDir, { recursive: true, force: true });
rmSync(legacyDir, { recursive: true, force: true });
rmSync(workspaceDir, { recursive: true, force: true });
rmSync(configuredDir, { recursive: true, force: true });
rmSync(presetDir, { recursive: true, force: true });
rmSync(archivedDir, { recursive: true, force: true });

console.log(failures === 0 ? '\nsession check OK' : `\nsession check FAILED (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
