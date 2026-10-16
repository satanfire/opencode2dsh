/**
 * OpenAI SSE → DSH 流协议。
 *
 * DSH 的 `StreamChunk` 只有四种增量：block-start / text-delta / reasoning-delta /
 * tool-call-delta，外加 block-end、usage，以及恰好一个终止 finish。
 * 本模块负责把上游的 delta 累积成块，并在流末尾一次性结算。
 *
 * @module opencode2dsh/stream
 */

import { createHash } from 'node:crypto';
import { llmError } from './errors.js';

/** 把任意文本块序列解析成 SSE 事件对象。 */
export async function* parseSse(chunks) {
	let buffer = '';
	for await (const chunk of chunks) {
		buffer += chunk;
		let cut = buffer.indexOf('\n');
		while (cut >= 0) {
			const line = buffer.slice(0, cut).replace(/\r$/, '');
			buffer = buffer.slice(cut + 1);
			cut = buffer.indexOf('\n');
			if (line.length === 0 || line.startsWith(':')) continue;
			if (!line.startsWith('data:')) continue;
			const data = line.slice(5).trim();
			if (data === '[DONE]') return;
			if (data.length === 0) continue;
			try {
				yield JSON.parse(data);
			} catch {
				/* 跳过无法解析的帧 */
			}
		}
	}
}

/** 把 fetch Response 的 body 读成文本块序列，并保证取消下游读取。 */
async function* bodyChunks(response) {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			yield decoder.decode(value, { stream: true });
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			/* 流已结束 */
		}
	}
}

/** 解析一次流式响应。 */
export async function* readSseBody(response) {
	yield* parseSse(bodyChunks(response));
}

/**
 * 写入一次 usage 结算。
 * DSH 的计数是不重叠的：`inputTokens` 只算未命中缓存的输入。
 */
export function applyUsage(usage, raw) {
	if (!raw || typeof raw !== 'object') return;
	const prompt = typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : undefined;
	const cached = raw.prompt_tokens_details && typeof raw.prompt_tokens_details.cached_tokens === 'number' ? raw.prompt_tokens_details.cached_tokens : 0;
	if (prompt !== undefined) {
		usage.inputTokens = Math.max(0, prompt - cached);
		if (cached > 0) usage.cacheReadTokens = cached;
	}
	if (typeof raw.completion_tokens === 'number') usage.outputTokens = raw.completion_tokens;
	if (typeof raw.total_tokens === 'number') usage.totalTokens = raw.total_tokens;
	if (raw.completion_tokens_details && typeof raw.completion_tokens_details.reasoning_tokens === 'number') {
		usage.reasoningTokens = raw.completion_tokens_details.reasoning_tokens;
	}
}

/** 上游 finish_reason → DSH FinishReason。 */
export function finishReasonOf(raw) {
	switch (raw) {
		case 'tool_calls':
		case 'function_call':
			return { kind: 'tool-calls' };
		case 'length':
			return { kind: 'max-tokens' };
		default:
			return { kind: 'stop' };
	}
}

function toolCallID(key) {
	return `call_${createHash('sha256').update(`${key}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 20)}`;
}

/**
 * 事件流 → 块流。终止帧（usage + finish）由本函数补齐，调用方只负责转发。
 * @param {AsyncIterable<object>} events - 已解析的 SSE 事件。
 * @param {string} model - 请求的模型 id，只用于错误文案。
 */
export async function* translate(events, model) {
	const blocks = new Map();
	const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
	let nextIndex = 0;
	let reason;
	let sawFrame = false;

	function open(key, blockType) {
		let block = blocks.get(key);
		if (block) return block;
		block = { index: nextIndex++, type: blockType, text: '', json: '', id: '', toolName: '', closed: false };
		blocks.set(key, block);
		return block;
	}

	for await (const event of events) {
		sawFrame = true;
		if (event?.usage) applyUsage(usage, event.usage);
		if (event?.error) {
			const detail = typeof event.error?.message === 'string' ? event.error.message : JSON.stringify(event.error).slice(0, 300);
			const type = typeof event.error?.type === 'string' ? event.error.type : '';
			throw llmError(`OpenCode Zen 流中断（${model}）：${detail}`, type === 'RegionError' ? 'MODEL_UNAVAILABLE' : 'SERVER');
		}
		const choice = Array.isArray(event?.choices) ? event.choices[0] : undefined;
		if (!choice) continue;
		const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {};

		if (typeof delta.content === 'string' && delta.content.length > 0) {
			let block = blocks.get('text');
			if (block && block.closed) {
				blocks.delete('text');
				block = undefined;
			}
			if (!block) {
				block = open('text', 'text');
				yield { type: 'block-start', index: block.index, blockType: 'text' };
			}
			block.text += delta.content;
			yield { type: 'text-delta', index: block.index, text: delta.content };
		}

		const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
		if (reasoning.length > 0) {
			let block = blocks.get('reasoning');
			if (!block) {
				block = open('reasoning', 'reasoning');
				yield { type: 'block-start', index: block.index, blockType: 'reasoning' };
			}
			block.text += reasoning;
			yield { type: 'reasoning-delta', index: block.index, text: reasoning };
		}

		if (Array.isArray(delta.tool_calls)) {
			for (const call of delta.tool_calls) {
				if (!call || typeof call !== 'object') continue;
				const key = `tool-${typeof call.index === 'number' ? call.index : 0}`;
				let block = blocks.get(key);
				if (!block) {
					block = open(key, 'tool-call');
					block.id = typeof call.id === 'string' && call.id.length > 0 ? call.id : toolCallID(key);
					block.toolName = typeof call.function?.name === 'string' ? call.function.name : '';
					yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
					yield { type: 'tool-call-delta', index: block.index, id: block.id, name: block.toolName, argumentsDelta: '' };
				} else if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
					block.toolName = call.function.name;
				}
				const args = typeof call.function?.arguments === 'string' ? call.function.arguments : '';
				if (args.length > 0) {
					block.json += args;
					yield { type: 'tool-call-delta', index: block.index, id: block.id, argumentsDelta: args };
				}
			}
		}

		if (choice.finish_reason) reason = finishReasonOf(choice.finish_reason);
	}

	if (!sawFrame) throw llmError(`OpenCode Zen 未返回任何流式数据（${model}）`, 'EMPTY_RESPONSE');

	const ordered = [...blocks.values()].sort((left, right) => left.index - right.index);
	for (const block of ordered) {
		if (block.type === 'tool-call') {
			yield { type: 'block-end', index: block.index, block: { type: 'tool-call', id: block.id, name: block.toolName, arguments: block.json.length > 0 ? block.json : '{}' } };
		} else if (block.type === 'reasoning') {
			yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } };
		} else {
			yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } };
		}
	}

	const hasToolCall = ordered.some((block) => block.type === 'tool-call');
	const resolved = reason ?? (hasToolCall ? { kind: 'tool-calls' } : { kind: 'stop' });
	if (ordered.length === 0 && resolved.kind === 'stop') throw llmError(`OpenCode Zen 返回了空响应（${model}）`, 'EMPTY_RESPONSE');

	const finalUsage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
	if (usage.cacheReadTokens > 0) finalUsage.cacheReadTokens = usage.cacheReadTokens;
	if (usage.reasoningTokens > 0) finalUsage.reasoningTokens = usage.reasoningTokens;
	finalUsage.totalTokens = typeof usage.totalTokens === 'number' && usage.totalTokens > 0 ? usage.totalTokens : finalUsage.inputTokens + finalUsage.outputTokens + (finalUsage.cacheReadTokens ?? 0);
	yield { type: 'usage', usage: finalUsage };
	yield { type: 'finish', reason: resolved };
}
