/** Per-request evidence only. A gateway's retention policy is not inferred from token counts. */
/** @typedef {{sessionId: string, agentId: string | null, turnId: string, index: number, model: string, startedAt: number, completedAt?: number, read: number, write: number, fresh: number, output: number, ttlMs: number | null, ttlSource: string, disabled: boolean, cacheCreation?: {fiveMinute: number, oneHour: number}}} CacheSample */
/** @typedef {{sessionId: string, agentId: string | null, resetAt: number}} CacheReset */
/** @typedef {{sessionId: string, agentId: string | null, label: string, samples: CacheSample[], last?: CacheSample, totals: {requests: number, read: number, write: number, fresh: number, output: number}}} CacheRow */

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

/** Mixed writes have two independently expiring portions; never flatten them into one TTL. */
export function reportedLifetimes(sample, now) {
  if (!sample?.cacheCreation) return [];
  return [{ ttlMs: 300000, tokens: sample.cacheCreation.fiveMinute, ttl: '5m' },
    { ttlMs: 3600000, tokens: sample.cacheCreation.oneHour, ttl: '1h' }]
    .filter(part => part.tokens > 0).map(part => ({ ...part,
      leftMs: Math.max(0, Math.min(part.ttlMs, sample.startedAt + part.ttlMs - now)) }));
}

/** Local flags describe disabling; only response metadata can establish a TTL. */
export function cachePolicy(env = {}, model = '') {
  const family = /haiku/i.test(model) ? 'HAIKU' : /sonnet/i.test(model) ? 'SONNET' : /opus/i.test(model) ? 'OPUS' : '';
  const disabled = on(env.DISABLE_PROMPT_CACHING) || !!family && on(env[`DISABLE_PROMPT_CACHING_${family}`]);
  return { ttlMs: null, ttlSource: 'response TTL metadata absent', disabled };
}

/** Dedupe identities and keep lifetime totals while bounding the visible request history. */
export function cacheRows(samples, resets = [], labels = new Map()) {
  const cutoffs = new Map(resets.map(r => [loopKey(r.sessionId, r.agentId), r.resetAt]));
  /** @type {Map<string, CacheRow>} */
  const rows = new Map();
  const unique = new Map(samples.filter(validSample).map(s => [sampleKey(s), s.cacheCreation ? applyCacheCreation(s, s.cacheCreation) : { ...s, ttlMs: null, ttlSource: 'response TTL metadata absent' }]));
  for (const s of [...unique.values()].sort((a, b) => a.startedAt - b.startedAt || a.index - b.index || sampleKey(a).localeCompare(sampleKey(b)))) {
    const key = loopKey(s.sessionId, s.agentId);
    let row = rows.get(key);
    if (!row) {
      row = { sessionId: s.sessionId, agentId: s.agentId, label: labels.get(key) ?? s.agentId ?? 'Main', samples: [], totals: { requests: 0, read: 0, write: 0, fresh: 0, output: 0 } };
      rows.set(key, row);
    }
    row.samples.push(s);
    if (row.samples.length > 30) row.samples.shift();
    if (s.startedAt >= (cutoffs.get(key) ?? 0)) row.last = s;
    row.totals.requests++;
    for (const field of ['read', 'write', 'fresh', 'output']) row.totals[field] += s[field];
  }
  return [...rows.values()];
}

export function cacheStatus(sample, now) {
  if (!sample) return { state: 'no observation', leftMs: null, ratio: null };
  const total = sample.read + sample.write + sample.fresh;
  const ratio = total ? sample.read / total : null;
  if (sample.disabled) return { state: 'disabled', leftMs: null, ratio };
  if (sample.read + sample.write === 0) return { state: 'uncached', leftMs: null, ratio };
  if (sample.cacheCreation?.fiveMinute && sample.cacheCreation?.oneHour) return { state: 'reported mixed 5m/1h writes', leftMs: null, ratio };
  if (!sample.cacheCreation || sample.ttlMs === null) return { state: 'TTL unknown', leftMs: null, ratio };
  const leftMs = Math.max(0, Math.min(sample.ttlMs, sample.startedAt + sample.ttlMs - now));
  const prefix = sample.cacheCreation ? `reported ${sample.cacheCreation.oneHour ? '1h' : '5m'} writes · ` : '';
  return { state: prefix + (leftMs === 0 ? 'likely expired' : 'estimated warm'), leftMs, ratio };
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
