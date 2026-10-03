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

/** Leading line of the "intent" section in the user prompt. */
const INTENT_HEADER = '【要表达的意图】';

/** Leading line of the transcript section in the user prompt. */
const HISTORY_HEADER = '【之前的对话】';

/** Label used for the user's own lines in the transcript. */
const USER_LABEL = '用户';

/** Label used for the speaker's lines in the transcript. */
const SELF_LABEL = '你';

/** @param {unknown} value @returns {string} trimmed string, '' when absent */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
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
    const body = text(turn?.text).replace(/\s+/g, ' ');
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
  const personality = text(cfg?.personality);
  if (personality.length > 0) system.push(`关于你自己：${personality}`);
  system.push('现在请你读一读之前的对话，把握当前的话题，然后把【要表达的意图】用日常、口语化的说法讲出来，就像对着用户说话一样。');
  const replyStyle = text(cfg?.replyStyle);
  if (replyStyle.length > 0) system.push(`说话风格：${replyStyle}`);
  const limits = text(cfg?.outputLimits);
  if (limits.length > 0) system.push(limits);

  const transcript = renderHistory(history);
  const user = [];
  if (transcript.length > 0) user.push(HISTORY_HEADER, transcript, '');
  user.push(INTENT_HEADER, text(intent));
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
    '【草稿】',
    text(draft),
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
  const head = body.slice(0, limit);
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
    if (trimmed.length > 0) return { ok: true, text: trimmed };
    return { ok: false, error: failure ? `the reply generator failed (${failure})` : 'the reply generator returned nothing' };
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
    const attempts = [replyerMessages(prompts, 'split'), replyerMessages(prompts, 'combined')];
    let last = null;
    let textValue = '';
    for (const messages of attempts) {
      const attempt = await streamOnce({ route, messages });
      if (attempt.ok) {
        textValue = attempt.text;
        last = null;
        break;
      }
      last = attempt;
      logger?.debug?.(`dsh-xiaoai-bridge: replyer attempt failed: ${attempt.error}`);
    }
    if (last) return { ok: false, error: last.error, reason: 'failure', provider: route.provider, model: route.model };

    const maxChars = Number.isFinite(cfg?.spokenMaxChars) ? Math.floor(cfg.spokenMaxChars) : 0;
    if (maxChars > 0 && textValue.length > maxChars) {
      const condensed = await streamOnce({
        route,
        messages: replyerMessages(buildCondensePrompts({ draft: textValue, intent, history, cfg, maxChars }), 'split'),
      });
      if (condensed.ok && condensed.text.length > 0) textValue = condensed.text;
      else if (!condensed.ok) logger?.debug?.(`dsh-xiaoai-bridge: replyer shortening pass failed: ${condensed.error}`);
    }
    if (maxChars > 0 && textValue.length > maxChars) textValue = truncateSpokenText(textValue, maxChars);

    return { ok: true, text: textValue, provider: route.provider, model: route.model, source: route.source };
  }

  return { generate, streamOnce };
}
