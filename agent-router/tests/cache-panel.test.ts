import { test, expect, mock, tier } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { AgentInfo, On, RenderInput, RenderNode, TurnStepInput } from 'claude-code';
import { ROLES } from '../lib/routing.js';
import { applyCacheCreation } from '../lib/cache.js';

tier('user');

const pane: RenderInput<'Pane', 'terminal'> = { component: 'Pane', surface: 'terminal', requestId: 'agent-cache',
  props: { title: 'Agent cache', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 24 }, view: {} } };
function band(agentId?: string): RenderInput<'AbovePrompt', 'terminal'> {
  return { component: 'AbovePrompt', surface: 'terminal', requestId: 'cache-band', props: {
    hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 110, scroll: { offset: 0, bodyRows: 5 }, view: { agentId },
  } };
}
function text(node: RenderNode): string {
  if (typeof node === 'string') return node;
  const label = node.type === 'Button' ? node.props.label : '';
  return label || ('children' in node && Array.isArray(node.children) ? node.children.map(text).join(' ') : '');
}

async function setup($: Engine, on: On, endpoint = 'https://gateway.example') {
  mock.store(on);
  mock.env(on, { ANTHROPIC_BASE_URL: endpoint });
  const clock = mock.clock(on);
  const world = { samples: [] as Record<string, any>[], resets: [] as Record<string, any>[], calls: [] as Record<string, any>[],
    roster: [] as AgentInfo[], sessionId: 'cache-session', failSave: false, failRead: false, logs: [] as string[],
    reported: undefined as { fiveMinute: number; oneHour: number } | undefined };
  const policy = { version: 1, roles: Object.fromEntries(ROLES.map(role => [role, { model: `vendor/${role}`, aliases: [role] }])) };
  on('session.id', () => ({ value: world.sessionId }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('settings.read', () => ({ value: {} }));
  on('command.register', ($, e) => ({ value: { command: e.name } }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('ui.close', () => ({ value: undefined }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('ui.log', ($, e) => { world.logs.push(e.text); return { value: undefined }; });
  on('agent.list', () => ({ value: world.roster }));
  on('agent.spawn', ($, e) => ({ model: e.model!, agentId: 'child' }));
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: ['Existing prompt content'] }));
  on('process.run', ($, e) => {
    const request = JSON.parse(e.init?.stdin || '{}');
    world.calls.push(request);
    if (request.action === 'cache-sample') {
      if (world.failSave) return { value: { exitCode: 1, stderr: 'storage failed', stdout: '' } };
      world.samples.push(world.reported ? applyCacheCreation(request.sample, world.reported) : request.sample);
    }
    if (request.action === 'cache-reset') world.resets.push({ sessionId: request.session_id, agentId: request.agent_id ?? null, resetAt: request.reset_at });
    if (request.action === 'cache-snapshot' && world.failRead) return { value: { exitCode: 1, stderr: 'storage failed', stdout: '' } };
    const output = request.action === 'bootstrap' ? { active: true, policy, agents: [] }
      : request.action === 'cache-sample' ? { sample: world.samples.at(-1) }
      : request.action === 'cache-snapshot' ? { samples: world.samples.filter(s => s.sessionId === request.session_id), resets: world.resets, labels: [] }
      : request.action === 'stats' ? { routed: 0, overrides: 0, mismatches: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } : {};
    return { value: { exitCode: 0, stderr: '', stdout: JSON.stringify(output) } };
  });
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  return { world, clock };
}

function response(on: On, read = 800, write = 100, fresh = 100, missing = false) {
  on('turn.step', async function* ($, e) {
    yield { kind: 'text' as const, index: 0, text: 'PRIVATE_ANSWER' };
    return { turnId: e.turnId, index: e.index, answer: 'PRIVATE_ANSWER', toolUses: [], stopReason: 'end_turn' as const,
      usage: missing ? null : { model: e.model, cache_read_input_tokens: read, cache_creation_input_tokens: write, input_tokens: fresh, output_tokens: 20 } };
  });
}
async function step($: Engine, extra: Partial<TurnStepInput> = {}) {
  const chunks = [];
  const stream = $.turn.step({ turnId: 'same-turn', index: 0, messageCount: 1, model: 'vendor/main', ...extra });
  for (;;) {
    const part = await stream.next();
    if (part.done) return { chunks, result: part.value };
    chunks.push(part.value);
  }
}
async function dashboard($: Engine) {
  await $.command.run({ command: 'agent-cache', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } });
  return text(await $.ui.render(pane));
}

test('main and child cache bars remain distinct and native stream and response survive observation', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  const main = await step($);
  expect(main.chunks).toEqual([{ kind: 'text', index: 0, text: 'PRIVATE_ANSWER' }]);
  expect(main.result.answer).toBe('PRIVATE_ANSWER');
  await step($, { index: 1 });
  await $.agent.spawn({ tool_use_id: 'spawn', description: 'Search', prompt: 'PRIVATE_PROMPT', subagentType: 'agent-router:scout',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'vendor/main', background: true, fork: false });
  world.roster = [{ id: 'child', type: 'agent-router:scout', description: 'Search', status: 'running' }];
  await step($, { agentId: 'child' });
  expect(world.samples.length).toBe(3);
  expect(world.samples[2].model).toBe('vendor/scout');
  expect(JSON.stringify(world.samples).includes('PRIVATE')).toBe(false);
  const contents = await dashboard($);
  expect(contents.includes('2 requests')).toBe(true);
  expect(contents.includes('1 requests')).toBe(true);
  expect(contents.includes('child')).toBe(true);
  expect(contents.includes('80% hit')).toBe(true);
  expect(contents.includes('TTL unknown')).toBe(true);
  expect(contents.includes('Recent requests')).toBe(true);
  const rendered = text(await $.ui.render(band('child')));
  expect(rendered.includes('Existing prompt content')).toBe(true);
  expect(rendered.includes('80% hit')).toBe(true);
});

test('native countdown expires from dispatch and compaction clears only the affected prefix', async ($, on) => {
  response(on);
  on('session.compact', ($, e) => ({ messages: e.messages }));
  const { clock, world } = await setup($, on, 'https://api.anthropic.com');
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await step($);
  await step($, { agentId: 'unmanaged', model: 'vendor/worker' });
  await clock.advance(301000);
  expect(text(await $.ui.render(band())).includes('likely expired')).toBe(true);
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'assistant', text: 'Summary', toolUses: [] }], instructions: 'Keep essentials' });
  expect(world.resets.length).toBe(1);
  expect(text(await $.ui.render(band())).includes('no observation')).toBe(true);
  expect(text(await $.ui.render(band('unmanaged'))).includes('likely expired')).toBe(true);
  const contents = await dashboard($);
  expect(contents.includes('read 800')).toBe(true);
});

test('missing usage never masquerades as zero and persistence failure cannot break a response', async ($, on) => {
  response(on, 0, 0, 100, true);
  const { world } = await setup($, on);
  await step($);
  expect(world.samples.length).toBe(0);
  expect(text(await $.ui.render(band())).includes('no observation')).toBe(true);
  expect(text(await $.ui.render(band())).includes('0%')).toBe(false);
});

test('failed save retains locally observed usage and emits no prompt or answer in records', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  world.failSave = true;
  const result = await step($);
  expect(result.result.answer).toBe('PRIVATE_ANSWER');
  expect(world.logs.some(log => log.includes('cache observation'))).toBe(true);
  expect(text(await $.ui.render(band())).includes('storage unavailable')).toBe(true);
  world.failRead = true;
  const contents = await dashboard($);
  expect(contents.includes('80% hit')).toBe(true);
  expect(contents.includes('Storage unavailable')).toBe(true);
});

test('clear separates new session usage and does not reuse a warm bar', async ($, on) => {
  response(on);
  on('session.end', ($, e) => ({ sessionId: e.sessionId }));
  const { world } = await setup($, on);
  await step($);
  await $.session.end({ reason: 'clear', sessionId: world.sessionId, resume: { id: world.sessionId } });
  world.sessionId = 'new-session';
  await step($);
  expect(world.samples[1].sessionId).toBe('new-session');
  const contents = await dashboard($);
  expect(contents.includes('1 requests')).toBe(true);
  expect(contents.includes('2 requests')).toBe(false);
});

test('cache panel close button releases the pane', async ($, on) => {
  const { world } = await setup($, on);
  await dashboard($);
  await $.ui.press({ plugin: 'agent-router', key: 'agent-cache-close', requestId: 'agent-cache' });
  expect(world.calls.some(call => call.action === 'cache-snapshot')).toBe(true);
});

test('reported third-party mixed TTLs produce separate lifetime bars in the native pane', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 40, oneHour: 60 };
  await step($);
  const contents = await dashboard($);
  expect(contents.includes('Reported 5m writes 40')).toBe(true);
  expect(contents.includes('Reported 1h writes 60')).toBe(true);
  expect(contents.includes('response cache_creation')).toBe(true);
  expect(contents.includes('provider TTL unknown')).toBe(false);
  await clock.advance(301000);
  const later = text(await $.ui.render(pane));
  expect(later.includes('~0:00 left')).toBe(true);
  expect(later.includes('~54:59 left')).toBe(true);
});

test('absent metadata is unknown for main and child on an Anthropic endpoint', async ($, on) => {
  response(on);
  const { clock, world } = await setup($, on, 'https://api.anthropic.com');
  await step($);
  await step($, { agentId: 'child' });
  expect(world.samples.every(sample => sample.ttlMs === null)).toBe(true);
  await clock.advance(301000);
  expect(text(await $.ui.render(band())).includes('TTL unknown')).toBe(true);
  expect(text(await $.ui.render(band('child'))).includes('TTL unknown')).toBe(true);
  const contents = await dashboard($);
  expect(contents.includes('Estimated lifetime')).toBe(false);
  expect(contents.includes('likely expired')).toBe(false);
});
