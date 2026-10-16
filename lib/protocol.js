/**
 * OpenCode Zen 匿名免费通道的请求伪装。
 *
 * 免费通道对客户端形状有三道门（2026-10 实测），三者缺一即 403 FreeTierError：
 *
 *   1. `user-agent` 必须是 `opencode/<版本> (...)` 的形状，追加任何后缀都会被拒；
 *   2. 会话头必须是 canonical id：`ses_` + 12 位小写 hex + 14 位 Base62。
 *      那 12 位 hex 不是随机串，而是把真实毫秒时钟 + 每毫秒序号 1 整体按位取反；
 *      上游会解回时间戳并校验低 12 位序号落在 [0, 63]；
 *   3. 请求体必须 `stream: true`，且 `tools` 里出现 `bash` 与 `read`。
 *
 * canonical id 的算法来自上游 identifier 生成器，经 opencode2dsh（FishBottle7）
 * 与 opencode2api（jasonxu114514）的公开实现确认，见 README「致谢」。
 *
 * @module opencode2dsh/protocol
 */

import { createHash } from 'node:crypto';

/** Zen 的 OpenAI 兼容入口。 */
export const ZEN_BASE_URL = 'https://opencode.ai/zen/v1';
/** 匿名通道的凭据是字面量 `public`，不是个人密钥。 */
export const ANONYMOUS_KEY = 'public';
/** CLI 版本号只参与形状，不影响鉴权。 */
export const CLIENT_VERSION = '1.18.31';
/** 免费通道要求 tools 里出现的名字。 */
export const GATE_TOOL_NAMES = ['bash', 'read'];

/** OpenCode CLI 同形 user-agent。 */
export function opencodeUserAgent() {
	return `opencode/${CLIENT_VERSION} (${process.platform} ${process.arch}; node${process.versions.node})`;
}

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** canonical 会话形状。 */
export const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const SESSION_MEMO_LIMIT = 512;
const sessionMemo = new Map();

/** 12 位时间片段：毫秒时钟 + 每毫秒序号 1，整体按位取反。 */
export function invertedTimestampHex(now = Date.now()) {
	return (~(BigInt(now) * 4096n + 1n) & 281474976710655n).toString(16).padStart(12, '0');
}

function base62Fixed(value, width) {
	let n = value;
	const out = new Array(width);
	for (let i = width - 1; i >= 0; i--) {
		out[i] = BASE62_ALPHABET.charAt(Number(n % 62n));
		n /= 62n;
	}
	return out.join('');
}

/**
 * 把任意会话种子展开成 canonical `ses_*`。
 * 同一会话必须复用同一个 id：上游按会话归集免费额度并复用 prompt cache。
 * 已经是 canonical 形状的输入原样透传。
 */
export function canonicalSessionID(signal) {
	if (typeof signal !== 'string' || signal.length === 0) signal = randomID('fallback', 16);
	if (CANONICAL_SESSION_PATTERN.test(signal)) return signal;
	const memoized = sessionMemo.get(signal);
	if (memoized !== undefined) return memoized;
	const sum = createHash('sha256').update(`ses\0${signal}`).digest();
	const session = `ses_${invertedTimestampHex()}${base62Fixed(BigInt(`0x${sum.subarray(6, 16).toString('hex')}`), 14)}`;
	if (sessionMemo.size >= SESSION_MEMO_LIMIT) {
		const oldest = sessionMemo.keys().next();
		if (!oldest.done) sessionMemo.delete(oldest.value);
	}
	sessionMemo.set(signal, session);
	return session;
}

export function stableID(prefix, seed) {
	const digest = createHash('sha256').update(`${prefix}\0${seed}`).digest('hex');
	return `${prefix}_${digest.slice(0, 24)}`;
}

export function randomID(prefix, bytes) {
	const entropy = `${Date.now()}\0${Math.random()}\0${process.hrtime.bigint()}`;
	return `${prefix}_${createHash('sha256').update(entropy).digest('hex').slice(0, bytes * 2)}`;
}

/** 会话首条用户消息作为关联种子：同一对话稳定，跨对话不碰撞。 */
export function conversationSeed(messages) {
	if (!Array.isArray(messages)) return '';
	for (const message of messages) {
		if (!message || message.role !== 'user') continue;
		let encoded;
		try {
			encoded = JSON.stringify(message.content ?? null);
		} catch {
			continue;
		}
		if (typeof encoded === 'string' && encoded.length > 0 && encoded !== 'null') return encoded;
	}
	return '';
}

/** 一次上游请求的关联 id。 */
export function deriveRequestIDs(messages) {
	const seed = conversationSeed(messages) || randomID('fallback', 16);
	return {
		session: canonicalSessionID(seed),
		request: randomID('req', 12),
		project: stableID('prj', 'opencode2dsh:default-project'),
	};
}

/** 与 OpenCode CLI 同形的请求头。 */
export function disguiseHeaders(ids) {
	return {
		'content-type': 'application/json',
		accept: 'text/event-stream',
		authorization: `Bearer ${ANONYMOUS_KEY}`,
		'user-agent': opencodeUserAgent(),
		'x-opencode-client': 'cli',
		'x-opencode-session': ids.session,
		'x-session-affinity': ids.session,
		'X-Session-Id': ids.session,
		'x-opencode-request': ids.request,
		'x-opencode-project': ids.project,
	};
}

/** 免费通道只检查名字，不检查 schema。 */
export function gateTool(toolName) {
	return {
		type: 'function',
		function: {
			name: toolName,
			description: 'Reserved for the host runtime; do not call it.',
			parameters: { type: 'object', properties: {} },
		},
	};
}

/**
 * 把 DSH 声明的工具翻译成上游 tools 数组，并保证 `bash` / `read` 出现。
 *
 * - 有真实工具时缺谁补谁，占位工具不会被执行（名字与宿主工具同名时不重复补）；
 * - 完全没有工具（会话标题、压缩这类内部调用）时只发两个占位，
 *   并用 `tool_choice: 'none'` 禁止模型真的去调它们。
 */
export function buildWireTools(declared) {
	const list = Array.isArray(declared) ? declared.filter((tool) => tool && typeof tool.name === 'string' && tool.name.length > 0) : [];
	const present = new Set(list.map((tool) => tool.name));
	const wire = list.map((tool) => ({
		type: 'function',
		function: {
			name: tool.name,
			description: typeof tool.description === 'string' ? tool.description : '',
			parameters: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
		},
	}));
	if (wire.length === 0) {
		for (const toolName of GATE_TOOL_NAMES) wire.push(gateTool(toolName));
		return { tools: wire, toolChoice: 'none' };
	}
	for (const toolName of GATE_TOOL_NAMES) {
		if (!present.has(toolName)) wire.push(gateTool(toolName));
	}
	return { tools: wire, toolChoice: undefined };
}
