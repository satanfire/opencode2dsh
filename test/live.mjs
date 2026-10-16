/**
 * 联网集成测试：真实打 OpenCode Zen，验证目录探测、文本流与工具调用。
 *
 * 运行：npm run test:live
 * 需要能出网访问 opencode.ai；结果受当前出口 IP 的地区限制与配额影响。
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCatalog } from '../lib/catalog.js';
import { ZenAdapter } from '../lib/adapter.js';

const log = (level, message) => console.log(`  [${level}] ${message}`);

const catalog = createCatalog({
	refreshSeconds: 3600,
	startDelayMs: 0,
	cachePath: join(mkdtempSync(join(tmpdir(), 'oc2dsh-')), 'catalog.json'),
	logger: { info: (message) => log('info', message), warn: (message) => log('warn', message) },
});
const adapter = new ZenAdapter({ providerId: 'opencode2dsh', catalog, requestTimeoutMs: 300000 });

async function collect(options) {
	// 网络层瞬时拥塞（TRANSPORT / TIMEOUT）时重试，避免把抖动当成功能缺陷。
	let lastError;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const chunks = [];
		try {
			for await (const chunk of adapter.stream(options)) chunks.push(chunk);
			return chunks;
		} catch (error) {
			lastError = error;
			if (error?.code !== 'TRANSPORT' && error?.code !== 'TIMEOUT') throw error;
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}
	}
	throw lastError;
}

console.log('1. 目录探测');
let refreshed = false;
for (let attempt = 1; attempt <= 3 && !refreshed; attempt += 1) {
	refreshed = await catalog.refresh();
	if (!refreshed) await new Promise((resolve) => setTimeout(resolve, 2000));
}
assert.ok(refreshed, `目录刷新必须成功：${catalog.lastError()}`);
const ids = catalog.ids();
assert.ok(ids.length > 0, '至少要有一个可用模型');
console.log(`   可用模型 ${ids.length} 个：${ids.join(', ')}`);
const model = ids[0];

console.log('2. 文本流');
const plain = await collect({
	provider: 'opencode2dsh',
	model,
	messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: pong' }] }],
	maxTokens: 64,
});
const text = plain.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
const finish = plain.find((chunk) => chunk.type === 'finish');
const usage = plain.find((chunk) => chunk.type === 'usage');
assert.ok(text.length > 0, '必须有文本输出');
assert.equal(finish?.reason?.kind, 'stop');
assert.ok(usage?.usage?.inputTokens > 0, '必须有 usage 结算');
console.log(`   输出 ${JSON.stringify(text.slice(0, 40))}，用量 ${JSON.stringify(usage.usage)}`);

console.log('3. 工具调用');
const toolRun = await collect({
	provider: 'opencode2dsh',
	model,
	messages: [{ role: 'user', content: [{ type: 'text', text: 'Use the bash tool to run: echo hi. Call the tool, do not answer in text.' }] }],
	tools: [
		{
			name: 'bash',
			description: 'Run a shell command and return its output.',
			parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
		},
		{ name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } },
	],
	maxTokens: 256,
});
const call = toolRun.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
assert.ok(call, '模型必须发起工具调用');
assert.equal(call.block.name, 'bash');
assert.doesNotThrow(() => JSON.parse(call.block.arguments), '工具参数必须是合法 JSON');
console.log(`   调用 ${call.block.name}${call.block.arguments}`);

console.log('4. 地区受限模型给出确定失败');
try {
	await collect({ provider: 'opencode2dsh', model: 'cat-jam-free', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 16 });
	console.log('   cat-jam-free 可用（当前地区未受限）');
} catch (error) {
	assert.ok(['MODEL_UNAVAILABLE', 'AUTH', 'RATE_LIMIT'].includes(error.code), `意外失败码：${error.code}`);
	console.log(`   按预期失败：${error.code}`);
}

catalog.stop();
console.log('\n全部通过');
