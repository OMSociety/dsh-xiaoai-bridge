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
 * @module dsh-xiaoai-bridge/speech-log
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** File name under the plugin data directory. */
export const SPOKEN_LOG_FILE = 'spoken.jsonl';

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
 * @returns {{path: string, write: (record: object) => Promise<void>}} log handle
 */
export function createSpokenLog({ dataDir, logger }) {
  const path = spokenLogPath(dataDir);
  let warned = false;

  return {
    path,
    /**
     * Append one record. Never throws.
     * @param {object} record fields to merge with the timestamp
     * @returns {Promise<void>} resolves when the append settled
     */
    async write(record) {
      try {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
      } catch (err) {
        if (!warned) {
          warned = true;
          logger?.warn?.(`dsh-xiaoai-bridge: spoken log write failed: ${String(err?.message ?? err)}`);
        }
      }
    },
  };
}
