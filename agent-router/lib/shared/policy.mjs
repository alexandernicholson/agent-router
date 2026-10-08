// Cache policy published by a gateway: GET {base}/v1/cache/policy?alias=&session=.
// Pure helpers plus a small client; the caller supplies fetch (the host's) and the clock.

export const POLICY_TTL_MS = 600000;
export const POLICY_TIMEOUT_MS = 5000;
export const POLICY_MAX_BYTES = 65536;
const BACKOFF_MS = [30000, 60000, 120000, 300000, 600000];
const STATUSES = ['native', 'enabled', 'shadow', 'insufficient_data', 'demoted', 'fixed_window'];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const seconds = v => Number.isSafeInteger(v) && v > 0 && v <= 604800;
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** The policy URL for a gateway base URL, or null for no base, api.anthropic.com or anything unsafe. */
export function policyUrl(base, alias, session) {
  let url;
  try { url = new URL(base); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.username || url.password || host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(host))) return null;
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/cache/policy`;
  url.search = new URLSearchParams({ alias, ...(session ? { session } : {}) }).toString();
  url.hash = '';
  return url.href;
}

/** Valid rows of a policy response body, or null when the body is not a policy. */
export function parsePolicy(body) {
  if (typeof body !== 'string' || body.length > POLICY_MAX_BYTES) return null;
  let rows;
  try { rows = JSON.parse(body)?.rows; } catch { return null; }
  if (!Array.isArray(rows) || rows.length > 64) return null;
  return rows.filter(row => row && STATUSES.includes(row.status) && text(row.alias ?? 'x') &&
    (row.safe_refresh_s == null || seconds(row.safe_refresh_s)) && (row.max_idle_s == null || seconds(row.max_idle_s)) &&
    (row.prefix_bucket == null || Number.isSafeInteger(row.prefix_bucket)))
    .map(row => ({ status: row.status, safe: row.safe_refresh_s ?? null, maxIdle: row.max_idle_s ?? null, bucket: row.prefix_bucket ?? 0,
      provider: text(row.upstream_provider) ? row.upstream_provider : null, model: text(row.upstream_model) ? row.upstream_model : null }));
}

/** The row for a prefix of this many tokens: the largest bucket not above it; ties keep the most cautious. */
export function pickRow(rows, prefixTokens) {
  const bucket = Math.floor(Math.log2(Math.max(1, prefixTokens)));
  const fit = rows?.filter(row => row.bucket <= bucket) ?? [];
  const top = Math.max(...fit.map(row => row.bucket));
  return fit.filter(row => row.bucket === top)
    .sort((a, b) => Number(a.status === 'enabled') - Number(b.status === 'enabled') || (a.safe ?? 0) - (b.safe ?? 0))[0];
}

/**
 * @param {{fetch: (url: string, init: object) => Promise<{status: number, text: string}>,
 *   headers?: () => Promise<Record<string, string>>}} host
 */
export function createPolicyClient(host) {
  /** @type {Map<string, {at: number, rows: object[] | null, failures: number, retryAt: number, lookup?: Promise<void>}>} */
  const known = new Map();
  const peek = (alias, now) => {
    const entry = known.get(alias);
    return entry?.rows && now - entry.at < POLICY_TTL_MS ? entry.rows : null;
  };
  async function load(url, entry, now) {
    let timer;
    try {
      const response = await Promise.race([host.fetch(url, { headers: { accept: 'application/json', ...await host.headers?.() } }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), POLICY_TIMEOUT_MS); })]);
      const rows = response.status === 200 ? parsePolicy(response.text) : null;
      if (!rows) throw new Error('bad policy');
      Object.assign(entry, { at: now, rows, failures: 0, retryAt: 0 });
    } catch {
      entry.failures++;
      entry.retryAt = now + BACKOFF_MS[Math.min(entry.failures, BACKOFF_MS.length) - 1];
    } finally { clearTimeout(timer); }
  }
  return {
    peek,
    /** Fetches when the alias is unknown or older than 10 minutes and not backing off; always resolves. */
    async refresh(base, alias, session, now) {
      const url = policyUrl(base, alias, session);
      if (!url) return;
      const entry = known.get(alias) ?? { at: 0, rows: null, failures: 0, retryAt: 0 };
      known.set(alias, entry);
      if (entry.lookup) return entry.lookup;
      if (now < entry.retryAt || entry.rows && now - entry.at < POLICY_TTL_MS) return;
      entry.lookup = load(url, entry, now).finally(() => { entry.lookup = undefined; });
      return entry.lookup;
    },
  };
}
