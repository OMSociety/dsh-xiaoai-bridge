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

import { DEFAULT_REPLY_STYLE, REPLYER_IDENTITY } from './replyer.js';

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
 * `xiaoai` speaks through the speaker's own TTS; `doubao` sends the text to the
 * Doubao client, which reads it with the voice `doubaoSpeaker` names — or the
 * bridge's `tts.doubao.default_speaker` while that is empty. There is no
 * "follow the voice" value: the voice id only matters on the Doubao path, and
 * the page owns that voice.
 */
export const TTS_PROVIDER_VALUES = Object.freeze(['xiaoai', 'doubao']);

/**
 * Audio formats the Doubao speech API can return, as the settings page offers
 * them. `auto` is the bridge's own strategy (pcm for a short line, mp3 for a
 * long one); an empty value keeps the bridge template's format.
 */
export const DOUBAO_AUDIO_FORMAT_VALUES = Object.freeze(['', 'auto', 'pcm', 'mp3', 'ogg_opus']);

/**
 * Default limits handed to the reply generator. This is a prompt, not a
 * cleaner: the wording the model produces is what gets spoken, so the
 * constraints have to travel with the request. The length ask is two-tier on
 * purpose: aim at a sentence or two (about 50 characters) and treat the
 * 300-character budget as the ceiling for replies that genuinely need it.
 */
export const DEFAULT_OUTPUT_LIMITS =
  '只输出要念出来的话：不要 emoji、颜文字、markdown 标记、括号里的动作或心理描写、URL、@ 提及；不要换行；'
  + '一般 50 字以内，一两句话讲完，只有确实需要长回复时才展开，最多不超过 300 字。';

/**
 * Default action rules handed to the bridge. They used to be the tail of
 * DEFAULT_VOICE_RULE_TEXT below; they are a setting of their own
 * (`behaviorStyle`), so `composeVoiceRule()` appends them as an explicit
 * 「行动准则：」 line.
 */
export const DEFAULT_BEHAVIOR_STYLE =
  '不要包含 markdown、代码、emoji、颜文字、括号里的动作或心理描写、URL；'
  + '一般 50 字以内，一两句话讲完，只有确实需要长回复时才展开，最多不超过 300 字。'
  + '只有当你要逐字念出、不要润色的内容时，才调用 xiaoai_speak 工具。';

/**
 * Default instruction the bridge appends to every voice utterance. It tells the
 * agent that its own reply will be read out loud, so the agent writes what it
 * wants to say instead of calling a tool. The rules that keep screen-only
 * content out of the reply body live in DEFAULT_BEHAVIOR_STYLE, next to it.
 */
export const DEFAULT_VOICE_RULE_TEXT =
  '注意：这条消息是用户通过小爱音箱发来的语音。你的回复正文会被自动念出来（念之前会先做一次口语化润色），'
  + '所以直接把要说的话写成回复正文就好。';

export const DEFAULTS = Object.freeze({
  /** Master switch: when false the plugin registers nothing but its settings card. */
  enabled: true,
  /** Display name of the single configured speaker (multi-device lands in phase 3). */
  deviceName: '小爱音箱',
  /** LAN address of the speaker running the open-xiaoai client. */
  deviceHost: '192.168.1.191',
  /**
   * Make the speaker prove it holds the API token before the bridge serves it.
   * The bridge's WebSocket server listens on 0.0.0.0:4399 and every connection
   * can inject microphone audio, so an unauthenticated port lets any host on the
   * LAN talk to the assistant. On (default) passes the same token the API Server
   * uses down as `DSH_XIAOAI_TOKEN`, and the server then accepts either an
   * `Authorization: Bearer` header or `?token=` in the dial URL — the second form
   * exists so a speaker on a stock client can opt in by editing `server.txt`
   * alone. Only `false` turns the check off; any other value keeps it on.
   */
  speakerAuth: true,
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
  wakeKeywords: '你好肥鱼',
  /** Words that end a continuous conversation, one per line. */
  exitKeywords: '退出\n停止\n再见',
  /** Spoken by the speaker the moment a wake word matched. */
  wakeupReplyText: '肥鱼来了',
  /** Spoken by the speaker when a continuous conversation ends. */
  exitReplyText: '肥鱼走了',
  /** Seconds of silence before a continuous conversation times out. */
  wakeupTimeout: 20,
  /** One wake word per sentence (false, default) or keep listening for follow-ups (true). */
  continuousConversation: false,
  /** TTS provider: `xiaoai` speaks with the speaker's own TTS, `doubao` uses Doubao. */
  ttsProvider: 'xiaoai',
  /** Volcengine App ID of the Doubao speech service; empty keeps the bridge template value. */
  doubaoAppId: '',
  /** DSH Credential reference holding the Doubao Access Token. Never the token itself. */
  doubaoAccessKeyCredential: 'DOUBAO_ACCESS_KEY',
  /** Doubao voice used when the provider is `doubao`; empty keeps the bridge template value. */
  doubaoSpeaker: '',
  /** Doubao audio format; empty keeps the bridge template value (pcm). */
  doubaoAudioFormat: '',
  /** Stream Doubao audio while it is still being synthesised, so playback starts earlier. */
  doubaoStream: true,
  /** Doubao speaking speed, 0.5–2.0. */
  ttsSpeed: 1.0,
  /** Spoken when the bridge is up but this plugin cannot be reached. */
  fallbackText: '连不上电脑，请稍后再试',
  /** Bridge session key, in `agent:<agentId>:<rest>` form. */
  sessionKey: 'agent:main:dsh-xiaoai-bridge',
  /**
   * Agent preset the speaker's conversation is created in — a name from the
   * host's preset registry (`standard`, `ptc`, `minimal`, `cordis`, or the
   * `xiaoai` preset this package's own bundle declares). Empty uses the host
   * default. A preset that is not installed is not an error: the session falls
   * back to the host default and one diagnostic says so.
   */
  agentPreset: 'xiaoai',
  /** Speech-recognition backend. */
  asrBackend: 'sense_voice',
  /** Workspace directory conversations started by the speaker land in; empty means the DSH default. */
  sessionCwd: '',
  /** Bridge log level. */
  logLevel: 'INFO',
  /** Speak the assistant's reply without being asked, when the model did not call the speak tool. */
  autoSpeak: true,
  /**
   * Let `xiaoai_speak` run from sessions the speaker did not start, e.g. a chat
   * in the DSH window. Off (default) keeps the tool inside speaker-started
   * conversations, so a desktop chat cannot make the speaker talk out of turn.
   * Only `true` opens it; any other value stays closed.
   */
  speakFromAnySession: false,
  /**
   * Persona handed to the reply generator that turns an intent into spoken
   * words. The default is the replyer's identity line, so `buildReplyerPrompts`
   * only adds a 「关于你自己：」 line for a persona the user wrote.
   */
  personality: REPLYER_IDENTITY,
  /** Speaking style handed to the reply generator. */
  replyStyle: DEFAULT_REPLY_STYLE,
  /**
   * Action rules the bridge appends to every voice utterance. They are the
   * 「行动准则：」 line of the rendered rule prompt, not a system-prompt section.
   */
  behaviorStyle: DEFAULT_BEHAVIOR_STYLE,
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
  speakerAuth: live(z.boolean()
    .default(DEFAULTS.speakerAuth)
    .description('Require the API token on the bridge WebSocket (port 4399) the speaker connects to. On by default so a LAN host cannot inject audio; only false disables it.')),
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
  ttsProvider: live(z.union(TTS_PROVIDER_VALUES.map((value) => z.const(value)))
    .default(DEFAULTS.ttsProvider)
    .description('TTS provider: xiaoai uses the speaker\'s own TTS, doubao uses the Doubao client.')),
  doubaoAppId: live(z.string().role('text')
    .default(DEFAULTS.doubaoAppId)
    .description('Volcengine App ID of the Doubao speech service; empty keeps the bridge template value.')),
  doubaoAccessKeyCredential: live(z.string().role('text')
    .default(DEFAULTS.doubaoAccessKeyCredential)
    .description('DSH Credential reference name holding the Doubao Access Token; the token itself is never stored in the plugin config.')),
  doubaoSpeaker: live(z.string().role('text')
    .default(DEFAULTS.doubaoSpeaker)
    .description('Doubao voice used when the provider is doubao; empty keeps the bridge template value.')),
  doubaoAudioFormat: live(z.union(DOUBAO_AUDIO_FORMAT_VALUES.map((value) => z.const(value)))
    .default(DEFAULTS.doubaoAudioFormat)
    .description('Doubao audio format: empty keeps the bridge template value, auto picks pcm for short lines and mp3 for long ones.')),
  doubaoStream: live(z.boolean()
    .default(DEFAULTS.doubaoStream)
    .description('Stream Doubao audio while it is still being synthesised.')),
  ttsSpeed: live(z.number()
    .default(DEFAULTS.ttsSpeed)
    .description('Doubao speaking speed, 0.5 to 2.0.')),
  fallbackText: live(z.string().role('text')
    .default(DEFAULTS.fallbackText)
    .description('Spoken when the bridge is up but this plugin cannot be reached.')),
  sessionKey: live(z.string().role('text')
    .default(DEFAULTS.sessionKey)
    .description('Bridge session key, in agent:<agentId>:<rest> form.')),
  agentPreset: live(z.string().role('text')
    .default(DEFAULTS.agentPreset)
    .description('Agent preset the speaker conversation is created in (e.g. xiaoai, standard, minimal). Empty uses the host default. A preset that is not installed falls back to the host default with one diagnostic.')),
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
  speakFromAnySession: live(z.boolean()
    .default(DEFAULTS.speakFromAnySession)
    .description('Allow xiaoai_speak from sessions the speaker did not start (desktop or web chats). Off keeps the tool on speaker-started conversations only.')),
  personality: live(z.string().role('text')
    .default(DEFAULTS.personality)
    .description('Persona handed to the reply generator (voice channel only).')),
  replyStyle: live(z.string().role('text')
    .default(DEFAULTS.replyStyle)
    .description('Speaking style handed to the reply generator (voice channel only).')),
  behaviorStyle: live(z.string().role('text')
    .default(DEFAULTS.behaviorStyle)
    .description('Action rules the bridge appends to every voice utterance, as the 「行动准则：」 line of the rendered rule prompt.')),
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

/**
 * The field rules shared by {@link validateConfig} and {@link sanitizeConfig}.
 *
 * These are the keys whose usable values are narrower than their type or whose
 * value crosses a field boundary. A key absent from this list is not unchecked:
 * {@link allRules} adds a plain type rule derived from `DEFAULTS` for each one.
 */
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
    message: 'ttsProvider must be one of ' + TTS_PROVIDER_VALUES.join('|'),
    ok: (value) => TTS_PROVIDER_VALUES.includes(value),
  },
  {
    key: 'doubaoAccessKeyCredential',
    fallback: DEFAULTS.doubaoAccessKeyCredential,
    message: 'doubaoAccessKeyCredential must be a POSIX-shell-shaped reference name',
    ok: (value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value ?? ''),
  },
  {
    key: 'doubaoAudioFormat',
    fallback: DEFAULTS.doubaoAudioFormat,
    message: 'doubaoAudioFormat must be one of ' + DOUBAO_AUDIO_FORMAT_VALUES.map((one) => one || '<empty>').join('|'),
    ok: (value) => DOUBAO_AUDIO_FORMAT_VALUES.includes(value ?? ''),
  },
  {
    key: 'ttsSpeed',
    fallback: DEFAULTS.ttsSpeed,
    // The bridge's Doubao payload takes a float (0.5–2.0); a string or an
    // out-of-range number would be sent as-is and refused by the API.
    message: 'ttsSpeed must be a number in [0.5, 2]',
    ok: (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 2,
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
 * The type rule for one `DEFAULTS` key that has no rule of its own.
 *
 * These keys used to travel unvalidated, and a wrong shape is not something the
 * rest of the plugin absorbs: `String()` renders an object as
 * `[object Object]` (straight into `XIAOAI_DEVICE_HOST`), a string in a boolean
 * position still reads as on (`enabled: 'no'`), and a number where text is
 * expected reaches the bridge. Nothing downstream re-checks them, so the shape
 * the default has is the shape the field has to keep.
 *
 * An empty string stays usable: it is what several fields mean by "keep the
 * built-in default" (`bridgeDir`, `pythonPath`, `agentPreset`, the Doubao
 * overrides, the replyer route).
 * @param {string} key a `DEFAULTS` key without an explicit rule
 * @returns {{key: string, fallback: *, message: string, ok: (value: *) => boolean}} the rule
 */
function typeRule(key) {
  const fallback = DEFAULTS[key];
  if (typeof fallback === 'boolean') {
    return { key, fallback, message: `${key} must be a boolean`, ok: (value) => typeof value === 'boolean' };
  }
  if (typeof fallback === 'number') {
    return {
      key,
      fallback,
      message: `${key} must be a finite number`,
      ok: (value) => typeof value === 'number' && Number.isFinite(value),
    };
  }
  return { key, fallback, message: `${key} must be a string`, ok: (value) => typeof value === 'string' };
}

/**
 * Every key of `DEFAULTS`, in its own order — an explicit rule where one
 * exists, a type rule otherwise.
 *
 * Built once: both halves are frozen and the rules close over immutable
 * defaults, so the list cannot drift from the schema. It is exactly as long as
 * `DEFAULTS` is wide — one rule per key, an explicit one for the twelve keys
 * whose usable values are narrower than their type and a derived type rule for
 * the rest — and every read evaluates all of them, so the per-read cost is
 * bounded by the number of `DEFAULTS` keys.
 * @returns {Array<{key: string, fallback: *, message: string, ok: (value: *) => boolean}>} the rules
 */
let allRulesCache = null;
function allRules() {
  if (allRulesCache === null) {
    const explicit = new Map(CONFIG_RULES.map((rule) => [rule.key, rule]));
    allRulesCache = Object.keys(DEFAULTS).map((key) => explicit.get(key) ?? typeRule(key));
  }
  return allRulesCache;
}

/**
 * Every field of a resolved section the bridge cannot use, in schema order.
 *
 * @param {object} value resolved section (defaults already merged)
 * @returns {ConfigProblem[]} the offending fields, empty when the section is usable
 */
export function configProblems(value) {
  const out = [];
  for (const rule of allRules()) {
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
 *
 * The check covers every `DEFAULTS` key, so `value` has to be a *complete*
 * section — a partial patch fails with a "must be …" problem for each key it
 * omits. That is the production shape (`{ ...DEFAULTS, ...patch }`); a caller
 * holding a bare patch has to merge the defaults first.
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
