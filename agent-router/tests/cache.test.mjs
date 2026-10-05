import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cachePolicy, cacheRows, cacheStatus, cacheBar, cacheClock, loopKey, applyCacheCreation } from '../lib/cache.js';
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
  // Persisted estimates from an older version cannot produce a warm/expiry bar.
  assert.equal(cacheStatus(sample(), 1000).state, 'TTL unknown');
  assert.equal(cacheStatus(sample(), 9999999).leftMs, null);
  const old = cacheRows([sample()])[0].last;
  assert.equal(old.ttlMs, null);
  assert.equal(old.ttlSource, 'response TTL metadata absent');
});

test('read ratio excludes output and countdown starts at dispatch, not response completion', () => {
  assert.equal(cacheStatus(sample({ output: 1000000 }), 101000).ratio, 0.8);
  const reported = applyCacheCreation(sample(), { fiveMinute: 100, oneHour: 0 });
  assert.equal(cacheStatus(reported, 101000).leftMs, 200000);
  assert.equal(cacheStatus(reported, 301000).state, 'reported 5m writes · likely expired');
  assert.equal(cacheStatus(sample({ ttlMs: null }), 9999999).state, 'TTL unknown');
  assert.equal(cacheStatus(sample({ read: 0, write: 0 }), 1000).state, 'uncached');
  assert.equal(cacheStatus(sample({ read: 0, write: 0, fresh: 0 }), 1000).ratio, null);
  assert.equal(cacheStatus(sample({ disabled: true }), 1000).state, 'disabled');
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
