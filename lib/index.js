/**
 * opencode2dsh — 在 DSH（DeepSeek Harness）里使用 OpenCode Zen 的匿名免费模型。
 *
 * 插件入口：向 DSH 注册一个 provider 路由和一个原生 LlmAdapter。
 * 零运行时依赖，只用 node: 内置模块。
 *
 * @module opencode2dsh
 */

import { createCatalog } from './catalog.js';
import { ZenAdapter } from './adapter.js';

export const name = 'opencode2dsh';
export const inject = ['llm'];

const DEFAULT_PROVIDER_ID = 'opencode2dsh';
const DEFAULT_REFRESH_SECONDS = 900;
const DEFAULT_START_DELAY_MS = 3000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300000;

function resolveNumber(value, fallback, min, max) {
	return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function resolveOverrides(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 挂载插件。
 * @param {object} ctx - Cordis 上下文，需要 `llm` 服务。
 * @param {object} [config] - 见 README 的配置表。
 */
export function apply(ctx, config = {}) {
	const providerId = typeof config?.providerId === 'string' && config.providerId.length > 0 ? config.providerId : DEFAULT_PROVIDER_ID;
	const refreshSeconds = resolveNumber(config?.refreshSeconds, DEFAULT_REFRESH_SECONDS, 30, 86400);
	const startDelayMs = resolveNumber(config?.startDelayMs, DEFAULT_START_DELAY_MS, 0, 600000);
	const requestTimeoutMs = resolveNumber(config?.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1000, 3600000);
	const exposeAll = config?.exposeAll === true;
	const modelOverrides = resolveOverrides(config?.modelOverrides);
	const logger = ctx?.logger;

	if (!ctx?.llm || typeof ctx.llm.registerAdapter !== 'function') {
		logger?.error?.('opencode2dsh: llm 服务不可用，无法注册 adapter');
		return;
	}

	let handle;
	// 目录刷新后原子替换路由，让 DSH 重读模型列表而不重挂 fiber。
	const onChange = () => {
		try {
			if (handle && typeof handle.replace === 'function') handle.replace([providerId]);
			else ctx.emit?.('llm/adapters-updated');
		} catch (error) {
			logger?.warn?.(`opencode2dsh: 目录更新通知失败：${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const catalog = createCatalog({ logger, refreshSeconds, startDelayMs, exposeAll, onChange });
	const adapter = new ZenAdapter({ providerId, catalog, logger, requestTimeoutMs, modelOverrides });

	handle = ctx.llm.registerAdapter([providerId], adapter);
	logger?.info?.(`opencode2dsh: 已注册 provider "${providerId}"，先展示兜底名单，稍后替换为探测结果`);

	ctx.effect(() => () => {
		catalog.stop();
	});

	catalog.start();
}
