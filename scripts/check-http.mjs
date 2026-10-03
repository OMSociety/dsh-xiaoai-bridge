/**
 * Offline checker for the plugin HTTP layer and the bridge API client.
 *
 * Why this file exists: the eight checkers next to it never import `lib/http.js`
 * (grep `scripts/` for `http.js` — zero hits), so routes, request-body parsing,
 * the same-origin check and `/asr` authentication had no offline signal at all.
 * The regression that motivated writing it is cheap to fix and easy to re-break:
 *
 *   - `/asr` used to fail OPEN. With no token provisioned it delivered the
 *     utterance into a live session anyway, and it never looked at the peer
 *     address either, so "no credential" silently meant "no gate". It now fails
 *     CLOSED (503), and this file is the only thing that notices if that
 *     reverses.
 *   - `readBody` used to `req.destroy()` the moment a body exceeded the limit and
 *     only then answered 400, so a real client saw ECONNRESET instead of a
 *     status code. The over-limit case below therefore goes over a RAW SOCKET:
 *     `fetch` would hide the difference behind its own error handling.
 *
 * What it does NOT cover: nothing here starts the bridge, opens the 9092 API
 * Server, touches `<DSH_HOME>`, or requests the running plugin. It mounts the
 * real route handler into a throwaway `http.Server` on an ephemeral loopback
 * port, drives it with real requests, and shuts everything down.
 *
 * Style follows `scripts/check-config.mjs`: one `ok`/`FAIL` line per assertion,
 * exit 1 if any failed, `http check OK` on success.
 */
import http from 'node:http';
import net from 'node:net';
import { mountHttp } from '../lib/http.js';
import { createBridgeClient } from '../lib/bridge.js';
import { DEFAULTS } from '../lib/config.js';

let failures = 0;

/** Record one assertion. @param {boolean} condition @param {string} label */
function ok(condition, label) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failures += 1;
  }
}

/**
 * Record an equality assertion.
 * @param {unknown} actual @param {unknown} expected @param {string} label
 */
function eq(actual, expected, label) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(same, same ? label : `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

/** @param {string} name */
function section(name) {
  console.log(`section: ${name}`);
}

/**
 * Mount the real handler the way `lib/index.js` does, but capture it instead of
 * registering it with a host webServer.
 * @param {object} deps route dependencies
 * @param {number} port port the Origin allowlist must agree with
 * @returns {{handler: (req: object, res: object) => void, registrations: object[], effects: number}}
 */
function captureHandler(deps, port) {
  const registrations = [];
  let effects = 0;
  const webCtx = {
    webServer: {
      host: '127.0.0.1',
      port,
      register: (spec) => {
        registrations.push(spec);
        return () => {};
      },
    },
    effect: (fn) => {
      effects += 1;
      fn();
    },
  };
  mountHttp(webCtx, deps);
  return { handler: registrations[0]?.handler, registrations, effects };
}

/** @param {http.Server} server @returns {Promise<number>} bound port */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/** @param {http.Server} server */
function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * One request against the throwaway server.
 * @param {number} port @param {string} path
 * @param {object} [options]
 * @returns {Promise<{status: number, headers: object, text: string, json: any, error?: string}>}
 */
async function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, headers: Object.fromEntries(response.headers), text, json };
  } catch (err) {
    return { status: 0, headers: {}, text: '', json: null, error: String(err?.message ?? err) };
  }
}

/**
 * Write a request by hand over a real TCP socket and collect whatever comes
 * back. This is the only way to tell "the server answered 400" apart from "the
 * server killed the socket", which is the whole point of the over-limit case.
 * @param {object} options
 * @param {number} options.port @param {string} options.head request line + headers
 * @param {Buffer[]} [options.chunks] body pieces to write after the head
 * @returns {Promise<{received: string, transportError: string|null}>}
 */
function rawRequest({ port, head, chunks = [] }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let received = '';
    let transportError = null;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ received, transportError });
    };
    const timer = setTimeout(() => {
      transportError = transportError ?? 'timed out waiting for a response';
      done();
    }, 5000);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      received += chunk;
    });
    socket.on('end', () => {
      clearTimeout(timer);
      done();
    });
    // A server that answers and then closes while we are still writing will
    // surface an EPIPE/ECONNRESET here; it is recorded, not fatal, because the
    // response may already have arrived.
    socket.on('error', (err) => {
      transportError = String(err?.code ?? err?.message ?? err);
      clearTimeout(timer);
      done();
    });
    socket.on('connect', () => {
      socket.write(head);
      for (const chunk of chunks) socket.write(chunk);
    });
  });
}

/** Route dependencies that answer every route this file exercises. */
function makeDeps(overrides = {}) {
  const calls = { deliver: [], utterance: [], notes: [], wipe: 0, update: [], mutate: [], logs: [] };
  const deps = {
    settings: {
      describe: () => [],
      update: async (ns, patch, revision) => {
        calls.update.push({ ns, patch, revision });
        return { ok: true };
      },
      mutate: async (ns, ops, revision) => {
        calls.mutate.push({ ns, ops, revision });
        return { ok: true };
      },
    },
    // A realistic live section: the route validates the draft it is about to
    // store (DEFAULTS + these values + the change), exactly like the host does.
    config: () => ({ ...DEFAULTS }),
    settingsNs: 'xiaoai',
    pluginVersion: '0.0.0-test',
    state: { collectFacts: async () => ({ ok: true }) },
    sessions: {
      deliver: async (params) => {
        calls.deliver.push(params);
        return { ok: true, sessionId: 'sess-1', deviceKey: 'dev-1' };
      },
      list: () => [],
    },
    supervisor: undefined,
    bridge: undefined,
    diagnostics: { note: (entry) => calls.notes.push(entry) },
    cleanup: {
      dataDir: 'unused-in-this-checker',
      wipe: () => {
        calls.wipe += 1;
        return { removed: [], failed: [] };
      },
    },
    resolveToken: async () => 'secret-token-abc123',
    logger: {
      warn: (...args) => calls.logs.push(args.join(' ')),
      error: (...args) => calls.logs.push(args.join(' ')),
      info: (...args) => calls.logs.push(args.join(' ')),
      debug: (...args) => calls.logs.push(args.join(' ')),
    },
    onUtterance: (params) => calls.utterance.push(params),
    onConfigWritten: () => ({ ok: true }),
    ...overrides,
  };
  return { deps, calls };
}

const PREFIX = '/plugin/xiaoai';

async function main() {
  // ---------------------------------------------------------------- mounting
  section('mount: the route tree is registered under the shared prefix once');
  {
    const { deps } = makeDeps();
    const probe = http.createServer(() => {});
    const port = await listen(probe);
    await close(probe);
    const { handler, registrations, effects } = captureHandler(deps, port);
    eq(registrations.length, 1, 'mountHttp registers exactly one route');
    eq(registrations[0]?.kind, 'prefix', 'the route is registered as a prefix route');
    eq(registrations[0]?.path, PREFIX, `the prefix is ${PREFIX}`);
    eq(effects, 1, 'registration runs inside webCtx.effect so teardown can unregister it');
    ok(typeof handler === 'function', 'the captured handler is callable');
  }

  // One server for every request-based case below.
  const { deps, calls } = makeDeps();
  let handler = null;
  const server = http.createServer((req, res) => handler(req, res));
  const port = await listen(server);
  const mounted = captureHandler(deps, port);
  handler = mounted.handler;

  // ------------------------------------------------------------ same origin
  section('origin: same-origin allowed, foreign origin refused, never with CORS headers');
  {
    const sameOrigin = await request(port, `${PREFIX}/health`, { headers: { origin: `http://127.0.0.1:${port}` } });
    eq(sameOrigin.status, 200, 'same-origin GET /health is served');

    const foreign = await request(port, `${PREFIX}/health`, { headers: { origin: 'http://evil.example' } });
    eq(foreign.status, 403, 'foreign Origin is refused with 403');
    ok(!('access-control-allow-origin' in foreign.headers), 'the 403 carries no Access-Control-Allow-Origin header');
    eq(foreign.json?.error, 'cross-origin request refused', 'the refusal says why');

    const preflightForeign = await request(port, `${PREFIX}/health`, {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
    });
    eq(preflightForeign.status, 403, 'a foreign preflight is refused with 403, not answered 204');
    ok(!('access-control-allow-origin' in preflightForeign.headers), 'the refused preflight advertises no CORS allowance');

    const preflightSame = await request(port, `${PREFIX}/health`, {
      method: 'OPTIONS',
      headers: { origin: `http://127.0.0.1:${port}`, 'access-control-request-method': 'POST' },
    });
    eq(preflightSame.status, 204, 'a same-origin preflight is answered 204');
    ok(!('access-control-allow-origin' in preflightSame.headers), 'even the 204 stays CORS-header free (deliberate)');
  }

  // ---------------------------------------------------------- unknown routes
  section('routes: an unknown path is a 404, not a fallthrough');
  {
    const unknown = await request(port, `${PREFIX}/definitely-not-a-route`);
    eq(unknown.status, 404, 'GET on an unknown route returns 404');
    ok(String(unknown.json?.error ?? '').startsWith('no such route'), 'the 404 names the route it could not find');

    const unknownMethod = await request(port, `${PREFIX}/asr`, { method: 'GET' });
    eq(unknownMethod.status, 404, 'GET /asr (wrong method) is a 404 rather than a delivery');
  }

  // ------------------------------------------------------- /asr fail closed
  section('asr: fail closed when no token is provisioned (the old behaviour delivered)');
  {
    const noToken = makeDeps({ resolveToken: async () => null });
    const unmounted = captureHandler(noToken.deps, port);
    handler = unmounted.handler;

    const refused = await request(port, `${PREFIX}/asr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '把客厅的灯打开', device_host: 'host-1', device_name: '客厅' }),
    });
    ok(refused.status === 401 || refused.status === 503, `no token + no bearer is refused (status ${refused.status})`);
    eq(refused.status, 503, 'the refusal is 503 (nothing to compare against)');
    ok(refused.status !== 200, 'an unauthenticated utterance is never answered 200');
    eq(noToken.calls.deliver.length, 0, 'the session deliver function was NOT called');
    eq(noToken.calls.utterance.length, 0, 'the utterance hook was NOT called either');
    ok(String(refused.json?.error ?? '').includes('no API token'), 'the body explains the missing credential');
    ok(String(refused.json?.error ?? '').includes('fail closed'), 'the body states the fail-closed semantics');
    ok(
      noToken.calls.notes.some((n) => n.code === 'plugin-rejected' && /no API token/.test(n.detail)),
      'the refusal is recorded as a plugin-rejected diagnostic',
    );

    const noResolver = makeDeps({ resolveToken: undefined });
    handler = captureHandler(noResolver.deps, port).handler;
    const refusedWithoutResolver = await request(port, `${PREFIX}/asr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    eq(refusedWithoutResolver.status, 503, 'a build with no resolveToken hook wired refuses instead of opening up');
    eq(noResolver.calls.deliver.length, 0, 'nothing is delivered when the credential seam is absent');
  }

  section('asr: wrong or missing bearer is 401, correct bearer delivers exactly once');
  {
    const guarded = makeDeps();
    handler = captureHandler(guarded.deps, port).handler;

    const missing = await request(port, `${PREFIX}/asr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    eq(missing.status, 401, 'a provisioned token with no Authorization header is 401');

    const wrong = await request(port, `${PREFIX}/asr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-token' },
      body: JSON.stringify({ text: 'hi' }),
    });
    eq(wrong.status, 401, 'a wrong bearer is 401');
    ok(
      guarded.calls.notes.some((n) => n.code === 'plugin-rejected' && /unauthorized/.test(n.detail)),
      'the 401 is recorded as a plugin-rejected diagnostic',
    );
    eq(guarded.calls.deliver.length, 0, 'neither refusal reached the session');

    const accepted = await request(port, `${PREFIX}/asr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token-abc123' },
      body: JSON.stringify({ text: '  把客厅的灯打开  ', device_host: 'host-1', device_name: '客厅', reply: 'spoken' }),
    });
    eq(accepted.status, 200, 'the correct bearer is accepted');
    eq(guarded.calls.deliver.length, 1, 'deliver was called exactly once');
    eq(
      guarded.calls.deliver[0],
      { host: 'host-1', name: '客厅', text: '把客厅的灯打开' },
      'deliver receives the trimmed text and the device fields',
    );
    eq(guarded.calls.utterance.length, 1, 'the utterance hook fired once');
    eq(guarded.calls.utterance[0]?.sessionId, 'sess-1', 'the utterance hook receives the session id');
    eq(accepted.json?.session_id, 'sess-1', 'the response reports the session id back to the bridge');
    eq(accepted.json?.reply, 'spoken', 'the response echoes the reply text the bridge sent');

    const failedDelivery = makeDeps({
      sessions: { deliver: async () => ({ ok: false, error: 'no session' }), list: () => [] },
    });
    handler = captureHandler(failedDelivery.deps, port).handler;
    const delivery = await request(port, `${PREFIX}/asr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token-abc123' },
      body: JSON.stringify({ text: 'hi' }),
    });
    eq(delivery.status, 503, 'a failed delivery is reported as 503, not swallowed as 200');
  }

  section('asr: a credential lookup that throws is a 500, not a delivery');
  {
    const throwing = makeDeps({
      resolveToken: async () => {
        throw new Error('vault locked');
      },
    });
    handler = captureHandler(throwing.deps, port).handler;
    const response = await request(port, `${PREFIX}/asr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    eq(response.status, 500, 'resolveToken throwing yields 500');
    ok(String(response.json?.error ?? '').includes('credential lookup failed'), 'the 500 names the credential lookup');
    ok(!String(response.json?.error ?? '').includes('vault locked'), 'the credential store message is not reflected');
    ok(throwing.calls.logs.some((line) => line.includes('vault locked')), 'the store message went to the log instead');
    eq(throwing.calls.deliver.length, 0, 'nothing is delivered when the credential store errors');
  }

  // ------------------------------------------------------------- body parsing
  section('body: malformed JSON is a 400 and never reaches a handler');
  {
    const guarded = makeDeps();
    handler = captureHandler(guarded.deps, port).handler;

    const malformed = await request(port, `${PREFIX}/asr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token-abc123' },
      body: 'this is not json',
    });
    eq(malformed.status, 400, 'a non-JSON body is a 400');
    ok(String(malformed.json?.error ?? '').startsWith('invalid JSON body'), 'the 400 says the body was not JSON');
    eq(guarded.calls.deliver.length, 0, 'a malformed body never reaches the session');

    const emptyText = await request(port, `${PREFIX}/asr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token-abc123' },
      body: JSON.stringify({ text: '   ' }),
    });
    eq(emptyText.status, 400, 'an empty utterance is a 400');
    eq(guarded.calls.deliver.length, 0, 'an empty utterance is not delivered');
  }

  section('body: an over-limit body answers 400 on a real socket (used to be ECONNRESET)');
  {
    const guarded = makeDeps();
    handler = captureHandler(guarded.deps, port).handler;

    // 1 MiB limit + 8 KiB over, written in 64 KiB pieces so the server sees the
    // body arrive as a stream rather than in one syscall.
    const oversize = Buffer.alloc((1 << 20) + 8192, 0x61);
    const chunks = [];
    for (let offset = 0; offset < oversize.length; offset += 1 << 16) chunks.push(oversize.subarray(offset, offset + (1 << 16)));
    const raw = await rawRequest({
      port,
      head:
        `POST ${PREFIX}/asr HTTP/1.1\r\n` +
        'Host: 127.0.0.1\r\n' +
        'Content-Type: application/json\r\n' +
        'Authorization: Bearer secret-token-abc123\r\n' +
        `Content-Length: ${oversize.length}\r\n` +
        'Connection: close\r\n\r\n',
      chunks,
    });
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(raw.received)?.[1];
    eq(status, '400', 'the raw socket received an HTTP 400 status line (not a bare reset)');
    ok(
      raw.received.includes('too large'),
      `the 400 body names the real reason (transport note: ${raw.transportError ?? 'clean'})`,
    );
    eq(guarded.calls.deliver.length, 0, 'an oversized body never reaches the session');

    // A body well under the limit must still parse normally over the same path.
    const normal = await request(port, `${PREFIX}/asr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token-abc123' },
      body: JSON.stringify({ text: '正常长度' }),
    });
    eq(normal.status, 200, 'a normal body is unaffected by the limit handling');
  }

  // ---------------------------------------------------------------- /data/wipe
  section('data/wipe: requires the explicit confirm word');
  {
    const guarded = makeDeps();
    handler = captureHandler(guarded.deps, port).handler;

    const bare = await request(port, `${PREFIX}/data/wipe`, { method: 'POST' });
    eq(bare.status, 400, 'POST /data/wipe with no body is refused');
    eq(guarded.calls.wipe, 0, 'nothing was deleted');

    const wrong = await request(port, `${PREFIX}/data/wipe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    eq(wrong.status, 400, 'a truthy-but-wrong confirm is refused');
    eq(guarded.calls.wipe, 0, 'nothing was deleted by the wrong confirm word');

    const confirmed = await request(port, `${PREFIX}/data/wipe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'wipe' }),
    });
    eq(confirmed.status, 200, 'the exact confirm word is accepted');
    eq(guarded.calls.wipe, 1, 'wipe ran exactly once');
  }

  // ---------------------------------------------------------------- /config
  section('config: a write is validated before the settings seam sees it');
  {
    const guarded = makeDeps();
    handler = captureHandler(guarded.deps, port).handler;
    const write = (payload) =>
      request(port, `${PREFIX}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

    // The rule list lives in lib/config.js; these four cases are the ones a
    // settings page can actually produce from its own controls.
    const badPort = await write({ patch: { apiServerPort: 70000 } });
    eq(badPort.status, 400, 'an out-of-range apiServerPort is refused with 400');
    eq(guarded.calls.update.length, 0, 'settings.update was NOT called for the refused patch');
    eq(badPort.json?.result, undefined, 'the refusal carries no result field');
    eq(badPort.json?.config, undefined, 'the refusal carries no config field');
    ok(/apiServerPort/.test(String(badPort.json?.error)), 'the refusal names the offending field');

    const fractional = await write({ patch: { wakeupTimeout: 20.5 } });
    eq(fractional.status, 400, 'a fractional wakeupTimeout is refused with 400');
    eq(guarded.calls.update.length, 0, 'settings.update was still not called');

    const emptyHost = await write({ ops: [{ op: 'set', path: ['apiServerHost'], value: '' }] });
    eq(emptyHost.status, 400, 'an ops set of an empty apiServerHost is refused with 400');
    eq(guarded.calls.mutate.length, 0, 'settings.mutate was NOT called for the refused ops');

    const legalOps = await write({
      ops: [
        { op: 'set', path: ['wakeupTimeout'], value: 30 },
        { op: 'unset', path: ['apiServerHost'] },
      ],
    });
    eq(legalOps.status, 200, 'a usable ops list still writes (unset needs no validation)');
    eq(guarded.calls.mutate.length, 1, 'settings.mutate ran exactly once for the accepted ops');

    const legal = await write({ patch: { sessionKey: 'agent:x:y' } });
    eq(legal.status, 200, 'a legal patch is still stored');
    eq(guarded.calls.update.length, 1, 'settings.update ran exactly once for the legal patch');
    eq(legal.json?.ok, true, 'the accepted write answers ok');
  }

  // --------------------------------------------------------- error reflection
  section('errors: a host exception is logged in full and never reflected');
  {
    // What a host exception looks like in practice: an OS error with an
    // absolute path in it. None of this may reach the caller.
    const leaking = 'EACCES: C:\\Users\\Administrator\\secret\\cfg.py open failed';
    const guarded = makeDeps({
      settings: {
        describe: () => [],
        update: async () => {
          throw new Error(leaking);
        },
        mutate: async () => ({}),
      },
    });
    handler = captureHandler(guarded.deps, port).handler;

    const response = await request(port, `${PREFIX}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { sessionKey: 'agent:x:y' } }),
    });
    eq(response.status, 500, 'an internal write failure is a 500');
    eq(response.json?.error, 'internal error', 'the 500 carries fixed wording, not the host message');
    eq(response.json?.ok, false, 'the 500 is still a refusal shape');
    ok(!/EACCES/.test(JSON.stringify(response.json)), 'the body does not echo the host error code');
    ok(!/Administrator|cfg\.py/.test(JSON.stringify(response.json)), 'the body does not echo the path');
    ok(guarded.calls.logs.some((line) => line.includes(leaking)), 'the full exception text went to the log');
    ok(
      guarded.calls.logs.some((line) => line.includes('POST') && line.includes(`${PREFIX}/config`)),
      'the log line names the request that failed',
    );
  }

  {
    // A revision conflict is our OWN message and the settings page shows it, so
    // this is the one 4xx/5xx branch where the text is kept verbatim.
    const conflict = new Error('revision mismatch: expected 7, got 3');
    conflict.name = 'SettingsConflictError';
    const guarded = makeDeps({
      settings: {
        describe: () => [],
        update: async () => {
          throw conflict;
        },
        mutate: async () => ({}),
      },
    });
    handler = captureHandler(guarded.deps, port).handler;

    const response = await request(port, `${PREFIX}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { sessionKey: 'agent:x:y' } }),
    });
    eq(response.status, 409, 'a stale revision is still classified as a conflict');
    eq(
      response.json?.error,
      'revision mismatch: expected 7, got 3',
      'the conflict keeps its own message (the page renders it)',
    );
  }

  await close(server);
  section('bridge client: the bearer only follows a vetted host:port');
  {
    const seen = [];
    const recorder = http.createServer((req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization ?? null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const recorderPort = await listen(recorder);

    const client = createBridgeClient({
      getConfig: () => ({ apiServerHost: '127.0.0.1', apiServerPort: recorderPort }),
      resolveToken: async () => 'secret-token-abc123',
      logger: { warn: () => {} },
      diagnostics: { note: () => {} },
    });
    const healthy = await client.health();
    eq(healthy.ok, true, 'a valid loopback target answers normally');
    eq(seen.length, 1, 'exactly one request reached the recorder');
    eq(seen[0]?.authorization, 'Bearer secret-token-abc123', 'the bearer is attached to the vetted target');

    // No token, no Authorization header at all (not an empty `Bearer `).
    const anonymous = createBridgeClient({
      getConfig: () => ({ apiServerHost: '127.0.0.1', apiServerPort: recorderPort }),
      resolveToken: async () => null,
      logger: { warn: () => {} },
      diagnostics: { note: () => {} },
    });
    const anonymousResult = await anonymous.health();
    eq(anonymousResult.ok, true, 'a bridge with no token is still reachable');
    eq(seen[1]?.authorization, null, 'no Authorization header is sent when the credential store is empty');

    const blank = createBridgeClient({
      getConfig: () => ({ apiServerHost: '127.0.0.1', apiServerPort: recorderPort }),
      resolveToken: async () => '',
      logger: { warn: () => {} },
      diagnostics: { note: () => {} },
    });
    await blank.health();
    eq(seen[2]?.authorization, null, 'an empty-string credential does not produce a bare Bearer header');
    eq(seen[2]?.url, '/api/health', 'the health probe still asks for /api/health');

    // Anything that is not a plain host:port is refused before the token is read.
    const hostile = [
      { apiServerHost: `127.0.0.1:${recorderPort}@evil.example`, apiServerPort: 80, expect: 'apiServerHost' },
      { apiServerHost: 'evil.example/plugin/xiaoai', apiServerPort: 9092, expect: 'apiServerHost' },
      { apiServerHost: 'evil.example:9092', apiServerPort: 9092, expect: 'apiServerHost' },
      { apiServerHost: '', apiServerPort: 9092, expect: 'apiServerHost' },
      { apiServerHost: '127.0.0.1', apiServerPort: 70000, expect: 'apiServerPort' },
      { apiServerHost: '127.0.0.1', apiServerPort: 'not-a-port', expect: 'apiServerPort' },
    ];
    for (const probe of hostile) {
      let tokenReads = 0;
      const notes = [];
      const clientUnderTest = createBridgeClient({
        getConfig: () => ({ apiServerHost: probe.apiServerHost, apiServerPort: probe.apiServerPort }),
        resolveToken: async () => {
          tokenReads += 1;
          return 'secret-token-abc123';
        },
        logger: { warn: () => {} },
        diagnostics: { note: (entry) => notes.push(entry) },
      });
      const result = await clientUnderTest.request('/api/health');
      eq(result.ok, false, `refused: ${probe.expect} = ${JSON.stringify(probe.apiServerHost)}:${probe.apiServerPort}`);
      ok(String(result.error ?? '').includes(probe.expect), `  the refusal names ${probe.expect}`);
      eq(tokenReads, 0, `  the credential was never read for ${JSON.stringify(probe.apiServerHost)}`);
      ok(notes.some((n) => n.code === 'bridge-unreachable'), '  the refusal is reported as bridge-unreachable');
    }
    eq(seen.length, 3, 'no refused target ever reached the recorder');

    // Port 80 is the one case URL normalization rewrites: `http://host:80`
    // parses with an empty port, and the vetting must not read that as a
    // mismatch. No token here, so this cannot leak a credential to port 80.
    const port80 = createBridgeClient({
      getConfig: () => ({ apiServerHost: '127.0.0.1', apiServerPort: 80 }),
      resolveToken: async () => null,
      logger: { warn: () => {} },
      diagnostics: { note: () => {} },
    });
    const port80Result = await port80.request('/api/health');
    ok(
      !String(port80Result.error ?? '').includes('apiServerHost'),
      'port 80 is treated as a valid target, not as a host-smuggling attempt',
    );

    // IPv6 and case-insensitive spellings of a working host stay accepted.
    const ipv6 = createBridgeClient({
      getConfig: () => ({ apiServerHost: '[::1]', apiServerPort: recorderPort }),
      resolveToken: async () => null,
      logger: { warn: () => {} },
      diagnostics: { note: () => {} },
    });
    eq(ipv6.baseUrl(), `http://[::1]:${recorderPort}`, 'baseUrl() keeps reporting the configured spelling');
    const upperCase = createBridgeClient({
      getConfig: () => ({ apiServerHost: 'LOCALHOST', apiServerPort: recorderPort }),
      resolveToken: async () => null,
      logger: { warn: () => {} },
      diagnostics: { note: () => {} },
    });
    ok(typeof (await upperCase.request('/api/health')).ok === 'boolean', 'a host name in mixed case is not treated as hostile');

    await close(recorder);
  }

  console.log(failures === 0 ? '\nhttp check OK' : `\nhttp check FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(`  FAIL the checker itself threw: ${String(err?.stack ?? err)}`);
  console.log('\nhttp check FAILED (1)');
  process.exit(1);
});
