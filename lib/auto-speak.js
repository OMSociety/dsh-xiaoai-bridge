/**
 * Automatic speaking.
 *
 * A voice turn has to end in sound, and the agent's own text is not what should
 * come out of the speaker (see {@link module:dsh-xiaoai-bridge/replyer}). This
 * module watches one session's events and decides, per turn, what the speaker
 * says:
 *
 * - `user/message` is not read here: the bridge already posts each recognized
 *   utterance to `/asr`, and that call is what opens a turn.
 * - `assistant/message` only records a draft. A turn can contain several
 *   assistant messages (one per step), and the last text-bearing one is the one
 *   the user should hear — the same "newest text wins, committed at `turn/end`"
 *   rule the harness uses for its own turn previews.
 * - `tool/call` marks that the agent spoke for itself through `xiaoai_speak`.
 *   The tool wins: its text is spoken verbatim and the drafted text is dropped.
 * - `approval/asked` speaks the approval line right away and drops the draft:
 *   nothing has been answered yet, and the payload belongs on the screen.
 * - `turn/end` is the only moment anything is spoken, so a reply never starts
 *   while the agent is still working.
 *
 * Everything is keyed by session id, which is the same identity the tool
 * execution context carries, so manual and automatic speaking share one
 * "already said this turn" flag.
 * @module dsh-xiaoai-bridge/auto-speak
 */

import { SPEAK_TOOL_NAME } from './tools.js';
import { truncateSpokenText } from './replyer.js';

/** Fallback failure line when the setting is empty. */
export const DEFAULT_FAILURE_TEXT = '回复器调用失败';

/** Fallback approval line when the setting is empty. */
export const DEFAULT_APPROVAL_TEXT = '需要你到电脑上确认一下';

/** @param {unknown} err @returns {string} a bounded message string */
function messageOf(err) {
  return String(err?.message ?? err).slice(0, 300);
}

/** @param {unknown} value @returns {string} trimmed string, '' when absent */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Create the automatic speaker.
 *
 * @param {object} options
 * @param {() => object} options.getConfig live settings projection
 * @param {object} options.bridge bridge API client (`playText`)
 * @param {object} options.replyer reply generator
 * @param {object} [options.spokenLog] appended-line log
 * @param {(sessionId: string) => ({provider?: string, model?: string})} [options.sessionRoute] the
 *   session's own model route, used when the settings do not override it
 * @param {object} [options.logger] host logger
 * @returns {object} auto-speak handle
 */
export function createAutoSpeak({ getConfig, bridge, replyer, spokenLog, sessionRoute, logger }) {
  /** @type {Map<string, object>} per-session turn state */
  const turns = new Map();

  /**
   * @param {string} sessionId session key
   * @param {string} [deviceKey] device key, when known
   * @returns {object} the session's state, created on first use
   */
  function ensureState(sessionId, deviceKey) {
    let state = turns.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        deviceKey: deviceKey ?? '',
        history: [],
        awaiting: false,
        draft: '',
        toolCalled: false,
        claimed: false,
        speaking: false,
        pending: null,
        approvalAnnounced: false,
      };
      turns.set(sessionId, state);
    }
    if (deviceKey) state.deviceKey = deviceKey;
    return state;
  }

  /**
   * Remember one line of the conversation for the reply generator, keeping at
   * most `replyerHistoryTurns` exchanges.
   *
   * @param {object} state session state
   * @param {'user'|'assistant'} role who said it
   * @param {string} body what was said
   * @returns {void}
   */
  function pushHistory(state, role, body) {
    const cfg = getConfig();
    const turns_ = Math.floor(Number(cfg?.replyerHistoryTurns ?? 0));
    if (!Number.isFinite(turns_) || turns_ <= 0) {
      state.history.length = 0;
      return;
    }
    const value = text(body);
    if (value.length === 0) return;
    state.history.push({ role, text: value });
    const cap = turns_ * 2;
    while (state.history.length > cap) state.history.shift();
  }

  /**
   * Write one spoken line to the log and to the reply generator's history.
   *
   * @param {object} input
   * @param {string} [input.sessionId] session key
   * @param {string} [input.deviceKey] device key
   * @param {string} input.intent what the agent meant
   * @param {string} input.spoken what the speaker said
   * @param {string} input.source `replyer` | `tool` | `failure` | `raw` | `approval`
   * @param {string} [input.provider] model provider
   * @param {string} [input.model] model id
   * @returns {Promise<void>} resolves when the log write settled
   */
  async function noteSpoken({ sessionId, deviceKey, intent, spoken, source, provider = '', model = '' }) {
    const state = sessionId ? turns.get(sessionId) : null;
    if (state) pushHistory(state, 'assistant', spoken);
    await spokenLog?.write?.({
      time: new Date().toISOString(),
      device: deviceKey || state?.deviceKey || '',
      intent,
      spoken,
      provider,
      model,
      source,
    });
  }

  /**
   * Speak one turn's reply.
   *
   * @param {object} state session state
   * @param {string} intent the agent's own text for this turn
   * @returns {Promise<void>} resolves when the line was handed to the speaker
   */
  async function speakTurn(state, intent) {
    const cfg = getConfig();
    const generated = await replyer.generate({
      intent,
      history: state.history,
      cfg,
      fallbackRoute: sessionRoute?.(state.sessionId) ?? null,
    });

    let spoken = '';
    let source = 'replyer';
    let provider = '';
    let model = '';
    if (generated.ok) {
      spoken = generated.text;
      provider = generated.provider ?? '';
      model = generated.model ?? '';
    } else if (generated.reason === 'no-route') {
      // No route is a settings gap, not a broken reply generator: saying the
      // failure line here would hide a working agent behind a config mistake.
      spoken = truncateSpokenText(intent, cfg?.spokenMaxChars);
      source = 'raw';
      logger?.warn?.('dsh-xiaoai-bridge: no model route for the reply generator; speaking the agent text as-is');
    } else {
      spoken = text(cfg?.replyerFailureText) || DEFAULT_FAILURE_TEXT;
      source = 'failure';
      logger?.warn?.(`dsh-xiaoai-bridge: reply generator failed (${generated.error}); speaking the failure line`);
    }
    if (spoken.length === 0) return;
    await playSpoken(state, { intent, spoken, source, provider, model });
  }

  /**
   * Hand one already-final line to the speaker and record it.
   *
   * @param {object} state session state
   * @param {object} input
   * @param {string} input.intent what the line answers
   * @param {string} input.spoken the exact words to speak
   * @param {string} input.source where the words came from
   * @param {string} [input.provider] model provider
   * @param {string} [input.model] model id
   * @returns {Promise<void>} resolves when playback was handed over
   */
  async function playSpoken(state, { intent, spoken, source, provider = '', model = '' }) {
    const played = await bridge.playText(spoken);
    if (!played?.ok) {
      logger?.warn?.(`dsh-xiaoai-bridge: auto speak failed: ${messageOf(played?.error ?? 'playback refused')}`);
      return;
    }
    logger?.info?.(`dsh-xiaoai-bridge[${state.deviceKey}] spoke (${source}): ${spoken.slice(0, 200)}`);
    await noteSpoken({ sessionId: state.sessionId, deviceKey: state.deviceKey, intent, spoken, source, provider, model });
  }

  /**
   * Put one line at the head of this session's queue and start draining.
   *
   * @param {object} state session state
   * @param {{intent: string, verbatim?: string, source?: string}} job the line to speak
   * @returns {void}
   */
  function queue(state, job) {
    state.pending = job;
    void drain(state);
  }

  /**
   * Speak anything queued for this session, one line at a time. A turn that
   * ends while a line is still playing replaces the queue instead of stacking:
   * only the newest reply is worth hearing.
   *
   * @param {object} state session state
   * @returns {Promise<void>} resolves when the queue drained
   */
  async function drain(state) {
    if (state.speaking) return;
    state.speaking = true;
    try {
      while (state.pending !== null) {
        const job = state.pending;
        state.pending = null;
        if (!getConfig()?.autoSpeak) continue;
        try {
          if (job.verbatim) await playSpoken(state, { intent: job.intent, spoken: job.verbatim, source: job.source });
          else await speakTurn(state, job.intent);
        } catch (err) {
          logger?.warn?.(`dsh-xiaoai-bridge: auto speak failed: ${messageOf(err)}`);
        }
      }
    } finally {
      state.speaking = false;
    }
  }

  return {
    /**
     * Open a turn: the bridge just delivered a recognized utterance.
     *
     * @param {object} input
     * @param {string} [input.sessionId] session key
     * @param {string} [input.deviceKey] device key
     * @param {string} [input.text] what the user said
     * @returns {void}
     */
    onUtterance({ sessionId, deviceKey, text: utterance }) {
      if (!sessionId) return;
      const state = ensureState(sessionId, deviceKey);
      state.awaiting = true;
      state.draft = '';
      state.toolCalled = false;
      state.claimed = false;
      state.approvalAnnounced = false;
      pushHistory(state, 'user', utterance);
    },

    /**
     * Record a text-bearing assistant message as this turn's draft.
     *
     * @param {string} sessionId session key
     * @param {string} body assistant text
     * @returns {void}
     */
    onAssistantText(sessionId, body) {
      if (!sessionId) return;
      const state = turns.get(sessionId);
      if (!state || !state.awaiting || state.toolCalled) return;
      const value = text(body);
      if (value.length === 0) return;
      state.draft = value;
    },

    /**
     * Notice that the agent used the speaker itself.
     *
     * @param {string} sessionId session key
     * @param {string} name tool name
     * @returns {void}
     */
    onToolCall(sessionId, name) {
      if (!sessionId || name !== SPEAK_TOOL_NAME) return;
      const state = turns.get(sessionId);
      if (!state) return;
      // The call is already on the wire, so this turn belongs to the tool even
      // if the tool itself then fails; `claimed` is what stops a second one.
      state.toolCalled = true;
      state.draft = '';
    },

    /**
     * A tool call is waiting for the user to approve something on screen.
     *
     * The approval payload is never read out — the speaker says the one line
     * that tells the user where to go, and nothing else. Whatever the agent had
     * written before asking is dropped with it: the user has not acted yet, so
     * that text is not an answer to anything. The turn itself stays open, so the
     * post-approval text becomes the draft and is spoken at `turn/end`.
     *
     * One line per turn: two tools blocked in the same step are still one walk
     * to the computer.
     *
     * @param {string} sessionId session key
     * @param {object} [data] `approval/asked` payload
     * @returns {void}
     */
    onApprovalAsked(sessionId, data) {
      if (!sessionId) return;
      const state = turns.get(sessionId);
      if (!state) return;
      if (state.approvalAnnounced) {
        logger?.debug?.('dsh-xiaoai-bridge: another approval in the same turn; the user is already on their way');
        return;
      }
      state.approvalAnnounced = true;
      state.draft = '';
      const name = text(data?.toolName);
      logger?.info?.(`dsh-xiaoai-bridge[${state.deviceKey}]: approval asked for ${name || 'a tool'}; asking the user to confirm on screen`);
      const spoken = text(getConfig()?.approvalText) || DEFAULT_APPROVAL_TEXT;
      queue(state, { intent: name ? `approval: ${name}` : 'approval', verbatim: spoken, source: 'approval' });
    },

    /**
     * Close a turn: this is the moment the speaker talks.
     *
     * @param {string} sessionId session key
     * @returns {void}
     */
    onTurnEnd(sessionId) {
      if (!sessionId) return;
      const state = turns.get(sessionId);
      if (!state) return;
      // A turn boundary is also where the next approval earns a fresh line.
      state.approvalAnnounced = false;
      if (!state.awaiting) return;
      const intent = state.draft;
      const toolCalled = state.toolCalled;
      state.awaiting = false;
      state.draft = '';
      state.toolCalled = false;
      state.claimed = false;
      if (intent.length === 0) return;
      if (toolCalled) {
        logger?.debug?.('dsh-xiaoai-bridge: xiaoai_speak handled this turn; the drafted text is dropped');
        return;
      }
      if (!getConfig()?.autoSpeak) {
        logger?.debug?.('dsh-xiaoai-bridge: autoSpeak is off; not speaking this turn');
        return;
      }
      queue(state, { intent });
    },

    /**
     * Reserve this turn's single spoken line for the `xiaoai_speak` tool.
     *
     * @param {string} [sessionId] session key
     * @returns {{allowed: boolean, reason?: string}} whether the tool may speak
     */
    claimToolSpeak(sessionId) {
      const state = sessionId ? turns.get(sessionId) : null;
      // No tracked turn (a desktop session, or the first call before any
      // utterance): nothing to deduplicate against.
      if (!state || !state.awaiting) return { allowed: true };
      // A `tool/call` event arrives before the tool body runs, so `toolCalled`
      // is already true on the first call; only `claimed` marks a spoken line.
      if (state.claimed) return { allowed: false, reason: 'already' };
      state.claimed = true;
      state.toolCalled = true;
      state.draft = '';
      return { allowed: true };
    },

    /** @see noteSpoken */
    noteSpoken,

    /**
     * A read-only view of the tracked turns, for the log and for tests.
     *
     * @returns {Array<object>} one summary per session
     */
    snapshot() {
      return [...turns.values()].map((state) => ({
        sessionId: state.sessionId,
        deviceKey: state.deviceKey,
        awaiting: state.awaiting,
        toolCalled: state.toolCalled,
        claimed: state.claimed,
        pending: state.pending !== null,
        history: state.history.length,
      }));
    },

    /** Drop every tracked turn. */
    dispose() {
      turns.clear();
    },
  };
}
