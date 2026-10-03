/**
 * dsh-xiaoai-bridge: what is left in the data directory after teardown.
 *
 * The same teardown runs on every DSH shutdown, on a plugin reload and on
 * `dsh plugin remove`, and it cannot tell those apart. That rules out the
 * obvious reading of "clean the data directory on uninstall": the spoken log
 * is the record of what the speaker actually said -- the reason the log exists
 * is to survive restarts -- so wiping the directory on the way down would
 * destroy the one file worth keeping, every time the user reloads.
 *
 * So the directory is split by what can be rebuilt:
 *
 *   generated  config.py (re-rendered from the template on start), bridge.pid
 *              (rewritten on start), *.tmp render leftovers, __pycache__
 *   history    bridge.log, spoken.jsonl, spoken.jsonl.1 (the rotation slot),
 *              devices.json, device.json
 *
 * Teardown deletes the generated half and leaves the rest; `wipe()` deletes
 * everything and is what a real uninstall wants. Anything else found in the
 * directory is left alone and reported: a file this list has never heard of is
 * not ours to delete.
 *
 *   node scripts/check-cleanup.mjs
 */
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Rebuilt on the next start: safe to delete at teardown. */
export const GENERATED_FILES = Object.freeze(['config.py', 'bridge.pid']);

/** Suffixes of files that only exist between write and rename. */
export const GENERATED_SUFFIXES = Object.freeze(['.tmp']);

/** Caches: regenerated whenever the bridge runs. */
export const GENERATED_DIRS = Object.freeze(['__pycache__']);

/** The user's own record of this plugin. Kept unless `wipe()` is asked for. */
export const HISTORY_FILES = Object.freeze(['bridge.log', 'spoken.jsonl', 'spoken.jsonl.1', 'devices.json', 'device.json']);

/**
 * What kind of thing a directory entry is.
 *
 * @param {string} name entry name
 * @returns {'generated'|'history'|'other'} the classification
 */
export function classify(name) {
  const text = String(name ?? '');
  if (GENERATED_FILES.includes(text) || GENERATED_DIRS.includes(text)) return 'generated';
  if (GENERATED_SUFFIXES.some((suffix) => text.endsWith(suffix))) return 'generated';
  if (HISTORY_FILES.includes(text)) return 'history';
  return 'other';
}

/**
 * A cleaner bound to one data directory.
 *
 * @param {object} options
 * @param {string} options.dataDir directory this plugin owns
 * @param {object} [options.logger] optional logger
 * @returns {object} { dataDir, list, removeGenerated, wipe }
 */
export function createCleanup({ dataDir, logger } = {}) {
  const root = String(dataDir ?? '');
  const say = (level, message) => {
    try {
      logger?.[level]?.(message);
    } catch {
      /* a logger must never break teardown */
    }
  };

  /** Directory entries, or an empty list when there is no directory yet. */
  function list() {
    try {
      return readdirSync(root);
    } catch {
      return [];
    }
  }

  /**
   * Delete one entry. `lstat` first on purpose: a symlink is unlinked, not
   * followed, so a link that happens to be called `__pycache__` cannot take a
   * directory outside the data dir with it.
   */
  function remove(name) {
    const path = join(root, name);
    const info = lstatSync(path);
    if (info.isDirectory()) {
      rmSync(path, { recursive: true, force: true });
      return;
    }
    // `force` without `recursive` on a symlink or junction removes the link
    // itself, which is exactly the intent: nothing outside the data dir moves.
    rmSync(path, { force: true });
  }

  function deleteAll(names) {
    const removed = [];
    const kept = [];
    const failed = [];
    for (const name of names) {
      try {
        remove(name);
        removed.push(name);
      } catch (err) {
        failed.push({ name, error: String(err?.message ?? err) });
      }
    }
    return { removed, kept, failed };
  }

  /**
   * Delete the files this plugin can rebuild, keep everything else.
   *
   * `keep` exists for the one case where "rebuildable" is not the same as
   * "safe to delete": a stop that did not finish leaves a bridge process
   * behind, and `bridge.pid` is the only record that says which process is
   * ours. Deleting it there does not clean anything up, it orphans the
   * process and lets the next start spawn a second one (R2-5).
   *
   * @param {object} [options]
   * @param {string[]} [options.keep] generated entries to leave in place
   * @returns {{removed: string[], kept: string[], failed: Array<{name: string, error: string}>}}
   */
  function removeGenerated({ keep = [] } = {}) {
    const names = list();
    const spared = new Set(keep.map((name) => String(name)));
    const targets = names.filter((name) => classify(name) === 'generated' && !spared.has(name));
    const result = deleteAll(targets);
    result.kept = names.filter((name) => !targets.includes(name));
    const stillThere = names.filter((name) => spared.has(name));
    if (stillThere.length > 0) {
      say('debug', `dsh-xiaoai-bridge: kept ${stillThere.join(', ')} in ${root} (a bridge process may still be running)`);
    }
    if (result.removed.length > 0) say('debug', `dsh-xiaoai-bridge: removed ${result.removed.join(', ')} from ${root}`);
    for (const failure of result.failed) {
      say('warn', `dsh-xiaoai-bridge: could not remove ${failure.name} from ${root}: ${failure.error}`);
    }
    return result;
  }

  /**
   * Delete every entry, history included. This is the uninstall the plan asks
   * for; the caller has to mean it.
   *
   * @returns {{removed: string[], kept: string[], failed: Array<{name: string, error: string}>}}
   */
  function wipe() {
    const result = deleteAll(list());
    result.kept = [];
    if (result.removed.length > 0) say('info', `dsh-xiaoai-bridge: wiped ${result.removed.join(', ')} from ${root}`);
    for (const failure of result.failed) {
      say('warn', `dsh-xiaoai-bridge: could not remove ${failure.name} from ${root}: ${failure.error}`);
    }
    return result;
  }

  return { dataDir: root, list, removeGenerated, wipe };
}
