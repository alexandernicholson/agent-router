import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cachePolicy, cacheRows, cacheStatus, cacheBar, cacheClock, loopKey, applyCacheCreation, cacheGrade, cachePercent, lifeGrade, isKeepalive, keepaliveWorthwhile, cacheDial, cacheBarParts, isCompaction } from '../lib/cache.js';
import { recordCacheSample, resetCache, cacheSnapshot } from '../lib/cache-state.mjs';
import { recordPath, writeRecord, linkTeammate } from '../lib/state.mjs';
import { handleRequest } from '../lib/bridge.mjs';

const sample = (extra = {}) => ({ sessionId: 'lead', agentId: null, turnId: 'turn', index: 0, model: 'vendor/main',
  startedAt: 1000, read: 800, write: 100, fresh: 100, output: 20, ttlMs: 300000, ttlSource: 'plugin estimate', disabled: false, ...extra });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-router-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('missing response metadata stays unknown and local flags only indicate disabling', () => {
  assert.equal(cachePolicy().ttlMs, null);
  assert.equal(cachePolicy({ ENABLE_PROMPT_CACHING_1H: '1', FORCE_PROMPT_CACHING_5M: 'true',
    CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' }, 'claude-opus-5').ttlMs, null);
  assert.equal(cachePolicy({ DISABLE_PROMPT_CACHING_OPUS: '1' }, 'claude-opus-5').disabled, true);
  assert.equal(cacheStatus(cacheRows([sample()])[0], 1000).state, 'TTL unknown');
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
  assert.equal(status(sample({ ttlMs: null }), 9999999).state, 'TTL unknown');
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
  await linkTeammate(root, 'lead', 'pane');
  await writeRecord(recordPath(root, 'sessions', 'pane'), { sessionId: 'pane', leadSessionId: 'lead', teammate: { agentId: 'mate', name: 'Worker' } });
  const snapshot = await cacheSnapshot(root, 'lead');
  assert.equal(snapshot.samples.length, 3);
  assert.equal(new Map(snapshot.labels).get(loopKey('pane', null)), 'Worker (mate)');
  const rows = cacheRows(snapshot.samples, snapshot.resets, new Map(snapshot.labels));
  assert.equal(rows.length, 3);
  assert.equal(rows.find(r => r.sessionId === 'pane' && r.agentId === null).label, 'Worker (mate)');
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
  assert.equal(cacheStatus(next, 9500).state, 'TTL unknown');
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
