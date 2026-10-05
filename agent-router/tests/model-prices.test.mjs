import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { modelPrices, MODELS_DEV_URL } from '../lib/model-prices.mjs';
import { catalogEntries } from '../lib/model-match.js';
import { handleRequest } from '../lib/bridge.mjs';

const HOUR = 3600000;
const catalog = (read = 0.2) => ({
  anthropic: { id: 'anthropic', models: {
    'claude-opus-5-5': { id: 'claude-opus-5-5', cost: { input: 4, output: 20, cache_read: read, cache_write: 5 }, canonical_model_id: 'anthropic/claude-opus-5-5' },
    'claude-haiku-4-5': { id: 'claude-haiku-4-5', cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 }, canonical_model_id: 'anthropic/claude-haiku-4-5' },
    'claude-free': { id: 'claude-free', cost: { input: 0, output: 0 } },
  } },
  'amazon-bedrock': { id: 'amazon-bedrock', models: {
    'us.anthropic.claude-opus-5-5': { cost: { input: 4.4, output: 22, cache_read: 0.22, cache_write: 5.5 }, canonical_model_id: 'anthropic/claude-opus-5-5' },
  } },
  broken: { models: { 'x-1': null, 'y-2': { cost: 'cheap' } } },
});
function server(body = catalog(), { status = 200, etag = '"v1"', delay = 0 } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), ifNoneMatch: init?.headers?.['if-none-match'] });
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (status === 0) throw new Error('offline');
    if (init?.headers?.['if-none-match'] === etag && status === 200) return new Response(null, { status: 304, headers: { etag } });
    return new Response(status === 200 ? JSON.stringify(body) : 'nope', { status, headers: { etag, 'content-type': 'application/json' } });
  };
  return { fetcher, calls };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-router-prices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('catalog entries keep priced models only, with their owner', () => {
  const entries = catalogEntries(catalog());
  assert.deepEqual(entries.map(entry => entry.slice(0, 3)), [
    ['anthropic', 'claude-opus-5-5', 'anthropic'], ['anthropic', 'claude-haiku-4-5', 'anthropic'], ['amazon-bedrock', 'us.anthropic.claude-opus-5-5', 'anthropic']]);
  for (const value of [null, 'x', [], { a: null }, { a: { models: [] } }]) assert.deepEqual(catalogEntries(value), []);
});

test('the first lookup fetches models.dev once and prices every spelling from the file cache', async t => {
  const root = await fixture(t);
  const { fetcher, calls } = server();
  const first = await modelPrices(root, ['claude-opus-5-5[1m]', 'us.anthropic.claude-opus-5-5-v1:0', 'anthropic/acme-1-code'], {}, fetcher, 1000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, MODELS_DEV_URL);
  assert.equal(first.catalog, 'fresh');
  assert.equal(first.prices['claude-opus-5-5[1m]'].read, 0.05);
  assert.equal(first.prices['us.anthropic.claude-opus-5-5-v1:0'].provider, 'anthropic');
  assert.equal(first.prices['anthropic/acme-1-code'], null);
  const second = await modelPrices(root, ['claude-haiku-4-5'], {}, fetcher, 1000 + 23 * HOUR);
  assert.equal(calls.length, 1);
  assert.equal(second.prices['claude-haiku-4-5'].read, 0.1);
  const stored = await readFile(join(root, 'models-dev.json'), 'utf8');
  assert.equal(stored.includes('canonical_model_id'), false);
  assert.ok(stored.length < 2000);
});

test('a day-old cache revalidates with its etag and keeps its entries on 304', async t => {
  const root = await fixture(t);
  const { fetcher, calls } = server();
  await modelPrices(root, [], {}, fetcher, 0);
  const result = await modelPrices(root, ['claude-opus-5-5'], {}, fetcher, 25 * HOUR);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].ifNoneMatch, '"v1"');
  assert.equal(result.catalog, 'fresh');
  assert.equal(result.prices['claude-opus-5-5'].read, 0.05);
  assert.equal((await modelPrices(root, [], {}, fetcher, 26 * HOUR)).catalog, 'fresh');
  assert.equal(calls.length, 2);
});

test('changed prices replace the cache after a day', async t => {
  const root = await fixture(t);
  await modelPrices(root, [], {}, server(catalog(0.2), { etag: '"v1"' }).fetcher, 0);
  const result = await modelPrices(root, ['claude-opus-5-5'], {}, server(catalog(0.4), { etag: '"v2"' }).fetcher, 25 * HOUR);
  assert.equal(result.prices['claude-opus-5-5'].read, 0.1);
});

test('windows refreshing at once fetch once, and the others use what is cached', async t => {
  const root = await fixture(t);
  const { fetcher, calls } = server(catalog(), { delay: 50 });
  const results = await Promise.all(Array.from({ length: 6 }, () => modelPrices(root, ['claude-opus-5-5'], {}, fetcher, 1000)));
  assert.equal(calls.length, 1);
  assert.equal(results.filter(result => result.catalog === 'fresh').length, 1);
  assert.equal(results.filter(result => result.catalog === 'missing').length, 5);
  assert.equal((await modelPrices(root, ['claude-opus-5-5'], {}, fetcher, 2000)).prices['claude-opus-5-5'].read, 0.05);
  assert.equal(calls.length, 1);
});

test('a lease left by a window that died expires', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'models-dev.lock'), '1000');
  const { fetcher, calls } = server();
  assert.equal((await modelPrices(root, [], {}, fetcher, 1000 + 60000)).catalog, 'missing');
  assert.equal(calls.length, 0);
  assert.equal((await modelPrices(root, [], {}, fetcher, 1000 + 3 * 60000)).catalog, 'fresh');
  assert.equal(calls.length, 1);
});

test('a failed refresh keeps the stale cache and waits an hour before trying again', async t => {
  const root = await fixture(t);
  await modelPrices(root, [], {}, server().fetcher, 0);
  for (const failure of [{ status: 0 }, { status: 500 }]) {
    const { fetcher, calls } = server(catalog(), failure);
    const stale = await modelPrices(root, ['claude-opus-5-5'], {}, fetcher, 30 * HOUR);
    assert.equal(stale.catalog, 'stale');
    assert.equal(stale.prices['claude-opus-5-5'].read, 0.05);
    await modelPrices(root, [], {}, fetcher, 30 * HOUR + 30 * 60000);
    assert.equal(calls.length, failure.status === 0 ? 1 : 0);
  }
  const { fetcher, calls } = server();
  assert.equal((await modelPrices(root, [], {}, fetcher, 32 * HOUR)).catalog, 'fresh');
  assert.equal(calls.length, 1);
});

test('invalid, oversized or empty catalogs and corrupt cache files are never trusted', async t => {
  const root = await fixture(t);
  for (const body of [{ nothing: true }, 'not json', []]) {
    const result = await modelPrices(root, ['claude-opus-5-5'], {}, async () => new Response(typeof body === 'string' ? body : JSON.stringify(body)), 0);
    assert.equal(result.prices['claude-opus-5-5'], null);
    await rm(join(root, 'models-dev.json'), { force: true });
  }
  const huge = async () => new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < 40; i++) controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
    controller.close();
  } }));
  assert.equal((await modelPrices(root, [], {}, huge, 0)).catalog, 'missing');
  await rm(join(root, 'models-dev.json'), { force: true });
  await writeFile(join(root, 'models-dev.json'), '{corrupt');
  assert.equal((await modelPrices(root, ['claude-opus-5-5'], {}, server().fetcher, 0)).prices['claude-opus-5-5'].read, 0.05);
});

test('nonessential traffic off means no fetch, only an existing cache', async t => {
  const root = await fixture(t);
  const { fetcher, calls } = server();
  const quiet = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  assert.equal((await modelPrices(root, ['claude-opus-5-5'], quiet, fetcher, 0)).catalog, 'missing');
  assert.equal(calls.length, 0);
  await modelPrices(root, [], {}, fetcher, 0);
  assert.equal((await modelPrices(root, ['claude-opus-5-5'], quiet, fetcher, 30 * HOUR)).prices['claude-opus-5-5'].read, 0.05);
  assert.equal(calls.length, 1);
});

test('the bridge answers price lookups from the plugin data directory', async t => {
  const root = await fixture(t);
  const env = { CLAUDE_PLUGIN_DATA: root };
  const result = await handleRequest({ action: 'cache-prices', session_id: 's', models: ['claude-opus-5-5'] }, env, undefined, undefined, server().fetcher);
  assert.equal(result.prices['claude-opus-5-5'].read, 0.05);
  for (const models of [undefined, 'claude', [42], Array(17).fill('a-1')]) {
    await assert.rejects(handleRequest({ action: 'cache-prices', session_id: 's', models }, env, undefined, undefined, server().fetcher), /models/);
  }
});
