import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogEntries, priceIndex, matchPrices } from './model-match.js';
import { writeRecord } from './state.mjs';
import { isTruthy } from './shared/models.js';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
const FRESH_MS = 24 * 3600000;
const RETRY_MS = 3600000;
const LEASE_MS = 120000;
const LIMIT = 32 * 1024 * 1024;

async function readCache(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

async function lease(file, now, retry = true) {
  try {
    const handle = await open(file, 'wx', 0o600);
    await handle.writeFile(String(now));
    await handle.close();
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST' || !retry) return false;
    const at = Number(await readFile(file, 'utf8').catch(() => ''));
    if (Number.isFinite(at) && now - at < LEASE_MS) return false;
    await unlink(file).catch(() => {});
    return lease(file, now, false);
  }
}

async function download(fetcher, etag) {
  const response = await fetcher(MODELS_DEV_URL, {
    headers: { accept: 'application/json', 'user-agent': 'agent-router', ...(etag ? { 'if-none-match': etag } : {}) },
    redirect: 'follow', signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 304) return { unchanged: true };
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`models.dev returned HTTP ${response.status}`);
  }
  let text = '';
  let bytes = 0;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > LIMIT) throw new Error('models.dev response exceeded its size limit');
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  const entries = catalogEntries(JSON.parse(text));
  if (!entries.length) throw new Error('models.dev listed no priced models');
  return { entries, etag: response.headers.get('etag') ?? undefined };
}

async function refresh(root, file, cached, now, fetcher) {
  const lock = join(root, 'models-dev.lock');
  if (!await lease(lock, now)) return cached;
  const update = async () => {
    const result = await download(fetcher, Array.isArray(cached?.entries) ? cached.etag : undefined);
    const next = result.unchanged ? { ...cached, fetchedAt: now, failedAt: undefined } : { fetchedAt: now, etag: result.etag, entries: result.entries };
    await writeRecord(file, next);
    return next;
  };
  const failed = async () => {
    const next = { ...(cached ?? {}), failedAt: now };
    await writeRecord(file, next).catch(() => {});
    return next;
  };
  return update().catch(failed).finally(() => unlink(lock).catch(() => {}));
}

/**
 * @param {string} root
 * @param {string[]} models
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} [fetcher]
 * @param {number} [now]
 */
export async function modelPrices(root, models, env, fetcher = fetch, now = Date.now()) {
  const file = join(root, 'models-dev.json');
  let cached = await readCache(file);
  const listed = value => Array.isArray(value?.entries) && Number.isSafeInteger(value.fetchedAt);
  const fresh = value => listed(value) && now - value.fetchedAt < FRESH_MS;
  const waiting = Number.isSafeInteger(cached?.failedAt) && now - cached.failedAt < RETRY_MS;
  if (!fresh(cached) && !waiting && !isTruthy(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)) cached = await refresh(root, file, cached, now, fetcher);
  const index = priceIndex(listed(cached) ? cached.entries : []);
  return {
    catalog: fresh(cached) ? 'fresh' : listed(cached) ? 'stale' : 'missing',
    fetchedAt: listed(cached) ? cached.fetchedAt : null,
    prices: Object.fromEntries(models.map(model => [model, matchPrices(index, model)])),
  };
}
