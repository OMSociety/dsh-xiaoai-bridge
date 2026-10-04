/**
 * dsh-xiaoai-bridge: the Python bridge process supervisor.
 *
 * The bridge is a long-running child of the DSH host process. This module owns
 * its whole lifecycle: spawn with a fully explicit environment, stream
 * stdout/stderr into a bounded ring buffer plus an on-disk log, and tear the
 * whole process tree down on stop (the bridge forks short-lived children for
 * keyword generation and shell commands, so killing only the direct child
 * leaks orphans that keep holding the speaker's sockets).
 *
 * Nothing here reads the settings card by itself: the caller passes live
 * accessors, so a settings write reaches the next spawn without a restart.
 * @module dsh-xiaoai-bridge/process
 */
import { execFile, spawn } from 'node:child_process';
import {
  closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, truncateSync,
  unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { renderConfigPath, writeConfig } from './render-config.js';

/** Promise wrapper for the short-lived query processes this module runs. */
const execFileAsync = promisify(execFile);

/** Ring-buffer capacity for retained log lines. */
const MAX_LOG_LINES = 400;
/** Log file is rolled over to `bridge.log.1` once it grows past this. */
const MAX_LOG_BYTES = 8 * 1024 * 1024;
/** Grace period between a graceful signal and a forced tree kill. */
const KILL_GRACE_MS = 3000;
/** How often an adopted bridge's pid is re-checked for liveness. */
const ADOPTED_POLL_MS = 5000;
/**
 * Budget for the command-line lookup that confirms a pid is really our bridge.
 *
 * A cold `powershell.exe` on this class of machine can take ~700 ms before it
 * even answers, so 2 s left barely 2.7x of headroom: a slow start turned into
 * "could not read the command line", and the caller then had to decide blind.
 * Five seconds keeps the check honest without making a start feel hung.
 */
const IDENTITY_TIMEOUT_MS = 5000;
/**
 * Backoff between automatic restarts, in milliseconds.
 *
 * Lengthening rather than fixed: a bridge that dies because the speaker is
 * unplugged would otherwise be respawned in a tight loop, and each spawn costs a
 * Python interpreter and a microphone grab. The schedule doubles as the retry
 * budget -- once it is exhausted the watchdog stops instead of spinning.
 */
const DEFAULT_RESTART_DELAYS_MS = [2000, 5000, 15000, 30000];
/**
 * Rolling window used to judge a crash loop, in milliseconds.
 *
 * Replaces the older rule that reset the whole retry budget once a single run
 * lasted long enough: a bridge crash-looping every 61 s never ran short, so the
 * budget kept being handed back and the watchdog retried forever. Counting
 * crashes inside a fixed window bounds both the fast and the slow loop, and a
 * bridge that stays up longer than the window ages out of it on its own.
 */
const DEFAULT_CRASH_WINDOW_MS = 60 * 60 * 1000;
/** Directories never scanned when looking for changed bridge sources. */
const SOURCE_SKIP_DIRS = new Set(['.venv', 'venv', '__pycache__', 'node_modules', 'models', 'logs']);

/**
 * Split a stdout/stderr chunk into complete lines, carrying a partial tail over.
 * @param {{ tail: string }} carry mutable tail holder
 * @param {Buffer|string} chunk raw chunk
 * @returns {string[]} complete lines (no trailing newline)
 */
function drainLines(carry, chunk) {
  const text = carry.tail + chunk.toString('utf8');
  const parts = text.split(/\r?\n/);
  carry.tail = parts.pop() ?? '';
  return parts;
}

/**
 * Wait for a number of milliseconds.
 * @param {number} ms delay
 * @returns {Promise<void>} resolves after the delay
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Roll the log file over when it exceeds the cap, keeping one old generation.
 *
 * Called before each append rather than on a timer: the file only grows when
 * the bridge actually says something, which is exactly when this check matters.
 * Zeroing it in place (the previous behaviour) dropped the whole history at the
 * moment a long-running problem finally overflowed, which is when the history is
 * worth the most; `bridge.log.1` keeps exactly one generation, the same single
 * slot `spoken.jsonl.1` already uses.
 * @param {string} logPath absolute log file path
 */
function rotateIfOversized(logPath) {
  try {
    if (statSync(logPath).size <= MAX_LOG_BYTES) return;
    renameSync(logPath, `${logPath}.1`);
  } catch {
    // The file may not exist yet; appending creates it.
  }
}

/**
 * Whether a command line really runs a given script, rather than merely
 * containing its name.
 *
 * `commandLine.includes('main.py')` also matched `D:\tools\main.py.bak`,
 * `run-main.pyc` and anything else with the name inside it, so a recycled pid
 * that happened to mention the string was adopted and later tree-killed. The
 * script has to appear as a whole token: at the start, or after a path
 * separator, quote or space, and followed by a quote, space or the end.
 * @param {string} commandLine full command line of a live process
 * @param {string} script script file name recorded in the pid file
 * @returns {boolean} true when the script is one of the command's arguments
 */
function commandLineRuns(commandLine, script) {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\\\/\\s"'])${escaped}(["']|\\s|$)`).test(commandLine);
}

/**
 * Translate the live settings into the environment the bridge child needs.
 *
 * The bridge decides what to start from environment variables alone (see
 * `bridge/main.py`), so this is the single place that maps a setting to process
 * behaviour. Kept pure and exported so `scripts/check-config.mjs` can assert the
 * mapping without spawning anything. The secrets are deliberately absent: the
 * caller adds the API token and the Doubao Access Token from the DSH credential
 * store.
 *
 * @param {object} cfg resolved plugin settings
 * @param {string} configPath rendered `config.py` the child must load
 * @returns {Record<string,string>} environment overrides for the child
 */
export function bridgeChildEnv(cfg, configPath) {
  return {
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    // The bridge's logger reads `LOGLEVEL` (see bridge/core/utils/logger.py);
    // `LOG_LEVEL` was a dead knob that looked live in the settings card.
    LOGLEVEL: String(cfg.logLevel ?? 'INFO'),
    DSH_ENABLE: cfg.enabled ? '1' : '0',
    AUDIO_INPUT_ENABLE: '1',
    // "静默启动": the native side skips its "已连接" prompt when this is on.
    SILENT_START_ENABLE: cfg.silentStart ? '1' : '0',
    API_SERVER_ENABLE: cfg.apiServerEnabled ? '1' : '0',
    API_SERVER_HOST: String(cfg.apiServerHost ?? '127.0.0.1'),
    API_SERVER_PORT: String(cfg.apiServerPort ?? 9092),
    XIAOAI_DEVICE_NAME: String(cfg.deviceName ?? ''),
    XIAOAI_DEVICE_HOST: String(cfg.deviceHost ?? ''),
    // Point the child at the config this plugin renders, so the settings card
    // stays the single source of truth for wake words and routing.
    CONFIG_PATH: configPath,
  };
}

/**
 * Read one credential value out of whatever shape the store answers with.
 *
 * DSH Credentials is a seam with more than one implementation. The abstract
 * provider declares `resolve()` as returning a `{value, source}` record, so a
 * reader testing `typeof value === 'string'` sees "not configured" against a
 * conforming store -- and the caller then spawns the bridge without the secret.
 * Both shapes mean the same thing to this plugin: the text to use, or nothing
 * when the slot is empty. Kept pure and exported so a check can pin it down
 * without a live credential store.
 *
 * @param {unknown} resolved value returned by `ctx.credentials.resolve()`
 * @returns {string|null} the credential text, or null when there is none
 */
export function credentialText(resolved) {
  if (typeof resolved === 'string') return resolved.length > 0 ? resolved : null;
  if (resolved === null || typeof resolved !== 'object') return null;
  const value = resolved.value;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Create the bridge supervisor.
 *
 * The API Server is meant to be always on: a proactive line from
 * `xiaoai_speak` has nobody watching the settings card, so a bridge that died
 * on its own is brought back (see {@link scheduleRestart}) and can also be
 * requested on demand (see {@link ensureStarted}).
 *
 * @param {object} options
 * @param {() => object} options.getConfig live settings projection
 * @param {() => {bridgeDir: string, pythonPath: string}} options.paths resolved filesystem locations
 * @param {string} options.dataDir plugin data directory (log + pid files)
 * @param {object} [options.logger] host logger
 * @param {() => Promise<string|null>} [options.resolveToken] reads the API bearer token from DSH credentials
 * @param {() => Promise<string|null>} [options.resolveDoubaoKey] reads the Doubao Access Token from DSH credentials
 * @param {(text: string) => void} [options.onLogLine] called for every complete log line
 * @param {number[]} [options.restartDelaysMs] watchdog backoff schedule, one delay per attempt
 * @param {number} [options.crashWindowMs] window used to count a crash loop
 * @returns {object} supervisor handle
 */
export function createBridgeSupervisor({
  getConfig, paths, dataDir, logger, resolveToken, resolveDoubaoKey, onLogLine,
  restartDelaysMs = DEFAULT_RESTART_DELAYS_MS,
  crashWindowMs = DEFAULT_CRASH_WINDOW_MS,
}) {
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  /**
   * In-flight start, so overlapping callers share one spawn.
   *
   * Two callers used to run the whole start sequence concurrently and interleave
   * between the `running()` check and the spawn: two bridges fighting for one
   * speaker, and an exit handler that wiped the state of a process it no longer
   * owned. Every later call now awaits the attempt already running.
   * @type {Promise<object>|null}
   */
  let starting = null;
  const lines = [];
  let startedAt = null;
  let exitCode = null;
  let exitSignal = null;
  let lastError = null;
  /** Set while a deliberate stop is in flight, so exit is not reported as a crash. */
  let stopping = false;
  /**
   * Pid of a bridge this supervisor did not spawn but adopted from the pid file.
   *
   * DSH can die without running plugin teardown (crash, force-quit, debugger
   * stop), which leaves the Python bridge holding localhost:9092 and the
   * speaker's socket on 4399. Without adoption the next start would spawn a
   * second bridge that immediately fails to bind, so a live pid file is treated
   * as "already running" and the existing process is driven instead.
   * @type {number|null}
   */
  let adoptedPid = null;
  /**
   * Whether the adopted pid's command line was actually read and matched.
   *
   * An unreadable command line (a slow `powershell.exe`, a locked-down host)
   * still adopts: the alternative is a second bridge that cannot bind. But the
   * teardown path must not take the whole tree down on that pid's word alone,
   * so this flag narrows the kill to the single process.
   */
  let adoptedVerified = false;
  /** Re-check timer that notices an adopted bridge dying. */
  let adoptedWatch = null;
  /** Epoch ms of each unexpected exit inside the crash window, oldest first. */
  let crashTimes = [];
  /** Said once: the host never handed over a token resolver (a wiring bug). */
  let missingResolverWarned = false;
  /** Pending watchdog timer, when a restart is scheduled. */
  let restartTimer = null;
  /** Epoch ms of the scheduled restart, for health reporting. */
  let nextRestartAt = null;
  /**
   * Set once the watchdog has spent its retry budget on a crash loop.
   *
   * Cleared by an explicit `start()` -- the user pressing start is the signal
   * that whatever killed the bridge has been dealt with -- but never by the
   * watchdog itself, which is what stops a broken bridge from respawning
   * forever.
   */
  let gaveUp = false;

  const logPath = join(dataDir, 'bridge.log');
  const pidPath = join(dataDir, 'bridge.pid');

  function ensureDataDir() {
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch (err) {
      lastError = `cannot create data directory ${dataDir}: ${String(err?.message ?? err)}`;
    }
  }

  /** @param {number} pid candidate process id @returns {boolean} whether it is alive */
  function isAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means the process exists but belongs to another user.
      return err?.code === 'EPERM';
    }
  }

  /**
   * Identity of the bridge this supervisor spawns, stored next to its pid.
   *
   * A bare pid is not an identity: Windows recycles pids aggressively and the
   * teardown path kills a whole process tree, so adopting a stranger's pid takes
   * unrelated processes down with it. The recorded interpreter plus the script
   * name are what the adoption check matches against the live command line.
   * @returns {{script: string, pythonPath: string, bridgeDir: string}} identity record
   */
  function bridgeIdentity() {
    const { bridgeDir, pythonPath } = paths();
    return { script: 'main.py', pythonPath, bridgeDir };
  }

  /**
   * Read the pid file, accepting both the current JSON record and the bare
   * number written by earlier versions, so an upgrade still adopts the bridge
   * that is already holding the speaker.
   * @returns {{pid: number, identity: object|null, recordedAt: string|null}|null} record, when a live pid is on file
   */
  function readPidRecord() {
    let raw;
    try {
      raw = readFileSync(pidPath, 'utf8').trim();
    } catch {
      return null;
    }
    if (raw === '') return null;
    let pid = null;
    let identity = null;
    let recordedAt = null;
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        pid = Number(parsed?.pid);
        identity = parsed?.identity ?? null;
        recordedAt = typeof parsed?.recordedAt === 'string' ? parsed.recordedAt : null;
      } catch {
        return null;
      }
    } else {
      pid = Number.parseInt(raw, 10);
    }
    if (!isAlive(pid)) return null;
    return { pid, identity, recordedAt };
  }

  /**
   * Ask the OS for a pid's command line.
   *
   * Windows-only: the question this answers ("is the pid in my file really the
   * bridge?") exists because Windows recycles pids and our teardown kills trees.
   * `null` means "could not find out", which callers treat as unverified rather
   * than verified.
   * @param {number} pid process id
   * @returns {Promise<string|null>} command line, or null when unreadable
   */
  async function commandLineOf(pid) {
    if (process.platform !== 'win32') return null;
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile', '-NonInteractive', '-Command',
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
        ],
        { timeout: IDENTITY_TIMEOUT_MS, windowsHide: true },
      );
      const text = String(stdout ?? '').trim();
      return text === '' ? null : text;
    } catch (err) {
      record('plugin', `command line lookup for pid=${pid} failed: ${String(err?.message ?? err)}`);
      return null;
    }
  }

  /**
   * Decide whether a pid recorded by an earlier run is still the bridge.
   *
   * A record written by this version must match both the interpreter and
   * `main.py` as a command-line *token*; a bare pid from an older version is
   * matched on `main.py` alone, which still rules out the ordinary "the pid now
   * belongs to something else" case. When the command line cannot be read at all,
   * adoption still proceeds -- a live bridge holding the ports is worth more than
   * a second bridge that cannot bind -- but the verdict says `verified: false`,
   * and the teardown path narrows to a single-process kill for those pids.
   * @param {{pid: number, identity: object|null}} record pid-file record
   * @returns {Promise<{ok: boolean, verified: boolean, reason: string}>} verdict plus a loggable reason
   */
  async function verifyBridgeIdentity(record) {
    const commandLine = await commandLineOf(record.pid);
    if (commandLine === null) {
      return {
        ok: true,
        verified: false,
        reason: `could not read the command line of pid=${record.pid}; adopting without verifying it`,
      };
    }
    const script = record.identity?.script ?? 'main.py';
    const expectedPython = record.identity?.pythonPath ?? null;
    const hasScript = commandLineRuns(commandLine, script);
    const hasPython = expectedPython === null || commandLine.includes(expectedPython);
    if (hasScript && hasPython) {
      return {
        ok: true,
        verified: true,
        reason: expectedPython === null
          ? 'command line still runs main.py (legacy pid file)'
          : 'command line matches the recorded interpreter and script',
      };
    }
    return {
      ok: false,
      verified: false,
      reason: `pid=${record.pid} is alive but its command line is not our bridge: ${commandLine.slice(0, 200)}`,
    };
  }

  /**
   * Persist the pid together with enough identity to recognise it after a DSH
   * restart. A pid without a pid file is a process nobody can adopt.
   *
   * Written through `bridge.pid.tmp` and renamed into place: a reader that
   * arrives mid-write used to see a half-written record, and its parser then
   * reported "no pid file" for a bridge that was in fact running.
   * @param {number|undefined} pid pid to persist
   * @param {object} [identity] identity record; defaults to the current paths
   */
  function writePidFile(pid, identity = bridgeIdentity()) {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      // Refuse instead of writing "undefined": that file used to make the next
      // start adopt a pid that never existed.
      record('plugin', `not writing a pid file without a real pid (got ${String(pid)})`);
      return;
    }
    try {
      ensureDataDir();
      const payload = { pid, identity, recordedAt: new Date().toISOString() };
      const tempPath = `${pidPath}.tmp`;
      writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, 'utf8');
      renameSync(tempPath, pidPath);
    } catch (err) {
      record('plugin', `cannot write pid file: ${String(err?.message ?? err)}`);
    }
  }

  /** Stop re-checking an adopted bridge. */
  function clearAdoptedWatch() {
    if (adoptedWatch === null) return;
    clearInterval(adoptedWatch);
    adoptedWatch = null;
  }

  /**
   * Re-check an adopted bridge for as long as this supervisor drives it.
   *
   * An adopted process is not our child, so no `exit` event ever arrives: its
   * death used to be invisible, and the plugin kept reporting a running bridge
   * that no longer held the speaker or the port.
   * @param {number} pid adopted process id
   */
  function watchAdopted(pid) {
    if (adoptedWatch !== null) return;
    adoptedWatch = setInterval(() => {
      if (adoptedPid === null || isAlive(adoptedPid)) return;
      const gone = adoptedPid;
      adoptedPid = null;
      adoptedVerified = false;
      startedAt = null;
      clearAdoptedWatch();
      clearPidFile();
      lastError = `adopted bridge pid=${gone} exited unexpectedly`;
      record('plugin', lastError);
      scheduleRestart(`(adopted pid=${gone}) exited unexpectedly`);
    }, ADOPTED_POLL_MS);
    // Never hold the host process open just to watch a bridge.
    adoptedWatch.unref?.();
  }

  function clearPidFile() {
    try {
      unlinkSync(pidPath);
    } catch {
      // Already gone, or never written.
    }
  }

  /**
   * Newest `.py` mtime under a directory tree, skipping vendored data.
   * @param {string} root directory to walk
   * @returns {number} newest mtimeMs, or 0 when nothing was readable
   */
  function newestSourceMtime(root) {
    let newest = 0;
    const pending = [root];
    while (pending.length > 0) {
      const dir = pending.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SOURCE_SKIP_DIRS.has(entry.name)) pending.push(full);
          continue;
        }
        if (!entry.name.endsWith('.py')) continue;
        try {
          const mtime = statSync(full).mtimeMs;
          if (mtime > newest) newest = mtime;
        } catch {
          // Unreadable: it cannot be newer than what we already saw.
        }
      }
    }
    return newest;
  }

  /**
   * True when bridge sources on disk are newer than the pid file.
   *
   * Adopting a leftover bridge is deliberate -- it holds the speaker's socket
   * and both ports, so a DSH that died without teardown should hand over rather
   * than collide. But adopting it also adopts its Python modules, and only
   * `config.py` is hot reloaded: `.py` code is not. Without this check a code
   * fix looks applied on the next start and silently is not, which costs a
   * whole round trip of "I already fixed that".
   * @returns {boolean} true when the adopted process is running replaced code
   */
  function adoptedCodeIsStale() {
    let pidMtime;
    try {
      pidMtime = statSync(pidPath).mtimeMs;
    } catch {
      return false;
    }
    const { bridgeDir } = paths();
    let newest = newestSourceMtime(join(bridgeDir, 'core'));
    try {
      const mainMtime = statSync(join(bridgeDir, 'main.py')).mtimeMs;
      if (mainMtime > newest) newest = mainMtime;
    } catch {
      // main.py missing: nothing to compare against.
    }
    return newest > pidMtime;
  }

  /**
   * Append one log line to the ring buffer, the on-disk log, and the host log.
   * @param {string} source 'out' | 'err' | 'plugin'
   * @param {string} line one line of text
   */
  function record(source, line) {
    const stamped = `${new Date().toISOString()} [${source}] ${line}`;
    lines.push(stamped);
    if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
    try {
      rotateIfOversized(logPath);
      const handle = openSync(logPath, 'a');
      try {
        writeSync(handle, stamped + '\n');
      } finally {
        closeSync(handle);
      }
    } catch {
      // Logging must never take the bridge down.
    }
    try {
      onLogLine?.(stamped);
    } catch {
      // A misbehaving consumer must not break the stream reader.
    }
  }

  /**
   * Whether the bridge process is currently alive.
   *
   * Deliberately pure: it is called from health reporting, from `start`, and
   * from `stop`, and a predicate that quietly cleared state (or rescheduled a
   * restart) made those callers disagree about what was running. An adopted
   * bridge is cleaned up by its own watcher instead.
   * @returns {boolean} true while a child or an adopted pid is alive
   */
  function running() {
    if (child !== null && child.exitCode === null && !child.killed) return true;
    if (adoptedPid !== null) return isAlive(adoptedPid);
    return false;
  }

  /** Cancel a scheduled watchdog restart, if one is pending. */
  function clearRestartTimer() {
    if (restartTimer === null) return;
    clearTimeout(restartTimer);
    restartTimer = null;
    nextRestartAt = null;
  }

  /**
   * Whether the watchdog is allowed to bring the bridge back by itself.
   *
   * Only while the plugin owns the process: `autoStart` off means the user runs
   * the bridge their own way, so respawning it would fight them.
   * @returns {boolean} true when automatic restarts are in scope
   */
  function watchdogActive() {
    const cfg = getConfig();
    return cfg.enabled !== false && cfg.autoStart !== false && !gaveUp && !stopping;
  }

  /**
   * Schedule one automatic restart after the bridge died on its own.
   *
   * The budget is a rolling window of crashes, not a streak: every unexpected
   * exit inside `crashWindowMs` counts, so a bridge that dies every minute runs
   * out just like one that dies every second. The delay for this attempt comes
   * from its position in the schedule.
   * @param {string} reason what happened, in words, for the log
   */
  function scheduleRestart(reason) {
    if (restartTimer !== null) return;
    if (!watchdogActive()) return;
    const now = Date.now();
    const windowMs = Math.max(1000, Number(crashWindowMs) || DEFAULT_CRASH_WINDOW_MS);
    crashTimes = crashTimes.filter((at) => now - at < windowMs);
    if (crashTimes.length >= restartDelaysMs.length) {
      gaveUp = true;
      lastError = `bridge ${reason}; the watchdog stopped after ${crashTimes.length} restarts in ${Math.round(windowMs / 60_000)} minutes`;
      record('plugin', lastError);
      logger?.warn?.(`dsh-xiaoai-bridge: ${lastError}`);
      return;
    }
    const delay = Math.max(0, Number(restartDelaysMs[crashTimes.length]) || 0);
    crashTimes.push(now);
    nextRestartAt = now + delay;
    record('plugin', `bridge ${reason}; restart #${crashTimes.length} in ${delay} ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      nextRestartAt = null;
      void (async () => {
        const result = await start({ fromWatchdog: true });
        // A start that never produced a process fires no exit event, so the
        // watchdog has to ask for the next attempt itself.
        if (!result.ok) scheduleRestart(`refused to start: ${String(result.error ?? 'unknown')}`);
      })().catch((err) => {
        record('plugin', `watchdog restart failed: ${String(err?.message ?? err)}`);
      });
    }, delay);
    // Never hold the host process open for a restart that may be minutes away.
    restartTimer.unref?.();
  }

  /**
   * Resolve the child environment from the live settings.
   *
   * The three removed connectors are explicitly cleared rather than merely not
   * set: they may linger in the interactive shell's environment, and a stray
   * `OPENAI_ENABLE` would silently start a second backend.
   * @returns {Promise<Record<string,string>>} child environment
   */
  async function childEnv() {
    const cfg = getConfig();
    const env = {
      ...process.env,
      ...bridgeChildEnv(cfg, renderConfigPath(dataDir)),
    };
    for (const dead of ['XIAOZHI_ENABLE', 'OPENCLAW_ENABLE', 'OPENCLAW_ENABLED', 'QWENPAW_ENABLE']) {
      delete env[dead];
    }
    // The dsh connector is the only backend this fork ships; clearing the rest
    // guarantees that even a stale OPENAI_ENABLE cannot add a second route.
    delete env.OPENAI_ENABLE;

    let token = null;
    if (typeof resolveToken !== 'function') {
      // A wiring mistake, not a settings problem: the host forgot to hand the
      // resolver over, and the child would silently come up without a bearer
      // token while `/asr` still demands one. Say so instead of spawning mute.
      if (!missingResolverWarned) {
        missingResolverWarned = true;
        record('plugin', 'no token resolver was handed to the supervisor; the bridge will start without XIAOAI_API_TOKEN');
      }
    } else {
      try {
        token = (await resolveToken()) ?? null;
      } catch (err) {
        record('plugin', `credential lookup failed: ${String(err?.message ?? err)}`);
      }
    }
    if (typeof token === 'string' && token.length > 0) env.XIAOAI_API_TOKEN = token;
    else delete env.XIAOAI_API_TOKEN;

    // The same token also guards the port the speaker dials (4399) when
    // 「音箱连接鉴权」 is on: the Rust server compares what the device presents
    // against DSH_XIAOAI_TOKEN and refuses the handshake without it. Cleared
    // rather than merely not set when the switch is off, so a value inherited
    // from the interactive shell cannot silently re-arm the check.
    if (getConfig()?.speakerAuth !== false && typeof token === 'string' && token.length > 0) {
      env.DSH_XIAOAI_TOKEN = token;
    } else {
      delete env.DSH_XIAOAI_TOKEN;
    }

    let doubaoKey = null;
    if (typeof resolveDoubaoKey === 'function') {
      try {
        // Normalised here as well as in the resolver that feeds it: whoever
        // supplies this hook, the child gets the text and not a `{value, source}`
        // record stringified into `DOUBAO_ACCESS_KEY`.
        doubaoKey = credentialText(await resolveDoubaoKey());
      } catch (err) {
        record('plugin', `Doubao credential lookup failed: ${String(err?.message ?? err)}`);
      }
    }
    // The Doubao Access Token rides the environment for the same reason the API
    // token does: the generated config.py is a plain file, and a credential the
    // bridge reads from `tts.doubao.access_key` would have to be written into it.
    // An unresolved credential leaves the inherited value alone, so a token set
    // by hand in the environment still works.
    if (typeof doubaoKey === 'string' && doubaoKey.length > 0) env.DOUBAO_ACCESS_KEY = doubaoKey;
    return env;
  }

  /**
   * Render the settings into the `config.py` the child loads.
   *
   * Called before every spawn and after every settings write, so the bridge's
   * one-second config watcher picks the change up and hot-reloads: wake words
   * included, because `core/services/audio/kws` regenerates the keyword file and
   * rebuilds the spotter when `wakeup.keywords` changes.
   * @returns {{ok: boolean, path?: string, error?: string}} render outcome
   */
  function renderConfig() {
    try {
      const { bridgeDir } = paths();
      const result = writeConfig({
        dataDir,
        templatePath: join(bridgeDir, 'config.py'),
        cfg: getConfig(),
      });
      return { ok: true, path: result.path };
    } catch (err) {
      const message = `config render failed: ${String(err?.message ?? err)}`;
      lastError = message;
      record('plugin', message);
      return { ok: false, error: message };
    }
  }

  /**
   * Wait for a pid to disappear, in small steps.
   * @param {number} pid process id
   * @param {number} ms how long to wait
   * @returns {Promise<boolean>} true once the pid is gone
   */
  async function waitGone(pid, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && isAlive(pid)) await sleep(100);
    return !isAlive(pid);
  }

  /**
   * Start the bridge process.
   *
   * Overlapping callers share the attempt that is already running: the settings
   * card, the host load, and the watchdog can all ask at once, and two of them
   * interleaving between the `running()` check and the spawn produced two
   * bridges for one speaker plus an exit handler that cleared the state of a
   * process it no longer owned.
   * @param {object} [options]
   * @param {boolean} [options.fromWatchdog] true when this call is itself a
   *   watchdog retry, which must not hand back a fresh retry budget
   * @returns {Promise<{ok: boolean, pid?: number, error?: string, already?: boolean}>}
   */
  async function start({ fromWatchdog = false } = {}) {
    if (starting !== null) return starting;
    if (!fromWatchdog) {
      // An explicit start (settings card, host load) means the user is asking
      // for the bridge now: forget the crash window instead of staying
      // given-up forever.
      clearRestartTimer();
      crashTimes = [];
      gaveUp = false;
    }
    starting = doStart();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  /**
   * Body of one start attempt; callers reach it through `start()`.
   * @returns {Promise<{ok: boolean, pid?: number, error?: string, already?: boolean, adopted?: boolean}>} start outcome
   */
  async function doStart() {
    if (!getConfig().enabled) return { ok: false, error: 'plugin disabled' };
    if (running()) return { ok: true, pid: child?.pid ?? adoptedPid, already: true };

    ensureDataDir();
    renderConfig();

    // Resolved once, before the adoption branch: the identity written into the
    // pid file has to describe the interpreter this start actually spawns. Asking
    // `paths()` again later let a settings write mid-start record an interpreter
    // that was never launched, and the next start then refused its own bridge.
    const { bridgeDir, pythonPath } = paths();

    // A pid file left by a DSH that died without teardown means the bridge is
    // already up (and already holds both ports). Adopt instead of colliding --
    // but only after checking that the pid is still *ours*: Windows recycles
    // pids, and the teardown path kills whole trees, so adopting a stranger's
    // pid (or killing it) takes unrelated processes down with it.
    const stale = readPidRecord();
    if (stale !== null) {
      const verdict = await verifyBridgeIdentity(stale);
      record('plugin', `pid file pid=${stale.pid}: ${verdict.reason}`);
      if (!verdict.ok) {
        record('plugin', `not adopting pid=${stale.pid}; leaving that process alone`);
        clearPidFile();
      } else if (!adoptedCodeIsStale()) {
        adoptedPid = stale.pid;
        adoptedVerified = verdict.verified;
        // Fresh timestamp: the adopted process did not start when *we* did.
        startedAt = new Date().toISOString();
        clearAdoptedWatch();
        watchAdopted(stale.pid);
        record('plugin', `adopted running bridge pid=${stale.pid} from ${pidPath}${verdict.verified ? '' : ' (identity unverified)'}`);
        logger?.info?.(`dsh-xiaoai-bridge: adopted running bridge (pid=${stale.pid})`);
        return { ok: true, pid: stale.pid, adopted: true };
      } else {
        record('plugin', `bridge sources changed since pid=${stale.pid} started; replacing it`);
        stopping = true;
        clearAdoptedWatch();
        // Same rule as stop(): an unverified pid does not get a tree kill.
        killTree(stale.pid, { force: false, tree: verdict.verified });
        let gone = await waitGone(stale.pid, KILL_GRACE_MS);
        if (!gone) {
          record('plugin', `stale bridge pid=${stale.pid} ignored the graceful kill; forcing tree kill`);
          killTree(stale.pid, { force: true, tree: verdict.verified });
          gone = await waitGone(stale.pid, KILL_GRACE_MS);
        }
        stopping = false;
        if (!gone) {
          lastError = `stale bridge pid=${stale.pid} did not exit; refusing to start a second one`;
          record('plugin', lastError);
          return { ok: false, error: lastError };
        }
        adoptedPid = null;
        adoptedVerified = false;
      }
    }
    // Nothing about a previously adopted process is true past this point: either
    // it was not ours (no pid file at all, or the identity check refused it) or
    // we just killed it. Leaving `adoptedPid`/`adoptedWatch` set would let that
    // watcher see the dead pid *after* the replacement writes its own pid file,
    // and then clear that file -- leaving a running bridge unadoptable after the
    // next crash -- plus overwrite `startedAt` and report a phantom exit.
    adoptedPid = null;
    adoptedVerified = false;
    clearAdoptedWatch();
    clearPidFile();

    let env;
    try {
      env = await childEnv();
    } catch (err) {
      lastError = `environment build failed: ${String(err?.message ?? err)}`;
      return { ok: false, error: lastError };
    }

    stopping = false;
    exitCode = null;
    exitSignal = null;
    lastError = null;

    let proc;
    try {
      proc = spawn(pythonPath, ['main.py'], {
        cwd: bridgeDir,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX: become a process-group leader so killTree can signal the whole
        // group; the bridge forks grandchildren that keep the speaker's socket.
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      lastError = `spawn failed: ${String(err?.message ?? err)}`;
      record('plugin', lastError);
      scheduleRestart(`failed to spawn: ${lastError}`);
      return { ok: false, error: lastError };
    }
    child = proc;

    startedAt = new Date().toISOString();
    const outCarry = { tail: '' };
    const errCarry = { tail: '' };
    /**
     * Emit whatever partial line is still buffered.
     *
     * A child killed mid-line leaves its last words without a newline; without
     * this they were dropped from the log exactly when they mattered most.
     */
    const flushCarries = () => {
      for (const [source, carry] of [['out', outCarry], ['err', errCarry]]) {
        if (carry.tail === '') continue;
        const text = carry.tail;
        carry.tail = '';
        record(source, text);
      }
    };
    proc.stdout?.on('data', (chunk) => {
      for (const line of drainLines(outCarry, chunk)) record('out', line);
    });
    proc.stderr?.on('data', (chunk) => {
      for (const line of drainLines(errCarry, chunk)) record('err', line);
    });
    proc.on('error', (err) => {
      lastError = `process error: ${String(err?.message ?? err)}`;
      record('plugin', lastError);
    });
    proc.on('exit', (code, signal) => {
      flushCarries();
      const pid = proc.pid;
      // An exit from a process this supervisor no longer owns belongs to a
      // previous generation: clearing state for it would erase the pid of the
      // bridge that is actually running. `exitCode`/`exitSignal` are part of that
      // state, so they are only recorded for the generation we still own.
      if (child !== proc) {
        record('plugin', `ignoring stale exit pid=${pid} code=${code} signal=${signal ?? 'none'}`);
        return;
      }
      exitCode = code;
      exitSignal = signal;
      child = null;
      clearPidFile();
      record('plugin', `bridge exited pid=${pid} code=${code} signal=${signal ?? 'none'}${stopping ? ' (requested)' : ''}`);
      if (!stopping) {
        lastError = `bridge exited unexpectedly (code=${code})`;
        scheduleRestart(`exited unexpectedly (code=${code})`);
      }
    });

    // Do not report success until the process really exists. `spawn` only queues
    // the attempt, so a wrong pythonPath used to answer `ok: true` with an
    // undefined pid, and the failure arrived later as an 'error' event that no
    // part of the watchdog was listening for: no retry, no give-up, and a pid
    // file containing the text "undefined".
    const spawned = await new Promise((resolve) => {
      const onSpawn = () => {
        proc.off('error', onError);
        resolve({ ok: true });
      };
      const onError = (err) => {
        proc.off('spawn', onSpawn);
        resolve({ ok: false, error: err });
      };
      proc.once('spawn', onSpawn);
      proc.once('error', onError);
    });
    if (!spawned.ok) {
      if (child === proc) child = null;
      lastError = `spawn failed: ${String(spawned.error?.message ?? spawned.error)}`;
      record('plugin', lastError);
      scheduleRestart(`failed to spawn: ${lastError}`);
      return { ok: false, error: lastError };
    }

    writePidFile(proc.pid, { script: 'main.py', pythonPath, bridgeDir });
    record('plugin', `bridge started pid=${proc.pid} cwd=${bridgeDir}`);
    logger?.info?.(`dsh-xiaoai-bridge: bridge started (pid=${proc.pid})`);
    return { ok: true, pid: proc.pid };
  }

  /**
   * Start the bridge on demand, for a caller that needs the API Server *now*.
   *
   * `xiaoai_speak` is why this exists: a proactive line has no user looking at
   * the settings card, so the tool asks for a bridge instead of reporting a dead
   * one. Deliberately narrower than `start()`: with autostart off the user runs
   * the bridge their own way, and a crash loop the watchdog already gave up on
   * is not restarted by a tool call either.
   * @returns {Promise<{ok: boolean, already?: boolean, pid?: number, error?: string}>} start outcome
   */
  async function ensureStarted() {
    if (running()) return { ok: true, already: true, pid: child?.pid ?? adoptedPid ?? undefined };
    const cfg = getConfig();
    if (cfg.enabled === false) return { ok: false, error: 'plugin disabled' };
    if (cfg.autoStart === false) return { ok: false, error: 'bridge is not running (autostart is off)' };
    if (gaveUp) return { ok: false, error: lastError ?? 'bridge keeps exiting' };
    return start({ fromWatchdog: true });
  }

  /**
   * Kill a process tree by pid, politely first.
   *
   * `child.kill()` reaches only the direct child. The bridge forks real
   * grandchildren (keyword generation, `run_shell` helpers), and an orphaned
   * grandchild keeps the speaker's WebSocket and port 9092 held, which makes the
   * next start fail with "address in use".
   * @param {number} pid process id
   * @param {object} [options]
   * @param {boolean} [options.force] true for the hammer; false asks the process
   *   to close its sockets and exit on its own first. POSIX only -- Windows
   *   always terminates forcefully, see the platform note inside.
   * @param {boolean} [options.tree] true to take the whole tree down. Pass false
   *   for a pid whose command line was never read: that pid is probably our
   *   bridge, but killing its children by pid on a guess is how unrelated
   *   processes die.
   */
  function killTree(pid, { force = true, tree = true } = {}) {
    if (process.platform === 'win32') {
      // Windows has no SIGTERM for a console child: `taskkill` without `/F` only
      // posts WM_CLOSE to a windowed app, and the bridge is a console process, so
      // the "graceful" pass always failed ("can only be terminated forcefully")
      // and burned the whole grace period before the hammer ran anyway. Go
      // straight to `/F`; a dead process's sockets are closed by the OS either
      // way, which is what releases port 9092 and the speaker's WebSocket.
      const args = ['/pid', String(pid), ...(tree ? ['/T'] : []), '/F'];
      try {
        const killer = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
        // `spawn` reports a missing `taskkill` asynchronously; without this the
        // failure was an unhandled 'error' event on a child nobody watched.
        killer.on('error', (err) => {
          record('plugin', `taskkill pid=${pid} failed: ${String(err?.message ?? err)}`);
        });
        killer.unref?.();
      } catch (err) {
        record('plugin', `taskkill pid=${pid} failed: ${String(err?.message ?? err)}`);
      }
      return;
    }
    const signal = force ? 'SIGKILL' : 'SIGTERM';
    if (!tree) {
      try { process.kill(pid, signal); } catch { /* already gone */ }
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      try { process.kill(pid, signal); } catch { /* already gone */ }
    }
  }

  /**
   * Stop the bridge, waiting for the tree to actually go away.
   * @returns {Promise<{ok: boolean, stopped?: boolean, error?: string}>}
   */
  async function stop() {
    // Before the early return: a restart scheduled while the bridge was already
    // down would otherwise fire after this stop and bring it back up.
    clearRestartTimer();
    // Join an in-flight start first: killing a child that is still being spawned
    // lets the spawn complete afterwards, and the bridge comes back by itself.
    if (starting !== null) {
      try {
        await starting;
      } catch {
        // The start reports its own failure; a stop still has to proceed.
      }
    }
    // An adopted bridge that died inside the poll window leaves `adoptedPid` set
    // while `running()` already answers false. Returning here would leave the
    // watcher armed, and its next tick would report a crash -- and restart the
    // bridge -- right after an explicit stop.
    if (adoptedPid !== null && !isAlive(adoptedPid)) {
      const gone = adoptedPid;
      adoptedPid = null;
      adoptedVerified = false;
      startedAt = null;
      clearAdoptedWatch();
      clearPidFile();
      record('plugin', `adopted bridge pid=${gone} was already gone; clearing its record`);
    }
    if (!running()) return { ok: true, stopped: false };
    if (child === null) {
      // Adopted process: no exit event will arrive, so poll liveness instead.
      const pid = adoptedPid;
      // A pid whose command line was never read gets a single-process kill: its
      // children are a guess, and `/T` on a guess takes strangers down with it.
      const tree = adoptedVerified;
      stopping = true;
      clearAdoptedWatch();
      record('plugin', `stopping adopted bridge pid=${pid}${tree ? '' : ' (identity unverified: no tree kill)'}`);
      killTree(pid, { force: false, tree });
      let gone = await waitGone(pid, KILL_GRACE_MS);
      if (!gone) {
        record('plugin', `adopted bridge pid=${pid} survived the graceful kill; forcing tree kill`);
        killTree(pid, { force: true, tree });
        gone = await waitGone(pid, KILL_GRACE_MS);
      }
      if (!gone) {
        stopping = false;
        lastError = `adopted bridge pid=${pid} did not exit`;
        return { ok: false, error: lastError };
      }
      adoptedPid = null;
      adoptedVerified = false;
      startedAt = null;
      stopping = false;
      clearPidFile();
      return { ok: true, stopped: true };
    }
    const proc = child;
    const pid = proc.pid;
    stopping = true;
    record('plugin', `stopping bridge pid=${pid}`);
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    killTree(pid, { force: false });
    await Promise.race([exited, sleep(KILL_GRACE_MS)]);
    if (running()) {
      record('plugin', `bridge pid=${pid} survived the graceful kill; forcing tree kill`);
      killTree(pid, { force: true });
      await Promise.race([exited, sleep(KILL_GRACE_MS)]);
    }
    if (running()) {
      // Keep the handle rather than dropping it: a process that survived the
      // tree kill still holds the speaker and port 9092, so the next start has
      // to see it, and a later stop has to be able to try again.
      stopping = false;
      lastError = `bridge pid=${pid} did not exit`;
      return { ok: false, error: lastError };
    }
    // Clear the flag here as well: start() also clears it, so without this a
    // successful stop leaves state() reporting `stopping: true` while idle.
    stopping = false;
    clearPidFile();
    return { ok: true, stopped: true };
  }

  /**
   * Stop then start.
   * @returns {Promise<object>} the start result
   */
  async function restart() {
    await stop();
    return start();
  }

  /** Current supervisor state for health reporting. */
  function state() {
    const cfg = getConfig();
    // Ask once: `running()` used to be called three times, and each call could
    // observe a different process as state changed under it.
    const isRunning = running();
    return {
      managed: cfg.autoStart !== false,
      running: isRunning,
      pid: isRunning ? (child?.pid ?? adoptedPid) : null,
      adopted: child === null && adoptedPid !== null,
      startedAt,
      exitCode,
      exitSignal,
      stopping,
      lastError,
      logFile: logPath,
      pidFile: pidPath,
      /** Automatic restarts spent inside the current crash window. */
      restarts: crashTimes.length,
      /** True once the watchdog stopped retrying; cleared by an explicit start. */
      watchdogGaveUp: gaveUp,
      /** ISO time of the next automatic restart, or null. */
      nextRestartAt: nextRestartAt === null ? null : new Date(nextRestartAt).toISOString(),
    };
  }

  /** Most recent log lines, oldest first. */
  function recentLogs(limit = 100) {
    const n = Math.max(1, Math.min(MAX_LOG_LINES, Number(limit) || 100));
    return lines.slice(-n);
  }

  return {
    start, stop, restart, ensureStarted, state, recentLogs, record, running, logPath, pidPath, renderConfig,
  };
}
