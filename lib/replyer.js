/**
 * The reply generator ("replyer").
 *
 * The agent's answer is written for a screen: it can be long, structured, and
 * full of markdown. A speaker cannot read any of that, so the plugin runs one
 * extra model call whose only job is to turn the agent's answer into a line
 * that sounds right when spoken. That is the whole design borrowed from
 * MaiBot's planner/replyer split: the agent decides *what* to say, the replyer
 * decides *how it sounds*, and the two are separate model calls with separate
 * prompts.
 *
 * Two deliberate choices:
 *
 * - **No mechanical cleanup.** Every constraint lives in the prompt (personality,
 *   speaking style, output limits), so the model rewrites the answer instead of
 *   the plugin stripping characters out of it afterwards.
 * - **No hand-built assistant history.** The host's `GenerateOptions.messages`
 *   accepts durable `Message` values plus request-only user inputs; a plugin
 *   cannot guarantee an id/source for a synthetic assistant turn, so the recent
 *   conversation is folded into the prompt as text and every request is a
 *   system + user pair.
 * @module dsh-xiaoai-bridge/replyer
 */

/** Opening line used when the user did not write a personality. */
export const REPLYER_IDENTITY = '你是一个通过小爱音箱和用户说话的语音助手，你的回答会被直接念出来。';

/**
 * Default speaking style handed to the reply generator. This is the style
 * clause that used to sit inside the task line below; it is a setting of its
 * own (`replyStyle`), so the wording lives here and the settings page shows it.
 */
export const DEFAULT_REPLY_STYLE = '用日常、口语化的说法讲出来，就像对着用户说话一样。';

/** Leading line of the "intent" section in the user prompt. */
const INTENT_HEADER = '【要表达的意图】';

/** Leading line of the transcript section in the user prompt. */
const HISTORY_HEADER = '【之前的对话】';

/** Label used for the user's own lines in the transcript. */
const USER_LABEL = '用户';

/** Label used for the speaker's lines in the transcript. */
const SELF_LABEL = '你';

/** Leading line of the draft section in the shortening prompt. */
const DRAFT_HEADER = '【草稿】';

/**
 * Every literal this module writes as prompt structure. Text from the model, the
 * user or the settings is untrusted: if it could reproduce one of these strings
 * verbatim it could open a forged section (its own `【要表达的意图】`, or a `用户：`
 * line inside the intent) and the reply generator would follow text the agent
 * never wrote. The invariant is that after interpolation no untrusted text
 * contains a marker character for character. Only exact marker occurrences
 * change, so an ordinary prompt reads exactly as it did before.
 */
const PROMPT_MARKERS = [INTENT_HEADER, HISTORY_HEADER, DRAFT_HEADER, `${USER_LABEL}：`, `${SELF_LABEL}：`];

/** @param {unknown} value @returns {string} trimmed string, '' when absent */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Neutralize the prompt markers inside untrusted text (`PROMPT_MARKERS`).
 *
 * @param {string} value text that came from the model, the user or the settings
 * @returns {string} the same text with each marker prefixed by a backslash
 */
function escapeMarkers(value) {
  let out = value;
  for (const marker of PROMPT_MARKERS) out = out.split(marker).join(`\\${marker}`);
  return out;
}

/**
 * Render the recent conversation as prompt text.
 *
 * @param {Array<{role: string, text: string}>} history oldest first
 * @returns {string} transcript, '' when there is nothing to show
 */
export function renderHistory(history) {
  const lines = [];
  for (const turn of Array.isArray(history) ? history : []) {
    const body = escapeMarkers(text(turn?.text).replace(/\s+/g, ' '));
    if (body.length === 0) continue;
    lines.push(`${turn?.role === 'assistant' ? SELF_LABEL : USER_LABEL}：${body}`);
  }
  return lines.join('\n');
}

/**
 * Build the two prompts: the persona/rules half and the request half.
 *
 * @param {object} options
 * @param {string} options.intent the agent's own answer, treated as the intent
 * @param {Array<{role: string, text: string}>} [options.history] recent turns
 * @param {object} options.cfg live settings projection
 * @returns {{system: string, user: string}} prompts
 */
export function buildReplyerPrompts({ intent, history, cfg }) {
  const system = [REPLYER_IDENTITY];
  // The settings interpolated below are text someone typed, and they land in the
  // same half as the structure markers, so they get the same treatment the
  // intent and the transcript get. For ordinary prose escaping changes nothing.
  const personality = escapeMarkers(text(cfg?.personality));
  // The setting's default IS this identity line, so restating it here would only
  // duplicate it; a persona the user actually wrote still gets its own line.
  if (personality.length > 0 && personality !== REPLYER_IDENTITY) system.push(`关于你自己：${personality}`);
  system.push('现在请你读一读之前的对话，把握当前的话题，然后把【要表达的意图】讲出来。');
  const replyStyle = escapeMarkers(text(cfg?.replyStyle));
  if (replyStyle.length > 0) system.push(`说话风格：${replyStyle}`);
  const limits = escapeMarkers(text(cfg?.outputLimits));
  if (limits.length > 0) system.push(limits);

  const transcript = renderHistory(history);
  const user = [];
  if (transcript.length > 0) user.push(HISTORY_HEADER, transcript, '');
  user.push(INTENT_HEADER, escapeMarkers(text(intent)));
  return { system: system.join('\n'), user: user.join('\n') };
}

/**
 * Build the request messages for one prompt pair.
 *
 * @param {{system: string, user: string}} prompts prompt pair
 * @param {'split'|'combined'} [mode] `split` sends system + user, `combined`
 *   sends one user message so a route that rejects a non-durable system
 *   message can still be used
 * @returns {Array<object>} messages for `ctx.llm.stream`
 */
export function replyerMessages(prompts, mode = 'split') {
  const part = (value) => [{ type: 'text', text: value }];
  if (mode === 'combined') return [{ role: 'user', content: part(`${prompts.system}\n\n${prompts.user}`) }];
  return [
    { role: 'system', content: part(prompts.system) },
    { role: 'user', content: part(prompts.user) },
  ];
}

/**
 * Build the prompts for the one shortening pass.
 *
 * @param {object} options
 * @param {string} options.draft the too-long first answer
 * @param {string} options.intent the original intent
 * @param {Array<{role: string, text: string}>} [options.history] recent turns
 * @param {object} options.cfg live settings projection
 * @param {number} options.maxChars hard limit to fit into
 * @returns {{system: string, user: string}} prompts
 */
export function buildCondensePrompts({ draft, intent, history, cfg, maxChars }) {
  const { system } = buildReplyerPrompts({ intent, history, cfg });
  const user = [
    '上面那版草稿太长了，念出来会拖很久。',
    `请把它压缩到 ${Math.max(1, Math.floor(maxChars))} 个字以内，只保留最要紧的意思，`,
    '仍然按照上面的人设和说话风格，只输出压缩后的那句话。',
    '',
    DRAFT_HEADER,
    escapeMarkers(text(draft)),
  ].join('\n');
  return { system, user };
}

/**
 * Cut a spoken line down to the limit without breaking a sentence in half.
 *
 * @param {string} value text to shorten
 * @param {number} maxChars limit in characters
 * @returns {string} shortened text
 */
export function truncateSpokenText(value, maxChars) {
  const body = text(value);
  const limit = Number.isFinite(maxChars) ? Math.floor(maxChars) : 0;
  if (limit <= 0 || body.length <= limit) return body;
  // A cut between the two halves of a surrogate pair leaves a lone high
  // surrogate in the spoken line, which is not text. When the character at
  // `limit - 1` is a high surrogate completed at `limit`, pull the boundary back
  // by one so the pair is kept whole or dropped whole.
  const head16 = body.charCodeAt(limit - 1);
  const next16 = body.charCodeAt(limit);
  const pair = head16 >= 0xd800 && head16 <= 0xdbff && next16 >= 0xdc00 && next16 <= 0xdfff;
  // The boundary never moves below one whole character: with `limit` 1 and a pair
  // in front, pulling back by one would leave nothing but the ellipsis, which
  // says less than the first character does.
  const boundary = pair ? Math.max(limit - 1, 2) : limit;
  const head = body.slice(0, boundary);
  let cut = -1;
  for (const mark of ['。', '！', '？', '!', '?', '…']) {
    cut = Math.max(cut, head.lastIndexOf(mark));
  }
  if (cut >= Math.floor(limit / 2)) return head.slice(0, cut + 1);
  return `${head}…`;
}

/**
 * Decide which provider/model the reply generator talks to.
 *
 * The settings win; an empty override follows the session's own model, which is
 * what "default follows the conversation model" means in practice.
 *
 * @param {object} cfg live settings projection
 * @param {{provider?: string, model?: string}} [fallback] session route
 * @returns {{provider: string, model: string, source: 'settings'|'session'|'mixed'|'none'}} route
 */
export function resolveReplyerRoute(cfg, fallback) {
  const overrideProvider = text(cfg?.replyerProvider);
  const overrideModel = text(cfg?.replyerModel);
  const sessionProvider = text(fallback?.provider);
  const sessionModel = text(fallback?.model);
  const provider = overrideProvider || sessionProvider;
  const model = overrideModel || sessionModel;
  let source = 'session';
  if (overrideProvider && overrideModel) source = 'settings';
  else if (overrideProvider || overrideModel) source = 'mixed';
  if (!provider || !model) source = 'none';
  return { provider, model, source };
}

/**
 * Whether streamed text already reads as a finished spoken line.
 *
 * The signal is the last character: text that ends in terminal punctuation
 * (optionally behind a closing quote) ended where a sentence ends, so the stream
 * stopping afterwards did not cut it short.
 *
 * @param {string} value text to inspect, already trimmed
 * @returns {boolean} whether it ends where a spoken line may end
 */
function looksFinished(value) {
  return /[。！？!?….]["'”’」』）)]?$/.test(value);
}

/**
 * Create the reply generator.
 *
 * @param {object} options
 * @param {object} options.ctx plugin context (`ctx.get('llm')`)
 * @param {object} [options.logger] host logger
 * @returns {{generate: (input: object) => Promise<object>, streamOnce: (input: object) => Promise<object>}} replyer
 */
export function createReplyer({ ctx, logger }) {
  /**
   * One provider attempt. A stream always ends with a terminal `finish` chunk,
   * so failure is read from the finish reason rather than from a throw — but a
   * throw is caught too, because a missing service or a broken adapter is a
   * normal failure for a plugin.
   *
   * @param {object} input
   * @param {{provider: string, model: string}} input.route
   * @param {Array<object>} input.messages
   * @returns {Promise<{ok: true, text: string} | {ok: false, error: string}>} attempt result
   */
  async function streamOnce({ route, messages }) {
    let llm;
    try {
      llm = ctx?.get?.('llm') ?? ctx?.llm;
    } catch (err) {
      return { ok: false, error: `llm lookup failed: ${String(err?.message ?? err)}` };
    }
    if (!llm || typeof llm.stream !== 'function') return { ok: false, error: 'the host llm service is unavailable' };
    let body = '';
    let failure = null;
    try {
      for await (const chunk of llm.stream({ provider: route.provider, model: route.model, messages })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          body += chunk.text;
          continue;
        }
        if (chunk?.type === 'finish') {
          const kind = chunk?.reason?.kind;
          if (kind === 'error' || kind === 'aborted') {
            failure = String(chunk?.reason?.failure?.code ?? kind);
          }
        }
      }
    } catch (err) {
      return { ok: false, error: `stream failed: ${String(err?.message ?? err)}` };
    }
    const trimmed = text(body);
    // Text that arrived before the terminal chunk is normally not an answer when
    // that chunk flagged an error or an abort: the draft is truncated, so using
    // it would speak half a sentence. The exception is text that already ends
    // where a sentence ends — throwing away a whole usable reply because the
    // stream then flagged a failure would put the failure line in the user's ear
    // for no reason. That case is marked `degraded` so the caller logs it rather
    // than passing it off as a clean answer.
    if (trimmed.length > 0 && (!failure || looksFinished(trimmed))) {
      return failure ? { ok: true, text: trimmed, degraded: failure } : { ok: true, text: trimmed };
    }
    return { ok: false, error: failure ? `the reply generator failed (${failure})` : 'the reply generator returned nothing' };
  }

  /**
   * One prompt pair, tried in both message shapes: `split` first, `combined` as
   * the retry. The retry is the "retry once" the settings promise, and it also
   * covers a route that refuses a non-durable system message (the same words go
   * out as a single user message). Every call site gets the same two attempts,
   * so the normal channel and the shortening pass cannot drift apart.
   *
   * @param {{provider: string, model: string}} route
   * @param {{system: string, user: string}} prompts prompt pair
   * @returns {Promise<{ok: true, text: string} | {ok: false, error: string}>} first success, else the last failure
   */
  async function attemptPrompt(route, prompts) {
    let last = null;
    for (const mode of ['split', 'combined']) {
      const attempt = await streamOnce({ route, messages: replyerMessages(prompts, mode) });
      if (attempt.ok) return attempt;
      last = attempt;
      logger?.debug?.(`dsh-xiaoai-bridge: replyer attempt failed: ${attempt.error}`);
    }
    return last;
  }

  /**
   * Turn the agent's answer into a spoken line.
   *
   * @param {object} input
   * @param {string} input.intent the agent's own answer
   * @param {Array<{role: string, text: string}>} [input.history] recent turns
   * @param {object} input.cfg live settings projection
   * @param {{provider?: string, model?: string}} [input.fallbackRoute] session route
   * @returns {Promise<object>} `{ok, text, provider, model, source}` or `{ok: false, error}`
   */
  async function generate({ intent, history, cfg, fallbackRoute }) {
    const route = resolveReplyerRoute(cfg, fallbackRoute);
    if (route.source === 'none') {
      // Nothing to call. The caller decides what to say instead; this is a
      // configuration gap, not a reply-generator failure.
      return { ok: false, error: 'no model route for the reply generator', reason: 'no-route', provider: '', model: '' };
    }

    const prompts = buildReplyerPrompts({ intent, history, cfg });
    // The second attempt is the "retry once" the settings promise, and it also
    // covers a route that refuses a non-durable system message: the same words
    // go out as a single user message.
    const first = await attemptPrompt(route, prompts);
    if (!first.ok) return { ok: false, error: first.error, reason: 'failure', provider: route.provider, model: route.model };
    // A degraded attempt is a success with a caveat: the text was kept because it
    // already read as finished, but the failure behind it still gets a line.
    if (first.degraded) {
      logger?.warn?.(`dsh-xiaoai-bridge: reply generator stream ended with ${first.degraded}; speaking the text it had already produced`);
    }
    let textValue = first.text;

    const maxChars = Number.isFinite(cfg?.spokenMaxChars) ? Math.floor(cfg.spokenMaxChars) : 0;
    if (maxChars > 0 && textValue.length > maxChars) {
      // The shortening pass gets the same two message shapes as the first
      // channel; a route that rejected the system message once will reject it
      // again here, and without the retry the long draft would be truncated
      // instead of properly shortened.
      const condensed = await attemptPrompt(route, buildCondensePrompts({ draft: textValue, intent, history, cfg, maxChars }));
      if (condensed.ok && condensed.text.length > 0) textValue = condensed.text;
      else if (!condensed.ok) logger?.debug?.(`dsh-xiaoai-bridge: replyer shortening pass failed: ${condensed.error}`);
    }
    if (maxChars > 0 && textValue.length > maxChars) textValue = truncateSpokenText(textValue, maxChars);

    const out = { ok: true, text: textValue, provider: route.provider, model: route.model, source: route.source };
    if (first.degraded) out.degraded = first.degraded;
    return out;
  }

  return { generate, streamOnce };
}
