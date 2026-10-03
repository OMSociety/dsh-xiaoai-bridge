/**
 * dsh-xiaoai-bridge: teardown checks.
 *
 * Removing the plugin has to free both ports and leave no operational residue,
 * but the same teardown runs on every DSH shutdown -- so what it deletes is a
 * design decision, not an implementation detail. This script covers that
 * decision (rebuildable files go, history stays, unknown files are reported and
 * left alone), the symlink guard that keeps the cleaner inside the data directory,
 * and the port probe that decides whether 4399/9092 were really released.
 *
 *   node scripts/check-cleanup.mjs
 */
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, createCleanup, GENERATED_FILES, HISTORY_FILES } from '../lib/cleanup.js';
import { heldPorts, probePort } from '../lib/ports.js';

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

/** A data directory shaped like the real one, history and all. */
function makeDataDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, 'config.py'), 'APP_CONFIG = {}\n');
  writeFileSync(join(dir, 'bridge.pid'), '4242\n');
  writeFileSync(join(dir, 'render.py.tmp'), 'half written\n');
  mkdirSync(join(dir, '__pycache__'));
  writeFileSync(join(dir, '__pycache__', 'mod.cpython-312.pyc'), 'bytecode');
  writeFileSync(join(dir, 'bridge.log'), 'bridge started\n');
  writeFileSync(join(dir, 'spoken.jsonl'), '{"spoken":"水开了"}\n');
  writeFileSync(join(dir, 'devices.json'), '{}\n');
  writeFileSync(join(dir, 'notes.txt'), 'not ours\n');
  return dir;
}

// 1. Classification: the split teardown depends on.
{
  check('a rendered config is generated', classify('config.py') === 'generated');
  check('the pid file is generated', classify('bridge.pid') === 'generated');
  check('a half-written render is generated', classify('config.py.tmp') === 'generated');
  check('the bytecode cache is generated', classify('__pycache__') === 'generated');
  for (const name of HISTORY_FILES) {
    check(`${name} is history`, classify(name) === 'history');
  }
  check('anything unknown is left alone', classify('notes.txt') === 'other');
  check('the lists do not overlap', GENERATED_FILES.every((one) => !HISTORY_FILES.includes(one)));
}

// 2. removeGenerated(): rebuildable files go, history and strangers stay.
{
  const dir = makeDataDir('xiaoai-cleanup-');
  const cleanup = createCleanup({ dataDir: dir });
  const result = cleanup.removeGenerated();
  const removed = [...result.removed].sort();
  check('every generated entry was removed',
    removed.join(',') === ['__pycache__', 'bridge.pid', 'config.py', 'render.py.tmp'].sort().join(','));
  check('nothing failed', result.failed.length === 0);
  check('the rendered config is gone', !existsSync(join(dir, 'config.py')));
  check('the pid file is gone', !existsSync(join(dir, 'bridge.pid')));
  check('the temp file is gone', !existsSync(join(dir, 'render.py.tmp')));
  check('the bytecode cache is gone', !existsSync(join(dir, '__pycache__')));
  check('the spoken log stays', existsSync(join(dir, 'spoken.jsonl')));
  check('the process log stays', existsSync(join(dir, 'bridge.log')));
  check('the device map stays', existsSync(join(dir, 'devices.json')));
  check('a file we never wrote stays', existsSync(join(dir, 'notes.txt')));
  check('the kept list is reported', result.kept.includes('spoken.jsonl') && result.kept.includes('notes.txt'));
  check('a second pass has nothing left to do', cleanup.removeGenerated().removed.length === 0);
  rmSync(dir, { recursive: true, force: true });
}

// 2b. A bridge process may still be alive: the pid file is the one thing the
// next start needs to adopt it, so the caller can ask for it to survive a
// teardown that could not prove the process was gone.
{
  const dir = makeDataDir('xiaoai-keep-');
  const cleanup = createCleanup({ dataDir: dir });
  const result = cleanup.removeGenerated({ keep: ['bridge.pid'] });
  check('a kept generated file stays on disk', existsSync(join(dir, 'bridge.pid')));
  check('the other generated entries still go',
    !existsSync(join(dir, 'config.py')) && !existsSync(join(dir, '__pycache__')));
  check('the kept file is not reported as removed',
    !result.removed.includes('bridge.pid') && result.removed.includes('config.py'));
  check('the kept file is still reported as kept', result.kept.includes('bridge.pid'));
  check('the rotation slot is history, so it survives both passes', classify('spoken.jsonl.1') === 'history');
  writeFileSync(join(dir, 'spoken.jsonl.1'), '{"spoken":"上一轮"}\n');
  const later = cleanup.removeGenerated();
  check('a later pass without the keep list removes the pid file',
    later.removed.includes('bridge.pid') && !existsSync(join(dir, 'bridge.pid')));
  check('the rotation slot is never removed as generated', existsSync(join(dir, 'spoken.jsonl.1')));
  rmSync(dir, { recursive: true, force: true });
}

// 3. wipe(): what a real uninstall wants, history included.
{
  const dir = makeDataDir('xiaoai-wipe-');
  const cleanup = createCleanup({ dataDir: dir });
  const result = cleanup.wipe();
  check('wipe removes everything it found', result.removed.length === 8 && result.kept.length === 0);
  check('the directory is empty afterwards', cleanup.list().length === 0);
  rmSync(dir, { recursive: true, force: true });
}

// 4. A data directory that does not exist is not an error.
{
  const missing = join(tmpdir(), `xiaoai-missing-${Date.now()}`);
  const cleanup = createCleanup({ dataDir: missing });
  check('listing a missing directory yields nothing', cleanup.list().length === 0);
  const result = cleanup.removeGenerated();
  check('cleaning a missing directory is a no-op',
    result.removed.length === 0 && result.kept.length === 0 && result.failed.length === 0);
  check('wiping a missing directory is a no-op', cleanup.wipe().removed.length === 0);
}

// 5. A link called __pycache__ must not take anything with it.
{
  const dir = mkdtempSync(join(tmpdir(), 'xiaoai-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'xiaoai-outside-'));
  writeFileSync(join(outside, 'precious.txt'), 'do not delete\n');
  let linked = true;
  try {
    symlinkSync(outside, join(dir, '__pycache__'), 'junction');
  } catch {
    linked = false;
  }
  if (linked) {
    const result = createCleanup({ dataDir: dir }).removeGenerated();
    check('the link was removed', result.removed.includes('__pycache__') && !existsSync(join(dir, '__pycache__')));
    check('the directory it pointed at is untouched', existsSync(join(outside, 'precious.txt')));
  } else {
    console.log('  skip no permission to create a junction on this machine');
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

// 6. The port probe: a bound port answers, a closed one does not.
{
  check('port 0 is not a port', (await probePort({ port: 0 })) === false);
  check('port 70000 is not a port', (await probePort({ port: 70000 })) === false);

  const server = net.createServer();
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  check('a bound port is reported as held', (await probePort({ port })) === true);
  check('heldPorts returns the held ones only', (await heldPorts({ ports: [port, 1] })).join(',') === String(port));
  check('heldPorts dedupes and drops nonsense',
    (await heldPorts({ ports: [port, port, 0, 'x', 70000] })).join(',') === String(port));

  await new Promise((resolve) => server.close(resolve));
  check('a closed port is free again', (await probePort({ port })) === false);
  check('heldPorts is empty when nothing answers', (await heldPorts({ ports: [port] })).length === 0);
}

// 7. The exit code is what a caller actually reads.
if (failures > 0) {
  console.log(`cleanup check FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log('cleanup check OK');
