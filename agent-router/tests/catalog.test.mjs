import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCatalog, filterModels } from '../lib/catalog.js';
import { isExactModelId } from '../lib/routing.js';

test('catalog preserves exact selectable IDs and omits ambiguous or unsafe rows', () => {
  const exact = '/models/模型 sample.gguf';
  const invalid = ['', ' model ', 'sonnet', 'OPUS', 'inherit', 'haiku', 'fable', 'vendor/line\nfeed', 'vendor/\u001b[31mred', 'vendor/\u202ehidden', null];
  for (const id of invalid) assert.equal(isExactModelId(id), false);
  const rows = normalizeCatalog([...invalid.map(id => ({ id })), null, { id: exact }, { id: 'vendor/sonnet-v2' }]);
  assert.deepEqual(rows.map(row => row.id), [exact, 'vendor/sonnet-v2']);
  assert.throws(() => normalizeCatalog(invalid.map(id => ({ id }))), /exact model IDs/);
});

test('display metadata strips terminal sequences and controls while bounding free text', () => {
  const [row] = normalizeCatalog([{
    id: 'vendor/model',
    display_name: '\u001b[31mRed\u001b[0m\u001b]8;;https://example.test\u0007 Link\u001b]8;;\u001b\\\u202e\u0000',
    description: '\u001bPprivate\u001b\\' + 'x'.repeat(700),
    max_input_tokens: 128000,
    max_tokens: 4096,
  }]);
  assert.equal(row.name, 'Red Link');
  assert.equal(row.description, 'x'.repeat(640));
  assert.equal(row.contextWindow, 128000);
  assert.equal(row.outputLimit, 4096);
  assert.equal(normalizeCatalog([{ id: 'vendor/long', name: 'a'.repeat(200) }])[0].name, 'a'.repeat(160));
});

test('metadata falls back to usable alternatives and first duplicate wins', () => {
  const rows = normalizeCatalog([
    { id: 'vendor/model', display_name: '\u001b[0m', name: 'Useful', max_input_tokens: -1, context_window: 100, max_tokens: Infinity, max_output_tokens: 20 },
    { id: 'vendor/model', name: 'Later', context_window: 200 },
    { id: 'vendor/other', context_window: '100', max_output_tokens: 0 },
  ]);
  assert.deepEqual(rows, [
    { id: 'vendor/model', name: 'Useful', description: '', contextWindow: 100, outputLimit: 20 },
    { id: 'vendor/other', name: 'vendor/other', description: '' },
  ]);
});

test('local token filtering matches across name, exact ID, and description', () => {
  const models = normalizeCatalog([
    { id: 'vendor/fast-v2', display_name: 'Swift', description: 'Code review' },
    { id: 'vendor/large-v1', display_name: 'Deep', description: 'Code planning' },
  ]);
  assert.deepEqual(filterModels(models, '  SWIFT review V2 '), [models[0]]);
  assert.deepEqual(filterModels(models, 'code'), models);
  assert.deepEqual(filterModels(models, 'swift planning'), []);
  assert.deepEqual(filterModels(models, ' \t '), models);
});
