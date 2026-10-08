import test from 'node:test';
import assert from 'node:assert/strict';
import { policyUrl, parsePolicy, pickRow, createPolicyClient, POLICY_TTL_MS } from '../lib/policy.mjs';

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
  assert.deepEqual(parsePolicy(body([row()])), [{ status: 'enabled', safe: 480, maxIdle: 3600, bucket: 12, refreshOnRead: null, provider: 'phala', model: 'moonshotai/kimi-k3' }]);
  assert.deepEqual(parsePolicy(body([row({ refresh_on_read: true }), row({ refresh_on_read: false })])).map(r => r.refreshOnRead), [true, false]);
  assert.equal(parsePolicy(body([row({ refresh_on_read: 'yes' }), row({ refresh_on_read: 1 })])).length, 0);
  assert.equal(parsePolicy(body([row({ status: 'weird' }), row({ safe_refresh_s: -1 }), row({ safe_refresh_s: 1.5 })])).length, 0);
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

test('the client caches ten minutes, never serves stale rows and backs off after errors', async () => {
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
  assert.equal(client.peek('kimi-k3', POLICY_TTL_MS), null);
  reply = new Error('down');
  await client.refresh(base, 'kimi-k3', 's', POLICY_TTL_MS);
  await client.refresh(base, 'kimi-k3', 's', POLICY_TTL_MS + 29000);
  assert.equal(calls.length, 2);
  await client.refresh(base, 'kimi-k3', 's', POLICY_TTL_MS + 30000);
  await client.refresh(base, 'kimi-k3', 's', POLICY_TTL_MS + 89000);
  assert.equal(calls.length, 3);
  reply = { status: 302, text: '' };
  await client.refresh(base, 'kimi-k3', 's', POLICY_TTL_MS + 90000);
  assert.equal(client.peek('kimi-k3', POLICY_TTL_MS + 90000), null);
  await client.refresh('https://api.anthropic.com', 'other', 's', 0);
  assert.equal(calls.length, 4);
});

test('policy rows take defaults for missing fields and a lookup in flight is shared', async () => {
  const rows = parsePolicy(JSON.stringify({ rows: [{ status: 'enabled' }, { status: 'shadow', alias: 'a', safe_refresh_s: 60, max_idle_s: 90, prefix_bucket: 3, upstream_provider: 'p', upstream_model: 'm' }] }));
  assert.deepEqual(rows[0], { status: 'enabled', safe: null, maxIdle: null, bucket: 0, refreshOnRead: null, provider: null, model: null });
  assert.deepEqual(rows[1], { status: 'shadow', safe: 60, maxIdle: 90, bucket: 3, refreshOnRead: null, provider: 'p', model: 'm' });
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
