import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cachePolicy, validSample, validPrices, cacheRows, cacheStatus, cacheBar, cacheClock, loopKey, applyCacheCreation, cacheGrade, cachePercent, lifeGrade, isKeepalive, keepaliveWorthwhile, keepalivesLeft, cacheDial, cacheBarParts, isCompaction,
  recentUsage, recentMisses, sampleTtl, unreportedModels, sessionMatrix, sessionUsage, cacheGap, lifetimeOf, lifetimeLabel, lifetimeStatus, clientTtl, parseTtlOverrides, fallbackTtl, savingsWorthwhile, KEEPALIVE_PROMPT, SOURCE_ICONS, policyAction, policyRow, POLICY_TICK_MS, MISS_WINDOW_MS, TTL_REPORT_MS } from '../lib/cache.js';
import { recordCacheSample, resetCache, cacheSnapshot, linkSession } from '../lib/cache-state.mjs';
import { recordPath, writeRecord, routerData } from '../lib/state.mjs';
import { handleRequest } from '../lib/bridge.mjs';
import { writeRoutes } from '../lib/shared/routes.mjs';
import { migrateFromRouter } from '../lib/migrate.mjs';

const sample = (extra = {}) => ({ sessionId: 'lead', agentId: null, turnId: 'turn', index: 0, model: 'vendor/main',
  startedAt: 1000, read: 800, write: 100, fresh: 100, output: 20, ttlMs: 300000, ttlSource: 'plugin estimate', disabled: false, ...extra });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'keepalive-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('missing response metadata stays unknown and local flags only indicate disabling', () => {
  assert.equal(cachePolicy().ttlMs, null);
  assert.equal(cachePolicy({ ENABLE_PROMPT_CACHING_1H: '1', FORCE_PROMPT_CACHING_5M: 'true',
    CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' }, 'claude-opus-5').ttlMs, null);
  assert.equal(cachePolicy({ DISABLE_PROMPT_CACHING_OPUS: '1' }, 'claude-opus-5').disabled, true);
  assert.equal(cacheStatus(cacheRows([sample()])[0], 1000).state, 'TTL not reported');
  assert.equal(cacheStatus(cacheRows([sample()])[0], 9999999).leftMs, null);
  const old = cacheRows([sample()])[0].last;
  assert.equal(old.ttlMs, null);
  assert.equal(old.ttlSource, 'response TTL metadata absent');
});

test('read ratio excludes output and countdown starts at dispatch, not response completion', () => {
  const status = (value, now) => cacheStatus(cacheRows([value])[0], now);
  assert.equal(status(sample({ output: 1000000 }), 101000).ratio, 0.8);
  const reported = applyCacheCreation(sample(), { fiveMinute: 100, oneHour: 0 });
  assert.equal(status(reported, 101000).leftMs, 200000);
  assert.equal(status(reported, 101000).state, 'warm');
  assert.equal(status(reported, 301000).state, 'expired');
  assert.equal(status(sample({ ttlMs: null }), 9999999).state, 'TTL not reported');
  assert.equal(status(sample({ read: 0, write: 0 }), 1000).state, 'uncached');
  assert.equal(status(sample({ read: 0, write: 0, fresh: 0 }), 1000).ratio, null);
  assert.equal(status(sample({ disabled: true }), 1000).state, 'caching disabled');
  assert.equal(cacheStatus(undefined, 1000).state, 'no observation');
  assert.equal(cacheClock(1), '0:01');
  assert.equal(cacheBar(0.8).length, 10);
});

test('nested and parallel loops sharing turn ids stay separate, duplicates count once', () => {
  const main = sample();
  const child = sample({ agentId: 'child', read: 0, write: 900 });
  const nested = sample({ agentId: 'nested', model: 'vendor/fast', read: 900, write: 0 });
  const pane = sample({ sessionId: 'pane', agentId: null });
  const rows = cacheRows([main, child, nested, pane, main]);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(r => r.totals.requests), [1, 1, 1, 1]);
  assert.equal(rows.find(r => r.agentId === 'child').totals.read, 0);
  assert.equal(rows.find(r => r.agentId === 'nested').totals.read, 900);
});

test('out of order responses cannot move the latest request backwards; history is bounded and totals are complete', () => {
  const samples = Array.from({ length: 40 }, (_, index) => sample({ index, startedAt: 1000 + index }));
  const row = cacheRows(samples.reverse())[0];
  assert.equal(row.last.index, 39);
  assert.equal(row.samples.length, 30);
  assert.equal(row.totals.requests, 40);
  assert.equal(row.totals.read, 32000);
});

test('compaction invalidates only its own prefix, retaining historical usage across resume', async t => {
  const root = await fixture(t);
  await recordCacheSample(root, 'lead', sample());
  await recordCacheSample(root, 'lead', sample({ agentId: 'child' }));
  await resetCache(root, 'lead', null, 2000);
  const { samples, resets } = await cacheSnapshot(root, 'lead');
  const rows = cacheRows(samples, resets);
  assert.equal(rows.find(r => r.agentId === null).last, undefined);
  assert.equal(cacheStatus(rows.find(r => r.agentId === null), 2000).state, 'no observation');
  assert.equal(rows.find(r => r.agentId === null).totals.read, 800);
  assert.equal(rows.find(r => r.agentId === 'child').last.read, 800);
  await recordCacheSample(root, 'lead', sample({ index: 1, startedAt: 2001 }));
  const next = await cacheSnapshot(root, 'lead');
  assert.equal(cacheRows(next.samples, next.resets).find(r => r.agentId === null).last.index, 1);
});

test('request persistence is atomic, idempotent and whitelisted', async t => {
  const root = await fixture(t);
  const value = sample({ answer: 'SECRET_ANSWER', prompt: 'SECRET_PROMPT', apiKey: 'SECRET_KEY' });
  await Promise.all(Array.from({ length: 8 }, () => recordCacheSample(root, 'lead', value)));
  const snapshot = await cacheSnapshot(root, 'lead');
  assert.equal(snapshot.samples.length, 1);
  assert.equal(JSON.stringify(snapshot).includes('SECRET'), false);
  const identity = JSON.stringify([null, 'turn', 0]);
  const stored = await readFile(recordPath(root, 'cache-samples', 'lead', identity), 'utf8');
  assert.equal(stored.includes('SECRET'), false);
  await assert.rejects(recordCacheSample(root, 'lead', sample({ read: -1 })), /Invalid/);
  await assert.rejects(recordCacheSample(root, 'lead', sample({ write: NaN })), /Invalid/);
  await assert.rejects(recordCacheSample(root, 'lead', sample({ fresh: undefined })), /Invalid/);
  await assert.rejects(recordCacheSample(root, 'lead', sample({ ttlMs: 1 })), /Invalid/);
});

test('lead observes linked pane teammates and their nested agents without counting unrelated sessions', async t => {
  const root = await fixture(t);
  await recordCacheSample(root, 'lead', sample());
  await recordCacheSample(root, 'pane', sample({ agentId: null }));
  await recordCacheSample(root, 'pane', sample({ agentId: 'nested' }));
  await recordCacheSample(root, 'unrelated', sample());
  await linkSession(root, 'lead', 'pane', 'Worker (mate)');
  const snapshot = await cacheSnapshot(root, 'lead');
  assert.equal(snapshot.samples.length, 3);
  assert.equal(new Map(snapshot.labels).get(loopKey('pane', null)), 'Worker (mate)');
  const rows = cacheRows(snapshot.samples, snapshot.resets, new Map(snapshot.labels));
  assert.equal(rows.length, 3);
  assert.equal(rows.find(r => r.sessionId === 'pane' && r.agentId === null).label, 'Worker (mate)');
});

test('without its own link, a pane teammate the router published still joins its lead, with the router labels', async t => {
  const root = await fixture(t);
  const config = await fixture(t);
  const router = routerData(config);
  await recordCacheSample(root, 'lead', sample());
  await recordCacheSample(root, 'lead', sample({ agentId: 'scout1' }));
  await recordCacheSample(root, 'pane', sample({ agentId: null }));
  await writeRoutes(router, { sessionId: 'lead', leadSessionId: null, self: null, teammate: null, teammates: ['pane'],
    agents: [{ agentId: 'scout1', kind: 'subagent', role: 'scout', model: 'vendor/search-v1' }] });
  await writeRoutes(router, { sessionId: 'pane', leadSessionId: 'lead', self: { role: 'task', model: 'vendor/task-v1', effort: 'low' },
    teammate: { agentId: 'worker@team', name: 'worker' }, teammates: [], agents: [] });
  const snapshot = await cacheSnapshot(root, 'lead', router);
  const labels = new Map(snapshot.labels);
  assert.equal(snapshot.samples.length, 3);
  assert.equal(labels.get(loopKey('lead', 'scout1')), 'scout (scout1)');
  assert.equal(labels.get(loopKey('pane', null)), 'worker (worker@team)');
  assert.deepEqual(snapshot.routes, { self: null, agents: [{ agentId: 'scout1', model: 'vendor/search-v1', kind: 'subagent' }] });
  assert.equal((await cacheSnapshot(root, 'lead')).routes, null);
});

test('the first run copies the cache history Agent Router kept, once, without overwriting', async t => {
  const root = await fixture(t);
  const config = await fixture(t);
  const router = routerData(config);
  await recordCacheSample(router, 'lead', sample({ turnId: 'old' }));
  await recordCacheSample(root, 'lead', sample({ turnId: 'new' }));
  assert.deepEqual(await migrateFromRouter(root, router), { migrated: true, copied: ['cache-samples'] });
  assert.deepEqual((await cacheSnapshot(root, 'lead')).samples.map(s => s.turnId).sort(), ['new', 'old']);
  await recordCacheSample(router, 'lead', sample({ turnId: 'later' }));
  assert.deepEqual(await migrateFromRouter(root, router), { migrated: false });
  assert.equal((await cacheSnapshot(root, 'lead')).samples.length, 2);
});

test('cache bridge records new clear-session identities without depending on routing bootstrap', async t => {
  const root = await fixture(t);
  const env = { CLAUDE_PLUGIN_DATA: root };
  await handleRequest({ action: 'cache-sample', session_id: 'after-clear', sample: sample() }, env);
  const snapshot = await handleRequest({ action: 'cache-snapshot', session_id: 'after-clear' }, env);
  assert.equal(snapshot.samples[0].sessionId, 'after-clear');
  assert.equal((await cacheSnapshot(root, 'lead')).samples.length, 0);
});

test('hit-rate grades tighten with context size so uncached tokens stay within budget', () => {
  const at = (rate, context) => {
    const read = Math.round(context * rate);
    return cacheGrade(sample({ read, write: context - read - 2, fresh: 2 }));
  };
  assert.equal(at(0.90, 10000), 'good');
  assert.equal(at(0.90, 990000), 'poor');
  assert.equal(at(0.95, 990000), 'fair');
  assert.equal(at(0.98, 990000), 'good');
  assert.equal(at(0.96, 150000), 'good');
  assert.equal(at(0.80, 50000), 'fair');
  assert.equal(at(0.50, 100000), 'poor');
  assert.equal(cacheGrade(sample({ read: 0, write: 0, fresh: 0 })), null);
  assert.equal(cacheGrade(undefined), null);
  assert.equal(cachePercent(sample({ read: 996, write: 4, fresh: 0 })), 99);
  assert.equal(cachePercent(sample({ read: 0, write: 0, fresh: 0 })), null);
});

test('time left is graded ahead of the window upkeep acts in', () => {
  assert.equal(lifeGrade(120001), 'good');
  assert.equal(lifeGrade(120000), 'fair');
  assert.equal(lifeGrade(30001), 'fair');
  assert.equal(lifeGrade(30000), 'poor');
  assert.equal(lifeGrade(0), 'poor');
  assert.equal(lifeGrade(null), null);
});

test('each request refreshes its loop cache and keeps the TTL its latest breakdown reported', () => {
  const written = applyCacheCreation(sample({ startedAt: 1000 }), { fiveMinute: 100, oneHour: 0 });
  const readOnly = sample({ index: 1, startedAt: 200000, read: 900, write: 0, fresh: 100 });
  const row = cacheRows([written, readOnly])[0];
  const status = cacheStatus(row, 300000);
  assert.equal(status.state, 'warm');
  assert.deepEqual(status.lifetimes.map(l => l.ttl), ['5m']);
  assert.equal(status.leftMs, 200000);
  assert.equal(status.ratio, 0.9);
  assert.equal(cacheStatus(row, 450000, 400000).leftMs, 250000);
  assert.equal(cacheStatus(row, 500000).state, 'expired');
  assert.equal(cacheStatus(row, 500000).leftMs, 0);
});

test('keepalives refresh the lifetime without replacing the last request hit rate', () => {
  const written = applyCacheCreation(sample({ startedAt: 1000 }), { fiveMinute: 100, oneHour: 0 });
  const keepalive = sample({ turnId: 'keepalive:271000', startedAt: 271000, read: 1000, write: 0, fresh: 10 });
  assert.equal(isKeepalive(keepalive), true);
  assert.equal(isKeepalive(written), false);
  const row = cacheRows([written, keepalive])[0];
  assert.equal(row.last.turnId, 'turn');
  assert.equal(row.keepalives.length, 1);
  assert.equal(row.totals.requests, 2);
  assert.equal(cacheStatus(row, 301000).leftMs, 270000);
  assert.equal(cacheStatus(row, 301000).ratio, 0.8);
  assert.equal(cacheRows([written, keepalive, sample({ index: 1, startedAt: 400000, read: 1000, write: 0 })])[0].keepalives.length, 0);
  assert.equal(cacheStatus(cacheRows([written, { ...keepalive, read: 0 }])[0], 301000).state, 'expired');
});

test('warming continues while measured keepalive cost stays below the rewrite it prevents', () => {
  const standard = { read: 0.1, fiveMinute: 1.25, output: 5 };
  const allowed = prices => {
    const samples = [applyCacheCreation(sample({ read: 9000, write: 1000, fresh: 0 }), { fiveMinute: 1000, oneHour: 0 })];
    for (let i = 1; i < 100; i++) {
      if (!keepaliveWorthwhile(cacheRows(samples)[0], prices)) return i - 1;
      samples.push(sample({ turnId: `keepalive:${i}`, startedAt: 1000 + i, read: 10000, write: 0, fresh: 10, output: 2 }));
    }
    return Infinity;
  };
  assert.equal(allowed(standard), 11);
  assert.equal(allowed({ ...standard, read: 0.05 }), 23);
  assert.equal(allowed({ read: 0.1, output: 4 }), 8);
  assert.equal(allowed(null), 0);
  assert.equal(allowed(undefined), 0);
  assert.equal(keepaliveWorthwhile(cacheRows([sample({ read: 0, write: 0 })])[0], standard), false);
  assert.equal(keepaliveWorthwhile(undefined, standard), false);
});

test('the dial shows the time left in quarters of the TTL, dotted while unknown', () => {
  const written = applyCacheCreation(sample({ startedAt: 0 }), { fiveMinute: 100, oneHour: 0 });
  const dial = now => cacheDial(cacheStatus(cacheRows([written])[0], now));
  assert.equal(dial(0), '●');
  assert.equal(dial(74999), '●');
  assert.equal(dial(75000), '◕');
  assert.equal(dial(150000), '◑');
  assert.equal(dial(225000), '◔');
  assert.equal(dial(299000), '◔');
  assert.equal(dial(300000), '○');
  const mixed = applyCacheCreation(sample({ startedAt: 0 }), { fiveMinute: 40, oneHour: 60 });
  assert.equal(cacheDial(cacheStatus(cacheRows([mixed])[0], 2000000)), '◑');
  for (const unknown of [sample(), sample({ read: 0, write: 0 }), sample({ disabled: true })]) {
    assert.equal(cacheDial(cacheStatus(cacheRows([unknown])[0], 1000)), '◌');
  }
  assert.equal(cacheDial(cacheStatus(undefined, 1000)), '◌');
});

test("a compaction shows its own request and sizes until the loop's next request", () => {
  const before = applyCacheCreation(sample({ startedAt: 1000, read: 300000, write: 5000 }), { fiveMinute: 5000, oneHour: 0 });
  const compaction = sample({ turnId: 'compaction:2000', startedAt: 2000, read: 305000, write: 0, fresh: 10, output: 9000,
    tokensBefore: 305010, tokensAfter: 18000 });
  assert.equal(isCompaction(compaction), true);
  const resets = [{ sessionId: 'lead', agentId: null, resetAt: 2000 }];
  const row = cacheRows([before, compaction], resets)[0];
  assert.equal(row.last, undefined);
  assert.equal(row.totals.requests, 2);
  const status = cacheStatus(row, 3000);
  assert.equal(status.state, 'compacted');
  assert.equal(status.sample.turnId, 'compaction:2000');
  assert.equal(status.ratio > 0.99, true);
  assert.deepEqual(status.compacted, { before: 305010, after: 18000 });
  assert.equal(status.leftMs, null);
  const after = sample({ turnId: 'next', startedAt: 9000, read: 48000, write: 20000, fresh: 2 });
  const next = cacheRows([before, compaction, after], resets)[0];
  assert.equal(cacheStatus(next, 9500).state, 'TTL not reported');
  assert.equal(next.last.miss, undefined);
  const bare = sample({ turnId: 'compaction:2000', startedAt: 2000, read: 0, write: 0, fresh: 0, output: 0 });
  const quiet = cacheRows([before, bare], resets)[0];
  assert.equal(quiet.totals.requests, 1);
  assert.equal(cacheStatus(quiet, 3000).state, 'compacted');
  assert.equal(cacheStatus(quiet, 3000).ratio, null);
});

test('a request that rewrites a cache its predecessor made is labelled with the likely cause', () => {
  const warm = applyCacheCreation(sample({ startedAt: 0, read: 340000, write: 3000 }), { fiveMinute: 3000, oneHour: 0 });
  const label = (next, extra = []) => cacheRows([warm, ...extra, sample({ turnId: 'next', ...next })])[0].last.miss;
  assert.equal(label({ startedAt: 26000, read: 48648, write: 337074 }), 'prefix changed');
  assert.equal(label({ startedAt: 301000, read: 0, write: 345000 }), 'expired');
  const keepalive = sample({ turnId: 'keepalive:270000', startedAt: 270000, read: 343000, write: 0, fresh: 10 });
  assert.equal(label({ startedAt: 400000, read: 48648, write: 300000 }, [keepalive]), 'prefix changed');
  assert.equal(label({ startedAt: 26000, read: 0, write: 345000, model: 'vendor/other' }), 'model changed');
  assert.equal(label({ startedAt: 26000, read: 48648, write: 337074 }, []), 'prefix changed');
  assert.equal(label({ startedAt: 26000, read: 343000, write: 2000 }), undefined);
  assert.equal(label({ startedAt: 26000, read: 341500, write: 3500 }), undefined);
  const unknown = sample({ startedAt: 0, read: 340000, write: 3000 });
  assert.equal(cacheRows([unknown, sample({ turnId: 'next', startedAt: 26000, read: 0, write: 343000 })])[0].last.miss, 'cache miss');
  assert.equal(cacheRows([sample({ read: 0, write: 343000 })])[0].last.miss, undefined);
});

test("the bar's fill texture repeats its grade for readers who cannot tell the colours apart", () => {
  assert.deepEqual(cacheBarParts(0.96, 10, 'good'), { fill: '██████████', empty: '' });
  assert.deepEqual(cacheBarParts(0.5, 10, 'fair'), { fill: '▓▓▓▓▓', empty: '░░░░░' });
  assert.deepEqual(cacheBarParts(0.14, 10, 'poor'), { fill: '▒', empty: '░░░░░░░░░' });
  assert.deepEqual(cacheBarParts(null, 4), { fill: '', empty: '░░░░' });
  assert.equal(cacheBar(0.5, 4), '██░░');
});

test('a compaction record keeps its sizes and nothing else', async t => {
  const root = await fixture(t);
  const compaction = sample({ turnId: 'compaction:2000', startedAt: 2000, tokensBefore: 305010, tokensAfter: 18000, summary: 'PRIVATE_SUMMARY' });
  const { sample: saved } = await recordCacheSample(root, 'lead', compaction);
  assert.equal(saved.tokensBefore, 305010);
  assert.equal(saved.tokensAfter, 18000);
  assert.equal(JSON.stringify(saved).includes('PRIVATE'), false);
  await assert.rejects(recordCacheSample(root, 'lead', sample({ turnId: 'compaction:3000', tokensAfter: -1 })), /Invalid/);
});

test('the keepalives left count down to the point where warming stops', () => {
  const standard = { read: 0.1, fiveMinute: 1.25, output: 5 };
  const samples = [applyCacheCreation(sample({ read: 9000, write: 1000, fresh: 0 }), { fiveMinute: 1000, oneHour: 0 })];
  const counts = [];
  for (let i = 1; i <= 12; i++) {
    const row = cacheRows(samples)[0];
    const left = keepalivesLeft(row, standard);
    assert.equal(left > 0, keepaliveWorthwhile(row, standard));
    counts.push(left);
    samples.push(sample({ turnId: `keepalive:${i}`, startedAt: 1000 + i, read: 10000, write: 0, fresh: 10, output: 2 }));
  }
  assert.deepEqual(counts, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  assert.equal(keepalivesLeft(cacheRows(samples.slice(0, 1))[0], null), 0);
  assert.equal(keepalivesLeft(cacheRows([sample({ read: 0, write: 0 })])[0], standard), null);
  assert.equal(keepalivesLeft(undefined, standard), null);
});

test('a set number of keepalives is sent after each request whatever it costs, and default follows the price', () => {
  const standard = { read: 0.1, fiveMinute: 1.25, output: 5 };
  const counts = (limit, prices = standard) => {
    const samples = [applyCacheCreation(sample({ read: 9000, write: 1000, fresh: 0 }), { fiveMinute: 1000, oneHour: 0 })];
    const seen = [];
    for (let i = 1; i <= 5; i++) {
      const row = cacheRows(samples)[0];
      seen.push([keepalivesLeft(row, prices, limit), keepaliveWorthwhile(row, prices, limit)]);
      samples.push(sample({ turnId: `keepalive:${i}`, startedAt: 1000 + i, read: 10000, write: 0, fresh: 10, output: 2 }));
    }
    return seen;
  };
  assert.deepEqual(counts(3), [[3, true], [2, true], [1, true], [0, false], [0, false]]);
  assert.deepEqual(counts(40).map(([left]) => left), [40, 39, 38, 37, 36]);
  assert.deepEqual(counts(3, null).map(([left]) => left), [3, 2, 1, 0, 0]);
  assert.deepEqual(counts(Infinity).map(([left, worth]) => [left, worth]), Array(5).fill([Infinity, true]));
  assert.deepEqual(counts(undefined).map(([left]) => left), [11, 10, 9, 8, 7]);
  assert.equal(keepalivesLeft(cacheRows([sample({ read: 0, write: 0 })])[0], standard, 3), null);
});

test('the bar rate covers the last 10 real requests, weighted by tokens, without keepalives', () => {
  const requests = [sample({ turnId: 'a', startedAt: 1, read: 0, write: 10000, fresh: 0 }),
    ...Array.from({ length: 3 }, (_, i) => sample({ turnId: `b${i}`, startedAt: 10 + i, read: 10000, write: 0, fresh: 0 }))];
  const keepalive = sample({ turnId: 'keepalive:20', startedAt: 20, read: 10000, write: 0, fresh: 0 });
  const usage = recentUsage(cacheRows([...requests, keepalive])[0]);
  assert.equal(usage.requests, 4);
  assert.equal(cachePercent(usage), 75);
  const many = Array.from({ length: 12 }, (_, i) => sample({ turnId: `m${i}`, startedAt: 100 + i, read: i < 2 ? 0 : 1000, write: i < 2 ? 1000 : 0, fresh: 0 }));
  assert.equal(cachePercent(recentUsage(cacheRows(many)[0])), 100);
  assert.equal(recentUsage(undefined), undefined);
});

test('misses are counted by cause for a window of time', () => {
  const warm = applyCacheCreation(sample({ startedAt: 0, read: 340000, write: 3000 }), { fiveMinute: 3000, oneHour: 0 });
  const written = (turnId, startedAt, read, write) => applyCacheCreation(sample({ turnId, startedAt, read, write }), { fiveMinute: write, oneHour: 0 });
  const rows = cacheRows([warm, written('p', 26000, 48648, 297000), written('e', 400000, 0, 345000), written('q', 420000, 100, 345000)]);
  assert.deepEqual(recentMisses(rows, 430000), { total: 3, latest: 420000, causes: [['prefix changed', 2], ['expired', 1]] });
  assert.deepEqual(recentMisses(rows, 26000 + MISS_WINDOW_MS + 1), { total: 2, latest: 420000, causes: [['expired', 1], ['prefix changed', 1]] });
  assert.deepEqual(recentMisses(rows, 420000 + MISS_WINDOW_MS + 1), { total: 0, latest: undefined, causes: [] });
});

test('a write whose TTL is not yet reported counts down from the requested TTL until the report is due', () => {
  const written = sample({ startedAt: 0, completedAt: 1000, read: 900, write: 100, requested: '1h', model: 'claude-opus-5-5' });
  const status = now => cacheStatus(cacheRows([written])[0], now);
  assert.equal(status(2000).ttl, '1h');
  assert.equal(status(2000).awaiting, true);
  assert.equal(status(2000).leftMs, 3598000);
  assert.equal(status(1000 + TTL_REPORT_MS).state, 'TTL not reported');
  assert.equal(cacheStatus(cacheRows([sample({ completedAt: 1000 })])[0], 2000).state, 'TTL not reported');
  assert.equal(cacheStatus(cacheRows([{ ...written, model: 'gpt-5.6' }])[0], 2000).awaiting, undefined);
  const reported = applyCacheCreation(written, { fiveMinute: 100, oneHour: 0 });
  assert.equal(cacheStatus(cacheRows([reported])[0], 2000).ttl, '5m');
  assert.equal(cacheStatus(cacheRows([reported])[0], 2000).awaiting, undefined);
});

test('a model seen not to report its TTL gets no provisional countdown on later writes, in any loop', () => {
  const first = sample({ turnId: 'a', startedAt: 0, completedAt: 1000, read: 0, write: 900, requested: '5m', model: 'claude-gateway[1m]' });
  const later = sample({ turnId: 'b', startedAt: 40000, completedAt: 41000, read: 900, write: 100, requested: '5m', model: 'claude-gateway' });
  const elsewhere = sample({ agentId: 'child', turnId: 'c', startedAt: 40000, completedAt: 41000, read: 0, write: 500, requested: '5m', model: 'claude-gateway' });
  const rows = cacheRows([first, later, elsewhere]);
  const quiet = unreportedModels(rows, 42000);
  assert.deepEqual([...quiet], ['claude-gateway']);
  for (const row of rows) assert.equal(cacheStatus(row, 42000, undefined, quiet).state, 'TTL not reported');
  assert.equal(cacheStatus(rows[0], 42000).awaiting, true);
  assert.deepEqual([...unreportedModels(cacheRows([first]), 2000)], []);
  const claude = sample({ turnId: 'd', startedAt: 40000, completedAt: 41000, read: 0, write: 500, requested: '5m', model: 'claude-opus-5-5' });
  assert.equal(cacheStatus(cacheRows([first, claude])[0], 42000, undefined, quiet).awaiting, true);
  const reported = applyCacheCreation(sample({ turnId: 'e', startedAt: 0, completedAt: 1000, read: 0, write: 900, model: 'claude-opus-5-5' }), { fiveMinute: 900, oneHour: 0 });
  assert.deepEqual([...unreportedModels(cacheRows([reported]), 99000)], []);
});

test('each request names the TTL it asked for, and a different reported one', () => {
  assert.equal(sampleTtl(sample({ requested: '1h' })), '1h');
  assert.equal(sampleTtl(applyCacheCreation(sample({ requested: '1h' }), { fiveMinute: 100, oneHour: 0 })), '1h (5m reported)');
  assert.equal(sampleTtl(applyCacheCreation(sample({ requested: '5m' }), { fiveMinute: 100, oneHour: 0 })), '5m');
  assert.equal(sampleTtl(applyCacheCreation(sample(), { fiveMinute: 40, oneHour: 60 })), '5m+1h');
  assert.equal(sampleTtl(sample()), undefined);
});

test('requests remember the TTL they asked for, and moving up to 1h is named as the miss', () => {
  assert.equal(validSample(sample({ requested: '1h' })), true);
  assert.equal(validSample(sample({ requested: '2h' })), false);
  const warm = applyCacheCreation(sample({ startedAt: 0, read: 340000, write: 3000, requested: '5m' }), { fiveMinute: 3000, oneHour: 0 });
  const label = next => cacheRows([warm, sample({ turnId: 'next', startedAt: 26000, ...next })])[0].last.miss;
  assert.equal(label({ read: 48648, write: 297000, requested: '1h' }), 'TTL changed');
  assert.equal(label({ read: 48648, write: 297000, requested: '5m' }), 'prefix changed');
  assert.equal(label({ read: 48648, write: 297000 }), 'prefix changed');
});

test('a 1h cache is costed at its own write price, and a missing 1h price errs toward fewer keepalives', () => {
  const listed = { read: 0.1, fiveMinute: 1.25, oneHour: 2, output: 5 };
  const unlisted = { read: 0.1, fiveMinute: 1.25, output: 5 };
  const allowed = (creation, prices) => {
    const samples = [applyCacheCreation(sample({ read: 9000, write: 1000, fresh: 0 }), creation)];
    for (let i = 1; i < 100; i++) {
      if (!keepaliveWorthwhile(cacheRows(samples)[0], prices)) return i - 1;
      samples.push(sample({ turnId: `keepalive:${i}`, startedAt: 1000 + i, read: 10000, write: 0, fresh: 10, output: 2 }));
    }
    return Infinity;
  };
  const oneHour = { fiveMinute: 0, oneHour: 1000 };
  assert.equal(allowed({ fiveMinute: 1000, oneHour: 0 }, listed), 11);
  assert.equal(allowed(oneHour, listed), 18);
  assert.equal(allowed(oneHour, unlisted), 11);
  assert.equal(keepalivesLeft(cacheRows([applyCacheCreation(sample({ read: 9000, write: 1000, fresh: 0 }), oneHour)])[0], listed), 19);
  assert.equal(validPrices({ ...listed, oneHour: -1 }), false);
});

test('the session matrix has one cell per request, in time order, with a shape for each grade and kind', () => {
  const warm = applyCacheCreation(sample({ turnId: 'a', startedAt: 0, read: 340000, write: 3000 }), { fiveMinute: 3000, oneHour: 0 });
  const miss = applyCacheCreation(sample({ turnId: 'b', startedAt: 26000, read: 48648, write: 297000 }), { fiveMinute: 297000, oneHour: 0 });
  const keepalive = sample({ turnId: 'keepalive:30000', startedAt: 30000, read: 345000, write: 0, fresh: 10 });
  const fair = sample({ agentId: 'child', turnId: 'c', startedAt: 10000, read: 6000, write: 3500, fresh: 500 });
  const compaction = sample({ turnId: 'compaction:40000', startedAt: 40000, read: 345000, write: 0, fresh: 10, output: 9000 });
  const cells = sessionMatrix(cacheRows([warm, miss, keepalive, fair, compaction]));
  assert.deepEqual(cells.map(cell => cell.glyph).join(''), '●◐✕·◆');
  assert.deepEqual(cells.map(cell => cell.tone), ['good', 'fair', 'poor', 'quiet', 'quiet']);
  assert.deepEqual(sessionMatrix([]), []);
});

test('the session rate weighs every real request, and the recent rate the last 10 across all loops', () => {
  const rows = cacheRows([
    sample({ turnId: 'a', startedAt: 1, read: 0, write: 10000, fresh: 0 }),
    ...Array.from({ length: 10 }, (_, i) => sample({ agentId: i % 2 ? 'child' : null, turnId: `b${i}`, startedAt: 10 + i, read: 10000, write: 0, fresh: 0 })),
    sample({ turnId: 'keepalive:50', startedAt: 50, read: 10000, write: 0, fresh: 0 }),
  ]);
  const usage = sessionUsage(rows);
  assert.equal(usage.session.requests, 11);
  assert.equal(cachePercent(usage.session), 90);
  assert.equal(usage.recent.requests, 10);
  assert.equal(cachePercent(usage.recent), 100);
  assert.equal(sessionUsage([]), undefined);
});

test('time between requests reads in seconds, minutes or hours', () => {
  assert.equal(cacheGap(420), '0.4s');
  assert.equal(cacheGap(12400), '12s');
  assert.equal(cacheGap(252000), '4m 12s');
  assert.equal(cacheGap(3780000), '1h 03m');
  assert.equal(cacheGap(-5), '0.0s');
});

const gateway = (extra = {}, ...keepalives) => cacheRows([sample({ completedAt: 2000, ...extra }),
  ...keepalives.map((k, i) => sample({ turnId: `keepalive:${i}`, startedAt: 2500 + i, completedAt: 3000, ...k }))])[0];
const enabled = { status: 'enabled', safe: 480, maxIdle: 3600, refreshOnRead: true };

test('a gateway policy counts down from the last confirmed cache touch and fires in the last tick, never later', () => {
  const row = gateway();
  assert.equal(policyRow(row), true);
  assert.deepEqual(policyAction(row, enabled, 2000 + 480000 - POLICY_TICK_MS - 1), { action: 'wait', dueAt: 482000 });
  assert.equal(policyAction(row, enabled, 482000 - POLICY_TICK_MS).action, 'fire');
  assert.equal(policyAction(row, enabled, 482000).action, 'fire');
  assert.equal(policyAction(row, enabled, 482001).action, 'missed');
});

test('without refresh_on_read the anchor is the last real turn and one keepalive is sent per idle period', () => {
  const once = { ...enabled, refreshOnRead: null };
  const chained = { ...enabled, refreshOnRead: true };
  assert.deepEqual(policyAction(gateway(), once, 482000), { action: 'fire', dueAt: 482000 });
  assert.equal(policyAction(gateway({}, { read: 900 }), once, 483000).action, 'sent');
  assert.equal(policyAction(gateway({}, { read: 900 }), once, 483000).dueAt, 482000);
  assert.equal(policyAction(gateway({}, { read: 0, write: 900 }), once, 100).action, 'sent');
  assert.equal(policyAction(gateway({}, { read: 900, model: 'other/model' }), once, 482000).action, 'fire');
  assert.equal(policyAction(gateway({}, { read: 900 }), chained, 483000).action, 'fire');
});

test('only a keepalive that read the cache renews the anchor', () => {
  assert.equal(policyAction(gateway({}, { read: 0, write: 900 }), enabled, 100).dueAt, 482000);
  assert.equal(policyAction(gateway({}, { read: 900, write: 0 }), enabled, 100).dueAt, 483000);
  assert.equal(policyAction(gateway({}, { read: 900, write: 0, model: 'other/model' }), enabled, 100).dueAt, 482000);
});

test('a gateway policy stops after max idle and only enabled rows with a safe time act', () => {
  assert.equal(policyAction(gateway({ completedAt: 1000 }, { read: 900 }), { ...enabled, maxIdle: 600 }, 601000).action, 'idle');
  for (const status of ['shadow', 'insufficient_data', 'demoted', 'fixed_window', 'native']) assert.equal(policyAction(gateway(), { ...enabled, status }, 100).action, 'monitor');
  assert.equal(policyAction(gateway(), { ...enabled, safe: null }, 100).action, 'monitor');
  assert.equal(policyAction(gateway(), undefined, 100).action, 'monitor');
});

test('rows with a reported cache creation, such as Claude behind a gateway, are never governed by a policy', () => {
  const claude = gateway({ model: 'claude-opus-5', cacheCreation: { fiveMinute: 100, oneHour: 0 } });
  assert.equal(policyRow(claude), false);
  assert.equal(policyAction(claude, enabled, 100).action, 'monitor');
  assert.equal(cacheStatus(claude, 2000).state, 'warm');
  assert.equal(cacheStatus(claude, 2000).ttl, '5m');
  assert.equal(policyRow(gateway({ read: 0, write: 0 })), false);
});

test('the policy anchor falls back to the start time of a request that never completed', () => {
  const row = cacheRows([sample({ startedAt: 2000, read: 0, write: 900, fresh: 10 })])[0];
  assert.equal(policyAction(row, { status: 'enabled', safe: 480, maxIdle: null }, 2000).dueAt, 482000);
});

const served = (extra = {}) => ({ status: 'enabled', safe: 240, maxIdle: 3600, refreshOnRead: null, source: 'learned', pResume: null, ...extra });

test('the lifetime chain is native, then the server row by source, then the client TTL, then unknown', () => {
  const row = gateway();
  assert.equal(lifetimeOf(gateway({ model: 'claude-opus-5', cacheCreation: { fiveMinute: 100, oneHour: 0 } }), served(), 300000).source, 'native');
  assert.equal(lifetimeOf(undefined, served(), 300000).source, 'unknown');
  assert.deepEqual(lifetimeOf(row, served({ source: 'documented', refreshOnRead: true }), 900000), { source: 'documented', controlled: true, once: false, shownS: 240,
    policy: { status: 'enabled', safe: 240, maxIdle: 3600, refreshOnRead: true, pResume: null } });
  assert.equal(lifetimeOf(row, served({ source: null }), null).source, 'learned');
  assert.equal(lifetimeOf(row, served({ status: 'no_cache' }), 900000).source, 'none');
  const demoted = lifetimeOf(row, served({ status: 'demoted', reason: 'misses' }), 900000);
  assert.deepEqual([demoted.source, demoted.policy, demoted.reason], ['unknown', undefined, 'misses']);
  const client = lifetimeOf(row, served({ status: 'shadow' }), 900000);
  assert.deepEqual([client.source, client.shownS, client.policy.safe, client.policy.refreshOnRead], ['client', 900, 810, null]);
  assert.equal(lifetimeOf(row, undefined, 60000).policy.safe, 50);
  assert.equal(lifetimeOf(row, undefined, 3600000).policy.safe, 3240);
  assert.equal(lifetimeOf(row, served({ status: 'fixed_window' }), 900000).source, 'unknown');
  const watched = lifetimeOf(row, served({ status: 'monitor', reason: 'ttl_too_short' }), 900000);
  assert.deepEqual([watched.source, watched.policy, watched.status, watched.reason], ['unknown', undefined, 'monitor', 'ttl_too_short']);
  assert.equal(lifetimeLabel(watched), '◌ monitor (ttl_too_short)');
  assert.equal(lifetimeLabel({ source: 'unknown', status: 'monitor' }), '◌ monitor');
  assert.equal(lifetimeOf(row, served({ status: 'insufficient_data' }), 900000).source, 'client');
  assert.equal(lifetimeOf(row, served({ status: 'enabled', safe: null }), null).status, 'enabled');
  assert.deepEqual(lifetimeOf(row, undefined, null), { source: 'unknown' });
});

test('lifetimes are labelled with their source icon', () => {
  const row = gateway();
  assert.equal(lifetimeLabel(lifetimeOf(row, served({ source: 'default', safe: 300 }), null)), '◇ 5m · once');
  assert.equal(lifetimeLabel(lifetimeOf(row, served({ source: 'documented', safe: 1680, refreshOnRead: true }), null)), '▣ 28m');
  assert.equal(lifetimeLabel(lifetimeOf(row, served({ safe: 95 }), null)), '✦ 1m 35s · once');
  assert.equal(lifetimeLabel(lifetimeOf(row, served({ safe: 3600 }), null)), '✦ 1h · once');
  assert.equal(lifetimeLabel(lifetimeOf(row, served({ safe: 45 }), null)), '✦ 45s · once');
  assert.equal(lifetimeLabel(lifetimeOf(row, undefined, 900000)), '✎ 15m');
  assert.equal(lifetimeLabel({ source: 'none' }), '⊘ no cache');
  assert.equal(lifetimeLabel({ source: 'unknown', status: 'demoted', reason: 'misses' }), '◌ demoted · misses');
  assert.equal(lifetimeLabel({ source: 'unknown', status: 'demoted' }), '◌ demoted');
  assert.equal(lifetimeLabel({ source: 'unknown', status: 'insufficient_data' }), '◌ insufficient data');
  assert.equal(lifetimeLabel({ source: 'unknown' }), '◌');
  assert.equal(lifetimeLabel({ source: 'native' }), undefined);
  assert.equal(lifetimeLabel({ source: 'native' }, 'uncached'), 'uncached');
  assert.equal(SOURCE_ICONS.native, '◉');
});

test('client TTL settings: a global choice, per-model overrides, never for Claude', () => {
  assert.deepEqual(parseTtlOverrides('kimi*=15m, glm-5.3=OFF, bad, x=2h, a=b=c, =5m\nz.y=1h'), [['kimi*', '15m'], ['glm-5.3', 'off'], ['z.y', '1h']]);
  assert.deepEqual(parseTtlOverrides(undefined), []);
  assert.equal(fallbackTtl('15m'), '15m');
  assert.equal(fallbackTtl('off'), 'off');
  assert.equal(fallbackTtl('toString'), undefined);
  assert.equal(fallbackTtl(5), undefined);
  assert.equal(clientTtl('kimi-k3', undefined), null);
  assert.equal(clientTtl('kimi-k3', 'off'), null);
  assert.equal(clientTtl('kimi-k3', '30m'), 1800000);
  assert.equal(clientTtl('vendor/kimi-k3', '30m', [['vendor/kimi*', '5m']]), 300000);
  assert.equal(clientTtl('glm-5.3', '30m', [['glm-5.3', 'off']]), null);
  assert.equal(clientTtl('glm-5x3', '30m', [['glm-5.3', 'off']]), 1800000);
  assert.equal(clientTtl('claude-opus-5', '1h'), null);
});

test('the keepalive prompt is neutral and carries nothing plugin-specific', () => {
  assert.equal(KEEPALIVE_PROMPT, 'Reply with only: K');
});

test('a keepalive is worth sending only when the chance of resuming times the saving beats its cost', () => {
  const prices = { read: 0.1, fiveMinute: 1.25, output: 5 };
  assert.equal(savingsWorthwhile(0.2, prices), true);
  assert.equal(savingsWorthwhile(0.08, prices), false);
  assert.equal(savingsWorthwhile(1, { read: 0.4, output: 1 }), true);
  assert.equal(savingsWorthwhile(1, null), false);
});

const fixedRow = (...samples) => cacheRows(samples.map((s, i) => sample({ turnId: s.turnId ?? `t${i}`, completedAt: s.at, startedAt: s.at - 100, ...s })))[0];
const fixed = { status: 'enabled', safe: 240, maxIdle: null, refreshOnRead: false };

test('a fixed window runs from the write that established the prefix, not from later reads', () => {
  const row = fixedRow({ at: 1000, read: 0, write: 900, fresh: 10 }, { at: 100000, read: 900, write: 20, fresh: 10 });
  assert.equal(policyAction(row, fixed, 1000).dueAt, 241000);
  assert.equal(policyAction(row, fixed, 241000 - POLICY_TICK_MS).action, 'fire');
  assert.equal(policyAction(row, fixed, 241001).action, 'missed');
  const rewritten = fixedRow({ at: 1000, read: 0, write: 900, fresh: 10 }, { at: 100000, read: 100, write: 800, fresh: 10 });
  assert.equal(policyAction(rewritten, fixed, 100000).dueAt, 340000);
  assert.equal(policyAction(fixedRow({ at: 1000, read: 900, write: 100, fresh: 10 }), fixed, 1000).action, 'monitor');
});

test('a fixed window gets one keepalive, even when it rewrote the cache', () => {
  const row = (extra = {}) => cacheRows([sample({ completedAt: 1000, startedAt: 900, read: 0, write: 900 }), sample({ turnId: 'keepalive:1', startedAt: 150000, completedAt: 150100, ...extra })])[0];
  const read = policyAction(row({ read: 900, write: 0 }), fixed, 160000);
  assert.equal(read.action, 'sent');
  const rewrote = policyAction(row({ read: 0, write: 900 }), fixed, 160000);
  assert.equal(rewrote.action, 'sent');
});

test('a client TTL counts from the start of the request, a served row from its completion', () => {
  const row = cacheRows([sample({ startedAt: 1000, completedAt: 61000, read: 0, write: 900 })])[0];
  const client = lifetimeOf(row, undefined, 300000).policy;
  assert.equal(client.anchorOnStart, true);
  assert.equal(policyAction(row, client, 1000).dueAt, 1000 + 270000);
  assert.equal(policyAction(row, { status: 'enabled', safe: 270, maxIdle: null, refreshOnRead: null }, 1000).dueAt, 61000 + 270000);
});

test('a fixed window anchors only on a write of at least half the current prefix', () => {
  const rows = (second) => cacheRows([sample({ turnId: 'a', completedAt: 1000, startedAt: 900, read: 0, write: 40000 }),
    sample({ turnId: 'b', completedAt: 100000, startedAt: 99000, ...second })])[0];
  assert.equal(policyAction(rows({ read: 40000, write: 60000 }), fixed, 100000).dueAt, 100000 + 240000);
  assert.equal(policyAction(rows({ read: 60000, write: 40000 }), fixed, 100000).action, 'monitor');
  assert.equal(policyAction(rows({ read: 40000, write: 20000 }), fixed, 100000).dueAt, 1000 + 240000);
});

test('a governed row counts down to the refresh time from the same deadline policyAction fires on', () => {
  const row = gateway();
  const life = lifetimeOf(row, served({ source: 'default', safe: 229 }), null);
  const base = cacheStatus(row, 100000);
  const status = lifetimeStatus(row, life, 100000, base);
  assert.equal(status.leftMs, 2000 + 229000 - 100000);
  assert.equal(status.state, 'warm');
  assert.equal(status.lifetimes[0].ttlMs, 229000);
  assert.equal(cacheDial(status), '◕');
  assert.equal(lifetimeLabel({ ...life, left: 129 }), '◇ 2m 9s · once');
  assert.equal(lifetimeLabel({ ...life, left: 0 }), '◇ expired');
  assert.equal(lifetimeLabel({ ...life, phase: 'sent' }), '◇ sent · once');
  assert.equal(lifetimeLabel({ ...life, phase: 'idle' }), '◇ idle');
  assert.equal(lifetimeLabel({ ...life, phase: 'missed' }), '◇ missed');
  assert.equal(lifetimeLabel({ source: 'default', left: 60 }), '◇ 1m');
  assert.equal(lifetimeStatus(row, life, 400000, base).state, 'expired');
  assert.equal(lifetimeStatus(row, life, 400000, base).phase, 'missed');
  assert.equal(lifetimeStatus(row, { source: 'unknown' }, 1, base), base);
  assert.equal(lifetimeStatus(row, life, 1, { ...base, state: 'uncached' }).state, 'uncached');
  const noWrite = fixedRow({ at: 1000, read: 900, write: 100, fresh: 10 });
  const fixedLife = lifetimeOf(noWrite, served({ refreshOnRead: false }), null);
  assert.equal(lifetimeStatus(noWrite, fixedLife, 1, cacheStatus(noWrite, 1)).state, cacheStatus(noWrite, 1).state);
});
