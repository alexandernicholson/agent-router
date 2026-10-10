/** @typedef {{sessionId: string, agentId: string | null, turnId: string, index: number, model: string, startedAt: number, completedAt?: number, read: number, write: number, fresh: number, output: number, ttlMs: number | null, ttlSource: string, disabled: boolean, cacheCreation?: {fiveMinute: number, oneHour: number}, tokensBefore?: number, tokensAfter?: number, miss?: string, requested?: '5m' | '1h'}} CacheSample */
/** @typedef {{sessionId: string, agentId: string | null, resetAt: number}} CacheReset */
/** @typedef {{fiveMinute: number, oneHour: number}} CacheCreation */
/** @typedef {{sessionId: string, agentId: string | null, label: string, samples: CacheSample[], recent?: CacheSample[], last?: CacheSample, compaction?: CacheSample, touchedAt?: number, creation?: CacheCreation | null, keepalives: CacheSample[], totals: {requests: number, read: number, write: number, fresh: number, output: number}}} CacheRow */
/** @typedef {{ttl: '5m' | '1h', ttlMs: number, tokens: number, leftMs: number}} CacheLifetime */
/** @typedef {{state: string, ratio: number | null, leftMs: number | null, lifetimes: CacheLifetime[], ttl?: string, sample?: CacheSample, compacted?: {before?: number, after?: number}, awaiting?: boolean}} CacheStatus */
/** @typedef {{read: number, write: number, fresh: number, requests: number}} CacheUsage */
/** @typedef {'good' | 'fair' | 'poor'} CacheGrade */

import { sameModel } from './shared/models.js';

const on = value => value === '1' || value?.toLowerCase() === 'true';
const count = value => value === undefined || Number.isSafeInteger(value) && value >= 0;
export const TTL_REPORT_MS = 30000;
export const RATE_REQUESTS = 10;
export const MISS_WINDOW_MS = 900000;
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
    (s.cacheCreation === undefined || validCreation(s.cacheCreation, s.write)) &&
    count(s.tokensBefore) && count(s.tokensAfter) && (s.requested === undefined || s.requested === '5m' || s.requested === '1h');
}

export function validCreation(value, writes) {
  return value && ['fiveMinute', 'oneHour'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) &&
    value.fiveMinute + value.oneHour === writes && writes > 0;
}

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

export const isKeepalive = sample => typeof sample?.turnId === 'string' && sample.turnId.startsWith('keepalive:');
export const isCompaction = sample => typeof sample?.turnId === 'string' && sample.turnId.startsWith('compaction:');

/**
 * @param {CacheSample} s
 * @param {CacheSample | undefined} prior
 * @param {number | undefined} touchedAt
 * @param {CacheCreation | null | undefined} creation
 */
function missOf(s, prior, touchedAt, creation) {
  const expected = prior ? prior.read + prior.write : 0;
  if (!prior || !expected || expected - s.read < Math.max(2000, expected * 0.05)) return undefined;
  if (!sameModel(prior.model, s.model)) return 'model changed';
  if (s.requested === '1h' && (prior.requested ?? '5m') !== '1h') return 'TTL changed';
  if (!creation) return 'cache miss';
  const ttlMs = creation.oneHour ? 3600000 : 300000;
  return s.startedAt - touchedAt > ttlMs ? 'expired' : 'prefix changed';
}

/** @typedef {{read: number, output: number, fiveMinute?: number, oneHour?: number, provider?: string, id?: string, source?: string}} CachePrices */

const multiple = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
/** @param {unknown} value */
export function validPrices(value) {
  return !!value && typeof value === 'object' && multiple(value.read) && multiple(value.output) &&
    (value.fiveMinute === undefined || multiple(value.fiveMinute)) && (value.oneHour === undefined || multiple(value.oneHour));
}

/**
 * @param {CacheRow | undefined} row
 * @param {CachePrices | null | undefined} prices
 * @param {number} [limit]
 */
export function keepaliveWorthwhile(row, prices, limit) {
  const left = keepalivesLeft(row, prices, limit);
  return left !== null && left > 0;
}

const writePrice = (row, prices) => {
  const fiveMinute = Math.max(1, prices.fiveMinute ?? 1);
  return row.creation?.oneHour && !row.creation.fiveMinute ? Math.max(fiveMinute, prices.oneHour ?? fiveMinute) : fiveMinute;
};

/**
 * @param {CacheRow | undefined} row
 * @param {CachePrices | null | undefined} prices
 * @param {number} [limit]
 * @returns {number | null}
 */
export function keepalivesLeft(row, prices, limit) {
  const last = row?.last;
  const prefix = last ? last.read + last.write : 0;
  if (!last || !prefix) return null;
  if (limit !== undefined) return Math.max(0, limit - row.keepalives.length);
  if (!validPrices(prices)) return 0;
  const write = writePrice(row, prices);
  const cost = s => s.read * prices.read + s.write * write + s.fresh + s.output * prices.output;
  const spent = row.keepalives.reduce((sum, s) => sum + cost(s), 0);
  const next = row.keepalives.length ? cost(row.keepalives.at(-1)) : prefix * prices.read;
  if (next <= 0) return null;
  return Math.max(0, Math.floor((prefix * (write - prices.read) - spent) / next + 1e-9));
}

/**
 * @param {CacheRow | undefined} row
 * @returns {CacheUsage | undefined}
 */
export function recentUsage(row) {
  const recent = row?.recent ?? [];
  if (!recent.length) return undefined;
  const mean = field => recent.reduce((sum, s) => sum + s[field], 0) / recent.length;
  return { read: mean('read'), write: mean('write'), fresh: mean('fresh'), requests: recent.length };
}

/**
 * @param {CacheRow[]} rows
 * @param {number} now
 * @param {number} [windowMs]
 */
export function recentMisses(rows, now, windowMs = MISS_WINDOW_MS) {
  /** @type {Map<string, number>} */
  const causes = new Map();
  let total = 0;
  /** @type {number | undefined} */
  let latest;
  for (const row of rows) for (const s of row.samples) {
    const at = s.completedAt ?? s.startedAt;
    if (!s.miss || at < now - windowMs) continue;
    total++;
    latest = Math.max(latest ?? at, at);
    causes.set(s.miss, (causes.get(s.miss) ?? 0) + 1);
  }
  return { total, latest, causes: [...causes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) };
}

export function cachePolicy(env = {}, model = '') {
  const family = /haiku/i.test(model) ? 'HAIKU' : /sonnet/i.test(model) ? 'SONNET' : /opus/i.test(model) ? 'OPUS' : '';
  const disabled = on(env.DISABLE_PROMPT_CACHING) || !!family && on(env[`DISABLE_PROMPT_CACHING_${family}`]);
  return { ttlMs: null, ttlSource: 'response TTL metadata absent', disabled };
}

export function cacheRows(samples, resets = [], labels = new Map()) {
  const cutoffs = new Map(resets.map(r => [loopKey(r.sessionId, r.agentId), r.resetAt]));
  /** @type {Map<string, CacheRow>} */
  const rows = new Map();
  const unique = new Map(samples.filter(validSample).map(s => [sampleKey(s), s.cacheCreation ? applyCacheCreation(s, s.cacheCreation) : { ...s, ttlMs: null, ttlSource: 'response TTL metadata absent' }]));
  for (const s of [...unique.values()].sort((a, b) => a.startedAt - b.startedAt || a.index - b.index || sampleKey(a).localeCompare(sampleKey(b)))) {
    const key = loopKey(s.sessionId, s.agentId);
    let row = rows.get(key);
    if (!row) {
      row = { sessionId: s.sessionId, agentId: s.agentId, label: labels.get(key) ?? s.agentId ?? 'Main', samples: [], recent: [], keepalives: [], totals: { requests: 0, read: 0, write: 0, fresh: 0, output: 0 } };
      rows.set(key, row);
    }
    row.samples.push(s);
    if (row.samples.length > 30) row.samples.shift();
    if (!isCompaction(s) || s.read + s.write + s.fresh + s.output > 0) row.totals.requests++;
    for (const field of ['read', 'write', 'fresh', 'output']) row.totals[field] += s[field];
    if (s.startedAt < (cutoffs.get(key) ?? 0)) continue;
    if (isCompaction(s)) { row.compaction = s; continue; }
    if (!isKeepalive(s)) s.miss = missOf(s, row.last, row.touchedAt, row.creation);
    if (s.read + s.write > 0) row.touchedAt = s.startedAt;
    if (isKeepalive(s)) { row.keepalives.push(s); continue; }
    row.last = s;
    row.recent = [...row.recent, s].slice(-RATE_REQUESTS);
    row.keepalives = [];
    if (s.write > 0) row.creation = s.cacheCreation ?? null;
  }
  return [...rows.values()];
}

export const POLICY_TICK_MS = 5000;

/** A row the gateway's policy governs: it has a cached prefix but Anthropic never reported its cache lifetimes. */
export const policyRow = row => !!row?.last && !row.creation && !row.last.cacheCreation && row.last.read + row.last.write > 0;

/** The keepalive request text: nothing plugin-specific ever reaches a model provider. */
export const KEEPALIVE_PROMPT = 'Reply with only: K';

export const SOURCE_ICONS = { native: '◉', learned: '✦', documented: '▣', default: '◇', override: '◇', probe: '⟳', client: '✎', none: '⊘', unknown: '◌' };
export const SOURCE_NAMES = { native: 'reported by the provider', learned: 'learned by the gateway', documented: 'documented by the provider',
  default: 'gateway default', override: 'set by your gateway administrator', probe: 'gateway probe', client: 'your TTL setting', none: 'no cache', unknown: 'unknown' };
export const FALLBACK_TTLS = { '5m': 300000, '15m': 900000, '30m': 1800000, '45m': 2700000, '1h': 3600000 };
/** @typedef {'off' | keyof typeof FALLBACK_TTLS} FallbackTtl */
/** @param {unknown} value @returns {FallbackTtl | undefined} */
export const fallbackTtl = value => value === 'off' || typeof value === 'string' && Object.hasOwn(FALLBACK_TTLS, value) ? value : undefined;

const globRegex = pattern => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
/** "kimi*=15m, glm-5.3=off" → [['kimi*', '15m'], ['glm-5.3', 'off']]; anything malformed is skipped. */
export function parseTtlOverrides(text) {
  return String(text ?? '').split(/[,\n]/).map(part => part.split('=').map(item => item.trim()))
    .filter(([pattern, ttl, extra]) => pattern && pattern.length <= 200 && extra === undefined && fallbackTtl(ttl?.toLowerCase())).map(([pattern, ttl]) => [pattern, ttl.toLowerCase()]);
}
/** The client TTL in ms for a model with no reported or served lifetime: the first matching override, else the global choice. Never for Claude. */
export function clientTtl(model, global, overrides = []) {
  if (isClaudeModel(model)) return null;
  const choice = overrides.find(([pattern]) => globRegex(pattern).test(model))?.[1] ?? global ?? 'off';
  return choice === 'off' ? null : FALLBACK_TTLS[choice];
}

/**
 * The lifetime that governs a row: native (reported) → the server's row by source → the client TTL → unknown.
 * `policy` is set only when it can be acted on; it feeds policyAction.
 * @param {CacheRow | undefined} row
 * @param {{status: string, safe: number | null, maxIdle: number | null, refreshOnRead?: boolean | null, anchorOnStart?: boolean, source?: string | null, pResume?: number | null, reason?: string | null} | undefined} server
 * @param {number | null} client ms
 * @returns {{source: string, policy?: {status: 'enabled', safe: number, maxIdle: number | null, refreshOnRead: boolean | null, pResume: number | null},
 *   shownS?: number, once?: boolean, controlled?: boolean, status?: string, reason?: string | null}}
 */
export function lifetimeOf(row, server, client) {
  if (!policyRow(row)) return { source: row?.creation || row?.last?.cacheCreation ? 'native' : 'unknown' };
  if (server?.status === 'no_cache') return { source: 'none' };
  if (server?.status === 'demoted') return { source: 'unknown', status: 'demoted', reason: server.reason };
  if (server?.status === 'enabled' && server.safe) {
    return { source: server.source ?? 'learned', controlled: true, once: server.refreshOnRead !== true, shownS: server.safe,
      policy: { status: 'enabled', safe: server.safe, maxIdle: server.maxIdle, refreshOnRead: server.refreshOnRead ?? null, pResume: server.pResume ?? null, ...(server.anchorOnStart ? { anchorOnStart: true } : {}) } };
  }
  if (client && (!server || server.status === 'shadow' || server.status === 'insufficient_data')) {
    const margin = Math.max(10000, client / 10);
    return { source: 'client', shownS: client / 1000, policy: { status: 'enabled', safe: (client - margin) / 1000, maxIdle: null, refreshOnRead: null, pResume: null, anchorOnStart: true } };
  }
  return { source: 'unknown', ...(server ? { status: server.status, reason: server.reason } : {}) };
}

const span = seconds => {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  const [minutes, rest] = [Math.floor(seconds / 60), Math.round(seconds % 60)];
  return minutes ? `${minutes}m${rest ? ` ${rest}s` : ''}` : `${rest}s`;
};
/**
 * Time left as reduced motion draws it: held at the middle of its minute, so its text, colour, dial and bar change together,
 * once a minute; the last minute is held at 30 seconds and reads "soon". A minute ends on its boundary, so 5:00 left is
 * already 4m and a fresh countdown never shows a minute it leaves a second later. 0 (expired) stays 0.
 * @param {number} ms
 */
export const steadyLeft = ms => ms > 0 ? (Math.ceil(ms / 60000) - 1) * 60000 + 30000 : ms;
/** @param {number} ms */
const steadySpan = ms => {
  const minutes = Math.floor(steadyLeft(ms) / 60000);
  return minutes ? span(minutes * 60) : 'soon';
};
/** The bar text for a lifetime, such as "◇ 5m · once" or "⊘ no cache"; undefined for native rows. */
export function lifetimeLabel(life, state = '') {
  if (life.source === 'native') return state || undefined;
  const icon = SOURCE_ICONS[life.source];
  if (life.source === 'none') return `${icon} no cache`;
  if (life.phase === 'sent') return `${icon} sent · once`;
  if (life.phase === 'idle' || life.phase === 'missed') return `${icon} ${life.phase}`;
  if (life.left !== undefined) return life.left ? `${icon} ${life.steady ? steadySpan(life.left * 1000) : span(life.left)}${life.once ? ' · once' : ''}` : `${icon} expired`;
  if (life.shownS) return `${icon} ${span(life.shownS)}${life.once ? ' · once' : ''}`;
  const why = life.status === 'demoted' ? `demoted${life.reason ? ` · ${life.reason}` : ''}`
    : life.status === 'monitor' ? `monitor${life.reason ? ` (${life.reason})` : ''}` : life.status?.replace('_', ' ');
  return `${icon} ${why ?? state}`.trimEnd();
}

/**
 * The cache status of a row governed by a gateway or client lifetime: a countdown to the refresh time, from the same deadline
 * policyAction fires on, so what is shown and what is sent cannot disagree. Rows without an actionable lifetime keep `base`.
 * @param {CacheRow} row
 * @param {ReturnType<typeof lifetimeOf>} life
 * @param {number} now
 * @param {CacheStatus} base
 * @returns {CacheStatus & {phase?: string}}
 */
export function lifetimeStatus(row, life, now, base) {
  if (!life.policy || ['compacted', 'caching disabled', 'uncached', 'no observation'].includes(base.state)) return base;
  const { action, dueAt } = policyAction(row, life.policy, now);
  if (dueAt === undefined) return base;
  const ttlMs = life.policy.safe * 1000;
  const leftMs = action === 'idle' || action === 'missed' ? 0 : Math.min(ttlMs, Math.max(0, dueAt - now));
  const ttl = span(life.shownS);
  return { ...base, state: leftMs ? 'warm' : 'expired', leftMs, ttl, phase: action, awaiting: undefined,
    lifetimes: [{ ttl, ttlMs, tokens: row.last.read + row.last.write, leftMs }] };
}

/** Whether a keepalive pays for itself: the chance the user resumes times what a hit saves must beat what the keepalive costs. */
export function savingsWorthwhile(pResume, prices) {
  return validPrices(prices) && pResume * (Math.max(1, prices.fiveMinute ?? 1) - prices.read) > prices.read;
}

/**
 * What a lifetime says to do for a row it governs. With refreshOnRead true the countdown anchors on the last confirmed
 * cache-touching request (the real one, or a keepalive that read the cache) and chains. Otherwise it anchors on the last real turn (null) or on the latest write (false, a fixed window)
 * and fires one keepalive per idle period. Either way it ends at anchor + safe: fire in the last tick before that, never after.
 * @param {CacheRow} row
 * @param {{status: string, safe: number | null, maxIdle: number | null, refreshOnRead?: boolean | null, anchorOnStart?: boolean} | undefined} policy
 * @param {number} now
 * @returns {{action: 'monitor' | 'wait' | 'fire' | 'missed' | 'idle' | 'sent', dueAt?: number}}
 */
export function policyAction(row, policy, now) {
  if (!policyRow(row) || !policy || policy.status !== 'enabled' || !policy.safe) return { action: 'monitor' };
  // The provider's cache clock may restart at prefill, so a client-set TTL counts from the start of the request; a server's margin already covers latency.
  const at = s => policy.anchorOnStart ? s.startedAt : s.completedAt ?? s.startedAt;
  const sameKeepalives = row.keepalives.filter(s => sameModel(s.model, row.last.model) && s.startedAt >= row.last.startedAt);
  const chained = policy.refreshOnRead === true;
  const fixed = policy.refreshOnRead === false;
  const safeMs = policy.safe * 1000;
  let anchor;
  if (fixed) {
    // A fixed window runs from the write that established the prefix: the latest sample that wrote at least half of the current prefix.
    const writes = row.samples.filter(s => sameModel(s.model, row.last.model) && !isCompaction(s) && s.write > 0 && s.write * 2 >= row.last.read + row.last.write);
    if (!writes.length) return { action: 'monitor' };
    anchor = Math.max(...writes.map(at));
  } else anchor = Math.max(at(row.last), ...(chained ? sameKeepalives.filter(s => s.read > 0).map(at) : []));
  const dueAt = anchor + safeMs;
  if (policy.maxIdle && now - at(row.last) >= policy.maxIdle * 1000) return { action: 'idle', dueAt };
  if (!chained && sameKeepalives.length) {
    return { action: 'sent', dueAt };
  }
  if (now > dueAt) return { action: 'missed', dueAt };
  return { action: now >= dueAt - POLICY_TICK_MS ? 'fire' : 'wait', dueAt };
}

/**
 * @param {CacheRow | undefined} row
 * @param {number} now
 * @param {number} [pendingAt]
 * @param {Set<string>} [unreported]
 * @returns {CacheStatus}
 */
export function cacheStatus(row, now, pendingAt, unreported) {
  const compaction = row?.compaction && (!row.last || row.compaction.startedAt >= row.last.startedAt) ? row.compaction : undefined;
  const sample = compaction ?? row?.last;
  if (!row || !sample) return { state: 'no observation', leftMs: null, ratio: null, lifetimes: [] };
  const total = sample.read + sample.write + sample.fresh;
  const ratio = total ? sample.read / total : null;
  if (compaction) {
    return { state: 'compacted', leftMs: null, ratio, lifetimes: [], sample, compacted: { before: sample.tokensBefore, after: sample.tokensAfter } };
  }
  const without = state => ({ state, leftMs: null, ratio, lifetimes: [], sample });
  if (sample.disabled) return without('caching disabled');
  if (sample.read + sample.write === 0) return without('uncached');
  const creation = row.creation ?? (unreported?.has(modelName(sample.model)) ? null : awaitedCreation(row, sample, now));
  if (!creation) return without('TTL not reported');
  const anchor = Math.max(row.touchedAt, pendingAt ?? 0);
  /** @type {CacheLifetime[]} */
  const lifetimes = [{ ttl: '5m', ttlMs: 300000, tokens: creation.fiveMinute }, { ttl: '1h', ttlMs: 3600000, tokens: creation.oneHour }]
    .filter(part => part.tokens > 0).map(part => ({ ...part, leftMs: Math.max(0, Math.min(part.ttlMs, anchor + part.ttlMs - now)) }));
  const running = lifetimes.filter(part => part.leftMs > 0).map(part => part.leftMs);
  const leftMs = running.length ? Math.min(...running) : 0;
  return { state: leftMs ? 'warm' : 'expired', leftMs, ratio, lifetimes, ttl: lifetimes.map(part => part.ttl).join('+'), sample,
    ...(row.creation ? {} : { awaiting: true }) };
}

/**
 * @param {CacheRow} row
 * @param {CacheSample} sample
 * @param {number} now
 * @returns {CacheCreation | null}
 */
function awaitedCreation(row, sample, now) {
  // Only Anthropic's own cache has a requested 5m/1h lifetime; a gateway's other models never get one made up.
  if (sample !== row.last || !sample.write || sample.cacheCreation || !sample.requested || !isClaudeModel(sample.model)) return null;
  if (sample.completedAt !== undefined && now - sample.completedAt >= TTL_REPORT_MS) return null;
  return sample.requested === '1h' ? { fiveMinute: 0, oneHour: sample.write } : { fiveMinute: sample.write, oneHour: 0 };
}

export const isClaudeModel = model => /claude/i.test(model);
const modelName = model => model.replace(/\[1m\]$/i, '');

/**
 * @param {CacheRow[]} rows
 * @param {number} now
 * @returns {Set<string>}
 */
export function unreportedModels(rows, now) {
  const reported = new Set();
  const silent = new Set();
  for (const row of rows) for (const s of row.samples) {
    if (!s.write || isKeepalive(s) || isCompaction(s)) continue;
    if (s.cacheCreation) reported.add(modelName(s.model));
    else if (s.completedAt !== undefined && now - s.completedAt >= TTL_REPORT_MS) silent.add(modelName(s.model));
  }
  return new Set([...silent].filter(model => !reported.has(model)));
}

/**
 * @param {CacheSample} sample
 * @returns {string | undefined}
 */
export function sampleTtl(sample) {
  const creation = sample.cacheCreation;
  const reported = creation ? [creation.fiveMinute ? '5m' : '', creation.oneHour ? '1h' : ''].filter(Boolean).join('+') : '';
  if (!sample.requested) return reported || undefined;
  return reported && reported !== sample.requested ? `${sample.requested} (${reported} reported)` : sample.requested;
}

const DIAL = ['○', '◔', '◑', '◕', '●'];
/**
 * @param {CacheStatus | undefined} status
 */
export function cacheDial(status) {
  if (!status?.ttl || status.leftMs === null) return '◌';
  const part = status.lifetimes.find(lifetime => lifetime.leftMs === status.leftMs);
  return DIAL[Math.min(4, Math.ceil(part.leftMs * 4 / part.ttlMs))];
}

export function cachePercent(sample) {
  const total = sample ? sample.read + sample.write + sample.fresh : 0;
  return total ? Math.floor(sample.read * 100 / total) : null;
}

/**
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
 * @returns {CacheGrade | null}
 */
export function lifeGrade(leftMs) {
  if (leftMs === null || leftMs === undefined) return null;
  return leftMs > 120000 ? 'good' : leftMs > 30000 ? 'fair' : 'poor';
}

const FILLS = { good: '█', fair: '▓', poor: '▒' };
/**
 * @param {number | null} ratio
 * @param {number} [width]
 * @param {CacheGrade | null} [grade]
 */
export function cacheBarParts(ratio, width = 10, grade = null) {
  const fill = ratio === null ? 0 : Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return { fill: (grade ? FILLS[grade] : '█').repeat(fill), empty: '░'.repeat(width - fill) };
}
export function cacheBar(ratio, width = 10, grade = null) {
  const { fill, empty } = cacheBarParts(ratio, width, grade);
  return fill + empty;
}
export function cacheClock(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
/** Time left on a countdown: `~4:51`, or with reduced motion whole minutes (`~4m`) and `soon` in the last one; expired is `~0:00`. */
export function timeLeft(ms, steady = false) {
  if (!steady || ms <= 0) return `~${cacheClock(ms)}`;
  const text = steadySpan(ms);
  return text === 'soon' ? text : `~${text}`;
}
/**
 * A status as the bar and dashboard draw it: with reduced motion its countdowns held still within each minute (steadyLeft).
 * @template {CacheStatus} T
 * @param {T} status
 * @param {boolean} steady
 * @returns {T}
 */
export function steadyStatus(status, steady) {
  if (!steady) return status;
  return { ...status, leftMs: status.leftMs === null ? null : steadyLeft(status.leftMs),
    lifetimes: status.lifetimes.map(part => ({ ...part, leftMs: steadyLeft(part.leftMs) })) };
}
export function cacheTokens(value) {
  return value < 1000 ? String(value) : `${Number((value / (value >= 1e6 ? 1e6 : 1000)).toFixed(1))}${value >= 1e6 ? 'm' : 'k'}`;
}

const MATRIX_GLYPHS = { good: '●', fair: '◐', poor: '○', miss: '✕', keepalive: '·', compaction: '◆' };

/**
 * @param {CacheRow[]} rows
 * @returns {{glyph: string, tone: CacheGrade | 'quiet', at: number}[]}
 */
export function sessionMatrix(rows) {
  const cells = [];
  for (const row of rows) for (const s of row.samples) {
    const at = s.startedAt;
    if (isKeepalive(s)) cells.push({ glyph: MATRIX_GLYPHS.keepalive, tone: 'quiet', at });
    else if (isCompaction(s)) { if (s.read + s.write + s.fresh + s.output > 0) cells.push({ glyph: MATRIX_GLYPHS.compaction, tone: 'quiet', at }); }
    else {
      const grade = cacheGrade(s);
      if (!grade) continue;
      cells.push({ glyph: s.miss ? MATRIX_GLYPHS.miss : MATRIX_GLYPHS[grade], tone: grade, at });
    }
  }
  return cells.sort((a, b) => a.at - b.at);
}

/**
 * @param {CacheRow[]} rows
 * @param {number} [recent]
 */
export function sessionUsage(rows, recent = RATE_REQUESTS) {
  const real = rows.flatMap(row => row.samples.filter(s => !isKeepalive(s) && !isCompaction(s) && s.read + s.write + s.fresh > 0))
    .sort((a, b) => a.startedAt - b.startedAt);
  const sum = list => list.reduce((total, s) => ({ read: total.read + s.read, write: total.write + s.write, fresh: total.fresh + s.fresh }), { read: 0, write: 0, fresh: 0 });
  const last = real.slice(-recent);
  const mean = list => { const total = sum(list); return { read: total.read / list.length, write: total.write / list.length, fresh: total.fresh / list.length }; };
  return real.length ? { session: { ...sum(real), requests: real.length }, recent: { ...mean(last), requests: last.length } } : undefined;
}

/** @param {number} ms */
export function cacheGap(ms) {
  const value = Math.max(0, ms);
  if (value < 1000) return `${(value / 1000).toFixed(1)}s`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}m`;
}
