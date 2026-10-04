/** Per-request evidence only. A gateway's retention policy is not inferred from token counts. */
/** @typedef {{sessionId: string, agentId: string | null, turnId: string, index: number, model: string, startedAt: number, read: number, write: number, fresh: number, output: number, ttlMs: number | null, ttlSource: string, disabled: boolean}} CacheSample */
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
    typeof s.ttlSource === 'string' && typeof s.disabled === 'boolean';
}

/** Display estimate only: the native hook cannot set cache_control on the wire. */
export function cachePolicy(option, endpoint, env = {}, setting, model = '', subagent = false) {
  const family = /haiku/i.test(model) ? 'HAIKU' : /sonnet/i.test(model) ? 'SONNET' : /opus/i.test(model) ? 'OPUS' : '';
  const disabled = on(env.DISABLE_PROMPT_CACHING) || !!family && on(env[`DISABLE_PROMPT_CACHING_${family}`]);
  const result = (ttl, source) => ({ ttlMs: ttl === '1h' ? 3600000 : 300000, ttlSource: source, disabled });
  if (option === '5m' || option === '1h') return result(option, 'plugin estimate');
  // Third-party providers may ignore Claude Code's TTL flags entirely.
  let anthropic = false;
  try { anthropic = new URL(endpoint).hostname === 'api.anthropic.com'; } catch { /* Unknown provider. */ }
  if (!anthropic) return { ttlMs: null, ttlSource: 'provider TTL unknown', disabled };
  if (on(env.FORCE_PROMPT_CACHING_5M)) return result('5m', 'FORCE_PROMPT_CACHING_5M');
  const variableName = subagent ? 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL' : 'CLAUDE_CODE_PROMPT_CACHE_TTL';
  const variable = env[variableName];
  if (variable === '5m' || variable === '1h') return result(variable, variableName);
  if (setting === '5m' || setting === '1h') return result(setting, subagent ? 'subagentPromptCacheTtl' : 'promptCacheTtl');
  if (on(env.ENABLE_PROMPT_CACHING_1H)) return result('1h', 'ENABLE_PROMPT_CACHING_1H');
  return result('5m', 'Anthropic API default');
}

/** Dedupe identities and keep lifetime totals while bounding the visible request history. */
export function cacheRows(samples, resets = [], labels = new Map()) {
  const cutoffs = new Map(resets.map(r => [loopKey(r.sessionId, r.agentId), r.resetAt]));
  /** @type {Map<string, CacheRow>} */
  const rows = new Map();
  const unique = new Map(samples.filter(validSample).map(s => [sampleKey(s), s]));
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
  if (sample.ttlMs === null) return { state: 'TTL unknown', leftMs: null, ratio };
  const leftMs = Math.max(0, Math.min(sample.ttlMs, sample.startedAt + sample.ttlMs - now));
  return { state: leftMs === 0 ? 'likely expired' : 'estimated warm', leftMs, ratio };
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
