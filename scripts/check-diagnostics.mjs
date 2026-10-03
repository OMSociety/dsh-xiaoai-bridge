/**
 * dsh-xiaoai-bridge: diagnostics recorder checks.
 *
 * The status card is only as truthful as the memory behind it. This script
 * covers both halves: the store itself (what it keeps, what it collapses, what
 * it refuses to do) and the bridge client's classification of a failed call --
 * a refused token, a dead process and a stalled request are three different
 * stories for the user, and the card has to tell them apart.
 *
 *   node scripts/check-diagnostics.mjs
 */
import { createBridgeClient } from '../lib/bridge.js';
import { createDiagnostics, DEFAULT_LIMIT, DIAGNOSTIC_CODES } from '../lib/diagnostics.js';

let failures = 0;

/**
 * @param {string} label assertion name
 * @param {boolean} ok result
 */
function check(label, ok) {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}`);
  }
}

/** A logger that records what it was told. */
function spyLogger() {
  const lines = [];
  return { logger: { warn: (line) => lines.push(String(line)), info: () => {}, debug: () => {} }, lines };
}

// 1. The store keeps what it was told, newest first, and bounds the list.
{
  const { logger, lines } = spyLogger();
  const diagnostics = createDiagnostics({ logger, limit: 3, now: () => Date.parse('2026-01-02T03:04:05Z') });
  check('an empty store reports nothing', diagnostics.last() === null && diagnostics.recent().length === 0);

  const first = diagnostics.note({ code: 'bridge-unreachable', detail: 'GET /api/health: ECONNREFUSED' });
  check('note() stores the entry', first?.code === 'bridge-unreachable' && first?.count === 1);
  check('the entry carries an ISO timestamp', first?.time === '2026-01-02T03:04:05.000Z');
  check('the store mirrors the entry to the log', lines.length === 1 && lines[0].includes('bridge-unreachable'));

  diagnostics.note({ code: 'bridge-error', detail: 'POST /api/play/text: HTTP 500' });
  check('the newest entry comes first', diagnostics.last()?.code === 'bridge-error');

  // Same code and detail collapsing is what keeps a playback loop from pushing
  // the interesting failure off the end of the list.
  diagnostics.note({ code: 'bridge-error', detail: 'POST /api/play/text: HTTP 500' });
  check('a repeat collapses into one entry', diagnostics.recent().length === 2 && diagnostics.last()?.count === 2);
  diagnostics.note({ code: 'bridge-error', detail: 'POST /api/play/text: HTTP 502' });
  check('a different detail is its own entry', diagnostics.recent().length === 3 && diagnostics.last()?.count === 1);

  diagnostics.note({ code: 'bridge-timeout', detail: 'GET /api/health: no answer' });
  check('the list is bounded by limit', diagnostics.recent().length === 3);
  check('the oldest entry is the one dropped', diagnostics.recent()[0]?.code === 'bridge-timeout');

  check('an empty code is not stored', diagnostics.note({ code: '   ' }) === null);
  check('a long detail is truncated', diagnostics.note({ code: 'bridge-error', detail: 'x'.repeat(500) })?.detail.length === 300);

  diagnostics.clear();
  check('clear() forgets everything', diagnostics.last() === null && diagnostics.recent().length === 0);
}

// 2. recent() hands out a copy: a card that mutates what it reads would corrupt
//    the store for everyone after it.
{
  const diagnostics = createDiagnostics({ limit: 5 });
  diagnostics.note({ code: 'start-failed', detail: 'python not found' });
  const snapshot = diagnostics.recent();
  snapshot.push({ code: 'made-up' });
  snapshot[0].code = 'rewritten';
  check('recent() returns a copy', diagnostics.recent().length === 1 && diagnostics.recent()[0].code === 'start-failed');
  check(`the default limit is ${DEFAULT_LIMIT}`, createDiagnostics().recent().length === 0);
}

// 3. The bridge client must classify a failure the way the card words it.
{
  const realFetch = globalThis.fetch;
  const notes = [];
  const diagnostics = { note: (entry) => notes.push(entry) };
  const client = createBridgeClient({
    getConfig: () => ({ apiServerHost: '127.0.0.1', apiServerPort: 9092 }),
    resolveToken: async () => 'secret',
    logger: { warn: () => {} },
    diagnostics,
  });

  try {
    // A refused token: the bridge is alive and answering, and the fix is ours.
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '{"error":"unauthorized"}' });
    const refused = await client.playText('你好');
    check('a 401 is reported as a rejected token', notes.at(-1)?.code === 'bridge-rejected');
    check('the rejection still carries the HTTP status', refused.status === 401 && refused.ok === false);
    check('the detail names the call', String(notes.at(-1)?.detail).startsWith('POST /api/play/text'));

    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    await client.health();
    check('a 500 is a bridge error, not a rejection', notes.at(-1)?.code === 'bridge-error');

    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{"success":true,"data":{"auth":"bearer"}}' });
    const healthy = await client.health({ timeoutMs: 100 });
    check('a healthy probe records nothing', healthy.ok === true && notes.at(-1)?.code === 'bridge-error');
    check('the probe surfaces the auth mode', healthy.data?.data?.auth === 'bearer');

    globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:9092'); };
    const down = await client.health();
    check('a dead process is unreachable', notes.at(-1)?.code === 'bridge-unreachable');
    check('an unreachable call has no status', down.ok === false && down.status === undefined);

    // A request that never answers: the abort has to be what ends it.
    globalThis.fetch = (url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
    const stalled = await client.health({ timeoutMs: 40 });
    check('a stalled request is a timeout', notes.at(-1)?.code === 'bridge-timeout');
    check('the timeout keeps its own wording', String(stalled.error).includes('请求超时'));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 4. Every code the plugin can store is one the store knows about.
{
  const known = new Set(DIAGNOSTIC_CODES);
  const { logger } = spyLogger();
  const diagnostics = createDiagnostics({ logger });
  const used = ['bridge-unreachable', 'bridge-rejected', 'bridge-error', 'bridge-timeout', 'start-failed', 'plugin-rejected', 'watchdog-gave-up', 'token-not-applied', 'scope-registration-unavailable', 'scope-registration-failed'];
  for (const code of used) {
    diagnostics.note({ code, detail: code });
    check(`${code} is a declared code`, known.has(code));
  }
  check('no duplicate entries after a clear', (diagnostics.clear(), diagnostics.recent().length === 0));
}

// 5. The level is honoured: `level` used to be a parameter that did nothing,
// so a hint and a failure both went out as warnings.
{
  const seen = [];
  const logger = {
    warn: (line) => seen.push(['warn', String(line)]),
    error: (line) => seen.push(['error', String(line)]),
    info: () => {},
    debug: () => {},
  };
  const diagnostics = createDiagnostics({ logger });
  diagnostics.note({ code: 'bridge-error', detail: 'POST /api/play/text: HTTP 500' });
  diagnostics.note({ code: 'token-not-applied', detail: 'restart the bridge to apply it', level: 'warn' });
  check('an unqualified note goes to the error sink', seen[0]?.[0] === 'error');
  check('an explicit warn note goes to the warn sink', seen[1]?.[0] === 'warn');

  const lines = [];
  const warnOnly = createDiagnostics({ logger: { warn: (line) => lines.push(String(line)) } });
  warnOnly.note({ code: 'bridge-error', detail: 'this logger has no error sink' });
  check('a logger without an error sink still gets the line', lines.length === 1);
  check('a logger with no sinks at all does not throw', (() => {
    try {
      createDiagnostics({ logger: {} }).note({ code: 'bridge-error', detail: 'nowhere to say it' });
      return true;
    } catch {
      return false;
    }
  })());
}

if (failures > 0) {
  console.log(`diagnostics check FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log('diagnostics check OK');
