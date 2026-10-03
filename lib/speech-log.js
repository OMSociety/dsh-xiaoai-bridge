/**
 * Spoken-line log.
 *
 * Every line the speaker actually said is appended to `<dataDir>/spoken.jsonl`,
 * one JSON object per line: what the agent meant (`intent`), what the reply
 * generator turned it into (`spoken`), and which route produced it. The pair is
 * the point: when a spoken answer sounds wrong, the log shows whether the
 * agent's text was already off or the reply generator reworded it badly.
 *
 * Writes are best-effort on purpose. A logging failure must never break the
 * turn that is being logged, so the first failure is reported once and the
 * rest stay silent.
 *
 * The log is capped: a household that talks to the speaker every day appends
 * roughly 200 bytes per spoken line and nothing else in the plugin ever removes
 * a line, so an unbounded file grows for the life of the installation. Once it
 * passes {@link SPOKEN_LOG_MAX_BYTES} the file is rotated to
 * `spoken.jsonl.1` (one slot, previous slot replaced) and a fresh file starts.
 * The size is reported to the settings card so "why is this disk filling up"
 * has a visible answer; a real wipe is still `POST /data/wipe`.
 * @module dsh-xiaoai-bridge/speech-log
 */

import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** File name under the plugin data directory. */
export const SPOKEN_LOG_FILE = 'spoken.jsonl';

/** The single rotation slot. It counts as history, not as a rebuildable file. */
export const SPOKEN_LOG_ROTATED_FILE = 'spoken.jsonl.1';

/** Bytes of `spoken.jsonl` before it rotates (about 24k spoken lines). */
export const SPOKEN_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Absolute path of the spoken log.
 * @param {string} dataDir plugin data directory
 * @returns {string} path of `spoken.jsonl`
 */
export function spokenLogPath(dataDir) {
  return join(dataDir, SPOKEN_LOG_FILE);
}

/**
 * Create the append-only spoken log.
 *
 * @param {object} options
 * @param {string} options.dataDir plugin data directory
 * @param {object} [options.logger] host logger
 * @param {number} [options.maxBytes] rotate past this size (tests use a small one)
 * @returns {{path: string, write: (record: object) => Promise<void>, size: () => Promise<number>}} log handle
 */
export function createSpokenLog({ dataDir, logger, maxBytes = SPOKEN_LOG_MAX_BYTES }) {
  const path = spokenLogPath(dataDir);
  const rotatedPath = join(dataDir, SPOKEN_LOG_ROTATED_FILE);
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : SPOKEN_LOG_MAX_BYTES;
  let warned = false;
  let warnedRotation = false;
  /** Cached byte count, or null while it has not been read yet. */
  let bytes = null;

  /** Size of the current file, read once and then tracked as lines are appended. */
  async function size() {
    if (bytes === null) {
      try {
        bytes = (await stat(path)).size;
      } catch {
        bytes = 0;
      }
    }
    return bytes;
  }

  /** Move the full file aside so a fresh one starts. Caller handles failures. */
  async function rotate() {
    // Windows refuses `rename` onto an existing name, so the old slot goes
    // first; a crash in between costs one generation of history, not the log.
    await unlink(rotatedPath).catch(() => {});
    await rename(path, rotatedPath);
    bytes = 0;
    logger?.debug?.(`dsh-xiaoai-bridge: rotated ${SPOKEN_LOG_FILE} to ${SPOKEN_LOG_ROTATED_FILE}`);
  }

  return {
    path,
    /**
     * Append one record, rotating first when the file is full. Never throws.
     * @param {object} record fields to merge with the timestamp
     * @returns {Promise<void>} resolves when the append settled
     */
    async write(record) {
      const line = `${JSON.stringify(record)}\n`;
      const length = Buffer.byteLength(line, 'utf8');
      try {
        await mkdir(dirname(path), { recursive: true });
        const current = await size();
        if (current > 0 && current + length > limit) {
          try {
            await rotate();
          } catch (err) {
            // Keep logging: a failed rotation is a housekeeping problem, and
            // dropping the line would lose the record the user asked for.
            if (!warnedRotation) {
              warnedRotation = true;
              logger?.warn?.(`dsh-xiaoai-bridge: spoken log rotation failed: ${String(err?.message ?? err)}`);
            }
          }
        }
        await appendFile(path, line, 'utf8');
        bytes = await size() + length;
      } catch (err) {
        if (!warned) {
          warned = true;
          logger?.warn?.(`dsh-xiaoai-bridge: spoken log write failed: ${String(err?.message ?? err)}`);
        }
      }
    },
    /** @returns {Promise<number>} current size of `spoken.jsonl` in bytes */
    size,
  };
}
