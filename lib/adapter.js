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

import { INFERENCE_BASE_URL, buildWireTools, deriveRequestIDs, disguiseHeaders, environmentInstructions } from './protocol.js';
import { toWireMessages, withEnvironment } from './messages.js';
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
	 * @param {{stream: (options: object) => Promise<Response>}} [options.transport] - HTTP 传输层（默认 Bun）。
	 * @param {{baseUrl?: string, client?: object, environment?: object}} [options.wire] - 请求形状覆盖。
	 */
	constructor({ providerId, catalog, logger, requestTimeoutMs, modelOverrides = {}, transport, wire = {} }) {
		this.providerId = providerId;
		this.catalog = catalog;
		this.logger = logger;
		this.requestTimeoutMs = requestTimeoutMs;
		this.modelOverrides = modelOverrides;
		this.transport = transport;
		this.baseUrl = typeof wire.baseUrl === 'string' && wire.baseUrl.length > 0 ? wire.baseUrl : INFERENCE_BASE_URL;
		this.client = wire.client && typeof wire.client === 'object' ? wire.client : {};
		this.environment = wire.environment && typeof wire.environment === 'object' ? wire.environment : {};
	}

	providerInfo(provider) {
		return { id: provider, name: DISPLAY_NAME };
	}

	/**
	 * 匿名通道按客户端形状放行，被拒时上游给的是 429 + 长 Retry-After。
	 * 放宽到 8 次、1s→20s 退避，让 DSH 的 llm-retry 静默扛过突发。
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
		const ids = deriveRequestIDs(options.messages, { projectSeed: this.environment.projectSeed });
		const { tools, toolChoice } = buildWireTools(options.tools);
		const messages = withEnvironment(toWireMessages(options), environmentInstructions(this.environment));

		const body = {
			model,
			messages,
			stream: true,
			stream_options: { include_usage: true },
			tools,
		};
		if (toolChoice !== undefined) body.tool_choice = toolChoice;

		const meta = metaFor(model, this.modelOverrides);
		const maxTokens = typeof options.maxTokens === 'number' && options.maxTokens > 0 ? options.maxTokens : meta.maxTokens;
		if (maxTokens > 0) body.max_completion_tokens = maxTokens;
		if (typeof options.temperature === 'number') body.temperature = options.temperature;
		if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop;
		if (typeof options.reasoningEffort === 'string' && options.reasoningEffort.length > 0) body.reasoning_effort = options.reasoningEffort;

		const timeout = AbortSignal.timeout(this.requestTimeoutMs);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

		let response;
		try {
			if (!this.transport || typeof this.transport.stream !== 'function') throw new Error('传输层未就绪');
			response = await this.transport.stream({
				url: `${this.baseUrl}/chat/completions`,
				headers: disguiseHeaders(ids, this.client),
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
