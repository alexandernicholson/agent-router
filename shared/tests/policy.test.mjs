import test from 'node:test';
import assert from 'node:assert/strict';
import { priceFeed, parsePriceFeed, feedPrice, policyUrl, parsePolicy, pickRow, createPolicyClient, createReportClient, reportsUrl, REPORT_QUEUE, REPORT_STOP_MS, POLICY_TTL_MS, POLICY_STALE_MS } from '../lib/policy.mjs';

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
  assert.deepEqual(parsePolicy(body([row()])), [{ status: 'enabled', safe: 480, maxIdle: 3600, bucket: 12, refreshOnRead: null, anchorOnStart: false, maxAgeMs: null, source: null, pResume: null, reason: null }]);
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
  assert.deepEqual(rows[0], { status: 'enabled', safe: null, maxIdle: null, bucket: 0, refreshOnRead: null, anchorOnStart: false, maxAgeMs: null, source: null, pResume: null, reason: null });
  assert.deepEqual(rows[1], { status: 'shadow', safe: 60, maxIdle: 90, bucket: 3, refreshOnRead: null, anchorOnStart: false, maxAgeMs: null, source: null, pResume: null, reason: null });
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

test('speaks is true only after a valid 200 answer, including empty rows, for an hour', async () => {
  let reply = { status: 404, text: '' };
  const client = createPolicyClient({ fetch: async () => reply });
  assert.equal(client.speaks(0), false);
  await client.refresh('https://gateway.example', 'a', 's', 0);
  assert.equal(client.speaks(0), false);
  reply = { status: 200, text: JSON.stringify({ rows: [] }) };
  await client.refresh('https://gateway.example', 'b', 's', 0);
  assert.equal(client.speaks(1), true);
  assert.equal(client.speaks(POLICY_STALE_MS), false);
  const failing = createPolicyClient({ fetch: async () => ({ status: 500, text: '' }) });
  await failing.refresh('https://gateway.example', 'a', 's', 0);
  assert.equal(failing.speaks(0), false);
});

test('the policy URL carries the client heartbeat and reportsUrl follows the same safety rules', () => {
  assert.equal(policyUrl('https://g.example', 'a', 's', 'keepalive/0.4.2'), 'https://g.example/v1/cache/policy?alias=a&session=s&client=keepalive%2F0.4.2');
  assert.equal(policyUrl('https://g.example', 'a', undefined, 'k/1', 'pi'), 'https://g.example/v1/cache/policy?alias=a&client=k%2F1&harness=pi');
  assert.equal(reportsUrl('https://g.example/'), 'https://g.example/v1/cache/reports');
  for (const bad of ['https://api.anthropic.com', 'http://g.example', undefined, 'https://u:p@g.example']) assert.equal(reportsUrl(bad), null);
});

test('the policy client sends its heartbeat in the query', async () => {
  const urls = [];
  const client = createPolicyClient({ fetch: async url => { urls.push(url); return { status: 200, text: body([row()]) }; }, client: 'keepalive/1.2.3', harness: 'omp' });
  await client.refresh('https://g.example', 'a', 's', 0);
  assert.match(urls[0], /client=keepalive%2F1\.2\.3&harness=omp/);
});

test('reports are batched, bounded, retried with backoff and stopped for an hour by a 404', async () => {
  const calls = [];
  let status = 200;
  let boom = false;
  const client = createReportClient({ client: 'keepalive/1', headers: async () => ({ authorization: 'x' }),
    fetch: async (url, init) => { calls.push(JSON.parse(init.body)); if (boom) throw new Error('down'); return { status }; } });
  const report = n => ({ kind: 'keepalive', n });
  const withHarness = createReportClient({ client: 'k/1', harness: 'pi', fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return { status: 202 }; } });
  withHarness.add(report(0), 0);
  await withHarness.flush('https://g.example', 0);
  assert.equal(calls.pop().harness, 'pi');
  const base = 'https://g.example';
  await client.flush(base, 0);
  assert.equal(calls.length, 0);
  for (let n = 0; n < 120; n++) client.add(report(n), 0);
  await client.flush('http://insecure.example', 0);
  assert.equal(calls.length, 0);
  await client.flush(base, 0);
  assert.deepEqual(calls.map(call => call.reports.length), [50, 50, 20]);
  assert.equal(client.size, 0);
  for (let n = 0; n < 250; n++) client.add(report(n), 1);
  assert.equal(client.size, REPORT_QUEUE);
  boom = true;
  await client.flush(base, 10);
  assert.equal(client.size, REPORT_QUEUE);
  const attempts = calls.length;
  await client.flush(base, 10 + 29999);
  assert.equal(calls.length, attempts);
  boom = false;
  const first = client.flush(base, 40000);
  assert.equal(client.flush(base, 40000), first);
  await first;
  assert.equal(client.size, 0);
  status = 500;
  client.add(report(1), 50000);
  await client.flush(base, 50000);
  assert.equal(client.size, 1);
  status = 404;
  await client.flush(base, 50000 + 600000);
  assert.equal(client.size, 0);
  client.add(report(2), 700000);
  assert.equal(client.size, 0);
  client.add(report(3), 650000 + REPORT_STOP_MS);
  assert.equal(client.size, 1);
});
