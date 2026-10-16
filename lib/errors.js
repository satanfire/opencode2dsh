/**
 * 失败映射：把上游 HTTP / 传输失败翻成 DSH 能路由的失败码。
 *
 * DSH 只信任自家 `HarnessError` 的 `code`（见 `normalizeLlmFailure`），但本插件
 * 零依赖、不能 import `@deepseek-ai/dsh-llm`。同时挂上自有的 `code` 与 `failure`
 * 数据属性即可被完整采纳：`normalizeLlmFailure` 优先采用与 `code` 一致的
 * `failure` 快照，因此 `status` / `providerRetryAfterMs` 也能带给重试层。
 *
 * @module opencode2dsh/errors
 */

/**
 * 造一个带 `code` 与 `failure` 的 Error。
 * @param {string} message - 非空的人类可读说明。
 * @param {string} code - 稳定的机器可路由码。
 * @param {{status?: number, providerRetryAfterMs?: number}} [extra] - 可选的上游事实。
 */
export function llmError(message, code, extra = {}) {
	const text = typeof message === 'string' && message.length > 0 ? message : 'opencode2dsh request failed';
	const failure = { message: text, code };
	if (Number.isInteger(extra.status) && extra.status >= 100 && extra.status <= 599) failure.status = extra.status;
	if (Number.isFinite(extra.providerRetryAfterMs) && extra.providerRetryAfterMs > 0) failure.providerRetryAfterMs = extra.providerRetryAfterMs;
	const error = new Error(text);
	Object.defineProperty(error, 'code', { value: code, enumerable: true, configurable: true });
	Object.defineProperty(error, 'failure', { value: failure, enumerable: true, configurable: true });
	return error;
}

/** 解析 Retry-After：秒数或 HTTP 日期都接受。 */
export function retryAfterMs(response) {
	let header;
	try {
		header = response.headers.get('retry-after');
	} catch {
		return undefined;
	}
	if (!header) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
	const at = Date.parse(header);
	if (Number.isFinite(at)) {
		const delta = at - Date.now();
		if (delta > 0) return delta;
	}
	return undefined;
}

/** 读出上游错误体里的 `error.type` 与 `error.message`。 */
async function readErrorBody(response) {
	let text = '';
	try {
		text = await response.text();
	} catch {
		text = '';
	}
	let type = '';
	let message = text.slice(0, 400).replace(/\s+/g, ' ').trim();
	try {
		const parsed = JSON.parse(text);
		const error = parsed && typeof parsed === 'object' ? parsed.error : undefined;
		if (error && typeof error === 'object') {
			if (typeof error.type === 'string') type = error.type;
			if (typeof error.message === 'string' && error.message.length > 0) message = error.message;
		}
	} catch {
		/* 非 JSON 错误体，保留原文 */
	}
	return { type, message };
}

/**
 * 把一次非 2xx 响应翻成 DSH 失败码。
 * `RATE_LIMIT` / `SERVER` 可被 DSH 的 llm-retry 重试；`AUTH` / `MODEL_UNAVAILABLE`
 * 是确定性拒绝，直接呈现给用户。
 */
export async function upstreamError(response, model) {
	const { type, message } = await readErrorBody(response);
	const status = response.status;
	const detail = message.length > 0 ? message : `HTTP ${status}`;
	if (status === 429) {
		return llmError(`OpenCode Zen 限流（${model}）：${detail}`, 'RATE_LIMIT', { status, providerRetryAfterMs: retryAfterMs(response) });
	}
	if (type === 'RegionError') return llmError(`模型 ${model} 在当前网络地区不可用：${detail}`, 'MODEL_UNAVAILABLE', { status });
	if (status === 401 || status === 403) return llmError(`OpenCode 免费通道拒绝该请求（${model}）：${detail}`, 'AUTH', { status });
	if (status >= 500) return llmError(`OpenCode Zen 服务端错误（${model}）：${detail}`, 'SERVER', { status });
	if (status === 400 && /context|too long|maximum|token/i.test(detail)) return llmError(`请求超过模型容量（${model}）：${detail}`, 'CONTEXT_WINDOW_EXCEEDED', { status });
	return llmError(`OpenCode Zen 请求失败（${model}，HTTP ${status}）：${detail}`, 'SERVER', { status });
}
