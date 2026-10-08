import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheRows, cacheStatus, cacheDial, lifeGrade, lifetimeOf, lifetimeLabel, lifetimeStatus, policyAction, clientTtl, savingsWorthwhile,
  keepaliveWorthwhile, keepalivesLeft, unreportedModels, POLICY_TICK_MS, SOURCE_ICONS } from '../lib/cache.js';
import { pickRow, parsePolicy, createPolicyClient, POLICY_STALE_MS } from '../lib/shared/policy.mjs';

const base = (extra = {}) => ({ sessionId: 's', agentId: null, turnId: 'turn', index: 0, model: 'glm-5.3', startedAt: 1000, completedAt: 2000,
  read: 0, write: 30000, fresh: 10, output: 20, ttlMs: null, ttlSource: 'none', disabled: false, requested: '1h', ...extra });
const keep = (i, extra = {}) => base({ turnId: `keepalive:${i}`, startedAt: 100000 * (i + 1), completedAt: 100000 * (i + 1) + 100, read: 30000, write: 0, ...extra });
const rowOf = (extra = {}, ...keepalives) => cacheRows([base(extra), ...keepalives])[0];
const serve = (extra = {}) => ({ status: 'enabled', safe: 1680, maxIdle: null, refreshOnRead: true, source: 'documented', pResume: null, reason: null, ...extra });
const PRICES = { read: 0.1, fiveMinute: 1.25, output: 5 };

// --- lifetime sources: label, icon, dial, TTL chip, marker source ---------------------------------------------------------------------
const SOURCES = [
  ['learned', serve({ source: 'learned', safe: 480 }), null, '✦', 'learned', true],
  ['documented', serve({ source: 'documented', safe: 1680 }), null, '▣', 'documented', true],
  ['probe', serve({ source: 'probe', safe: 1800, refreshOnRead: null }), null, '⟳', 'probe', true],
  ['override', serve({ source: 'override', safe: 600 }), null, '◇', 'override', true],
  ['default', serve({ source: 'default', safe: 229, refreshOnRead: null }), null, '◇', 'default', true],
  ['server row without source', serve({ source: null }), null, '✦', 'learned', true],
  ...['5m', '15m', '30m', '45m', '1h'].map(ttl => [`client ${ttl}`, undefined, ttl, '✎', 'client', true]),
  ['client over insufficient_data', { status: 'insufficient_data', safe: null }, '15m', '✎', 'client', true],
  ['client over deprecated shadow', { status: 'shadow', safe: null }, '15m', '✎', 'client', true],
  ['no_cache', serve({ status: 'no_cache', safe: null }), '15m', '⊘', undefined, false],
  ['monitor ttl_too_short', serve({ status: 'monitor', reason: 'ttl_too_short' }), '15m', '◌', undefined, false],
  ['monitor below_economic_floor', serve({ status: 'monitor', reason: 'below_economic_floor' }), '15m', '◌', undefined, false],
  ['monitor unreliable_cache', serve({ status: 'monitor', reason: 'unreliable_cache' }), '15m', '◌', undefined, false],
  ['monitor pressure', serve({ status: 'monitor', reason: 'pressure' }), '15m', '◌', undefined, false],
  ['demoted', serve({ status: 'demoted', reason: 'misses' }), '15m', '◌', undefined, false],
  ['fixed_window status', serve({ status: 'fixed_window' }), '15m', '◌', undefined, false],
  ['native status', serve({ status: 'native' }), '15m', '◌', undefined, false],
  ['no server row and no client TTL', undefined, null, '◌', undefined, false],
];
for (const [name, server, clientChoice, icon, src, active] of SOURCES) {
  test(`matrix source: ${name}`, () => {
    const row = rowOf();
    const client = clientChoice ? clientTtl('glm-5.3', clientChoice) : null;
    const life = lifetimeOf(row, server, client);
    assert.equal(!!life.policy, active, 'actionable');
    if (src) assert.equal(life.source, src);
    const status = lifetimeStatus(row, life, 100000, cacheStatus(row, 100000));
    const label = lifetimeLabel({ ...life, left: Math.ceil((status.leftMs ?? 0) / 1000), phase: status.phase }, status.state);
    assert.ok(label.startsWith(icon), `${label} starts with ${icon}`);
    if (active) {
      assert.ok(status.leftMs > 0 && status.leftMs <= life.policy.safe * 1000);
      assert.notEqual(cacheDial(status), '◌');
      assert.notEqual(lifeGrade(status.leftMs), null);
      assert.ok(!label.includes('◉'));
    }
  });
}

// --- native rows -----------------------------------------------------------------------------------------------------------------------
const NATIVE = [['native 5m', { fiveMinute: 100, oneHour: 0 }, '5m'], ['native 1h', { fiveMinute: 0, oneHour: 100 }, '1h'], ['native mixed', { fiveMinute: 50, oneHour: 50 }, '5m+1h']];
for (const [name, cacheCreation, ttl] of NATIVE) {
  test(`matrix ${name} is native and never governed by a lifetime`, () => {
    const row = rowOf({ model: 'claude-opus-5', write: 100, read: 900, cacheCreation, ttlMs: 300000, requested: '5m' });
    assert.equal(cacheStatus(row, 3000).ttl, ttl);
    assert.equal(lifetimeOf(row, serve(), 900000).source, 'native');
    assert.equal(policyAction(row, lifetimeOf(row, serve(), 900000).policy, 3000).action, 'monitor');
  });
}
test('matrix: a Claude write awaiting its report within 30s is shown from the requested TTL; a gateway model never is', () => {
  const claude = rowOf({ model: 'claude-opus-5', write: 100, read: 0, requested: '1h' });
  assert.equal(cacheStatus(claude, 5000).ttl, '1h');
  assert.equal(cacheStatus(claude, 40000).state, 'TTL not reported');
  for (const model of ['glm-5.3', 'gpt-5.6', 'gateway-code-task', 'kimi-k3[1m]']) {
    const row = rowOf({ model, write: 30200, read: 0, requested: '1h' });
    const status = cacheStatus(row, 5000);
    assert.equal(status.ttl, undefined, model);
    assert.equal(status.state, 'TTL not reported');
    assert.equal(status.leftMs, null);
    assert.ok(!unreportedModels([row], 100000).has('claude'));
  }
});

// --- actions over timing, refresh_on_read, anchors ---------------------------------------------------------------------------------------
const SAFE = 480;
const policyFor = refreshOnRead => ({ status: 'enabled', safe: SAFE, maxIdle: null, refreshOnRead });
const TIMES = [['well before', 2000 + 100000, 'wait'], ['one tick before the window', 2000 + SAFE * 1000 - POLICY_TICK_MS - 1, 'wait'],
  ['inside the window', 2000 + SAFE * 1000 - 1000, 'fire'], ['exactly at due', 2000 + SAFE * 1000, 'fire'], ['after due', 2000 + SAFE * 1000 + 1, 'missed'],
  ['after a long sleep', 2000 + SAFE * 1000 * 20, 'missed']];
for (const refresh of [true, null]) for (const [when, now, action] of TIMES) {
  test(`matrix timing: refresh_on_read ${refresh}, ${when}`, () => {
    const result = policyAction(rowOf(), policyFor(refresh), now);
    assert.equal(result.action, action);
    assert.equal(result.dueAt, 2000 + SAFE * 1000);
  });
}
for (const [when, now, action] of TIMES) {
  test(`matrix timing: fixed window (false), ${when}`, () => {
    const row = rowOf({ read: 0, write: 30000 });
    assert.equal(policyAction(row, policyFor(false), now).action, action);
  });
}
test('matrix keepalive outcomes', () => {
  const read = rowOf({}, keep(0));
  const wrote = rowOf({}, keep(0, { read: 0, write: 30000 }));
  assert.equal(policyAction(read, policyFor(true), 150000).dueAt, 100100 + SAFE * 1000);
  assert.equal(policyAction(wrote, policyFor(true), 150000).dueAt, 2000 + SAFE * 1000);
  for (const refresh of [null, false]) {
    assert.equal(policyAction(read, policyFor(refresh), 150000).action, 'sent');
    assert.equal(policyAction(wrote, policyFor(refresh), 150000).action, 'sent');
  }
  assert.equal(policyAction(rowOf({}, keep(0, { model: 'other' })), policyFor(null), 150000).action, 'wait');
});
test('matrix: max idle, in flight, no safe time and non-enabled policies', () => {
  assert.equal(policyAction(rowOf(), { ...policyFor(true), maxIdle: 100 }, 2000 + 100000).action, 'idle');
  assert.equal(policyAction(rowOf(), { ...policyFor(true), safe: null }, 5000).action, 'monitor');
  for (const status of ['no_cache', 'monitor', 'demoted', 'fixed_window', 'native', 'insufficient_data', 'shadow']) assert.equal(policyAction(rowOf(), { ...policyFor(true), status }, 5000).action, 'monitor');
  assert.equal(policyAction(undefined, policyFor(true), 5000).action, 'monitor');
});

// --- savings rule and limits ----------------------------------------------------------------------------------------------------------------
for (const [p, expected] of [[0, false], [0.05, false], [0.08, false], [0.1, true], [0.5, true], [1, true]]) {
  test(`matrix savings: p_resume ${p}`, () => assert.equal(savingsWorthwhile(p, PRICES), expected));
}
test('matrix prices and limits', () => {
  assert.equal(savingsWorthwhile(1, null), false);
  assert.equal(savingsWorthwhile(1, undefined), false);
  const row = rowOf({}, keep(0), keep(1));
  assert.equal(keepaliveWorthwhile(row, PRICES, 2), false);
  assert.equal(keepaliveWorthwhile(row, PRICES, 3), true);
  assert.equal(keepaliveWorthwhile(row, null, undefined), false);
  assert.equal(keepaliveWorthwhile(row, PRICES, Infinity), true);
});

// --- gateway answers ------------------------------------------------------------------------------------------------------------------------
test('matrix gateway answers: rows, 404, failure and staleness', async () => {
  let reply = { status: 200, text: JSON.stringify({ rows: [{ status: 'enabled', safe_refresh_s: 300 }] }) };
  const client = createPolicyClient({ fetch: async () => { if (reply instanceof Error) throw reply; return reply; } });
  const base = 'https://gateway.example';
  await client.refresh(base, 'm', 's', 0);
  assert.equal(pickRow(client.peek('m', 1), 1000).safe, 300);
  reply = new Error('down');
  await client.refresh(base, 'm', 's', 700000);
  assert.equal(client.peek('m', 700001).length, 1);
  assert.equal(client.peek('m', POLICY_STALE_MS - 1).length, 1);
  assert.equal(client.peek('m', POLICY_STALE_MS), null);
  reply = { status: 404, text: '' };
  await client.refresh(base, 'm', 's', POLICY_STALE_MS + 100000);
  assert.deepEqual(client.peek('m', POLICY_STALE_MS + 100001), []);
  assert.equal(pickRow([], 1000), undefined);
  assert.equal(pickRow(null, 1000), undefined);
  assert.equal(parsePolicy('{"rows":[]}').length, 0);
});

// --- Claude vs other models ------------------------------------------------------------------------------------------------------------------
test('matrix model kinds', () => {
  for (const model of ['claude-opus-5', 'anthropic/claude-sonnet-5', 'us.anthropic.claude-haiku-4-5-v1:0']) assert.equal(clientTtl(model, '1h'), null);
  for (const model of ['glm-5.3', 'gpt-5.6', 'kimi-k3']) assert.equal(clientTtl(model, '1h'), 3600000);
  assert.equal(SOURCE_ICONS.native, '◉');
});

// --- seeded randomized timelines -------------------------------------------------------------------------------------------------------------
function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; }
test('property: a keepalive never fires after the true expiry, and never repeats without a confirmed refresh', () => {
  const random = rng(20261008);
  for (let run = 0; run < 400; run++) {
    const safe = 60 + Math.floor(random() * 1700);
    const refreshOnRead = [true, false, null][Math.floor(random() * 3)];
    const anchorOnStart = random() < 0.3;
    const policy = { status: 'enabled', safe, maxIdle: random() < 0.3 ? safe * 3 : null, refreshOnRead, ...(anchorOnStart ? { anchorOnStart } : {}) };
    const startedAt = Math.floor(random() * 5000);
    const completedAt = startedAt + Math.floor(random() * 90000);
    const writeFirst = random() < 0.6;
    const real = base({ startedAt, completedAt, read: writeFirst ? 0 : 20000, write: writeFirst ? 30000 : 40000 });
    const fires = [];
    const keepalives = [];
    let now = completedAt;
    for (let step = 0; step < 200 && now < completedAt + safe * 1000 * 6; step++) {
      now += Math.floor(random() * 4000);
      const row = cacheRows([real, ...keepalives])[0];
      const { action, dueAt } = policyAction(row, policy, now);
      if (action === 'fire') {
        const anchorAt = dueAt - safe * 1000;
        assert.ok(now <= dueAt, `fired at ${now} after due ${dueAt}`);
        assert.ok(now >= dueAt - POLICY_TICK_MS);
        assert.ok(anchorAt >= (anchorOnStart ? startedAt : 0));
        fires.push(now);
        const read = random() < 0.7;
        keepalives.push(base({ turnId: `keepalive:${fires.length}`, startedAt: now, completedAt: now + 100, read: read ? 30000 : 0, write: read ? 0 : 30000 }));
      }
      if (action === 'missed' || action === 'idle') assert.notEqual(action, 'fire');
    }
    if (refreshOnRead !== true) assert.ok(fires.length <= 1, `refresh_on_read ${refreshOnRead} fired ${fires.length} times`);
  }
});

test('matrix prices: the feed price of a native 1h write decides how many keepalives pay off, not the list price', () => {
  const row = cacheRows([base({ model: 'claude-opus-5', read: 0, write: 100000, cacheCreation: { fiveMinute: 0, oneHour: 100000 }, ttlMs: 3600000 })])[0];
  const list = { read: 0.05, fiveMinute: 1.25, oneHour: 2, output: 5 };
  const feed = { read: 0.05, fiveMinute: 1.25, oneHour: 4, output: 5 };
  assert.ok(keepalivesLeft(row, feed) > keepalivesLeft(row, list));
  assert.equal(keepalivesLeft(row, { read: 0.05, output: 5 }) >= 0, true);
  assert.equal(keepalivesLeft(row, { ...feed, oneHour: undefined }), keepalivesLeft(row, { ...feed, oneHour: 1.25 }));
});
