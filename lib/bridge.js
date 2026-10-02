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
 * and correct once it lands.
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
 * Create a bridge API client bound to live settings.
 *
 * @param {object} options
 * @param {() => object} options.getConfig live settings projection
 * @param {() => Promise<string|null>} [options.resolveToken] reads the bearer token from DSH credentials
 * @param {object} [options.logger] host logger
 * @returns {{baseUrl: () => string, playText: Function, health: Function, interrupt: Function, request: Function}}
 */
export function createBridgeClient({ getConfig, resolveToken, logger }) {
  /** Base URL of the bridge API Server, derived from live settings. */
  function baseUrl() {
    const cfg = getConfig();
    const host = String(cfg.apiServerHost ?? '127.0.0.1');
    const port = Number(cfg.apiServerPort ?? 9092);
    return `http://${host}:${port}`;
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
    const url = baseUrl() + path;
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      const token = await resolveToken?.();
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
        return { ok: false, status: response.status, data, error: `HTTP ${response.status}${detail ? ': ' + detail : ''}` };
      }
      return { ok: true, status: response.status, data };
    } catch (err) {
      if (err?.name === 'AbortError') return { ok: false, error: `请求超时（${timeoutMs} ms）` };
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

  /** Probe the bridge API Server. @returns {Promise<object>} structured result */
  function health() {
    return request('/api/health', { timeoutMs: 5000 });
  }

  /** Ask the bridge to stop whatever the speaker is doing. @returns {Promise<object>} structured result */
  function interrupt() {
    return request('/api/interrupt', { method: 'POST', timeoutMs: 5000 });
  }

  return { baseUrl, request, playText, health, interrupt };
}
