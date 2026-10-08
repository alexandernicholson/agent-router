import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VERSION } from '../lib/version.js';

const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

test('the version sent in the keepalive prompt is the plugin version', async () => {
  assert.equal(VERSION, (await json('../.claude-plugin/plugin.json')).version);
  assert.equal(VERSION, (await json('../package.json')).version);
});
