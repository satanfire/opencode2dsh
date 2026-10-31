/**
 * 免费模型目录：上游实时列表 ∩ 免费判定，再做一次真实可用性探测。
 *
 * 匿名通道按客户端形状放行，形状不对时上游回 `429 FreeUsageLimitError`（不是额度用尽）。
 * 探测请求必须和真实调用同形：Bun 传输 + 会话头 + 带 `<env>` 的系统提示词 + 工具表。
 * 只把探测通过的模型交给选择器，用户就不会选中一个必然失败的模型。
 *
 * 结果落盘在 `$DSH_HOME/opencode2dsh/catalog.json`：既是离线兜底，
 * 也记录最后一次刷新错误，便于排查。
 *
 * @module opencode2dsh/catalog
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { INFERENCE_BASE_URL, MODELS_URL, deriveRequestIDs, disguiseHeaders, environmentInstructions, gateTool, GATE_TOOL_NAMES } from './protocol.js';
import { VERIFIED_FALLBACK_IDS, isFreeCandidate } from './models.js';

const CACHE_FILE = 'catalog.json';
const CACHE_VERSION = 1;
const PROBE_CONCURRENCY = 2;
const PROBE_TIMEOUT_MS = 45000;
const DISCOVER_TIMEOUT_MS = 30000;
/** 刷新失败后的短周期重试：出网尚未就绪时不必等满一个周期。 */
const RETRY_DELAY_MS = 60000;

/** 目录状态落盘目录。 */
export function dataDir() {
	const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh');
	return join(home, 'opencode2dsh');
}

function probeBody(model, environment) {
	return {
		model,
		stream: true,
		max_completion_tokens: 1,
		tools: GATE_TOOL_NAMES.map(gateTool),
		tool_choice: 'none',
		messages: [
			{ role: 'system', content: environmentInstructions(environment) },
			{ role: 'user', content: 'ping' },
		],
	};
}

/** 读一小段响应体用于判定失败原因。 */
async function readErrorText(response, limit = 200) {
	try {
		const text = await response.text();
		return text.slice(0, limit);
	} catch {
		return '';
	}
}

/**
 * 探测一个模型是否真的可用。
 *
 * `429 FreeUsageLimitError` 是**门禁拒绝**（客户端形状不对），不是"限流但放行"，
 * 必须当成不可用，否则选择器里会一直挂着必然失败的模型。
 *
 * @returns {Promise<'ok'|'rejected'|'unknown'>}
 */
export async function probeModel(model, { transport, baseUrl = INFERENCE_BASE_URL, environment = {}, timeoutMs = PROBE_TIMEOUT_MS, fetchImpl } = {}) {
	const ids = deriveRequestIDs([{ role: 'user', content: `probe:${model}` }], { projectSeed: environment.projectSeed });
	const url = `${baseUrl}/chat/completions`;
	const headers = disguiseHeaders(ids);
	const body = JSON.stringify(probeBody(model, environment));
	try {
		const response = transport
			? await transport.stream({ url, headers, body, signal: AbortSignal.timeout(timeoutMs) })
			: await (fetchImpl ?? fetch)(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
		if (response.status === 200) {
			try {
				await response.body?.cancel();
			} catch {
				/* 忽略取消失败 */
			}
			return 'ok';
		}
		const text = await readErrorText(response);
		if (response.status === 429) return 'rejected';
		if (text.includes('not available in your country')) return 'rejected';
		if (/ModelProtocolUnsupported|Unsupported|not supported/i.test(text)) return 'rejected';
		if (response.status === 403 || response.status === 400) return 'rejected';
		return 'unknown';
	} catch {
		return 'unknown';
	}
}

/** 拉取上游模型列表，过滤出免费候选。 */
export async function discoverFreeModels({ fetchImpl = fetch, timeoutMs = DISCOVER_TIMEOUT_MS } = {}) {
	const response = await fetchImpl(MODELS_URL, { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`模型列表请求失败：HTTP ${response.status}`);
	const payload = await response.json();
	const data = Array.isArray(payload?.data) ? payload.data : [];
	return data.map((entry) => entry?.id).filter(isFreeCandidate);
}

/**
 * 按 `-free` 候选顺序探测，保留可用的；兜底名单排前面。
 *
 * 只有确定性拒绝（门禁拒绝、地区封锁、协议不支持）才剔除。探测遇到网络错误时两次都拿不到
 * 结论，此时保留「上一轮已知可用」的模型：网络抖动不该让可用模型从选择器里消失，
 * 否则用户正在用的默认模型会突然无法提交。
 *
 * @param {string[]} candidates - 免费候选模型 id。
 * @param {Set<string>} knownUsable - 上一轮可用的模型 id。
 * @param {object} options - 传给 {@link probeModel} 的选项。
 */
async function selectUsable(candidates, knownUsable, options) {
	const usable = [];
	const queue = [...candidates];
	const workers = Array.from({ length: PROBE_CONCURRENCY }, async () => {
		for (;;) {
			const model = queue.shift();
			if (model === undefined) return;
			let state = await probeModel(model, options);
			if (state === 'unknown') state = await probeModel(model, options);
			if (state === 'ok' || (state === 'unknown' && knownUsable.has(model))) usable.push(model);
		}
	});
	await Promise.all(workers);
	usable.sort((left, right) => {
		const leftKnown = VERIFIED_FALLBACK_IDS.includes(left) ? 0 : 1;
		const rightKnown = VERIFIED_FALLBACK_IDS.includes(right) ? 0 : 1;
		return leftKnown - rightKnown || left.localeCompare(right);
	});
	return usable;
}

/**
 * 建一个会自我刷新的目录。
 *
 * @param {object} options
 * @param {object} [options.logger] - Cordis logger；缺失时静默。
 * @param {number} options.refreshSeconds - 刷新周期。
 * @param {number} options.startDelayMs - 首轮刷新的延后，避免与启动期请求抢连接。
 * @param {boolean} [options.exposeAll] - true 时跳过探测，暴露全部免费候选。
 * @param {() => void} [options.onChange] - 可用模型集合变化时回调（用于通知 DSH 刷新选择器）。
 * @param {string} [options.cachePath] - 状态文件路径。
 * @param {object} [options.transport] - 探测用的 HTTP 传输层（与真实调用同形）。
 * @param {string} [options.baseUrl] - 推理入口。
 * @param {object} [options.environment] - `<env>` 上下文。
 * @param {typeof fetch} [options.fetchImpl] - 便于测试替换（列表与探测共用）。
 */
export function createCatalog({
	logger,
	refreshSeconds,
	startDelayMs,
	exposeAll = false,
	onChange,
	cachePath = join(dataDir(), CACHE_FILE),
	transport,
	baseUrl,
	environment = {},
	fetchImpl = fetch,
	transportKind = 'fetch',
}) {
	let ids = [...VERIFIED_FALLBACK_IDS];
	let lastError = '';
	let timer = null;
	let stopped = false;
	let running = false;
	loadCache();
	saveCache();

	function loadCache() {
		let raw;
		try {
			raw = JSON.parse(readFileSync(cachePath, 'utf8'));
		} catch {
			return; // 首次运行没有缓存
		}
		if (!raw || raw.version !== CACHE_VERSION) return;
		if (Array.isArray(raw.ids) && raw.ids.length > 0) ids = raw.ids.filter((id) => typeof id === 'string' && id.length > 0);
		if (typeof raw.lastError === 'string') lastError = raw.lastError;
	}

	function saveCache() {
		try {
			mkdirSync(dirname(cachePath), { recursive: true });
			writeFileSync(cachePath, JSON.stringify({ version: CACHE_VERSION, at: Date.now(), ids, lastError, transport: transportKind }, null, 2), 'utf8');
		} catch {
			/* 落盘失败不影响运行 */
		}
	}

	async function refresh() {
		if (running || stopped) return false;
		running = true;
		const before = ids.join(',');
		try {
			const candidates = await discoverFreeModels({ fetchImpl });
			if (candidates.length === 0) throw new Error('上游返回了空的免费模型列表');
			if (exposeAll) {
				ids = candidates;
			} else {
				const usable = await selectUsable(candidates, new Set(ids), { transport, baseUrl, environment, fetchImpl });
				if (usable.length === 0) throw new Error('所有免费模型探测均失败（免费通道可能正在按客户端形状拒绝请求）');
				ids = usable;
			}
			lastError = '';
			saveCache();
			logger?.info?.(`opencode2dsh: 免费模型目录已更新，${ids.length} 个可用：${ids.join(', ')}`);
			if (ids.join(',') !== before) notify();
			return true;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			saveCache();
			logger?.warn?.(`opencode2dsh: 目录刷新失败，继续使用现有 ${ids.length} 个模型：${lastError}`);
			return false;
		} finally {
			running = false;
		}
	}

	function notify() {
		try {
			onChange?.();
		} catch (error) {
			logger?.warn?.(`opencode2dsh: 目录更新通知失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function schedule(delayMs) {
		if (stopped) return;
		timer = setTimeout(() => {
			refresh().then((ok) => schedule(ok ? refreshSeconds * 1000 : Math.min(RETRY_DELAY_MS, refreshSeconds * 1000)));
		}, delayMs);
		if (typeof timer.unref === 'function') timer.unref();
	}

	return {
		/** 当前可用模型 id 的快照。 */
		ids: () => [...ids],
		/** 最近一次刷新错误，空串表示正常。 */
		lastError: () => lastError,
		/** 立即刷新一次（测试与手动重试用）。 */
		refresh,
		start() {
			if (stopped) return;
			schedule(startDelayMs);
		},
		stop() {
			stopped = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		},
	};
}
