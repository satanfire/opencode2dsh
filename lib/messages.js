/**
 * DSH 消息 → OpenAI chat/completions 消息。
 *
 * @module opencode2dsh/messages
 */

/** 取一段内容里的可见文本；图片与文件在只声明文本输入时投影成占位符。 */
export function blocksToText(blocks) {
	if (!Array.isArray(blocks)) return '';
	const parts = [];
	for (const block of blocks) {
		if (!block) continue;
		if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
		else if (block.type === 'image') parts.push('[image]');
		else if (block.type === 'file') parts.push('[file]');
	}
	return parts.join('');
}

/** 把一条 assistant 消息里的 tool-call 块翻成 OpenAI 的 tool_calls。 */
function toolCallsOf(blocks) {
	return (Array.isArray(blocks) ? blocks : [])
		.filter((block) => block && block.type === 'tool-call')
		.map((block) => ({
			id: String(block.id ?? ''),
			type: 'function',
			function: {
				name: String(block.name ?? ''),
				arguments: typeof block.arguments === 'string' && block.arguments.length > 0 ? block.arguments : '{}',
			},
		}))
		.filter((call) => call.function.name.length > 0);
}

/**
 * 翻译整段对话。
 * `developer` 在 OpenAI 协议里没有对应角色，落到 `system`；
 * 工具增量块（tool-addition / tool-removal）不产生可见文本，由 `tools` 字段整体声明。
 */
export function toWireMessages(options = {}) {
	const out = [];
	if (typeof options.system === 'string' && options.system.length > 0) out.push({ role: 'system', content: options.system });
	const messages = Array.isArray(options.messages) ? options.messages : [];
	for (const message of messages) {
		if (!message) continue;
		switch (message.role) {
			case 'system':
			case 'developer':
				out.push({ role: 'system', content: blocksToText(message.content) });
				break;
			case 'user':
				out.push({ role: 'user', content: blocksToText(message.content) });
				break;
			case 'assistant': {
				const text = blocksToText(message.content);
				const toolCalls = toolCallsOf(message.content);
				const wire = { role: 'assistant', content: text.length > 0 ? text : null };
				if (toolCalls.length > 0) wire.tool_calls = toolCalls;
				out.push(wire);
				break;
			}
			case 'tool':
				out.push({ role: 'tool', tool_call_id: String(message.toolCallId ?? ''), content: blocksToText(message.content) });
				break;
			default:
				break;
		}
	}
	return out;
}
