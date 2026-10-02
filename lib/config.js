/**
 * dsh-xiaoai-bridge configuration schema and defaults.
 *
 * Resolution layers: schema defaults < composition base (the bundle row's
 * `config`) < the profile entry patch written by the settings card.
 *
 * DSH 2.x derives a plugin's settings card from its exported `Config`, and only
 * offers fields carrying `meta.volatile`; a schema without them has no card at
 * all. Every field here is therefore marked live (see {@link live}) and arrives
 * in `apply(ctx, config)` as a volatile reference rather than a plain value —
 * read it through {@link plainConfig}.
 *
 * Secret VALUES never live here: `apiServerTokenCredential` is only the name of
 * a DSH Credential reference; the token itself is stored through the
 * credentials seam.
 * @module dsh-xiaoai-bridge/config
 */
import z from '@deepseek-ai/schemastery';

/**
 * Mark one field live-editable.
 *
 * `.volatile()` exists in schemastery >= 3.18.4 only, and a profile can hoist an
 * older copy (3.18.2 still satisfies `^3.18.0`) above the installation's one, so
 * an unguarded call fails activation with `TypeError: ...volatile is not a
 * function`. `.extra('volatile', true)` writes the same flag on every version, so
 * the card appears either way; only hot-edit needs the newer copy.
 * @template T
 * @param {T} field one schemastery field
 * @returns {T} the field, flagged volatile when the copy supports it
 */
export function live(field) {
  if (typeof field?.volatile === 'function') return field.volatile();
  if (typeof field?.extra === 'function') return field.extra('volatile', true);
  return field;
}

/**
 * Unwrap one live configuration reference.
 *
 * A `meta.volatile` field resolves to a cosmokit volatile reference; reading it
 * through `get()` is what makes a settings write visible to the next call. Plain
 * values pass through unchanged.
 * @param {unknown} value a reference or a plain value
 * @returns {unknown} the current value
 */
export function unwrapField(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

/**
 * Project the entry config into plain values.
 * @param {object} [config] entry config handed to `apply` (volatile fields are references)
 * @returns {object} a plain, detached configuration object
 */
export function plainConfig(config) {
  const out = {};
  for (const [key, value] of Object.entries(config ?? {})) out[key] = unwrapField(value);
  return out;
}

/** Speech-recognition backends the bridge can load. */
export const ASR_BACKEND_VALUES = Object.freeze(['sense_voice', 'paraformer', 'fire_red_asr']);

/** Bridge log levels accepted by the Python logging setup. */
export const LOG_LEVEL_VALUES = Object.freeze(['DEBUG', 'INFO', 'WARNING', 'ERROR']);

export const DEFAULTS = Object.freeze({
  /** Master switch: when false the plugin registers nothing but its settings card. */
  enabled: true,
  /** Display name of the single configured speaker (multi-device lands in phase 3). */
  deviceName: '小爱音箱',
  /** LAN address of the speaker running the open-xiaoai client. */
  deviceHost: '192.168.1.191',
  /** Bridge source directory; empty resolves to `<package root>/bridge`. */
  bridgeDir: '',
  /** Python interpreter running the bridge; empty resolves to `<bridgeDir>/.venv/Scripts/python.exe` on Windows. */
  pythonPath: '',
  /** Start the bridge process together with the plugin. */
  autoStart: true,
  /** Bridge API Server bind address (loopback only by default). */
  apiServerHost: '127.0.0.1',
  /** Bridge API Server port; 9092 is the upstream default. */
  apiServerPort: 9092,
  /** Enable the bridge API Server. It is bearer-authenticated by the plugin. */
  apiServerEnabled: true,
  /** DSH Credential reference holding the API Server bearer token. Never the token itself. */
  apiServerTokenCredential: 'XIAOAI_API_TOKEN',
  /** Wake word(s) rendered into the bridge keyword file, one per line. */
  wakeKeywords: '小爱小爱',
  /** Speech-recognition backend. */
  asrBackend: 'sense_voice',
  /** Workspace directory conversations started by the speaker land in; empty means the DSH default. */
  sessionCwd: '',
  /** Bridge log level. */
  logLevel: 'INFO',
});

export const CONFIG_SCHEMA = z.object({
  enabled: live(z.boolean()
    .default(DEFAULTS.enabled)
    .description('Enable the XiaoAI bridge plugin.')),
  deviceName: live(z.string().role('text')
    .default(DEFAULTS.deviceName)
    .description('Display name of the configured speaker.')),
  deviceHost: live(z.string().role('text')
    .default(DEFAULTS.deviceHost)
    .description('LAN address of the speaker running the open-xiaoai client.')),
  bridgeDir: live(z.string().role('text')
    .default(DEFAULTS.bridgeDir)
    .description('Bridge source directory; empty uses the bundled bridge/ directory.')),
  pythonPath: live(z.string().role('text')
    .default(DEFAULTS.pythonPath)
    .description('Python interpreter for the bridge; empty uses bridge/.venv.')),
  autoStart: live(z.boolean()
    .default(DEFAULTS.autoStart)
    .description('Start the bridge process together with the plugin.')),
  apiServerHost: live(z.string().role('text')
    .default(DEFAULTS.apiServerHost)
    .description('Bridge API Server bind address (loopback by default).')),
  apiServerPort: live(z.number()
    .default(DEFAULTS.apiServerPort)
    .description('Bridge API Server port (upstream default 9092).')),
  apiServerEnabled: live(z.boolean()
    .default(DEFAULTS.apiServerEnabled)
    .description('Enable the bridge API Server.')),
  apiServerTokenCredential: live(z.string().role('text')
    .default(DEFAULTS.apiServerTokenCredential)
    .description('DSH Credential reference name holding the API Server bearer token.')),
  wakeKeywords: live(z.string().role('text')
    .default(DEFAULTS.wakeKeywords)
    .description('Wake words, one per line, rendered into the bridge keyword file.')),
  asrBackend: live(z.union([z.const('sense_voice'), z.const('paraformer'), z.const('fire_red_asr')])
    .default(DEFAULTS.asrBackend)
    .description('Speech-recognition backend: sense_voice, paraformer or fire_red_asr.')),
  sessionCwd: live(z.string().role('text')
    .default(DEFAULTS.sessionCwd)
    .description('Workspace directory for speaker-started conversations; empty uses the DSH default.')),
  logLevel: live(z.union([z.const('DEBUG'), z.const('INFO'), z.const('WARNING'), z.const('ERROR')])
    .default(DEFAULTS.logLevel)
    .description('Bridge log level.')),
});

/**
 * Validate one resolved config section (the schema has already run).
 *
 * Cross-field and range constraints the schema cannot express.
 * @param {object} value resolved section
 * @throws {Error} when the section is unusable
 */
export function validateConfig(value) {
  const err = (msg) => { throw new Error('dsh-xiaoai-bridge config: ' + msg); };
  if (!ASR_BACKEND_VALUES.includes(value.asrBackend)) err('asrBackend must be one of ' + ASR_BACKEND_VALUES.join('|'));
  if (!LOG_LEVEL_VALUES.includes(value.logLevel)) err('logLevel must be one of ' + LOG_LEVEL_VALUES.join('|'));
  if (!Number.isInteger(value.apiServerPort) || value.apiServerPort < 1 || value.apiServerPort > 65535) {
    err('apiServerPort must be an integer in [1, 65535]');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiServerTokenCredential ?? '')) {
    err('apiServerTokenCredential must be a POSIX-shell-shaped reference name');
  }
  const host = value.apiServerHost ?? '';
  if (host.length === 0) err('apiServerHost must not be empty');
  return value;
}

/** Merged defaults + overrides, validated. Throws on an unusable section. */
export function resolveLoadConfig(config) {
  const value = { ...DEFAULTS, ...(config ?? {}) };
  validateConfig(value);
  return value;
}
