import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, chmod, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleRequest } from '../lib/bridge.mjs';
import { cachePolicy, cacheRows, cacheStatus, cacheTokens, cacheDial, cachePercent, sampleTtl, sessionMatrix, unreportedModels, applyCacheCreation, loopKey } from '../lib/cache.js';
import { recordCacheSample, enrichCacheSamples, resetCache, cacheSnapshot, linkSession } from '../lib/cache-state.mjs';
import { transcriptTail, transcriptCreation } from '../lib/cache-transcript.mjs';
import { modelKey, priceIndex, matchPrices } from '../lib/model-match.js';
import { modelPrices } from '../lib/model-prices.mjs';
import { modelsDevPrices } from '../lib/price-sources.mjs';
import { linkedSessions, recordPath, writeRecord } from '../lib/state.mjs';
import { migrateFromRouter } from '../lib/migrate.mjs';
import { writeRoutes } from '../lib/shared/routes.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sample = (extra = {}) => ({ sessionId: 'lead', agentId: null, turnId: 'turn', index: 0, model: 'vendor/main',
  startedAt: 1000, read: 800, write: 100, fresh: 100, output: 20, ttlMs: null, ttlSource: 'x', disabled: false, ...extra });

async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'keepalive-edges-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('the bridge refuses malformed input and unknown actions, and answers identity, link and reset', async t => {
  const data = await temp(t);
  const env = { CLAUDE_PLUGIN_DATA: data };
  await assert.rejects(handleRequest(null, env), /bridge JSON object/);
  await assert.rejects(handleRequest([], env), /bridge JSON object/);
  await assert.rejects(handleRequest({ action: 'bootstrap' }, env), /Unknown Keepalive bridge action/);
  assert.deepEqual(await handleRequest({ action: 'identity' }, {}), { teammate: null });
  assert.deepEqual(await handleRequest({ action: 'identity', teammate: { agentId: 'a' } }, {}), { teammate: { agentId: 'a' } });
  assert.deepEqual(await handleRequest({ action: 'migrate', session_id: 's' }, env), { migrated: false, handover: null });
  const router = await temp(t);
  const migrated = await handleRequest({ action: 'migrate', session_id: 's' }, env, { routerData: router });
  assert.deepEqual(migrated, { migrated: false, copied: [], handover: null });
  assert.deepEqual(await handleRequest({ action: 'link', session_id: 'pane', lead_session_id: 'lead', label: 'w' }, env), {});
  assert.deepEqual(await linkedSessions(data, 'lead'), [{ sessionId: 'pane', label: 'w' }]);
  assert.deepEqual(await handleRequest({ action: 'cache-reset', session_id: 'lead', reset_at: 5 }, env), {});
  assert.deepEqual(await handleRequest({ action: 'cache-reset', session_id: 'lead', agent_id: 'a', reset_at: 6 }, env), {});
  assert.deepEqual(await handleRequest({ action: 'cache-enrich', session_id: 'lead' }, env), { samples: [] });
  await assert.rejects(handleRequest({ action: 'cache-prices', session_id: 's', models: 'x' }, env), /up to 16/);
});

test('cache state checks every identity, link and reset it is given', async t => {
  const data = await temp(t);
  await assert.rejects(resetCache(data, 'lead', '', 5), /identity/);
  await assert.rejects(resetCache(data, 'lead', null, -1), /reset time/);
  await assert.rejects(resetCache(data, 'lead', null, 1.5), /reset time/);
  await assert.rejects(enrichCacheSamples(data, 'lead', '', 'x.jsonl'), /identity/);
  await assert.rejects(linkSession(data, 'lead', 'lead'), /link to itself/);
  await linkSession(data, 'lead', 'quiet');
  assert.deepEqual(await linkedSessions(data, 'lead'), [{ sessionId: 'quiet', label: null }]);
  const saved = await recordCacheSample(data, 'lead', { ...sample(), cacheCreation: { fiveMinute: 100, oneHour: 0 } });
  assert.deepEqual(saved.sample.cacheCreation, { fiveMinute: 100, oneHour: 0 });
  await recordCacheSample(data, 'lead', sample({ turnId: 'w', write: 50, read: 0, completedAt: 1100 }));
  const transcript = join(data, 'main.jsonl');
  await writeFile(transcript, 'not json\n');
  assert.deepEqual(await enrichCacheSamples(data, 'lead', null, transcript), { samples: [] });
});

test('a snapshot labels a published teammate without a name, keeps an effort, and drops a reset for an odd agent id', async t => {
  const data = await temp(t);
  const router = await temp(t);
  await writeRoutes(router, { sessionId: 'lead', leadSessionId: null, self: null, teammate: null, teammates: ['pane'],
    agents: [{ agentId: 'a1', kind: 'subagent', role: 'scout', model: 'vendor/s', effort: 'low' }] });
  await writeRoutes(router, { sessionId: 'pane', leadSessionId: 'lead', self: { role: 'task', model: 'vendor/t' }, teammate: { agentId: 'w@t', name: null }, teammates: [], agents: [] });
  await recordCacheSample(data, 'pane', sample({ sessionId: 'pane' }));
  await writeRecord(recordPath(data, 'cache-resets', 'lead', 'odd'), { sessionId: 'lead', agentId: 7, resetAt: 3 });
  await writeRecord(recordPath(data, 'cache-resets', 'lead', 'ok'), { sessionId: 'lead', agentId: 'a1', resetAt: 3 });
  const snapshot = await cacheSnapshot(data, 'lead', router);
  assert.equal(new Map(snapshot.labels).get(loopKey('pane', null)), 'Teammate (w@t)');
  assert.deepEqual(snapshot.routes.agents, [{ agentId: 'a1', model: 'vendor/s', kind: 'subagent', effort: 'low' }]);
  assert.deepEqual(snapshot.resets, [{ sessionId: 'lead', agentId: 'a1', resetAt: 3 }]);
});

test('the cache policy reads each model family and boolean spelling', () => {
  assert.equal(cachePolicy({ DISABLE_PROMPT_CACHING_HAIKU: 'TRUE' }, 'claude-haiku-4-5').disabled, true);
  assert.equal(cachePolicy({ DISABLE_PROMPT_CACHING_SONNET: '1' }, 'claude-sonnet-5-5').disabled, true);
  assert.equal(cachePolicy({ DISABLE_PROMPT_CACHING_SONNET: '1' }, 'claude-opus-5-5').disabled, false);
  assert.equal(cachePolicy({}, 'vendor/other').disabled, false);
  assert.equal(cachePolicy().disabled, false);
});

test('token counts read in plain numbers, thousands and millions', () => {
  assert.equal(cacheTokens(999), '999');
  assert.equal(cacheTokens(1500), '1.5k');
  assert.equal(cacheTokens(2400000), '2.4m');
});

test('a 1h miss is judged expired against a one-hour lifetime', () => {
  const warm = applyCacheCreation(sample({ startedAt: 0, read: 340000, write: 3000 }), { fiveMinute: 0, oneHour: 3000 });
  const next = time => cacheRows([warm, sample({ turnId: 'n', startedAt: time, read: 0, write: 343000, requested: '1h' })])[0].last.miss;
  assert.equal(next(1000000), 'TTL changed');
  const both = applyCacheCreation(sample({ startedAt: 0, read: 340000, write: 3000, requested: '1h' }), { fiveMinute: 0, oneHour: 3000 });
  const after = time => cacheRows([both, sample({ turnId: 'n', startedAt: time, read: 0, write: 343000, requested: '1h' })])[0].last.miss;
  assert.equal(after(1000000), 'prefix changed');
  assert.equal(after(3700000), 'expired');
});

test('keepalives priced at nothing leave the count unknown, and a dial without a matching lifetime is the soonest', () => {
  const rows = cacheRows([applyCacheCreation(sample({ read: 0, write: 1000 }), { fiveMinute: 1000, oneHour: 0 })]);
  assert.equal(cacheStatus(rows[0], 2000).ttl, '5m');
  assert.equal(cacheDial({ ttl: '5m', leftMs: 300000, lifetimes: [{ ttl: '5m', ttlMs: 300000, tokens: 1, leftMs: 300000 }] }), '●');
  assert.equal(cachePercent(undefined), null);
  assert.equal(cachePercent({ read: 0, write: 0, fresh: 0 }), null);
});

test('a request that wrote nothing has no TTL to show, and a keepalive or compaction never marks a model as silent', () => {
  assert.equal(sampleTtl(sample({ write: 0 })), undefined);
  assert.equal(sampleTtl(applyCacheCreation(sample({ write: 100 }), { fiveMinute: 40, oneHour: 60 })), '5m+1h');
  const rows = cacheRows([sample({ turnId: 'keepalive:1', write: 10, completedAt: 1000 }), sample({ turnId: 'compaction:2', startedAt: 2000, write: 10, completedAt: 2000 }), sample({ turnId: 'r', write: 0 })]);
  assert.deepEqual([...unreportedModels(rows, 999999)], []);
  const cells = sessionMatrix(cacheRows([sample({ turnId: 'empty', read: 0, write: 0, fresh: 0 })]));
  assert.deepEqual(cells, []);
});

test('a transcript tail starts at a whole line, a missing file reads as nothing, and odd rows are skipped', async t => {
  const data = await temp(t);
  assert.equal(await transcriptTail(join(data, 'missing.jsonl')), '');
  assert.equal(await transcriptTail(join(data, 'notes.txt')), '');
  assert.equal(await transcriptTail(42), '');
  const big = join(data, 'big.jsonl');
  await writeFile(big, `${'x'.repeat(1024 * 1024 + 10)}\n{"tail":true}\n`);
  assert.equal(await transcriptTail(big), '{"tail":true}\n');
  const s = sample({ completedAt: 3000, startedAt: 1000, read: 800, write: 100, fresh: 100, output: 20 });
  const row = (extra = {}) => JSON.stringify({ type: 'assistant', sessionId: 'lead', timestamp: new Date(2000).toISOString(),
    message: { id: 'm1', model: 'vendor/main', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 } }, ...extra });
  assert.equal(transcriptCreation(row(), s), undefined);
  assert.equal(transcriptCreation(row(), sample()), undefined);
});

test('model names without a date or tokens, and indexes given junk, match nothing', () => {
  assert.equal(modelKey('—'), null);
  assert.equal(priceIndex('not entries').size, 0);
  assert.equal(priceIndex([['p', 'claude-opus-5-5', null, 1, 5, 0.1], 'junk']).size, 1);
  assert.equal(matchPrices(priceIndex([]), 'claude-opus-5-5'), null);
});

test('models.dev prices are skipped without a data folder, and a held or stale lock is handled', async t => {
  assert.deepEqual(await modelsDevPrices.prices(['claude-opus-5-5'], {}), {});
  const data = await temp(t);
  const catalog = { anthropic: { models: { 'claude-opus-5-5': { cost: { input: 5, output: 25, cache_read: 0.5 }, canonical_model_id: 'anthropic/x' } } } };
  let calls = 0;
  const fetcher = async () => { calls++; return new Response(JSON.stringify(catalog), { status: 200 }); };
  await writeFile(join(data, 'models-dev.lock'), String(Date.now()));
  assert.equal((await modelPrices(data, ['claude-opus-5-5'], {}, fetcher)).catalog, 'missing');
  assert.equal(calls, 0);
  await writeFile(join(data, 'models-dev.lock'), 'not a time');
  await writeFile(join(data, 'models-dev.json'), '[]');
  assert.equal((await modelPrices(data, ['claude-opus-5-5'], {}, fetcher)).catalog, 'fresh');
  assert.equal(calls, 1);
  const locked = await temp(t);
  await mkdir(join(locked, 'models-dev.lock'));
  assert.equal((await modelPrices(locked, ['claude-opus-5-5'], {}, fetcher)).catalog, 'missing');
});

test('a models.dev error status is retried later, and a cached file that is not an object is ignored', async t => {
  const data = await temp(t);
  await writeFile(join(data, 'models-dev.json'), 'null');
  const failing = async () => new Response('down', { status: 503 });
  const result = await modelPrices(data, ['claude-opus-5-5'], {}, failing);
  assert.equal(result.catalog, 'missing');
  assert.equal(Number.isSafeInteger(JSON.parse(await readFile(join(data, 'models-dev.json'), 'utf8')).failedAt), true);
});

test('migration skips a router entry that is a file, not a folder', async t => {
  const data = await temp(t);
  const router = await temp(t);
  await writeFile(join(router, 'cache-samples'), 'not a folder');
  assert.deepEqual(await migrateFromRouter(data, router), { migrated: false, copied: [] });
});

test('the bridge script answers identity from the command line', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'bridge.mjs')], { input: JSON.stringify({ action: 'identity' }), encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { teammate: null });
});

test('a keepalive that would cost nothing leaves the count unknown, rather than infinite', async () => {
  const { keepalivesLeft } = await import('../lib/cache.js');
  const row = cacheRows([applyCacheCreation(sample({ read: 900, write: 100 }), { fiveMinute: 100, oneHour: 0 })])[0];
  assert.equal(keepalivesLeft(row, { read: 0, output: 0 }), null);
});

test('a TTL reported for a request that asked for none is shown as reported', () => {
  assert.equal(sampleTtl(applyCacheCreation(sample({ write: 100 }), { fiveMinute: 100, oneHour: 0 })), '5m');
  assert.equal(sampleTtl(sample({ write: 100, requested: '1h' })), '1h');
});

test('migration copies a models.dev price file when the router had one', async t => {
  const data = await temp(t);
  const router = await temp(t);
  await writeFile(join(router, 'models-dev.json'), '{"fetchedAt":1,"entries":[]}');
  assert.deepEqual(await migrateFromRouter(data, router), { migrated: true, copied: ['models-dev.json'] });
  assert.equal(await readFile(join(data, 'models-dev.json'), 'utf8'), '{"fetchedAt":1,"entries":[]}');
});

test('a transcript that opens but cannot be read reads as nothing', async t => {
  const data = await temp(t);
  await mkdir(join(data, 'folder.jsonl'));
  assert.equal(await transcriptTail(join(data, 'folder.jsonl')), '');
});

test('a 1h-only write shows as 1h', () => {
  assert.equal(sampleTtl(applyCacheCreation(sample({ write: 100 }), { fiveMinute: 0, oneHour: 100 })), '1h');
});
