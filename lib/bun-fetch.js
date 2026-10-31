/**
 * 由 Bun 运行的 HTTP 转发器：stdin 收一条 JSON 请求，stdout 先写一行元信息，再写响应原始字节。
 *
 * 为什么需要它：上游的匿名免费通道只放行 OpenCode 本体（Bun/BoringSSL + HTTP/2）的
 * 传输指纹，Node 的 undici、curl、Node 的 http2 都会被回 `429 FreeUsageLimitError`。
 * 因此 HTTP 这一步交给 Bun，Node 只负责解析流。
 *
 * @module opencode2dsh/bun-fetch
 */

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	input += chunk;
});

function write(value) {
	return new Promise((resolve) => {
		if (process.stdout.write(value)) resolve();
		else process.stdout.once('drain', resolve);
	});
}

process.stdin.on('end', async () => {
	try {
		const config = JSON.parse(input);
		const signal = typeof config.timeoutMs === 'number' && config.timeoutMs > 0 ? AbortSignal.timeout(config.timeoutMs) : undefined;
		const response = await fetch(config.url, {
			method: 'POST',
			headers: config.headers,
			body: config.body,
			signal,
		});
		const headers = {};
		for (const [key, value] of response.headers) headers[key] = value;
		await write(`${JSON.stringify({ __meta: { status: response.status, headers } })}\n`);
		if (response.body) {
			for await (const chunk of response.body) await write(chunk);
		} else {
			await write(await response.text());
		}
	} catch (error) {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		await write(`${JSON.stringify({ __meta: { status: 0, headers: {}, error: message } })}\n`);
		process.exitCode = 1;
	}
});
