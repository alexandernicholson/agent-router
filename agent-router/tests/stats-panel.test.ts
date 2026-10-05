import { test, expect, mock, tier } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { AgentInfo, On, RenderInput, RenderNode } from 'claude-code';
import { ROLES } from '../lib/routing.js';

tier('user');

const band: RenderInput<'AbovePrompt', 'terminal'> = {
  component: 'AbovePrompt', surface: 'terminal', requestId: 'stats-band',
  props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 5 }, view: {} },
};

function text(node: RenderNode): string {
  if (typeof node === 'string') return node;
  return 'children' in node && Array.isArray(node.children) ? node.children.map(text).join(' ') : '';
}

test('resumed agents lose their previous terminal status across roster removal and reload', async ($, on) => {
  const clock = mock.clock(on);
  mock.store(on);
  mock.env(on, {});
  const managed: AgentInfo = { id: 'managed', description: 'Worker', type: 'task', status: 'completed' };
  const foreign: AgentInfo = { id: 'foreign', description: 'Unmanaged', type: 'task', status: 'running' };
  let roster = [managed, foreign];
  const policy = { version: 1, roles: Object.fromEntries(ROLES.map(role => [role, { model: 'vendor/worker-v1', aliases: [role] }])) };
  on('session.id', () => ({ value: 'stats-session' }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('command.register', ($, e) => ({ value: { command: e.name } }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.log', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('agent.list', () => ({ value: roster }));
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }));
  on('process.run', ($, e) => {
    const request = JSON.parse(e.init?.stdin || '{}');
    return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 0, stderr: '', stdout: JSON.stringify(request.action === 'bootstrap'
      ? { active: true, policy, agents: [{ agentId: 'managed', role: 'task', effectiveModel: 'vendor/worker-v1' }] }
      : { routed: 0, overrides: 0, mismatches: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) } };
  });
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(text(await $.ui.render(band)).match(/\d+/g)?.map(Number)).toEqual([0, 1, 0]);
  roster = [{ ...managed, status: 'running' }, foreign];
  await clock.advance(1000);
  expect(text(await $.ui.render(band)).match(/\d+/g)?.map(Number)).toEqual([1, 0, 0]);
  roster = [foreign];
  await clock.advance(1000);
  expect(text(await $.ui.render(band)).match(/\d+/g)?.map(Number)).toEqual([0, 0, 0]);
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(text(await $.ui.render(band)).match(/\d+/g)?.map(Number)).toEqual([0, 0, 0]);
});

type Hook = (key: string, value?: unknown) => any;
const pause = (ms: number) => new Promise(resolve => (globalThis as unknown as { setTimeout: (done: () => void, ms: number) => void }).setTimeout(() => resolve(undefined), ms));
type Stats = { routed: number; overrides: number; mismatches: number; inputTokens: number; outputTokens: number; cacheReadTokens: number };

function world(on: On) {
  const policy = { version: 1, roles: Object.fromEntries(ROLES.map(role => [role, { model: 'vendor/worker-v1', aliases: [role] }])) };
  const state = { store: new Map<string, unknown>(), roster: [] as AgentInfo[], ids: 0, stats: { routed: 3, overrides: 1, mismatches: 0, inputTokens: 500, outputTokens: 1500, cacheReadTokens: 2_500_000 } as Stats,
    hooks: {} as Partial<Record<'get' | 'set' | 'list', Hook>> };
  mock.env(on, {});
  const clock = mock.clock(on);
  on('store.get', async ($, e) => (await state.hooks.get?.(e.key)) ?? { value: state.store.get(e.key) });
  on('store.set', async ($, e) => (await state.hooks.set?.(e.key, e.value)) ?? (state.store.set(e.key, e.value), { value: undefined }));
  on('store.delete', ($, e) => (state.store.delete(e.key), { value: undefined }));
  on('session.id', () => { state.ids++; return { value: 'stats-session' }; });
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('command.register', ($, e) => ({ value: { command: e.name } }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.log', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('agent.list', async () => (await state.hooks.list?.('')) ?? { value: state.roster });
  on('agent.spawn', ($, e) => ({ model: e.model!, agentId: 'spawned' }));
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }));
  on('process.run', ($, e) => {
    const request = JSON.parse(e.init?.stdin || '{}');
    return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 0, stderr: '', stdout: JSON.stringify(request.action === 'bootstrap'
      ? { active: true, policy, agents: ['a', 'b', 'c'].map(agentId => ({ agentId, role: 'task', effectiveModel: 'vendor/worker-v1' })) }
      : request.action === 'stats' ? state.stats : {}) } };
  });
  return { state, clock };
}

const begin = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => $.session.start({ cwd: '/work', surface, isInteractive: true });
const shown = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => text(await $.ui.render({ ...band, surface } as RenderInput<'AbovePrompt', 'terminal'>)).trim();
const cycle = async ($: Engine) => { await shown($); return $.ui.press({ plugin: 'agent-router', key: 'router-view', requestId: 'stats-band' }); };
const gate = () => { let open!: (value?: unknown) => void; const wait = new Promise(resolve => { open = resolve; }); return { wait, open }; };
async function until(check: () => boolean) {
  for (let tries = 0; tries < 200 && !check(); tries++) await pause(5);
  await pause(20);
}

test('the usage and routing views show token sizes and routing counts', async ($, on) => {
  const { state } = world(on);
  await begin($);
  await cycle($);
  expect((await shown($)).includes('500 in · 1.5k out · 2.5m cache read')).toBe(true);
  await cycle($);
  expect((await shown($)).includes('3 routed · 1 overrides · 0 mismatches')).toBe(true);
  state.stats = { ...state.stats, inputTokens: 3_000_000_000 };
  await cycle($);
  await cycle($);
  await begin($);
  expect((await shown($)).includes('Usage')).toBe(true);
  expect((await shown($)).includes('3b in')).toBe(true);
  expect(state.store.get('stats-view')).toBe('Usage');
});

test('a view that cannot be saved is marked unsaved', async ($, on) => {
  const { state } = world(on);
  state.hooks.set = key => key === 'stats-view' ? { deny: 'Store is read-only' } : undefined;
  await begin($);
  await cycle($);
  expect((await shown($)).includes('view unsaved')).toBe(true);
});

test('a view chosen before the statistics start is kept once they do', async ($, on) => {
  const { state } = world(on);
  await begin($, 'desktop');
  await $.agent.spawn({ tool_use_id: 'desk', description: 'Work', prompt: 'Work', subagentType: 'task', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'sonnet', background: true, fork: false });
  await shown($, 'desktop');
  await $.ui.press({ plugin: 'agent-router', key: 'router-view', requestId: 'stats-band', surface: 'desktop' });
  state.store.set('stats-view', 'Routing');
  await begin($);
  expect((await shown($)).startsWith('Usage')).toBe(true);
  expect(state.store.get('stats-view')).toBe('Usage');
});

test('corrupt activity history is ignored until a valid one loads', async ($, on) => {
  const { state, clock } = world(on);
  const key = 'stats-activity:stats-session';
  state.store.set(key, 'corrupt');
  state.roster = [{ id: 'a', description: 'Worker', type: 'task', status: 'completed' }];
  await begin($);
  expect((await shown($)).includes('unavailable')).toBe(true);
  for (const saved of [['x'], [['a']], [[1, 'completed']], [['a', 'running']]]) {
    state.store.set(key, saved);
    await clock.advance(1000);
    expect((await shown($)).includes('unavailable')).toBe(true);
  }
  state.store.set(key, [['a', 'completed'], ['b', 'killed']]);
  await clock.advance(1000);
  expect((await shown($)).match(/\d+/g)?.map(Number)).toEqual([0, 1, 1]);
  await clock.advance(1000);
  expect((await shown($)).match(/\d+/g)?.map(Number)).toEqual([0, 1, 1]);
});

test('a session restarted while its view loads keeps only the newer session', async ($, on) => {
  const { state } = world(on);
  state.store.set('stats-view', 'Routing');
  const held = gate();
  let calls = 0;
  state.hooks.get = async key => { if (key === 'stats-view' && ++calls === 1) await held.wait; };
  const first = begin($);
  await until(() => calls === 1);
  await begin($);
  held.open();
  await first;
  expect((await shown($)).startsWith('Routing')).toBe(true);
});

test('a view read that fails marks the view unsaved, but only for the current session', async ($, on) => {
  const { state } = world(on);
  const held = gate();
  let calls = 0;
  state.hooks.get = async key => {
    if (key !== 'stats-view') return undefined;
    if (++calls === 1) await held.wait;
    return { deny: 'Store unavailable' };
  };
  const first = begin($);
  await until(() => calls === 1);
  await begin($);
  held.open();
  await first;
  expect((await shown($)).includes('view unsaved')).toBe(true);
});

test('activity loading from a replaced session is dropped', async ($, on) => {
  const { state } = world(on);
  const history = gate();
  const roster = gate();
  let reads = 0;
  let lists = 0;
  state.hooks.get = async key => { if (key.startsWith('stats-activity:') && ++reads === 1) await history.wait; };
  state.hooks.list = async () => { if (++lists === 1) await roster.wait; };
  const first = begin($);
  await until(() => reads === 1);
  const second = begin($);
  await until(() => lists === 1);
  history.open();
  await first;
  await begin($);
  roster.open();
  await second;
  expect((await shown($)).match(/\d+/g)?.map(Number)).toEqual([0, 0, 0]);
});

test('view choices saved after their session was replaced do not touch the new one', async ($, on) => {
  const { state } = world(on);
  await begin($);
  await shown($);
  const held = gate();
  let writes = 0;
  state.hooks.set = async key => {
    if (key !== 'stats-view') return undefined;
    if (++writes === 1) await held.wait;
    return writes === 2 ? { deny: 'Store unavailable' } : undefined;
  };
  const clicks = [cycle($), cycle($)];
  await until(() => writes === 1);
  const ids = state.ids;
  const restart = begin($);
  await until(() => state.ids > ids + 2);
  held.open();
  await Promise.all([...clicks, restart]);
  expect((await shown($)).includes('view unsaved')).toBe(false);
});
