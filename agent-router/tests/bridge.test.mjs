import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRequest } from '../lib/bridge.mjs';
import { policyFromOptions } from '../lib/policy.mjs';
import { routeAgent, validatePolicy } from '../lib/routing.js';
import { routingStatus, recordPath, readRecord, writeRecord } from '../lib/state.mjs';
import { modelOptions } from './fixtures.mjs';

const policy = policyFromOptions(modelOptions);
const catalog = async () => Object.values(policy.roles).map(({ model }) => ({ id: model }));

async function fixture(t, options = modelOptions) {
  const root = await mkdtemp(join(tmpdir(), 'agent-router-bridge-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { CLAUDE_PLUGIN_DATA: root, ANTHROPIC_BASE_URL: 'https://gateway.example/ai/claude' };
  const request = (action, fields = {}, environment = env, discover = catalog) =>
    handleRequest({ action, session_id: 'one', options, ...fields }, environment, discover);
  await request('bootstrap');
  return { root, env, request };
}

function route(tool_use_id = 'call-one', effectiveType = 'agent-router:scout') {
  return { tool_use_id, requestedType: 'Explore', requestedModel: 'sonnet', effectiveType };
}

async function storedText(directory) {
  let text = '';
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    text += entry.isDirectory() ? await storedText(path) : await readFile(path, 'utf8');
  }
  return text;
}

test('register options select exact models and completed spawns restore their assignment', async t => {
  const options = { ...modelOptions, scout_model: policy.roles.sonic.model };
  const { request, root } = await fixture(t, options);
  await request('route', route());
  await request('result', { tool_use_id: 'call-one', result: { agentId: 'child', model: options.scout_model } });
  const restored = await request('bootstrap', {}, undefined, async () => { throw new Error('should use pinned session'); });
  assert.equal(restored.policy.roles.scout.model, options.scout_model);
  assert.equal(restored.agents.find(agent => agent.agentId === 'child').effectiveModel, options.scout_model);
  const status = await routingStatus(root);
  assert.equal(status.routes[0].effectiveModel, options.scout_model);
  assert.equal(status.routes[0].resolutionMismatch, false);
});

test('saved and cleared options preserve pinned routing and report pending configuration', async t => {
  const { request, root } = await fixture(t);
  for (const options of [{ ...modelOptions, scout_model: 'provider/changed-model' }, {}, { ...modelOptions, scout_model: '' }]) {
    const snapshot = await request('bootstrap', { options }, undefined, async () => assert.fail('must use pinned catalog'));
    assert.equal(snapshot.pendingConfiguration, true);
    assert.equal(snapshot.policy.roles.scout.model, modelOptions.scout_model);
    await request('route', { ...route(), options });
    await request('result', { options, tool_use_id: 'call-one', result: { agentId: 'child' } });
    await request('observe', { options, agent_id: 'child', turn_id: 'turn-one', usage: { inputTokens: 7 } });
    assert.equal((await routingStatus(root)).routes[0].effectiveModel, modelOptions.scout_model);
  }
  assert.equal((await request('bootstrap')).pendingConfiguration, false);
});

test('gateway and override changes remain guarded for pinned sessions', async t => {
  const { request, env, root } = await fixture(t);
  for (const action of ['bootstrap', 'route']) {
    await assert.rejects(request(action, { ...route(), options: {} }, { ...env, ANTHROPIC_BASE_URL: 'https://other.example' }), /changed/);
    await assert.rejects(request(action, route(), { ...env, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: 'sonnet' }), /conflicts/);
  }
  assert.deepEqual((await routingStatus(root)).routes, []);
});

test('initial incomplete setup denies routing and can become ready in the same session', async t => {
  const { request, root } = await fixture(t);
  await assert.rejects(request('bootstrap', { session_id: 'setup', options: {} }), /scout_model/);
  await assert.rejects(request('route', { ...route(), session_id: 'setup', options: {} }), /not ready/);
  assert.equal(await readRecord(recordPath(root, 'sessions', 'setup')), null);
  const ready = await request('bootstrap', { session_id: 'setup' });
  assert.equal(ready.active, true);
  assert.equal(ready.pendingConfiguration, false);
  await request('route', { ...route(), session_id: 'setup' });
});

test('catalog discovery works before setup without persisting a session', async t => {
  const { env, root } = await fixture(t);
  const result = await handleRequest({ action: 'catalog' }, env, async () => [{ id: 'provider/model', display_name: 'Model' }]);
  assert.deepEqual(result, { endpoint: env.ANTHROPIC_BASE_URL, models: [{ id: 'provider/model', name: 'Model', description: '' }] });
  assert.equal(await readRecord(recordPath(root, 'sessions', 'setup')), null);
  await assert.rejects(handleRequest({ action: 'catalog' }, { ...env, ANTHROPIC_BASE_URL: '' }, async () => assert.fail('must not discover')), /ANTHROPIC_BASE_URL/);
  await assert.rejects(handleRequest({ action: 'catalog' }, env, async () => [{ id: 'sonnet' }]), /exact model IDs/);
});

test('unavailable or incomplete catalogs leave sessions unroutable', async t => {
  const { request, root } = await fixture(t);
  await assert.rejects(request('bootstrap', { session_id: 'missing' }, undefined, async () => []), /catalog/);
  await assert.rejects(request('bootstrap', { session_id: 'offline' }, undefined, async () => { throw new Error('Catalog unavailable'); }), /unavailable/);
  for (const session_id of ['missing', 'offline']) {
    await assert.rejects(request('route', { ...route(), session_id }), /not ready/);
    assert.equal(await readRecord(recordPath(root, 'sessions', session_id)), null);
  }
});

test('gateway URL validation rejects credential-bearing and insecure URLs before discovery', async t => {
  const { request, env } = await fixture(t);
  for (const ANTHROPIC_BASE_URL of ['http://gateway.example', 'https://user:PRIVATE@gateway.example', 'https://gateway.example?token=PRIVATE', 'invalid']) {
    let discovered = false;
    await assert.rejects(request('bootstrap', { session_id: 'invalid' }, { ...env, ANTHROPIC_BASE_URL }, async () => {
      discovered = true;
      return catalog();
    }), error => !error.message.includes('PRIVATE'));
    assert.equal(discovered, false);
  }
});

test('native role aliases route while missing roles, unknown roles and forks fail closed', () => {
  for (const [role, entry] of Object.entries(policy.roles)) {
    for (const subagentType of [`agent-router:${role}`, ...entry.aliases]) {
      assert.deepEqual(routeAgent(policy, { subagentType }), {
        role, type: subagentType === 'Plan' ? 'Plan' : `agent-router:${role}`, model: entry.model,
      });
    }
  }
  for (const input of [{}, { subagentType: 'other:role' }, { subagentType: 'fork' }, { subagentType: 'Explore', fork: true }]) {
    assert.throws(() => routeAgent(policy, input));
  }
  assert.throws(() => policyFromOptions({ ...modelOptions, scout_model: 'sonnet' }), /exact model/);
  assert.throws(() => policyFromOptions({ ...modelOptions, sonic_model: ' model-with-spaces ' }), /exact model/);
  const duplicate = structuredClone(policy);
  duplicate.roles.sonic.aliases.push('Explore');
  assert.throws(() => validatePolicy(duplicate), /Duplicate/);
});

test('Plan retains native dispatch and persisted identity with the task model', async t => {
  const selected = routeAgent(policy, { subagentType: 'Plan', model: 'sonnet' });
  assert.deepEqual(selected, { role: 'task', type: 'Plan', model: modelOptions.task_model });
  const { request, root } = await fixture(t);
  await request('route', { ...route('native-plan', selected.type), requestedType: 'Plan' });
  await request('result', { tool_use_id: 'native-plan', result: { agentId: 'plan-child', model: selected.model } });
  const status = await routingStatus(root);
  assert.equal(status.routes[0].role, 'task');
  assert.equal(status.routes[0].effectiveType, 'Plan');
  assert.equal(status.routes[0].effectiveModel, modelOptions.task_model);
  assert.equal(status.routes[0].resolutionMismatch, false);
  const restored = await request('bootstrap');
  assert.equal(restored.agents.find(agent => agent.agentId === 'plan-child').effectiveModel, modelOptions.task_model);
});

test('every role requires explicit nonempty model configuration', () => {
  assert.throws(() => policyFromOptions(), /scout_model/);
  for (const key of Object.keys(modelOptions)) {
    const incomplete = { ...modelOptions };
    delete incomplete[key];
    for (const options of [incomplete, { ...modelOptions, [key]: '' }, { ...modelOptions, [key]: '   ' }]) {
      assert.throws(() => policyFromOptions(options), error => error.message.includes(key));
    }
  }
});

test('model IDs remain opaque, including local paths and Unicode names', () => {
  const model = '/models/模型 sample.gguf';
  const configured = policyFromOptions({ ...modelOptions, scout_model: model });
  assert.equal(routeAgent(configured, { subagentType: 'Explore' }).model, model);
  assert.throws(() => policyFromOptions({ ...modelOptions, scout_model: 'vendor/model\ninjected' }));
});

test('denied results fail while results without an agent identity stay unresolved', async t => {
  const { request, root } = await fixture(t);
  for (const [tool_use_id, result] of [['denied', { deny: 'PRIVATE_REASON', agentId: 'not-started' }], ['empty', { model: policy.roles.scout.model }]]) {
    await request('route', route(tool_use_id));
    await request('result', { tool_use_id, result });
  }
  assert.deepEqual((await routingStatus(root)).routes.map(row => row.state), ['failed', 'unresolved']);
  assert.deepEqual((await request('bootstrap')).agents, []);
  assert.equal((await storedText(root)).includes('PRIVATE_REASON'), false);
  await assert.rejects(request('result', { tool_use_id: 'unknown', result: {} }));
  assert.equal(await readRecord(recordPath(root, 'routes', 'one', 'unknown')), null);
});

test('an empty denial reason still records a denied spawn', async t => {
  const { request, root } = await fixture(t);
  await request('route', route());
  await request('result', { tool_use_id: 'call-one', result: { deny: '' } });
  assert.equal((await routingStatus(root)).routes[0].state, 'failed');
  assert.deepEqual((await request('bootstrap')).agents, []);
});

test('state failures propagate rather than claiming a route or result was saved', async t => {
  const { request, root } = await fixture(t);
  const routePath = recordPath(root, 'routes', 'one', 'blocked');
  await mkdir(routePath, { recursive: true });
  await assert.rejects(request('route', route('blocked')));
  await request('route', route());
  const assignmentPath = recordPath(root, 'agents', 'one', 'child');
  await mkdir(assignmentPath, { recursive: true });
  await assert.rejects(request('result', { tool_use_id: 'call-one', result: { agentId: 'child', model: policy.roles.scout.model } }));
});

test('completed turns aggregate idempotently by agent, including observations arriving before results', async t => {
  const { request, root, env } = await fixture(t);
  env.ANTHROPIC_AUTH_TOKEN = 'PRIVATE_TOKEN';
  await request('route', { ...route('task', 'agent-router:task'), prompt: 'PRIVATE_PROMPT' });
  await request('route', route('scout'));
  const completion = {
    agent_id: 'task-child', turn_id: 'turn-one', reason: 'answer', answer: 'PRIVATE_ANSWER',
    usage: { model: 'provider/response-model', input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 2, cache_read_input_tokens: 5, prompt: 'PRIVATE_USAGE' },
  };
  await Promise.all([request('observe', completion), request('observe', completion)]);
  await request('observe', { ...completion, turn_id: 'turn-two', usage: { model: 'provider/second-model', input_tokens: 4, output_tokens: 6, cache_creation_input_tokens: -1 } });
  const mismatch = await request('result', { tool_use_id: 'task', result: { agentId: 'task-child', model: 'different/resolved-model', content: 'PRIVATE_RESULT' } });
  assert.match(mismatch.systemMessage, /mismatch/);
  await request('result', { tool_use_id: 'scout', result: { agentId: 'scout-child', model: policy.roles.scout.model } });
  let status = await routingStatus(root);
  const task = status.routes.find(row => row.role === 'task');
  assert.deepEqual(task.responseModels, ['provider/response-model', 'provider/second-model']);
  assert.deepEqual(task.usage, { input_tokens: 11, output_tokens: 9, cache_creation_input_tokens: 2, cache_read_input_tokens: 5 });
  assert.equal(task.completedTurns, 2);
  assert.equal(task.state, 'stopped');
  assert.equal(task.resolutionMismatch, true);
  assert.equal(task.upstreamVerified, false);
  assert.equal(task.observationScope, 'last response per completed turn');
  assert.equal(status.routes.find(row => row.role === 'scout').usage, undefined);
  assert.equal((await storedText(root)).includes('PRIVATE_'), false);

  await request('route', route('resumed', 'agent-router:task'));
  const resumedPath = recordPath(root, 'routes', 'one', 'resumed');
  const resumed = await readRecord(resumedPath);
  await writeRecord(resumedPath, { ...resumed, createdAt: '2099-01-01T00:00:00.000Z' });
  await request('result', { tool_use_id: 'resumed', result: { agentId: 'task-child', model: policy.roles.task.model } });
  status = await routingStatus(root);
  assert.equal(status.routes.reduce((sum, row) => sum + (row.usage?.input_tokens || 0), 0), 11);
  assert.equal(status.routes.find(row => row.toolUseId === 'resumed').state, 'started', 'earlier completions must not stop a new spawn');
});

test('observations without a turn identity cannot inflate completed-turn usage', async t => {
  const { request, root } = await fixture(t);
  await request('route', route());
  await request('result', { tool_use_id: 'call-one', result: { agentId: 'child', model: policy.roles.scout.model } });
  await writeRecord(recordPath(root, 'observations', 'one', 'unscoped-record'), {
    sessionId: 'one', agentId: 'child', responseModels: ['unknown/model'], usage: { input_tokens: 9999 },
  });
  await request('observe', { agent_id: 'child', turn_id: 'turn', reason: 'answer',
    usage: { model: policy.roles.scout.model, input_tokens: 7 } });
  const status = await routingStatus(root);
  assert.equal(status.routes[0].completedTurns, 1);
  assert.equal(status.routes[0].usage.input_tokens, 7);
});

test('sessions without an explicit endpoint stay inactive and never query a gateway', async t => {
  const { request, env, root } = await fixture(t);
  for (const [session_id, ANTHROPIC_BASE_URL] of [['unset', undefined], ['empty', '']]) {
    const environment = { ...env, ANTHROPIC_BASE_URL };
    const snapshot = await request('bootstrap', { session_id, options: {} }, environment, async () => assert.fail('must not discover'));
    assert.equal(snapshot.active, false);
    assert.equal(snapshot.gateway, null);
    assert.equal(snapshot.policy, null);
    assert.equal(snapshot.digest, null);
    assert.equal(snapshot.pendingConfiguration, false);
    assert.equal((await request('bootstrap', { session_id, options: {} }, environment)).active, false);
    await assert.rejects(request('route', { ...route(), session_id }, environment));
    assert.deepEqual((await routingStatus(root, session_id)).routes, []);
  }
});

test('explicit official and loopback endpoints participate in configured routing', async t => {
  const { request, env } = await fixture(t);
  for (const ANTHROPIC_BASE_URL of ['https://api.anthropic.com', 'http://127.0.0.1:8080']) {
    const environment = { ...env, ANTHROPIC_BASE_URL };
    const session_id = ANTHROPIC_BASE_URL;
    const snapshot = await request('bootstrap', { session_id }, environment);
    assert.equal(snapshot.active, true);
    await request('route', { ...route(), session_id }, environment);
    const restored = await request('bootstrap', { session_id }, environment);
    assert.equal(restored.policy.roles.scout.model, modelOptions.scout_model);
  }
});

test('unknown actions are rejected instead of silently succeeding', async t => {
  const { request } = await fixture(t);
  await assert.rejects(request('unrecognized'), /Unknown/);
});
