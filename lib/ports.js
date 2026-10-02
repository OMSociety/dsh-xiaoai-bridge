/**
 * dsh-xiaoai-bridge: probes for the two ports the bridge holds.
 *
 * 4399 is the Rust AppServer the speaker dials into; the API Server port
 * (9092 unless the settings say otherwise) is the aiohttp half the plugin and
 * the `xiaoai-tts` skill talk to. Removing the plugin is only finished when
 * both are gone, and "gone" is not something the process table can be trusted
 * for -- an orphaned listener whose parent died still answers, and the pid in
 * our pid file may belong to a bridge this DSH never started. A connection
 * attempt is the honest test: something is either accepting or it is not.
 *
 *   node scripts/check-cleanup.mjs
 */
import net from 'node:net';

/** The AppServer port the speaker connects to (fixed by the bridge). */
export const SPEAKER_PORT = 4399;

/** How long a probe waits before calling the port free. */
export const DEFAULT_PROBE_TIMEOUT_MS = 600;

/**
 * Try once to open a TCP connection.
 *
 * @param {object} options
 * @param {string} [options.host] address to dial
 * @param {number} options.port port to dial
 * @param {number} [options.timeoutMs] how long to wait
 * @returns {Promise<boolean>} true when something accepted the connection
 */
export function probePort({ host = '127.0.0.1', port, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65535) {
      resolve(false);
      return;
    }
    const socket = new net.Socket();
    let settled = false;
    const done = (listening) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect({ host, port: number });
  });
}

/**
 * Which of these ports still accept connections.
 *
 * @param {object} options
 * @param {string} [options.host] address to dial
 * @param {number[]} options.ports ports to probe
 * @param {number} [options.timeoutMs] per-port timeout
 * @returns {Promise<number[]>} the ports that answered, in the order given
 */
export async function heldPorts({ host = '127.0.0.1', ports = [], timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const unique = [...new Set(ports.map((port) => Number(port))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535))];
  const answers = await Promise.all(unique.map((port) => probePort({ host, port, timeoutMs })));
  return unique.filter((port, index) => answers[index]);
}
