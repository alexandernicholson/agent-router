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

function recorder(base = '5m', live = () => []) {
  const writes = [];
  let timers = [];
  let clock = 0;
  let value = null;
  const gate = createTtlGate(async next => { writes.push(next); value = next; },
    { base, buildMs: 1000, live: () => live(), sleep: ms => new Promise(resolve => timers.push({ at: clock + ms, fire: resolve })) });
  const advance = async ms => {
    clock += ms;
    const due = timers.filter(timer => timer.at <= clock);
    timers = timers.filter(timer => timer.at > clock);
    for (const timer of due) timer.fire();
    await tick();
  };
  return { gate, writes, advance, now: () => value };
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

test('a request wanting a different TTL waits while another is being built, and later arrivals queue behind it', async () => {
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

test('once a request is built, the variable returns to your own default, which reads its cache whatever TTL it wrote', async () => {
  const { gate, writes, advance, now } = recorder('5m');
  const release = await gate.acquire('1h');
  assert.equal(now(), '1h');
  await advance(999);
  assert.equal(now(), '1h');
  await advance(1);
  assert.equal(now(), null);
  await release();
  assert.deepEqual(writes, ['1h', null]);
});

test('with a 1h default, the variable rests on 5m while a request that wants 5m is still answering', async () => {
  const { gate, writes, advance, now } = recorder('1h');
  const release = await gate.acquire('5m');
  await advance(600000);
  assert.equal(now(), '5m');
  await release();
  assert.equal(now(), null);
  assert.deepEqual(writes, ['5m', null]);
});

test('with a 1h default, the variable rests on 5m while any conversation still running wants 5m, and returns when none does', async () => {
  let live = ['1h', '5m'];
  const { gate, writes, now } = recorder('1h', () => live);
  await gate.refresh();
  assert.equal(now(), '5m');
  live = ['1h'];
  await gate.refresh();
  assert.equal(now(), null);
  const { gate: plain, writes: none } = recorder('5m', () => ['5m', '1h']);
  await plain.refresh();
  assert.deepEqual(none, []);
  assert.deepEqual(writes, ['5m', null]);
});

test('a request wanting another TTL waits only while a long response is being sent, never for its answer', async () => {
  const { gate, advance, now } = recorder();
  const streaming = await gate.acquire('1h');
  const started = [];
  const other = gate.acquire(null).then(release => { started.push(now()); return release; });
  await advance(999);
  assert.deepEqual(started, []);
  await advance(1);
  const releaseOther = await other;
  assert.deepEqual(started, [null]);
  const late = gate.acquire('1h').then(release => { started.push(now()); return release; });
  await advance(999);
  assert.deepEqual(started, [null]);
  await advance(1);
  const releaseLate = await late;
  assert.deepEqual(started, [null, '1h']);
  await advance(1000);
  assert.equal(now(), null);
  await Promise.all([releaseOther(), releaseLate(), streaming()]);
  assert.equal(now(), null);
});

test('every waiter wanting the TTL that comes next starts with it, whatever its place in the queue', async () => {
  const { gate, advance, now } = recorder();
  await gate.acquire(null);
  const order = [];
  const track = (name, value) => gate.acquire(value).then(release => { order.push(`${name}:${now()}`); return release; });
  const waiting = [track('a', '1h'), track('b', '5m'), track('c', '1h'), track('d', '5m')];
  await advance(1000);
  assert.deepEqual(order, ['a:1h', 'c:1h']);
  await advance(1000);
  assert.deepEqual(order, ['a:1h', 'c:1h', 'b:5m', 'd:5m']);
  await Promise.all(waiting);
});

const BUILD = 1000;

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

async function schedule(seed) {
  const next = random(seed);
  const pick = list => list[Math.floor(next() * list.length)];
  const base = pick(['5m', '1h']);
  let now = 0;
  let timers = [];
  let env = null;
  const failures = [];
  const requests = [];
  const pending = () => requests.filter(request => request.grantedAt === undefined);
  const answering = () => requests.filter(request => request.grantedAt !== undefined && request.releasedAt === undefined);
  const building = () => answering().filter(request => now - request.grantedAt < BUILD);
  const gate = createTtlGate(async value => {
    for (const holder of building()) if (holder.value !== value) failures.push(`t=${now}: ${holder.id} (${holder.value}) lost its TTL to ${value} while being built`);
    env = value;
  }, { base, buildMs: BUILD, live: () => [], sleep: ms => new Promise(resolve => timers.push({ at: now + ms, fire: resolve })) });
  const values = [null, '5m', '1h'];
  const count = 4 + Math.floor(next() * 14);
  let at = 0;
  const plan = [];
  for (let id = 0; id < count; id++) {
    at += pick([0, 0, 10, 300, 900, 2500, 6000]);
    plan.push({ id: `r${id}`, at, value: pick(values), lasts: pick([20, 400, 1500, 8000, 45000, Infinity]) });
  }
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
  const releases = [];
  const end = at + 120000;
  while (now <= end) {
    for (const item of plan.filter(item => item.at === now)) {
      const request = { id: item.id, value: item.value, arrivedAt: now };
      requests.push(request);
      gate.acquire(item.value).then(release => {
        request.grantedAt = now;
        if (env !== request.value) failures.push(`t=${now}: ${request.id} started with ${env} instead of ${request.value}`);
        if (now - request.arrivedAt > new Set(plan.map(entry => entry.value)).size * BUILD) failures.push(`t=${now}: ${request.id} waited ${now - request.arrivedAt}ms`);
        if (item.lasts !== Infinity) releases.push({ at: now + item.lasts, run: async () => { request.releasedAt = now; await release(); } });
      });
    }
    await flush();
    const due = timers.filter(timer => timer.at <= now);
    timers = timers.filter(timer => timer.at > now);
    for (const timer of due) timer.fire();
    await flush();
    for (const release of releases.filter(item => item.at <= now)) { releases.splice(releases.indexOf(release), 1); await release.run(); }
    await flush();
    if (!building().length && !pending().length) {
      const rest = base === '1h' && answering().some(request => (request.value ?? base) === '5m') ? '5m' : null;
      if (env !== rest) failures.push(`t=${now}: the variable rests on ${env} instead of ${rest} with ${answering().map(request => request.value).join(', ')} answering`);
    }
    const upcoming = [...plan.map(item => item.at), ...timers.map(timer => timer.at), ...releases.map(item => item.at)].filter(time => time > now);
    if (!upcoming.length) break;
    now = Math.min(...upcoming);
  }
  for (const request of pending()) failures.push(`${request.id} (${request.value}) never started`);
  return failures;
}

test('in random mixes of requests wanting every TTL, each is built with its own TTL after waiting at most a second for each TTL wanted, and otherwise the variable rests on your default, or 5m when it is 1h and a request answering wants 5m', async () => {
  for (let seed = 1; seed <= 400; seed++) {
    const failures = await schedule(seed);
    assert.deepEqual(failures, [], `seed ${seed}`);
  }
});
