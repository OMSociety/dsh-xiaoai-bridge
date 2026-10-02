/**
 * Device-to-session bridge.
 *
 * Each speaker owns exactly one DSH session. An utterance arriving from the
 * bridge is delivered into that session as a user message, which is what makes
 * the conversation show up in the GUI and gives the agent its context.
 *
 * Two host contracts are load-bearing here and both are easy to get silently
 * wrong:
 *
 * 1. The message source kind must be produced-owned. Session format v4 rejects
 *    the bare literal `plugin` on the persistence read path, so a session built
 *    with `{kind: 'plugin'}` appends fine, renders fine, and then fails every
 *    later resume with `SessionFormatError`. `SOURCE_KIND` is therefore a
 *    namespaced literal, not a generic one.
 * 2. Delivery uses `agent.followup(message)`, not `agent.inject(message)`.
 *    `inject` is a silent queue with no wakeup: the message would sit in the
 *    inbox of an idle agent forever.
 *
 * The message factory is resolved lazily because `@deepseek-ai/dsh-llm` is
 * host-provided: a statically failed import would abort plugin activation on a
 * host build that does not expose it, so failure degrades to a hand-built
 * message of the same runtime shape.
 * @module dsh-xiaoai-bridge/session
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Producer-owned source kind stamped on every message this plugin injects. */
export const SOURCE_KIND = 'plugin:dsh-xiaoai-bridge';

/** Prefix DSH uses for session ids; kept so plugin sessions look identical to UI sessions. */
const SESSION_ID_PREFIX = 'session-';

/** Device store schema version, bumped when the on-disk shape changes. */
const DEVICE_STORE_VERSION = 1;

/** Fallback key when a device reports neither host nor name. */
const DEFAULT_DEVICE_KEY = 'default';

/** Resolved lazily: `undefined` = not tried yet, `null` = unavailable on this host. */
let messageFactory;
let messageFactoryResolved = false;

/**
 * Resolve the host's user-message constructor once.
 * @returns {Promise<Function|null>} `createUserMessage`, or null when unavailable
 */
async function resolveMessageFactory() {
  if (messageFactoryResolved) return messageFactory;
  messageFactoryResolved = true;
  try {
    const mod = await import('@deepseek-ai/dsh-llm');
    messageFactory = typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : null;
  } catch {
    messageFactory = null;
  }
  return messageFactory;
}

/**
 * Build the user message for one utterance.
 *
 * Content is always the block array form: the host's `createUserMessage` does no
 * runtime validation, and a bare string only fails much later, inside the
 * session append.
 * @param {string} text utterance text
 * @returns {Promise<object>} a user message ready for `agent.followup`
 */
async function buildUserMessage(text) {
  const create = await resolveMessageFactory();
  if (create) return create({ content: [{ type: 'text', text }], source: { kind: SOURCE_KIND } });
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND },
  };
}

/** @param {unknown} err @returns {string} a bounded message string */
function messageOf(err) {
  return String(err?.message ?? err).slice(0, 300);
}

/** Normalize a device host into a stable store key. */
function normalizeKey(host) {
  const raw = String(host ?? '').trim();
  return raw.length > 0 ? raw : DEFAULT_DEVICE_KEY;
}

/**
 * Create the device/session bridge.
 *
 * @param {object} options
 * @param {object} options.ctx plugin context (host plane)
 * @param {() => object} options.getConfig live settings projection
 * @param {string} options.dataDir plugin data directory
 * @param {object} [options.logger] host logger
 * @returns {object} bridge API
 */
export function createSessionBridge({ ctx, getConfig, dataDir, logger }) {
  const storePath = join(dataDir, 'devices.json');
  /** @type {Map<string, object>} device records keyed by host */
  const records = new Map();
  /** @type {Map<string, {dispose?: () => Promise<void>}>} live agent handles keyed by session id */
  const handles = new Map();
  /** @type {Map<string, Promise<object>>} in-flight agent creation keyed by device key */
  const pending = new Map();
  let loaded = false;
  let saveTimer = null;

  function load() {
    if (loaded) return;
    loaded = true;
    if (!existsSync(storePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(storePath, 'utf8'));
      const list = Array.isArray(parsed?.devices) ? parsed.devices : [];
      for (const entry of list) {
        if (entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key.length > 0) {
          records.set(entry.key, {
            key: entry.key,
            host: typeof entry.host === 'string' ? entry.host : '',
            name: typeof entry.name === 'string' ? entry.name : '',
            sessionId: typeof entry.sessionId === 'string' && entry.sessionId.length > 0 ? entry.sessionId : null,
            utterances: Number.isFinite(entry.utterances) ? entry.utterances : 0,
            createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
            updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
          });
        }
      }
    } catch (err) {
      logger?.warn?.(`dsh-xiaoai-bridge: device store unreadable, starting empty: ${messageOf(err)}`);
    }
  }

  /** Write the device store atomically so a crash cannot leave a half-written file. */
  function persist() {
    try {
      mkdirSync(dataDir, { recursive: true });
      const payload = JSON.stringify({
        version: DEVICE_STORE_VERSION,
        devices: [...records.values()].sort((a, b) => a.key.localeCompare(b.key)),
      }, null, 2);
      const tmp = `${storePath}.tmp`;
      writeFileSync(tmp, `${payload}\n`, 'utf8');
      renameSync(tmp, storePath);
    } catch (err) {
      logger?.warn?.(`dsh-xiaoai-bridge: device store write failed: ${messageOf(err)}`);
    }
  }

  function schedulePersist() {
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persist();
    }, 300);
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
  }

  /** @returns {object[]} a detached copy of the device records */
  function list() {
    load();
    return [...records.values()].map((record) => ({ ...record }));
  }

  /** Configured workspace for new sessions; DSH requires an absolute path. */
  function sessionCwd() {
    const raw = String(getConfig()?.sessionCwd ?? '').trim();
    if (raw.length === 0) return '';
    if (isAbsolute(raw)) return raw;
    logger?.warn?.(`dsh-xiaoai-bridge: sessionCwd must be an absolute path, ignoring: ${raw}`);
    return '';
  }

  function agentsService() {
    try {
      return ctx.get?.('agents') ?? ctx.agents ?? null;
    } catch {
      return null;
    }
  }

  function track(sessionId, handle) {
    handles.set(sessionId, handle);
  }

  /** Name the session after its device; purely cosmetic, so failures are dropped. */
  function renameSession(agent, record) {
    try {
      const titles = ctx.get?.('sessionTitle');
      if (!titles || typeof titles.rename !== 'function' || !agent?.session) return;
      const label = record.name || record.host || '小爱音箱';
      const out = titles.rename(agent.session, label);
      if (out && typeof out.catch === 'function') out.catch(() => {});
    } catch {
      // Titles are cosmetic; a host without the service must not break delivery.
    }
  }

  async function ensureAgent(record) {
    const agents = agentsService();
    if (!agents || typeof agents.create !== 'function') {
      throw new Error('DSH agents service is unavailable');
    }
    if (record.sessionId) {
      const live = agents.get?.(record.sessionId);
      if (live) return live;
      try {
        const handle = await agents.resume({ resumeSessionId: record.sessionId });
        track(record.sessionId, handle);
        return handle.agent;
      } catch (err) {
        // A first-run session was never persisted, so resume failing is the
        // normal path for a brand-new device; only a real error is worth a log.
        logger?.info?.(`dsh-xiaoai-bridge: session ${record.sessionId} not resumable, creating a new one: ${messageOf(err)}`);
      }
    }
    const sessionId = SESSION_ID_PREFIX + randomUUID();
    const meta = {};
    const cwd = sessionCwd();
    if (cwd.length > 0) meta.cwd = cwd;
    const handle = await agents.create({ sessionId, meta });
    record.sessionId = sessionId;
    record.updatedAt = Date.now();
    track(sessionId, handle);
    renameSession(handle.agent, record);
    schedulePersist();
    return handle.agent;
  }

  function ensureRecord(host, name) {
    load();
    const key = normalizeKey(host);
    let record = records.get(key);
    if (!record) {
      record = {
        key,
        host: String(host ?? '').trim(),
        name: String(name ?? '').trim(),
        sessionId: null,
        utterances: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      records.set(key, record);
      schedulePersist();
      return record;
    }
    const nextName = String(name ?? '').trim();
    if (nextName.length > 0 && record.name !== nextName) {
      record.name = nextName;
      record.updatedAt = Date.now();
      schedulePersist();
    }
    return record;
  }

  /**
   * Deliver one utterance into its device's session.
   * @param {object} input
   * @param {string} [input.host] speaker address reported by the bridge
   * @param {string} [input.name] speaker display name reported by the bridge
   * @param {string} input.text recognized utterance
   * @returns {Promise<{ok: boolean, sessionId?: string, deviceKey?: string, error?: string}>} delivery result
   */
  async function deliver({ host, name, text }) {
    const body = String(text ?? '').trim();
    if (body.length === 0) return { ok: false, error: 'empty text' };
    const record = ensureRecord(host, name);
    let inflight = pending.get(record.key);
    if (!inflight) {
      inflight = ensureAgent(record).finally(() => pending.delete(record.key));
      pending.set(record.key, inflight);
    }
    let agent;
    try {
      agent = await inflight;
    } catch (err) {
      return { ok: false, error: `无法创建会话：${messageOf(err)}` };
    }
    try {
      agent.followup(await buildUserMessage(body));
    } catch (err) {
      return { ok: false, error: `无法投递消息：${messageOf(err)}` };
    }
    record.utterances += 1;
    record.updatedAt = Date.now();
    schedulePersist();
    logger?.info?.(`dsh-xiaoai-bridge: delivered utterance to ${record.sessionId} (${body.length} chars)`);
    return { ok: true, sessionId: record.sessionId, deviceKey: record.key };
  }

  /**
   * Resolve the device a session belongs to, so `xiaoai_speak` answers the
   * speaker that asked rather than an arbitrary one.
   * @param {string|undefined} sessionId DSH session id
   * @returns {object|null} the matching device record
   */
  function deviceForSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    load();
    for (const record of records.values()) {
      if (record.sessionId === sessionId) return { ...record };
    }
    return null;
  }

  /** @returns {object|null} the sole configured device, if there is exactly one */
  function primaryDevice() {
    const all = list();
    return all.length > 0 ? all[0] : null;
  }

  /** Dispose every agent handle this plugin created; used on plugin teardown. */
  async function dispose() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const open = [...handles.values()];
    handles.clear();
    pending.clear();
    if (records.size > 0) persist();
    await Promise.all(open.map(async (handle) => {
      try {
        await handle.dispose?.();
      } catch (err) {
        logger?.warn?.(`dsh-xiaoai-bridge: session dispose failed: ${messageOf(err)}`);
      }
    }));
  }

  return { deliver, list, deviceForSession, primaryDevice, dispose, storePath };
}
