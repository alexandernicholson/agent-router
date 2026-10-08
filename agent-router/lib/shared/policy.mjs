// Cache policy published by a gateway: GET {base}/v1/cache/policy?alias=&session=.
// Pure helpers plus a small client; the caller supplies fetch (the host's) and the clock.

export const POLICY_TTL_MS = 600000;
export const POLICY_TIMEOUT_MS = 5000;
export const POLICY_STALE_MS = 3600000;
export const POLICY_MAX_BYTES = 65536;
const BACKOFF_MS = [30000, 60000, 120000, 300000, 600000];
const STATUSES = ['native', 'enabled', 'shadow', 'insufficient_data', 'demoted', 'fixed_window', 'no_cache', 'monitor'];
const SOURCES = ['learned', 'documented', 'default'];
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
  const kept = rows.filter(row => row && STATUSES.includes(row.status) && text(row.alias ?? 'x') &&
    (row.safe_refresh_s == null || seconds(row.safe_refresh_s)) && (row.max_idle_s == null || seconds(row.max_idle_s)) &&
    (row.prefix_bucket == null || Number.isSafeInteger(row.prefix_bucket)) && (row.refresh_on_read == null || typeof row.refresh_on_read === 'boolean'))
    .map(row => ({ status: row.status, safe: row.safe_refresh_s ?? null, maxIdle: row.max_idle_s ?? null, bucket: row.prefix_bucket ?? 0,
      refreshOnRead: row.refresh_on_read ?? null, source: SOURCES.includes(row.source) ? row.source : null,
      pResume: typeof row.p_resume === 'number' && row.p_resume >= 0 && row.p_resume <= 1 ? row.p_resume : null, reason: text(row.reason) ? row.reason : null,
      provider: text(row.upstream_provider) ? row.upstream_provider : null, model: text(row.upstream_model) ? row.upstream_model : null }));
  return rows.length && !kept.length ? null : kept;
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
  /** The last rows served for an alias, kept while refreshing or failing for up to an hour; [] is a real answer of no policy, null is unknown. */
  const peek = (alias, now) => {
    const entry = known.get(alias);
    return entry?.rows && now - entry.at < POLICY_STALE_MS ? entry.rows : null;
  };
  async function load(url, entry, now) {
    let timer;
    try {
      const response = await Promise.race([host.fetch(url, { headers: { accept: 'application/json', ...await host.headers?.() } }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), POLICY_TIMEOUT_MS); })]);
      const rows = response.status === 404 ? [] : response.status === 200 ? parsePolicy(response.text) : null;
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

export const PRICES_TTL_MS = 3600000;
const sameOrigin = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };

/**
 * Where model prices come from: the user's own URL, or the gateway's {base}/v1/cache/prices. Credentials go only to the gateway's origin.
 * @param {string | undefined} base the inference base URL
 * @param {string | undefined} custom a user-chosen price URL, 'off' or 'default'/empty
 * @returns {{url: string, authorize: boolean} | null}
 */
export function priceFeed(base, custom) {
  const choice = (custom ?? '').trim();
  if (choice.toLowerCase() === 'off') return null;
  if (!choice || choice.toLowerCase() === 'default') {
    const url = policyUrl(base, 'x');
    return url ? { url: url.replace(/\/v1\/cache\/policy\?.*$/, '/v1/cache/prices'), authorize: true } : null;
  }
  let url;
  try { url = new URL(choice); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(host)))) return null;
  url.hash = '';
  return { url: url.href, authorize: !!base && sameOrigin(url.href, base) && !!policyUrl(base, 'x') };
}

/**
 * Prices in relative units (or dollars) per model, as CachePrices (input = 1).
 * @param {string} body
 * @returns {Record<string, {read: number, output: number, fiveMinute: number}> | null}
 */
export function parsePriceFeed(body) {
  if (typeof body !== 'string' || body.length > POLICY_MAX_BYTES) return null;
  let feed;
  try { feed = JSON.parse(body); } catch { return null; }
  if (feed?.version !== 1 || !feed.models || typeof feed.models !== 'object' || Array.isArray(feed.models)) return null;
  const prices = {};
  for (const [alias, value] of Object.entries(feed.models).slice(0, 256)) {
    const [input, read, write, output] = ['input', 'read', 'write', 'output'].map(key => value?.[key]);
    if (![input, read, write, output].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) || input <= 0) continue;
    prices[alias] = { read: read / input, fiveMinute: write / input, output: output / input };
  }
  return prices;
}
