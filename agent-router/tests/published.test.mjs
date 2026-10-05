import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRequest } from '../lib/bridge.mjs';
import { policyFromOptions } from '../lib/policy.mjs';
import { readRoutes, routesFile } from '../lib/shared/routes.mjs';
import { linkTeammate } from '../lib/state.mjs';
import { modelOptions } from './fixtures.mjs';

const policy = policyFromOptions({ ...modelOptions, scout_effort: 'low' });
const catalog = async () => Object.values(policy.roles).map(({ model }) => ({ id: model }));

async function fixture(t, env = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-router-published-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const full = { CLAUDE_PLUGIN_DATA: root, ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_API_KEY: 'secret-key-value', ...env };
  const request = (action, fields = {}) => handleRequest({ action, session_id: 'lead', options: { ...modelOptions, scout_effort: 'low' }, ...fields }, full, catalog);
  return { root, request };
}

test('every routed agent is published for Keepalive to read, with only its route', async t => {
  const { root, request } = await fixture(t);
  await request('bootstrap');
  assert.deepEqual(await readRoutes(root, 'lead'), { version: 1, sessionId: 'lead', leadSessionId: null, self: null, teammate: null, agents: [], teammates: [] });
  await request('route', { tool_use_id: 'call-1', requestedType: 'Explore', requestedModel: 'PRIVATE_PROMPT_MODEL', effectiveType: 'agent-router:scout' });
  await request('result', { tool_use_id: 'call-1', result: { agentId: 'scout1', model: 'vendor/search-v1' } });
  const routes = await readRoutes(root, 'lead');
  assert.deepEqual(routes.agents, [{ agentId: 'scout1', kind: 'subagent', role: 'scout', model: 'vendor/search-v1', effort: 'low' }]);
  const raw = await readFile(routesFile(root, 'lead'), 'utf8');
  for (const secret of ['secret-key-value', 'PRIVATE', 'gateway.example', 'digest', 'policy']) assert.equal(raw.includes(secret), false, secret);
});

test('a lead publishes its split-pane teammates, and an inactive session publishes nothing routed', async t => {
  const { root, request } = await fixture(t);
  await request('bootstrap');
  await linkTeammate(root, 'lead', 'pane-session');
  await request('route', { kind: 'teammate', name: 'worker', tool_use_id: 'call-2', requestedType: 'agent-router:task', effectiveType: 'agent-router:task' });
  await request('result', { tool_use_id: 'call-2', result: { agentId: 'worker@team', model: 'vendor/task-v1', backend: 'tmux' } });
  const routes = await readRoutes(root, 'lead');
  assert.deepEqual(routes.teammates, ['pane-session']);
  assert.deepEqual(routes.agents, [{ agentId: 'worker@team', kind: 'teammate', role: 'task', model: 'vendor/task-v1', name: 'worker', backend: 'tmux' }]);
  const inactive = await fixture(t, { ANTHROPIC_BASE_URL: undefined });
  await inactive.request('bootstrap');
  assert.deepEqual((await readRoutes(inactive.root, 'lead')).agents, []);
});

test('a malformed published file reads as absent instead of failing the cache bar', async t => {
  const { root, request } = await fixture(t);
  await request('bootstrap');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(routesFile(root, 'lead'), JSON.stringify({ version: 1, sessionId: 'lead', agents: 'nope' }));
  assert.equal(await readRoutes(root, 'lead'), null);
  assert.equal(await readRoutes(root, 'never-started'), null);
});
