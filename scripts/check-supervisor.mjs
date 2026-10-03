/**
 * dsh-xiaoai-bridge: supervisor pid-file adoption checks.
 *
 * A DSH that dies without running plugin teardown leaves the Python bridge
 * alive holding localhost:9092 and the speaker's socket. The supervisor adopts
 * that process instead of spawning a colliding second one -- but only while its
 * code still matches disk, because Python modules are not hot reloaded (only
 * `config.py` is), and only while the pid file's recorded identity still matches
 * the command line, because Windows recycles pids and the stop path kills whole
 * trees. This script drives those decisions against a throwaway tree, so "I
 * fixed it and nothing changed" cannot happen quietly again.
 *
 * Cases C-E cover the other half of "the API Server is always up": what happens
 * when the bridge dies *by itself*. The watchdog restarts it on a widening
 * schedule, a deliberate stop cancels a restart that was already queued, and a
 * crash loop spends the schedule and then gives up instead of spinning forever.
 *
 * Cases F-H cover the failures that used to escape the watchdog entirely: a pid
 * file naming a process that is not our bridge, an interpreter that cannot be
 * spawned, and two callers asking for a start at the same moment.
 *
 * Cases I-J cover the seams with the rest of the plugin: the API token handed to
 * the child (and never inherited from the host when there is none), and a start
 * that replaces an adopted bridge whose death the 5s poll has not seen yet.
 *
 *   node scripts/check-supervisor.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeSupervisor } from '../lib/process.js';

const HOUR_MS = 3600 * 1000;
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

/**
 * @param {string} path file to stamp
 * @param {number} at epoch ms
 */
function stamp(path, at) {
  const seconds = at / 1000;
  utimesSync(path, seconds, seconds);
}

/**
 * Start a process whose command line looks like the bridge's (`node main.py` in
 * the throwaway bridge dir), so the pid-file identity check can recognise it.
 * @returns {Promise<import('node:child_process').ChildProcess>} a long-lived dummy
 */
function startDummy() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['main.py'], {
      cwd: bridgeDir,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

/**
 * Start a process that is *not* the bridge: used to prove the adoption check
 * refuses a pid whose command line does not match the recorded identity.
 * @returns {Promise<import('node:child_process').ChildProcess>} a stranger process
 */
function startStranger() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

/**
 * Write the pid file the way the supervisor now does: a pid plus the identity it
 * has to match before adopting.
 * @param {number} pid process id
 */
function writePidRecord(pid) {
  const record = {
    pid,
    identity: { script: 'main.py', pythonPath: process.execPath, bridgeDir },
    recordedAt: new Date().toISOString(),
  };
  writeFileSync(pidPath, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * @param {number} pid process id
 * @returns {boolean} whether the pid is still around
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * @param {number} pid process id
 * @param {number} deadline epoch ms
 */
async function waitGone(pid, deadline) {
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

const root = mkdtempSync(join(tmpdir(), 'oxb-supervisor-'));
const dataDir = join(root, 'data');
const bridgeDir = join(root, 'bridge');
const coreDir = join(bridgeDir, 'core');
mkdirSync(dataDir, { recursive: true });
mkdirSync(coreDir, { recursive: true });
writeFileSync(join(bridgeDir, 'main.py'), 'setInterval(() => {}, 1000);\n', 'utf8');
writeFileSync(join(coreDir, 'dummy.py'), 'VALUE = 1\n', 'utf8');

const logPath = join(dataDir, 'bridge.log');
const pidPath = join(dataDir, 'bridge.pid');
const config = {
  enabled: true,
  logLevel: 'INFO',
  apiServerEnabled: false,
  apiServerHost: '127.0.0.1',
  apiServerPort: 9092,
  deviceName: 'test-speaker',
  deviceHost: '127.0.0.1',
};

/**
 * @param {number} ms milliseconds to wait
 * @returns {Promise<void>} resolves after the delay
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Poll a predicate until it holds or the deadline passes.
 * @param {() => boolean} predicate condition to wait for
 * @param {number} budgetMs how long to keep asking
 * @returns {Promise<boolean>} whether it ever held
 */
async function until(predicate, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
}

/** @returns {string} the whole bridge log, or '' before it exists */
function logText() {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

/** @returns {object|null} the pid record the supervisor last wrote, if any */
function readPidRecord() {
  try {
    return JSON.parse(readFileSync(pidPath, 'utf8'));
  } catch {
    return null;
  }
}

/** @returns {number[]} every pid the supervisor reported starting, in order */
function startedPids() {
  return [...logText().matchAll(/bridge started pid=(\d+)/g)].map((m) => Number(m[1]));
}

/**
 * @returns {object} supervisor bound to the throwaway tree
 */
function makeSupervisor(overrides = {}) {
  return createBridgeSupervisor({
    getConfig: () => config,
    paths: () => ({ bridgeDir, pythonPath: process.execPath }),
    dataDir,
    logger: { info() {}, warn() {} },
    resolveToken: async () => null,
    onLogLine() {},
    ...overrides,
  });
}

console.log('case A: leftover bridge whose recorded identity matches is adopted');
{
  stamp(join(bridgeDir, 'main.py'), Date.now() - HOUR_MS);
  stamp(join(coreDir, 'dummy.py'), Date.now() - HOUR_MS);
  const dummy = await startDummy();
  writePidRecord(dummy.pid);

  const supervisor = makeSupervisor();
  const res = await supervisor.start();
  check('start reports adoption', res.ok === true && res.adopted === true);
  check('adopted pid is the leftover one', res.pid === dummy.pid);
  check('the leftover process is left running', isAlive(dummy.pid));
  check(
    'the identity check matched interpreter and script',
    logText().includes('command line matches the recorded interpreter and script'),
  );
  check(
    'the adoption is recorded in the log',
    readFileSync(logPath, 'utf8').includes(`adopted running bridge pid=${dummy.pid}`),
  );

  await supervisor.stop();
  check('stop kills the adopted process', await waitGone(dummy.pid, Date.now() + 10_000));
  check('a finished stop is not still reported as stopping', supervisor.state().stopping === false);
}

console.log('case A2: a pid file from an older version (bare number) is still adopted');
{
  rmSync(logPath, { force: true });
  const dummy = await startDummy();
  writeFileSync(pidPath, `${dummy.pid}\n`, 'utf8');

  const supervisor = makeSupervisor();
  const res = await supervisor.start();
  check('the legacy pid file is adopted', res.ok === true && res.adopted === true && res.pid === dummy.pid);
  check('the log says which check was used', logText().includes('command line still runs main.py (legacy pid file)'));

  await supervisor.stop();
  check('stop kills the adopted legacy process', await waitGone(dummy.pid, Date.now() + 10_000));
}

console.log('case B: leftover bridge running replaced code is restarted');
{
  stamp(join(bridgeDir, 'main.py'), Date.now());
  stamp(join(coreDir, 'dummy.py'), Date.now());
  const dummy = await startDummy();
  writePidRecord(dummy.pid);
  // Sources are newer than the pid file, i.e. the bridge predates our edits.
  stamp(pidPath, Date.now() - HOUR_MS);

  const supervisor = makeSupervisor();
  const res = await supervisor.start();
  check('start reports a fresh process, not an adoption', res.ok === true && res.adopted !== true);
  check('the fresh process is not the leftover one', res.pid !== dummy.pid);
  check('the replaced process was killed', await waitGone(dummy.pid, Date.now() + 10_000));
  check(
    'the replacement is recorded in the log',
    readFileSync(logPath, 'utf8').includes(`bridge sources changed since pid=${dummy.pid} started`),
  );

  await supervisor.stop();
  check('stop kills the freshly spawned process', await waitGone(res.pid, Date.now() + 10_000));
  check('a finished stop is not still reported as stopping', supervisor.state().stopping === false);
}

console.log('case F: a pid file naming a process that is not the bridge is refused');
{
  rmSync(pidPath, { force: true });
  rmSync(logPath, { force: true });
  // Sources older than the pid file, so only the identity check can refuse this.
  stamp(join(bridgeDir, 'main.py'), Date.now() - HOUR_MS);
  stamp(join(coreDir, 'dummy.py'), Date.now() - HOUR_MS);
  const stranger = await startStranger();
  writePidRecord(stranger.pid);

  const supervisor = makeSupervisor();
  const res = await supervisor.start();
  check(
    'start does not adopt the stranger',
    res.ok === true && res.adopted !== true && res.pid !== stranger.pid,
  );
  check('the stranger process is left alone', isAlive(stranger.pid));
  check('the refusal is recorded in the log', logText().includes(`not adopting pid=${stranger.pid}`));

  await supervisor.stop();
  check('stop does not kill the stranger', isAlive(stranger.pid));
  check('stop kills the bridge that was actually started', await waitGone(res.pid, Date.now() + 10_000));
  try { process.kill(stranger.pid); } catch { /* already gone */ }
}

console.log('case C: a bridge that dies on its own is restarted by the watchdog');
{
  rmSync(pidPath, { force: true });
  rmSync(logPath, { force: true });
  // Exits ~30 ms after start: a real process that ran, but far shorter than the
  // crash window, so the retry budget must not be reset.
  writeFileSync(join(bridgeDir, 'main.py'), 'setTimeout(() => process.exit(3), 30);\n', 'utf8');
  const supervisor = makeSupervisor({ restartDelaysMs: [120] });
  const first = await supervisor.start();
  check('the first start succeeds', first.ok === true && first.pid !== undefined);

  const restarted = await until(() => startedPids().length >= 2, 5000);
  check('the watchdog starts the bridge again', restarted);
  check('the restarted process is a new one', startedPids()[1] !== first.pid);
  check(
    'the restart and its delay are recorded',
    logText().includes('exited unexpectedly (code=3)') && logText().includes('restart #1 in 120 ms'),
  );
  check('the spent restart is counted in state', supervisor.state().restarts >= 1);

  await supervisor.stop();
}

console.log('case D: stopping the bridge cancels a restart that was already queued');
{
  rmSync(pidPath, { force: true });
  rmSync(logPath, { force: true });
  writeFileSync(join(bridgeDir, 'main.py'), 'process.exit(3);\n', 'utf8');
  const supervisor = makeSupervisor({ restartDelaysMs: [700] });
  const first = await supervisor.start();
  check('the first start succeeds', first.ok === true);

  const scheduled = await until(() => supervisor.state().nextRestartAt !== null, 5000);
  check('a restart is queued after the crash', scheduled);
  const before = startedPids().length;

  const stopped = await supervisor.stop();
  check('stopping an already dead bridge reports success', stopped.ok === true && stopped.stopped === false);
  check('the queued restart is dropped', supervisor.state().nextRestartAt === null);

  await sleep(1000);
  check('the cancelled restart never fires', startedPids().length === before && supervisor.state().running === false);
  check('one crash is not enough to give up', supervisor.state().watchdogGaveUp === false);
}

console.log('case E: a crash loop spends the schedule and then gives up');
{
  rmSync(pidPath, { force: true });
  rmSync(logPath, { force: true });
  // The default crash window stays in place: every run dies within it, so the
  // budget is never reset and the crash loop has to exhaust the schedule.
  writeFileSync(join(bridgeDir, 'main.py'), 'process.exit(7);\n', 'utf8');
  const supervisor = makeSupervisor({ restartDelaysMs: [10, 20] });
  const first = await supervisor.start();
  check('the first start succeeds', first.ok === true);

  const gaveUp = await until(() => supervisor.state().watchdogGaveUp === true, 5000);
  check('the watchdog gives up instead of looping forever', gaveUp);
  check('the log says how many restarts were spent', logText().includes('the watchdog stopped after 2 restarts'));
  check(
    'giving up is reported as the last error',
    String(supervisor.state().lastError ?? '').includes('the watchdog stopped after 2 restarts'),
  );
  const spent = startedPids().length;
  await sleep(250);
  check('nothing is started after giving up', startedPids().length === spent);

  // An explicit start is the user saying "try again": it clears the budget.
  writeFileSync(join(bridgeDir, 'main.py'), 'setInterval(() => {}, 1000);\n', 'utf8');
  const again = await supervisor.start();
  check('an explicit start still starts the bridge', again.ok === true);
  check(
    'an explicit start clears the give-up state',
    supervisor.state().watchdogGaveUp === false && supervisor.state().restarts === 0,
  );
  check('the restarted bridge is running', supervisor.state().running === true);

  await supervisor.stop();
  check('stop kills the restarted bridge', await waitGone(again.pid, Date.now() + 10_000));
}

console.log('case G: an interpreter that cannot be spawned is not reported as a success');
{
  rmSync(pidPath, { force: true });
  rmSync(logPath, { force: true });
  // A pythonPath that does not exist: `spawn` queues, then fails asynchronously.
  const supervisor = makeSupervisor({
    paths: () => ({ bridgeDir, pythonPath: join(root, 'missing', 'python.exe') }),
    restartDelaysMs: [60_000],
  });
  const res = await supervisor.start();
  check('start reports the failure', res.ok === false && String(res.error ?? '').includes('spawn failed'));
  check('the failure reaches the log', logText().includes('failed to spawn'));
  check('the watchdog queues the next attempt', supervisor.state().nextRestartAt !== null);
  check('no pid file with an undefined pid is written', existsSync(pidPath) === false);

  await supervisor.stop();
  check('stop cancels the queued retry', supervisor.state().nextRestartAt === null);
}

console.log('case H: two callers asking for a start at the same time share one spawn');
{
  rmSync(pidPath, { force: true });
  rmSync(logPath, { force: true });
  writeFileSync(join(bridgeDir, 'main.py'), 'setInterval(() => {}, 1000);\n', 'utf8');
  const supervisor = makeSupervisor();
  const [a, b] = await Promise.all([supervisor.start(), supervisor.start()]);
  check('both callers report success', a.ok === true && b.ok === true);
  check('both callers see the same pid', a.pid === b.pid && a.pid !== undefined);
  check('only one bridge was started', startedPids().length === 1);

  await supervisor.stop();
  check('stop kills the single bridge', await waitGone(a.pid, Date.now() + 10_000));
}

console.log('case I: the API token reaches the bridge process, and only when there is one');
{
  rmSync(pidPath, { force: true });
  rmSync(logPath, { force: true });
  const marker = join(dataDir, 'env-probe.json');
  // main.py is executed by node here, so it can report back what the supervisor
  // actually put in its environment -- a visible stand-in for the Python bridge
  // reading XIAOAI_API_TOKEN out of os.environ.
  writeFileSync(
    join(bridgeDir, 'main.py'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, `
      + `JSON.stringify({ token: process.env.XIAOAI_API_TOKEN ?? null }));\n`
      + 'setInterval(() => {}, 1000);\n',
    'utf8',
  );

  const withToken = makeSupervisor({ resolveToken: async () => 'probe-token-32-hex' });
  const res = await withToken.start();
  check('a start with a configured token succeeds', res.ok === true);
  check('the bridge process reported its environment', await until(() => existsSync(marker), 10_000));
  const seen = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : {};
  check('XIAOAI_API_TOKEN is passed to the bridge', seen.token === 'probe-token-32-hex');
  await withToken.stop();

  // The mirror image: with no token to pass, the host's own variable must not
  // leak into the child, or the bridge would demand a bearer nobody sends.
  rmSync(marker, { force: true });
  process.env.XIAOAI_API_TOKEN = 'leaked-from-the-host';
  const withoutToken = makeSupervisor({ resolveToken: async () => null });
  const bare = await withoutToken.start();
  check('a start without a configured token still succeeds', bare.ok === true);
  check('the tokenless bridge reported its environment', await until(() => existsSync(marker), 10_000));
  const bareSeen = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : {};
  check('an unconfigured token is not inherited from the host', bareSeen.token === null);
  delete process.env.XIAOAI_API_TOKEN;
  await withoutToken.stop();
}

console.log('case J: a replacement start forgets the adopted bridge it outlived');
{
  rmSync(pidPath, { force: true });
  rmSync(logPath, { force: true });
  writeFileSync(join(bridgeDir, 'main.py'), 'setInterval(() => {}, 1000);\n', 'utf8');

  // An adopted process is not our child, so its death is only noticed by the 5s
  // poll. Dying just before an explicit start used to leave that poll armed: it
  // then deleted the pid file the *replacement* had just written, wiped
  // startedAt, and reported an exit that never happened.
  const dummy = await startDummy();
  writePidRecord(dummy.pid);
  const supervisor = makeSupervisor();
  const adopted = await supervisor.start();
  check('the leftover bridge is adopted first', adopted.adopted === true && adopted.pid === dummy.pid);
  check('the adopted state is visible', supervisor.state().adopted === true);

  // Kill it and start again in the same breath: waiting only long enough for the
  // pid to really be gone keeps this well inside the poll window.
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(dummy.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(dummy.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  check('the adopted bridge is gone before the replacement starts', await until(() => !isAlive(dummy.pid), 2_000));

  const fresh = await supervisor.start();
  check('a start replaces the dead adopted bridge', fresh.ok === true && fresh.adopted !== true);
  check('the replacement got its own pid', typeof fresh.pid === 'number' && fresh.pid !== dummy.pid);
  check('the replacement owns the pid file', readPidRecord()?.pid === fresh.pid);
  check('startedAt belongs to the replacement', supervisor.state().startedAt !== null);
  check('the adoption is no longer armed', supervisor.state().adopted === false);
  check('no phantom exit was reported', !logText().includes('adopted bridge pid='));
  check('the phantom exit did not wake the watchdog', supervisor.state().restarts === 0);

  // One full poll period later the verdict must not have changed.
  await sleep(5_500);
  check('the pid file survives the poll period', readPidRecord()?.pid === fresh.pid);
  check('the poll still reports no phantom exit', !logText().includes('adopted bridge pid='));

  await supervisor.stop();
  check('stop kills the replacement', await waitGone(fresh.pid, Date.now() + 10_000));
}

rmSync(root, { recursive: true, force: true });

if (failures > 0) {
  console.log(`supervisor check FAILED (${failures})`);
  process.exit(1);
}
console.log('supervisor check OK');
