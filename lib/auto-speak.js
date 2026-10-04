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
 *   A call the bridge refused outright (an HTTP status, e.g. 503) hands the turn
 *   back, so a refused line does not silence what the turn had to say; a call
 *   that never got an answer (a timeout, an unreachable port) keeps the turn,
 *   because nothing proves the speaker stayed silent.
 * - `approval/asked` speaks the approval line right away and drops the draft:
 *   nothing has been answered yet, and the payload belongs on the screen. That
 *   one line is what the tool contract promises (see
 *   `skills/xiaoai-speak/SKILL.md` rule 3), so unlike a reply it is not the
 *   `autoSpeak` switch's to silence.
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
   * @param {string} [input.degraded] the replyer's stream ended with this failure
   *   code after the text had already read as finished (`replyer.js`), so the
   *   line sounding right does not mean the model call was clean. Omitted from
   *   the record entirely when absent, which keeps the record shape of every
   *   ordinary line unchanged.
   * @returns {Promise<void>} resolves when the log write settled
   */
  async function noteSpoken({ sessionId, deviceKey, intent, spoken, source, provider = '', model = '', degraded = '' }) {
    const state = sessionId ? turns.get(sessionId) : null;
    if (state) pushHistory(state, 'assistant', spoken);
    const record = {
      time: new Date().toISOString(),
      device: deviceKey || state?.deviceKey || '',
      intent,
      spoken,
      provider,
      model,
      source,
    };
    if (degraded) record.degraded = degraded;
    await spokenLog?.write?.(record);
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
    await playSpoken(state, { intent, spoken, source, provider, model, degraded: text(generated.degraded) });
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
   * @param {string} [input.degraded] the replyer's degraded stream code, when there was one
   * @returns {Promise<void>} resolves when playback was handed over
   */
  async function playSpoken(state, { intent, spoken, source, provider = '', model = '', degraded = '' }) {
    const played = await bridge.playText(spoken);
    if (!played?.ok) {
      logger?.warn?.(`dsh-xiaoai-bridge: auto speak failed: ${messageOf(played?.error ?? 'playback refused')}`);
      return;
    }
    logger?.info?.(`dsh-xiaoai-bridge[${state.deviceKey}] spoke (${source}): ${spoken.slice(0, 200)}`);
    await noteSpoken({ sessionId: state.sessionId, deviceKey: state.deviceKey, intent, spoken, source, provider, model, degraded });
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
   * The queue is per session on purpose: ordering ACROSS sessions belongs to
   * the bridge, not here. Every playback goes through the one lock and the
   * bounded queue in `POST /api/play/text`
   * (bridge/core/services/api_server.py), so two sessions speaking at once are
   * serialised there and the excess is refused with 503 instead of stacking.
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
        // `autoSpeak` gates the replies this module composes on its own. The
        // approval line is not one of them: it announces that a tool is blocked
        // on the screen, which the skill promises unconditionally
        // (skills/xiaoai-speak/SKILL.md rule 3). Only that source skips the gate.
        if (job.source !== 'approval' && !getConfig()?.autoSpeak) continue;
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
      // The call is already on the wire, so the turn is handed to the tool
      // before its body runs. That hand-over is provisional: a call that never
      // made a sound reports it back through `releaseToolSpeak`, and the turn
      // speaks again. `claimed` is what stops a second line while the first one
      // is still in flight.
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

    /**
     * Give this turn's spoken line back after `xiaoai_speak` did not take it.
     *
     * The turn is handed to the tool before the tool body runs, so its
     * `tool/call` event already dropped the draft and set `toolCalled`. A call
     * that then refuses itself — empty text, a plugin that is off, a session the
     * speaker did not start — would leave the turn marked as spoken and swallow
     * every text written afterwards, so those refusals call this too. Clearing
     * `claimed` as well is what makes a refused attempt retryable and lets the
     * reply written instead be spoken at `turn/end`.
     *
     * This is only safe because the sole caller is `lib/tools.js`, and it calls
     * it at the points where *this* call either never claimed (`claimed` false)
     * or claimed and then watched playback fail. A call still in flight in the
     * same step is the one case that would read `claimed` as its own: two
     * `xiaoai_speak` calls in one assistant step, one of them refused before the
     * claim while the other holds it, would hand the held line back and could
     * speak a second line in the turn.
     *
     * The drafted text stays dropped, as `tool/call` decided: the turn is
     * expected to write a fresh answer to the failure, and that answer becomes
     * the new draft. Only text written after this call can take the turn back.
     *
     * @param {string} [sessionId] session key
     * @returns {void}
     */
    releaseToolSpeak(sessionId) {
      const state = sessionId ? turns.get(sessionId) : null;
      if (!state || !state.awaiting) return;
      if (!state.claimed && !state.toolCalled) return;
      state.claimed = false;
      state.toolCalled = false;
      logger?.debug?.('dsh-xiaoai-bridge: xiaoai_speak did not speak; the turn may speak again');
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
