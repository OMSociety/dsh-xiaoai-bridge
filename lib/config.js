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

/**
 * Default limits handed to the reply generator. This is a prompt, not a
 * cleaner: the wording the model produces is what gets spoken, so the
 * constraints have to travel with the request.
 */
export const DEFAULT_OUTPUT_LIMITS =
  '只输出要念出来的话：不要 emoji、颜文字、markdown 标记、括号里的动作或心理描写、URL、@ 提及；不要换行；不超过 300 字。';

/**
 * Default instruction the bridge appends to every voice utterance. It tells the
 * agent that its own reply will be read out loud, so the agent writes what it
 * wants to say instead of calling a tool, and keeps screen-only content out of
 * the reply body.
 */
export const DEFAULT_VOICE_RULE_TEXT =
  '注意：这条消息是主人通过小爱音箱发来的语音。你的回复正文会被自动念出来（念之前会先做一次口语化润色），'
  + '所以直接把要说的话写成回复正文就好：不要包含 markdown、代码、emoji、颜文字、括号里的动作或心理描写、URL，尽量 300 字以内。'
  + '只有当你要逐字念出、不要润色的内容时，才调用 xiaoai_speak 工具。';

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
  /** Words that end a continuous conversation, one per line. */
  exitKeywords: '退出\n停止\n再见',
  /** Spoken by the speaker the moment a wake word matched. */
  wakeupReplyText: '小爱来了',
  /** Spoken by the speaker when a continuous conversation ends. */
  exitReplyText: '小爱，再见',
  /** Seconds of silence before a continuous conversation times out. */
  wakeupTimeout: 20,
  /** TTS voice for spoken replies: `xiaoai` or a Doubao voice id. */
  ttsSpeaker: 'xiaoai',
  /** Spoken when the bridge is up but this plugin cannot be reached. */
  fallbackText: '连不上电脑，请稍后再试',
  /** Bridge session key, in `agent:<agentId>:<rest>` form. */
  sessionKey: 'agent:main:open-xiaoai-bridge',
  /** Speech-recognition backend. */
  asrBackend: 'sense_voice',
  /** Workspace directory conversations started by the speaker land in; empty means the DSH default. */
  sessionCwd: '',
  /** Bridge log level. */
  logLevel: 'INFO',
  /** Speak the assistant's reply without being asked, when the model did not call the speak tool. */
  autoSpeak: true,
  /** Persona handed to the reply generator that turns an intent into spoken words. */
  personality: '',
  /** Speaking style handed to the reply generator. */
  replyStyle: '',
  /** Action guidelines injected into the system prompt of speaker-started sessions only. */
  behaviorStyle: '',
  /** What the reply generator must obey, e.g. no emoji, no markdown, no bracketed stage directions. */
  outputLimits: DEFAULT_OUTPUT_LIMITS,
  /** Instruction the bridge appends to every voice utterance; empty keeps the bridge default. */
  voiceRuleText: DEFAULT_VOICE_RULE_TEXT,
  /** Reply generator provider; empty follows the session's default model route. */
  replyerProvider: '',
  /** Reply generator model; empty follows the session's default model route. */
  replyerModel: '',
  /** How many recent exchanges the reply generator sees as context. */
  replyerHistoryTurns: 6,
  /** Spoken when the reply generator fails even after one retry. */
  replyerFailureText: '回复器调用失败',
  /** Characters allowed in one spoken reply; longer text is condensed once, then truncated. */
  spokenMaxChars: 300,
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
  exitKeywords: live(z.string().role('text')
    .default(DEFAULTS.exitKeywords)
    .description('Words that end a continuous conversation, one per line.')),
  wakeupReplyText: live(z.string().role('text')
    .default(DEFAULTS.wakeupReplyText)
    .description('Spoken by the speaker the moment a wake word matched.')),
  exitReplyText: live(z.string().role('text')
    .default(DEFAULTS.exitReplyText)
    .description('Spoken by the speaker when a continuous conversation ends.')),
  wakeupTimeout: live(z.number()
    .default(DEFAULTS.wakeupTimeout)
    .description('Seconds of silence before a continuous conversation times out.')),
  ttsSpeaker: live(z.string().role('text')
    .default(DEFAULTS.ttsSpeaker)
    .description('TTS voice for spoken replies: xiaoai, or a Doubao voice id.')),
  fallbackText: live(z.string().role('text')
    .default(DEFAULTS.fallbackText)
    .description('Spoken when the bridge is up but this plugin cannot be reached.')),
  sessionKey: live(z.string().role('text')
    .default(DEFAULTS.sessionKey)
    .description('Bridge session key, in agent:<agentId>:<rest> form.')),
  asrBackend: live(z.union([z.const('sense_voice'), z.const('paraformer'), z.const('fire_red_asr')])
    .default(DEFAULTS.asrBackend)
    .description('Speech-recognition backend: sense_voice, paraformer or fire_red_asr.')),
  sessionCwd: live(z.string().role('text')
    .default(DEFAULTS.sessionCwd)
    .description('Absolute working directory for speaker-started conversations; empty uses the first DSH workspace, then the host process directory. The host refuses to serve a session whose header has no absolute cwd, so this is never left empty.')),
  logLevel: live(z.union([z.const('DEBUG'), z.const('INFO'), z.const('WARNING'), z.const('ERROR')])
    .default(DEFAULTS.logLevel)
    .description('Bridge log level.')),
  autoSpeak: live(z.boolean()
    .default(DEFAULTS.autoSpeak)
    .description('Speak the assistant reply automatically when the model did not call the speak tool.')),
  personality: live(z.string().role('text')
    .default(DEFAULTS.personality)
    .description('Persona handed to the reply generator (voice channel only).')),
  replyStyle: live(z.string().role('text')
    .default(DEFAULTS.replyStyle)
    .description('Speaking style handed to the reply generator (voice channel only).')),
  behaviorStyle: live(z.string().role('text')
    .default(DEFAULTS.behaviorStyle)
    .description('Action guidelines injected into the system prompt of speaker-started sessions.')),
  outputLimits: live(z.string().role('text')
    .default(DEFAULTS.outputLimits)
    .description('Constraints the reply generator must obey, e.g. no emoji, kaomoji, markdown or stage directions.')),
  voiceRuleText: live(z.string().role('text')
    .default(DEFAULTS.voiceRuleText)
    .description('Instruction the bridge appends to every voice utterance; empty keeps the bridge default.')),
  replyerProvider: live(z.string().role('text')
    .default(DEFAULTS.replyerProvider)
    .description('Reply generator provider; empty follows the session default model.')),
  replyerModel: live(z.string().role('text')
    .default(DEFAULTS.replyerModel)
    .description('Reply generator model; empty follows the session default model.')),
  replyerHistoryTurns: live(z.number()
    .default(DEFAULTS.replyerHistoryTurns)
    .description('Recent exchanges handed to the reply generator as context.')),
  replyerFailureText: live(z.string().role('text')
    .default(DEFAULTS.replyerFailureText)
    .description('Spoken when the reply generator fails even after one retry.')),
  spokenMaxChars: live(z.number()
    .default(DEFAULTS.spokenMaxChars)
    .description('Characters allowed in one spoken reply; longer text is condensed once, then truncated.')),
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
  if (!Number.isFinite(value.wakeupTimeout) || value.wakeupTimeout < 1 || value.wakeupTimeout > 600) {
    err('wakeupTimeout must be a number of seconds in [1, 600]');
  }
  if (!Number.isInteger(value.replyerHistoryTurns) || value.replyerHistoryTurns < 0 || value.replyerHistoryTurns > 50) {
    err('replyerHistoryTurns must be an integer in [0, 50]');
  }
  if (!Number.isInteger(value.spokenMaxChars) || value.spokenMaxChars < 40 || value.spokenMaxChars > 2000) {
    err('spokenMaxChars must be an integer in [40, 2000]');
  }
  return value;
}

/** Merged defaults + overrides, validated. Throws on an unusable section. */
export function resolveLoadConfig(config) {
  const value = { ...DEFAULTS, ...(config ?? {}) };
  validateConfig(value);
  return value;
}
