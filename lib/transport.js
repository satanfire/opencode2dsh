/**
 * HTTP 传输层：默认交给 Bun 子进程，必要时退回 Node 的 fetch。
 *
 * 上游匿名免费通道按客户端传输指纹放行：Bun 能过，Node 的 undici / 原生 http2 / curl
 * 都会被回 429。所以默认走 `bun-fetch.js`，Node 侧只负责把响应包装成 `Response`，
 * 后续的 SSE 解析与失败映射都不用变。
 *
 * @module opencode2dsh/transport
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'bun-fetch.js');

/** 常见安装位置，`bun` 不在 PATH 时也能找到。 */
const BUN_CANDIDATES = [process.env.OPENCODE2DSH_BUN, 'bun', '/usr/local/bin/bun', '/opt/homebrew/bin/bun', join(process.env.HOME ?? '', '.bun/bin/bun')].filter(
	(candidate) => typeof candidate === 'string' && candidate.length > 0,
);

/**
 * 找一个可用的 Bun 可执行文件。
 * @param {string[]} [candidates] - 覆盖候选列表（配置里的 `bunPath` 放在最前）。
 * @returns {{command: string, version: string} | undefined}
 */
export function resolveBun(candidates = BUN_CANDIDATES) {
	for (const command of candidates) {
		if (command !== 'bun' && !existsSync(command)) continue;
		const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 });
		if (result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim().length > 0) {
			return { command, version: result.stdout.trim() };
		}
	}
	return undefined;
}

/** 把子进程 stdout 拆成「元信息行 + body 字节流」。 */
async function readFramedStdout(stream, stderr) {
	const reader = stream[Symbol.asyncIterator]();
	let buffer = Buffer.alloc(0);
	let meta;
	while (!meta) {
		const { value, done } = await reader.next();
		if (done) {
			const detail = stderr.text().trim();
			throw new Error(detail.length > 0 ? detail : 'bun 传输进程没有返回响应头');
		}
		buffer = Buffer.concat([buffer, Buffer.isBuffer(value) ? value : Buffer.from(value)]);
		const cut = buffer.indexOf(0x0a);
		if (cut < 0) continue;
		const line = buffer.subarray(0, cut).toString('utf8');
		buffer = buffer.subarray(cut + 1);
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`bun 传输进程返回了非法元信息：${line.slice(0, 200)}`);
		}
		if (!parsed || typeof parsed.__meta !== 'object' || parsed.__meta === null) throw new Error('bun 传输进程缺少元信息');
		meta = parsed.__meta;
	}
	if (meta.error) throw new Error(meta.error);
	const rest = new ReadableStream({
		start(controller) {
			if (buffer.length > 0) controller.enqueue(new Uint8Array(buffer));
			(async () => {
				try {
					for (;;) {
						const { value, done } = await reader.next();
						if (done) break;
						controller.enqueue(new Uint8Array(Buffer.isBuffer(value) ? value : Buffer.from(value)));
					}
					controller.close();
				} catch (error) {
					controller.error(error);
				}
			})();
		},
	});
	return { meta, rest };
}

/**
 * Bun 传输：把一次请求交给子进程，返回与 `fetch` 同形的 `Response`。
 * @param {{bunPath?: string, timeoutMs?: number, logger?: object}} options
 */
export function createBunTransport({ bunPath, timeoutMs = 300000, logger } = {}) {
	let resolved;
	return {
		kind: 'bun',
		async stream({ url, headers, body, signal }) {
			if (!resolved) {
				const candidates = typeof bunPath === 'string' && bunPath.length > 0 ? [bunPath, ...BUN_CANDIDATES] : BUN_CANDIDATES;
				resolved = resolveBun(candidates);
			}
			if (!resolved) throw new Error('找不到 Bun 可执行文件；免费通道要求 Bun 传输，请安装 bun 或配置 bunPath');
			const child = spawn(resolved.command, [HELPER], { stdio: ['pipe', 'pipe', 'pipe'] });
			const stderrChunks = [];
			const stderr = {
				text: () => Buffer.concat(stderrChunks).toString('utf8'),
			};
			child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			const aborted = () => {
				child.kill('SIGKILL');
			};
			if (signal) {
				if (signal.aborted) aborted();
				else signal.addEventListener('abort', aborted, { once: true });
			}
			const timer = setTimeout(aborted, timeoutMs);
			if (typeof timer.unref === 'function') timer.unref();
			const exited = new Promise((resolve) => child.on('close', resolve));
			child.stdin.on('error', () => {});
			child.stdin.end(`${JSON.stringify({ url, headers, body, timeoutMs })}\n`);
			try {
				const { meta, rest } = await readFramedStdout(child.stdout, stderr);
				const response = new Response(rest, { status: meta.status, headers: meta.headers ?? {} });
				if (signal) signal.addEventListener('abort', () => response.body?.cancel?.().catch?.(() => {}), { once: true });
				logger?.debug?.(`opencode2dsh: bun 传输 HTTP ${response.status}（bun ${resolved.version}）`);
				return response;
			} catch (error) {
				if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { name: 'AbortError' });
				throw error;
			} finally {
				clearTimeout(timer);
				if (signal) signal.removeEventListener('abort', aborted);
				exited.then(() => {}, () => {});
			}
		},
	};
}

/** 直接使用 Node 的 fetch（上游免费门禁大概率拒绝，仅作兜底与离线测试）。 */
export function createFetchTransport({ fetchImpl = fetch } = {}) {
	return {
		kind: 'fetch',
		stream(options) {
			return fetchImpl(options.url, { method: 'POST', headers: options.headers, body: options.body, signal: options.signal });
		},
	};
}

/**
 * 按配置建传输层。
 * `auto`：能找到 Bun 就用 Bun，否则退回 fetch。
 * @param {{transport?: 'auto'|'bun'|'fetch', bunPath?: string, timeoutMs?: number, fetchImpl?: typeof fetch, logger?: object}} [options]
 */
export function createTransport({ transport = 'auto', bunPath, timeoutMs, fetchImpl, logger } = {}) {
	if (transport === 'fetch') return createFetchTransport({ fetchImpl });
	if (transport === 'bun') return createBunTransport({ bunPath, timeoutMs, logger });
	const resolved = resolveBun(typeof bunPath === 'string' && bunPath.length > 0 ? [bunPath, ...BUN_CANDIDATES] : BUN_CANDIDATES);
	if (resolved) {
		logger?.info?.(`opencode2dsh: 使用 Bun 传输（${resolved.command}，${resolved.version}）`);
		return createBunTransport({ bunPath: resolved.command, timeoutMs, logger });
	}
	logger?.warn?.('opencode2dsh: 未找到 Bun，退回 Node fetch；上游免费通道会拒绝这种传输指纹');
	return createFetchTransport({ fetchImpl });
}
