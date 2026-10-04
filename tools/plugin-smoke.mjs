/**
 * Phase-1 dry run for the dsh-xiaoai-bridge host half.
 *
 * Loads lib/index.js with a fake cordis context, applies the plugin, then drives
 * the mounted /plugin/xiaoai handler for the acceptance call
 * `GET /plugin/xiaoai/health`. Run: node plugin-smoke.mjs
 */
import { EventEmitter } from 'node:events';

const PLUGIN = new URL('../lib/index.js', import.meta.url).href;
const recorded = { skills: [], tools: [], routes: [], logs: [], effects: 0, injected: null };

const fakeWebServer = {
  host: '127.0.0.1',
  port: 19387,
  register(route) { recorded.routes.push(route); return () => {}; },
};

const ctx = {
  logger: {
    info: (...a) => recorded.logs.push(['info', ...a.map(String)]),
    warn: (...a) => recorded.logs.push(['warn', ...a.map(String)]),
    debug: () => {},
  },
  fiber: { entry: { options: { id: 'xiaoai' } } },
  effect(fn) { recorded.effects += 1; const d = fn(); return typeof d === 'function' ? d : () => {}; },
  skills: { register(def) { recorded.skills.push(def); return () => {}; } },
  tools: { register(def) { recorded.tools.push(def); return () => {}; } },
  settings: {
    describe() { return [{ ns: 'xiaoai', revision: 7, value: {}, schema: {} }]; },
    _fence(expectedRevision) {
      // Mirrors dsh-settings: a stale revision is a structural conflict, which
      // the route maps to 409 (the client then reloads and re-seeds its draft).
      if (expectedRevision !== 7) {
        const err = new Error('settings conflict on xiaoai');
        err.name = 'SettingsConflictError';
        throw err;
      }
    },
    async update(ns, patch, expectedRevision) { this._fence(expectedRevision); return { ns, patch, expectedRevision }; },
    async mutate(ns, ops, expectedRevision) { this._fence(expectedRevision); return { ns, ops, expectedRevision }; },
  },
  credentials: {
    async resolve() { return 'smoke-token'; },
    async describe() { return { configured: true }; },
    async set() {},
    async unset() {},
  },
  agents: {},
  get(name) {
    // The settings page offers the host's own project groups, so the plugin
    // reads them off the workspace registry.
    if (name === 'workspaceRegistry') {
      return {
        list: () => [
          { id: 'w1', path: 'D:\\WorkSpace', title: 'WorkSpace' },
          { id: 'w2', path: 'D:\\WorkSpace\\XiaoAI', title: 'XiaoAI' },
          { id: 'w3', path: '  ', title: 'no path' },
        ],
        resolveByPath: async () => undefined,
      };
    }
    return undefined;
  },
  on() { return () => {}; },
  inject(services, cb) {
    recorded.injected = services;
    cb({ webServer: fakeWebServer, effect: ctx.effect });
  },
};

const mod = await import(PLUGIN);
console.log('exports:', Object.keys(mod).sort().join(', '));
console.log('name =', mod.name, '| inject =', JSON.stringify(mod.inject));
console.log('settingsNamespace =', mod.settingsNamespace(ctx));
console.log('parseWakeKeywords("小爱小爱\\n小爱同学") =', JSON.stringify(mod.parseWakeKeywords('小爱小爱\n小爱同学')));

// Volatile fields arrive as live references in apply(); mix one ref in to prove
// plainConfig() unwraps it.
const config = {
  deviceHost: { get: () => '192.168.1.191' },
  wakeKeywords: { get: () => '小爱小爱\n小爱同学' },
  autoStart: { get: () => false },
};
mod.apply(ctx, config);

console.log('--- after apply ---');
console.log('effects:', recorded.effects, '| injected services:', JSON.stringify(recorded.injected));
console.log('skills:', recorded.skills.map((s) => s.name + ' (' + s.source + ',' + (s.content ?? '').length + ' chars, resourceBase=' + (s.resourceBase ? s.resourceBase.kind : 'none') + ')').join('; '));
console.log('tools:', recorded.tools.length);
console.log('routes:', recorded.routes.map((r) => r.kind + ' ' + r.path).join('; '));

// --- drive the HTTP handler -------------------------------------------------
function fakeRes() {
  return {
    status: null, headers: null, body: '', headersSent: false, destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(chunk) { if (chunk !== undefined) this.body += chunk; this.headersSent = true; },
    destroy() { this.destroyed = true; },
  };
}

function fakeReq(method, url, headers = {}, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  req.destroy = () => {};
  return req;
}

async function call(method, url, headers, body) {
  const req = fakeReq(method, url, headers, body);
  const res = fakeRes();
  await recorded.routes[0].handler(req, res);
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { /* non-JSON */ }
  return { status: res.status, body: parsed ?? res.body };
}

const health = await call('GET', '/plugin/xiaoai/health');
console.log('--- GET /plugin/xiaoai/health ---');
console.log('status =', health.status, '| ok =', health.body.ok, '| plugin =', health.body.plugin, '| version =', health.body.version);
console.log('health.enabled =', health.body.health.enabled, '| wakeKeywords =', JSON.stringify(health.body.health.wakeKeywords));
console.log('health.paths.bridgeDir =', health.body.health.paths.bridgeDir);
console.log('health.workspaces =', JSON.stringify(health.body.health.workspaces));
console.log('health.checks =', JSON.stringify(health.body.health.checks));
{
  const rows = health.body.health.workspaces;
  const ok = Array.isArray(rows)
    && rows.length === 2
    && rows[0].path === 'D:\\WorkSpace' && rows[0].title === 'WorkSpace'
    && rows[1].path === 'D:\\WorkSpace\\XiaoAI';
  console.log(ok ? 'workspaces facts OK (the picker has groups to offer)' : 'workspaces facts WRONG: ' + JSON.stringify(rows));
}

const cfg = await call('GET', '/plugin/xiaoai/config');
console.log('--- GET /plugin/xiaoai/config --- status =', cfg.status, '| ns =', cfg.body.descriptor && cfg.body.descriptor.ns);

const post = await call('POST', '/plugin/xiaoai/config', { 'content-type': 'application/json' }, JSON.stringify({ patch: { deviceHost: '10.0.0.2' }, revision: 7 }));
console.log('--- POST /plugin/xiaoai/config --- status =', post.status, '| result =', JSON.stringify(post.body.result));

// The settings page saves with ops, not patch: one save can mix edits with
// resets, and only {op:'unset'} can restore a field to its inherited value.
const ops = await call('POST', '/plugin/xiaoai/config', { 'content-type': 'application/json' }, JSON.stringify({ ops: [{ op: 'set', path: ['deviceHost'], value: '10.0.0.3' }, { op: 'unset', path: ['logLevel'] }], revision: 7 }));
console.log('--- POST /config (ops) --- status =', ops.status, '| result =', JSON.stringify(ops.body.result), '| error =', JSON.stringify(ops.body.error), '| config =', JSON.stringify(ops.body.config));

const both = await call('POST', '/plugin/xiaoai/config', { 'content-type': 'application/json' }, JSON.stringify({ patch: { logLevel: 'DEBUG' }, ops: [{ op: 'unset', path: ['logLevel'] }], revision: 7 }));
console.log('--- POST /config (patch+ops) --- status =', both.status, '| error =', both.body.error);

const badOps = await call('POST', '/plugin/xiaoai/config', { 'content-type': 'application/json' }, JSON.stringify({ ops: [], revision: 7 }));
console.log('--- POST /config (empty ops) --- status =', badOps.status, '| error =', badOps.body.error);

const badOp = await call('POST', '/plugin/xiaoai/config', { 'content-type': 'application/json' }, JSON.stringify({ ops: [{ op: 'reset', path: ['logLevel'] }], revision: 7 }));
console.log('--- POST /config (bad op) --- status =', badOp.status, '| error =', badOp.body.error);

const conflict = await call('POST', '/plugin/xiaoai/config', { 'content-type': 'application/json' }, JSON.stringify({ ops: [{ op: 'unset', path: ['logLevel'] }], revision: 3 }));
console.log('--- POST /config (stale revision) --- status =', conflict.status, '| error =', conflict.body.error);

const foreign = await call('GET', '/plugin/xiaoai/health', { origin: 'http://evil.example' });
console.log('--- foreign origin --- status =', foreign.status, '| error =', foreign.body.error);

const missing = await call('GET', '/plugin/xiaoai/nope');
console.log('--- unknown route --- status =', missing.status, '| error =', missing.body.error);

const st = await call('GET', '/plugin/xiaoai/bridge/status');
console.log('--- GET /bridge/status --- status =', st.status, '| keys =', Object.keys(st.body).join(','));

const asrNoAuth = await call('POST', '/plugin/xiaoai/asr', { 'content-type': 'application/json' }, JSON.stringify({ text: '你好' }));
console.log('--- POST /asr (no bearer) --- status =', asrNoAuth.status, '| error =', asrNoAuth.body.error);
{
  // ctx.credentials.resolve() hands the plugin 'smoke-token', so a token DOES
  // exist: a bearerless call must be refused as unauthorized (401), never as
  // "no token is configured" (503). The 503 here is the fail-closed gate, which
  // by definition means the gate never received the resolver the host wired up.
  const ok = asrNoAuth.status === 401;
  console.log(ok
    ? 'asr gate facts OK (a configured token means 401, not fail-closed 503)'
    : 'asr gate facts WRONG: status ' + asrNoAuth.status + ' (expected 401; 503 means the host handed the gate no token resolver)');
}

const asrAuth = await call('POST', '/plugin/xiaoai/asr', { 'content-type': 'application/json', authorization: 'Bearer smoke-token' }, JSON.stringify({ text: '你好', device_name: '小爱音箱' }));
console.log('--- POST /asr (bearer, empty agents stub) --- status =', asrAuth.status, '| error =', asrAuth.body.error);

const asrEmpty = await call('POST', '/plugin/xiaoai/asr', { 'content-type': 'application/json', authorization: 'Bearer smoke-token' }, JSON.stringify({ text: '   ' }));
console.log('--- POST /asr (empty text) --- status =', asrEmpty.status, '| error =', asrEmpty.body.error);

// The status card reads the API Server probe and the error memory out of
// /health. The rejected /asr above must show up there: that is the only place
// the user can see a bearer mismatch at all.
const health2 = await call('GET', '/plugin/xiaoai/health');
console.log('--- GET /health (after the rejected /asr) ---');
console.log('health.bridgeApi =', JSON.stringify(health2.body.health.bridgeApi));
console.log('health.diagnostics =', JSON.stringify(health2.body.health.diagnostics));
{
  const api = health2.body.health.bridgeApi;
  const rows = health2.body.health.diagnostics;
  const apiOk = Boolean(api)
    && ['connected', 'unauthorized', 'unreachable', 'disabled'].includes(api.state)
    && api.url === 'http://127.0.0.1:9092';
  const diagOk = Array.isArray(rows) && rows.some((row) => row.code === 'plugin-rejected');
  console.log(apiOk ? 'bridgeApi facts OK (the card can say connected or not)' : 'bridgeApi facts WRONG: ' + JSON.stringify(api));
  console.log(diagOk ? 'diagnostics facts OK (the rejected /asr was remembered)' : 'diagnostics facts WRONG: ' + JSON.stringify(rows));
}

// Uninstalling deletes history on request only: the route must refuse anything
// that does not spell out the confirmation, then report what it removed.
const wipeRefused = await call('POST', '/plugin/xiaoai/data/wipe', { 'content-type': 'application/json' }, JSON.stringify({ confirm: 'please' }));
console.log('--- POST /data/wipe (no confirmation) --- status =', wipeRefused.status, '| error =', wipeRefused.body.error);
const wipe = await call('POST', '/plugin/xiaoai/data/wipe', { 'content-type': 'application/json' }, JSON.stringify({ confirm: 'wipe' }));
console.log('--- POST /data/wipe --- status =', wipe.status, '| dataDir =', wipe.body.dataDir, '| removed =', JSON.stringify(wipe.body.removed));
{
  const refuseOk = wipeRefused.status === 400 && typeof wipeRefused.body.error === 'string';
  const wipeOk = wipe.status === 200 && wipe.body.ok === true && Array.isArray(wipe.body.removed);
  console.log(refuseOk ? 'wipe guard OK (the route needs an explicit confirmation)' : 'wipe guard WRONG: ' + JSON.stringify(wipeRefused.body));
  console.log(wipeOk ? 'wipe route OK (nothing left to delete in a fresh home)' : 'wipe route WRONG: ' + JSON.stringify(wipe.body));
}

console.log('--- logs ---');
for (const line of recorded.logs) console.log(line.join(' '));

// --- Config schema resolution ----------------------------------------------
console.log("--- Config({}) defaults ---");
const resolved = mod.Config({});
console.log("apiServerPort =", resolved.apiServerPort, "| apiServerTokenCredential =", resolved.apiServerTokenCredential);
console.log("wakeKeywords =", JSON.stringify(resolved.wakeKeywords), "| asrBackend =", resolved.asrBackend, "| enabled =", resolved.enabled);
console.log("deviceName =", resolved.deviceName);

console.log("--- Config(override) ---");
const over = mod.Config({ apiServerPort: 19092, wakeKeywords: "你好小智" });
console.log("apiServerPort =", over.apiServerPort, "| wakeKeywords =", JSON.stringify(over.wakeKeywords), "| deviceName =", over.deviceName);
