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
 * speaker — it is the escape hatch for text that must be read out verbatim.
 */
export const SPEAK_TOOL_DESCRIPTION = [
  '让小爱音箱（用户房间里的实体音箱）用语音念出一段话。',
  '注意：当主人通过小爱音箱跟你说话时，你的回复正文会被自动念出来（念之前会先做一次口语化润色），',
  '所以一般**不需要**调用本工具：直接把要说的话写成回复正文就好，',
  '不要包含 Markdown、代码、emoji、颜文字、括号里的动作或心理描写、URL，尽量 300 字以内。',
  '只有当你需要**逐字念出、不要润色**的内容（例如口令、验证码、必须一字不差的句子）时才调用本工具。',
  '同一轮里只会念一次：重复调用会被忽略。调用会立即返回，音箱在后台播放。',
].join('');

/** @param {unknown} err @returns {string} a bounded message string */
function messageOf(err) {
  return String(err?.message ?? err).slice(0, 300);
}

/**
 * Build the `xiaoai_speak` tool definition.
 *
 * @param {object} options
 * @param {() => object} options.getConfig live settings projection
 * @param {object} options.bridge bridge API client (`playText`)
 * @param {object} options.sessions device/session bridge (`deviceForSession`)
 * @param {object} [options.autoSpeak] turn bookkeeping (`claimToolSpeak`, `noteSpoken`)
 * @param {object} [options.logger] host logger
 * @returns {object} a raw JSON-Schema tool definition for `ctx.tools.register`
 */
export function createSpeakTool({ getConfig, bridge, sessions, autoSpeak, logger }) {
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
      const device = sessions.deviceForSession(sessionId) ?? sessions.primaryDevice();
      if (device && device.host) logger?.debug?.(`dsh-xiaoai-bridge: xiaoai_speak -> ${device.name || device.host}`);

      const result = await bridge.playText(text);
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
