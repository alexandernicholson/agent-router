/** Per-request evidence only. A gateway's retention policy is not inferred from token counts. */
/** @typedef {{sessionId: string, agentId: string | null, turnId: string, index: number, model: string, startedAt: number, completedAt?: number, read: number, write: number, fresh: number, output: number, ttlMs: number | null, ttlSource: string, disabled: boolean, cacheCreation?: {fiveMinute: number, oneHour: number}}} CacheSample */
/** @typedef {{sessionId: string, agentId: string | null, resetAt: number}} CacheReset */
/** @typedef {{fiveMinute: number, oneHour: number}} CacheCreation */
/** @typedef {{sessionId: string, agentId: string | null, label: string, samples: CacheSample[], last?: CacheSample, touchedAt?: number, creation?: CacheCreation | null, keepalives: CacheSample[], totals: {requests: number, read: number, write: number, fresh: number, output: number}}} CacheRow */
/** @typedef {{ttl: '5m' | '1h', ttlMs: number, tokens: number, leftMs: number}} CacheLifetime */
/** @typedef {{state: string, ratio: number | null, leftMs: number | null, lifetimes: CacheLifetime[], ttl?: string}} CacheStatus */
/** @typedef {'good' | 'fair' | 'poor'} CacheGrade */

const on = value => value === '1' || value?.toLowerCase() === 'true';
export const loopKey = (sessionId, agentId) => JSON.stringify([sessionId, agentId ?? null]);
export const sampleKey = sample => JSON.stringify([sample.sessionId, sample.agentId, sample.turnId, sample.index]);

export function validSample(s) {
  return s && typeof s === 'object' && typeof s.sessionId === 'string' && s.sessionId.length > 0 &&
    (s.agentId === null || typeof s.agentId === 'string' && s.agentId.length > 0) &&
    typeof s.turnId === 'string' && s.turnId.length > 0 && typeof s.model === 'string' && s.model.length > 0 &&
    ['index', 'startedAt', 'read', 'write', 'fresh', 'output'].every(k => Number.isSafeInteger(s[k]) && s[k] >= 0) &&
    (s.ttlMs === null || s.ttlMs === 300000 || s.ttlMs === 3600000) &&
    typeof s.ttlSource === 'string' && typeof s.disabled === 'boolean' &&
    (s.completedAt === undefined || Number.isSafeInteger(s.completedAt) && s.completedAt >= s.startedAt) &&
    (s.cacheCreation === undefined || validCreation(s.cacheCreation, s.write));
}

export function validCreation(value, writes) {
  return value && ['fiveMinute', 'oneHour'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) &&
    value.fiveMinute + value.oneHour === writes && writes > 0;
}

/** Write buckets are response evidence, independent of endpoint or requested TTL. */
export function reportedCacheCreation(usage) {
  const value = usage?.cache_creation;
  if (!value || typeof value !== 'object') return undefined;
  const creation = { fiveMinute: value.ephemeral_5m_input_tokens, oneHour: value.ephemeral_1h_input_tokens };
  return validCreation(creation, usage.cache_creation_input_tokens) ? creation : undefined;
}

export function applyCacheCreation(sample, creation) {
  if (!validCreation(creation, sample.write)) return sample;
  return { ...sample, cacheCreation: { fiveMinute: creation.fiveMinute, oneHour: creation.oneHour },
    ttlMs: creation.fiveMinute && creation.oneHour ? null : creation.oneHour ? 3600000 : 300000,
    ttlSource: 'response cache_creation', disabled: false };
}

// Keepalives are requests Agent Router sends itself; they refresh a cache
// without being the conversation's own last request.
export const isKeepalive = sample => typeof sample?.turnId === 'string' && sample.turnId.startsWith('keepalive:');

// List prices as multiples of a model's base input price: cache reads are
// 0.1x except where a model prices them lower; output is 5x on current models.
const READ_PRICES = [[/fable-5-1|mythos-5-1/i, 0.025], [/opus-5-5/i, 0.05]];
export function cachePrices(model) {
  return { read: READ_PRICES.find(([pattern]) => pattern.test(model))?.[1] ?? 0.1, fiveMinute: 1.25, oneHour: 2, output: 5 };
}

/**
 * A keepalive is worth sending while the keepalives since the loop's last
 * request, this one included, cost less than the cache rewrite they prevent:
 * the cached prefix written again instead of read. Each keepalive's measured
 * tokens are priced; the next is assumed to cost what the last one did.
 * @param {CacheRow | undefined} row
 * @param {number} ttlMs the TTL whose write a lapse would repeat
 */
export function keepaliveWorthwhile(row, ttlMs) {
  const last = row?.last;
  const prefix = last ? last.read + last.write : 0;
  if (!last || !prefix) return false;
  const prices = cachePrices(last.model);
  const write = ttlMs === 3600000 ? prices.oneHour : prices.fiveMinute;
  const cost = s => s.read * prices.read + s.write * write + s.fresh + s.output * prices.output;
  const spent = row.keepalives.reduce((sum, s) => sum + cost(s), 0);
  const next = row.keepalives.length ? cost(row.keepalives.at(-1)) : prefix * prices.read;
  return spent + next <= prefix * (write - prices.read);
}

/** Local flags describe disabling; only response metadata can establish a TTL. */
export function cachePolicy(env = {}, model = '') {
  const family = /haiku/i.test(model) ? 'HAIKU' : /sonnet/i.test(model) ? 'SONNET' : /opus/i.test(model) ? 'OPUS' : '';
  const disabled = on(env.DISABLE_PROMPT_CACHING) || !!family && on(env[`DISABLE_PROMPT_CACHING_${family}`]);
  return { ttlMs: null, ttlSource: 'response TTL metadata absent', disabled };
}

/**
 * Dedupe identities and keep lifetime totals while bounding the visible request history.
 * Each request that reads or writes a loop's cache refreshes its entry, so the
 * countdown runs from the latest such request; its TTL is the one the latest
 * write reported, since read tokens keep the TTL they were written with.
 */
export function cacheRows(samples, resets = [], labels = new Map()) {
  const cutoffs = new Map(resets.map(r => [loopKey(r.sessionId, r.agentId), r.resetAt]));
  /** @type {Map<string, CacheRow>} */
  const rows = new Map();
  const unique = new Map(samples.filter(validSample).map(s => [sampleKey(s), s.cacheCreation ? applyCacheCreation(s, s.cacheCreation) : { ...s, ttlMs: null, ttlSource: 'response TTL metadata absent' }]));
  for (const s of [...unique.values()].sort((a, b) => a.startedAt - b.startedAt || a.index - b.index || sampleKey(a).localeCompare(sampleKey(b)))) {
    const key = loopKey(s.sessionId, s.agentId);
    let row = rows.get(key);
    if (!row) {
      row = { sessionId: s.sessionId, agentId: s.agentId, label: labels.get(key) ?? s.agentId ?? 'Main', samples: [], keepalives: [], totals: { requests: 0, read: 0, write: 0, fresh: 0, output: 0 } };
      rows.set(key, row);
    }
    row.samples.push(s);
    if (row.samples.length > 30) row.samples.shift();
    row.totals.requests++;
    for (const field of ['read', 'write', 'fresh', 'output']) row.totals[field] += s[field];
    if (s.startedAt < (cutoffs.get(key) ?? 0)) continue;
    if (s.read + s.write > 0) row.touchedAt = s.startedAt;
    if (isKeepalive(s)) { row.keepalives.push(s); continue; }
    row.last = s;
    row.keepalives = [];
    if (s.write > 0) row.creation = s.cacheCreation ?? null;
  }
  return [...rows.values()];
}

/**
 * A request in flight (`pendingAt`, its dispatch) reads or rewrites the entry,
 * so it restarts the countdown. Mixed writes keep two lifetimes; the time left
 * is the sooner one still running.
 * @param {CacheRow | undefined} row
 * @param {number} now
 * @param {number} [pendingAt]
 * @returns {CacheStatus}
 */
export function cacheStatus(row, now, pendingAt) {
  const sample = row?.last;
  if (!row || !sample) return { state: 'no observation', leftMs: null, ratio: null, lifetimes: [] };
  const total = sample.read + sample.write + sample.fresh;
  const ratio = total ? sample.read / total : null;
  const without = state => ({ state, leftMs: null, ratio, lifetimes: [] });
  if (sample.disabled) return without('caching disabled');
  if (sample.read + sample.write === 0) return without('uncached');
  if (!row.creation) return without('TTL unknown');
  const anchor = Math.max(row.touchedAt ?? sample.startedAt, pendingAt ?? 0);
  /** @type {CacheLifetime[]} */
  const lifetimes = [{ ttl: '5m', ttlMs: 300000, tokens: row.creation.fiveMinute }, { ttl: '1h', ttlMs: 3600000, tokens: row.creation.oneHour }]
    .filter(part => part.tokens > 0).map(part => ({ ...part, leftMs: Math.max(0, Math.min(part.ttlMs, anchor + part.ttlMs - now)) }));
  const running = lifetimes.filter(part => part.leftMs > 0).map(part => part.leftMs);
  const leftMs = running.length ? Math.min(...running) : 0;
  return { state: leftMs ? 'warm' : 'expired', leftMs, ratio, lifetimes, ttl: lifetimes.map(part => part.ttl).join('+') };
}

const DIAL = ['○', '◔', '◑', '◕', '●'];
/**
 * The time left as quarters of a circle: full when the entry was just read or
 * written, one quarter gone per quarter of the TTL, empty once it expired.
 * Dotted while there is no reported TTL to count down.
 * @param {CacheStatus | undefined} status
 */
export function cacheDial(status) {
  if (!status?.ttl || status.leftMs === null) return '◌';
  const part = status.lifetimes.find(lifetime => lifetime.leftMs === status.leftMs);
  return DIAL[part ? Math.min(4, Math.ceil(part.leftMs * 4 / part.ttlMs)) : 0];
}

/** A whole percentage that reads 100 only for a complete hit. */
export function cachePercent(sample) {
  const total = sample ? sample.read + sample.write + sample.fresh : 0;
  return total ? Math.floor(sample.read * 100 / total) : null;
}

/**
 * A miss costs its uncached tokens, so a hit rate is graded against the
 * context it was served over: the budgets for uncached input (written plus
 * new) are a share of the context, within fixed bounds. Between 40k and 400k
 * tokens, good is a 95% hit rate; a 1M-token context needs 98%.
 * @returns {CacheGrade | null}
 */
export function cacheGrade(sample) {
  const context = sample ? sample.read + sample.write + sample.fresh : 0;
  if (!context) return null;
  const missed = sample.write + sample.fresh;
  const budget = (percent, low, high) => Math.min(Math.max(context * percent / 100, low), high);
  return missed <= budget(5, 2000, 20000) ? 'good' : missed <= budget(20, 5000, 50000) ? 'fair' : 'poor';
}

/**
 * Time left, graded so the last half minute, when upkeep acts, reads poor.
 * @returns {CacheGrade | null}
 */
export function lifeGrade(leftMs) {
  if (leftMs === null || leftMs === undefined) return null;
  return leftMs > 120000 ? 'good' : leftMs > 30000 ? 'fair' : 'poor';
}

export function cacheBar(ratio, width = 10) {
  const fill = ratio === null ? 0 : Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return '█'.repeat(fill) + '░'.repeat(width - fill);
}
export function cacheClock(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function cacheTokens(value) {
  return value < 1000 ? String(value) : `${Number((value / (value >= 1e6 ? 1e6 : 1000)).toFixed(1))}${value >= 1e6 ? 'm' : 'k'}`;
}
