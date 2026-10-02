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
 * @module dsh-xiaoai-bridge/http
 */

const JSON_BODY_LIMIT = 1 << 20;
const ROUTE_PREFIX = '/plugin/xiaoai';

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
 * Mount the /plugin/xiaoai route tree.
 * @param {object} webCtx context carrying the injected `webServer` service
 * @param {object} deps
 * @param {object} deps.settings the settings service (describe/update)
 * @param {() => object} deps.config reads the live entry config (volatile fields unwrapped)
 * @param {string} deps.settingsNs the profile entry id this card is keyed by
 * @param {string} deps.pluginVersion manifest version, reported by /health
 * @param {object} [deps.state] plugin state carrying collectFacts()
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
    const patch = payload?.patch;
    const expectedRevision = payload?.revision;
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      sendJson(res, 400, { ok: false, error: 'patch must be an object' });
      return;
    }
    const result = await deps.settings.update(settingsNs, patch, expectedRevision);
    sendJson(res, 200, { ok: true, result });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'no such route: ' + route });
}
