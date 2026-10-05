import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyCacheCreation, reportedCacheCreation, cacheRows, cacheStatus, validSample } from '../lib/cache.js';
import { transcriptCreation, transcriptTail } from '../lib/cache-transcript.mjs';
import { recordCacheSample, enrichCacheSamples, cacheSnapshot } from '../lib/cache-state.mjs';
import { handleRequest } from '../lib/bridge.mjs';

const sample = (extra = {}) => ({ sessionId: 'lead', agentId: null, turnId: 'turn', index: 0, model: 'vendor/worker',
  startedAt: 1000, completedAt: 2000, read: 800, write: 100, fresh: 100, output: 20,
  ttlMs: null, ttlSource: 'provider TTL unknown', disabled: false, ...extra });
const usage = (fiveMinute = 100, oneHour = 0) => ({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 800,
  cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: fiveMinute, ephemeral_1h_input_tokens: oneHour } });
const record = (extra = {}, reported = usage()) => ({ type: 'assistant', sessionId: 'lead', timestamp: new Date(1500).toISOString(),
  message: { id: 'msg_one', model: 'vendor/worker', usage: reported, content: [{ type: 'text', text: 'PRIVATE_ANSWER' }] }, ...extra });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-router-cache-response-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('reported 5m or 1h writes override conflicting plugin estimates and caching-disabled flags', () => {
  const prior = sample({ ttlMs: 3600000, ttlSource: 'plugin estimate', disabled: true });
  const short = applyCacheCreation(prior, reportedCacheCreation(usage()));
  assert.equal(short.ttlMs, 300000);
  assert.equal(short.ttlSource, 'response cache_creation');
  assert.equal(short.disabled, false);
  assert.equal(applyCacheCreation(prior, reportedCacheCreation(usage(0, 100))).ttlMs, 3600000);
});

test('mixed reported writes retain two token counts and two independent lifetimes', () => {
  const mixed = applyCacheCreation(sample(), reportedCacheCreation(usage(40, 60)));
  assert.equal(validSample(mixed), true);
  assert.equal(mixed.ttlMs, null);
  const status = cacheStatus(cacheRows([mixed])[0], 401000);
  assert.deepEqual(status.lifetimes.map(p => [p.ttl, p.tokens, p.leftMs]), [['5m', 40, 0], ['1h', 60, 3200000]]);
  // The 1h portion stays warm after the 5m portion expires.
  assert.equal(status.state, 'warm');
  assert.equal(status.leftMs, 3200000);
});

test('missing, null, negative, fractional, inconsistent and read-only bucket metadata never manufactures a TTL', () => {
  for (const value of [undefined, { cache_creation: null }, usage(-1, 101), usage(0.5, 99.5), usage(20, 50),
    { ...usage(0, 0), cache_creation_input_tokens: 0 }, { ...usage(), cache_creation: { ephemeral_5m_input_tokens: 100 } }]) {
    assert.equal(reportedCacheCreation(value), undefined);
  }
  const original = sample();
  assert.equal(applyCacheCreation(original, undefined), original);
});

test('transcript correlation requires matching session, loop, model, full counts and request interval', () => {
  assert.deepEqual(transcriptCreation(JSON.stringify(record()), sample()), { fiveMinute: 100, oneHour: 0 });
  for (const other of [record({ sessionId: 'other' }), record({ agentId: 'child' }), record({ timestamp: new Date(999).toISOString() }),
    record({ timestamp: new Date(2001).toISOString() }), record({}, { ...usage(), output_tokens: 21 }),
    record({ message: { ...record().message, model: 'vendor/other' } })]) {
    assert.equal(transcriptCreation(JSON.stringify(other), sample()), undefined);
  }
  assert.equal(transcriptCreation(JSON.stringify(record()), sample({ completedAt: undefined })), undefined);
});

test('duplicate blocks of the same API message count once; multiple responses or conflicting copies are rejected', () => {
  const line = JSON.stringify(record());
  assert.deepEqual(transcriptCreation(`${line}\n${line}\npartial{`, sample()), { fiveMinute: 100, oneHour: 0 });
  const second = record({ message: { ...record().message, id: 'msg_two' } });
  assert.equal(transcriptCreation(`${line}\n${JSON.stringify(second)}`, sample()), undefined);
  assert.equal(transcriptCreation(`${line}\n${JSON.stringify(record({}, usage(0, 100)))}`, sample()), undefined);
});

test('late transcript flush enriches persisted requests without doubling totals or retaining content', async t => {
  const root = await fixture(t);
  const path = join(root, 'transcript.jsonl');
  const first = await recordCacheSample(root, 'lead', sample(), path);
  assert.equal(first.sample.ttlMs, null);
  await writeFile(path, JSON.stringify(record()) + '\n');
  const enriched = await enrichCacheSamples(root, 'lead', null, path);
  assert.equal(enriched.samples[0].ttlMs, 300000);
  assert.equal((await enrichCacheSamples(root, 'lead', null, path)).samples.length, 0);
  const snapshot = await cacheSnapshot(root, 'lead');
  assert.equal(snapshot.samples.length, 1);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_ANSWER'), false);
  assert.equal(JSON.stringify(snapshot).includes('transcript.jsonl'), false);
});

test('child transcript metadata enriches only that agent, including third-party responses', async t => {
  const root = await fixture(t);
  const path = join(root, 'child.jsonl');
  await writeFile(path, JSON.stringify(record({ agentId: 'child' }, usage(0, 100))) + '\n');
  const env = { CLAUDE_PLUGIN_DATA: root, ANTHROPIC_BASE_URL: 'https://third-party.example' };
  const result = await handleRequest({ action: 'cache-sample', session_id: 'lead', sample: sample({ agentId: 'child' }), transcript_path: path }, env);
  assert.equal(result.sample.ttlMs, 3600000);
  const main = await recordCacheSample(root, 'lead', sample(), path);
  assert.equal(main.sample.ttlMs, null);
});

test('unreadable, truncated or non-transcript paths fall back without breaking observations', async t => {
  const root = await fixture(t);
  assert.equal(await transcriptTail(join(root, 'missing.jsonl')), '');
  const path = join(root, 'data.txt');
  await writeFile(path, JSON.stringify(record()));
  assert.equal(await transcriptTail(path), '');
  const partial = join(root, 'partial.jsonl');
  await writeFile(partial, '{"type":"assistant",');
  const result = await recordCacheSample(root, 'lead', sample(), partial);
  assert.equal(result.sample.ttlMs, null);
});
