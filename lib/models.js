/**
 * 模型元数据：展示名、容量，以及「哪些 id 属于免费候选」的判定。
 *
 * 上游不公布免费模型的上下文窗口，这里给保守默认值；需要精确值时用配置里的
 * `modelOverrides` 覆盖。
 *
 * @module opencode2dsh/models
 */

/** 免费候选的 id 后缀。 */
export const FREE_SUFFIX = '-free';
/** 目录拉取彻底失败时的兜底名单（曾实测可用）。 */
export const VERIFIED_FALLBACK_IDS = ['big-pickle', 'deepseek-v4.1-flash-free', 'longcat-2.5-preview-free', 'space-bunny-free'];
/** 保守默认：宁可早压缩，也不要撞上游的真实上限。 */
export const DEFAULT_CONTEXT_WINDOW = 131072;
export const DEFAULT_MAX_TOKENS = 16384;

/** 展示名与容量的已知条目；未列出的模型走自动推导。 */
export const MODEL_META = {
	'big-pickle': { name: 'Big Pickle', contextWindow: 131072 },
	'deepseek-v4.1-flash-free': { name: 'DeepSeek V4.1 Flash', contextWindow: 131072 },
	'longcat-2.5-preview-free': { name: 'LongCat 2.5 Preview', contextWindow: 131072 },
	'space-bunny-free': { name: 'Space Bunny', contextWindow: 131072 },
	'glm-5.3-flash-free': { name: 'GLM 5.3 Flash', contextWindow: 131072 },
	'll-alpha-free': { name: 'LL Alpha', contextWindow: 131072 },
	'mimo-v2.6-flash-free': { name: 'MiMo V2.6 Flash', contextWindow: 131072 },
	'nemotron-3.5-lightning-free': { name: 'Nemotron 3.5 Lightning', contextWindow: 131072 },
	'nemotron-3.5-super-vl-free': { name: 'Nemotron 3.5 Super VL', contextWindow: 131072 },
	'cat-jam-free': { name: 'Cat Jam', contextWindow: 131072 },
};

/** 从 id 推导展示名。 */
export function prettyName(id) {
	const base = id.endsWith(FREE_SUFFIX) ? id.slice(0, -FREE_SUFFIX.length) : id;
	const words = base
		.split(/[-_]/)
		.filter((word) => word.length > 0)
		.map((word) => (/^[a-z]/.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : word));
	return words.join(' ') || id;
}

/**
 * 一个 id 的展示名与容量。
 * @param {string} id - 上游模型 id。
 * @param {Record<string, {name?: string, contextWindow?: number, maxTokens?: number}>} [overrides] - 配置里的覆盖项，优先于内置表。
 */
export function metaFor(id, overrides = {}) {
	const override = overrides && typeof overrides === 'object' ? overrides[id] : undefined;
	const meta = MODEL_META[id];
	const contextWindow = pickNumber(override?.contextWindow, pickNumber(meta?.contextWindow, DEFAULT_CONTEXT_WINDOW));
	const maxTokens = pickNumber(override?.maxTokens, pickNumber(meta?.maxTokens, DEFAULT_MAX_TOKENS));
	const name = typeof override?.name === 'string' && override.name.length > 0 ? override.name : typeof meta?.name === 'string' && meta.name.length > 0 ? meta.name : prettyName(id);
	return { name, contextWindow, maxTokens };
}

function pickNumber(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 免费候选判定：`-free` 后缀，或已在兜底名单里。
 * `test` 是上游的占位模型，永远排除。
 */
export function isFreeCandidate(id) {
	if (typeof id !== 'string' || id.length === 0) return false;
	if (id === 'test') return false;
	return id.endsWith(FREE_SUFFIX) || VERIFIED_FALLBACK_IDS.includes(id);
}
