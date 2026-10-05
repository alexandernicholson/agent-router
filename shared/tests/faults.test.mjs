import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fault = code => async () => { const error = new Error(`injected ${code}`); error.code = code; throw error; };

async function records(t, overrides) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-router-faults-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.module('node:fs/promises', { namedExports: { ...fs, ...overrides } });
  const module = await import(`../lib/records.mjs?${Object.keys(overrides).join('-')}`);
  return { directory, ...module };
}

test('an exclusive write surfaces a link failure other than the record already existing', async t => {
  const { directory, writeRecord } = await records(t, { link: fault('EPERM') });
  await assert.rejects(writeRecord(join(directory, 'a.json'), { a: 1 }, true), /injected EPERM/);
});

test('a write surfaces a failure to clean up its temporary file, other than it being gone', async t => {
  const { directory, writeRecord } = await records(t, { unlink: fault('EACCES') });
  await assert.rejects(writeRecord(join(directory, 'a.json'), { a: 1 }, true), /injected EACCES/);
});
