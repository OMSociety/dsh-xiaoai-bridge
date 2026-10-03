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
 * Text-to-speech providers the settings page can name.
 *
 * `''` leaves the choice to the bridge, which picks by voice id (the speaker's
 * own TTS for `xiaoai`, Doubao for a Doubao voice id). `xiaoai` forces the
 * speaker's own TTS. `mimo` is reserved: the page stores it so the choice
 * survives until MiMo support lands, but it is never rendered, because the
 * bridge's TTS router rejects a provider it cannot load.
 */
export const TTS_PROVIDER_VALUES = Object.freeze(['', 'xiaoai', 'mimo']);

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
  /** Stay quiet on start: skip the bridge's "已连接" prompt when it connects to the speaker. */
  silentStart: false,
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
  /** One wake word per sentence (false, default) or keep listening for follow-ups (true). */
  continuousConversation: false,
  /** TTS voice for spoken replies: `xiaoai` or a Doubao voice id. */
  ttsSpeaker: 'xiaoai',
  /** TTS provider: '' lets the bridge pick from the voice id, `xiaoai` forces the speaker's own TTS, `mimo` is reserved and not wired yet. */
  ttsProvider: '',
  /** Reserved MiMo TTS endpoint, in `https://host/v1/audio/speech` form; nothing calls it yet. */
  mimoBaseUrl: '',
  /** Reserved MiMo credential name in the DSH credential store; nothing reads it yet. */
  mimoApiKeyCredential: '',
  /** Reserved MiMo model id; nothing sends it yet. */
  mimoModel: '',
  /** Reserved MiMo voice id; nothing sends it yet. */
  mimoVoice: '',
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
  /** Spoken when a tool call is waiting for the user's approval on screen. */
  approvalText: '需要你到电脑上确认一下',
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
  silentStart: live(z.boolean()
    .default(DEFAULTS.silentStart)
    .description('Skip the bridge connect prompt so the speaker stays quiet while it starts.')),
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
  continuousConversation: live(z.boolean()
    .default(DEFAULTS.continuousConversation)
    .description('Keep listening for follow-up sentences after the first one; off means one wake word per sentence.')),
  ttsSpeaker: live(z.string().role('text')
    .default(DEFAULTS.ttsSpeaker)
    .description('TTS voice for spoken replies: xiaoai, or a Doubao voice id.')),
  ttsProvider: live(z.union(TTS_PROVIDER_VALUES.map((value) => z.const(value)))
    .default(DEFAULTS.ttsProvider)
    .description('TTS provider: empty follows the voice id, xiaoai forces the speaker\'s own TTS, mimo is reserved and does not play yet.')),
  mimoBaseUrl: live(z.string().role('text')
    .default(DEFAULTS.mimoBaseUrl)
    .description('Reserved MiMo TTS endpoint; stored for the day the provider is wired, sent to no one today.')),
  mimoApiKeyCredential: live(z.string().role('text')
    .default(DEFAULTS.mimoApiKeyCredential)
    .description('Reserved MiMo credential name in the DSH credential store; the secret itself is never stored in the plugin config.')),
  mimoModel: live(z.string().role('text')
    .default(DEFAULTS.mimoModel)
    .description('Reserved MiMo model id.')),
  mimoVoice: live(z.string().role('text')
    .default(DEFAULTS.mimoVoice)
    .description('Reserved MiMo voice id.')),
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
    .description('Working directory for speaker-started conversations, normally one of the project groups the settings page lists. Empty uses the first DSH workspace, then the host process directory. The host refuses to serve a session whose header has no absolute cwd, so this is never left empty; it also refuses to group a session whose cwd is not exactly a workspace path, which is why the page offers the registry\'s own entries instead of a text field.')),
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
  approvalText: live(z.string().role('text')
    .default(DEFAULTS.approvalText)
    .description('Spoken when a tool call is blocked waiting for approval on screen; the approval payload itself is never read aloud.')),
  spokenMaxChars: live(z.number()
    .default(DEFAULTS.spokenMaxChars)
    .description('Characters allowed in one spoken reply; longer text is condensed once, then truncated.')),
});

/**
 * One out-of-range field, as both the strict and the repairing path see it.
 *
 * The schema is the settings page's contract, not a guarantee about what
 * arrives at `apply()`: the composition layer, a `POST /config` from any local
 * process and an older stored patch can all hand over a value the schema would
 * have rejected. Every consumer therefore goes through the rules below.
 *
 * @typedef {object} ConfigProblem
 * @property {string} key field name
 * @property {*} fallback value to use instead (the `DEFAULTS` entry)
 * @property {string} message human-readable reason
 */

/** The field rules shared by {@link validateConfig} and {@link sanitizeConfig}. */
const CONFIG_RULES = Object.freeze([
  {
    key: 'asrBackend',
    fallback: DEFAULTS.asrBackend,
    message: 'asrBackend must be one of ' + ASR_BACKEND_VALUES.join('|'),
    ok: (value) => ASR_BACKEND_VALUES.includes(value),
  },
  {
    key: 'logLevel',
    fallback: DEFAULTS.logLevel,
    message: 'logLevel must be one of ' + LOG_LEVEL_VALUES.join('|'),
    ok: (value) => LOG_LEVEL_VALUES.includes(value),
  },
  {
    key: 'ttsProvider',
    fallback: DEFAULTS.ttsProvider,
    message: 'ttsProvider must be one of ' + TTS_PROVIDER_VALUES.map((one) => one || '<empty>').join('|'),
    ok: (value) => TTS_PROVIDER_VALUES.includes(value ?? ''),
  },
  {
    key: 'apiServerPort',
    fallback: DEFAULTS.apiServerPort,
    message: 'apiServerPort must be an integer in [1, 65535]',
    ok: (value) => Number.isInteger(value) && value >= 1 && value <= 65535,
  },
  {
    key: 'apiServerTokenCredential',
    fallback: DEFAULTS.apiServerTokenCredential,
    message: 'apiServerTokenCredential must be a POSIX-shell-shaped reference name',
    ok: (value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value ?? ''),
  },
  {
    key: 'apiServerHost',
    fallback: DEFAULTS.apiServerHost,
    message: 'apiServerHost must be a non-empty host name or address',
    ok: (value) => typeof value === 'string' && value.trim().length > 0,
  },
  {
    key: 'wakeupTimeout',
    fallback: DEFAULTS.wakeupTimeout,
    message: 'wakeupTimeout must be a whole number of seconds in [1, 600]',
    // A fractional timeout renders into config.py as-is, and the bridge's
    // timeout is a second count the settings page promises is whole.
    ok: (value) => Number.isInteger(value) && value >= 1 && value <= 600,
  },
  {
    key: 'replyerHistoryTurns',
    fallback: DEFAULTS.replyerHistoryTurns,
    message: 'replyerHistoryTurns must be an integer in [0, 50]',
    ok: (value) => Number.isInteger(value) && value >= 0 && value <= 50,
  },
  {
    key: 'spokenMaxChars',
    fallback: DEFAULTS.spokenMaxChars,
    message: 'spokenMaxChars must be an integer in [40, 2000]',
    ok: (value) => Number.isInteger(value) && value >= 40 && value <= 2000,
  },
]);

/**
 * Every field of a resolved section the bridge cannot use, in schema order.
 *
 * @param {object} value resolved section (defaults already merged)
 * @returns {ConfigProblem[]} the offending fields, empty when the section is usable
 */
export function configProblems(value) {
  const out = [];
  for (const rule of CONFIG_RULES) {
    if (!rule.ok(value?.[rule.key])) {
      out.push({ key: rule.key, fallback: rule.fallback, message: rule.message });
    }
  }
  return out;
}

/**
 * Validate one resolved config section (the schema has already run).
 *
 * Cross-field and range constraints the schema cannot express. Strict on
 * purpose: this is what a writer calls before storing a patch, so an unusable
 * value is refused at the door instead of being silently repaired.
 * @param {object} value resolved section
 * @throws {Error} when the section is unusable
 */
export function validateConfig(value) {
  const [first] = configProblems(value);
  if (first) throw new Error('dsh-xiaoai-bridge config: ' + first.message);
  return value;
}

/**
 * Repair one resolved config section into values the bridge can actually use.
 *
 * The runtime counterpart of {@link validateConfig}: instead of refusing to
 * load, every offending field falls back to its default and the caller is told
 * which ones did. That matters because the values reaching a live plugin are
 * not all filtered by the schema — a `POST /config` from elsewhere on the
 * machine, a composition base, or a patch written before a rule was tightened
 * all land here — and a bridge started with `apiServerPort=70000` fails quietly
 * rather than visibly.
 *
 * @param {object} [config] merged-or-not section; defaults fill the gaps
 * @returns {{value: object, repairs: Array<{key: string, bad: *, message: string}>}}
 *   the usable section plus one entry per repaired field
 */
export function sanitizeConfig(config) {
  const value = { ...DEFAULTS, ...(config ?? {}) };
  const repairs = [];
  for (const problem of configProblems(value)) {
    repairs.push({ key: problem.key, bad: value[problem.key], message: problem.message });
    value[problem.key] = problem.fallback;
  }
  return { value, repairs };
}

/**
 * Merged defaults + overrides, repaired. Never throws.
 *
 * @param {object} [config] partial section
 * @returns {object} the usable section (see {@link sanitizeConfig} for the repairs)
 */
export function resolveLoadConfig(config) {
  return sanitizeConfig(config).value;
}
