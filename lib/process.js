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
import { spawn } from 'node:child_process';
import {
  closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, truncateSync, unlinkSync,
  writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

/** Ring-buffer capacity for retained log lines. */
const MAX_LOG_LINES = 400;
/** Log file is truncated back to zero once it grows past this. */
const MAX_LOG_BYTES = 8 * 1024 * 1024;
/** Grace period between a graceful signal and a forced tree kill. */
const KILL_GRACE_MS = 3000;
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
 * Truncate the log file when it exceeds the cap.
 *
 * Called before each append rather than on a timer: the file only grows when
 * the bridge actually says something, which is exactly when this check matters.
 * @param {string} logPath absolute log file path
 */
function rotateIfOversized(logPath) {
  try {
    if (statSync(logPath).size > MAX_LOG_BYTES) truncateSync(logPath, 0);
  } catch {
    // The file may not exist yet; appending creates it.
  }
}

/**
 * Create the bridge supervisor.
 *
 * @param {object} options
 * @param {() => object} options.getConfig live settings projection
 * @param {() => {bridgeDir: string, pythonPath: string}} options.paths resolved filesystem locations
 * @param {string} options.dataDir plugin data directory (log + pid files)
 * @param {object} [options.logger] host logger
 * @param {() => Promise<string|null>} [options.resolveToken] reads the API bearer token from DSH credentials
 * @param {(text: string) => void} [options.onLogLine] called for every complete log line
 * @returns {object} supervisor handle
 */
export function createBridgeSupervisor({ getConfig, paths, dataDir, logger, resolveToken, onLogLine }) {
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  /** @type {number|null} */
  let fd = null;
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

  /** @returns {number|null} a live pid recorded by an earlier DSH run */
  function readLivePid() {
    try {
      const raw = readFileSync(pidPath, 'utf8').trim();
      const pid = Number.parseInt(raw, 10);
      return isAlive(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  /** @param {number|undefined} pid pid to persist */
  function writePidFile(pid) {
    try {
      ensureDataDir();
      writeFileSync(pidPath, `${pid}\n`, 'utf8');
    } catch (err) {
      record('plugin', `cannot write pid file: ${String(err?.message ?? err)}`);
    }
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

  /** Whether the child process is currently alive. */
  function running() {
    if (child !== null && child.exitCode === null && !child.killed) return true;
    if (adoptedPid !== null) {
      if (isAlive(adoptedPid)) return true;
      adoptedPid = null;
      clearPidFile();
    }
    return false;
  }

  /**
   * Resolve the child environment from the live settings.
   *
   * The bridge decides what to start from environment variables alone (see
   * `bridge/main.py`), so this is the single place that translates settings into
   * process behaviour. The three removed connectors are explicitly cleared
   * rather than merely not set: they may linger in the interactive shell's
   * environment, and a stray `OPENAI_ENABLE` would silently start a second
   * backend.
   * @returns {Promise<Record<string,string>>} child environment
   */
  async function childEnv() {
    const cfg = getConfig();
    const env = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      LOG_LEVEL: String(cfg.logLevel ?? 'INFO'),
      DSH_ENABLE: cfg.enabled ? '1' : '0',
      AUDIO_INPUT_ENABLE: '1',
      API_SERVER_ENABLE: cfg.apiServerEnabled ? '1' : '0',
      API_SERVER_HOST: String(cfg.apiServerHost ?? '127.0.0.1'),
      API_SERVER_PORT: String(cfg.apiServerPort ?? 9092),
      XIAOAI_DEVICE_NAME: String(cfg.deviceName ?? ''),
      XIAOAI_DEVICE_HOST: String(cfg.deviceHost ?? ''),
    };
    for (const dead of ['XIAOZHI_ENABLE', 'OPENCLAW_ENABLE', 'OPENCLAW_ENABLED', 'QWENPAW_ENABLE']) {
      delete env[dead];
    }
    // The dsh connector is the only backend this fork ships; clearing the rest
    // guarantees that even a stale OPENAI_ENABLE cannot add a second route.
    delete env.OPENAI_ENABLE;

    let token = null;
    try {
      token = (await resolveToken?.()) ?? null;
    } catch (err) {
      record('plugin', `credential lookup failed: ${String(err?.message ?? err)}`);
    }
    if (typeof token === 'string' && token.length > 0) env.XIAOAI_API_TOKEN = token;
    else delete env.XIAOAI_API_TOKEN;
    return env;
  }

  /**
   * Start the bridge process.
   * @returns {Promise<{ok: boolean, pid?: number, error?: string, already?: boolean}>}
   */
  async function start() {
    if (!getConfig().enabled) return { ok: false, error: 'plugin disabled' };
    if (running()) return { ok: true, pid: child?.pid ?? adoptedPid, already: true };

    ensureDataDir();

    // A pid file left by a DSH that died without teardown means the bridge is
    // already up (and already holds both ports). Adopt instead of colliding --
    // unless its code has been replaced on disk since it started, in which case
    // adopting it would silently keep running the old modules.
    const stale = readLivePid();
    if (stale !== null && !adoptedCodeIsStale()) {
      adoptedPid = stale;
      startedAt = startedAt ?? new Date().toISOString();
      record('plugin', `adopted running bridge pid=${stale} from ${pidPath}`);
      logger?.info?.(`dsh-xiaoai-bridge: adopted running bridge (pid=${stale})`);
      return { ok: true, pid: stale, adopted: true };
    }
    if (stale !== null) {
      record('plugin', `bridge sources changed since pid=${stale} started; replacing it`);
      stopping = true;
      killTree(stale);
      const deadline = Date.now() + KILL_GRACE_MS * 2;
      while (Date.now() < deadline && isAlive(stale)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      stopping = false;
      if (isAlive(stale)) {
        lastError = `stale bridge pid=${stale} did not exit; refusing to start a second one`;
        record('plugin', lastError);
        return { ok: false, error: lastError };
      }
    }
    clearPidFile();

    const { bridgeDir, pythonPath } = paths();
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

    try {
      child = spawn(pythonPath, ['main.py'], {
        cwd: bridgeDir,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      child = null;
      lastError = `spawn failed: ${String(err?.message ?? err)}`;
      record('plugin', lastError);
      return { ok: false, error: lastError };
    }

    startedAt = new Date().toISOString();
    const outCarry = { tail: '' };
    const errCarry = { tail: '' };
    child.stdout?.on('data', (chunk) => {
      for (const line of drainLines(outCarry, chunk)) record('out', line);
    });
    child.stderr?.on('data', (chunk) => {
      for (const line of drainLines(errCarry, chunk)) record('err', line);
    });
    child.on('error', (err) => {
      lastError = `process error: ${String(err?.message ?? err)}`;
      record('plugin', lastError);
    });
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      const pid = child?.pid;
      child = null;
      clearPidFile();
      if (fd !== null) {
        try { closeSync(fd); } catch { /* already closed */ }
        fd = null;
      }
      record('plugin', `bridge exited pid=${pid} code=${code} signal=${signal ?? 'none'}${stopping ? ' (requested)' : ''}`);
      if (!stopping) lastError = `bridge exited unexpectedly (code=${code})`;
    });

    writePidFile(child.pid);
    record('plugin', `bridge started pid=${child.pid} cwd=${bridgeDir}`);
    logger?.info?.(`dsh-xiaoai-bridge: bridge started (pid=${child.pid})`);
    return { ok: true, pid: child.pid ?? undefined };
  }

  /**
   * Kill a process tree, hard, by pid.
   *
   * `child.kill()` reaches only the direct child. The bridge forks real
   * grandchildren (keyword generation, `run_shell` helpers), and an orphaned
   * grandchild keeps the speaker's WebSocket and port 9092 held, which makes the
   * next start fail with "address in use".
   * @param {number} pid process id
   */
  function killTree(pid) {
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch (err) {
        record('plugin', `taskkill failed: ${String(err?.message ?? err)}`);
      }
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }

  /**
   * Stop the bridge, waiting for the tree to actually go away.
   * @returns {Promise<{ok: boolean, stopped?: boolean, error?: string}>}
   */
  async function stop() {
    if (!running()) return { ok: true, stopped: false };
    if (child === null) {
      // Adopted process: no exit event will arrive, so poll liveness instead.
      const pid = adoptedPid;
      stopping = true;
      record('plugin', `stopping adopted bridge pid=${pid}`);
      killTree(pid);
      const deadline = Date.now() + KILL_GRACE_MS * 2;
      while (Date.now() < deadline && isAlive(pid)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (isAlive(pid)) {
        lastError = `adopted bridge pid=${pid} did not exit`;
        return { ok: false, error: lastError };
      }
      adoptedPid = null;
      startedAt = null;
      stopping = false;
      clearPidFile();
      return { ok: true, stopped: true };
    }
    const pid = child.pid;
    stopping = true;
    record('plugin', `stopping bridge pid=${pid}`);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    killTree(pid);
    const timer = new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
    await Promise.race([exited, timer]);
    if (running()) {
      record('plugin', `bridge pid=${pid} survived the graceful kill; forcing tree kill`);
      killTree(pid);
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS))]);
    }
    // Detach the exit handler's grip even if the process is somehow still up.
    if (running()) {
      lastError = `bridge pid=${pid} did not exit`;
      child = null;
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
    return {
      managed: cfg.autoStart !== false,
      running: running(),
      pid: running() ? (child?.pid ?? adoptedPid) : null,
      adopted: child === null && adoptedPid !== null,
      startedAt,
      exitCode,
      exitSignal,
      stopping,
      lastError,
      logFile: logPath,
      pidFile: pidPath,
    };
  }

  /** Most recent log lines, oldest first. */
  function recentLogs(limit = 100) {
    const n = Math.max(1, Math.min(MAX_LOG_LINES, Number(limit) || 100));
    return lines.slice(-n);
  }

  return { start, stop, restart, state, recentLogs, record, running, logPath, pidPath };
}
