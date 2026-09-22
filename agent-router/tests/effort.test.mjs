import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRequest } from '../lib/bridge.mjs';
import { policyFromOptions, policyDigest } from '../lib/policy.mjs';
import { routeAgent, validatePolicy } from '../lib/routing.js';
import { routingStatus } from '../lib/state.mjs';
import { modelOptions } from './fixtures.mjs';

const catalog = async () => Object.values(modelOptions).map(id => ({ id }));

test('role efforts come from options and default leaves the engine effort alone', () => {
  const policy = policyFromOptions({ ...modelOptions, scout_effort: 'low', security_reviewer_effort: 'max', task_effort: 'default' });
  assert.equal(policy.roles.scout.effort, 'low');
  assert.equal(policy.roles['security-reviewer'].effort, 'max');
  assert.equal('effort' in policy.roles.task, false);
  assert.equal('effort' in policy.roles.reviewer, false);
  assert.equal(routeAgent(policy, { subagentType: 'Explore' }).effort, 'low');
  assert.equal(routeAgent(policy, { subagentType: 'Plan' }).effort, undefined);
});

test('unknown effort levels are refused rather than silently ignored', () => {
  assert.throws(() => policyFromOptions({ ...modelOptions, sonic_effort: 'turbo' }), /sonic_effort/);
  const policy = policyFromOptions(modelOptions);
  assert.throws(() => validatePolicy({ ...policy, roles: { ...policy.roles, scout: { ...policy.roles.scout, effort: 9 } } }), /effort/);
});

test('policies without effort keep their digest so pinned sessions stay current', () => {
  const plain = policyFromOptions(modelOptions);
  const defaulted = policyFromOptions({ ...modelOptions, scout_effort: 'default' });
  assert.equal(policyDigest(defaulted), policyDigest(plain));
  // Digest of the pre-effort normalization, fixed so a format change is caught.
  assert.equal(policyDigest(plain), '9cf0118a0a3bb53c25791936dff0b80e8acb522e3ba3c70379339adbda36b4a7');
  assert.notEqual(policyDigest(policyFromOptions({ ...modelOptions, scout_effort: 'high' })), policyDigest(plain));
});

test('an effort change is pending for the pinned session and recorded on routes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-router-effort-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { CLAUDE_PLUGIN_DATA: root, ANTHROPIC_BASE_URL: 'https://gateway.example' };
  const options = { ...modelOptions, reviewer_effort: 'xhigh' };
  const request = (action, fields = {}) => handleRequest({ action, session_id: 'one', options, ...fields }, env, catalog);
  const started = await request('bootstrap');
  assert.equal(started.policy.roles.reviewer.effort, 'xhigh');
  assert.equal(started.pendingConfiguration, false);
  const changed = await request('bootstrap', { options: { ...options, reviewer_effort: 'low' } });
  assert.equal(changed.pendingConfiguration, true);
  assert.equal(changed.policy.roles.reviewer.effort, 'xhigh');
  await request('route', { tool_use_id: 'call-review', requestedType: 'reviewer', effectiveType: 'agent-router:reviewer' });
  await request('route', { tool_use_id: 'call-scout', requestedType: 'Explore', effectiveType: 'agent-router:scout' });
  const routes = (await routingStatus(root)).routes;
  assert.equal(routes.find(route => route.toolUseId === 'call-review').effectiveEffort, 'xhigh');
  assert.equal(routes.find(route => route.toolUseId === 'call-scout').effectiveEffort, null);
});
