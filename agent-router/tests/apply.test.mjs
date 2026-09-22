import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRequest } from '../lib/bridge.mjs';
import { routingStatus, recordPath, readRecord } from '../lib/state.mjs';
import { modelOptions } from './fixtures.mjs';

const changed = { ...modelOptions, reviewer_model: 'vendor/review-v2', reviewer_effort: 'high' };
const catalog = async () => [...new Set([...Object.values(modelOptions), changed.reviewer_model])].map(id => ({ id }));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-router-apply-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { CLAUDE_PLUGIN_DATA: root, ANTHROPIC_BASE_URL: 'https://gateway.example' };
  const request = (action, fields = {}, environment = env, discover = catalog) =>
    handleRequest({ action, session_id: 'one', options: modelOptions, ...fields }, environment, discover);
  await request('bootstrap');
  return { root, env, request };
}

test('apply re-pins the running session to the saved settings', async t => {
  const { root, request } = await fixture(t);
  await request('route', { tool_use_id: 'before', requestedType: 'reviewer', effectiveType: 'agent-router:reviewer' });
  assert.equal((await request('bootstrap', { options: changed })).pendingConfiguration, true);
  const applied = await request('apply', { options: changed });
  assert.equal(applied.active, true);
  assert.equal(applied.pendingConfiguration, false);
  assert.equal(applied.policy.roles.reviewer.model, 'vendor/review-v2');
  assert.equal(applied.policy.roles.reviewer.effort, 'high');
  const reloaded = await request('bootstrap', { options: changed }, undefined, async () => assert.fail('must use the pinned session'));
  assert.equal(reloaded.pendingConfiguration, false);
  assert.equal(reloaded.policy.roles.reviewer.model, 'vendor/review-v2');
  await request('route', { tool_use_id: 'after', options: changed, requestedType: 'reviewer', effectiveType: 'agent-router:reviewer' });
  const routes = (await routingStatus(root)).routes;
  const before = routes.find(route => route.toolUseId === 'before');
  const after = routes.find(route => route.toolUseId === 'after');
  assert.equal(before.effectiveModel, modelOptions.reviewer_model);
  assert.equal(after.effectiveModel, 'vendor/review-v2');
  assert.notEqual(before.policyDigest, after.policyDigest);
});

test('apply refuses models the endpoint does not advertise and keeps the pinned policy', async t => {
  const { root, request } = await fixture(t);
  const unknown = { ...modelOptions, sonic_model: 'vendor/not-advertised' };
  await assert.rejects(request('apply', { options: unknown }), /does not advertise/);
  await assert.rejects(request('apply', { options: { ...modelOptions, scout_model: '' } }), /scout_model/);
  await assert.rejects(request('apply', { options: changed }, undefined, async () => { throw new Error('Catalog unavailable'); }), /unavailable/);
  const pinned = await readRecord(recordPath(root, 'sessions', 'one'));
  assert.equal(pinned.policy.roles.sonic.model, modelOptions.sonic_model);
  assert.equal(pinned.policy.roles.scout.model, modelOptions.scout_model);
});

test('apply keeps the endpoint and override guards of the pinned session', async t => {
  const { request, env } = await fixture(t);
  await assert.rejects(request('apply', { options: changed }, { ...env, ANTHROPIC_BASE_URL: 'https://other.example' }), /changed/);
  await assert.rejects(request('apply', { options: changed }, { ...env, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: 'sonnet' }), /conflicts/);
  await assert.rejects(request('apply', { session_id: 'never-started', options: changed }), /not ready/);
});

test('apply is refused for sessions without a configured endpoint', async t => {
  const { root } = await fixture(t);
  const env = { CLAUDE_PLUGIN_DATA: root };
  await handleRequest({ action: 'bootstrap', session_id: 'inactive', options: modelOptions }, env, async () => assert.fail('no discovery'));
  await assert.rejects(handleRequest({ action: 'apply', session_id: 'inactive', options: changed }, env, catalog), /endpoint/);
});
