// Cache policy published by a gateway: GET {base}/v1/cache/policy?alias=&session=.
// Pure helpers plus a small client; the caller supplies fetch (the host's) and the clock.

export const POLICY_TTL_MS = 600000;
export const POLICY_TIMEOUT_MS = 5000;
export const POLICY_STALE_MS = 3600000;
export const POLICY_MAX_BYTES = 65536;
const BACKOFF_MS = [30000, 60000, 120000, 300000, 600000];
const STATUSES = ['native', 'enabled', 'shadow', 'insufficient_data', 'demoted', 'fixed_window', 'no_cache', 'monitor'];
const SOURCES = ['learned', 'documented', 'default', 'override', 'probe'];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const seconds = v => Number.isSafeInteger(v) && v > 0 && v <= 604800;
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** A gateway endpoint under {base}/v1/cache, or null for no base, api.anthropic.com or anything unsafe. */
function gatewayUrl(base, path, query) {
  let url;
  try { url = new URL(base); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.username || url.password || host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(host))) return null;
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/cache/${path}`;
  url.search = new URLSearchParams(query).toString();
  url.hash = '';
  return url.href;
}

/** The policy URL for a gateway base URL; client ("keepalive/0.4.2") is the heartbeat naming the plugin and version. */
export function policyUrl(base, alias, session, client, harness) {
  return gatewayUrl(base, 'policy', { alias, ...(session ? { session } : {}), ...(client ? { client } : {}), ...(harness ? { harness } : {}) });
}

/** Where a gateway takes client reports, with the same safety rules as the policy URL. */
export const reportsUrl = base => gatewayUrl(base, 'reports', {});

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
      refreshOnRead: row.refresh_on_read ?? null, anchorOnStart: row.anchor === 'start',
      maxAgeMs: Number.isFinite(row.max_age_s) ? Math.min(600, Math.max(30, row.max_age_s)) * 1000 : null, source: SOURCES.includes(row.source) ? row.source : null,
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
 *   headers?: () => Promise<Record<string, string>>, client?: string, harness?: string}} host
 */
export function createPolicyClient(host) {
  /** @type {Map<string, {at: number, rows: object[] | null, ttl: number, failures: number, retryAt: number, speaks?: number, lookup?: Promise<void>}>} */
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
      Object.assign(entry, { at: now, rows, ttl: Math.min(POLICY_TTL_MS, ...rows.map(row => row.maxAgeMs ?? POLICY_TTL_MS)), failures: 0, retryAt: 0, speaks: response.status === 200 ? now : entry.speaks });
    } catch {
      entry.failures++;
      entry.retryAt = now + BACKOFF_MS[Math.min(entry.failures, BACKOFF_MS.length) - 1];
    } finally { clearTimeout(timer); }
  }
  return {
    peek,
    /** True when the gateway answered a policy request with a valid 200 within the last hour: it speaks the protocol and strips the keepalive marker. */
    speaks: now => [...known.values()].some(entry => entry.speaks !== undefined && now - entry.speaks < POLICY_STALE_MS),
    /** Fetches when the alias is unknown or older than 10 minutes and not backing off; always resolves. */
    async refresh(base, alias, session, now) {
      const url = policyUrl(base, alias, session, host.client, host.harness);
      if (!url) return;
      const entry = known.get(alias) ?? { at: 0, rows: null, ttl: POLICY_TTL_MS, failures: 0, retryAt: 0 };
      known.set(alias, entry);
      if (entry.lookup) return entry.lookup;
      if (now < entry.retryAt || entry.rows && now - entry.at < entry.ttl) return;
      entry.lookup = load(url, entry, now).finally(() => { entry.lookup = undefined; });
      return entry.lookup;
    },
  };
}

export const REPORT_BATCH = 50;
export const REPORT_QUEUE = 200;
export const REPORT_STOP_MS = 3600000;

/**
 * Out-of-band reports of keepalives and compactions the plugin made, for the gateway's telemetry only.
 * Bounded queue, fire-and-forget batches, backoff after failures, silence for an hour after a 404.
 * @param {{fetch: (url: string, init: object) => Promise<{status: number}>, headers?: () => Promise<Record<string, string>>, client: string, harness?: string}} host
 */
export function createReportClient(host) {
  const queue = [];
  let retryAt = 0;
  let stopUntil = 0;
  let failures = 0;
  let flushing;
  async function send(url, batch) {
    let timer;
    try {
      const response = await Promise.race([host.fetch(url, { method: 'POST', body: JSON.stringify({ client: host.client, ...(host.harness ? { harness: host.harness } : {}), reports: batch }),
        headers: { 'content-type': 'application/json', ...await host.headers?.() } }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), POLICY_TIMEOUT_MS); })]);
      return response.status;
    } catch { return 0; } finally { clearTimeout(timer); }
  }
  async function drain(url, now) {
    while (queue.length) {
      const batch = queue.slice(0, REPORT_BATCH);
      const status = await send(url, batch);
      if (status === 404) { stopUntil = now + REPORT_STOP_MS; queue.length = 0; return; }
      if (status < 200 || status >= 300) { retryAt = now + BACKOFF_MS[Math.min(++failures, BACKOFF_MS.length) - 1]; return; }
      failures = 0;
      for (const sent of batch) queue.splice(queue.indexOf(sent), 1);
    }
  }
  return {
    get size() { return queue.length; },
    /** Queues one report, dropping the oldest beyond the bound; nothing is queued while the gateway has said it does not want them. */
    add(report, now) {
      if (now < stopUntil) return;
      queue.push(report);
      if (queue.length > REPORT_QUEUE) queue.splice(0, queue.length - REPORT_QUEUE);
    },
    /** Sends queued reports in batches unless backing off; always resolves. */
    flush(base, now) {
      const url = reportsUrl(base);
      if (!url || !queue.length || now < retryAt || now < stopUntil) return Promise.resolve();
      flushing ??= drain(url, now).finally(() => { flushing = undefined; });
      return flushing;
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

const priceOf = value => {
  const [input, read, write, output] = ['input', 'read', 'write', 'output'].map(key => value?.[key]);
  if (![input, read, write, output].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) || input <= 0) return null;
  const hour = value.write_1h;
  return { read: read / input, fiveMinute: write / input, output: output / input,
    ...(typeof hour === 'number' && Number.isFinite(hour) && hour >= 0 ? { oneHour: hour / input } : {}) };
};
const globPattern = glob => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');

/**
 * A price feed: exact `models` by alias, then `patterns` (only * is a wildcard; first match in order wins). Prices are relative to input.
 * @param {string} body
 * @returns {{models: Record<string, object>, patterns: [RegExp, object][]} | null}
 */
export function parsePriceFeed(body) {
  if (typeof body !== 'string' || body.length > POLICY_MAX_BYTES) return null;
  let feed;
  try { feed = JSON.parse(body); } catch { return null; }
  const table = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value).slice(0, 256) : [];
  if (feed?.version !== 1 || !feed.models || typeof feed.models !== 'object' || Array.isArray(feed.models)) return null;
  const models = {};
  for (const [alias, value] of table(feed.models)) { const price = priceOf(value); if (price) models[alias] = price; }
  const patterns = [];
  for (const [glob, value] of table(feed.patterns)) { const price = priceOf(value); if (price && glob.length <= 200) patterns.push([globPattern(glob), price]); }
  return { models, patterns };
}

/** The feed's price for a model: exact alias, else the first matching pattern after dropping a [1m] suffix; null when it has none. */
export function feedPrice(feed, model) {
  if (Object.hasOwn(feed.models, model)) return feed.models[model];
  const name = model.replace(/\[1m\]$/i, '');
  return feed.patterns.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}
