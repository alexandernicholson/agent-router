import { test, expect, mock, tier } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { On, AgentSpawnInput } from 'claude-code';

tier('user');

const policy = { version: 1, roles: {
  scout: { model: 'vendor/search-v1', aliases: ['scout', 'Explore'] },
  reviewer: { model: 'vendor/review-v1', aliases: ['reviewer'] },
  'security-reviewer': { model: 'vendor/security-v1', aliases: ['security-reviewer'] },
  task: { model: 'vendor/task-v1', aliases: ['task', 'general-purpose', 'Plan'] },
  sonic: { model: 'vendor/fast-v1', aliases: ['sonic'] },
} };

function agentInput(input: Partial<AgentSpawnInput>): AgentSpawnInput {
  return { tool_use_id: `call-${input.subagentType}`, description: 'Routing probe', prompt: 'Probe',
    subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'sonnet', background: true, fork: input.subagentType === 'fork', ...input };
}

async function start($: Engine, on: On, failBridge = false, agents: Array<{ agentId: string; role: string; effectiveModel: string }> = [], calls: Record<string, unknown>[] = []) {
  mock.store(on);
  mock.env(on, {});
  on('command.register', ($, e) => ({ value: { command: e.name } }));
  on('session.id', () => ({ value: 'session' }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.log', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('process.run', ($, e) => {
    const input = JSON.parse(e.init?.stdin || '{}');
    calls.push(input);
    return { value: {
      exitCode: failBridge ? 1 : 0, stderr: failBridge ? 'catalog unavailable' : '',
      stdout: JSON.stringify(input.action === 'bootstrap'
        ? { active: true, policy, sessionId: 'session', gateway: 'https://gateway.example', digest: 'pinned', agents } : {}),
    } };
  });
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
}

test('built-in Explore cannot override its assigned model with Sonnet', async ($, on) => {
  on('agent.spawn', ($, e) => {
    if (e.subagentType !== 'agent-router:scout' || e.prompt !== 'Find the parser') return { deny: 'wrong agent or task' };
    return { model: e.model!, agentId: 'scout-1' };
  });
  await start($, on);
  const result = await $.agent.spawn(agentInput({ subagentType: 'Explore', model: 'sonnet', prompt: 'Find the parser' }));
  expect(result.deny).toBe(undefined);
  expect(result.model).toBe(policy.roles.scout.model);
});

test('concurrent distinct roles keep different model assignments', async ($, on) => {
  on('agent.spawn', ($, e) => ({ model: e.model!, agentId: e.subagentType }));
  await start($, on);
  const [scout, plan] = await Promise.all([
    $.agent.spawn(agentInput({ subagentType: 'Explore', prompt: 'Find code', model: 'opus' })),
    $.agent.spawn(agentInput({ subagentType: 'Plan', prompt: 'Design change', model: 'sonnet' })),
  ]);
  expect(scout.deny).toBe(undefined);
  expect(scout.model).toBe(policy.roles.scout.model);
  expect(plan.deny).toBe(undefined);
  expect(plan.model).toBe(policy.roles.task.model);
});

test('Plan keeps its core definition while using the configured task model', async ($, on) => {
  on('agent.spawn', ($, e) => {
    if (e.subagentType !== 'Plan' || e.provider.plugin !== 'engine' || e.provider.tier !== 'core') {
      return { deny: 'Plan must resolve through its native read-only definition' };
    }
    return { model: e.model!, agentId: 'native-plan' };
  });
  await start($, on);
  const result = await $.agent.spawn(agentInput({ subagentType: 'Plan', model: 'sonnet' }));
  expect(result.deny).toBe(undefined);
  expect(result.agentId).toBe('native-plan');
  expect(result.model).toBe(policy.roles.task.model);
});

test('unavailable policy prevents downstream agent execution', async ($, on) => {
  let started = false;
  on('agent.spawn', () => { started = true; return { model: 'sonnet' }; });
  await start($, on, true);
  const result = await $.agent.spawn(agentInput({ subagentType: 'Explore', prompt: 'Find code' }));
  expect(typeof result.deny).toBe('string');
  expect(started).toBe(false);
});

test('fork dispatch cannot evade the role model assignment', async ($, on) => {
  let started = false;
  on('agent.spawn', () => { started = true; return { model: 'sonnet' }; });
  await start($, on);
  const result = await $.agent.spawn(agentInput({ subagentType: 'fork', prompt: 'Inherit everything' }));
  expect(typeof result.deny).toBe('string');
  expect(started).toBe(false);
});

test('unmapped agents are refused rather than inheriting the lead model', async ($, on) => {
  let started = false;
  on('agent.spawn', () => { started = true; return { model: 'sonnet' }; });
  await start($, on);
  const result = await $.agent.spawn(agentInput({ subagentType: 'another-plugin:agent', prompt: 'Work' }));
  expect(typeof result.deny).toBe('string');
  expect(started).toBe(false);
});

test('resumed teammates retain pinned routing without changing the lead model or stream', async ($, on) => {
  on('turn.step', async function* ($, e) {
    yield { kind: 'text' as const, index: 0, text: e.model };
    return { turnId: e.turnId, index: e.index, answer: e.model, toolUses: [], stopReason: 'end_turn' as const, usage: null };
  });
  await start($, on, false, [{ agentId: 'teammate-1', role: 'scout', effectiveModel: policy.roles.scout.model }]);
  const child = $.turn.step({ turnId: 'turn-child', index: 0, messageCount: 1, agentId: 'teammate-1', model: 'sonnet' });
  const childChunks = [];
  for await (const chunk of child) childChunks.push(chunk);
  expect(childChunks).toEqual([{ kind: 'text', index: 0, text: policy.roles.scout.model }]);
  const lead = $.turn.step({ turnId: 'turn-lead', index: 0, messageCount: 1, model: 'vendor/lead-v1' });
  const leadChunks = [];
  for await (const chunk of lead) leadChunks.push(chunk);
  expect(leadChunks).toEqual([{ kind: 'text', index: 0, text: 'vendor/lead-v1' }]);
});

test('remote tool dispatch cannot escape the local plugin and profile', async ($, on) => {
  let started = false;
  on('tool.call', () => { started = true; return { deny: 'unexpected remote launch' }; });
  await start($, on);
  const result = await $.tool.call({ tool: 'Agent', tool_use_id: 'remote-call', prompt: 'Work',
    description: 'Remote probe', subagent_type: 'agent-router:scout', isolation: 'remote' });
  expect(typeof result.deny).toBe('string');
  expect(started).toBe(false);
});

test('completed-turn observations never include the agent answer', async ($, on) => {
  const calls: Record<string, unknown>[] = [];
  on('agent.spawn', ($, e) => ({ model: e.model!, agentId: 'observed-child' }));
  on('turn.complete', ($, e) => ({ text: e.answer }));
  await start($, on, false, [], calls);
  await $.agent.spawn(agentInput({ subagentType: 'scout' }));
  await $.turn.complete({
    answer: 'SENSITIVE_ANSWER_NOT_FOR_STORAGE', durationMs: 10, isAborted: false,
    reason: 'answer', turnId: 'observed-turn', agentId: 'observed-child',
    usage: { model: policy.roles.scout.model, input_tokens: 5, output_tokens: 2,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
  const observation = calls.find(call => call.action === 'observe');
  expect(observation === undefined).toBe(false);
  expect(JSON.stringify(observation).includes('SENSITIVE_ANSWER_NOT_FOR_STORAGE')).toBe(false);
});
