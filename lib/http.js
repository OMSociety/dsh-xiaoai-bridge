/**
 * Web host surface for the Web profile: the `/plugin/xiaoai/*` route tree that
 * backs the "小爱音箱" settings tab.
 *
 * Same-origin browser calls only; config reads and writes go through the
 * settings seam, which is revision-fenced so a stale tab cannot clobber a newer
 * write. No secret VALUE ever crosses this surface — the API Server token lives
 * in DSH Credentials under a reference name.
 *
 * The revision conflict thrown by the settings seam is classified structurally
 * (error name) rather than by importing `@deepseek-ai/dsh-settings`: that module
 * is host-internal at runtime, and a plugin half has no need to depend on it.
 *
 * Two classes of caller reach this tree and they authenticate differently:
 *
 * - The GUI (settings card) is same-origin and carries the browser session, so
 *   the Origin check below is its gate.
 * - The bridge process posts recognized utterances to `/asr`. It is not a
 *   browser, sends no Origin, and runs as a local process: `/asr` therefore
 *   requires the bearer token the same process was launched with, and is the
 *   only route on this tree that does.
 * @module dsh-xiaoai-bridge/http
 */
import { timingSafeEqual } from 'node:crypto';

const JSON_BODY_LIMIT = 1 << 20;
const ROUTE_PREFIX = '/plugin/xiaoai';
/** Default number of bridge log lines returned by /bridge/logs. */
const LOG_TAIL_DEFAULT = 80;

/** @param {unknown} err @returns {boolean} whether the settings seam rejected a stale revision */
function isSettingsConflict(err) {
  return Boolean(err) && (err.name === 'SettingsConflictError' || err.constructor?.name === 'SettingsConflictError');
}

function readBody(req, limit = JSON_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendEmpty(res, status) {
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff' });
  res.end();
}

/**
 * Read the bearer token out of an Authorization header.
 * @param {object} req incoming request
 * @returns {string} the token, or an empty string when absent or malformed
 */
function bearerOf(req) {
  const raw = req.headers?.authorization;
  const match = /^Bearer\s+(.+)$/i.exec(String(raw ?? ''));
  return match ? match[1].trim() : '';
}

/**
 * Compare two secrets without leaking their length-independent prefix through
 * timing. Returns false for a length mismatch, which is itself observable but
 * reveals nothing about the token.
 * @param {string} presented value supplied by the caller
 * @param {string} expected value the plugin provisioned
 * @returns {boolean} whether they are equal
 */
function secretMatches(presented, expected) {
  const a = Buffer.from(String(presented), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * Mount the /plugin/xiaoai route tree.
 * @param {object} webCtx context carrying the injected `webServer` service
 * @param {object} deps
 * @param {object} deps.settings the settings service (describe/update)
 * @param {() => object} deps.config reads the live entry config (volatile fields unwrapped)
 * @param {string} deps.settingsNs the profile entry id this card is keyed by
 * @param {string} deps.pluginVersion manifest version, reported by /health
 * @param {object} [deps.state] plugin state carrying collectFacts()
 * @param {object} [deps.sessions] device/session bridge; enables /asr
 * @param {() => Promise<string|null>} [deps.resolveToken] reads the API token from DSH credentials
 * @param {object} [deps.supervisor] bridge process supervisor; enables /bridge/*
 * @param {object} [deps.bridge] bridge HTTP client; enables /bridge/health
 * @param {() => object} [deps.onConfigWritten] re-renders the bridge config after a write
 */
export function mountHttp(webCtx, deps) {
  const { webServer } = webCtx;

  webCtx.effect(() => webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => handle(req, res, { ...deps, webServer }).catch((err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = String(err?.message ?? err).slice(0, 400);
      const conflict = isSettingsConflict(err);
      sendJson(res, conflict ? 409 : 500, {
        ok: false,
        error: conflict ? message : 'internal error: ' + message,
      });
    }),
  }), 'dsh-xiaoai-bridge: /plugin/xiaoai routes');
}

/**
 * Re-render the bridge config after a settings write.
 *
 * The write already succeeded, so a render failure must not turn it into an
 * error response: it is reported alongside the result instead, and the next
 * bridge start renders again.
 * @param {object} deps route dependencies
 * @returns {object|undefined} render outcome, or undefined without a hook
 */
function afterConfigWrite(deps) {
  if (typeof deps.onConfigWritten !== 'function') return undefined;
  try {
    return deps.onConfigWritten() ?? undefined;
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err).slice(0, 200) };
  }
}

async function handle(req, res, deps) {
  const { webServer } = deps;
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const route = pathname.slice(ROUTE_PREFIX.length) || '/';

  // Same-origin only: refuse requests carrying a foreign Origin header. DSH's
  // GUI is served from the same webServer, so same-origin calls carry either no
  // Origin (curl, status probes) or exactly this host.
  const origin = req.headers.origin;
  if (origin) {
    const allowed = new Set([
      'http://' + webServer.host + ':' + webServer.port,
      'http://localhost:' + webServer.port,
      'http://127.0.0.1:' + webServer.port,
    ]);
    if (!allowed.has(origin)) {
      sendJson(res, 403, { ok: false, error: 'cross-origin request refused' });
      return;
    }
  }
  if (method === 'OPTIONS') {
    // No CORS headers: cross-origin preflights fail, same-origin calls proceed.
    sendEmpty(res, 204);
    return;
  }

  // DSH keys a plugin's settings card by its profile entry id, which the host
  // half resolves and passes down; 'xiaoai' is only the fallback.
  const settingsNs = typeof deps.settingsNs === 'string' && deps.settingsNs.length > 0 ? deps.settingsNs : 'xiaoai';
  const descriptorOf = () => (deps.settings.describe({ redactSecrets: true }) ?? []).find((row) => row.ns === settingsNs);

  if (route === '/health' && method === 'GET') {
    const facts = deps.state ? await deps.state.collectFacts() : { ok: true };
    sendJson(res, 200, {
      ok: true,
      plugin: 'dsh-xiaoai-bridge',
      version: deps.pluginVersion,
      namespace: settingsNs,
      health: facts,
    });
    return;
  }

  if (route === '/config' && method === 'GET') {
    const descriptor = descriptorOf();
    if (descriptor === undefined) {
      // The card is derived from CONFIG_SCHEMA: it is missing when the entry is
      // inactive or declares no meta.volatile field.
      sendJson(res, 503, {
        ok: false,
        error: 'settings card not available: the xiaoai entry must be active and declare at least one volatile field',
      });
      return;
    }
    sendJson(res, 200, { ok: true, descriptor });
    return;
  }

  if (route === '/config' && method === 'POST') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body: ' + String(err?.message ?? err).slice(0, 200) });
      return;
    }
    const expectedRevision = payload?.revision;
    const patch = payload?.patch;
    const ops = payload?.ops;

    if (patch !== undefined && ops !== undefined) {
      sendJson(res, 400, { ok: false, error: 'send either patch or ops, not both' });
      return;
    }

    // `ops` exists because a merge cannot express a reset: `settings.update`
    // only writes the keys it is given, while `{op:'unset', path:[field]}`
    // restores the inherited value, which is what the page's reset button
    // means. Both paths keep the same revision fence.
    if (ops !== undefined) {
      if (!Array.isArray(ops) || ops.length === 0) {
        sendJson(res, 400, { ok: false, error: 'ops must be a non-empty array' });
        return;
      }
      for (const op of ops) {
        const kind = op?.op;
        const path = op?.path;
        if ((kind !== 'set' && kind !== 'unset') || !Array.isArray(path) || path.length === 0) {
          sendJson(res, 400, { ok: false, error: 'each op must be {op:"set"|"unset", path:[...]}' });
          return;
        }
      }
      const result = await deps.settings.mutate(settingsNs, ops, expectedRevision);
      sendJson(res, 200, { ok: true, result, config: afterConfigWrite(deps) });
      return;
    }

    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      sendJson(res, 400, { ok: false, error: 'patch must be an object' });
      return;
    }
    const result = await deps.settings.update(settingsNs, patch, expectedRevision);
    sendJson(res, 200, { ok: true, result, config: afterConfigWrite(deps) });
    return;
  }

  if (route === '/asr' && method === 'POST') {
    // The bridge is the only non-browser caller of this tree. It carries the
    // token it was launched with; when the token could not be provisioned the
    // route stays open to loopback only, matching the pre-auth behaviour.
    let expected = null;
    try {
      expected = await deps.resolveToken?.();
    } catch (err) {
      sendJson(res, 500, { ok: false, error: 'credential lookup failed: ' + String(err?.message ?? err).slice(0, 200) });
      return;
    }
    if (typeof expected === 'string' && expected.length > 0 && !secretMatches(bearerOf(req), expected)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body: ' + String(err?.message ?? err).slice(0, 200) });
      return;
    }
    const text = String(payload?.text ?? '').trim();
    if (text.length === 0) {
      sendJson(res, 400, { ok: false, error: 'text is required' });
      return;
    }
    if (!deps.sessions) {
      sendJson(res, 503, { ok: false, error: 'session bridge unavailable' });
      return;
    }
    const result = await deps.sessions.deliver({
      host: payload?.device_host,
      name: payload?.device_name,
      text,
    });
    if (!result.ok) {
      sendJson(res, 503, { ok: false, error: result.error ?? 'delivery failed' });
      return;
    }
    // The turn this utterance opens is answered through the speaker; from here
    // on the session events decide what is said (see the plugin's auto-speak
    // wiring). A failure here must not fail the delivery the bridge is waiting
    // on, so the hook is best-effort.
    try {
      deps.onUtterance?.({ sessionId: result.sessionId, deviceKey: result.deviceKey, text });
    } catch (err) {
      deps.logger?.warn?.('dsh-xiaoai-bridge: utterance hook failed: ' + String(err?.message ?? err).slice(0, 200));
    }
    sendJson(res, 200, {
      ok: true,
      session_id: result.sessionId,
      device_key: result.deviceKey,
      reply: typeof payload?.reply === 'string' ? payload.reply : undefined,
    });
    return;
  }

  if (route === '/devices' && method === 'GET') {
    sendJson(res, 200, { ok: true, devices: deps.sessions ? deps.sessions.list() : [] });
    return;
  }

  if (route.startsWith('/bridge/')) {
    if (!deps.supervisor) {
      sendJson(res, 503, { ok: false, error: 'bridge supervision is not available in this plugin build' });
      return;
    }
    const action = route.slice('/bridge/'.length);

    if (action === 'status' && method === 'GET') {
      sendJson(res, 200, { ok: true, bridge: deps.supervisor.state(), logFile: deps.supervisor.logPath });
      return;
    }
    if (action === 'logs' && method === 'GET') {
      const limit = Math.max(1, Math.min(400, Number(url.searchParams.get('limit') ?? LOG_TAIL_DEFAULT) || LOG_TAIL_DEFAULT));
      sendJson(res, 200, { ok: true, lines: deps.supervisor.recentLogs(limit) });
      return;
    }
    if (action === 'health' && method === 'GET') {
      const result = deps.bridge ? await deps.bridge.health() : { ok: false, error: 'bridge client unavailable' };
      sendJson(res, result.ok ? 200 : 503, { ok: result.ok, result });
      return;
    }
    if (action === 'start' && method === 'POST') {
      const result = await deps.supervisor.start();
      sendJson(res, result.ok ? 200 : 500, { ok: result.ok, result, bridge: deps.supervisor.state() });
      return;
    }
    if (action === 'stop' && method === 'POST') {
      const result = await deps.supervisor.stop();
      sendJson(res, result.ok ? 200 : 500, { ok: result.ok, result, bridge: deps.supervisor.state() });
      return;
    }
    if (action === 'restart' && method === 'POST') {
      const result = await deps.supervisor.restart();
      sendJson(res, result.ok ? 200 : 500, { ok: result.ok, result, bridge: deps.supervisor.state() });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'no such bridge action: ' + action });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'no such route: ' + route });
}
