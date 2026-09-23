import { test, expect, mock, tier } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { On, AgentInfo, RenderInput, RenderNode } from 'claude-code';

tier('user');

const roles = {
  scout: { model: 'vendor/search-v1', aliases: ['scout', 'Explore'], effort: 'low' },
  reviewer: { model: 'vendor/review-v1', aliases: ['reviewer'] },
  'security-reviewer': { model: 'vendor/security-v1', aliases: ['security-reviewer'] },
  task: { model: 'vendor/task-v1', aliases: ['task', 'general-purpose', 'Plan'] },
  sonic: { model: 'vendor/fast-v1', aliases: ['sonic'] },
};
const policy = { version: 1, roles };
const withMate = { ...policy, teammate: { model: 'vendor/mate-v1', effort: 'high' } };

type World = { calls: Record<string, any>[]; env: Array<{ name: string; value?: string }>; roster: AgentInfo[]; logs: string[]; applied?: Record<string, unknown>; redraws: number };

async function lead($: Engine, on: On, snapshot: Record<string, unknown> = { active: true, policy }, world: World = { calls: [], env: [], roster: [], logs: [], redraws: 0 }): Promise<World> {
  mock.store(on);
  mock.clock(on);
  on('env.get', ($, e) => ({ value: e.name === 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' ? '1' : world.env.filter(item => item.name === e.name).at(-1)?.value }));
  on('env.set', ($, e) => { world.env.push({ name: e.name, value: e.value }); return { value: undefined }; });
  on('command.register', ($, e) => ({ value: { command: e.name } }));
  on('session.id', () => ({ value: 'lead-session' }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.log', ($, e) => { world.logs.push(e.text); return { value: undefined }; });
  on('ui.invalidate', () => { world.redraws++; return { value: undefined }; });
  on('agent.list', () => ({ value: world.roster }));
  on('agent.spawn', ($, e) => ({ model: e.model!, agentId: `sub-${e.tool_use_id}` }));
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }));
  on('turn.complete', ($, e) => ({ text: e.answer }));
  on('process.run', ($, e) => {
    const input = JSON.parse(e.init?.stdin || '{}');
    world.calls.push(input);
    return { value: { exitCode: 0, stderr: '', stdout: JSON.stringify(input.action === 'bootstrap'
      ? { sessionId: 'lead-session', gateway: 'https://gateway.example', digest: 'pinned', agents: [], ...snapshot }
      : input.action === 'apply' ? { active: true, policy: world.applied } : {}) } };
  });
  // Stands in for the Agent tool: reports a teammate launch for named calls.
  on('tool.call', ($, e) => {
    const input = e as Record<string, any>;
    const model = world.env.filter(item => item.name === 'CLAUDE_CODE_SUBAGENT_MODEL').at(-1)?.value;
    world.calls.push({ action: 'launch', input, model });
    const backend = world.applied?.backend === 'tmux' ? 'tmux' : 'in-process';
    return { result: { status: 'teammate_spawned', teammate_id: `${input.name}@session-lead`, agent_id: `${input.name}@session-lead`,
      agent_type: input.subagent_type ?? 'general-purpose', model: model ?? 'claude-opus-5-5', name: input.name,
      tmux_pane_id: backend === 'in-process' ? 'in-process' : '%9', is_splitpane: backend !== 'in-process', team_name: 'session-lead' } } as any;
  });
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  return world;
}

async function steps($: Engine, input: { agentId?: string; model: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }) {
  const chunks = [];
  for await (const chunk of $.turn.step({ turnId: 'turn', index: 0, messageCount: 1, ...input })) chunks.push(chunk);
  return chunks;
}

function echo(on: On) {
  on('turn.step', async function* ($, e) {
    yield { kind: 'text' as const, index: 0, text: `${e.model}|${e.effort ?? 'none'}` };
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null };
  });
}

const call = (input: Record<string, unknown>) => ({ tool: 'Agent', tool_use_id: `launch-${input.name}`, description: 'Team', prompt: 'Work', ...input }) as any;

test('a named Agent call launches the teammate on its role model with the exact model default', async ($, on) => {
  const world = await lead($, on);
  const result = await $.tool.call(call({ name: 'probe', subagent_type: 'Explore', model: 'opus' }));
  expect(result.deny).toBe(undefined);
  const launch = world.calls.find(item => item.action === 'launch')!;
  expect(launch.input.subagent_type).toBe('agent-router:scout');
  expect('model' in launch.input).toBe(false);
  expect(launch.model).toBe(roles.scout.model);
  expect(world.env.at(-1)).toEqual({ name: 'CLAUDE_CODE_SUBAGENT_MODEL', value: undefined });
  const route = world.calls.find(item => item.action === 'route')!;
  expect(route.kind).toBe('teammate');
  expect(route.name).toBe('probe');
  expect(route.effectiveType).toBe('agent-router:scout');
  const recorded = world.calls.find(item => item.action === 'result')!;
  expect(recorded.result).toEqual({ agentId: 'probe@session-lead', model: roles.scout.model, backend: 'in-process' });
});

test('an untyped teammate uses the task role and the teammate override wins', async ($, on) => {
  const world = await lead($, on, { active: true, policy: withMate });
  await $.tool.call(call({ name: 'helper' }));
  const launch = world.calls.find(item => item.action === 'launch')!;
  expect(launch.input.subagent_type).toBe('agent-router:task');
  expect(launch.model).toBe('vendor/mate-v1');
});

// A named fork never becomes a teammate; agent.spawn refuses it as a subagent.
test('unmapped and Plan teammates are refused before launch', async ($, on) => {
  const world = await lead($, on);
  for (const input of [{ name: 'x', subagent_type: 'other-plugin:agent' }, { name: 'y', subagent_type: 'Plan' }]) {
    const result = await $.tool.call(call(input));
    expect(typeof result.deny).toBe('string');
  }
  expect(world.calls.some(item => item.action === 'launch')).toBe(false);
  expect(world.env.length).toBe(0);
});

test('named calls that run as subagents keep the subagent path', async ($, on) => {
  const world = await lead($, on);
  await $.tool.call(call({ name: 'isolated', subagent_type: 'Explore', isolation: 'worktree' }));
  await $.tool.call(call({ name: 'elsewhere', subagent_type: 'Explore', cwd: '/other' }));
  await $.tool.call(call({ subagent_type: 'Explore' }));
  expect(world.env.length).toBe(0);
  expect(world.calls.filter(item => item.action === 'launch').every(item => item.input.subagent_type === 'Explore')).toBe(true);
});

test('in-process teammate steps use the teammate model and effort while the lead keeps its own', async ($, on) => {
  echo(on);
  const world = await lead($, on, { active: true, policy: withMate });
  await $.tool.call(call({ name: 'probe', subagent_type: 'Explore' }));
  world.roster = [{ id: 'aprobe-1', description: 'Work', type: 'teammate', status: 'running', name: 'probe' }];
  expect(await steps($, { agentId: 'aprobe-1', model: 'claude-opus-5-5', effort: 'low' }))
    .toEqual([{ kind: 'text', index: 0, text: 'vendor/mate-v1|high' }]);
  expect(await steps($, { model: 'claude-opus-5-5', effort: 'low' }))
    .toEqual([{ kind: 'text', index: 0, text: 'claude-opus-5-5|low' }]);
});

test('an unknown in-process teammate is left to the engine', async ($, on) => {
  echo(on);
  const world = await lead($, on);
  world.roster = [{ id: 'amystery-1', description: 'Work', type: 'teammate', status: 'running', name: 'mystery' }];
  expect(await steps($, { agentId: 'amystery-1', model: 'claude-opus-5-5', effort: 'medium' }))
    .toEqual([{ kind: 'text', index: 0, text: 'claude-opus-5-5|medium' }]);
});

test('teammates launched before an apply keep their route and later ones use the new policy', async ($, on) => {
  echo(on);
  const world = await lead($, on, { active: true, policy, pendingConfiguration: true });
  await $.tool.call(call({ name: 'early', subagent_type: 'reviewer' }));
  world.applied = { ...policy, roles: { ...roles, reviewer: { ...roles.reviewer, model: 'vendor/review-v2' } } };
  await $.command.run({ command: 'agent-models-apply', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } });
  await $.tool.call(call({ name: 'late', subagent_type: 'reviewer' }));
  world.roster = [
    { id: 'aearly-1', description: 'Work', type: 'teammate', status: 'running', name: 'early' },
    { id: 'alate-1', description: 'Work', type: 'teammate', status: 'running', name: 'late' },
  ];
  expect(await steps($, { agentId: 'aearly-1', model: 'x' })).toEqual([{ kind: 'text', index: 0, text: 'vendor/review-v1|none' }]);
  expect(await steps($, { agentId: 'alate-1', model: 'x' })).toEqual([{ kind: 'text', index: 0, text: 'vendor/review-v2|none' }]);
});

test('a pane teammate session pins its own requests to the route it inherited', async ($, on) => {
  echo(on);
  const self = { role: 'scout', type: 'agent-router:scout', model: 'vendor/mate-v1', effort: 'high' };
  const world = await lead($, on, { active: true, policy: withMate, leadSessionId: 'lead-of-mate', self });
  expect(await steps($, { model: 'claude-opus-5-5', effort: 'low' }))
    .toEqual([{ kind: 'text', index: 0, text: 'vendor/mate-v1|high' }]);
  expect(await steps($, { model: 'claude-opus-5-5' }))
    .toEqual([{ kind: 'text', index: 0, text: 'vendor/mate-v1|none' }]);
  expect(world.logs.some(line => line.includes('vendor/mate-v1'))).toBe(false);
});

test('a teammate whose lead is not routing gets a notice and keeps its own routing', async ($, on) => {
  echo(on);
  const world = await lead($, on, { active: true, policy, teammateNotice: 'Agent Router is not routing in this teammate\'s lead session.' });
  expect(world.logs.some(line => line.includes('lead session'))).toBe(true);
  expect(await steps($, { model: 'claude-opus-5-5', effort: 'low' }))
    .toEqual([{ kind: 'text', index: 0, text: 'claude-opus-5-5|low' }]);
});

test('a pane teammate records its own completed turns under its teammate id', async ($, on) => {
  const self = { role: 'task', type: 'agent-router:task', model: 'vendor/task-v1' };
  const world = await lead($, on, { active: true, policy, leadSessionId: 'lead-of-mate', self, teammate: { agentId: 'worker@session-lead' } });
  await $.turn.complete({ answer: 'PRIVATE', durationMs: 5, isAborted: false, reason: 'answer', turnId: 'mate-turn',
    usage: { model: 'vendor/task-v1', input_tokens: 4, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
  const observed = world.calls.find(item => item.action === 'observe');
  expect(observed?.agent_id).toBe('worker@session-lead');
  expect(observed?.turn_id).toBe('mate-turn');
  expect(JSON.stringify(observed).includes('PRIVATE')).toBe(false);
});

test('an ordinary lead never records its own main-loop turns', async ($, on) => {
  const world = await lead($, on);
  await $.turn.complete({ answer: 'x', durationMs: 5, isAborted: false, reason: 'answer', turnId: 'lead-turn',
    usage: { model: 'claude-opus-5-5', input_tokens: 4, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
  expect(world.calls.some(item => item.action === 'observe')).toBe(false);
});

function band(agentId?: string): RenderInput<'AbovePrompt', 'terminal'> {
  return { component: 'AbovePrompt', surface: 'terminal', requestId: 'band',
    props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 160, scroll: { offset: 0, bodyRows: 5 }, view: agentId ? { agentId } : {} } };
}

function text(node: RenderNode): string {
  if (typeof node === 'string') return node;
  return 'children' in node && Array.isArray(node.children) ? node.children.map(text).join(' ') : '';
}

const spawnInput = (subagentType: string) => ({ tool_use_id: `call-${subagentType}`, description: 'Look around', prompt: 'Probe',
  subagentType, provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'claude-opus-5-5', background: true, fork: false });

function badge(node: RenderNode): string | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  const props = ('props' in node ? node.props : {}) as { key?: string; label?: string };
  if ('type' in node && node.type === 'Button' && props.key === 'router-view') return props.label;
  if (!('children' in node) || !Array.isArray(node.children)) return undefined;
  for (const child of node.children) { const found = badge(child); if (found !== undefined) return found; }
  return undefined;
}

test('viewing an in-process teammate puts its model and effort in the router button', async ($, on) => {
  echo(on);
  const world = await lead($, on, { active: true, policy: withMate });
  await $.tool.call(call({ name: 'probe', subagent_type: 'Explore' }));
  world.roster = [{ id: 'aprobe-1', description: 'Work', type: 'teammate', status: 'running', name: 'probe' }];
  const before = world.redraws;
  await steps($, { agentId: 'aprobe-1', model: 'claude-opus-5-5', effort: 'low' });
  expect(world.redraws > before).toBe(true);
  expect(badge(await $.ui.render(band('aprobe-1')))).toBe('⇄ · vendor/mate-v1 · high');
  expect(badge(await $.ui.render(band()))).toBe('⇄');
  const settled = world.redraws;
  await steps($, { agentId: 'aprobe-1', model: 'claude-opus-5-5', effort: 'low' });
  expect(world.redraws).toBe(settled);
});

test('a viewed subagent shows its role route before its first request', async ($, on) => {
  const world = await lead($, on);
  const spawned = await $.agent.spawn(spawnInput('Explore'));
  world.roster = [{ id: spawned.agentId!, description: 'Look around', type: 'agent-router:scout', status: 'running' }];
  expect(badge(await $.ui.render(band(spawned.agentId)))).toBe(`⇄ · ${roles.scout.model} · low`);
});

test('efforts use short names and a viewed agent Agent Router does not route shows what is sent', async ($, on) => {
  echo(on);
  const world = await lead($, on);
  world.roster = [{ id: 'other-1', description: 'Other work', type: 'other-plugin:agent', status: 'running' }];
  await steps($, { agentId: 'other-1', model: 'claude-opus-5-5', effort: 'medium' });
  expect(badge(await $.ui.render(band('other-1')))).toBe('⇄ · claude-opus-5-5 · med');
});

test('a model that takes no effort setting is shown without one', async ($, on) => {
  echo(on);
  const world = await lead($, on);
  const spawned = await $.agent.spawn(spawnInput('reviewer'));
  world.roster = [{ id: spawned.agentId!, description: 'Review', type: 'agent-router:reviewer', status: 'running' }];
  await steps($, { agentId: spawned.agentId, model: 'sonnet' });
  expect(badge(await $.ui.render(band(spawned.agentId)))).toBe(`⇄ · ${roles.reviewer.model}`);
});

test('a pane teammate session always shows its own model and effort', async ($, on) => {
  echo(on);
  const self = { role: 'scout', type: 'agent-router:scout', model: 'vendor/mate-v1', effort: 'high' };
  await lead($, on, { active: true, policy: withMate, leadSessionId: 'lead-of-mate', self, teammate: { agentId: 'worker@session-lead', name: 'worker' } });
  expect(badge(await $.ui.render(band()))).toBe('⇄ · vendor/mate-v1 · high');
  await steps($, { model: 'claude-opus-5-5', effort: 'low' });
  expect(badge(await $.ui.render(band()))).toBe('⇄ · vendor/mate-v1 · high');
});

test('pending settings keep their mark beside the viewed agent', async ($, on) => {
  const world = await lead($, on, { active: true, policy, pendingConfiguration: true });
  const spawned = await $.agent.spawn(spawnInput('Explore'));
  world.roster = [{ id: spawned.agentId!, description: 'Look around', type: 'agent-router:scout', status: 'running' }];
  expect(badge(await $.ui.render(band(spawned.agentId)))).toBe(`⇄* · ${roles.scout.model} · low`);
});
