/**
 * Web host surface for the Web profile: the `/plugin/xiaoai/*` route tree that
 * backs the "小爱音箱" settings tab.
 *
 * Same-origin browser calls only; config reads and writes go through the
 * settings seam, which is revision-fenced so a stale tab cannot clobber a newer
 * write. A write is additionally validated against the config rules BEFORE the
 * seam is called, so an unusable value never reaches storage (the load path
 * repairs instead of refusing; see validateDraft). No secret VALUE ever crosses
 * this surface — the API Server token lives in DSH Credentials under a reference
 * name.
 *
 * The revision conflict thrown by the settings seam is classified structurally
 * (error name) rather than by importing `@deepseek-ai/dsh-settings`: that module
 * is host-internal at runtime, and a plugin half has no need to depend on it.
 *
 * Nothing host-internal is reflected either: a failed route answers a fixed
 * `internal error` and the exception text goes to the plugin log, because Node
 * error messages routinely embed absolute paths and host module names. The one
 * exception is a revision conflict, whose message is this plugin's own text and
 * is what the settings page renders.
 *
 * `/credential/doubao` is the one route that touches a secret VALUE, and it is
 * one-way in: the page posts the Doubao Access Token and gets back only whether
 * a value is stored, whether this plugin may replace it and which reference it
 * lives under. The token is written into DSH Credentials and never enters the
 * settings document, this plugin's config, a log line or a response body.
 *
 * Two classes of caller reach this tree and they authenticate differently:
 *
 * - The GUI (settings card) is same-origin and carries the browser session, so
 *   the Origin check below is its gate.
 * - The bridge process posts recognized utterances to `/asr`. It is not a
 *   browser, sends no Origin, and runs as a local process: `/asr` therefore
 *   requires the bearer token the same process was launched with, and is the
 *   only route on this tree that does. It fails CLOSED: with no token
 *   provisioned there is nothing to compare against, so an utterance is refused
 *   with 503 rather than delivered (a locally deployed bridge can never be
 *   mistaken for another local caller). Local processes are otherwise inside
 *   this plugin's trust boundary by design — `/config`, `/bridge/*` and
 *   `/data/wipe` are unauthenticated — which is why no route, `/asr` included,
 *   filters on the peer address; see the note on `/asr` about the voice threat
 *   model.
 * @module dsh-xiaoai-bridge/http
 */
import { timingSafeEqual } from 'node:crypto';

import { DEFAULTS, validateConfig } from './config.js';

const JSON_BODY_LIMIT = 1 << 20;
/**
 * Bytes discarded after a body trips JSON_BODY_LIMIT, before the socket is torn
 * down. Draining the tail is what makes the 400 reachable: destroying the
 * request while the client is still writing surfaces as ECONNRESET and the
 * response never arrives.
 */
const BODY_DRAIN_LIMIT = 1 << 20;
const ROUTE_PREFIX = '/plugin/xiaoai';
/** Default number of bridge log lines returned by /bridge/logs. */
const LOG_TAIL_DEFAULT = 80;

/** @param {unknown} err @returns {boolean} whether the settings seam rejected a stale revision */
function isSettingsConflict(err) {
  return Boolean(err) && (err.name === 'SettingsConflictError' || err.constructor?.name === 'SettingsConflictError');
}

/**
 * The shape a `path` element of a settings op is allowed to have.
 *
 * Every key this plugin's schema exposes is a plain camelCase field name, so
 * nothing legitimate is lost by insisting on that shape — and something real is
 * gained: the settings seam deep-writes the path it is handed, which makes an
 * unexpected segment a key-shaped hole in a write primitive. The path is
 * caller-supplied, so it is restricted here rather than forwarded on the
 * assumption that it is well formed (R3-3).
 */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Names that the shape above cannot rule out but a settings path never needs.
 *
 * These are the property names a deep write resolves through the prototype
 * chain rather than as an own key, and plain letters are exactly what they are
 * made of, so the pattern alone would let `__proto__` / `constructor` through.
 * No key in `lib/config.js` uses them, so refusing them costs nothing (R3-3).
 */
const RESERVED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Read a request body as UTF-8 text.
 *
 * The request is deliberately NOT destroyed the moment the limit trips: a route
 * that still owes the caller a response must get the chance to write it, and
 * destroying a socket while the client is mid-upload is exactly how a should-be
 * 400 turns into ECONNRESET. An over-limit body therefore rejects with
 * `err.bodyTooLarge === true` and Node keeps discarding the tail up to
 * BODY_DRAIN_LIMIT (the route answers first; see sendBodyError, which closes
 * the connection so no unread bytes can be mistaken for a new request). Only a
 * client that keeps streaming past that drain budget has its socket torn down.
 *
 * Every other failure (aborted upload, socket error) rejects with the original
 * error and no `bodyTooLarge` flag.
 *
 * @param {object} req incoming request
 * @param {number} [limit] maximum accepted body size in bytes
 * @returns {Promise<string>} the decoded body
 */
function readBody(req, limit = JSON_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let discarded = 0;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) {
        // Refused already: count the tail down, then cut the socket if the
        // caller ignores the response and keeps writing.
        discarded += chunk.length;
        if (discarded > BODY_DRAIN_LIMIT) req.destroy();
        return;
      }
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error(`request body too large (limit ${limit} bytes)`), {
          bodyTooLarge: true,
          limit,
        }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', fail);
  });
}

/**
 * Write a JSON response.
 * @param {object} res outgoing response
 * @param {number} status HTTP status
 * @param {unknown} payload value to serialize
 * @param {Record<string, string>} [extraHeaders] headers to merge over the defaults
 */
function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(extraHeaders ?? {}),
  });
  res.end(body);
}

/**
 * Answer a body that could not be read, and say which of the two things went
 * wrong: over-limit (400 + `Connection: close`, because the tail may never have
 * been read and the response is what the caller must see) or unparseable/invalid
 * (400). Both are 400 — the route contract never changed — but the message no
 * longer claims a malformed body when the body was simply too big.
 * @param {object} res outgoing response
 * @param {Error & {bodyTooLarge?: boolean, limit?: number}} err failure from readBody/JSON.parse
 */
function sendBodyError(res, err) {
  if (err?.bodyTooLarge === true) {
    sendJson(
      res,
      400,
      { ok: false, error: `request body too large (limit ${err.limit ?? JSON_BODY_LIMIT} bytes)` },
      { Connection: 'close' },
    );
    return;
  }
  sendJson(res, 400, { ok: false, error: `invalid JSON body: ${String(err?.message ?? err).slice(0, 200)}` });
}

/**
 * Parse a JSON request body.
 * @param {object} req incoming request
 * @param {object} res outgoing response
 * @returns {Promise<{ok: true, value: any} | {ok: false}>} `ok: false` means a 400 was already sent
 */
async function readJson(req, res) {
  try {
    return { ok: true, value: JSON.parse(await readBody(req)) };
  } catch (err) {
    sendBodyError(res, err);
    return { ok: false };
  }
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
 * Remember a refused /asr call for the status card. Either reason means the
 * bridge cannot talk to this plugin — no token provisioned, or a different one
 * than the credential store holds — and nothing else about the plugin will look
 * wrong, so the diagnostic is the only visible signal. Best effort: a failing
 * diagnostic must never change the answer the caller gets.
 * @param {object} deps route dependencies
 * @param {object} req incoming request
 * @param {string} reason why the call was refused
 */
function noteAsrRejection(deps, req, reason) {
  try {
    deps.diagnostics?.note?.({
      code: 'plugin-rejected',
      detail: `POST /asr from ${String(req.socket?.remoteAddress ?? 'unknown')}: ${reason}`,
    });
  } catch {
    // ignored on purpose, see above
  }
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
 * @param {() => Promise<object>} [deps.describeDoubaoKey] reports the Doubao credential state (never its value)
 * @param {(value: unknown) => Promise<object>} [deps.writeDoubaoKey] stores the Doubao Access Token in DSH credentials
 * @param {() => Promise<object>} [deps.clearDoubaoKey] removes the stored Doubao Access Token
 * @param {object} [deps.supervisor] bridge process supervisor; enables /bridge/*
 * @param {object} [deps.bridge] bridge HTTP client; enables /bridge/health
 * @param {object} [deps.diagnostics] remembers failures for the settings status card
 * @param {object} [deps.cleanup] bridge data directory cleaner; enables POST /data/wipe
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
      // The host exception is logged in full and never reflected (NOTE-5). Its
      // message routinely embeds absolute paths, host module names or config
      // fragments — Node's EACCES/ENOENT text carries a full path — and this
      // response is read by whatever page called the route. The operator gets
      // the detail from the log; the caller gets a fixed string, because a
      // substring of a host message is not something we can call safe.
      const detail = String(err?.message ?? err);
      const where = `${req.method ?? 'request'} ${String(req.url ?? '').slice(0, 120)}`;
      const log = deps.logger?.error ?? deps.logger?.warn;
      log?.call(deps.logger, `dsh-xiaoai-bridge: ${where} failed: ${detail}`);
      const conflict = isSettingsConflict(err);
      sendJson(res, conflict ? 409 : 500, {
        ok: false,
        // A revision conflict is our own message and the page shows it verbatim;
        // anything else is an internal fault the caller cannot act on.
        error: conflict ? detail.slice(0, 400) : 'internal error',
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

/**
 * The config section as DEFAULTS + the live values, i.e. what a write starts from.
 * @param {object} deps route dependencies
 * @returns {object} a plain section object
 */
function currentSection(deps) {
  const live = typeof deps.config === 'function' ? deps.config() : undefined;
  const base = live !== null && typeof live === 'object' && !Array.isArray(live) ? live : {};
  return { ...DEFAULTS, ...base };
}

/**
 * Deep-set one `set` op's path onto a draft section, copying containers as it
 * descends so the live section is never mutated.
 * @param {object} draft section being built
 * @param {Array<string|number>} path field path from the op
 * @param {*} value value to store
 */
function applySetOp(draft, path, value) {
  let cursor = draft;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    const next = cursor[key];
    cursor[key] = next !== null && typeof next === 'object' ? (Array.isArray(next) ? next.slice() : { ...next }) : {};
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]] = value;
}

/**
 * Validate the section a POST /config call is ABOUT to store, before the host
 * writer runs (R1-1, server half).
 *
 * `lib/index.js` repairs bad values on load with `sanitizeConfig` and only warns,
 * which is right for a value already on disk: the plugin has to come up. A write
 * that is still in flight is different — the caller is here, the settings seam
 * has not been touched, and silently substituting a default would make the page
 * disagree with what the user asked for. So the draft is checked strictly with
 * `validateConfig` and an unusable field is refused at the door with 400.
 *
 * The draft mirrors what the seam will store: DEFAULTS, then the live section,
 * then the change (the `patch`, or the `set` ops applied in order). `unset` only
 * removes a key, and what reappears is the inherited default — already valid —
 * so it needs no check of its own.
 *
 * Ordering note: this runs before the revision fence, so a request that is both
 * stale and invalid answers 400 rather than 409. Both refuse the write, and
 * naming the unusable field is the more actionable of the two.
 *
 * @param {object} draft section about to be written
 * @returns {string|null} the refusal message, or null when the draft is usable
 */
function validateDraft(draft) {
  try {
    validateConfig(draft);
    return null;
  } catch (err) {
    return String(err?.message ?? err).slice(0, 400);
  }
}

/**
 * @param {object} deps route dependencies
 * @param {object} patch merge the caller wants stored
 * @returns {object} the section that would result
 */
function draftForPatch(deps, patch) {
  return { ...currentSection(deps), ...patch };
}

/**
 * @param {object} deps route dependencies
 * @param {Array<object>} ops validated ops list
 * @returns {object} the section that would result
 */
function draftForOps(deps, ops) {
  const draft = currentSection(deps);
  for (const op of ops) {
    if (op?.op === 'set') applySetOp(draft, op.path, op.value);
  }
  return draft;
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
  //
  // TRUST BOUNDARY (NOTE-6): "local" here means the whole machine, not the DSH
  // user. A loopback peer with no Origin passes, and on Windows loopback is
  // reachable from every local user session, so this gate does not separate one
  // local account from another. What it does separate is the browser: a page
  // from another origin cannot reach these routes (no CORS headers either).
  // `apiServerHost` defaults to 127.0.0.1 for that reason — the same-origin
  // check plus the bearer on the routes that require one is the whole gate, and
  // the assumption is the documented one: a process that can already reach this
  // port can already read the credential store, so it owns the DSH profile.
  // Several people sharing one machine need more than this plugin can give:
  // point `apiServerTokenCredential` at a real token and keep the bridge bound
  // to loopback. Deliberately not enforced in code — refusing loopback peers
  // would break the bridge, which is a loopback client by design.
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
    const parsed = await readJson(req, res);
    if (!parsed.ok) return;
    const payload = parsed.value;
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
        // Elements, not just the array, have to be field names: see
        // SAFE_PATH_SEGMENT and RESERVED_PATH_SEGMENTS for why a caller-supplied
        // path is not trusted, and why the pattern alone is not enough.
        if (
          !path.every(
            (segment) =>
              typeof segment === 'string' &&
              SAFE_PATH_SEGMENT.test(segment) &&
              !RESERVED_PATH_SEGMENTS.has(segment),
          )
        ) {
          sendJson(res, 400, {
            ok: false,
            error: 'each path element must be a settings key of letters, digits, "_" or "-" (at most 64 characters), never a prototype name',
          });
          return;
        }
      }
      // Refuse an unusable value BEFORE the seam is touched: `set` is checked,
      // `unset` cannot introduce one (see validateDraft).
      const opRefusal = validateDraft(draftForOps(deps, ops));
      if (opRefusal !== null) {
        sendJson(res, 400, { ok: false, error: opRefusal });
        return;
      }
      const result = await deps.settings.mutate(settingsNs, ops, expectedRevision);
      sendJson(res, 200, { ok: true, result, config: afterConfigWrite(deps) });
      return;
    }

    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      sendJson(res, 400, { ok: false, error: 'patch must be an object' });
      return;
    }
    const patchRefusal = validateDraft(draftForPatch(deps, patch));
    if (patchRefusal !== null) {
      sendJson(res, 400, { ok: false, error: patchRefusal });
      return;
    }
    const result = await deps.settings.update(settingsNs, patch, expectedRevision);
    sendJson(res, 200, { ok: true, result, config: afterConfigWrite(deps) });
    return;
  }

  if (route === '/asr' && method === 'POST') {
    // THREAT MODEL (R3-5): the text below is recognized speech, i.e. UNTRUSTED
    // INPUT that becomes a user message in a DSH session. Whoever can reach this
    // route can therefore ask the agent to do things, in the user's own voice
    // from the agent's point of view. The mechanical guarantees are only:
    //   1. the bearer gate below, and
    //   2. the host's existing approval flow — the speaker announces a fixed
    //      "confirm on the computer" line before an approval-gated tool runs
    //      (lib/auto-speak.js), and the host decides the tool call.
    // There is no restricted tool set for voice turns and no per-utterance
    // approval policy at this layer, by architecture: an utterance gets exactly
    // the powers of the session it lands in. Anything stronger is a session /
    // agent-layer decision (lib/session.js), not something this route can
    // enforce; this comment exists so the gap is not mistaken for a guard.
    //
    // AUTH (R3-1): fail CLOSED — never deliver unless the caller proved it is
    // the bridge. Two distinct answers, one rule:
    //   503  no token is provisioned, so this route has nothing to compare
    //        against and cannot tell the bridge process from any other local
    //        caller. Refusing is the only safe reading of "unknown caller".
    //   401  a token is provisioned and the presented bearer did not match.
    // This route does not consult req.socket.remoteAddress, on purpose: local
    // processes are already inside this plugin's trust boundary (POST /config,
    // /bridge/start, /data/wipe all run unauthenticated by design — see the
    // module header), so a loopback check would add no security while breaking
    // a bridge that legitimately reaches DSH over a non-loopback address.
    // The 500 branch below is only reachable if resolveToken() itself throws:
    // lib/index.js currently swallows credential errors and resolves null, so a
    // failed credential lookup in practice lands on the 503 above, not here.
    let expected = '';
    try {
      expected = String((await deps.resolveToken?.()) ?? '');
    } catch (err) {
      // Same rule as the route wrapper (NOTE-5): the prefix is ours and safe to
      // return, the store's own message goes to the log only.
      const detail = String(err?.message ?? err);
      const log = deps.logger?.error ?? deps.logger?.warn;
      log?.call(deps.logger, 'dsh-xiaoai-bridge: credential lookup failed: ' + detail);
      sendJson(res, 500, { ok: false, error: 'credential lookup failed' });
      return;
    }
    if (expected.length === 0) {
      noteAsrRejection(deps, req, 'no API token is configured');
      sendJson(res, 503, {
        ok: false,
        error:
          'refusing to deliver: no API token is configured, so this route cannot tell the bridge process from any ' +
          'other caller (fail closed). Set the plugin credential, then restart the bridge so it carries the token.',
      });
      return;
    }
    if (!secretMatches(bearerOf(req), expected)) {
      noteAsrRejection(deps, req, 'unauthorized');
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }

    const parsed = await readJson(req, res);
    if (!parsed.ok) return;
    const payload = parsed.value;
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
    // LOGGING / PRIVACY (R3-4): delivery is where the utterance stops being the
    // plugin's problem, and it is NOT redacted anywhere downstream. The bridge
    // writes both sides of the turn verbatim into bridge.log (`💬 我说：…` /
    // `🤖 DSH：…`, bridge/core/dsh.py + bridge/core/utils/logger.py) and the host
    // writes the first 200 characters of each side into the DSH log (the
    // session-event observer in lib/index.js). bridge.log therefore holds the
    // conversation in clear text and must be treated as private when collected
    // for troubleshooting. This transport deliberately does not try to fix that:
    // it must not truncate (the bridge posts the real utterance and the session
    // needs it) and it has no redaction switch, because a switch here would lie
    // about what the layers behind it still write. Any redaction belongs to those
    // writers.
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

  if (route === '/data/wipe' && method === 'POST') {
    // Uninstalling raises no host signal and shares this teardown with every DSH
    // shutdown, so the history files are only deleted when someone asks for it in
    // so many words; a settings save can never reach this route by accident.
    if (!deps.cleanup) {
      sendJson(res, 503, { ok: false, error: 'data cleanup is not available in this plugin build' });
      return;
    }
    const parsed = await readJson(req, res);
    if (!parsed.ok) return;
    const payload = parsed.value;
    if (payload?.confirm !== 'wipe') {
      sendJson(res, 400, { ok: false, error: 'send {"confirm":"wipe"} to delete the bridge logs and the spoken log' });
      return;
    }
    const result = deps.cleanup.wipe();
    sendJson(res, 200, {
      ok: true,
      dataDir: deps.cleanup.dataDir,
      removed: result.removed,
      failed: result.failed,
    });
    return;
  }

  if (route === '/credential/doubao' && method === 'GET') {
    // The credential state, never the credential. The page shows this row
    // instead of a settings field because a settings value would be stored in
    // the settings document and handed back to the browser on every load.
    const mounted = typeof deps.describeDoubaoKey === 'function';
    if (!mounted) {
      sendJson(res, 503, { ok: false, error: 'credential access is not available in this plugin build' });
      return;
    }
    const answer = await deps.describeDoubaoKey();
    sendJson(res, answer.ok === true ? 200 : 503, answer);
    return;
  }

  if (route === '/credential/doubao' && method === 'POST') {
    // The one route that receives a secret VALUE. Same authentication reading
    // as POST /config: the GUI is same-origin and carries the browser session,
    // and a caller that can reach this port can already read the credential
    // store (see the trust-boundary note at the top of handle()). What this
    // route adds is that the value goes one way -- in -- and is not echoed by
    // any response, log line or settings document.
    const mounted = typeof deps.writeDoubaoKey === 'function' && typeof deps.clearDoubaoKey === 'function';
    if (!mounted) {
      sendJson(res, 503, { ok: false, error: 'credential access is not available in this plugin build' });
      return;
    }
    const parsed = await readJson(req, res);
    if (!parsed.ok) return;
    const payload = parsed.value;
    let answer;
    if (payload?.clear === true) {
      answer = await deps.clearDoubaoKey();
    } else {
      // The empty rule is enforced here, before the store is touched: an empty
      // value is refused by the seam anyway, and "no value given" must never be
      // read as "clear it" by accident.
      if (typeof payload?.value !== 'string' || payload.value.trim().length === 0) {
        sendJson(res, 400, { ok: false, error: 'value must be a non-empty string, or send {"clear":true}' });
        return;
      }
      answer = await deps.writeDoubaoKey(payload.value);
    }
    if (answer.ok === true) {
      sendJson(res, 200, answer);
      return;
    }
    // Each refusal is a distinct answer for the page: a read-only source is the
    // host's decision the caller must respect, and anything else means the
    // store could not be reached.
    sendJson(res, answer.error === 'credential is read-only' ? 403 : 503, answer);
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
