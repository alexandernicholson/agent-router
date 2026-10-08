import test from 'node:test';
import assert from 'node:assert/strict';
import { priceFeed, parsePriceFeed, feedPrice, policyUrl, parsePolicy, pickRow, createPolicyClient, POLICY_TTL_MS, POLICY_STALE_MS } from '../lib/policy.mjs';

const row = (extra = {}) => ({ alias: 'kimi-k3', status: 'enabled', safe_refresh_s: 480, max_idle_s: 3600, prefix_bucket: 12,
  upstream_provider: 'phala', upstream_model: 'moonshotai/kimi-k3', ...extra });
const body = rows => JSON.stringify({ rows, server_now: 1 });

test('the policy URL is built only for a safe non-Anthropic gateway', () => {
  assert.equal(policyUrl('https://gateway.example/', 'kimi-k3', 's 1'), 'https://gateway.example/v1/cache/policy?alias=kimi-k3&session=s+1');
  assert.equal(policyUrl('https://gateway.example/prefix', 'a'), 'https://gateway.example/prefix/v1/cache/policy?alias=a');
  assert.equal(policyUrl('http://127.0.0.1:8080', 'a'), 'http://127.0.0.1:8080/v1/cache/policy?alias=a');
  for (const base of [undefined, '', 'nonsense', 'https://api.anthropic.com', 'https://API.anthropic.com/', 'http://gateway.example', 'https://u:p@gateway.example']) {
    assert.equal(policyUrl(base, 'a'), null, String(base));
  }
});

test('parsePolicy keeps valid rows and rejects oversized or malformed bodies', () => {
  assert.deepEqual(parsePolicy(body([row()])), [{ status: 'enabled', safe: 480, maxIdle: 3600, bucket: 12, refreshOnRead: null, source: null, pResume: null, reason: null, provider: 'phala', model: 'moonshotai/kimi-k3' }]);
  assert.deepEqual(parsePolicy(body([row({ refresh_on_read: true }), row({ refresh_on_read: false })])).map(r => r.refreshOnRead), [true, false]);
  assert.equal(parsePolicy(body([row({ refresh_on_read: 'yes' }), row({ refresh_on_read: 1 })])), null);
  assert.equal(parsePolicy(body([row({ status: 'weird' }), row({ safe_refresh_s: -1 }), row({ safe_refresh_s: 1.5 })])), null);
  assert.deepEqual(parsePolicy(body([])), []);
  assert.equal(parsePolicy(body([row({ status: 'monitor', reason: 'ttl_too_short' })]))[0].status, 'monitor');
  assert.equal(parsePolicy('not json'), null);
  assert.equal(parsePolicy('{}'), null);
  assert.equal(parsePolicy(body([row()]) + ' '.repeat(70000)), null);
});

test('pickRow takes the largest bucket not above the prefix and the most cautious tie', () => {
  const rows = parsePolicy(body([row({ prefix_bucket: 10, safe_refresh_s: 600 }), row({ prefix_bucket: 14, safe_refresh_s: 300 }),
    row({ prefix_bucket: 14, safe_refresh_s: 200 }), row({ prefix_bucket: 14, status: 'shadow' })]));
  assert.equal(pickRow(rows, 2 ** 12).safe, 600);
  assert.equal(pickRow(rows, 2 ** 15).status, 'shadow');
  assert.equal(pickRow(rows.filter(r => r.status === 'enabled'), 2 ** 15).safe, 200);
  assert.equal(pickRow(rows, 100), undefined);
});

test('the client caches ten minutes, serves stale rows for an hour while refreshing or failing, and backs off after errors', async () => {
  const calls = [];
  let reply = { status: 200, text: body([row()]) };
  const client = createPolicyClient({ fetch: async (url, init) => { calls.push([url, init]); if (reply instanceof Error) throw reply; return reply; },
    headers: async () => ({ authorization: 'Bearer t' }) });
  const base = 'https://gateway.example';
  await client.refresh(base, 'kimi-k3', 's', 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].headers.authorization, 'Bearer t');
  await client.refresh(base, 'kimi-k3', 's', POLICY_TTL_MS - 1);
  assert.equal(calls.length, 1);
  assert.equal(client.peek('kimi-k3', POLICY_TTL_MS - 1).length, 1);
  assert.equal(client.peek('kimi-k3', POLICY_TTL_MS).length, 1);
  reply = new Error('down');
  await client.refresh(base, 'kimi-k3', 's', POLICY_TTL_MS);
  await client.refresh(base, 'kimi-k3', 's', POLICY_TTL_MS + 29000);
  assert.equal(calls.length, 2);
  await client.refresh(base, 'kimi-k3', 's', POLICY_TTL_MS + 30000);
  await client.refresh(base, 'kimi-k3', 's', POLICY_TTL_MS + 89000);
  assert.equal(calls.length, 3);
  reply = { status: 302, text: '' };
  await client.refresh(base, 'kimi-k3', 's', POLICY_TTL_MS + 90000);
  assert.equal(client.peek('kimi-k3', POLICY_TTL_MS + 90000).length, 1);
  assert.equal(client.peek('kimi-k3', POLICY_STALE_MS - 1).length, 1);
  assert.equal(client.peek('kimi-k3', POLICY_STALE_MS), null);
  assert.equal(client.peek('never-asked', 0), null);
  reply = { status: 404, text: 'none' };
  await client.refresh(base, 'kimi-k3', 's', POLICY_STALE_MS + 1000000);
  assert.deepEqual(client.peek('kimi-k3', POLICY_STALE_MS + 1000000), []);
  await client.refresh('https://api.anthropic.com', 'other', 's', 0);
  assert.equal(calls.length, 5);
});

test('policy rows take defaults for missing fields and a lookup in flight is shared', async () => {
  const rows = parsePolicy(JSON.stringify({ rows: [{ status: 'enabled' }, { status: 'shadow', alias: 'a', safe_refresh_s: 60, max_idle_s: 90, prefix_bucket: 3, upstream_provider: 'p', upstream_model: 'm' }] }));
  assert.deepEqual(rows[0], { status: 'enabled', safe: null, maxIdle: null, bucket: 0, refreshOnRead: null, source: null, pResume: null, reason: null, provider: null, model: null });
  assert.deepEqual(rows[1], { status: 'shadow', safe: 60, maxIdle: 90, bucket: 3, refreshOnRead: null, source: null, pResume: null, reason: null, provider: 'p', model: 'm' });
  let release;
  let calls = 0;
  const client = createPolicyClient({ fetch: () => { calls++; return new Promise(resolve => { release = () => resolve({ status: 200, text: JSON.stringify({ rows: [{ status: 'enabled', safe_refresh_s: 60 }] }) }); }); } });
  const first = client.refresh('https://gw.example', 'm', 's', 0);
  await Promise.resolve();
  const second = client.refresh('https://gw.example', 'm', 's', 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('rows carry a source, a resume hint and a reason, and no_cache is a status', () => {
  const [a, b, c] = parsePolicy(body([row({ source: 'documented', p_resume: 0.4, reason: 'kill switch', status: 'no_cache' }), row({ source: 'weird', p_resume: 2 }), row({ p_resume: 'x' })]));
  assert.deepEqual([a.status, a.source, a.pResume, a.reason], ['no_cache', 'documented', 0.4, 'kill switch']);
  assert.deepEqual([b.source, b.pResume, c.pResume], [null, null, null]);
});

test('the price feed is the gateway default, a user URL, or off, and credentials stay on the gateway origin', () => {
  assert.deepEqual(priceFeed('https://gateway.example/p', ''), { url: 'https://gateway.example/p/v1/cache/prices', authorize: true });
  assert.deepEqual(priceFeed('https://gateway.example', 'default'), { url: 'https://gateway.example/v1/cache/prices', authorize: true });
  assert.equal(priceFeed('https://api.anthropic.com', undefined), null);
  assert.equal(priceFeed('https://gateway.example', 'off'), null);
  assert.deepEqual(priceFeed('https://gateway.example', 'https://gateway.example/my.json#x'), { url: 'https://gateway.example/my.json', authorize: true });
  assert.deepEqual(priceFeed('https://gateway.example', 'https://other.example/my.json'), { url: 'https://other.example/my.json', authorize: false });
  assert.deepEqual(priceFeed(undefined, 'http://localhost:9/p.json'), { url: 'http://localhost:9/p.json', authorize: false });
  assert.deepEqual(priceFeed('https://api.anthropic.com', 'https://api.anthropic.com/x'), { url: 'https://api.anthropic.com/x', authorize: false });
  for (const bad of ['nonsense', 'http://other.example/p', 'https://u:p@other.example/p']) assert.equal(priceFeed('https://gateway.example', bad), null);
});

test('a price feed maps relative units, exact models and glob patterns, and skips unusable entries', () => {
  const feed = parsePriceFeed(JSON.stringify({ version: 1,
    models: { a: { input: 2, read: 0.2, write: 2.5, output: 10 }, b: { input: 0, read: 1, write: 1, output: 1 }, c: { input: 1 }, d: null, 'claude-opus-5-5': { input: 1, read: 1, write: 1, output: 1 } },
    patterns: { 'claude-opus-*': { input: 5, read: 0.5, write: 6.25, write_1h: 10, output: 25 }, '*': { input: 1, read: 1, write: 1, write_1h: 'x', output: 1 }, bad: { input: 0 }, ['x'.repeat(201)]: { input: 1, read: 1, write: 1, output: 1 } } }));
  assert.deepEqual(feedPrice(feed, 'a'), { read: 0.1, fiveMinute: 1.25, output: 5 });
  assert.equal(feedPrice(feed, 'claude-opus-5-5').read, 1);
  assert.deepEqual(feedPrice(feed, 'claude-opus-5-1'), { read: 0.1, fiveMinute: 1.25, oneHour: 2, output: 5 });
  assert.deepEqual(feedPrice(feed, 'CLAUDE-OPUS-4[1M]'), { read: 0.1, fiveMinute: 1.25, oneHour: 2, output: 5 });
  assert.equal(feedPrice(feed, 'gpt-5').oneHour, undefined);
  assert.equal(feedPrice(feed, 'b'), feedPrice(feed, 'b'));
  assert.equal(feedPrice(parsePriceFeed(JSON.stringify({ version: 1, models: {} })), 'x'), null);
  assert.equal(feedPrice(parsePriceFeed(JSON.stringify({ version: 1, models: {}, patterns: [] })), 'constructor'), null);
  for (const bad of ['{', JSON.stringify({ version: 2, models: {} }), JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, models: [] }), 'x'.repeat(70000), 5]) assert.equal(parsePriceFeed(bad), null);
});

test('every served source is accepted, including probe and override', () => {
  const sources = parsePolicy(body(['learned', 'documented', 'default', 'override', 'probe'].map(source => row({ source })))).map(r => r.source);
  assert.deepEqual(sources, ['learned', 'documented', 'default', 'override', 'probe']);
});
