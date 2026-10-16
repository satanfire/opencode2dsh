/**
 * 离线测试：不访问网络，覆盖协议伪装、消息映射、失败映射、SSE 翻译、目录筛选。
 *
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	CANONICAL_SESSION_PATTERN,
	buildWireTools,
	canonicalSessionID,
	deriveRequestIDs,
	disguiseHeaders,
	invertedTimestampHex,
} from '../lib/protocol.js';
import { metaFor } from '../lib/models.js';
import { toWireMessages } from '../lib/messages.js';
import { llmError, upstreamError } from '../lib/errors.js';
import { parseSse, translate } from '../lib/stream.js';
import { createCatalog, discoverFreeModels, probeModel } from '../lib/catalog.js';

// #region 测试替身

function jsonResponse(body, { status = 200, headers = {} } = {}) {
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: { get: (name) => headers[name.toLowerCase()] ?? null },
		body: null,
		async text() {
			return typeof body === 'string' ? body : JSON.stringify(body);
		},
		async json() {
			return typeof body === 'string' ? JSON.parse(body) : body;
		},
	};
}

async function collect(iterable) {
	const out = [];
	for await (const item of iterable) out.push(item);
	return out;
}

async function* eventsOf(list) {
	for (const item of list) yield item;
}

function sseChunk(delta, extra = {}) {
	return JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }], ...extra });
}

// #endregion

// #region 会话 id 与请求伪装

const TIME_MASK = 281474976710655n;

test('invertedTimestampHex 是时钟取反，低 12 位是序号 1', () => {
	const now = 1_800_000_000_000;
	const decoded = ~BigInt(`0x${invertedTimestampHex(now)}`) & TIME_MASK;
	// 时间片只有 48 位，时钟左移 12 位后高位会被截断——上游只解回低位。
	assert.equal(decoded, ((BigInt(now) * 4096n + 1n) & TIME_MASK));
	assert.equal(decoded & 4095n, 1n, '低 12 位必须落在上游接受的 [0, 63] 区间');
});

test('canonicalSessionID 产出 canonical 形状', () => {
	assert.match(canonicalSessionID('seed-a'), CANONICAL_SESSION_PATTERN);
});

test('canonicalSessionID 对同一会话稳定、对不同会话不同', () => {
	assert.equal(canonicalSessionID('same'), canonicalSessionID('same'));
	assert.notEqual(canonicalSessionID('a'), canonicalSessionID('b'));
});

test('canonicalSessionID 对已 canonical 的输入原样透传', () => {
	const given = 'ses_0123456789abEFGHIJKLMNOPQR';
	assert.match(given, CANONICAL_SESSION_PATTERN, '示例串本身必须合法');
	assert.equal(canonicalSessionID(given), given);
	const generated = canonicalSessionID('roundtrip');
	assert.equal(canonicalSessionID(generated), generated);
});

test('deriveRequestIDs 给出会话/请求/项目三个关联 id', () => {
	const messages = [{ role: 'user', content: [{ type: 'text', text: '你好' }] }];
	const first = deriveRequestIDs(messages);
	const second = deriveRequestIDs(messages);
	assert.match(first.session, CANONICAL_SESSION_PATTERN);
	assert.equal(first.session, second.session, '同一会话必须复用会话 id');
	assert.match(first.request, /^req_[0-9a-f]{24}$/);
	assert.notEqual(first.request, second.request, '每个请求要有新的 request id');
	assert.equal(first.project, second.project, '项目 id 应当稳定');
});

test('disguiseHeaders 与 CLI 同形：UA 无后缀，会话头一致，凭据是 public', () => {
	const headers = disguiseHeaders(deriveRequestIDs([{ role: 'user', content: 'x' }]));
	assert.match(headers['user-agent'], /^opencode\/\d+\.\d+\.\d+ \([^)]+\)$/);
	assert.equal(headers.authorization, 'Bearer public');
	assert.equal(headers['x-opencode-client'], 'cli');
	const session = headers['x-opencode-session'];
	assert.equal(headers['x-session-affinity'], session);
	assert.equal(headers['X-Session-Id'], session);
});

// #endregion

// #region 工具闸门

test('声明工具为空时补两个占位并禁用工具调用', () => {
	const { tools, toolChoice } = buildWireTools([]);
	assert.deepEqual(tools.map((tool) => tool.function.name), ['bash', 'read']);
	assert.equal(toolChoice, 'none');
});

test('bash 与 read 都在时不补占位', () => {
	const declared = [
		{ name: 'bash', description: '跑命令', parameters: { type: 'object' } },
		{ name: 'read', description: '读文件', parameters: { type: 'object' } },
		{ name: 'grep', description: '搜索', parameters: { type: 'object' } },
	];
	const { tools, toolChoice } = buildWireTools(declared);
	assert.deepEqual(tools.map((tool) => tool.function.name), ['bash', 'read', 'grep']);
	assert.equal(toolChoice, undefined);
	assert.equal(tools[0].function.description, '跑命令', '真实工具的定义必须保留');
});

test('缺 read 时只补缺失的那个', () => {
	const { tools } = buildWireTools([{ name: 'bash', description: '跑命令', parameters: { type: 'object' } }]);
	assert.deepEqual(tools.map((tool) => tool.function.name), ['bash', 'read']);
	assert.equal(tools[1].function.description, 'Reserved for the host runtime; do not call it.');
});

// #endregion

// #region 消息映射

test('system 选项与历史消息按顺序映射', () => {
	const wire = toWireMessages({
		system: '你是助手',
		messages: [
			{ role: 'user', content: [{ type: 'text', text: '你好' }] },
			{ role: 'assistant', content: [{ type: 'text', text: '在' }] },
		],
	});
	assert.deepEqual(wire, [
		{ role: 'system', content: '你是助手' },
		{ role: 'user', content: '你好' },
		{ role: 'assistant', content: '在' },
	]);
});

test('developer 落到 system，工具块与图片投影成占位符', () => {
	const wire = toWireMessages({
		messages: [
			{ role: 'developer', content: [{ type: 'text', text: '规则' }, { type: 'tool-addition', toolName: 'bash' }] },
			{ role: 'user', content: [{ type: 'image', attachment: {} }, { type: 'text', text: '看图' }] },
		],
	});
	assert.deepEqual(wire, [
		{ role: 'system', content: '规则' },
		{ role: 'user', content: '[image]看图' },
	]);
});

test('assistant 的工具调用与工具结果能往返', () => {
	const wire = toWireMessages({
		messages: [
			{ role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }] },
			{ role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'file.txt' }] },
		],
	});
	assert.equal(wire[0].role, 'assistant');
	assert.equal(wire[0].content, null, '没有正文时 content 必须是 null');
	assert.deepEqual(wire[0].tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }]);
	assert.deepEqual(wire[1], { role: 'tool', tool_call_id: 'call_1', content: 'file.txt' });
});

// #endregion

// #region 失败映射

test('llmError 同时暴露 code 与一致的 failure 快照', () => {
	const error = llmError('炸了', 'RATE_LIMIT', { status: 429, providerRetryAfterMs: 1500 });
	assert.equal(error.code, 'RATE_LIMIT');
	assert.equal(error.failure.code, error.code, 'normalizeLlmFailure 要求两者一致才会采纳快照');
	assert.equal(error.failure.status, 429);
	assert.equal(error.failure.providerRetryAfterMs, 1500);
});

test('429 映射成可重试的 RATE_LIMIT 并带 Retry-After', async () => {
	const error = await upstreamError(jsonResponse({ error: { type: 'server_error', message: 'busy' } }, { status: 429, headers: { 'retry-after': '3' } }), 'm');
	assert.equal(error.code, 'RATE_LIMIT');
	assert.equal(error.failure.status, 429);
	assert.equal(error.failure.providerRetryAfterMs, 3000);
});

test('地区限制映射成 MODEL_UNAVAILABLE，普通 403 映射成 AUTH', async () => {
	const region = await upstreamError(jsonResponse({ error: { type: 'RegionError', message: 'not available in your country' } }, { status: 403 }), 'm');
	assert.equal(region.code, 'MODEL_UNAVAILABLE');
	const denied = await upstreamError(jsonResponse({ error: { type: 'FreeTierError', message: 'only from within OpenCode' } }, { status: 403 }), 'm');
	assert.equal(denied.code, 'AUTH');
});

test('5xx 映射成可重试的 SERVER', async () => {
	const error = await upstreamError(jsonResponse('upstream down', { status: 503 }), 'm');
	assert.equal(error.code, 'SERVER');
	assert.equal(error.failure.status, 503);
});

// #endregion

// #region SSE 解析与翻译

test('parseSse 处理跨块的帧、注释行与 [DONE]', async () => {
	const chunks = [': keep-alive\n\ndata: {"a":', '1}\n\ndata: {"b":2}\n\n', 'data: [DONE]\n\ndata: {"c":3}\n'];
	assert.deepEqual(await collect(parseSse(chunks)), [{ a: 1 }, { b: 2 }]);
});

test('translate 把文本、思考与工具调用翻成块协议', async () => {
	const events = [
		{ choices: [{ delta: { reasoning_content: '先想一下' }, finish_reason: null }] },
		{ choices: [{ delta: { content: '你好' }, finish_reason: null }] },
		{ choices: [{ delta: { content: '世界' }, finish_reason: null }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: 'bash', arguments: '{"comm' } }] }, finish_reason: null }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] }, finish_reason: null }] },
		{ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 7 } } },
	];
	const chunks = await collect(translate(eventsOf(events), 'demo-model'));

	const starts = chunks.filter((chunk) => chunk.type === 'block-start');
	assert.deepEqual(starts.map((chunk) => chunk.blockType), ['reasoning', 'text', 'tool-call']);

	const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
	assert.equal(text, '你好世界');

	const ends = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block);
	assert.deepEqual(ends[0], { type: 'reasoning', text: '先想一下' });
	assert.deepEqual(ends[1], { type: 'text', text: '你好世界' });
	assert.deepEqual(ends[2], { type: 'tool-call', id: 'call_x', name: 'bash', arguments: '{"command":"ls"}' });

	const usage = chunks.find((chunk) => chunk.type === 'usage');
	assert.deepEqual(usage.usage, { inputTokens: 60, outputTokens: 20, cacheReadTokens: 40, reasoningTokens: 7, totalTokens: 120 });

	const finish = chunks.find((chunk) => chunk.type === 'finish');
	assert.deepEqual(finish.reason, { kind: 'tool-calls' });
	assert.ok(chunks.indexOf(chunks.find((chunk) => chunk.type === 'usage')) < chunks.indexOf(finish), 'usage 必须在 finish 之前');
});

test('translate 对没有正文字段的流报 EMPTY_RESPONSE', async () => {
	const events = [{ choices: [{ delta: {}, finish_reason: 'stop' }] }];
	await assert.rejects(() => collect(translate(eventsOf(events), 'demo-model')), (error) => error.code === 'EMPTY_RESPONSE');
});

test('translate 对完全无帧的流报 EMPTY_RESPONSE', async () => {
	await assert.rejects(() => collect(translate(eventsOf([]), 'demo-model')), (error) => error.code === 'EMPTY_RESPONSE');
});

// #endregion

// #region 模型元数据与目录

test('metaFor 取内置表并接受配置覆盖', () => {
	assert.equal(metaFor('deepseek-v4.1-flash-free').name, 'DeepSeek V4.1 Flash');
	assert.equal(metaFor('unknown-model-free').name, 'Unknown Model');
	assert.equal(metaFor('unknown-model-free').contextWindow, 131072);
	const overridden = metaFor('big-pickle', { 'big-pickle': { contextWindow: 262144, maxTokens: 4096, name: '自定义' } });
	assert.deepEqual(overridden, { name: '自定义', contextWindow: 262144, maxTokens: 4096 });
});

test('discoverFreeModels 只保留免费候选并排除 test', async () => {
	const fetchImpl = async () => jsonResponse({ data: [{ id: 'alpha-free' }, { id: 'big-pickle' }, { id: 'gpt-5.4' }, { id: 'test' }] });
	assert.deepEqual(await discoverFreeModels({ fetchImpl }), ['alpha-free', 'big-pickle']);
});

test('probeModel 把 200 / 429 视为放行，把地区拒绝与协议不支持排除', async () => {
	assert.equal(await probeModel('ok', { fetchImpl: async () => jsonResponse({}, { status: 200 }) }), 'ok');
	assert.equal(await probeModel('busy', { fetchImpl: async () => jsonResponse({}, { status: 429 }) }), 'ok');
	const region = async () => jsonResponse(JSON.stringify({ error: { message: 'This model is not available in your country' } }), { status: 403 });
	assert.equal(await probeModel('region', { fetchImpl: region }), 'rejected');
	const unsupported = async () => jsonResponse(JSON.stringify({ error: { type: 'ModelProtocolUnsupported' } }), { status: 400 });
	assert.equal(await probeModel('proto', { fetchImpl: unsupported }), 'rejected');
	assert.equal(await probeModel('net', { fetchImpl: async () => { throw new Error('boom'); } }), 'unknown');
});

test('目录刷新只暴露探测通过的模型，并记录错误', async () => {
	const cachePath = join(mkdtempSync(join(tmpdir(), 'oc2dsh-')), 'catalog.json');
	const fetchImpl = async (url, init) => {
		if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'good-free' }, { id: 'bad-free' }, { id: 'paid-model' }] });
		const body = JSON.parse(init.body);
		if (body.model === 'good-free') return jsonResponse({}, { status: 200 });
		if (body.model === 'bad-free') return jsonResponse(JSON.stringify({ error: { message: 'This model is not available in your country' } }), { status: 403 });
		throw new Error('不应探测付费模型');
	};
	let changes = 0;
	const catalog = createCatalog({ refreshSeconds: 3600, startDelayMs: 0, cachePath, fetchImpl, onChange: () => { changes += 1; } });
	assert.ok(await catalog.refresh());
	assert.deepEqual(catalog.ids(), ['good-free']);
	assert.equal(catalog.lastError(), '');
	assert.equal(changes, 1, '模型集合变化时必须通知 DSH 重读列表');
	assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf8')).ids, ['good-free']);
	catalog.stop();
});

test('目录刷新失败时保留现有名单并记录原因', async () => {
	const cachePath = join(mkdtempSync(join(tmpdir(), 'oc2dsh-')), 'catalog.json');
	const catalog = createCatalog({ refreshSeconds: 3600, startDelayMs: 0, cachePath, fetchImpl: async () => { throw new Error('offline'); } });
	assert.ok(!(await catalog.refresh()));
	assert.ok(catalog.ids().length > 0, '必须有兜底名单可用');
	assert.equal(catalog.lastError(), 'offline');
	assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).lastError, 'offline');
	catalog.stop();
});

// #endregion
