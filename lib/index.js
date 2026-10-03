/**
 * dsh-xiaoai-bridge host plugin.
 *
 * The plugin owns two halves of the voice loop and keeps them in one process:
 *
 * - It supervises the Python bridge (see `process.js`), which is what actually
 *   holds the speaker's WebSocket and the local ASR/keyword stack.
 * - It turns whatever the bridge recognizes into a DSH session message (see
 *   `session.js`), and lets the model answer back through `xiaoai_speak`
 *   (see `tools.js`).
 *
 * Nothing in this file talks to the speaker directly: playback is the bridge's
 * job, reached over loopback HTTP by `bridge.js`.
 * @module dsh-xiaoai-bridge
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { CONFIG_SCHEMA, plainConfig, sanitizeConfig } from './config.js';
import { mountHttp } from './http.js';
import { PACKAGE_ROOT, SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_DIR, SKILL_NAME } from './skill.js';
import { createBridgeSupervisor } from './process.js';
import { createBridgeClient, dialableHost } from './bridge.js';
import { createSessionBridge, currentSelection } from './session.js';
import { createSpeakTool, SPEAK_TOOL_NAME } from './tools.js';
import { createSpokenLog } from './speech-log.js';
import { createReplyer } from './replyer.js';
import { createAutoSpeak } from './auto-speak.js';
import { createDiagnostics } from './diagnostics.js';
import { createExposure } from './exposure.js';
import { createCleanup } from './cleanup.js';
import { SPEAKER_PORT, heldPorts } from './ports.js';
import { renderConfigPath, splitList } from './render-config.js';

const require = createRequire(import.meta.url);
/** Plugin version read from the package manifest (single source of truth). */
export const PLUGIN_VERSION = require('../package.json').version ?? '0.0.0';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'xiaoai';
/** Required host-plane services. */
export const inject = ['tools', 'skills', 'settings', 'credentials', 'agents'];
/** Entry config schema (validated by the Loader). */
export const Config = CONFIG_SCHEMA;

/** Directory name under `$DSH_HOME` holding the bridge log, pid file and device map. */
const DATA_DIR_NAME = 'xiaoai-bridge';
/** Fallback credential reference when the settings field is blank. */
const DEFAULT_CREDENTIAL_REF = 'XIAOAI_API_TOKEN';
/**
 * How long the status card waits for the bridge API Server.
 *
 * Shorter than a playback timeout on purpose: the card is answering "is it
 * there", and a user staring at a settings page should not wait 15 seconds to be
 * told the bridge is not running.
 */
const BRIDGE_PROBE_TIMEOUT_MS = 1500;

/** @param {unknown} err @returns {string} a bounded message string */
function messageOf(err) {
  return String(err?.message ?? err).slice(0, 300);
}

/**
 * Resolve the settings namespace this plugin's card is keyed by.
 *
 * DSH 2.x derives the card from the exported `Config` and reports it under the
 * owning profile entry id, which is also the id `settings.update` writes to. The
 * `/plugin/xiaoai` routes must look the card up under that id rather than under
 * the constant the installer happened to write.
 * @param {object} ctx plugin context
 * @returns {string} the profile entry id, or 'xiaoai' when it cannot be read
 */
export function settingsNamespace(ctx) {
  try {
    const id = ctx?.fiber?.entry?.options?.id;
    if (typeof id === 'string' && id.length > 0) return id;
  } catch {
    // A fiber with no owning entry (or an unreadable computed id) falls back.
  }
  return 'xiaoai';
}

/**
 * Split the wake-word field into individual keywords.
 *
 * Delegates to the one splitter in `lib/render-config.js`: the keywords sent to
 * the bridge over the keyword hot-reload call and the keywords written into
 * `config.py` have to be the same words. They used to be split by two different
 * regexes, so `小爱小爱，小爱同学` became one keyword here and one impossible
 * keyword there (a comma is not a scorable word, so sherpa dropped it in
 * silence and the speaker never woke).
 * @param {string} text raw field value
 * @returns {string[]} non-empty, trimmed keywords in declaration order
 */
export function parseWakeKeywords(text) {
  return splitList(text);
}

/** Resolve a config path relative to the package root. */
function resolveFromPackage(value, fallback) {
  const raw = String(value ?? '').trim();
  if (raw.length === 0) return fallback;
  return isAbsolute(raw) ? raw : resolve(PACKAGE_ROOT, raw);
}

/** Default interpreter inside the bridge virtual environment. */
export function defaultPythonPath(bridgeDir) {
  return process.platform === 'win32'
    ? join(bridgeDir, '.venv', 'Scripts', 'python.exe')
    : join(bridgeDir, '.venv', 'bin', 'python');
}

/** Plugin data directory, following the DSH data-directory convention. */
export function resolveDataDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, DATA_DIR_NAME);
}

/** Lazily resolved `credentialRef`, `null` once known unavailable. */
let credentialRefImpl;
let credentialRefResolved = false;

/**
 * Turn a plain reference name into the host's credential reference.
 *
 * `@deepseek-ai/dsh-credentials` is host-provided, so the import is deferred and
 * a bare name is used as the fallback: the reference is a branded string, and a
 * plugin that cannot brand it still reads and writes the same slot.
 * @param {string} name POSIX-shaped reference name
 * @returns {Promise<string>} the reference to hand to `ctx.credentials`
 */
async function credentialRefFor(name) {
  if (!credentialRefResolved) {
    credentialRefResolved = true;
    try {
      const mod = await import('@deepseek-ai/dsh-credentials');
      credentialRefImpl = typeof mod?.credentialRef === 'function' ? mod.credentialRef : null;
    } catch {
      credentialRefImpl = null;
    }
  }
  return credentialRefImpl ? credentialRefImpl(name) : name;
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] entry config (composition layer); `meta.volatile`
 *   fields arrive as live references rather than plain values
 */
export function apply(ctx, config) {
  // Every read re-projects the entry config, so a settings write reaches the
  // next call without a restart (DSH 2.x seam; there is no `settings.register`).
  //
  // The projection is repaired, not trusted: the schema is the settings page's
  // contract, and a local `POST /config`, a composition base or a patch stored
  // before a rule was tightened can all hand over a value the schema would have
  // rejected. A field that cannot be used falls back to its default and the
  // repair is logged once per distinct set, so `apiServerPort=70000` shows up as
  // a warning and a working bridge instead of a silent failure.
  let repairsReported = '';
  const configNow = () => {
    const { value, repairs } = sanitizeConfig(plainConfig(config));
    if (repairs.length > 0) {
      const signature = repairs.map((repair) => `${repair.key}=${JSON.stringify(repair.bad)}`).sort().join(',');
      if (signature !== repairsReported) {
        repairsReported = signature;
        const detail = repairs.map((repair) => `${repair.key}=${JSON.stringify(repair.bad)} (${repair.message})`).join('; ');
        ctx.logger?.warn?.(`dsh-xiaoai-bridge: unusable config repaired with defaults: ${detail}`);
      }
    }
    return value;
  };
  // Read once up front so a bad stored patch is reported at activation rather
  // than at the first status refresh.
  const loadCfg = configNow();
  const settingsNs = settingsNamespace(ctx);
  const dataDir = resolveDataDir();

  /** Reference name the API token lives under, never the token itself. */
  function credentialName() {
    const raw = String(configNow().apiServerTokenCredential ?? '').trim();
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) ? raw : DEFAULT_CREDENTIAL_REF;
  }

  /** @returns {Promise<string|null>} the API bearer token, or null when unset */
  async function resolveToken() {
    try {
      const ref = await credentialRefFor(credentialName());
      const value = await ctx.credentials.resolve(ref);
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch (err) {
      ctx.logger?.warn?.(`dsh-xiaoai-bridge: credential lookup failed: ${messageOf(err)}`);
      return null;
    }
  }

  /** @returns {Promise<boolean>} whether the token slot holds a value */
  async function tokenConfigured() {
    try {
      const ref = await credentialRefFor(credentialName());
      const info = await ctx.credentials.describe(ref);
      return Boolean(info?.configured);
    } catch {
      return false;
    }
  }

  /**
   * Make sure a token exists before the bridge starts.
   *
   * The upstream API Server has no authentication at all; this fork requires a
   * bearer token, and generating one on first start is what keeps the
   * "authenticated by default" promise from depending on the user inventing a
   * secret. The value is written straight into DSH Credentials and never
   * crosses the settings card.
   * @returns {Promise<string|null>} the token in use
   */
  async function ensureToken() {
    const existing = await resolveToken();
    if (existing) return existing;
    const generated = randomUUID().replace(/-/g, '');
    try {
      const ref = await credentialRefFor(credentialName());
      await ctx.credentials.set(ref, generated);
      ctx.logger?.info?.(`dsh-xiaoai-bridge: provisioned credential ${credentialName()} for the bridge API token`);
      return generated;
    } catch (err) {
      ctx.logger?.warn?.(`dsh-xiaoai-bridge: could not provision an API token: ${messageOf(err)}`);
      return null;
    }
  }

  // The one secret both halves of the pair have to agree on: the environment the
  // bridge is spawned with, and the bearer `/asr` fails closed against.
  //
  // `resolveToken` alone is not enough for that. A credential store can answer
  // `describe` (the settings card says "configured") and still hand back nothing
  // from `resolve`; the bridge would then be spawned without a token while `/asr`
  // expected one, and every utterance would be refused with a 503 that looks like
  // a broken speaker. `ensureToken` returns the value it just stored, so when the
  // store stops answering we hold that value for as long as this process lives and
  // both halves use it. While the store *does* answer it stays authoritative, so a
  // rotated credential still reaches the next call.
  let heldToken = null;
  let heldFor = null;
  async function currentToken() {
    const name = credentialName();
    const stored = await resolveToken();
    if (stored) {
      heldToken = null;
      heldFor = null;
      return stored;
    }
    if (heldToken && heldFor === name) return heldToken;
    const token = await ensureToken();
    if (token) {
      heldToken = token;
      heldFor = name;
    }
    return token;
  }

  const state = {
    getConfig: configNow,
    dataDir,
    /** Resolved filesystem locations derived from the live config. */
    paths() {
      const cfg = configNow();
      const bridgeDir = resolveFromPackage(cfg.bridgeDir, join(PACKAGE_ROOT, 'bridge'));
      const explicit = String(cfg.pythonPath ?? '').trim();
      return {
        packageRoot: PACKAGE_ROOT,
        bridgeDir,
        pythonPath: explicit.length === 0 ? defaultPythonPath(bridgeDir) : resolveFromPackage(explicit, defaultPythonPath(bridgeDir)),
        modelsDir: join(bridgeDir, 'core', 'models'),
        skillDir: SKILL_DIR,
        dataDir,
        configPath: renderConfigPath(dataDir),
      };
    },
    /**
     * The project groups the host already owns, as the settings page offers them.
     *
     * The page must not ask for a typed path: the host groups a session only
     * when its stored cwd is exactly the group's directory, so a path the user
     * cannot verify is a path that quietly leaves the speaker in "ungrouped".
     * Listing the registry's own entries makes the choice one the host honours.
     * @returns {Array<{id: string, path: string, title: string}>}
     */
    workspaces() {
      // Read through the session bridge, which owns every other conversation
      // with the workspace registry (see `lib/session.js`).
      try {
        return sessions.workspaceGroups();
      } catch {
        return [];
      }
    },
    /**
     * Ask the bridge API Server whether it is answering, right now.
     *
     * The status card has to distinguish "the process is up" from "the process
     * answers": a Python half that is still importing, or that crashed after
     * spawning, shows up as a running pid that plays nothing. The probe is the
     * same request a spoken line takes, so a green card means the next line will
     * get through.
     * @returns {Promise<{state: string, url: string, auth: string|null, asr: object|null, error: string|null, checkedAt: string}>}
     */
    async probeBridgeApi() {
      const cfg = configNow();
      const url = 'http://' + cfg.apiServerHost + ':' + cfg.apiServerPort;
      const checkedAt = new Date().toISOString();
      if (cfg.apiServerEnabled === false) {
        return { state: 'disabled', url, auth: null, asr: null, error: 'API Server is turned off', checkedAt };
      }
      const result = await bridge.health({ timeoutMs: BRIDGE_PROBE_TIMEOUT_MS });
      if (result.ok) {
        // `asr` is the bridge telling us which speech-to-text backend it is
        // really running, next to the one the settings page asks for.
        return { state: 'connected', url, auth: result.data?.data?.auth ?? null, asr: result.data?.data?.asr ?? null, error: null, checkedAt };
      }
      const rejected = result.status === 401 || result.status === 403;
      return {
        state: rejected ? 'unauthorized' : 'unreachable',
        url,
        auth: null,
        asr: null,
        error: result.error ?? null,
        checkedAt,
      };
    },
    /** Non-secret facts for the settings tab and status probes. */
    async collectFacts() {
      const cfg = configNow();
      const paths = state.paths();
      let bridgeDirIsDirectory = false;
      try {
        bridgeDirIsDirectory = existsSync(paths.bridgeDir) && statSync(paths.bridgeDir).isDirectory();
      } catch {
        bridgeDirIsDirectory = false;
      }
      const bridgeState = supervisor.state();
      // A watchdog that stopped trying is a one-line fact the card must show;
      // report it once, not once per health refresh.
      if (bridgeState.watchdogGaveUp) {
        const detail = bridgeState.lastError ?? 'the watchdog stopped restarting the bridge';
        if (!diagnostics.recent().some((entry) => entry.code === 'watchdog-gave-up' && entry.detail === detail)) {
          diagnostics.note({ code: 'watchdog-gave-up', detail });
        }
      }
      const tokenReady = await tokenConfigured();
      const bridgeApi = await state.probeBridgeApi();
      // `auth: loopback-only` is the bridge saying it came up before a token
      // existed: it answers this plugin over loopback but would turn a remote
      // caller away. One restart applies the token, so the card gets one line
      // instead of a green "connected" that is only true from this machine.
      if (bridgeApi.auth === 'loopback-only' && tokenReady) {
        const detail = 'the bridge started before the API token existed; restart the bridge to apply it';
        if (!diagnostics.recent().some((entry) => entry.code === 'token-not-applied')) {
          diagnostics.note({ code: 'token-not-applied', detail, level: 'warn' });
        }
      }
      // The bridge keeps the recognizer it already loaded when the backend picked
      // in the settings cannot be loaded, so "I switched it and nothing changed"
      // would otherwise be the only signal the user ever gets.
      const asr = bridgeApi.asr;
      if (bridgeApi.state === 'connected' && asr) {
        const unavailable = asr.known === false
          || Boolean(asr.error)
          || Boolean(asr.requested && asr.active && asr.requested !== asr.active);
        if (unavailable) {
          const detail = asr.error
            ? `${asr.requested} cannot be loaded: ${asr.error}`
            : `${asr.requested} is not available; ${asr.active} is still loaded`;
          if (!diagnostics.recent().some((entry) => entry.code === 'asr-model-unavailable' && entry.detail === detail)) {
            diagnostics.note({ code: 'asr-model-unavailable', detail, level: 'warn' });
          }
        }
      }
      return {
        phase: 3,
        enabled: cfg.enabled,
        pluginVersion: PLUGIN_VERSION,
        namespace: settingsNs,
        deviceName: cfg.deviceName,
        deviceHost: cfg.deviceHost,
        autoStart: cfg.autoStart,
        apiServerEnabled: cfg.apiServerEnabled,
        apiServerUrl: 'http://' + cfg.apiServerHost + ':' + cfg.apiServerPort,
        apiServerTokenCredential: cfg.apiServerTokenCredential,
        tokenConfigured: tokenReady,
        wakeKeywords: parseWakeKeywords(cfg.wakeKeywords),
        exitKeywords: splitList(cfg.exitKeywords),
        wakeupReplyText: cfg.wakeupReplyText,
        exitReplyText: cfg.exitReplyText,
        wakeupTimeout: cfg.wakeupTimeout,
        fallbackText: cfg.fallbackText,
        ttsSpeaker: cfg.ttsSpeaker,
        sessionKey: cfg.sessionKey,
        asrBackend: cfg.asrBackend,
        sessionCwd: cfg.sessionCwd,
        workspaces: state.workspaces(),
        logLevel: cfg.logLevel,
        configPath: renderConfigPath(dataDir),
        spokenLogPath: spokenLog.path,
        // The cap is enforced by rotation; the size is the visible half of it,
        // so "the disk is filling up" has an answer on the card.
        spokenLogBytes: await spokenLog.size(),
        paths,
        checks: {
          bridgeDirIsDirectory,
          pythonExists: existsSync(paths.pythonPath),
          modelsDirExists: existsSync(paths.modelsDir),
          skillFileExists: existsSync(join(SKILL_DIR, 'SKILL.md')),
          configFileExists: existsSync(renderConfigPath(dataDir)),
        },
        bridge: supervisor.state(),
        bridgeApi,
        diagnostics: diagnostics.recent(),
        sessions: sessions.list(),
        tool: SPEAK_TOOL_NAME,
        // Where the speak tool currently lives: `scoped` (one registry layer per
        // speaker session), `global` (the speakFromAnySession escape hatch), or
        // `unavailable` (this host has no per-session seam, so nothing registered).
        exposure: exposure?.state?.() ?? null,
        // Which Agent preset the speaker conversation was last created in, and
        // why it fell back to the host default when it did (lib/session.js).
        preset: sessions.presetState?.() ?? null,
      };
    },
  };

  const supervisor = createBridgeSupervisor({
    getConfig: configNow,
    paths: () => state.paths(),
    dataDir,
    logger: ctx.logger,
    resolveToken: currentToken,
    onLogLine: (line) => {
      if (/\[ERROR\]|\[CRITICAL\]|Traceback/.test(line)) ctx.logger?.warn?.(`dsh-xiaoai-bridge[bridge]: ${line}`);
    },
  });

  /**
   * Where `xiaoai_speak` and its skill are registered (see lib/exposure.js).
   *
   * Assigned further down, once the bridge client and the automatic speaker
   * exist. The session bridge below only *calls* this hook — from an agent's
   * `setup`, which cannot run before this plugin has finished loading.
   * @type {object|null}
   */
  let exposure = null;

  const diagnostics = createDiagnostics({ logger: ctx.logger });
  const bridge = createBridgeClient({ getConfig: configNow, resolveToken: currentToken, logger: ctx.logger, diagnostics });
  const cleanup = createCleanup({ dataDir, logger: ctx.logger });
  const sessions = createSessionBridge({
    ctx,
    getConfig: configNow,
    dataDir,
    logger: ctx.logger,
    // A preset that is configured but not installed is a warning, not a failed
    // utterance, so the session bridge reports it through the same sink the rest
    // of the plugin uses (lib/diagnostics.js).
    diagnostics,
    // The speaker agent's own context is the only place the speak tool belongs,
    // and `setup` is the one moment the host hands it over (lib/exposure.js).
    // Declared below: no session exists before this plugin finishes loading.
    onAgentScope: (agentCtx, agent) => exposure?.attach(agentCtx, agent),
  });
  const spokenLog = createSpokenLog({ dataDir, logger: ctx.logger });
  const replyer = createReplyer({ ctx, logger: ctx.logger });

  /**
   * Model routes observed in the event stream, keyed by session id.
   *
   * The reply generator normally follows the conversation's model, and the
   * conversation's model is whatever the user last picked in that session — which
   * only the event stream knows. The host default is the fallback for a session
   * that never announced a selection (and the route `session.js` pinned at
   * creation).
   * @type {Map<string, {provider: string, model: string}>}
   */
  const sessionRoutes = new Map();

  /** @param {string} sessionId session key @returns {{provider: string, model: string}|null} route */
  function sessionRouteFor(sessionId) {
    const tracked = sessionId ? sessionRoutes.get(sessionId) : null;
    if (tracked) return tracked;
    return currentSelection(ctx);
  }

  const autoSpeak = createAutoSpeak({
    getConfig: configNow,
    bridge,
    replyer,
    spokenLog,
    sessionRoute: sessionRouteFor,
    logger: ctx.logger,
  });

  // Render the bridge config at load time, not only on start: a card that opens
  // before the first spawn should describe the file the bridge will actually
  // read, and a bridge that is already running picks the change up through its
  // own one-second watcher.
  supervisor.renderConfig();

  /**
   * A fresh tool definition per registration.
   *
   * Each registry layer owns what it is given and unwinds it on its own, so two
   * scopes never share one definition object.
   * @returns {object} the `xiaoai_speak` tool definition
   */
  const speakTool = () => createSpeakTool({
    getConfig: configNow,
    bridge,
    sessions,
    autoSpeak,
    // A proactive line has no user watching the settings card, so the tool asks
    // the supervisor for a bridge instead of reporting a dead one (phase 4.1).
    ensureBridge: () => supervisor.ensureStarted(),
    logger: ctx.logger,
  });

  /** @returns {object} a fresh `xiaoai-speak` skill registration */
  const speakSkill = () => ({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    source: 'runtime',
    content: SKILL_CONTENT,
    resourceBase: { kind: 'directory', path: SKILL_DIR },
  });

  exposure = createExposure({
    ctx,
    getConfig: configNow,
    logger: ctx.logger,
    diagnostics,
    tool: speakTool,
    skill: speakSkill,
  });

  // The escape hatch is live rather than restart-bound: while
  // `speakFromAnySession` is on, both entries sit in the global layer (the
  // pre-scoping behaviour), and turning it off takes them out again. The
  // handler re-reads the whole projection, so it does not need to know which
  // document changed.
  ctx.effect(() => {
    exposure.syncGlobal();
    return ctx.on('settings/document-updated', () => {
      try {
        exposure.syncGlobal();
      } catch (err) {
        ctx.logger?.warn?.(`dsh-xiaoai-bridge: following the speak-scope setting failed: ${messageOf(err)}`);
      }
    });
  }, 'dsh-xiaoai-bridge: xiaoai_speak exposure');

  // Scoped registrations belong to their agent scope and are unwound with it;
  // only the global layer is this plugin's to drop.
  ctx.effect(() => () => exposure?.dispose?.(), 'dsh-xiaoai-bridge: xiaoai_speak teardown');

  // The voice loop is driven by the bridge POSTing to /asr (see http.js), which
  // opens a turn on `autoSpeak`; this subscription is what closes it. An
  // utterance that came in through the speaker is answered through the speaker,
  // so the listener both logs the turn and feeds the automatic speaker:
  //
  //   assistant/message -> a draft (a turn can hold several, newest wins)
  //   tool/call         -> xiaoai_speak claimed the turn; the draft is dropped
  //   approval/asked    -> a tool is blocked on the screen; say only where to go
  //   turn/end          -> the only moment anything is spoken
  //
  // Desktop sessions have no device, so they are left alone entirely.
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.id;
      const device = sessions.deviceForSession(sessionId);
      if (!device) return;
      const deviceKey = device.key;
      const type = event?.type;
      const data = event?.data;

      if (type === 'model/selection') {
        if (data && typeof data.provider === 'string' && typeof data.model === 'string') {
          sessionRoutes.set(sessionId, { provider: data.provider, model: data.model });
        }
        return;
      }
      if (type === 'tool/call') {
        autoSpeak.onToolCall(sessionId, data?.name);
        return;
      }
      if (type === 'approval/asked') {
        autoSpeak.onApprovalAsked(sessionId, data);
        return;
      }
      if (type === 'turn/end') {
        autoSpeak.onTurnEnd(sessionId);
        return;
      }
      if (type !== 'user/message' && type !== 'assistant/message') return;
      const blocks = data?.message?.content ?? data?.content ?? [];
      const text = (Array.isArray(blocks) ? blocks : [])
        .map((block) => (block?.type === 'text' ? block.text : ''))
        .join('')
        .trim();
      if (text.length === 0) return;
      const who = type === 'user/message' ? 'user' : 'assistant';
      ctx.logger?.info?.(`dsh-xiaoai-bridge[${deviceKey}] ${who}: ${text.slice(0, 200)}`);
      if (type === 'assistant/message') autoSpeak.onAssistantText(sessionId, text);
    } catch (err) {
      // An observer must never break the append it is watching.
      ctx.logger?.debug?.(`dsh-xiaoai-bridge: session event ignored: ${messageOf(err)}`);
    }
  }), 'dsh-xiaoai-bridge: session event log');

  // Web profile only: the settings tab talks to /plugin/xiaoai.
  ctx.inject(['webServer'], (webCtx) => {
    mountHttp(webCtx, {
      settings: ctx.settings,
      config: configNow,
      settingsNs,
      pluginVersion: PLUGIN_VERSION,
      state,
      sessions,
      supervisor,
      bridge,
      diagnostics,
      cleanup,
      resolveToken: currentToken,
      logger: ctx.logger,
      // Every recognized utterance opens a turn for the automatic speaker; the
      // session events that follow decide what gets said back (see above).
      onUtterance: (input) => autoSpeak.onUtterance(input),
      onConfigWritten: () => supervisor.renderConfig(),
    });
  });

  /**
   * Confirm that teardown really released the two ports the bridge listens on.
   *
   * The OS drops a listening socket when the process dies, but not always in the
   * same tick, so a port that answers once is asked again after a short pause. A
   * listener this plugin never started is not ours to take, and saying so at
   * debug level keeps a shared machine from looking like a leak.
   *
   * @param {{ok?: boolean, stopped?: boolean, error?: string}} stopped result of supervisor.stop()
   * @returns {Promise<number[]>} ports still answering when the dust settled
   */
  async function reportHeldPorts(stopped) {
    const cfg = configNow();
    // Probe the address the bridge was told to bind, not a fixed loopback: a
    // non-loopback `apiServerHost` is supported (docs/deploy.md 12.21), and
    // probing 127.0.0.1 there reports the port free while the bridge is still
    // listening on the LAN address. A wildcard bind (`0.0.0.0`, `::`, `[::]`)
    // answers on loopback, so that is what gets probed and dialed for it --
    // `dialableHost` is the one implementation of that rule. A blank setting is
    // refused by `validateConfig` and repaired to the default on load, so it only
    // arrives here from a half-written config: probe the default too.
    const host = dialableHost(configNow().apiServerHost) || '127.0.0.1';
    const ports = [SPEAKER_PORT, cfg.apiServerPort];
    let held = await heldPorts({ host, ports });
    if (held.length > 0 && stopped?.stopped === true) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      held = await heldPorts({ host, ports: held });
    }
    for (const port of held) {
      if (stopped?.stopped !== true) {
        ctx.logger?.debug?.(`dsh-xiaoai-bridge: port ${port} is served by a process outside this plugin`);
        continue;
      }
      const detail = `port ${port} still accepts connections after the bridge was stopped`
        + (stopped.error ? ` (${messageOf(stopped.error)})` : '');
      diagnostics.note({ code: 'port-held', detail });
      ctx.logger?.warn?.(`dsh-xiaoai-bridge: ${detail}`);
    }
    return held;
  }

  // Lifecycle: start the bridge when the plugin loads, tear the whole process
  // tree down when it unloads. Both sides run detached from `apply` because the
  // host does not wait for either, and a bridge that is slow to boot must not
  // hold up activation of the settings card.
  //
  // Teardown has to be honest about what it can finish: killing the tree is the
  // part that frees 4399/9092, so it is verified rather than assumed, and the
  // data directory is cleaned of everything the next start can rebuild while the
  // spoken log stays (see lib/cleanup.js for why that split is the only safe one
  // when uninstall and shutdown run the same code).
  ctx.effect(() => {
    let released = false;
    void (async () => {
      try {
        const cfg = configNow();
        if (!cfg.enabled) {
          ctx.logger?.info?.('dsh-xiaoai-bridge: bridge autostart skipped (plugin disabled)');
          return;
        }
        if (cfg.autoStart === false) {
          ctx.logger?.info?.('dsh-xiaoai-bridge: bridge autostart skipped (autoStart off)');
          return;
        }
        await ensureToken();
        const result = await supervisor.start();
        if (!result.ok) {
          diagnostics.note({ code: 'start-failed', detail: messageOf(result.error) });
          ctx.logger?.warn?.(`dsh-xiaoai-bridge: bridge did not start: ${messageOf(result.error)}`);
        }
      } catch (err) {
        diagnostics.note({ code: 'start-failed', detail: messageOf(err) });
        ctx.logger?.warn?.(`dsh-xiaoai-bridge: bridge autostart failed: ${messageOf(err)}`);
      }
    })();
    return () => {
      if (released) return;
      released = true;
      return (async () => {
        autoSpeak.dispose();
        sessionRoutes.clear();
        await sessions.dispose();
        const stopped = await supervisor.stop();
        const held = await reportHeldPorts(stopped);
        // `bridge.pid` is the next start's proof of which process is ours. If
        // the stop did not finish — or something still answers on the bridge's
        // ports — deleting the record orphans that process for good: the next
        // start would find no pid file, spawn a second bridge, and lose on the
        // port. Keep the generated files and say why; the next start adopts.
        const unreleased = held.length > 0 || stopped?.ok === false;
        if (unreleased) {
          const reason = held.length > 0
            ? `port(s) ${held.join(', ')} still answer`
            : `stop failed (${messageOf(stopped?.error ?? 'unknown reason')})`;
          ctx.logger?.warn?.(`dsh-xiaoai-bridge: keeping generated files in ${dataDir} (${reason}); the next start adopts the leftover process`);
        }
        cleanup.removeGenerated({ keep: unreleased ? ['bridge.pid'] : [] });
      })();
    };
  }, 'dsh-xiaoai-bridge: bridge lifecycle');

  const loadedPaths = state.paths();
  ctx.logger?.info?.(
    `dsh-xiaoai-bridge ${PLUGIN_VERSION} loaded (namespace=${settingsNs}, bridgeDir=${loadedPaths.bridgeDir}, `
    + `dataDir=${dataDir}, enabled=${loadCfg.enabled}, autoStart=${loadCfg.autoStart})`,
  );
}
