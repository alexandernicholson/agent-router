import test from 'node:test';
import assert from 'node:assert/strict';
import { modelKey, priceIndex, matchPrices } from '../lib/model-match.js';

const entries = [
  ['anthropic', 'claude-opus-5-5', 'anthropic', 4, 20, 0.2, 5],
  ['anthropic', 'claude-opus-5', 'anthropic', 5, 25, 0.5, 6.25],
  ['anthropic', 'claude-sonnet-5-5', 'anthropic', 2, 10, 0.2, 2.5],
  ['anthropic', 'claude-haiku-4-5', 'anthropic', 1, 5, 0.1, 1.25],
  ['anthropic', 'claude-haiku-4-5-20251001', 'anthropic', 1, 5, 0.1, 1.25],
  ['amazon-bedrock', 'us.anthropic.claude-opus-5-5', 'anthropic', 4.4, 22, 0.22, 5.5],
  ['google-vertex-anthropic', 'claude-opus-5-5@default', 'anthropic', 4, 20, 0.2, 5],
  ['openrouter', 'anthropic/claude-opus-5.5', 'anthropic', 4, 20, 0.2, 5],
  ['vercel', 'anthropic/claude-opus-5.5-fast', 'anthropic', 8, 40, 0.4, 10],
  ['gitlab', 'duo-chat-opus-5-5', 'anthropic', 0, 0, null, null],
  ['openai', 'gpt-5', 'openai', 1.25, 10, 0.125, null],
  ['azure', 'gpt-5', 'openai', 1.25, 10, 0.125, null],
  ['openai', 'gpt-5-mini', 'openai', 0.25, 2, 0.025, null],
  ['one', 'river-2', null, 1, 4, 0.1, null],
  ['two', 'river-2', null, 1, 4, 0.5, null],
  ['one', 'lake-3', null, 1, 4, 0.1, null],
  ['two', 'lake-3', null, 1, 4, 0.1, null],
  ['three', 'lake-3', null, 1, 4, 0.1, null],
  ['four', 'lake-3', null, 1, 4, 0.3, null],
  ['five', 'stream-1-20250101', null, 1, 4, 0.1, null],
  ['five', 'stream-1-20260101', null, 1, 4, 0.2, null],
  ['six', 'code', null, 1, 4, 0.1, null],
  ['six', 'test', null, 1, 4, 0.1, null],
  ['seven', 'deepseek-chat', 'deepseek', 0.3, 1.2, 0.03, null],
];
const index = priceIndex(entries);
const match = model => matchPrices(index, model);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test('spellings of one model share a key', () => {
  const key = modelKey('claude-opus-5-5');
  for (const spelling of ['claude-opus-5-5[1m]', 'Claude-Opus-5.5', 'anthropic/claude-opus-5.5', 'us.anthropic.claude-opus-5-5-v1:0',
    'global.anthropic.claude-opus-5-5', 'anthropic.claude-opus-5-5', 'claude-opus-5-5@default', 'claude-opus-5-5@eu', 'opus-5-5',
    'gateway/claude-opus-5-5[1m]', 'aws-bedrock/claude-opus-5-5', '  claude-opus-5-5  ']) {
    assert.equal(modelKey(spelling), key, spelling);
  }
  assert.equal(modelKey('claude-3-5-sonnet'), modelKey('claude-sonnet-3-5'));
  assert.equal(modelKey('claude-haiku-4-5-20251001'), modelKey('anthropic.claude-haiku-4-5-20251001-v1:0'));
});

test('different models never share a key', () => {
  const distinct = ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-5-6', 'claude-opus-6', 'claude-sonnet-5-5', 'claude-opus-5-5-fast',
    'claude-opus-5-5-thinking', 'gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4', 'o3', 'o3-mini'];
  assert.equal(new Set(distinct.map(modelKey)).size, distinct.length);
});

test('names without both a family and a version are never matched', () => {
  for (const name of ['', '   ', 'code', 'test', 'vendor/test', 'default', 'claude', 'claude-5', '5-5', 'deepseek-chat', 'x'.repeat(201)]) {
    assert.equal(modelKey(name), null, name);
    assert.equal(match(name), null, name);
  }
  for (const value of [undefined, null, 42, {}]) assert.equal(match(value), null);
});

test('the first-party listing prices a model however a gateway or cloud spells it', () => {
  for (const spelling of ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'us.anthropic.claude-opus-5-5-v1:0', 'claude-opus-5-5@default', 'anthropic/claude-opus-5.5']) {
    const prices = match(spelling);
    near(prices.read, 0.05);
    near(prices.fiveMinute, 1.25);
    near(prices.output, 5);
    assert.deepEqual([prices.provider, prices.id], ['anthropic', 'claude-opus-5-5']);
  }
  near(match('claude-opus-5').read, 0.1);
  near(match('claude-sonnet-5-5').read, 0.1);
  near(match('claude-opus-5-5-fast').read, 0.05);
  assert.equal(match('claude-opus-5-5-fast').id, 'anthropic/claude-opus-5.5-fast');
});

test('models not yet listed, and gateway aliases, stay unmatched', () => {
  for (const name of ['claude-opus-5-6', 'claude-opus-6', 'claude-opus-5-5-thinking', 'claude-sonnet-6', 'anthropic/acme-1-code',
    'anthropic/acme-1-code-task-pro[1m]', 'gpt-6', 'gpt-5-nano']) {
    assert.equal(match(name), null, name);
  }
});

test('a dated snapshot prefers its own listing, then listings that agree', () => {
  assert.equal(match('claude-haiku-4-5-20251001').id, 'claude-haiku-4-5-20251001');
  near(match('claude-haiku-4-5-20991231').read, 0.1);
  near(match('stream-1-20260101').read, 0.2);
  assert.equal(match('stream-1-20270101'), null);
  assert.equal(match('stream-1'), null);
});

test('listings that disagree give no price unless two thirds agree', () => {
  assert.equal(match('river-2'), null);
  const lake = match('lake-3');
  near(lake.read, 0.1);
  assert.equal(lake.fiveMinute, undefined);
  near(lake.output, 4);
  near(match('gpt-5').read, 0.1);
  near(match('gpt-5-mini').read, 0.1);
});

test('listings with no input price or no cache price are ignored', () => {
  assert.equal(match('duo-chat-opus-5-5'), null);
  assert.equal(matchPrices(priceIndex([['x', 'pond-1', null, 1, 4, null, null]]), 'pond-1'), null);
  assert.equal(matchPrices(priceIndex([['x', 'pond-1', null, 'free', 4, 0.1, null], ['y', 'pond-1', null, -1, 4, 0.1, null]]), 'pond-1'), null);
});

test('a listing with a 1h write price passes it on as a multiple of input', () => {
  const priced = priceIndex([['maker', 'pond-2', 'maker', 4, 20, 0.2, 5, 8]]);
  assert.deepEqual(matchPrices(priced, 'pond-2'), { read: 0.05, fiveMinute: 1.25, oneHour: 2, output: 5, provider: 'maker', id: 'pond-2' });
  assert.equal(matchPrices(priceIndex([['maker', 'pond-2', 'maker', 4, 20, 0.2, 5]]), 'pond-2').oneHour, undefined);
  assert.equal(matchPrices(priceIndex([['maker', 'pond-2', 'maker', 4, 20, 0.2, 5, -8]]), 'pond-2').oneHour, undefined);
});
