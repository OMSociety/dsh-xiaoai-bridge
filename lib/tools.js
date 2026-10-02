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
 * live here as prose: the model only learns this tool is the way to answer a
 * speaker that talked to it by reading this sentence.
 */
export const SPEAK_TOOL_DESCRIPTION = [
  '让小爱音箱（用户房间里的实体音箱）用语音念出一段话。',
  '用户通过小爱音箱跟你说话时，你的回复会由你自己决定要不要念出来：需要念出来就调用本工具，',
  '只适合显示在屏幕上的内容（代码、长表格、链接清单）才不要调用。',
  '也用于用户明确要求「说给我听」「念一下」「播报」的场景。',
  '调用会立即返回，音箱在后台播放；不要为了等它播完而重复调用同一段文本。',
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
 * @param {object} [options.logger] host logger
 * @returns {object} a raw JSON-Schema tool definition for `ctx.tools.register`
 */
export function createSpeakTool({ getConfig, bridge, sessions, logger }) {
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

      // Answer the speaker that asked. With a single device this is the same
      // record either way; the lookup is what makes multi-device correct later.
      const sessionId = exec?.agent?.session?.id;
      const device = sessions.deviceForSession(sessionId) ?? sessions.primaryDevice();
      if (device && device.host) logger?.debug?.(`dsh-xiaoai-bridge: xiaoai_speak -> ${device.name || device.host}`);

      const result = await bridge.playText(text);
      if (!result.ok) {
        logger?.warn?.(`dsh-xiaoai-bridge: xiaoai_speak failed: ${messageOf(result.error)}`);
        return { text: `xiaoai_speak 失败：${messageOf(result.error)}`, isError: true };
      }
      return { text: `已让小爱音箱念出：${text}` };
    },
  };
}
