import { test, expect, mock, tier } from 'claude-code/testing';
import type { Engine, MockClock } from 'claude-code/testing';
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

type World = { calls: Record<string, any>[]; env: Array<{ name: string; value?: string }>; roster: AgentInfo[]; logs: string[]; applied?: Record<string, unknown>; redraws: number; backend?: 'tmux'; clock?: MockClock;
  spawnTeammates?: boolean; starting?: Promise<void>; started?: Promise<unknown>; lists?: number;
  fail?: Record<string, string>; replies?: Record<string, unknown>; refuse?: { restore?: boolean; teams?: boolean; id?: boolean };
  launch?: (input: Record<string, any>) => unknown; spawned?: (e: Record<string, any>) => unknown };

const fresh = (extra: Partial<World> = {}): World => ({ calls: [], env: [], roster: [], logs: [], redraws: 0, ...extra });

async function lead($: Engine, on: On, snapshot: Record<string, unknown> = { active: true, policy }, world: World = fresh()): Promise<World> {
  const engine = $;
  mock.store(on);
  world.clock = mock.clock(on);
  on('session.end', ($, e) => ({ sessionId: e.sessionId }));
  on('env.get', ($, e) => e.name === 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' && world.refuse?.teams ? { deny: 'Environment unavailable' }
    : { value: e.name === 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' ? '1' : world.env.filter(item => item.name === e.name).at(-1)?.value });
  on('env.set', ($, e) => {
    if (world.refuse?.restore && e.name === 'CLAUDE_CODE_SUBAGENT_MODEL' && e.value === undefined) return { deny: 'Environment is read-only' };
    world.env.push({ name: e.name, value: e.value });
    return { value: undefined };
  });
  on('command.register', ($, e) => ({ value: { command: e.name } }));
  on('session.id', () => world.refuse?.id ? { deny: 'No session yet' } : { value: 'lead-session' });
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.log', ($, e) => { world.logs.push(e.text); return { value: undefined }; });
  on('ui.invalidate', () => { world.redraws++; return { value: undefined }; });
  on('agent.list', () => { world.lists = (world.lists ?? 0) + 1; return { value: world.roster }; });
  on('agent.spawn', ($, e) => (world.spawned?.(e) ?? { model: e.model!, agentId: `sub-${e.tool_use_id}` }) as any);
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }));
  on('turn.complete', ($, e) => ({ text: e.answer }));
  on('process.run', async ($, e) => {
    const input = JSON.parse(e.init?.stdin || '{}');
    world.calls.push(input);
    if (input.action === 'bootstrap' && world.starting) await world.starting;
    const failed = world.fail?.[input.action];
    if (failed !== undefined) return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 1, stderr: failed, stdout: '' } };
    if (world.replies?.[input.action]) return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 0, stderr: '', stdout: JSON.stringify(world.replies[input.action]) } };
    return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 0, stderr: '', stdout: JSON.stringify(input.action === 'bootstrap'
      ? { sessionId: 'lead-session', gateway: 'https://gateway.example', digest: 'pinned', agents: [], ...snapshot }
      : input.action === 'apply' ? { active: true, policy: world.applied } : {}) } };
  });
  // Stands in for the Agent tool: reports a teammate launch for named calls.
  on('tool.call', async ($, e) => {
    const input = e as Record<string, any>;
    if (input.tool !== 'Agent') return { result: `ran ${input.tool}` } as any;
    if (world.launch) return world.launch(input) as any;
    const model = world.env.filter(item => item.name === 'CLAUDE_CODE_SUBAGENT_MODEL').at(-1)?.value;
    const spawned = world.spawnTeammates ? await engine.agent.spawn({ tool_use_id: input.tool_use_id, description: 'Team', prompt: 'Work',
      subagentType: input.subagent_type ?? 'teammate', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5',
      background: true, fork: false, isTeammate: true, name: input.name }) : undefined;
    world.calls.push({ action: 'launch', input, model, spawned: spawned?.model });
    const backend = world.backend ?? 'in-process';
    return { result: { status: 'teammate_spawned', teammate_id: `${input.name}@session-lead`, agent_id: `${input.name}@session-lead`,
      agent_type: input.subagent_type ?? 'general-purpose', model: model ?? 'claude-opus-5-5', name: input.name,
      tmux_pane_id: backend === 'in-process' ? 'in-process' : '%9', is_splitpane: backend !== 'in-process', team_name: 'session-lead' } } as any;
  });
  world.started = $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  if (!world.starting) await world.started;
  return world;
}

async function steps($: Engine, input: { agentId?: string; model: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number }) {
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
  await steps($, { agentId: 'other-1', model: 'claude-opus-5-5', effort: 32000 });
  expect(badge(await $.ui.render(band('other-1')))).toBe('⇄ · claude-opus-5-5 · 32000');
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
  const world = await lead($, on, { active: true, policy: withMate, leadSessionId: 'lead-of-mate', self, teammate: { agentId: 'worker@session-lead', name: 'worker' } });
  expect(badge(await $.ui.render(band()))).toBe('⇄ · vendor/mate-v1 · high');
  await steps($, { model: 'claude-opus-5-5', effort: 'low' });
  expect(badge(await $.ui.render(band()))).toBe('⇄ · vendor/mate-v1 · high');
  const settled = world.redraws;
  await steps($, { model: 'claude-opus-5-5', effort: 'low' });
  expect(world.redraws).toBe(settled);
});

test('pending settings keep their mark beside the viewed agent', async ($, on) => {
  const world = await lead($, on, { active: true, policy, pendingConfiguration: true });
  const spawned = await $.agent.spawn(spawnInput('Explore'));
  world.roster = [{ id: spawned.agentId!, description: 'Look around', type: 'agent-router:scout', status: 'running' }];
  expect(badge(await $.ui.render(band(spawned.agentId)))).toBe(`⇄* · ${roles.scout.model} · low`);
});

const statsReads = (world: World) => world.calls.filter(item => item.action === 'stats').length;

// A split-pane teammate records its turns from its own process, so nothing in
// the lead signals them; the lead polls its stats while such a teammate exists.
test('a lead with a split-pane teammate keeps its usage current', async ($, on) => {
  const world = await lead($, on);
  const idle = statsReads(world);
  await world.clock!.advance(10_000);
  expect(statsReads(world)).toBe(idle);
  world.backend = 'tmux';
  await $.tool.call(call({ name: 'pane', subagent_type: 'reviewer' }));
  const launched = statsReads(world);
  await world.clock!.advance(5_000);
  expect(statsReads(world) > launched).toBe(true);
  await $.session.end({ reason: 'other', sessionId: 'lead-session', resume: { id: 'lead-session' } });
  const ended = statsReads(world);
  await world.clock!.advance(10_000);
  expect(statsReads(world)).toBe(ended);
});

test('an in-process teammate adds no polling, since its turns reach the lead directly', async ($, on) => {
  const world = await lead($, on);
  await $.tool.call(call({ name: 'inline', subagent_type: 'reviewer' }));
  const launched = statsReads(world);
  await world.clock!.advance(10_000);
  expect(statsReads(world)).toBe(launched);
});

test('a reloaded lead resumes polling for its split-pane teammates', async ($, on) => {
  const world = await lead($, on, { active: true, policy, agents: [
    { agentId: 'pane@session-lead', role: 'reviewer', effectiveModel: roles.reviewer.model, kind: 'teammate', name: 'pane', backend: 'tmux' },
  ] });
  const started = statsReads(world);
  await world.clock!.advance(5_000);
  expect(statsReads(world) > started).toBe(true);
});


test('a lead session leaves the main conversation TTL to Claude Code by default', async ($, on) => {
  const world = await lead($, on);
  expect(world.env.some(item => item.name === 'CLAUDE_CODE_PROMPT_CACHE_TTL' && item.value !== undefined)).toBe(false);
});

test('a teammate keeps its teammate model through the spawn the Agent tool raises for it', async ($, on) => {
  const world = await lead($, on, { active: true, policy: withMate }, fresh({ spawnTeammates: true }));
  await $.tool.call(call({ name: 'probe', subagent_type: 'Explore' }));
  const launch = world.calls.find(item => item.action === 'launch')!;
  expect(launch.spawned).toBe('vendor/mate-v1');
  expect(world.calls.filter(item => item.action === 'route').map(item => item.kind)).toEqual(['teammate']);
  expect(world.logs.some(line => line.includes('mismatch'))).toBe(false);
});

test('an in-process teammate launched with a role steps on the teammate model, found by its team address', async ($, on) => {
  echo(on);
  const world = await lead($, on, { active: true, policy: withMate });
  await $.tool.call(call({ name: 'probe', subagent_type: 'Explore' }));
  world.roster = [{ id: 'aprobe-1', description: 'Work', type: 'agent-router:scout', teammateId: 'probe@session-lead', status: 'running', name: 'probe' }];
  expect(await steps($, { agentId: 'aprobe-1', model: 'claude-opus-5-5', effort: 'low' }))
    .toEqual([{ kind: 'text', index: 0, text: 'vendor/mate-v1|high' }]);
});

test('a split-pane teammate request sent while its session is still starting waits, so it is pinned', async ($, on) => {
  on('turn.step', async function* ($, e) {
    yield { kind: 'text' as const, index: 0, text: `${e.model}|${e.effort ?? 'none'}` };
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const,
      usage: { model: e.model, cache_read_input_tokens: 0, cache_creation_input_tokens: 4000, input_tokens: 10, output_tokens: 2 } };
  });
  let release!: () => void;
  const self = { role: 'scout', type: 'agent-router:scout', model: 'vendor/mate-v1', effort: 'high' };
  const world = await lead($, on, { active: true, policy: withMate, leadSessionId: 'lead-of-mate', self, teammate: { agentId: 'worker@session-lead' } },
    fresh({ starting: new Promise<void>(resolve => { release = resolve; }) }));
  const first = steps($, { model: 'claude-opus-5-5', effort: 'low' });
  await Promise.resolve();
  release();
  expect(await first).toEqual([{ kind: 'text', index: 0, text: 'vendor/mate-v1|high' }]);
  await world.started;
});

test('a split-pane teammate session runs at its pinned effort, so keepalives and compactions match its requests', async ($, on) => {
  const self = { role: 'scout', type: 'agent-router:scout', model: 'vendor/mate-v1', effort: 'high' };
  const world = await lead($, on, { active: true, policy: withMate, leadSessionId: 'lead-of-mate', self, teammate: { agentId: 'worker@session-lead' } });
  expect(world.env.filter(item => item.name === 'CLAUDE_CODE_EFFORT_LEVEL').at(-1)?.value).toBe('high');
});

test('a teammate without a pinned effort and a lead leave the session effort alone', async ($, on) => {
  const self = { role: 'task', type: 'agent-router:task', model: 'vendor/task-v1' };
  const mate = await lead($, on, { active: true, policy, leadSessionId: 'lead-of-mate', self, teammate: { agentId: 'worker@session-lead' } });
  expect(mate.env.some(item => item.name === 'CLAUDE_CODE_EFFORT_LEVEL')).toBe(false);
});

test('a lead never sets the session effort', async ($, on) => {
  const world = await lead($, on, { active: true, policy: withMate });
  expect(world.env.some(item => item.name === 'CLAUDE_CODE_EFFORT_LEVEL')).toBe(false);
});

const applyCommand = { command: 'agent-models-apply', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } };
const spawnTeammate = (input: Record<string, unknown>) => ({ ...spawnInput('teammate'), isTeammate: true as const, ...input });
const reply = (text: unknown) => typeof text === 'string' ? text : '';
const pause = (ms: number) => new Promise(resolve => (globalThis as unknown as { setTimeout: (done: () => void, ms: number) => void }).setTimeout(() => resolve(undefined), ms));
const settle = async (check: () => boolean) => { for (let tries = 0; tries < 200 && !check(); tries++) await pause(5); };

test('without an endpoint only Agent Router roles are refused and the band stays plain', async ($, on) => {
  echo(on);
  const world = await lead($, on, { active: false, policy: null, agents: [{ agentId: 'old', role: 'scout', effectiveModel: roles.scout.model }] });
  expect(typeof (await $.tool.call(call({ name: 'probe', subagent_type: 'agent-router:scout' }))).deny).toBe('string');
  expect((await $.tool.call(call({ name: 'probe', subagent_type: 'Explore' }))).deny).toBe(undefined);
  expect(typeof (await $.agent.spawn(spawnInput('agent-router:scout'))).deny).toBe('string');
  expect((await $.agent.spawn({ ...spawnInput('Explore'), model: 'sonnet' })).model).toBe('sonnet');
  expect(typeof (await $.agent.spawn({ ...spawnInput('Explore'), subagentType: undefined } as any)).deny).toBe('string');
  expect(await steps($, { agentId: 'old', model: 'claude-opus-5-5' })).toEqual([{ kind: 'text', index: 0, text: 'claude-opus-5-5|none' }]);
  expect(reply((await $.command.run(applyCommand)).text).includes('Configure an Anthropic-compatible endpoint')).toBe(true);
  expect(badge(await $.ui.render(band()))).toBe(undefined);
  expect(world.calls.some(item => item.action === 'route')).toBe(false);
});

test('a failed or invalid setup refuses agents and says why', async ($, on) => {
  const world = await lead($, on, { active: true, policy }, fresh({ fail: { bootstrap: '' } }));
  expect((await $.tool.call(call({ name: 'probe', subagent_type: 'Explore' }))).deny).toBe('Agent Router bridge failed.');
  expect(reply((await $.command.run(applyCommand)).text).includes('Agent Router bridge failed.')).toBe(true);
  expect(badge(await $.ui.render(band()))).toBe(undefined);
  world.fail = undefined;
  world.replies = { bootstrap: { active: 'yes' } };
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(reply((await $.command.run(applyCommand)).text).includes('Invalid Agent Router bootstrap response')).toBe(true);
});

test('a session whose id is unavailable refuses agents and reports the picker problem', async ($, on) => {
  const world = await lead($, on, { active: true, policy }, fresh({ refuse: { id: true } }));
  expect(typeof (await $.tool.call(call({ name: 'probe', subagent_type: 'Explore' }))).deny).toBe('string');
  expect(world.logs.some(line => line.startsWith('Agent Router models:'))).toBe(true);
  expect(world.calls.length).toBe(0);
});

test('other tools, survey prompts and non-interactive sessions pass through untouched', async ($, on) => {
  const world = await lead($, on);
  expect((await $.tool.call({ tool: 'Grep', tool_use_id: 'grep', pattern: 'x' } as any)).result).toBe('ran Grep');
  expect(badge(await $.ui.render({ ...band(), props: { ...band().props, hasSurvey: true } }))).toBe(undefined);
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false });
  await $.tool.call(call({ name: 'quiet', subagent_type: 'Explore' }));
  expect(world.calls.find(item => item.action === 'launch')?.input.subagent_type).toBe('Explore');
});

test('a teammate Claude Code renames keeps its route, and model substitutions are reported', async ($, on) => {
  echo(on);
  const world = await lead($, on, { active: true, policy: withMate }, fresh({ fail: { result: 'disk full' } }));
  world.launch = input => ({ result: { status: 'teammate_spawned', name: input.name === 'first' ? 'renamed' : undefined, model: 'claude-opus-5-5', is_splitpane: true } });
  await $.tool.call(call({ name: 'first', subagent_type: 'Explore' }));
  await $.tool.call(call({ name: 'second', subagent_type: 'Explore' }));
  expect(world.logs.some(line => line.includes('mismatch: teammate renamed'))).toBe(true);
  expect(world.logs.some(line => line.includes('mismatch: teammate second'))).toBe(true);
  expect(world.logs.some(line => line.includes('teammate started, but'))).toBe(true);
  world.roster = [{ id: 'arenamed-1', description: 'Work', type: 'teammate', status: 'running', name: 'renamed' },
    { id: 'afirst-1', description: 'Work', type: 'teammate', status: 'running', name: 'first' }];
  expect(await steps($, { agentId: 'arenamed-1', model: 'claude-opus-5-5' })).toEqual([{ kind: 'text', index: 0, text: 'vendor/mate-v1|none' }]);
  expect(await steps($, { agentId: 'afirst-1', model: 'claude-opus-5-5' })).toEqual([{ kind: 'text', index: 0, text: 'claude-opus-5-5|none' }]);
});

test('a named call that does not start a teammate records why', async ($, on) => {
  const world = await lead($, on, { active: true, policy }, fresh({ fail: { result: '' } }));
  const outcomes = [{ deny: 'Teams are off' }, { isError: true, result: null, text: 'Spawn crashed' }, { isError: true, result: null }, { result: 'ran as a subagent' }];
  for (const [index, outcome] of outcomes.entries()) {
    world.launch = () => outcome;
    await $.tool.call(call({ name: `try-${index}`, subagent_type: 'Explore' }));
  }
  world.launch = async input => {
    await $.agent.spawn({ ...spawnInput('Explore'), tool_use_id: input.tool_use_id });
    return { isError: true, result: null, text: 'Subagent failed' };
  };
  await $.tool.call(call({ name: 'as-subagent', subagent_type: 'Explore' }));
  expect(world.calls.filter(item => item.action === 'result').map(item => item.result.deny))
    .toEqual(['Teams are off', 'Spawn crashed', 'The teammate did not start.', undefined]);
});

test('a teammate launch that cannot restore the subagent model still returns, and later launches run', async ($, on) => {
  const world = await lead($, on, { active: true, policy }, fresh({ refuse: { restore: true } }));
  expect((await $.tool.call(call({ name: 'first', subagent_type: 'Explore' }))).deny).toBe(undefined);
  await $.tool.call(call({ name: 'second', subagent_type: 'reviewer' }));
  expect(world.calls.filter(item => item.action === 'launch').map(item => item.model)).toEqual([roles.scout.model, roles.reviewer.model]);
});

test('a teammate call is refused when its environment cannot be read', async ($, on) => {
  const world = await lead($, on, { active: true, policy }, fresh({ refuse: { teams: true } }));
  expect((await $.tool.call(call({ name: 'probe', subagent_type: 'Explore' }))).deny).toBe('Agent Router guard failed before tool dispatch.');
  expect(world.calls.some(item => item.action === 'launch')).toBe(false);
});

test('teammates the Agent tool spawns directly route as teammates and relay bridge notices', async ($, on) => {
  const world = await lead($, on, { active: true, policy: withMate }, fresh({ replies: { result: { systemMessage: 'Teammate noted' } } }));
  world.spawned = e => ({ model: e.model });
  const untyped = await $.agent.spawn(spawnTeammate({ tool_use_id: 'direct-1', name: 'direct' }));
  const typed = await $.agent.spawn(spawnTeammate({ tool_use_id: 'direct-2', name: 'typed', subagentType: 'reviewer' }));
  expect([untyped.model, typed.model]).toEqual(['vendor/mate-v1', 'vendor/mate-v1']);
  expect(world.calls.filter(item => item.action === 'route').map(item => [item.kind, item.name, item.effectiveType]))
    .toEqual([['teammate', 'direct', 'agent-router:task'], ['teammate', 'typed', 'agent-router:reviewer']]);
  expect(world.logs.filter(line => line === 'Teammate noted').length).toBe(2);
  world.replies = undefined;
  world.spawnTeammates = true;
  await $.tool.call(call({ name: 'launched', subagent_type: 'Explore' }));
  expect(world.calls.find(item => item.action === 'launch')?.spawned).toBe('vendor/mate-v1');
});

test('agents first seen on the roster are matched to their routes', async ($, on) => {
  echo(on);
  const world = await lead($, on, { active: true, policy, agents: [
    { agentId: 7, role: 'scout' }, { agentId: 'mate@x', kind: 'teammate', backend: 'in-process' },
    { agentId: 'stale', role: 'scout', effectiveModel: 'vendor/old' }, { agentId: 'gone', role: 'retired', effectiveModel: 'vendor/old' },
  ] });
  world.roster = [{ id: 'anon-1', description: 'Work', type: 'teammate', status: 'running' },
    { id: 'scout-x', description: 'Work', type: 'agent-router:scout', status: 'running' }];
  for (const agentId of ['anon-1', 'ghost', 'stale', 'ghost']) {
    expect(await steps($, { agentId, model: 'claude-opus-5-5' })).toEqual([{ kind: 'text', index: 0, text: 'claude-opus-5-5|none' }]);
  }
  expect(await steps($, { agentId: 'scout-x', model: roles.scout.model, effort: 'high' })).toEqual([{ kind: 'text', index: 0, text: `${roles.scout.model}|low` }]);
  expect(world.logs.some(line => line.includes('corrected'))).toBe(false);
});

test('a teammate whose first request overtakes its renamed launch waits for it', async ($, on) => {
  echo(on);
  const world = await lead($, on, { active: true, policy: withMate });
  world.roster = [{ id: 'alate-1', description: 'Work', type: 'teammate', status: 'running', name: 'late' }];
  let early: Promise<unknown> | undefined;
  world.launch = async () => {
    const lists = world.lists ?? 0;
    early = steps($, { agentId: 'alate-1', model: 'claude-opus-5-5' });
    await settle(() => (world.lists ?? 0) > lists);
    return { result: { status: 'teammate_spawned', name: 'late', agent_id: 'late@session-lead' } };
  };
  await $.tool.call(call({ name: 'early', subagent_type: 'Explore' }));
  expect(await early).toEqual([{ kind: 'text', index: 0, text: 'vendor/mate-v1|none' }]);
});

test('the band shows a teammate route before its first request and counts only managed agents', async ($, on) => {
  const world = await lead($, on, { active: true, policy: withMate });
  await $.tool.call(call({ name: 'probe', subagent_type: 'Explore' }));
  world.roster = [{ id: 'aprobe-1', description: 'Work', type: 'teammate', status: 'running', name: 'probe' },
    { id: 'anon-1', description: 'Work', type: 'teammate', status: 'running' },
    { id: 'astranger-1', description: 'Work', type: 'teammate', status: 'running', name: 'stranger' }];
  expect(badge(await $.ui.render(band('aprobe-1')))).toBe('⇄ · vendor/mate-v1 · high');
  expect(badge(await $.ui.render(band('anon-1')))).toBe('⇄');
  expect(badge(await $.ui.render(band('ghost')))).toBe('⇄');
  await world.clock!.advance(1000);
  expect(text(await $.ui.render(band())).includes('1 running')).toBe(true);
});

test('completed turns that cannot be recorded are logged for debugging', async ($, on) => {
  const world = await lead($, on, { active: true, policy }, fresh({ fail: { observe: 'disk full' } }));
  const spawned = await $.agent.spawn(spawnInput('Explore'));
  await $.turn.complete({ answer: 'x', durationMs: 5, isAborted: false, reason: 'answer', turnId: 't', agentId: spawned.agentId,
    usage: { model: roles.scout.model, input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
  expect(world.logs.some(line => line.includes('completed-turn observations'))).toBe(true);
});

test('applying settings lists the teammate override as saved', async ($, on) => {
  const world = await lead($, on, { active: true, policy, pendingConfiguration: true });
  const lines: string[] = [];
  for (const teammate of [{ model: 'vendor/mate-v2', effort: 'max' }, { effort: 'low' }, { model: 'vendor/mate-v3' }]) {
    world.applied = { ...policy, teammate };
    lines.push(reply((await $.command.run(applyCommand)).text).split('\n').find(line => line.startsWith('- teammates'))!);
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  }
  expect(lines).toEqual(['- teammates: vendor/mate-v2 (max effort)', '- teammates: each role\'s model (low effort)', '- teammates: vendor/mate-v3']);
});
