/**
 * 免费模型目录：上游实时列表 ∩ 免费判定，再做一次真实可用性探测。
 *
 * 匿名通道按出口 IP 限制地区，很多 `-free` 模型会直接 403 RegionError。
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
import { ZEN_BASE_URL, deriveRequestIDs, disguiseHeaders, gateTool, GATE_TOOL_NAMES } from './protocol.js';
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

function probeBody(model) {
	return {
		model,
		stream: true,
		max_tokens: 1,
		tools: GATE_TOOL_NAMES.map(gateTool),
		tool_choice: 'none',
		messages: [{ role: 'user', content: 'ping' }],
	};
}

/**
 * 探测一个模型是否真的可用。
 * @returns {Promise<'ok'|'rejected'|'unknown'>} `ok` 含 429（被限流但已放行）。
 */
export async function probeModel(model, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
	const ids = deriveRequestIDs([{ role: 'user', content: `probe:${model}` }]);
	try {
		const response = await fetchImpl(`${ZEN_BASE_URL}/chat/completions`, {
			method: 'POST',
			headers: disguiseHeaders(ids),
			body: JSON.stringify(probeBody(model)),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (response.status === 200 || response.status === 429) {
			try {
				await response.body?.cancel();
			} catch {
				/* 忽略取消失败 */
			}
			return 'ok';
		}
		let text = '';
		try {
			text = (await response.text()).slice(0, 200);
		} catch {
			text = '';
		}
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
	const response = await fetchImpl(`${ZEN_BASE_URL}/models`, { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`模型列表请求失败：HTTP ${response.status}`);
	const payload = await response.json();
	const data = Array.isArray(payload?.data) ? payload.data : [];
	return data.map((entry) => entry?.id).filter(isFreeCandidate);
}

/** 按 `-free` 候选顺序探测，保留通过的；兜底名单排前面。 */
async function selectUsable(candidates, options) {
	const usable = [];
	const queue = [...candidates];
	const workers = Array.from({ length: PROBE_CONCURRENCY }, async () => {
		for (;;) {
			const model = queue.shift();
			if (model === undefined) return;
			let state = await probeModel(model, options);
			if (state === 'unknown') state = await probeModel(model, options);
			if (state === 'ok') usable.push(model);
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
 * @param {typeof fetch} [options.fetchImpl] - 便于测试替换。
 */
export function createCatalog({ logger, refreshSeconds, startDelayMs, exposeAll = false, onChange, cachePath = join(dataDir(), CACHE_FILE), fetchImpl = fetch }) {
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
			writeFileSync(cachePath, JSON.stringify({ version: CACHE_VERSION, at: Date.now(), ids, lastError }, null, 2), 'utf8');
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
				const usable = await selectUsable(candidates, { fetchImpl });
				if (usable.length === 0) throw new Error('所有免费模型探测均失败');
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
