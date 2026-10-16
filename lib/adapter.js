/**
 * DSH 的 LlmAdapter 实现：把一次模型调用打到 OpenCode Zen 的匿名免费通道。
 *
 * 注意：DSH 的 `LlmAdapter` 是抽象类，但注册路径只做鸭子类型检查，因此本插件
 * 用普通类实现同一组方法，从而保持零依赖（不 import `@deepseek-ai/dsh-llm`）。
 * 方法集合必须完整：`providerRetryPolicy` / `imageRequestPricing` 缺一个，
 * `registerAdapter` 就会在注册期抛 TypeError。
 *
 * @module opencode2dsh/adapter
 */

import { ZEN_BASE_URL, buildWireTools, deriveRequestIDs, disguiseHeaders } from './protocol.js';
import { toWireMessages } from './messages.js';
import { llmError, upstreamError } from './errors.js';
import { readSseBody, translate } from './stream.js';
import { metaFor } from './models.js';

/** 展示名，出现在 DSH 的模型选择器分组标题上。 */
const DISPLAY_NAME = 'OpenCode Zen 免费';

export class ZenAdapter {
	/**
	 * @param {object} options
	 * @param {string} options.providerId - 注册的 provider 路由名。
	 * @param {{ids: () => string[]}} options.catalog - 可用模型目录。
	 * @param {object} [options.logger] - Cordis logger。
	 * @param {number} options.requestTimeoutMs - 单次请求总超时。
	 * @param {Record<string, object>} [options.modelOverrides] - 模型容量覆盖。
	 */
	constructor({ providerId, catalog, logger, requestTimeoutMs, modelOverrides = {} }) {
		this.providerId = providerId;
		this.catalog = catalog;
		this.logger = logger;
		this.requestTimeoutMs = requestTimeoutMs;
		this.modelOverrides = modelOverrides;
	}

	providerInfo(provider) {
		return { id: provider, name: DISPLAY_NAME };
	}

	/**
	 * 匿名通道按 IP 共享配额，429 突发很常见。
	 * 放宽到 8 次、1s→20s 退避，让 DSH 的 llm-retry 静默扛过突发，
	 * 而不是把限流直接抛给用户。
	 */
	providerRetryPolicy() {
		return Object.freeze({
			mode: 'normal',
			maxRetries: 8,
			retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
			initialDelayMs: 1000,
			maxDelayMs: 20000,
			jitterRatio: 0.15,
		});
	}

	/** 只声明文本输入，没有请求图片计价。 */
	imageRequestPricing() {
		return undefined;
	}

	listModels(provider) {
		return Promise.resolve(this.catalog.ids().map((id) => this.#info(provider, id)));
	}

	resolveModel(provider, model) {
		const meta = metaFor(model, this.modelOverrides);
		return Promise.resolve({
			...this.#info(provider, model),
			context: { contextWindow: meta.contextWindow },
			defaultMaxTokens: meta.maxTokens,
			inputModalities: ['text'],
		});
	}

	prepareCall(provider, model, signal) {
		return this.resolveModel(provider, model, signal).then((resolved) => ({
			model: resolved,
			stream: (options) => this.stream(options),
		}));
	}

	#info(provider, id) {
		return {
			provider,
			id,
			name: metaFor(id, this.modelOverrides).name,
			description: 'OpenCode Zen 匿名免费通道',
			inputModalities: ['text'],
		};
	}

	async *stream(options = {}) {
		const model = typeof options.model === 'string' && options.model.length > 0 ? options.model : 'big-pickle';
		const ids = deriveRequestIDs(options.messages);
		const { tools, toolChoice } = buildWireTools(options.tools);

		const body = {
			model,
			messages: toWireMessages(options),
			stream: true,
			stream_options: { include_usage: true },
			tools,
		};
		if (toolChoice !== undefined) body.tool_choice = toolChoice;

		const meta = metaFor(model, this.modelOverrides);
		const maxTokens = typeof options.maxTokens === 'number' && options.maxTokens > 0 ? options.maxTokens : meta.maxTokens;
		if (maxTokens > 0) body.max_tokens = maxTokens;
		if (typeof options.temperature === 'number') body.temperature = options.temperature;
		if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop;
		if (typeof options.reasoningEffort === 'string' && options.reasoningEffort.length > 0) body.reasoning_effort = options.reasoningEffort;

		const timeout = AbortSignal.timeout(this.requestTimeoutMs);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

		let response;
		try {
			response = await fetch(`${ZEN_BASE_URL}/chat/completions`, {
				method: 'POST',
				headers: disguiseHeaders(ids),
				body: JSON.stringify(body),
				signal,
			});
		} catch (error) {
			if (options.signal?.aborted) throw llmError('请求已取消', 'ABORTED');
			const detail = error instanceof Error ? error.message : String(error);
			if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
				throw llmError(`OpenCode Zen 请求超时（${model}）：${detail}`, 'TIMEOUT');
			}
			throw llmError(`无法连接 OpenCode Zen（${model}）：${detail}`, 'TRANSPORT');
		}

		if (!response.ok) throw await upstreamError(response, model);
		yield* translate(readSseBody(response), model);
	}
}
