/**
 * dsh-xiaoai-bridge host plugin.
 *
 * Phase 1 scope: the plugin loads, contributes the "小爱音箱" settings tab, the
 * `xiaoai-speak` runtime skill, and the `/plugin/xiaoai` HTTP surface. The
 * bridge process supervisor, the `xiaoai_speak` tool and the conversation
 * connector land in later phases.
 * @module dsh-xiaoai-bridge
 */
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DEFAULTS, CONFIG_SCHEMA, plainConfig, resolveLoadConfig } from './config.js';
import { mountHttp } from './http.js';
import { PACKAGE_ROOT, SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_DIR, SKILL_NAME } from './skill.js';

const require = createRequire(import.meta.url);
/** Plugin version read from the package manifest (single source of truth). */
export const PLUGIN_VERSION = require('../package.json').version ?? '0.0.0';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'xiaoai';
/** Required host-plane services. */
export const inject = ['tools', 'skills', 'settings', 'credentials', 'agents'];
/** Entry config schema (validated by the Loader). */
export const Config = CONFIG_SCHEMA;

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
    ctx.logger?.warn?.(`dsh-xiaoai-bridge: invalid config, falling back to defaults: ${String(err?.message ?? err)}`);
    loadCfg = { ...DEFAULTS };
  }

  // Every read re-projects the entry config, so a settings write reaches the
  // next call without a restart (DSH 2.x seam; there is no `settings.register`).
  const configNow = () => ({ ...DEFAULTS, ...plainConfig(config) });
  const settingsNs = settingsNamespace(ctx);

  const state = {
    getConfig: configNow,
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
      return {
        phase: 1,
        enabled: cfg.enabled,
        pluginVersion: PLUGIN_VERSION,
        namespace: settingsNs,
        deviceName: cfg.deviceName,
        deviceHost: cfg.deviceHost,
        autoStart: cfg.autoStart,
        apiServerEnabled: cfg.apiServerEnabled,
        apiServerUrl: 'http://' + cfg.apiServerHost + ':' + cfg.apiServerPort,
        apiServerTokenCredential: cfg.apiServerTokenCredential,
        wakeKeywords: parseWakeKeywords(cfg.wakeKeywords),
        asrBackend: cfg.asrBackend,
        sessionCwd: cfg.sessionCwd,
        logLevel: cfg.logLevel,
        paths,
        checks: {
          bridgeDirIsDirectory,
          pythonExists: existsSync(paths.pythonPath),
          modelsDirExists: existsSync(paths.modelsDir),
          skillFileExists: existsSync(join(SKILL_DIR, 'SKILL.md')),
        },
        // Bridge process supervision arrives with phase 2.
        bridge: { managed: false, running: false, pid: null },
      };
    },
  };

  ctx.effect(() => {
    ctx.skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      source: 'runtime',
      content: SKILL_CONTENT,
      resourceBase: { kind: 'directory', path: SKILL_DIR },
    });
  }, 'dsh-xiaoai-bridge: xiaoai-speak skill');

  // Web profile only: the settings tab talks to /plugin/xiaoai.
  ctx.inject(['webServer'], (webCtx) => {
    mountHttp(webCtx, {
      settings: ctx.settings,
      config: configNow,
      settingsNs,
      pluginVersion: PLUGIN_VERSION,
      state,
    });
  });

  const loadedPaths = state.paths();
  ctx.logger?.info?.(
    `dsh-xiaoai-bridge ${PLUGIN_VERSION} loaded (namespace=${settingsNs}, bridgeDir=${loadedPaths.bridgeDir}, `
    + `enabled=${loadCfg.enabled}, autoStart=${loadCfg.autoStart})`,
  );
}
