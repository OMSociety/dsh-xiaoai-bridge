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
import { DEFAULTS, CONFIG_SCHEMA, plainConfig, resolveLoadConfig } from './config.js';
import { mountHttp } from './http.js';
import { PACKAGE_ROOT, SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_DIR, SKILL_NAME } from './skill.js';
import { createBridgeSupervisor } from './process.js';
import { createBridgeClient } from './bridge.js';
import { createSessionBridge, currentSelection } from './session.js';
import { createSpeakTool, SPEAK_TOOL_NAME } from './tools.js';
import { createSpokenLog } from './speech-log.js';
import { createReplyer } from './replyer.js';
import { createAutoSpeak } from './auto-speak.js';
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
 * Newlines, commas and the CJK enumeration comma all separate entries.
 * @param {string} text raw field value
 * @returns {string[]} non-empty, trimmed keywords in declaration order
 */
export function parseWakeKeywords(text) {
  return String(text ?? '')
    .split(/[\r\n,，、]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
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
  let loadCfg;
  try {
    loadCfg = resolveLoadConfig(plainConfig(config));
  } catch (err) {
    // A rejected section must not abort activation: the settings card is what
    // lets the user fix it, and a parked fiber would hide that card.
    ctx.logger?.warn?.(`dsh-xiaoai-bridge: invalid config, falling back to defaults: ${messageOf(err)}`);
    loadCfg = { ...DEFAULTS };
  }

  // Every read re-projects the entry config, so a settings write reaches the
  // next call without a restart (DSH 2.x seam; there is no `settings.register`).
  const configNow = () => ({ ...DEFAULTS, ...plainConfig(config) });
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
        tokenConfigured: await tokenConfigured(),
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
        paths,
        checks: {
          bridgeDirIsDirectory,
          pythonExists: existsSync(paths.pythonPath),
          modelsDirExists: existsSync(paths.modelsDir),
          skillFileExists: existsSync(join(SKILL_DIR, 'SKILL.md')),
          configFileExists: existsSync(renderConfigPath(dataDir)),
        },
        bridge: supervisor.state(),
        sessions: sessions.list(),
        tool: SPEAK_TOOL_NAME,
      };
    },
  };

  const supervisor = createBridgeSupervisor({
    getConfig: configNow,
    paths: () => state.paths(),
    dataDir,
    logger: ctx.logger,
    resolveToken,
    onLogLine: (line) => {
      if (/\[ERROR\]|\[CRITICAL\]|Traceback/.test(line)) ctx.logger?.warn?.(`dsh-xiaoai-bridge[bridge]: ${line}`);
    },
  });

  const bridge = createBridgeClient({ getConfig: configNow, resolveToken, logger: ctx.logger });
  const sessions = createSessionBridge({ ctx, getConfig: configNow, dataDir, logger: ctx.logger });
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

  ctx.effect(() => ctx.tools.register(createSpeakTool({
    getConfig: configNow,
    bridge,
    sessions,
    autoSpeak,
    // A proactive line has no user watching the settings card, so the tool asks
    // the supervisor for a bridge instead of reporting a dead one (phase 4.1).
    ensureBridge: () => supervisor.ensureStarted(),
    logger: ctx.logger,
  })), 'dsh-xiaoai-bridge: xiaoai_speak tool');

  ctx.effect(() => {
    ctx.skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      source: 'runtime',
      content: SKILL_CONTENT,
      resourceBase: { kind: 'directory', path: SKILL_DIR },
    });
  }, 'dsh-xiaoai-bridge: xiaoai-speak skill');

  // The voice loop is driven by the bridge POSTing to /asr (see http.js), which
  // opens a turn on `autoSpeak`; this subscription is what closes it. An
  // utterance that came in through the speaker is answered through the speaker,
  // so the listener both logs the turn and feeds the automatic speaker:
  //
  //   assistant/message -> a draft (a turn can hold several, newest wins)
  //   tool/call         -> xiaoai_speak claimed the turn; the draft is dropped
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
      resolveToken,
      logger: ctx.logger,
      // Every recognized utterance opens a turn for the automatic speaker; the
      // session events that follow decide what gets said back (see above).
      onUtterance: (input) => autoSpeak.onUtterance(input),
      onConfigWritten: () => supervisor.renderConfig(),
    });
  });

  // Lifecycle: start the bridge when the plugin loads, tear the whole process
  // tree down when it unloads. Both sides run detached from `apply` because the
  // host does not wait for either, and a bridge that is slow to boot must not
  // hold up activation of the settings card.
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
        if (!result.ok) ctx.logger?.warn?.(`dsh-xiaoai-bridge: bridge did not start: ${messageOf(result.error)}`);
      } catch (err) {
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
        await supervisor.stop();
      })();
    };
  }, 'dsh-xiaoai-bridge: bridge lifecycle');

  const loadedPaths = state.paths();
  ctx.logger?.info?.(
    `dsh-xiaoai-bridge ${PLUGIN_VERSION} loaded (namespace=${settingsNs}, bridgeDir=${loadedPaths.bridgeDir}, `
    + `dataDir=${dataDir}, enabled=${loadCfg.enabled}, autoStart=${loadCfg.autoStart})`,
  );
}
