import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDefaultTtl, createTtlGate, isTtl } from '../lib/cache-ttl.js';

const resolve = (scope, overrides = {}) => resolveDefaultTtl({ scope, env: {}, settings: {}, auth: 'gateway', ...overrides });

test('without any setting, Claude Code uses 5m on API keys and gateways and 1h for a subscription main conversation', () => {
  assert.deepEqual(resolve('main'), { ttl: '5m', reason: 'Claude Code default for API keys and gateways', locked: false });
  assert.deepEqual(resolve('main', { auth: 'api-key' }), { ttl: '5m', reason: 'Claude Code default for API keys and gateways', locked: false });
  assert.deepEqual(resolve('main', { auth: 'subscription' }), { ttl: '1h', reason: 'Claude Code default for a Claude subscription', locked: false });
  assert.deepEqual(resolve('subagent', { auth: 'subscription' }), { ttl: '5m', reason: 'Claude Code default outside the main conversation', locked: false });
});

test('each scope follows its own environment variable, then its own setting', () => {
  assert.equal(resolve('main', { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } }).ttl, '1h');
  assert.equal(resolve('main', { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } }).reason, 'CLAUDE_CODE_PROMPT_CACHE_TTL');
  assert.equal(resolve('subagent', { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } }).ttl, '5m');
  assert.equal(resolve('subagent', { env: { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' } }).ttl, '1h');
  assert.deepEqual(resolve('main', { settings: { promptCacheTtl: '1h' } }), { ttl: '1h', reason: 'promptCacheTtl in your Claude Code settings', locked: false });
  assert.deepEqual(resolve('subagent', { settings: { subagentPromptCacheTtl: '1h' } }), { ttl: '1h', reason: 'subagentPromptCacheTtl in your Claude Code settings', locked: false });
  assert.equal(resolve('main', { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, settings: { promptCacheTtl: '1h' } }).ttl, '5m');
  for (const value of ['', '2h', '1H', 3600, null]) {
    assert.equal(resolve('main', { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: value } }).ttl, '5m');
    assert.equal(resolve('main', { settings: { promptCacheTtl: value } }).ttl, '5m');
  }
});

test('the 1h switches and the forced 5m follow Claude Code precedence', () => {
  assert.deepEqual(resolve('subagent', { env: { ENABLE_PROMPT_CACHING_1H: '1' } }), { ttl: '1h', reason: 'ENABLE_PROMPT_CACHING_1H', locked: false });
  assert.equal(resolve('main', { env: { ENABLE_PROMPT_CACHING_1H: 'true' } }).ttl, '1h');
  assert.equal(resolve('main', { env: { ENABLE_PROMPT_CACHING_1H: '1' }, settings: { promptCacheTtl: '5m' } }).ttl, '5m');
  assert.equal(resolve('main', { env: { ENABLE_PROMPT_CACHING_1H_BEDROCK: '1' } }).ttl, '5m');
  assert.equal(resolve('main', { env: { ENABLE_PROMPT_CACHING_1H_BEDROCK: '1', CLAUDE_CODE_USE_BEDROCK: '1' } }).ttl, '1h');
  assert.equal(resolve('main', { env: { ENABLE_PROMPT_CACHING_1H: '0' } }).ttl, '5m');
  const forced = resolve('main', { env: { FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, auth: 'subscription' });
  assert.deepEqual(forced, { ttl: '5m', reason: 'FORCE_PROMPT_CACHING_5M', locked: true });
  assert.equal(isTtl('5m') && isTtl('1h') && !isTtl('default') && !isTtl(undefined), true);
});

function recorder() {
  const writes = [];
  let value = null;
  const gate = createTtlGate(async next => { writes.push(next); value = next; });
  return { gate, writes, now: () => value };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('requests wanting the same TTL share it, and the base value returns when they are done', async () => {
  const { gate, writes, now } = recorder();
  const first = await gate.acquire('1h');
  const second = await gate.acquire('1h');
  assert.deepEqual(writes, ['1h']);
  await first();
  assert.equal(now(), '1h');
  await second();
  assert.deepEqual(writes, ['1h', null]);
  await second();
  assert.deepEqual(writes, ['1h', null]);
});

test('a request wanting the base value writes nothing when nothing else holds the gate', async () => {
  const { gate, writes } = recorder();
  const release = await gate.acquire(null);
  await release();
  assert.deepEqual(writes, []);
});

test('a request wanting a different TTL waits its turn, and later arrivals queue behind it', async () => {
  const { gate, writes, now } = recorder();
  const order = [];
  const a = await gate.acquire('5m');
  order.push('a');
  const b = gate.acquire('1h').then(release => { order.push(`b:${now()}`); return release; });
  await tick();
  const c = gate.acquire('5m').then(release => { order.push(`c:${now()}`); return release; });
  await tick();
  assert.deepEqual(order, ['a']);
  await a();
  const releaseB = await b;
  await tick();
  assert.deepEqual(order, ['a', 'b:1h']);
  await releaseB();
  const releaseC = await c;
  assert.deepEqual(order, ['a', 'b:1h', 'c:5m']);
  await releaseC();
  assert.deepEqual(writes, ['5m', '1h', '5m', null]);
});
