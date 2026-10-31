/**
 * opencode2dsh — 在 DSH（DeepSeek Harness）里使用 OpenCode Zen 的匿名免费模型。
 *
 * 插件入口：向 DSH 注册一个 provider 路由和一个原生 LlmAdapter。
 * 运行时只用 node: 内置模块；HTTP 传输交给 Bun 子进程（见 transport.js），
 * 因为上游免费通道只放行 OpenCode 本体的传输指纹。
 *
 * @module opencode2dsh
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createCatalog } from './catalog.js';
import { ZenAdapter } from './adapter.js';
import { createTransport } from './transport.js';

export const name = 'opencode2dsh';
export const inject = ['llm'];

const DEFAULT_PROVIDER_ID = 'opencode2dsh';
const DEFAULT_REFRESH_SECONDS = 1800;
const DEFAULT_START_DELAY_MS = 3000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300000;

function resolveNumber(value, fallback, min, max) {
	return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function resolveOverrides(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function resolveString(value, fallback) {
	return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * `<env>` 上下文块的数据来源：模拟 OpenCode 认为自己在哪个目录工作。
 * 默认取插件进程的工作目录；用 `workspaceDirectory` 覆盖。
 */
function resolveEnvironment(config = {}) {
	const directory = resolveString(config?.workspaceDirectory, process.cwd());
	const root = resolveString(config?.workspaceRoot, directory);
	const tmp = resolveString(config?.tmpDirectory, process.env.TMPDIR);
	return {
		directory,
		root,
		gitRepo: config?.gitRepo === true || (config?.gitRepo !== false && existsSync(join(directory, '.git'))),
		platform: process.platform,
		...(tmp ? { tmp } : {}),
		projectSeed: root,
	};
}

/**
 * 挂载插件。
 * @param {object} ctx - Cordis 上下文，需要 `llm` 服务。
 * @param {object} [config] - 见 README 的配置表。
 */
export function apply(ctx, config = {}) {
	const providerId = resolveString(config?.providerId, DEFAULT_PROVIDER_ID);
	const refreshSeconds = resolveNumber(config?.refreshSeconds, DEFAULT_REFRESH_SECONDS, 30, 86400);
	const startDelayMs = resolveNumber(config?.startDelayMs, DEFAULT_START_DELAY_MS, 0, 600000);
	const requestTimeoutMs = resolveNumber(config?.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1000, 3600000);
	const exposeAll = config?.exposeAll === true;
	const modelOverrides = resolveOverrides(config?.modelOverrides);
	const logger = ctx?.logger;
	const environment = resolveEnvironment(config);

	if (!ctx?.llm || typeof ctx.llm.registerAdapter !== 'function') {
		logger?.error?.('opencode2dsh: llm 服务不可用，无法注册 adapter');
		return;
	}

	const transport = createTransport({
		transport: config?.transport === 'bun' || config?.transport === 'fetch' ? config.transport : 'auto',
		bunPath: resolveString(config?.bunPath, undefined),
		timeoutMs: requestTimeoutMs,
		logger,
	});
	const wire = {
		baseUrl: resolveString(config?.baseUrl, undefined),
		client: {
			channel: resolveString(config?.channel, undefined),
			version: resolveString(config?.clientVersion, undefined),
			name: resolveString(config?.clientName, undefined),
		},
		environment,
	};

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

	const catalog = createCatalog({
		logger,
		refreshSeconds,
		startDelayMs,
		exposeAll,
		transport,
		baseUrl: wire.baseUrl,
		environment,
		onChange,
		transportKind: transport.kind,
	});
	const adapter = new ZenAdapter({ providerId, catalog, logger, requestTimeoutMs, modelOverrides, transport, wire });

	handle = ctx.llm.registerAdapter([providerId], adapter);
	logger?.info?.(`opencode2dsh: 已注册 provider "${providerId}"，先展示兜底名单，稍后替换为探测结果（传输：${transport.kind}）`);

	ctx.effect(() => () => {
		catalog.stop();
	});

	catalog.start();
}
