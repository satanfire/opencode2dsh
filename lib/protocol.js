/**
 * OpenCode Zen 匿名免费通道的请求伪装：严格对齐 OpenCode 客户端源码的发送形状。
 *
 * 形状来自 `opencode/packages/core/src/session/model-request.ts` 的请求头，
 * `packages/core/src/app.ts` 的 user-agent，以及
 * `packages/core/src/instructions/builtins.ts` 的 `<env>` 上下文块。
 * 上游免费门禁按这些形状放行，缺一项就回 `429 FreeUsageLimitError`。
 *
 * @module opencode2dsh/protocol
 */

import { createHash, randomBytes } from 'node:crypto';

/** 上游推理入口（OpenCode 客户端走 openai 兼容网关，不是 zen 的公共端点）。 */
export const INFERENCE_BASE_URL = 'https://opencode.ai/inference/openai/v1';
/** 模型目录仍从 zen 公共端点读取。 */
export const MODELS_URL = 'https://opencode.ai/zen/v1/models';
/** 匿名通道的凭据是字面量 `public`，不是个人密钥。 */
export const ANONYMOUS_KEY = 'public';
/** 与 `App.useragent()` 对齐：`opencode/<channel>/<version>/<name>`。 */
export const CLIENT_CHANNEL = 'latest';
export const CLIENT_VERSION = '2.0.29';
export const CLIENT_NAME = 'cli';
/** 免费通道要求 tools 里出现的名字。 */
export const GATE_TOOL_NAMES = ['bash', 'read'];

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** canonical 会话形状。 */
export const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const SESSION_MEMO_LIMIT = 512;
const sessionMemo = new Map();

/** OpenCode CLI 同形 user-agent。 */
export function opencodeUserAgent({ channel = CLIENT_CHANNEL, version = CLIENT_VERSION, name = CLIENT_NAME } = {}) {
	return `opencode/${channel}/${version}/${name}`;
}

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

/**
 * 项目 id：OpenCode 用 40 位十六进制串标识项目。
 * 同一工作目录必须稳定，否则上游会把请求当成陌生项目。
 */
export function projectIDFor(seed) {
	return createHash('sha1').update(`project\0${typeof seed === 'string' ? seed : ''}`).digest('hex');
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

/**
 * 一次上游请求的关联 id。
 * @param {readonly object[]} messages - 会话消息，用首条用户消息派生会话 id。
 * @param {{projectSeed?: string}} [options] - 项目种子的来源（通常是工作目录）。
 */
export function deriveRequestIDs(messages, options = {}) {
	const seed = conversationSeed(messages) || randomID('fallback', 16);
	return {
		session: canonicalSessionID(seed),
		request: randomID('req', 12),
		project: projectIDFor(typeof options.projectSeed === 'string' && options.projectSeed.length > 0 ? options.projectSeed : 'opencode2dsh:default-project'),
	};
}

/**
 * W3C trace 头：OpenCode 的 HTTP 层会自动注入，免费门禁形状里也带着它们。
 * 每次请求新生成一条 trace，不参与鉴权，只为形状一致。
 */
export function traceHeaders() {
	const trace = randomBytes(16).toString('hex');
	const span = randomBytes(8).toString('hex');
	const parent = randomBytes(8).toString('hex');
	return {
		b3: `${trace}-${span}-1-${parent}`,
		traceparent: `00-${trace}-${span}-01`,
	};
}

/**
 * 与 OpenCode CLI 同形的请求头。
 * @param {{session: string, project: string}} ids - {@link deriveRequestIDs} 的结果。
 * @param {{channel?: string, version?: string, name?: string}} [client] - 客户端形状覆盖。
 */
export function disguiseHeaders(ids, client = {}) {
	const name = typeof client.name === 'string' && client.name.length > 0 ? client.name : CLIENT_NAME;
	return {
		'content-type': 'application/json',
		accept: '*/*',
		authorization: `Bearer ${ANONYMOUS_KEY}`,
		'user-agent': opencodeUserAgent(client),
		...traceHeaders(),
		'x-opencode-client': name,
		'x-opencode-project': ids.project,
		'x-opencode-session': ids.session,
		'x-opencode-session-id': ids.session,
		'x-session-affinity': ids.session,
		'X-Session-Id': ids.session,
	};
}

/**
 * OpenCode 的 `<env>` 上下文块（见 `instructions/builtins.ts`）。
 * 上游免费门禁会检查系统提示词里有没有这块带 `Working directory` 的环境信息。
 *
 * @param {{directory?: string, root?: string, gitRepo?: boolean, platform?: string, tmp?: string}} [input]
 */
export function environmentBlock(input = {}) {
	const directory = typeof input.directory === 'string' && input.directory.length > 0 ? input.directory : process.cwd();
	const root = typeof input.root === 'string' && input.root.length > 0 ? input.root : directory;
	const platform = typeof input.platform === 'string' && input.platform.length > 0 ? input.platform : process.platform;
	const tmp = typeof input.tmp === 'string' && input.tmp.length > 0 ? input.tmp : process.env.TMPDIR || '/tmp';
	return [
		'<env>',
		`  Working directory: ${directory}`,
		`  Workspace root folder: ${root}`,
		`  Is directory a git repo: ${input.gitRepo === true ? 'yes' : 'no'}`,
		`  Platform: ${platform}`,
		`  Prefer ${tmp.replace(/\/$/, '')} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
		'</env>',
	].join('\n');
}

/**
 * 追加到系统提示词末尾的环境说明（opencode 把 date 与 env 作为两条 instruction 渲染）。
 * @param {object} [input] - 见 {@link environmentBlock}。
 * @param {Date} [now] - 注入当前时间，便于测试。
 */
export function environmentInstructions(input = {}, now = new Date()) {
	return [`Today's date: ${now.toDateString()}`, 'Here is some useful information about the environment you are running in:', environmentBlock(input)].join('\n');
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
