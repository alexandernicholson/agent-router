import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRequest } from '../lib/bridge.mjs';
import { policyFromOptions, policyDigest } from '../lib/policy.mjs';
import { routeTeammate, validatePolicy } from '../lib/routing.js';
import { routingStatus, recordPath, readRecord, sessionStats } from '../lib/state.mjs';
import { parseTeammateArgs, readTeammateIdentity } from '../lib/teammate.mjs';
import { modelOptions } from './fixtures.mjs';

const lead = 'aaaaaaaa-1111-4222-8333-444444444444';
const team = 'session-aaaaaaaa';
const mate = 'bbbbbbbb-1111-4222-8333-444444444444';
const catalog = async () => [...new Set([...Object.values(modelOptions), 'vendor/mate-v1'])].map(id => ({ id }));

async function fixture(t, { leadOptions = modelOptions, member = { agentType: 'agent-router:scout' }, configLead = lead } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-router-teammate-test-'));
  const config = await mkdtemp(join(tmpdir(), 'agent-router-teammate-config-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(config, { recursive: true, force: true })]));
  const env = { CLAUDE_PLUGIN_DATA: root, CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: 'https://gateway.example' };
  await mkdir(join(config, 'teams', team), { recursive: true });
  await writeFile(join(config, 'teams', team, 'config.json'), JSON.stringify({
    name: team, leadSessionId: configLead,
    members: [{ agentId: `team-lead@${team}`, name: 'team-lead', agentType: 'team-lead' },
      ...(member ? [{ agentId: `probe@${team}`, name: 'probe', backendType: 'tmux', ...member }] : [])],
  }));
  const request = (action, fields = {}, environment = env, discover = catalog) =>
    handleRequest({ action, options: modelOptions, ...fields }, environment, discover, { confirmMs: 60, stepMs: 10 });
  if (leadOptions) await request('bootstrap', { session_id: lead, options: leadOptions });
  const identity = { agentId: `probe@${team}`, agentName: 'probe', teamName: team, parentSessionId: lead, agentType: 'agent-router:scout' };
  return { root, env, request, identity };
}

test('teammate override takes precedence over the role and default keeps the role', () => {
  const plain = policyFromOptions(modelOptions);
  assert.deepEqual(routeTeammate(plain, { subagentType: 'Explore' }),
    { role: 'scout', type: 'agent-router:scout', model: modelOptions.scout_model });
  const policy = policyFromOptions({ ...modelOptions, teammate_model: 'vendor/mate-v1', teammate_effort: 'high', scout_effort: 'low' });
  assert.deepEqual(policy.teammate, { model: 'vendor/mate-v1', effort: 'high' });
  assert.deepEqual(routeTeammate(policy, { subagentType: 'Explore' }),
    { role: 'scout', type: 'agent-router:scout', model: 'vendor/mate-v1', effort: 'high' });
  assert.deepEqual(routeTeammate(policy, { subagentType: undefined }),
    { role: 'task', type: 'agent-router:task', model: 'vendor/mate-v1', effort: 'high' });
  const effortOnly = policyFromOptions({ ...modelOptions, teammate_effort: 'max', teammate_model: 'default' });
  assert.deepEqual(routeTeammate(effortOnly, { subagentType: 'reviewer' }),
    { role: 'reviewer', type: 'agent-router:reviewer', model: modelOptions.reviewer_model, effort: 'max' });
  assert.throws(() => routeTeammate(plain, { subagentType: 'Plan' }), /Plan/);
  assert.throws(() => routeTeammate(plain, { subagentType: 'fork' }), /fork/);
  assert.throws(() => routeTeammate(plain, { subagentType: 'other-plugin:agent' }), /No routing policy/);
});

test('teammate settings are validated and keep older digests stable', () => {
  const plain = policyFromOptions(modelOptions);
  assert.equal(policyDigest(policyFromOptions({ ...modelOptions, teammate_model: '', teammate_effort: 'default' })), policyDigest(plain));
  assert.equal(policyDigest(plain), '9cf0118a0a3bb53c25791936dff0b80e8acb522e3ba3c70379339adbda36b4a7');
  assert.notEqual(policyDigest(policyFromOptions({ ...modelOptions, teammate_model: 'vendor/mate-v1' })), policyDigest(plain));
  assert.throws(() => policyFromOptions({ ...modelOptions, teammate_model: 'opus' }), /teammate_model/);
  assert.throws(() => policyFromOptions({ ...modelOptions, teammate_effort: 'turbo' }), /teammate_effort/);
  assert.throws(() => validatePolicy({ ...plain, teammate: { model: 'vendor/x', extra: 1 } }), /teammate/);
});

test('an unadvertised teammate model blocks bootstrap and apply', async t => {
  const { request } = await fixture(t);
  await assert.rejects(request('bootstrap', { session_id: 'fresh', options: { ...modelOptions, teammate_model: 'vendor/missing' } }), /teammate/);
  await assert.rejects(request('apply', { session_id: lead, options: { ...modelOptions, teammate_model: 'vendor/missing' } }), /teammate/);
});

test('launch flags parse from a teammate process command line', () => {
  const args = ['/bin/claude', '--agent-id', 'probe@session-aaaaaaaa', '--agent-name', 'probe', '--team-name', team,
    '--agent-color', 'blue', `--parent-session-id=${lead}`, '--agent-type', 'agent-router:scout', '--model', 'x'];
  assert.deepEqual(parseTeammateArgs(args), { agentId: `probe@${team}`, agentName: 'probe', teamName: team, parentSessionId: lead, agentType: 'agent-router:scout' });
  assert.equal(parseTeammateArgs(['/bin/claude', '--model', 'x']), null);
  assert.equal(parseTeammateArgs(['/bin/claude', '--agent-id', 'probe@x']), null);
});

test('a pane teammate inherits the lead policy and routes its own steps', async t => {
  const { request, identity, root } = await fixture(t, { leadOptions: { ...modelOptions, teammate_effort: 'high' } });
  const changed = { ...modelOptions, scout_model: 'vendor/mate-v1' };
  const snapshot = await request('bootstrap', { session_id: mate, options: changed, teammate: identity }, undefined, async () => assert.fail('must inherit, not discover'));
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.policy.roles.scout.model, modelOptions.scout_model);
  assert.deepEqual(snapshot.self, { role: 'scout', type: 'agent-router:scout', model: modelOptions.scout_model, effort: 'high' });
  assert.equal(snapshot.leadSessionId, lead);
  assert.equal(snapshot.pendingConfiguration, false);
  const again = await request('bootstrap', { session_id: mate, options: changed, teammate: identity });
  assert.equal(again.policy.roles.scout.model, modelOptions.scout_model);
  await assert.rejects(request('apply', { session_id: mate, options: changed }), /lead/);
  const pinned = await readRecord(recordPath(root, 'sessions', mate));
  assert.equal(pinned.teammate.agentId, identity.agentId);
});

test('a pane teammate refuses an identity the team config does not confirm', async t => {
  const { request, identity } = await fixture(t);
  for (const forged of [{ ...identity, parentSessionId: 'cccccccc-1111-4222-8333-444444444444' }, { ...identity, agentId: `ghost@${team}` },
    { ...identity, teamName: 'session-zzzzzzzz' }, { ...identity, agentType: 'agent-router:task' }]) {
    const snapshot = await request('bootstrap', { session_id: `forged-${forged.agentId}-${forged.parentSessionId}-${forged.teamName}-${forged.agentType}`.replace(/[^a-z0-9-]/gi, ''), teammate: forged });
    assert.equal(snapshot.self, undefined);
    assert.equal(snapshot.leadSessionId, undefined);
    assert.equal(typeof snapshot.teammateNotice, 'string');
  }
});

test('a pane teammate whose lead never routed keeps its own session policy', async t => {
  const { request, identity } = await fixture(t, { leadOptions: null });
  const snapshot = await request('bootstrap', { session_id: mate, teammate: identity });
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.leadSessionId, undefined);
  assert.equal(snapshot.self, undefined);
  assert.match(snapshot.teammateNotice, /lead/);
});

test('a pane teammate whose endpoint differs from the lead fails closed', async t => {
  const { request, identity, env } = await fixture(t);
  await assert.rejects(request('bootstrap', { session_id: mate, teammate: identity }, { ...env, ANTHROPIC_BASE_URL: 'https://other.example' }), /endpoint/);
});

test('teammate launches are recorded on the lead and teammate usage joins its stats', async t => {
  const { request, identity, root } = await fixture(t);
  await request('route', { session_id: lead, tool_use_id: 'launch', requestedType: 'Explore', effectiveType: 'agent-router:scout', kind: 'teammate', name: 'probe' });
  await request('result', { session_id: lead, tool_use_id: 'launch', result: { agentId: identity.agentId, model: modelOptions.scout_model, backend: 'tmux' } });
  await request('bootstrap', { session_id: mate, teammate: identity });
  await request('observe', { session_id: mate, agent_id: mate, turn_id: 'mate-turn', usage: { model: modelOptions.scout_model, input_tokens: 11, output_tokens: 3 } });
  const stats = await sessionStats(root, lead);
  assert.equal(stats.routed, 1);
  assert.equal(stats.inputTokens, 11);
  assert.equal(stats.outputTokens, 3);
  const route = (await routingStatus(root, lead)).routes.find(item => item.toolUseId === 'launch');
  assert.equal(route.kind, 'teammate');
  assert.equal(route.backend, 'tmux');
  assert.equal(route.agentId, identity.agentId);
  const agents = (await request('bootstrap', { session_id: lead })).agents;
  assert.equal(agents.find(agent => agent.agentId === identity.agentId).kind, 'teammate');
  assert.equal(agents.find(agent => agent.agentId === identity.agentId).name, 'probe');
});

test('teammate identity is read from the nearest teammate ancestor process', () => {
  const table = {
    100: `90 node /plugin/scripts/bridge.mjs`,
    90: `80 /bin/claude --agent-id probe@${team} --agent-name probe --team-name ${team} --agent-color blue --parent-session-id ${lead} --agent-type agent-router:scout`,
    80: `1 tmux`,
  };
  const run = (command, args) => { const line = table[Number(args[args.length - 1])]; if (!line) throw new Error('gone'); return line; };
  assert.deepEqual(readTeammateIdentity(100, run), { agentId: `probe@${team}`, agentName: 'probe', teamName: team, parentSessionId: lead, agentType: 'agent-router:scout' });
  assert.equal(readTeammateIdentity(80, run), null);
  assert.equal(readTeammateIdentity(100, () => { throw new Error('no ps'); }), null);
});

// A resumed lead keeps its team, named for and recorded under the session it
// started as, while the process (and the teammate's launch flag) moves on to
// the resumed session's id. The team name alone cannot vouch for a lead.
test('a teammate of a resumed lead inherits the policy its launch flag names', async t => {
  const original = 'dddddddd-1111-4222-8333-444444444444';
  const { request, identity } = await fixture(t, { configLead: original });
  await request('route', { session_id: lead, tool_use_id: 'launch', effectiveType: 'agent-router:scout', kind: 'teammate', name: 'probe' });
  await request('result', { session_id: lead, tool_use_id: 'launch', result: { agentId: identity.agentId, backend: 'tmux' } });
  const snapshot = await request('bootstrap', { session_id: mate, teammate: identity }, undefined, async () => assert.fail('must inherit, not discover'));
  assert.equal(snapshot.leadSessionId, lead);
  assert.equal(snapshot.self.model, modelOptions.scout_model);
});

test('a lead id that neither the team config nor the lead records back is refused', async t => {
  const { request, identity } = await fixture(t, { configLead: 'dddddddd-1111-4222-8333-444444444444' });
  const other = 'eeeeeeee-1111-4222-8333-444444444444';
  await request('bootstrap', { session_id: other });
  const snapshot = await request('bootstrap', { session_id: mate, teammate: { ...identity, parentSessionId: other } });
  assert.equal(snapshot.leadSessionId, undefined);
  assert.equal(typeof snapshot.teammateNotice, 'string');
});

test('a resumed lead\'s launch record that lands after the teammate starts is still found', async t => {
  const { request, identity } = await fixture(t, { configLead: 'dddddddd-1111-4222-8333-444444444444' });
  await request('route', { session_id: lead, tool_use_id: 'launch', effectiveType: 'agent-router:scout', kind: 'teammate', name: 'probe' });
  setTimeout(() => request('result', { session_id: lead, tool_use_id: 'launch', result: { agentId: identity.agentId, backend: 'tmux' } }), 20);
  const snapshot = await request('bootstrap', { session_id: mate, teammate: identity });
  assert.equal(snapshot.leadSessionId, lead);
});

test('a subagent record never vouches for a teammate of a resumed lead', async t => {
  const { request, identity } = await fixture(t, { configLead: 'dddddddd-1111-4222-8333-444444444444' });
  await request('route', { session_id: lead, tool_use_id: 'sub', effectiveType: 'agent-router:scout' });
  await request('result', { session_id: lead, tool_use_id: 'sub', result: { agentId: identity.agentId } });
  const snapshot = await request('bootstrap', { session_id: mate, teammate: identity });
  assert.equal(snapshot.leadSessionId, undefined);
});
