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
 * @returns {object} supervisor bound to the throwaway tree
 */
function makeSupervisor() {
  return createBridgeSupervisor({
    getConfig: () => config,
    paths: () => ({ bridgeDir, pythonPath: process.execPath }),
    dataDir,
    logger: { info() {}, warn() {} },
    resolveToken: async () => null,
    onLogLine() {},
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

rmSync(root, { recursive: true, force: true });

if (failures > 0) {
  console.log(`supervisor check FAILED (${failures})`);
  process.exit(1);
}
console.log('supervisor check OK');
