/**
 * dsh-xiaoai-bridge: HTTP client for the bridge's API Server.
 *
 * The bridge exposes a small JSON API on loopback (aiohttp, see
 * `bridge/core/services/api_server.py`). This client is the plugin's only way to
 * make the speaker talk, so every call is bounded by a timeout and reports a
 * structured failure instead of throwing into a caller that cannot recover.
 *
 * Authentication: the upstream API Server has no auth at all. This fork adds a
 * bearer token (phase 3); sending it now is harmless against an unpatched bridge
 * and correct once it lands. The token is only ever attached when the credential
 * store actually holds one AND the request target has passed `resolveTarget()`
 * below — that is, the address is a plain `host:port` built from exactly the two
 * settings it claims to come from. A host value that smuggles in a path, a
 * userinfo block or a second authority would otherwise redirect the secret
 * (`apiServerHost: "127.0.0.1:9092@evil.example"` sends the token to
 * evil.example while the setting still reads like loopback). Non-loopback hosts
 * stay supported on purpose: a bridge on another machine is a documented
 * deployment, and the address the user typed is the address they meant. Vetting
 * the shape of the setting itself is `lib/config.js`'s half of this fix.
 * @module dsh-xiaoai-bridge/bridge
 */
/** Default per-request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Normalize a base URL: trim and drop trailing slashes.
 * @param {string} value configured base URL
 * @returns {string} normalized base URL
 */
export function normalizeBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

/**
 * Host shapes accepted for `apiServerHost`: a bare DNS name / IPv4 literal, or a
 * bracketed IPv6 literal. Anything with `/`, `@`, `?`, `#` or a second `:` is
 * refused rather than interpolated into an authority.
 */
const HOST_SHAPE = /^[A-Za-z0-9._-]+$/;
const IPV6_SHAPE = /^\[[0-9A-Fa-f:.]+\]$/;

/**
 * Addresses that mean "bind every interface" instead of naming a peer: the IPv4
 * wildcard and the IPv6 wildcard in either spelling. A client has no single
 * address to dial for them, so they are dialed on loopback -- the same
 * normalization the port probe uses (`reportHeldPorts` in `lib/index.js`,
 * documented in docs/deploy.md 12.21).
 *
 * An empty setting is deliberately NOT one of these: `validateConfig` refuses it,
 * so the client keeps refusing it too instead of quietly dialing loopback.
 */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);
/** Loopback address a wildcard bind is dialed on. */
const LOOPBACK_HOST = '127.0.0.1';

/**
 * Turn a bind address into something a client can actually dial.
 * @param {unknown} value raw `apiServerHost` setting
 * @returns {string} the host to interpolate into a request URL
 */
export function dialableHost(value) {
  const host = String(value ?? '').trim();
  return WILDCARD_HOSTS.has(host.toLowerCase()) ? LOOPBACK_HOST : host;
}

/**
 * Create a bridge API client bound to live settings.
 *
 * @param {object} options
 * @param {() => object} options.getConfig live settings projection
 * @param {() => Promise<string|null>} [options.resolveToken] reads the bearer token from DSH credentials
 * @param {object} [options.logger] host logger
 * @param {object} [options.diagnostics] remembers failures for the settings status card
 * @returns {{baseUrl: () => string, playText: Function, health: Function, interrupt: Function, request: Function}}
 */
export function createBridgeClient({ getConfig, resolveToken, logger, diagnostics }) {
  /**
   * Base URL of the bridge API Server, derived from live settings. Display and
   * diagnostics only: this is the raw concatenation (wildcard binds normalized
   * to the loopback they are dialed on), and it is NOT what `request` sends to.
   * Use `resolveTarget()` for that.
   * @returns {string} best-effort base URL
   */
  function baseUrl() {
    const cfg = getConfig();
    const host = dialableHost(cfg.apiServerHost ?? '127.0.0.1');
    const port = Number(cfg.apiServerPort ?? 9092);
    return `http://${host}:${port}`;
  }

  /**
   * Build the request origin from live settings and prove it is what it looks
   * like before anything (in particular the bearer token) is sent there.
   *
   * @returns {{url: string, host: string} | {error: string}} `url` is the vetted
   *   `http://host:port` origin, `error` a human-readable refusal
   */
  function resolveTarget() {
    const cfg = getConfig();
    const configured = String(cfg.apiServerHost ?? '127.0.0.1').trim();
    const host = dialableHost(configured);
    const port = Number(cfg.apiServerPort ?? 9092);
    const raw = `http://${host}:${port}`;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: `apiServerPort is not a port number: ${String(cfg.apiServerPort)}` };
    }
    if (!HOST_SHAPE.test(host) && !IPV6_SHAPE.test(host)) {
      return { error: `apiServerHost is not a plain host name: ${JSON.stringify(configured)}` };
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return { error: `apiServerHost/apiServerPort does not form a URL: ${raw}` };
    }
    // URL keeps the brackets of an IPv6 literal in `hostname`, but accept either
    // spelling so this check survives that detail. It also drops a port that is
    // the scheme default, so `:80` arrives here as ''.
    const acceptableHosts = IPV6_SHAPE.test(host) ? [host, host.slice(1, -1)] : [host.toLowerCase()];
    const acceptablePorts = port === 80 ? ['', '80'] : [String(port)];
    if (
      parsed.protocol !== 'http:' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      !acceptableHosts.includes(parsed.hostname) ||
      !acceptablePorts.includes(parsed.port)
    ) {
      return { error: `apiServerHost/apiServerPort does not resolve to ${raw} (got ${parsed.origin})` };
    }
    return { url: raw, host };
  }

  /**
   * Remember a failed call for the status card. The bridge answers a lot of
   * questions the user never sees; the ones that failed are worth keeping.
   * @param {string} code diagnostic code ('bridge-rejected' and friends)
   * @param {string} detail raw technical detail, shown verbatim
   */
  function report(code, detail) {
    try {
      diagnostics?.note?.({ code, detail });
    } catch (err) {
      logger?.warn?.(`dsh-xiaoai-bridge: could not record a diagnostic: ${String(err?.message ?? err)}`);
    }
  }

  /**
   * Issue one JSON request against the bridge.
   *
   * Never throws: a bridge that is down, slow, or returning garbage is a normal
   * operating condition (the user may not have started it yet), and callers are
   * tool handlers that must return a message rather than an exception.
   * @param {string} path API path beginning with '/'
   * @param {object} [options]
   * @param {string} [options.method] HTTP method, default GET
   * @param {object} [options.body] JSON request body
   * @param {number} [options.timeoutMs] request timeout
   * @returns {Promise<{ok: boolean, status?: number, data?: any, error?: string}>} structured result
   */
  async function request(path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    // Nothing is sent until the address survives resolveTarget(). A refused
    // address is reported as unreachable rather than thrown, like every other
    // failure here: the caller is a tool handler that must return a message.
    const target = resolveTarget();
    if (target.error) {
      report('bridge-unreachable', `${method} ${path}: ${target.error}`);
      return { ok: false, error: `无法连接桥接器：${target.error}` };
    }
    const url = target.url + path;
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      const token = await resolveToken?.();
      // Only a real token, and only towards the vetted origin above: an empty or
      // missing credential must not produce a bare `Bearer ` header.
      if (typeof token === 'string' && token.length > 0) headers.authorization = `Bearer ${token}`;
    } catch (err) {
      logger?.warn?.(`dsh-xiaoai-bridge: credential lookup failed: ${String(err?.message ?? err)}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      if (text.length > 0) {
        try { data = JSON.parse(text); } catch { data = { raw: text }; }
      }
      if (!response.ok) {
        const detail = data && typeof data === 'object' && 'error' in data ? String(data.error) : text.slice(0, 200);
        const error = `HTTP ${response.status}${detail ? ': ' + detail : ''}`;
        // 401/403 is the one failure the user can actually fix: the bridge was
        // told to want a different token than the one we hold.
        report(response.status === 401 || response.status === 403 ? 'bridge-rejected' : 'bridge-error', `${method} ${path}: ${error}`);
        return { ok: false, status: response.status, data, error };
      }
      return { ok: true, status: response.status, data };
    } catch (err) {
      if (err?.name === 'AbortError') {
        report('bridge-timeout', `${method} ${path}: no answer in ${timeoutMs} ms`);
        return { ok: false, error: `请求超时（${timeoutMs} ms）` };
      }
      report('bridge-unreachable', `${method} ${path}: ${String(err?.message ?? err)}`);
      return { ok: false, error: `无法连接桥接器 ${url}：${String(err?.message ?? err)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ask the bridge to speak a line of text.
   *
   * Deliberately non-blocking: the bridge's non-blocking path goes through
   * `ubus call mibrain text_to_speech`, which reports success honestly. Its
   * blocking path runs `/usr/sbin/tts_play.sh`, whose last statement is a
   * conditional `mphelper play` and therefore returns exit code 1 after a
   * perfectly audible playback (measured on the device, see docs/deploy.md).
   * @param {string} text text to speak
   * @returns {Promise<{ok: boolean, data?: any, error?: string}>} bridge result
   */
  function playText(text) {
    return request('/api/play/text', {
      method: 'POST',
      body: { text, blocking: false },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  }

  /**
   * Probe the bridge API Server.
   *
   * The settings page calls this to draw the status card, so it accepts a
   * shorter timeout than a playback: "not answering right now" is all the card
   * needs to know, and the user should not wait five seconds to be told it.
   * @param {object} [options]
   * @param {number} [options.timeoutMs] probe timeout
   * @returns {Promise<object>} structured result
   */
  function health({ timeoutMs = 5000 } = {}) {
    return request('/api/health', { timeoutMs });
  }

  /** Ask the bridge to stop whatever the speaker is doing. @returns {Promise<object>} structured result */
  function interrupt() {
    return request('/api/interrupt', { method: 'POST', timeoutMs: 5000 });
  }

  return { baseUrl, request, playText, health, interrupt };
}
