/**
 * dsh-xiaoai-bridge: supervisor pid-file adoption checks.
 *
 * A DSH that dies without running plugin teardown leaves the Python bridge
 * alive holding localhost:9092 and the speaker's socket. The supervisor adopts
 * that process instead of spawning a colliding second one -- but only while its
 * code still matches disk, because Python modules are not hot reloaded (only
 * `config.py` is). This script drives both decisions against a throwaway
 * tree, so "I fixed it and nothing changed" cannot happen quietly again.
 *
 * Cases C-E cover the other half of "the API Server is always up": what happens
 * when the bridge dies *by itself*. The watchdog restarts it on a widening
 * schedule, a deliberate stop cancels a restart that was already queued, and a
 * crash loop spends the schedule and then gives up instead of spinning forever.
 *
 *   node scripts/check-supervisor.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

/** @returns {Promise<import('node:child_process').ChildProcess>} a long-lived dummy */
function startDummy() {
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

console.log('case A: leftover bridge running the same code is adopted');
{
  stamp(join(bridgeDir, 'main.py'), Date.now() - HOUR_MS);
  stamp(join(coreDir, 'dummy.py'), Date.now() - HOUR_MS);
  const dummy = await startDummy();
  writeFileSync(pidPath, `${dummy.pid}\n`, 'utf8');

  const supervisor = makeSupervisor();
  const res = await supervisor.start();
  check('start reports adoption', res.ok === true && res.adopted === true);
  check('adopted pid is the leftover one', res.pid === dummy.pid);
  check('the leftover process is left running', isAlive(dummy.pid));
  check(
    'the adoption is recorded in the log',
    readFileSync(logPath, 'utf8').includes(`adopted running bridge pid=${dummy.pid}`),
  );

  await supervisor.stop();
  check('stop kills the adopted process', await waitGone(dummy.pid, Date.now() + 10_000));
  check('a finished stop is not still reported as stopping', supervisor.state().stopping === false);
}

console.log('case B: leftover bridge running replaced code is restarted');
{
  stamp(join(bridgeDir, 'main.py'), Date.now());
  stamp(join(coreDir, 'dummy.py'), Date.now());
  const dummy = await startDummy();
  writeFileSync(pidPath, `${dummy.pid}\n`, 'utf8');
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

console.log('case C: a bridge that dies on its own is restarted by the watchdog');
{
  rmSync(pidPath, { force: true });
  rmSync(logPath, { force: true });
  // Exits ~30 ms after start: a real process that ran, but far shorter than the
  // stable window, so the retry budget must not be reset.
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
  // The default stable window stays in place: every run dies within it, so the
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

rmSync(root, { recursive: true, force: true });

if (failures > 0) {
  console.log(`supervisor check FAILED (${failures})`);
  process.exit(1);
}
console.log('supervisor check OK');
