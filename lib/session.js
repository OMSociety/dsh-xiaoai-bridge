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
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Producer-owned source kind stamped on every message this plugin injects. */
export const SOURCE_KIND = 'plugin:dsh-xiaoai-bridge';

/** Prefix DSH uses for session ids; kept so plugin sessions look identical to UI sessions. */
const SESSION_ID_PREFIX = 'session-';

/**
 * Device store schema version, bumped when the on-disk shape changes.
 *
 * v1 records were written before the plugin supplied a working directory, so
 * their sessions have no `cwd` in the session header. The host refuses to serve
 * such a session (`session/not-found`), which is why an old record's session
 * cannot be opened in the GUI. Version 1 records therefore retire their session
 * id on load: the history file stays on disk, but the next utterance starts a
 * session that works.
 */
const DEVICE_STORE_VERSION = 2;

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

/** Resolved lazily: `undefined` = not tried yet, `null` = unavailable on this host. */
let modelInstaller;
let modelInstallerResolved = false;

/**
 * Import the host's model-selection installer once.
 *
 * The installer is a host package export, so it is genuinely cacheable; the
 * selection it is given is not, because the user can change the default model
 * while the bridge is running.
 * @returns {Promise<Function|null>} `installModelSelection`, or null when unavailable
 */
async function resolveModelInstaller() {
  if (modelInstallerResolved) return modelInstaller;
  modelInstallerResolved = true;
  try {
    const mod = await import('@deepseek-ai/dsh-agent');
    modelInstaller = typeof mod?.installModelSelection === 'function' ? mod.installModelSelection : null;
  } catch {
    modelInstaller = null;
  }
  return modelInstaller;
}

/**
 * Read the host's current default model selection.
 * @param {object} ctx plugin context
 * @returns {{provider: string, model: string}|null} a usable selection
 */
export function currentSelection(ctx) {
  try {
    const current = ctx.get?.('agentDefaultModel')?.currentSelection?.();
    if (current && typeof current.provider === 'string' && typeof current.model === 'string') {
      return { ...current };
    }
  } catch {
    // A host without the service simply has no default to copy.
  }
  return null;
}

/**
 * Build the `setup` hook that couples one selection to prompt assembly.
 *
 * This is not cosmetic. An agent created without `agentOptions` never gets a
 * provider/model, and only the installer below supplies the assembly's
 * `{{model}}` prompt variable; without both, the deployment persona's template
 * fails to assemble and the very first turn ends immediately with
 *
 *   prompt variable "{{model}}" has no value for this assembly
 *   (section "deployment:persona-prefix")
 *
 * The session looks healthy in the sidebar, the turn is recorded, and nothing
 * is ever sent to a model. The headless runner avoids it the same way.
 *
 * The route is captured once, when the session is created, and never refreshed
 * afterwards. That is a deliberate trade-off (R6-6): the voice session keeps the
 * model it started with for the lifetime of this DSH process, which matches how
 * a DSH session's own model behaves. Changing the default model therefore takes
 * effect immediately for the replyer half (lib/replyer.js re-resolves its route
 * on every call) but only reaches the speaker's session after DSH restarts. The
 * holder is still mutable because the host installer reads `current` on each
 * prompt assembly; nothing in this plugin writes to it after creation.
 * @param {Function|null} install host installer
 * @param {{provider: string, model: string}} selection the route to pin
 * @returns {(agentCtx: object) => void} agent-context setup hook
 */
function modelSelectionSetup(install, selection) {
  const mutable = { current: selection, assembled: undefined };
  if (install) return (agentCtx) => { install(agentCtx, mutable); };
  // Degraded fallback: only the prompt variables are restored, which is the
  // part whose absence actually kills the turn.
  return (agentCtx) => {
    agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next();
      return {
        ...assembled,
        variables: { ...assembled.variables, provider: selection.provider, model: selection.model },
      };
    });
  };
}

/** Normalize a device host into a stable store key. */
function normalizeKey(host) {
  const raw = String(host ?? '').trim();
  return raw.length > 0 ? raw : DEFAULT_DEVICE_KEY;
}

/**
 * One-line reason out of a preset registry's `broken` marker.
 *
 * The registry reports a failed declaration either as a plain string or as an
 * object with one of a few reason fields, and a diagnostic reader wants the
 * reason rather than the shape.
 * @param {unknown} broken the `broken` field from `agentPresets.resolve`
 * @returns {string} a human-readable reason, or a placeholder
 */
function describeBroken(broken) {
  if (broken === null || broken === undefined) return 'no reason reported';
  if (typeof broken === 'string') return broken.length > 0 ? broken : 'no reason reported';
  const reason = broken.message ?? broken.reason ?? broken.error;
  return reason === undefined || reason === null || reason === '' ? 'no reason reported' : String(reason);
}

/**
 * Create the device/session bridge.
 *
 * @param {object} options
 * @param {object} options.ctx plugin context (host plane)
 * @param {() => object} options.getConfig live settings projection
 * @param {string} options.dataDir plugin data directory
 * @param {object} [options.logger] host logger
 * @param {(agentCtx: object, agent?: object) => void} [options.onAgentScope] called with the own
 *   context of every agent this bridge creates or reuses — the one context whose registry layer
 *   belongs to that speaker conversation (see lib/exposure.js). No other session is ever passed.
 * @param {object} [options.diagnostics] diagnostic sink (see lib/diagnostics.js); a preset that
 *   cannot be opened is reported through it instead of failing the utterance.
 * @returns {object} bridge API
 */
export function createSessionBridge({ ctx, getConfig, dataDir, logger, onAgentScope, diagnostics }) {
  const storePath = join(dataDir, 'devices.json');
  /** @type {Map<string, object>} device records keyed by host */
  const records = new Map();
  /** @type {Map<string, {dispose?: () => Promise<void>}>} live agent handles keyed by session id */
  const handles = new Map();
  /** @type {Map<string, Promise<object>>} in-flight agent creation keyed by device key */
  const pending = new Map();
  let loaded = false;
  let saveTimer = null;
  /** Version read from disk, so the upgraded store can be written back once. */
  let storedVersionSeen = null;
  /** Last preset resolution, as reported by `/health`; null when nothing is configured. */
  let presetState = null;
  /** Session ids already bound to the preset in this process. */
  const presetBound = new Set();

  /**
   * Report a condition the speaker works around through the diagnostic sink.
   *
   * Level `warn` on purpose: a preset that fell back and a conversation the user
   * archived both change how the speaker answers without stopping it, and the
   * sink folds a repeated code plus detail into one entry with a count.
   * @param {string} code a declared diagnostic code
   * @param {string} detail what happened, in English (the sink truncates it)
   */
  function noteWarn(code, detail) {
    try {
      diagnostics?.note?.({ code, detail, level: 'warn' });
    } catch {
      // Diagnostics are never worth failing a delivery over.
    }
  }

  function load() {
    if (loaded) return;
    loaded = true;
    if (!existsSync(storePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(storePath, 'utf8'));
      const list = Array.isArray(parsed?.devices) ? parsed.devices : [];
      const storedVersion = Number.isFinite(parsed?.version) ? parsed.version : 1;
      storedVersionSeen = storedVersion;
      // See DEVICE_STORE_VERSION: anything below the current version may point
      // at a session the host will not serve, so its link is dropped here.
      const retireSessions = storedVersion < DEVICE_STORE_VERSION;
      if (retireSessions && list.length > 0) {
        logger?.info?.(
          `dsh-xiaoai-bridge: device store v${storedVersion} has no working directory on its sessions; starting fresh sessions`,
        );
      }
      for (const entry of list) {
        if (entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key.length > 0) {
          records.set(entry.key, {
            key: entry.key,
            host: typeof entry.host === 'string' ? entry.host : '',
            name: typeof entry.name === 'string' ? entry.name : '',
            sessionId: !retireSessions && typeof entry.sessionId === 'string' && entry.sessionId.length > 0
              ? entry.sessionId
              : null,
            utterances: Number.isFinite(entry.utterances) ? entry.utterances : 0,
            createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
            updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
            titleLabel: retireSessions || typeof entry.titleLabel !== 'string' ? '' : entry.titleLabel,
          });
        }
      }
    } catch (err) {
      logger?.warn?.(`dsh-xiaoai-bridge: device store unreadable, starting empty: ${messageOf(err)}`);
    }
    // A retired session id is a durable change: write the upgraded store now so
    // a crash before the next utterance cannot resurrect the old link.
    if (typeof storedVersionSeen === 'number' && storedVersionSeen < DEVICE_STORE_VERSION) schedulePersist();
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

  /**
   * Working directory for a new session. Never empty.
   *
   * This is not cosmetic. DSH records the directory in the session header, and
   * the host's session controller refuses to serve a session whose header has
   * no `cwd` — it answers `session/not-found`, so the GUI shows
   * "历史加载失败" for a session that is sitting intact on disk. The
   * `deployment:persona-suffix` prompt section also needs `{{cwd}}`, so an
   * empty directory kills every turn as well. Both symptoms have this one
   * cause, which is why the fallback chain terminates in a real absolute path
   * instead of returning the empty string.
   * @returns {string} an absolute, existing-or-creatable directory
   */
  function sessionCwd() {
    const raw = String(getConfig()?.sessionCwd ?? '').trim();
    if (raw.length > 0) {
      if (isAbsolute(raw)) return raw;
      logger?.warn?.(`dsh-xiaoai-bridge: sessionCwd must be an absolute path, ignoring: ${raw}`);
    }
    // Prefer a workspace the host already owns, so the session lands in the
    // same project group as the user's own sessions instead of a new bucket.
    try {
      const registry = ctx.get?.('workspaceRegistry');
      const first = registry?.list?.()?.[0];
      const dir = typeof first?.path === 'string' ? first.path.trim() : '';
      if (dir.length > 0 && isAbsolute(dir)) return dir;
    } catch {
      // An unstarted or absent registry simply has no opinion.
    }
    const cwd = String(process.cwd?.() ?? '').trim();
    if (cwd.length > 0 && isAbsolute(cwd)) return cwd;
    return homedir();
  }

  function agentsService() {
    try {
      return ctx.get?.('agents') ?? ctx.agents ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Whether the host has this conversation in its archive.
   *
   * Archiving is a display-level, durable host concept: the session file stays
   * where it is. What changes is admission — the host's archived-session gate
   * refuses every model step proposed for an archived conversation (or for a
   * subagent descendant of one). A follow-up to one is therefore accepted by
   * `agent.followup()`, appended to the store, and then dropped by the loop as
   * `blocked`, with no request and no reply. Nothing throws and nothing is
   * logged, which is exactly why the plugin asks before it reuses a conversation
   * (see `ensureAgent`).
   * @param {string|null} sessionId the conversation the device record points at
   * @returns {boolean} true when the host reports it as archived
   */
  function isArchived(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
    try {
      const archived = ctx.get?.('workspaceRegistry')?.archivedSessionIds;
      if (!archived) return false;
      return [...archived].some((id) => String(id) === sessionId);
    } catch {
      // An unstarted or absent registry simply has no opinion.
      return false;
    }
  }

  function track(sessionId, handle) {
    handles.set(sessionId, handle);
  }

  /**
   * Put a freshly created session into its project group.
   *
   * A sidebar group is a workspace: a registered directory plus the sessions
   * explicitly accounted to it. Membership is *not* implied by cwd — the host's
   * own session controller attaches a session only when the caller names a
   * workspace — and the host refuses to attach a session whose stored cwd is not
   * exactly the workspace path. So look the cwd up in the registry and attach
   * only when the two agree; a session in a subdirectory honestly stays
   * "ungrouped" instead of being forced into the nearest group.
   * @param {string} sessionId the session that was just created
   * @param {string} cwd the cwd that session was created with
   */
  async function attachToWorkspace(sessionId, cwd) {
    try {
      const registry = ctx.get?.('workspaceRegistry');
      // `resolveByPath` is async on the host (it canonicalizes the path first).
      const workspace = await registry?.resolveByPath?.(cwd);
      if (!workspace || typeof workspace.attachSession !== 'function') return;
      await workspace.attachSession(sessionId);
    } catch (err) {
      // Grouping is presentation: a host without workspaces, or one that has not
      // flushed the new header yet, must not break delivery.
      logger?.info?.(`dsh-xiaoai-bridge: session ${sessionId} stays ungrouped: ${messageOf(err)}`);
    }
  }

  /**
   * The project groups this host already owns, in the shape the settings page
   * offers them.
   *
   * The page lists these instead of accepting a typed path because the host
   * groups a session only when its stored cwd is exactly a workspace path: a
   * path the user cannot verify is a path that quietly leaves the speaker in
   * "ungrouped", and an unaccounted session can never be moved in afterwards.
   * @returns {Array<{id: string, path: string, title: string}>}
   */
  function workspaceGroups() {
    try {
      const registry = ctx.get?.('workspaceRegistry');
      const rows = registry?.list?.() ?? [];
      const out = [];
      for (const row of rows) {
        const path = String(row?.path ?? '').trim();
        if (path.length === 0) continue;
        out.push({ id: String(row?.id ?? ''), path, title: String(row?.title ?? '').trim() });
      }
      return out;
    } catch {
      // A host without workspaces offers no groups; the page then shows only
      // "follow the default".
      return [];
    }
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

  /**
   * Apply the device label as the session title, once per label.
   *
   * The name usually arrives one utterance *after* the session was created (the
   * bridge only learns it from the plugin's environment), so renaming only at
   * creation time leaves every existing session labelled with its bare IP. The
   * stored label keeps this from appending a title event on every utterance.
   * @param {object} agent the live agent
   * @param {object} record its device record
   */
  function applyTitle(agent, record) {
    const label = record.name || record.host || '小爱音箱';
    if (record.titleLabel === label) return;
    record.titleLabel = label;
    record.updatedAt = Date.now();
    schedulePersist();
    renameSession(agent, record);
  }

  /**
   * Point the exposure hook at one agent.
   *
   * `setup` covers an agent as it is created; this covers the two other paths —
   * an agent that was already running when this plugin loaded, and a host build
   * that ignores `setup` — and is idempotent per agent context, so calling it on
   * every delivery is free.
   * @param {object} agentCtx the agent's own context
   * @param {object} [agent] the live agent
   */
  function announce(agentCtx, agent) {
    if (typeof onAgentScope !== 'function') return;
    try {
      onAgentScope(agentCtx, agent);
    } catch (err) {
      logger?.warn?.(`dsh-xiaoai-bridge: agent scope hook failed: ${messageOf(err)}`);
    }
  }

  /**
   * Open the configured Agent preset, if this host keeps a preset registry.
   *
   * "Open" means resolve the id and hold a revision lease until the agent has
   * been created or resumed — the sequence the host's own webhook uses. A
   * recompose landing between `resolve` and `mount` would otherwise revoke the
   * generation the agent is about to bind to.
   *
   * Every failure degrades to the host default instead of failing the utterance:
   * a speaker that answers in the wrong style is better than one that does not
   * answer. The reason stays visible in `presetState()` (reported by `/health`)
   * and, once per code, in the diagnostics list.
   * @returns {Promise<{id: string, lease: object|null}|null>} the opened preset
   */
  async function openPreset() {
    const want = String(getConfig?.()?.agentPreset ?? '').trim();
    if (want.length === 0) {
      presetState = null;
      return null;
    }
    const registry = ctx.get?.('agentPresets');
    if (!registry || typeof registry.resolve !== 'function') {
      presetState = { configured: want, resolved: null, reason: 'no-registry' };
      return null;
    }
    let preset;
    try {
      preset = await registry.resolve(want);
    } catch (err) {
      presetState = { configured: want, resolved: null, reason: 'missing' };
      noteWarn('agent-preset-missing', `"${want}" is not installed, so this session uses the host default preset: ${messageOf(err)}`);
      return null;
    }
    if (!preset || preset.broken) {
      presetState = { configured: want, resolved: null, reason: 'broken' };
      noteWarn('agent-preset-broken', `"${want}" is declared but cannot be activated, so this session uses the host default preset: ${describeBroken(preset?.broken)}`);
      return null;
    }
    let lease = null;
    if (typeof registry.acquireScope === 'function') {
      try {
        lease = await registry.acquireScope(preset.id);
      } catch (err) {
        logger?.warn?.(`dsh-xiaoai-bridge: could not lease preset "${preset.id}": ${messageOf(err)}`);
      }
    }
    presetState = { configured: want, resolved: preset.id, reason: null };
    return { id: preset.id, lease };
  }

  /** Release the revision lease `openPreset` took; a lease that never opened is ignored. */
  async function closePreset(opened) {
    const dispose = opened?.lease?.[Symbol.asyncDispose];
    if (typeof dispose !== 'function') return;
    try {
      await dispose.call(opened.lease);
    } catch (err) {
      logger?.warn?.(`dsh-xiaoai-bridge: releasing preset "${opened.id}" failed: ${messageOf(err)}`);
    }
  }

  /**
   * Bind one agent context to the preset.
   *
   * `mount` retains the revision and binds it to the agent's own scope, so the
   * preset's plugins — persona, tools, prompt sections — belong to that
   * conversation. Binding is remembered per session because `setup` runs on
   * every create and resume while the reuse path runs on every utterance, and a
   * rebind there would churn the generation for nothing.
   * @param {object} agentCtx the agent's own context
   * @param {object} agent the live agent
   * @param {{id: string, lease: object|null}} opened the opened preset
   */
  async function bindPreset(agentCtx, agent, opened) {
    if (!opened || !agentCtx) return;
    const sessionId = agent?.session?.id;
    if (typeof sessionId === 'string' && presetBound.has(sessionId)) return;
    const registry = ctx.get?.('agentPresets');
    if (typeof registry?.mount !== 'function') return;
    try {
      await registry.mount(agentCtx, opened.id);
    } catch (err) {
      noteWarn('agent-preset-mount-failed', `could not bind preset "${opened.id}", so this session uses the host default preset: ${messageOf(err)}`);
      return;
    }
    if (typeof sessionId === 'string') presetBound.add(sessionId);
  }

  /**
   * Options that both `resume` and `create` need so the agent can reach a model.
   * See `resolveModelHelpers` for why `agentOptions` is mandatory.
   *
   * The selection is read here, at creation or resume time, and pinned for the
   * session's lifetime; see `modelSelectionSetup` for why that is deliberate.
   *
   * The three hooks stay independent on purpose: a host that cannot name a
   * default model still gets a speaker session that can speak, and a preset that
   * is missing still gets one — each degradation is local to what failed.
   * @param {{id: string, lease: object|null}|null} opened the opened preset
   * @returns {Promise<object>} spreadable factory options
   */
  async function factoryOptions(opened) {
    const selection = currentSelection(ctx);
    const hooks = [];
    if (opened) hooks.push((agentCtx, agent) => bindPreset(agentCtx, agent, opened));
    if (selection) {
      hooks.push(modelSelectionSetup(await resolveModelInstaller(), selection));
    } else {
      logger?.warn?.('dsh-xiaoai-bridge: no default model selection on this host; the first turn may fail');
    }
    if (typeof onAgentScope === 'function') hooks.push(announce);
    const options = {};
    if (selection) options.agentOptions = { provider: selection.provider, model: selection.model };
    if (hooks.length > 0) {
      options.setup = async (agentCtx, agent) => {
        for (const hook of hooks) await hook(agentCtx, agent);
      };
    }
    return options;
  }

  async function ensureAgent(record) {
    const agents = agentsService();
    if (!agents || typeof agents.create !== 'function') {
      throw new Error('DSH agents service is unavailable');
    }
    const opened = await openPreset();
    try {
      const factory = await factoryOptions(opened);
      // A conversation the user archived is one the host will not run any more,
      // so the binding is retired here instead of being reused (see
      // `isArchived`). This is what turns "the speaker stopped answering" into a
      // fresh conversation on the very utterance that would otherwise be lost.
      if (record.sessionId && isArchived(record.sessionId)) {
        const retired = record.sessionId;
        logger?.info?.(`dsh-xiaoai-bridge: session ${retired} is archived; starting a new conversation`);
        noteWarn('session-archived-rebound', `session ${retired} is archived, so this utterance starts a new conversation`);
        record.sessionId = null;
        // Cleared so the new conversation gets the device's title again.
        record.titleLabel = '';
        record.updatedAt = Date.now();
        schedulePersist();
      }
      if (record.sessionId) {
        const live = agents.get?.(record.sessionId);
        if (live) {
          await bindPreset(live.ctx, live, opened);
          announce(live.ctx, live);
          applyTitle(live, record);
          return live;
        }
        try {
          const handle = await agents.resume({ resumeSessionId: record.sessionId, ...factory });
          track(record.sessionId, handle);
          announce(handle.agent?.ctx, handle.agent);
          applyTitle(handle.agent, record);
          // Heals a session created before its workspace existed (or before this
          // plugin attached at all); harmless when it is already accounted.
          await attachToWorkspace(record.sessionId, sessionCwd());
          return handle.agent;
        } catch (err) {
          // A first-run session was never persisted, so resume failing is the
          // normal path for a brand-new device; only a real error is worth a log.
          logger?.info?.(`dsh-xiaoai-bridge: session ${record.sessionId} not resumable, creating a new one: ${messageOf(err)}`);
        }
      }
      const sessionId = SESSION_ID_PREFIX + randomUUID();
      // Always present: see `sessionCwd`. A header without `cwd` is a session the
      // host will not serve and whose `{{cwd}}` prompt variable has no value.
      const cwd = sessionCwd();
      // The header records the preset revision the session started in, which is
      // what makes the composition survive a restart and a resume.
      const meta = opened ? { cwd, agentPreset: opened.id } : { cwd };
      const handle = await agents.create({ sessionId, meta, ...factory });
      record.sessionId = sessionId;
      record.updatedAt = Date.now();
      track(sessionId, handle);
      announce(handle.agent?.ctx, handle.agent);
      applyTitle(handle.agent, record);
      schedulePersist();
      await attachToWorkspace(sessionId, cwd);
      return handle.agent;
    } finally {
      await closePreset(opened);
    }
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
        titleLabel: '',
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

  /**
   * The device `xiaoai_speak` falls back to when the calling session is not one
   * this bridge created.
   *
   * Returns the first configured device, or null when there is none. With two
   * or more devices "first" means first in this process's record order: the
   * on-disk store is written sorted by key, but a device seen for the first time
   * after startup lands last. That is a guess, and it stays a small one because
   * the fallback only feeds the device key written to spoken.jsonl, so a wrong
   * guess mislabels a log line instead of sending audio to the wrong speaker.
   * @returns {object|null} the fallback device record, or null when none exist
   */
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

  return { deliver, list, deviceForSession, primaryDevice, workspaceGroups, dispose, storePath, presetState: () => presetState };
}
