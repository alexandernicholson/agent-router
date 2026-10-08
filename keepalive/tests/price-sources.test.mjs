import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ANTHROPIC_PRICES } from '../lib/anthropic-prices.js';
import { PRICE_SOURCES, anthropicPrices, customUrlPrices, lookUpPrices } from '../lib/price-sources.mjs';
import { handleRequest } from '../lib/bridge.mjs';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
const source = (id, prices, calls = []) => ({ id, label: id, async prices(models) { calls.push([...models]); return Object.fromEntries(models.map(model => [model, prices[model] ?? null])); } });

test('Anthropic prices every Claude model, however a gateway or cloud spells it', async () => {
  const spellings = ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'us.anthropic.claude-opus-5-5-v1:0', 'global.anthropic.claude-opus-5-5',
    'claude-opus-5-5@default', 'anthropic/claude-opus-5.5', 'gateway/claude-opus-5-5[1m]', 'aws-bedrock/claude-opus-5-5'];
  const { prices } = await lookUpPrices(spellings, {}, [anthropicPrices]);
  for (const spelling of spellings) {
    const value = prices[spelling];
    near(value.read, 0.05);
    near(value.fiveMinute, 1.25);
    near(value.oneHour, 2);
    near(value.output, 5);
    assert.equal(value.source, 'Anthropic pricing');
  }
  const more = await lookUpPrices(['claude-fable-5-1', 'claude-mythos-5', 'claude-opus-5', 'claude-sonnet-4-5-20250929', 'claude-3-5-haiku-20241022', 'claude-opus-4-20250514'], {}, [anthropicPrices]);
  near(more.prices['claude-fable-5-1'].read, 0.025);
  near(more.prices['claude-mythos-5'].read, 0.1);
  near(more.prices['claude-opus-5'].read, 0.1);
  near(more.prices['claude-sonnet-4-5-20250929'].oneHour, 2);
  near(more.prices['claude-3-5-haiku-20241022'].output, 5);
  near(more.prices['claude-opus-4-20250514'].output, 5);
});

test('the Anthropic table matches its published multipliers', () => {
  assert.ok(ANTHROPIC_PRICES.length >= 19);
  for (const [, id, , input, output, read, fiveMinute, oneHour] of ANTHROPIC_PRICES) {
    near(fiveMinute / input, 1.25);
    near(oneHour / input, 2);
    near(output / input, 5);
    const multiple = /fable-5-1|mythos-5-1/.test(id) ? 0.025 : /opus-5-5/.test(id) ? 0.05 : 0.1;
    near(read / input, multiple);
  }
});

test('Anthropic unlisted versions, variants and gateway aliases fall through, never borrowing a price', async () => {
  const { prices } = await lookUpPrices(['claude-opus-5-6', 'claude-opus-6', 'claude-opus-5-5-fast', 'claude-opus-5-5-thinking', 'anthropic/acme-1-code[1m]', 'gpt-5', 'vendor/test'], {}, [anthropicPrices]);
  for (const value of Object.values(prices)) assert.equal(value, null);
});

test('sources are asked in order, each only for models still unpriced', async () => {
  const later = [];
  const { prices } = await lookUpPrices(['claude-opus-5-5', 'gpt-5', 'mystery-1'], {}, [
    anthropicPrices, source('second', { 'claude-opus-5-5': { read: 0.9, output: 9 }, 'gpt-5': { read: 0.1, output: 8, provider: 'p', id: 'gpt-5' } }, later)]);
  assert.deepEqual(later, [['gpt-5', 'mystery-1']]);
  near(prices['claude-opus-5-5'].read, 0.05);
  assert.equal(prices['gpt-5'].source, 'second');
  assert.equal(prices['mystery-1'], null);
});

test('a source that fails or answers with invalid prices is passed over', async () => {
  const broken = { id: 'broken', label: 'broken', async prices() { throw new Error('offline'); } };
  const invalid = source('invalid', { 'pond-1': { read: -1, output: 5 } });
  const good = source('good', { 'pond-1': { read: 0.1, output: 5 } });
  const { prices } = await lookUpPrices(['pond-1'], {}, [broken, invalid, good]);
  assert.equal(prices['pond-1'].source, 'good');
  assert.deepEqual(await lookUpPrices([], {}, [broken]), { prices: {} });
});

test('the default sources try a price feed, then Anthropic, then models.dev', () => {
  assert.deepEqual(PRICE_SOURCES.map(item => item.id), ['feed', 'anthropic', 'models.dev']);
});

test('the bridge prices Claude models without downloading models.dev', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepalive-price-sources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const fetcher = async url => { calls.push(String(url)); return new Response(JSON.stringify({ openai: { models: { 'gpt-5': { cost: { input: 1.25, output: 10, cache_read: 0.125 } } } } })); };
  const env = { CLAUDE_PLUGIN_DATA: root };
  const claude = await handleRequest({ action: 'cache-prices', session_id: 's', models: ['us.anthropic.claude-opus-5-5-v1:0'] }, env, {}, fetcher);
  assert.equal(claude.prices['us.anthropic.claude-opus-5-5-v1:0'].source, 'Anthropic pricing');
  assert.equal(calls.length, 0);
  const other = await handleRequest({ action: 'cache-prices', session_id: 's', models: ['gpt-5'] }, env, {}, fetcher);
  assert.equal(other.prices['gpt-5'].source, 'models.dev');
  assert.equal(other.prices['gpt-5'].oneHour, undefined);
  assert.equal(calls.length, 1);
});

test('a price feed prices models in relative units, sends credentials only to the gateway, and a 404 means none', async () => {
  const calls = [];
  const feed = { version: 1, models: { 'kimi-k3': { input: 2, read: 0.2, write: 2.5, output: 10 } } };
  const fetcher = async (url, init) => { calls.push([String(url), init]); return url.includes('missing') ? new Response('no', { status: 404 }) : new Response(JSON.stringify(feed)); };
  const headers = { authorization: 'Bearer t' };
  const own = await lookUpPrices(['kimi-k3', 'other'], { fetcher, feed: { base: 'https://gateway.example', headers } }, [customUrlPrices]);
  assert.deepEqual(own.prices['kimi-k3'], { read: 0.1, fiveMinute: 1.25, output: 5, source: 'price feed' });
  assert.equal(own.prices.other, null);
  assert.equal(calls[0][0], 'https://gateway.example/v1/cache/prices');
  assert.equal(calls[0][1].headers.authorization, 'Bearer t');
  assert.equal(calls[0][1].redirect, 'error');
  await lookUpPrices(['kimi-k3'], { fetcher, feed: { base: 'https://gateway.example', url: 'https://prices.example/p.json', headers } }, [customUrlPrices]);
  assert.equal(calls[1][1].headers.authorization, undefined);
  assert.deepEqual(await lookUpPrices(['kimi-k3'], { fetcher, feed: { base: 'https://gateway.example', url: 'https://x.example/missing', headers } }, [customUrlPrices]), { prices: { 'kimi-k3': null } });
  assert.deepEqual(await lookUpPrices(['kimi-k3'], { fetcher, feed: { base: 'https://api.anthropic.com' } }, [customUrlPrices]), { prices: { 'kimi-k3': null } });
  assert.deepEqual(await lookUpPrices(['kimi-k3'], { fetcher }, [customUrlPrices]), { prices: { 'kimi-k3': null } });
  const big = async () => new Response('{}', { headers: { 'content-length': '70000' } });
  assert.deepEqual(await lookUpPrices(['kimi-k3'], { fetcher: big, feed: { base: 'https://gateway.example' } }, [customUrlPrices]), { prices: { 'kimi-k3': null } });
  const plain = async () => ({ ok: true, text: async () => JSON.stringify(feed) });
  assert.equal((await lookUpPrices(['kimi-k3'], { fetcher: plain, feed: { base: 'https://gateway.example' } }, [customUrlPrices])).prices['kimi-k3'].read, 0.1);
  const junk = async () => new Response('nonsense');
  assert.equal((await lookUpPrices(['kimi-k3'], { fetcher: junk, feed: { base: 'https://gateway.example' } }, [customUrlPrices])).prices['kimi-k3'], null);
});

test('the bridge hands only credential headers to the price feed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepalive-price-feed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen = [];
  const fetcher = async (url, init) => { seen.push(init.headers); return new Response(JSON.stringify({ version: 1, models: { m: { input: 1, read: 0.1, write: 1.25, output: 5 } } })); };
  const found = await handleRequest({ action: 'cache-prices', session_id: 's', models: ['m'], feed: { base: 'https://gateway.example', headers: { authorization: 'Bearer t', cookie: 'x', 'x-api-key': 5 } } }, { CLAUDE_PLUGIN_DATA: root }, {}, fetcher);
  assert.equal(found.prices.m.source, 'price feed');
  assert.deepEqual(seen[0], { accept: 'application/json', authorization: 'Bearer t' });
  await handleRequest({ action: 'cache-prices', session_id: 's', models: ['m'], feed: { base: 'https://gateway.example' } }, { CLAUDE_PLUGIN_DATA: root }, {}, fetcher);
  await handleRequest({ action: 'cache-prices', session_id: 's', models: ['m'], feed: {} }, { CLAUDE_PLUGIN_DATA: root }, {}, fetcher);
});

test('the feed prices Claude too: a pattern with write_1h beats Anthropic list prices, and a model it lacks falls back', async () => {
  const feed = { version: 1, models: {}, patterns: { 'claude-opus-*': { input: 2, read: 0.4, write: 5, write_1h: 8, output: 10 } } };
  const fetcher = async () => new Response(JSON.stringify(feed));
  const context = { fetcher, feed: { base: 'https://gateway.example' } };
  const { prices } = await lookUpPrices(['claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-sonnet-5'], context);
  for (const model of ['claude-opus-5-5', 'claude-opus-5-5[1m]']) {
    assert.deepEqual([prices[model].read, prices[model].fiveMinute, prices[model].oneHour, prices[model].source], [0.2, 2.5, 4, 'price feed']);
  }
  assert.equal(prices['claude-sonnet-5'].source, 'Anthropic pricing');
  near(prices['claude-sonnet-5'].read, 0.1);
  const exact = { version: 1, models: { 'claude-opus-5-5': { input: 1, read: 0.9, write: 1, output: 1 } }, patterns: feed.patterns };
  const won = await lookUpPrices(['claude-opus-5-5'], { fetcher: async () => new Response(JSON.stringify(exact)), feed: { base: 'https://gateway.example' } });
  assert.equal(won.prices['claude-opus-5-5'].read, 0.9);
  const none = await lookUpPrices(['claude-opus-5-5'], { fetcher: async () => new Response('x', { status: 404 }), feed: { base: 'https://gateway.example' } });
  assert.equal(none.prices['claude-opus-5-5'].source, 'Anthropic pricing');
});
