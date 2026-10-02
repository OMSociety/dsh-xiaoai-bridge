/**
 * dsh-xiaoai-bridge: the last few things that went wrong, for the status card.
 *
 * A voice setup fails in places nobody is looking at: the bridge process exits,
 * the API Server refuses our token, someone calls the plugin with the wrong
 * bearer. Each of those is already logged, but a log line scrolls away and the
 * settings page has no way to say "this is what broke last".
 *
 * This module is that memory: callers report a *code* (a stable identifier the
 * settings page translates) plus the raw technical detail, and the newest few
 * are served to `/health`. Failures with the same code and detail collapse into
 * one row with a repeat count, so a playback loop cannot push the interesting
 * error off the end.
 *
 * Nothing here throws: a diagnostic path that can break the thing it is
 * describing is worse than no diagnostic path.
 * @module dsh-xiaoai-bridge/diagnostics
 */

/** How many entries the settings page can show. */
export const DEFAULT_LIMIT = 20;

/** Codes callers may report. The settings page translates each one. */
export const DIAGNOSTIC_CODES = Object.freeze([
  /** The bridge API Server did not answer at all (process down, wrong host/port). */
  'bridge-unreachable',
  /** The bridge API Server accepted the connection but not our token. */
  'bridge-rejected',
  /** Our own `/asr` route refused a caller's bearer token. */
  'plugin-rejected',
  /** The bridge answered with an error status. */
  'bridge-error',
  /** The request was sent but nothing came back in time. */
  'bridge-timeout',
  /** The supervisor could not start the bridge process. */
  'start-failed',
  /** The watchdog used up its restart budget and stopped trying. */
  'watchdog-gave-up',
  /** A listener the plugin was supposed to have killed is still answering. */
  'port-held',
]);

/**
 * Create the diagnostics store.
 *
 * @param {object} [options]
 * @param {object} [options.logger] host logger; entries are mirrored there
 * @param {number} [options.limit] entries to keep, newest first
 * @param {() => number} [options.now] clock, injectable for tests
 * @returns {{note: Function, recent: Function, last: Function, clear: Function}}
 */
export function createDiagnostics({ logger, limit = DEFAULT_LIMIT, now = () => Date.now() } = {}) {
  const keep = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  /** @type {Array<{time: string, code: string, detail: string, count: number}>} */
  const entries = [];

  function stamp() {
    try {
      return new Date(now()).toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  /**
   * Record one problem.
   *
   * Passing an unknown code is a bug in the caller, not a crash: the entry is
   * still stored (the card shows the code) and the log line names it.
   * @param {{code: string, detail?: string, level?: 'warn'|'error'}} entry what happened
   * @returns {object|null} the stored entry, or null when there was nothing to say
   */
  function note({ code, detail = '', level = 'error' } = {}) {
    const text = String(detail ?? '').trim().slice(0, 300);
    const name = String(code ?? '').trim();
    if (name.length === 0) return null;
    const time = stamp();

    const newest = entries[0];
    if (newest && newest.code === name && newest.detail === text) {
      newest.count += 1;
      newest.time = time;
      return newest;
    }

    const stored = { time, code: name, detail: text, count: 1 };
    const line = `dsh-xiaoai-bridge: ${name}${text ? ': ' + text : ''}`;
    if (level === 'warn') logger?.warn?.(line);
    else logger?.warn?.(line);
    entries.unshift(stored);
    if (entries.length > keep) entries.length = keep;
    return stored;
  }

  /**
   * The stored entries, newest first. Copies, so a reader that edits what it
   * gets back cannot rewrite the record for the next reader.
   * @returns {Array<object>} snapshots of the stored entries
   */
  function recent() {
    return entries.map((entry) => ({ ...entry }));
  }

  /** @returns {object|null} the newest entry, if any */
  function last() {
    return entries[0] ?? null;
  }

  /** Forget everything (a manual restart is the user saying "try again"). */
  function clear() {
    entries.length = 0;
  }

  return { note, recent, last, clear };
}
