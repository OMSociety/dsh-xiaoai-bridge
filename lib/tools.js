/**
 * Model-facing tools contributed by the plugin.
 *
 * Tools are registered as raw JSON-Schema definitions through `ctx.tools.register`
 * rather than through the host's `defineTool` helper: an out-of-tree plugin
 * cannot reliably resolve `@deepseek-ai/dsh-tools`, and `register` returns the
 * disposer this module hands back to `ctx.effect`.
 * @module dsh-xiaoai-bridge/tools
 */

/** Registered tool name; stable, referenced by the `xiaoai-speak` skill text. */
export const SPEAK_TOOL_NAME = 'xiaoai_speak';

/**
 * Tool description.
 *
 * DSH does not render a `whenToUse` field, so the trigger conditions have to
 * live here as prose. Since the plugin speaks the agent's own reply body by
 * default (see `auto-speak.js`), this tool is no longer the way to answer the
 * speaker — it is the escape hatch for text that must be read out verbatim, and
 * the only way to speak without being asked first.
 */
export const SPEAK_TOOL_DESCRIPTION = [
  '让小爱音箱（用户房间里的实体音箱）用语音念出一段话。',
  '注意：当主人通过小爱音箱跟你说话时，你的回复正文会被自动念出来（念之前会先做一次口语化润色），',
  '所以一般**不需要**调用本工具：直接把要说的话写成回复正文就好，',
  '不要包含 Markdown、代码、emoji、颜文字、括号里的动作或心理描写、URL，尽量 300 字以内。',
  '只有当你需要**逐字念出、不要润色**的内容（例如口令、验证码、必须一字不差的句子）时才调用本工具。',
  '也可以**主动说话**，不必等主人先唤醒音箱：定时提醒到点、长任务跑完、有事要通知，',
  '直接调用本工具说出来即可（桥接器没在运行时会自动把它拉起来）。',
  '默认只在**小爱音箱发起的对话**里可用：在电脑或网页的普通对话里调用会被拒绝，',
  '除非在插件设置里打开了「任何会话都能让小爱说话」。',
  '同一轮里只会念一次：重复调用会被忽略。调用会立即返回，音箱在后台播放。',
].join('');

/** How long a bridge that was just started gets to answer, in milliseconds. */
const DEFAULT_REVIVE_WAIT_MS = 12000;
/** How often the request is retried while that bridge boots. */
const DEFAULT_REVIVE_POLL_MS = 1500;

/** @param {unknown} err @returns {string} a bounded message string */
function messageOf(err) {
  return String(err?.message ?? err).slice(0, 300);
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, Math.max(0, ms)); });
}

/**
 * Ask the bridge to speak, starting a dead one first.
 *
 * A failure with no HTTP status means the request never reached the API Server:
 * the bridge is down (it crashed, or nobody started it yet). A proactive line is
 * often the only sign anyone would notice, so the supervisor is asked to bring
 * the process up and the request is retried while it boots, rather than handing
 * back a connection error the user cannot act on. An HTTP error is a different
 * thing entirely — the bridge answered, and restarting it would be wrong.
 *
 * @param {string} text text to speak
 * @param {object} deps
 * @param {object} deps.bridge bridge API client (`playText`)
 * @param {() => Promise<{ok: boolean, error?: string}>} [deps.ensureBridge] starts the bridge on demand
 * @param {object} [deps.logger] host logger
 * @param {number} [deps.waitMs] how long to keep retrying a freshly started bridge
 * @param {number} [deps.pollMs] wait between those retries
 * @returns {Promise<{ok: boolean, status?: number, data?: any, error?: string}>} the bridge result
 */
async function speakWithRevive(text, { bridge, ensureBridge, logger, waitMs, pollMs }) {
  const first = await bridge.playText(text);
  if (first.ok || first.status !== undefined) return first;
  if (typeof ensureBridge !== 'function') return first;

  const started = await ensureBridge();
  if (!started || started.ok !== true) {
    const why = messageOf(started?.error ?? 'unknown');
    logger?.warn?.(`dsh-xiaoai-bridge: xiaoai_speak could not start the bridge: ${why}`);
    return { ok: false, error: `桥接器没在运行，自动启动也失败了：${why}` };
  }
  logger?.info?.('dsh-xiaoai-bridge: xiaoai_speak started the bridge on demand');

  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  const interval = Math.max(1, Number(pollMs) || DEFAULT_REVIVE_POLL_MS);
  let result = first;
  for (;;) {
    await sleep(interval);
    result = await bridge.playText(text);
    if (result.ok || result.status !== undefined) return result;
    if (Date.now() >= deadline) return result;
  }
}

/**
 * Build the `xiaoai_speak` tool definition.
 *
 * @param {object} options
 * @param {() => object} options.getConfig live settings projection
 * @param {object} options.bridge bridge API client (`playText`)
 * @param {object} options.sessions device/session bridge (`deviceForSession`)
 * @param {object} [options.autoSpeak] turn bookkeeping (`claimToolSpeak`, `noteSpoken`)
 * @param {() => Promise<{ok: boolean, error?: string}>} [options.ensureBridge] starts a dead bridge
 * @param {number} [options.reviveWaitMs] how long a revived bridge gets to answer
 * @param {number} [options.revivePollMs] retry interval while it boots
 * @param {object} [options.logger] host logger
 * @returns {object} a raw JSON-Schema tool definition for `ctx.tools.register`
 */
export function createSpeakTool({
  getConfig, bridge, sessions, autoSpeak, ensureBridge, logger,
  reviveWaitMs = DEFAULT_REVIVE_WAIT_MS,
  revivePollMs = DEFAULT_REVIVE_POLL_MS,
}) {
  return {
    name: SPEAK_TOOL_NAME,
    timeoutMs: 30000,
    description: SPEAK_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要朗读的文本。写成适合听的短句，不要包含 Markdown 标记、代码块或 URL。',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          isError: { type: 'boolean' },
        },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    /**
     * @param {object} args tool arguments
     * @param {object} [exec] execution context carrying the calling `agent`
     * @returns {Promise<{text: string, isError?: boolean}>} tool result
     */
    async execute(args, exec) {
      const text = String(args?.text ?? '').trim();
      if (text.length === 0) return { text: 'xiaoai_speak: text 不能为空', isError: true };

      const cfg = getConfig();
      if (!cfg.enabled) return { text: 'xiaoai_speak: 插件已在设置中禁用', isError: true };
      if (!cfg.apiServerEnabled) return { text: 'xiaoai_speak: 桥接器 API Server 已在设置中关闭', isError: true };

      const sessionId = exec?.agent?.session?.id;

      // Only speaker-started conversations may talk through the speaker. A chat
      // opened in the DSH window is not a voice conversation, so an unrelated
      // request must not make the speaker talk out of turn; `speakFromAnySession`
      // is the explicit opt-in that lifts the rule. Checked before the turn claim
      // so a refused call cannot consume the turn's one line.
      const bound = sessions.deviceForSession(sessionId);
      if (!bound && cfg.speakFromAnySession !== true) {
        logger?.debug?.('dsh-xiaoai-bridge: xiaoai_speak refused (this session was not started by a speaker)');
        return {
          text: 'xiaoai_speak 只能在小爱音箱发起的对话里用：当前会话不是音箱那一路，不能直接让音箱说话。'
            + '要让任何会话都能调用，可以在插件设置里打开「任何会话都能让小爱说话」。',
          isError: true,
        };
      }

      // One line per voice turn. The `tool/call` event reaches the plugin before
      // this body runs, so the first call is the one that claims the turn; a
      // repeat is ignored instead of talking over the line already playing.
      const claim = autoSpeak?.claimToolSpeak?.(sessionId);
      if (claim && claim.allowed === false) {
        logger?.debug?.('dsh-xiaoai-bridge: xiaoai_speak ignored (this turn already spoke)');
        return { text: 'xiaoai_speak: 这一轮已经念过一句了，重复的调用被忽略。' };
      }

      // Answer the speaker that asked. With a single device this is the same
      // record either way; the lookup is what makes multi-device correct later.
      // `primaryDevice()` is reached only when `speakFromAnySession` opened the
      // tool to sessions no speaker owns.
      const device = bound ?? sessions.primaryDevice();
      if (device && device.host) logger?.debug?.(`dsh-xiaoai-bridge: xiaoai_speak -> ${device.name || device.host}`);

      const result = await speakWithRevive(text, {
        bridge, ensureBridge, logger, waitMs: reviveWaitMs, pollMs: revivePollMs,
      });
      if (!result.ok) {
        logger?.warn?.(`dsh-xiaoai-bridge: xiaoai_speak failed: ${messageOf(result.error)}`);
        return { text: `xiaoai_speak 失败：${messageOf(result.error)}`, isError: true };
      }
      // The line is in the log with the agent's own wording on both sides: for a
      // verbatim line the intent and what was said are the same text.
      await autoSpeak?.noteSpoken?.({
        sessionId,
        deviceKey: device?.key ?? '',
        intent: text,
        spoken: text,
        source: 'tool',
      });
      return { text: `已让小爱音箱念出：${text}` };
    },
  };
}
