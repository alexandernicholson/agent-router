import { test, expect, mock, tier } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { AgentInfo, On, RenderInput, RenderNode, TurnStepInput } from 'claude-code';
import { ROLES } from '../lib/routing.js';
import { applyCacheCreation, loopKey } from '../lib/cache.js';
import { CACHE_COLORS } from '../lib/cache-colors.js';

tier('user');
const DARK = CACHE_COLORS.dark;

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

const ttlSeen: { at: string; agentId: string | null; value?: string }[] = [];
let liveEnv: Record<string, string | undefined> = {};

async function setup($: Engine, on: On, endpoint = 'https://gateway.example', stored?: Record<string, unknown>,
  extra: { settings?: Record<string, unknown>; env?: Record<string, string>; auth?: 'bearer' | 'api-key'; refuseEnv?: boolean } = {}) {
  mock.store(on, stored);
  ttlSeen.length = 0;
  const env: Record<string, string | undefined> = { ...(endpoint ? { ANTHROPIC_BASE_URL: endpoint } : {}), ...extra.env };
  const envSets: [string, string | undefined][] = [];
  liveEnv = env;
  on('env.get', ($, e) => ({ value: env[e.name] }));
  on('env.set', ($, e) => {
    if (extra.refuseEnv) throw new Error('env.set refused');
    envSets.push([e.name, e.value]); env[e.name] = e.value; return { value: undefined };
  });
  on('session.authorize', () => ({ value: extra.auth ? { handle: 'opaque', kind: extra.auth } : null }));
  const clock = mock.clock(on);
  const world = { samples: [] as Record<string, any>[], resets: [] as Record<string, any>[], calls: [] as Record<string, any>[],
    roster: [] as AgentInfo[], sessionId: 'cache-session', failSave: false, failRead: false, logs: [] as string[],
    reported: undefined as { fiveMinute: number; oneHour: number } | undefined,
    flushed: undefined as { fiveMinute: number; oneHour: number } | undefined,
    forks: [] as string[], compactions: [] as string[], theme: 'dark',
    forkUsage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
    compaction: {} as Record<string, unknown>,
    prices: { 'vendor/main': { read: 0.1, fiveMinute: 1.25, output: 5, provider: 'example', id: 'main-1', source: 'models.dev' } } as Record<string, unknown>,
    priceLookups: [] as string[][], pricesFail: false,
    linked: [] as Record<string, any>[], labels: [] as [string, string][], env, envSets };
  const policy = { version: 1, roles: Object.fromEntries(ROLES.map(role => [role, { model: `vendor/${role}`, aliases: [role] }])) };
  on('session.id', () => ({ value: world.sessionId }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('settings.read', () => ({ value: extra.settings ?? {} }));
  on('command.register', ($, e) => ({ value: { command: e.name } }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('ui.close', () => ({ value: undefined }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('ui.log', ($, e) => { world.logs.push(e.text); return { value: undefined }; });
  on('agent.list', () => ({ value: world.roster }));
  on('classic.SessionStart', () => ({}));
  on('classic.Stop', () => ({}));
  on('model.fork', ($, e) => {
    world.forks.push(e.prompt);
    ttlSeen.push({ at: 'keepalive', agentId: null, value: env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL });
    return { value: { isAnswered: true as const, text: 'OK', usage: world.forkUsage } };
  });
  on('session.compact', ($, e) => {
    world.compactions.push('instructions' in e && e.instructions ? e.instructions : 'default');
    ttlSeen.push({ at: 'compaction', agentId: e.agentId ?? null, value: env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL });
    return { messages: [{ role: 'assistant' as const, text: 'Summary', toolUses: [] }], ...world.compaction };
  });
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'enum', value: world.theme, provider: { plugin: 'engine', tier: 'core' }, isLocked: false }] as any }));
  on('agent.spawn', ($, e) => ({ model: e.model!, agentId: 'child' }));
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: ['Existing prompt content'] }));
  on('process.run', ($, e) => {
    const request = JSON.parse(e.init?.stdin || '{}');
    world.calls.push(request);
    if (request.action === 'cache-sample') {
      if (world.failSave) return { value: { exitCode: 1, stderr: 'storage failed', stdout: '' } };
      world.samples.push(world.reported ? applyCacheCreation(request.sample, world.reported) : request.sample);
    }
    if (request.action === 'cache-enrich') {
      const enriched = [];
      for (const [i, s] of world.samples.entries()) {
        if (!world.flushed || s.sessionId !== request.session_id || s.agentId !== (request.agent_id ?? null) || s.cacheCreation || !s.write) continue;
        world.samples[i] = applyCacheCreation(s, world.flushed);
        enriched.push(world.samples[i]);
      }
      return { value: { exitCode: 0, stderr: '', stdout: JSON.stringify({ samples: enriched }) } };
    }
    if (request.action === 'cache-prices') {
      world.priceLookups.push(request.models);
      if (world.pricesFail) return { value: { exitCode: 1, stderr: 'offline', stdout: '' } };
      const prices = Object.fromEntries(request.models.map((model: string) => [model, world.prices[model] ?? null]));
      return { value: { exitCode: 0, stderr: '', stdout: JSON.stringify({ catalog: 'fresh', prices }) } };
    }
    if (request.action === 'cache-reset') world.resets.push({ sessionId: request.session_id, agentId: request.agent_id ?? null, resetAt: request.reset_at });
    if (request.action === 'cache-snapshot' && world.failRead) return { value: { exitCode: 1, stderr: 'storage failed', stdout: '' } };
    const output = request.action === 'bootstrap' ? { active: true, policy, agents: [] }
      : request.action === 'cache-sample' ? { sample: world.samples.at(-1) }
      : request.action === 'cache-snapshot' ? { samples: [...world.samples.filter(s => s.sessionId === request.session_id), ...world.linked], resets: world.resets, labels: world.labels }
      : request.action === 'stats' ? { routed: 0, overrides: 0, mismatches: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } : {};
    return { value: { exitCode: 0, stderr: '', stdout: JSON.stringify(output) } };
  });
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  return { world, clock };
}

function response(on: On, read = 800, write = 100, fresh = 100, missing = false) {
  on('turn.step', async function* ($, e) {
    ttlSeen.push({ at: 'step', agentId: e.agentId ?? null, value: e.agentId ? liveEnv.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL : liveEnv.CLAUDE_CODE_PROMPT_CACHE_TTL });
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
  expect(contents.includes('1 request ')).toBe(true);
  expect(contents.includes('child')).toBe(true);
  expect(contents.includes('80%')).toBe(true);
  expect(contents.includes('not reported')).toBe(true);
  expect(contents.includes('Recent requests')).toBe(true);
  const rendered = text(await $.ui.render(band('child')));
  expect(rendered.includes('Existing prompt content')).toBe(true);
  expect(rendered.includes('80%')).toBe(true);
});

test('native countdown expires from dispatch and compaction clears only the affected prefix', async ($, on) => {
  response(on);
  const { clock, world } = await setup($, on, 'https://api.anthropic.com');
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await step($);
  await step($, { agentId: 'unmanaged', model: 'vendor/worker' });
  await clock.advance(301000);
  expect(text(await $.ui.render(band())).includes('expired')).toBe(true);
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'assistant', text: 'Summary', toolUses: [] }], instructions: 'Keep essentials' });
  expect(world.resets.length).toBe(1);
  expect(text(await $.ui.render(band())).includes('cmpt ✓')).toBe(true);
  expect(text(await $.ui.render(band('unmanaged'))).includes('expired')).toBe(true);
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
  expect(contents.includes('80%')).toBe(true);
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
  expect(contents.includes('1 request ')).toBe(true);
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
  expect(contents.includes('TTL 5m · 40 written')).toBe(true);
  expect(contents.includes('TTL 1h · 60 written')).toBe(true);
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
  expect(text(await $.ui.render(band())).includes('not reported')).toBe(true);
  expect(text(await $.ui.render(band('child'))).includes('not reported')).toBe(true);
  const contents = await dashboard($);
  expect(contents.includes('Estimated lifetime')).toBe(false);
  expect(contents.includes('expired')).toBe(false);
});

const transcript = '/transcripts/cache-session.jsonl';
const enrichments = (world: { calls: Record<string, any>[] }) => world.calls.filter(call => call.action === 'cache-enrich').length;

test('a final response flushed to the transcript after Stop still gets its reported TTL', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  await $.classic.SessionStart({ source: 'startup', session_id: world.sessionId, transcript_path: transcript });
  await step($);
  await $.classic.Stop({ stop_hook_active: false, session_id: world.sessionId, transcript_path: transcript });
  expect(text(await $.ui.render(band())).includes('not reported')).toBe(true);
  world.flushed = { fiveMinute: 100, oneHour: 0 };
  await clock.advance(1000);
  const rendered = text(await $.ui.render(band()));
  expect(rendered.includes('TTL 5m')).toBe(true);
  expect(rendered.includes('not reported')).toBe(false);
});

test('a response whose TTL never reaches the transcript stops being rechecked', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  await $.classic.SessionStart({ source: 'startup', session_id: world.sessionId, transcript_path: transcript });
  await step($);
  await clock.advance(60000);
  const checks = enrichments(world);
  expect(checks > 0).toBe(true);
  await clock.advance(60000);
  expect(enrichments(world)).toBe(checks);
  expect(text(await $.ui.render(band())).includes('not reported')).toBe(true);
});

function labelled(on: On, label: (model: string) => string) {
  on('turn.step', async function* ($, e) {
    yield { kind: 'text' as const, index: 0, text: 'answer' };
    return { turnId: e.turnId, index: e.index, answer: 'answer', toolUses: [], stopReason: 'end_turn' as const,
      usage: { model: label(e.model), cache_read_input_tokens: 800, cache_creation_input_tokens: 100, input_tokens: 100, output_tokens: 20 } };
  });
}
async function inFlight($: Engine, model: string, index = 1) {
  const stream = $.turn.step({ turnId: 'same-turn', index, messageCount: 1, model });
  await stream.next();
  const rendered = text(await $.ui.render(band()));
  while (!(await stream.next()).done);
  return rendered;
}

test('a context-window suffix the response label omits is not a model change', async ($, on) => {
  labelled(on, model => model.replace(/\[1m\]$/, ''));
  await setup($, on);
  await step($, { model: 'vendor/main[1m]' });
  const rendered = await inFlight($, 'vendor/main[1m]');
  expect(rendered.includes('model changed')).toBe(false);
  expect(rendered.includes('80%')).toBe(true);
});

test('a gateway that relabels the answering model is not a model change', async ($, on) => {
  labelled(on, () => 'upstream-main-2026-10-01');
  await setup($, on);
  await step($);
  expect((await inFlight($, 'vendor/main')).includes('model changed')).toBe(false);
});

test('a request for a different model marks the last bar stale until usage arrives', async ($, on) => {
  labelled(on, () => 'upstream-main-2026-10-01');
  await setup($, on);
  await step($);
  expect((await inFlight($, 'vendor/other')).includes('model changed · awaiting usage')).toBe(true);
  expect(text(await $.ui.render(band())).includes('model changed')).toBe(false);
});

function colors(node: RenderNode, found: [string, string][] = []): [string, string][] {
  if (typeof node === 'string' || !('props' in node)) return found;
  const color = (node.props as { color?: unknown }).color;
  if (node.type === 'Text' && typeof color === 'string') found.push([text(node), color]);
  if ('children' in node && Array.isArray(node.children)) for (const child of node.children) colors(child, found);
  return found;
}
const colorOf = (node: RenderNode, pattern: RegExp) => colors(node).find(([value]) => pattern.test(value))?.[1];
const upkeep = ($: Engine) => $.ui.press({ plugin: 'agent-router', key: 'agent-cache-upkeep', requestId: 'cache-band' });
function markers(node: RenderNode, found: { glyph: string; color?: string; dim?: boolean }[] = []) {
  if (typeof node === 'string' || !('props' in node)) return found;
  const props = node.props as { color?: string; dimColor?: boolean };
  if (node.type === 'Text' && /^[⬥⬦]$/.test(text(node))) found.push({ glyph: text(node), color: props.color, dim: props.dimColor });
  if ('children' in node && Array.isArray(node.children)) for (const child of node.children) markers(child, found);
  return found;
}
function backgrounds(node: RenderNode, found: string[] = []): string[] {
  if (typeof node === 'string' || !('props' in node)) return found;
  const background = (node.props as { backgroundColor?: string } | undefined)?.backgroundColor;
  if (background) found.push(background);
  if ('children' in node && Array.isArray(node.children)) for (const child of node.children) backgrounds(child, found);
  return found;
}
const mode = async ($: Engine) => button(await $.ui.render(band()), 'agent-cache-upkeep')?.label;
async function cycleTo($: Engine, wanted: string) {
  for (let i = 0; i < 4 && await mode($) !== wanted; i++) await upkeep($);
  expect(await mode($)).toBe(wanted);
}

test('the band shows the hit rate, reported TTL and time left in its colours', async ($, on) => {
  response(on, 144000, 5000, 1000);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 5000, oneHour: 0 };
  await step($);
  let rendered = await $.ui.render(band());
  for (const part of ['96%', 'TTL 5m', 'ETA ~5:00', 'read 144k', 'write 5k', 'new 1k']) expect(text(rendered).includes(part)).toBe(true);
  expect(text(rendered).includes('estimated')).toBe(false);
  expect(colorOf(rendered, /█/)).toBe(DARK.good);
  expect(colorOf(rendered, /96%/)).toBe(DARK.good);
  expect(colorOf(rendered, /ETA/)).toBe(DARK.good);
  await clock.advance(180000);
  expect(colorOf(await $.ui.render(band()), /ETA/)).toBe(DARK.fair);
  await clock.advance(91000);
  expect(colorOf(await $.ui.render(band()), /ETA/)).toBe(DARK.poor);
  await clock.advance(30000);
  rendered = await $.ui.render(band());
  expect(text(rendered).includes('ETA')).toBe(false);
  expect(colorOf(rendered, /expired/)).toBe(DARK.poor);
});

test('a hit rate that is fine on a small context is graded poor on a large one', async ($, on) => {
  response(on, 891000, 98000, 1000);
  await setup($, on);
  await step($);
  const rendered = await $.ui.render(band());
  expect(text(rendered).includes('90%')).toBe(true);
  expect(colorOf(rendered, /90%/)).toBe(DARK.poor);
});

test('a small context with the same hit rate is graded good', async ($, on) => {
  response(on, 9000, 900, 100);
  await setup($, on);
  await step($);
  expect(colorOf(await $.ui.render(band()), /90%/)).toBe(DARK.good);
});

test('a read-only request keeps the reported TTL and a request in flight restarts the countdown', async ($, on) => {
  const usage = { read: 800, write: 100 };
  on('turn.step', async function* ($, e) {
    yield { kind: 'text' as const, index: 0, text: 'answer' };
    return { turnId: e.turnId, index: e.index, answer: 'answer', toolUses: [], stopReason: 'end_turn' as const,
      usage: { model: e.model, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write, input_tokens: 100, output_tokens: 20 } };
  });
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await step($);
  Object.assign(usage, { read: 900, write: 0 });
  await clock.advance(200000);
  await step($, { index: 1 });
  await clock.advance(100000);
  const shown = text(await $.ui.render(band()));
  expect(shown.includes('TTL 5m')).toBe(true);
  expect(shown.includes('ETA ~3:20')).toBe(true);
  expect((await inFlight($, 'vendor/main', 2)).includes('ETA ~5:00')).toBe(true);
});

test('the upkeep button cycles off, warm, compact and warmcomp and keeps the choice for the session', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  expect(await mode($)).toBe('off');
  for (const next of ['warm', 'compact', 'warmcomp', 'off', 'warm']) {
    await upkeep($);
    expect(await mode($)).toBe(next);
  }
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(await mode($)).toBe('warm');
  world.sessionId = 'another-session';
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(await mode($)).toBe('off');
});

function button(node: RenderNode, key: string): { label?: string; plain?: boolean } | undefined {
  if (typeof node === 'string') return undefined;
  if (node.type === 'Button' && node.props.key === key) return node.props;
  if ('children' in node && Array.isArray(node.children)) for (const child of node.children) {
    const found = button(child, key);
    if (found) return found;
  }
  return undefined;
}
const dial = async ($: Engine, agentId?: string) => button(await $.ui.render(band(agentId)), 'agent-cache-open')?.label;

test('the band opens with a bordered dial and the bare upkeep mode', async ($, on) => {
  response(on);
  await setup($, on);
  await step($);
  const rendered = await $.ui.render(band());
  const shown = text(rendered);
  expect(shown.includes('Cache')).toBe(false);
  expect(shown.includes('ttl')).toBe(false);
  expect(/◌ ⬦ off TTL 5m █{8} ░{2}\s+80%/.test(shown)).toBe(true);
  expect(button(rendered, 'agent-cache-open')?.plain).toBe(undefined);
  await $.ui.press({ plugin: 'agent-router', key: 'agent-cache-open', requestId: 'cache-band' });
  expect(text(await $.ui.render(pane)).includes('Prompt cache')).toBe(true);
});

test('each upkeep mode has its own marker colour, none used elsewhere in the band', async ($, on) => {
  response(on, 144000, 5000, 1000);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 5000, oneHour: 0 };
  await step($);
  const seen: Record<string, { glyph: string; color?: string; dim?: boolean }[]> = {};
  const others = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const rendered = await $.ui.render(band());
    const marks = markers(rendered);
    seen[(await mode($))!] = marks;
    const own = new Set(marks.map(mark => mark.color));
    for (const [, color] of colors(rendered)) if (!own.has(color)) others.add(color);
    expect(backgrounds(rendered)).toEqual([]);
    await upkeep($);
    await clock.advance(100000);
  }
  expect(seen.off).toEqual([{ glyph: '⬦', color: undefined, dim: true }]);
  expect(seen.warm.map(mark => mark.color)).toEqual([DARK.warm]);
  expect(seen.compact.map(mark => mark.color)).toEqual([DARK.compact]);
  expect(seen.warmcomp.map(mark => mark.color)).toEqual([DARK.warm, DARK.compact]);
  expect(others.has(DARK.warm) || others.has(DARK.compact)).toBe(false);
});

test('a light theme draws every colour from the light palette', async ($, on) => {
  response(on, 144000, 5000, 1000);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 5000, oneHour: 0 };
  world.theme = 'light-daltonized';
  await clock.advance(5000);
  await step($);
  await cycleTo($, 'warm');
  const rendered = await $.ui.render(band());
  expect(colorOf(rendered, /96%/)).toBe(CACHE_COLORS.light.good);
  expect(colorOf(rendered, /ETA/)).toBe(CACHE_COLORS.light.good);
  expect(markers(rendered).map(mark => mark.color)).toEqual([CACHE_COLORS.light.warm]);
});

test('a cache rewritten while it was still warm is labelled a prefix change', async ($, on) => {
  const usage = { read: 300000, write: 5000, fresh: 2 };
  on('turn.step', async function* ($, e) {
    yield { kind: 'text' as const, index: 0, text: 'answer' };
    return { turnId: e.turnId, index: e.index, answer: 'answer', toolUses: [], stopReason: 'end_turn' as const,
      usage: { model: e.model, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write, input_tokens: usage.fresh, output_tokens: 20 } };
  });
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 5000, oneHour: 0 };
  await step($);
  Object.assign(usage, { read: 48648, write: 257000 });
  world.reported = { fiveMinute: 257000, oneHour: 0 };
  await clock.advance(26000);
  await step($, { index: 1 });
  expect(text(await $.ui.render(band())).includes('prefix changed')).toBe(true);
  Object.assign(usage, { read: 0, write: 306000 });
  world.reported = { fiveMinute: 306000, oneHour: 0 };
  await clock.advance(400000);
  await step($, { index: 2 });
  expect(text(await $.ui.render(band())).includes('expired ·')).toBe(false);
  expect(/\d+%\s+·\s+expired/.test(text(await $.ui.render(band())))).toBe(true);
  const contents = await dashboard($);
  expect(contents.includes('prefix changed')).toBe(true);
});

test('nothing is the default upkeep and sends no request', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await step($);
  await clock.advance(400000);
  expect(world.forks.length).toBe(0);
  expect(world.compactions.length).toBe(0);
});

test('warm mode forks the main conversation shortly before its reported TTL ends', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(260000);
  expect(world.forks.length).toBe(0);
  await clock.advance(15000);
  expect(world.forks.length).toBe(1);
  const keepalive = world.samples.find(sample => sample.turnId.startsWith('keepalive:'));
  expect(keepalive?.read).toBe(900);
  expect(keepalive?.agentId).toBe(null);
  const shown = text(await $.ui.render(band()));
  expect(shown.includes('80%')).toBe(true);
  expect(shown.includes('ETA ~4:55')).toBe(true);
  expect((await dashboard($)).includes('keepalive')).toBe(true);
});

test('warming stops once more keepalives would cost more than rewriting the cache', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'warm');
  await step($);
  for (let i = 0; i < 15; i++) await clock.advance(270000);
  expect(world.forks.length).toBe(9);
  await step($, { index: 1 });
  await clock.advance(270000);
  expect(world.forks.length).toBe(10);
});

test('warm mode leaves a request in flight to refresh the cache itself', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'warm');
  await step($);
  const stream = $.turn.step({ turnId: 'same-turn', index: 1, messageCount: 1, model: 'vendor/main' });
  await stream.next();
  await clock.advance(290000);
  expect(world.forks.length).toBe(0);
  while (!(await stream.next()).done);
});

test('compaction waits for a response to finish, then still runs before the cache expires', async ($, on) => {
  response(on, 120000, 1000, 100);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 1000, oneHour: 0 };
  await cycleTo($, 'compact');
  await step($);
  const stream = $.turn.step({ turnId: 'same-turn', index: 1, messageCount: 1, model: 'vendor/main' });
  await stream.next();
  await clock.advance(285000);
  expect(world.compactions.length).toBe(0);
  expect(world.forks.length).toBe(0);
  while (!(await stream.next()).done);
  await clock.advance(2000);
  expect(world.compactions).toEqual(['default']);
});

test('compact mode compacts a large idle conversation once, then marks it compacted', async ($, on) => {
  response(on, 120000, 1000, 100);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 1000, oneHour: 0 };
  world.compaction = { tokensBefore: 121100, tokensAfter: 18000,
    usage: { input_tokens: 10, output_tokens: 9000, cache_read_input_tokens: 121000, cache_creation_input_tokens: 0 } };
  await cycleTo($, 'compact');
  await step($);
  await clock.advance(260000);
  expect(world.compactions.length).toBe(0);
  await clock.advance(15000);
  expect(world.compactions).toEqual(['default']);
  expect(world.forks.length).toBe(0);
  const shown = text(await $.ui.render(band()));
  expect(shown.includes('cmpt ✓ 121.1k → 18k')).toBe(true);
  expect(shown.includes('99%')).toBe(true);
  expect(await dial($)).toBe('◌');
  await clock.advance(400000);
  expect(world.compactions.length).toBe(1);
  expect((await dashboard($)).includes('compaction')).toBe(true);
  await step($, { index: 1 });
  expect(text(await $.ui.render(band())).includes('cmpt')).toBe(false);
});

test('warmcomp keeps the cache warm while that pays, then compacts before it expires', async ($, on) => {
  response(on, 120000, 1000, 100);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 1000, oneHour: 0 };
  world.forkUsage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 121000, cache_creation_input_tokens: 0 };
  await cycleTo($, 'warmcomp');
  await step($);
  for (let i = 0; i < 11; i++) await clock.advance(270000);
  expect(world.forks.length).toBe(11);
  expect(world.compactions.length).toBe(0);
  await clock.advance(270000);
  expect(world.forks.length).toBe(11);
  expect(world.compactions).toEqual(['default']);
  expect(text(await $.ui.render(band())).includes('cmpt ✓')).toBe(true);
  for (let i = 0; i < 4; i++) await clock.advance(270000);
  expect(world.forks.length).toBe(11);
  expect(world.compactions.length).toBe(1);
});

test('warmcomp lets a small conversation expire after warming', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'warmcomp');
  await step($);
  for (let i = 0; i < 15; i++) await clock.advance(270000);
  expect(world.forks.length).toBe(9);
  expect(world.compactions.length).toBe(0);
});

test('compact mode leaves a small conversation alone', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'compact');
  await step($);
  await clock.advance(400000);
  expect(world.compactions.length).toBe(0);
});

test('a headless run checks the transcript once more as its session ends', async ($, on) => {
  response(on);
  on('session.end', ($, e) => ({ sessionId: e.sessionId }));
  const { world } = await setup($, on);
  await $.classic.SessionStart({ source: 'startup', session_id: world.sessionId, transcript_path: transcript });
  await step($);
  await $.classic.Stop({ stop_hook_active: false, session_id: world.sessionId, transcript_path: transcript });
  world.flushed = { fiveMinute: 100, oneHour: 0 };
  await $.session.end({ reason: 'other', sessionId: world.sessionId, resume: { id: world.sessionId } });
  expect(world.samples[0].cacheCreation).toEqual({ fiveMinute: 100, oneHour: 0 });
});

test('the dial empties a quarter at a time and refills when a request is dispatched', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await step($);
  expect(await dial($)).toBe('●');
  for (const glyph of ['◕', '◑', '◔', '○']) {
    await clock.advance(75000);
    expect(await dial($)).toBe(glyph);
  }
  const stream = $.turn.step({ turnId: 'same-turn', index: 1, messageCount: 1, model: 'vendor/main' });
  await stream.next();
  expect(await dial($)).toBe('●');
  while (!(await stream.next()).done);
});

test('the band and dashboard dial follow each agent', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await step($);
  world.roster = [{ id: 'child', type: 'agent-router:scout', description: 'Search', status: 'running' }];
  await clock.advance(150000);
  world.reported = undefined;
  await step($, { agentId: 'child' });
  expect(await dial($)).toBe('◑');
  expect(await dial($, 'child')).toBe('◌');
  const contents = await dashboard($);
  expect(/Main ◑\s+⬦\s+off\s+TTL 5m\s+█/.test(contents)).toBe(true);
  expect(/\(child\)\s+◌\s+–\s+TTL 5m\s+█/.test(contents)).toBe(true);
});

test('keepalives are priced from the models.dev listing matched to the model', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(2000);
  expect(world.priceLookups).toEqual([['vendor/main']]);
  expect((await dashboard($)).includes('priced by models.dev (example/main-1)')).toBe(true);
  await step($, { index: 1 });
  await clock.advance(2000);
  expect(world.priceLookups.length).toBe(1);
});

test('a model models.dev does not list gets no keepalives, and warmcomp compacts instead', async ($, on) => {
  response(on, 120000, 1000, 100);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 1000, oneHour: 0 };
  world.prices = {};
  await cycleTo($, 'warm');
  await step($, { model: 'gateway/alias-code' });
  await clock.advance(400000);
  expect(world.forks.length).toBe(0);
  expect(world.logs.some(log => log.includes('no price found for gateway/alias-code'))).toBe(true);
  expect((await dashboard($)).includes('no price found')).toBe(true);
  await cycleTo($, 'warmcomp');
  await step($, { model: 'gateway/alias-code', index: 1 });
  await clock.advance(280000);
  expect(world.forks.length).toBe(0);
  expect(world.compactions).toEqual(['default']);
});

test('upkeep waits for a price lookup rather than deciding without one', async ($, on) => {
  response(on, 120000, 1000, 100);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 1000, oneHour: 0 };
  await cycleTo($, 'warmcomp');
  world.pricesFail = true;
  await step($);
  await clock.advance(280000);
  expect(world.forks.length).toBe(0);
  expect(world.compactions).toEqual(['default']);
  expect(world.priceLookups.length > 1).toBe(true);
});

test('warm mode shows how many keepalives are left before warming stops', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(2000);
  expect(text(await $.ui.render(band())).includes('· ↻11 ·')).toBe(true);
  await clock.advance(273000);
  expect(world.forks.length).toBe(1);
  expect(text(await $.ui.render(band())).includes('· ↻8 ·')).toBe(true);
  expect((await dashboard($)).includes('1 keepalive since the last request · 8 keepalives left')).toBe(true);
  expect(text(await $.ui.render(band('child'))).includes('↻')).toBe(false);
});

test('warmcomp counts down the keepalives left before it compacts', async ($, on) => {
  response(on, 120000, 1000, 100);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 1000, oneHour: 0 };
  world.forkUsage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 121000, cache_creation_input_tokens: 0 };
  await cycleTo($, 'warmcomp');
  await step($);
  await clock.advance(2000);
  expect(text(await $.ui.render(band())).includes('· ↻11 ➜ cmpt ·')).toBe(true);
  for (let i = 0; i < 11; i++) await clock.advance(270000);
  expect(world.forks.length).toBe(11);
  expect(text(await $.ui.render(band())).includes('· ➜ cmpt ·')).toBe(true);
  expect((await dashboard($)).includes('compact next')).toBe(true);
});

test('modes that send no keepalives show no count', async ($, on) => {
  response(on, 120000, 1000, 100);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 1000, oneHour: 0 };
  await step($);
  await clock.advance(2000);
  expect(text(await $.ui.render(band())).includes('↻')).toBe(false);
  await cycleTo($, 'compact');
  await clock.advance(2000);
  expect(text(await $.ui.render(band())).includes('↻')).toBe(false);
  expect(text(await $.ui.render(band())).includes('➜')).toBe(false);
});

function keys(node: RenderNode, prefix: string, found: string[] = []): string[] {
  if (typeof node === 'string') return found;
  if (node.type === 'Button' && typeof node.props.key === 'string' && node.props.key.startsWith(prefix)) found.push(node.props.key);
  if ('children' in node && Array.isArray(node.children)) for (const child of node.children) keys(child, prefix, found);
  return found;
}
const press = ($: Engine, key: string) => $.ui.press({ plugin: 'agent-router', key, requestId: 'agent-cache' });

test('viewing an agent that cannot be warmed shows a dash in place of the mode button', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  await cycleTo($, 'warm');
  await step($);
  world.roster = [{ id: 'child', type: 'agent-router:scout', description: 'Search', status: 'running' }];
  await step($, { agentId: 'child' });
  const child = await $.ui.render(band('child'));
  expect(button(child, 'agent-cache-upkeep')).toBe(undefined);
  expect(/◌ – TTL 5m █/.test(text(child))).toBe(true);
  expect(button(await $.ui.render(band()), 'agent-cache-upkeep')?.label).toBe('warm');
});

test('the dashboard draws every agent as a tree with its kind and upkeep mode', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, undefined, { 'cache-upkeep': [['pane-session', 'warm']] });
  world.reported = { fiveMinute: 100, oneHour: 0 };
  world.roster = [
    { id: 'scout1', type: 'agent-router:scout', description: 'Search', status: 'running' },
    { id: 'nested1', type: 'agent-router:task', description: 'Dig', status: 'running', parentId: 'scout1' },
    { id: 'mate1', type: 'teammate', description: 'Probe', status: 'running', name: 'probe' },
  ];
  await step($);
  for (const agentId of ['scout1', 'nested1', 'mate1']) await step($, { agentId });
  const now = clock.now();
  const linked = (agentId: string | null, index: number) => applyCacheCreation({ sessionId: 'pane-session', agentId, turnId: 'pane-turn', index, model: 'vendor/main',
    startedAt: now, completedAt: now, read: 800, write: 100, fresh: 100, output: 20, ttlMs: null, ttlSource: 'response cache_creation', disabled: false },
    { fiveMinute: 100, oneHour: 0 });
  world.linked = [linked(null, 0), linked('pane-sub', 1)];
  world.labels = [[loopKey('pane-session', null), 'Worker (worker@team)']];
  await clock.advance(5000);
  const contents = await dashboard($);
  const order = ['Main', 'agent-router:scout (scout1)', 'agent-router:task (nested1)', 'probe (mate1)', 'Worker (worker@team)', 'pane-sub'].map(label => contents.indexOf(label));
  expect(order.every(index => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(/├─\s+agent-router:scout \(scout1\)/.test(contents)).toBe(true);
  expect(/│\s+└─\s+agent-router:task \(nested1\)/.test(contents)).toBe(true);
  expect(contents.includes('probe (mate1) · in-process teammate')).toBe(true);
  expect(contents.includes('Worker (worker@team) · split-pane teammate')).toBe(true);
  expect(/Main\s+●\s+⬦\s+off/.test(contents)).toBe(true);
  expect(/Worker \(worker@team\) · split-pane teammate\s+●\s+⬥\s+warm/.test(contents)).toBe(true);
  expect(/\(scout1\)\s+│?\s+●\s+–\s+TTL 5m\s+█/.test(contents)).toBe(true);
  expect(contents.includes('– can\'t be kept warm')).toBe(true);
  const lines = treeLines(await $.ui.render(pane));
  const scout = lines.findIndex(line => line.includes('(scout1)'));
  expect(lines[scout + 1].startsWith('│  ')).toBe(true);
});

function treeLines(node: RenderNode): string[] {
  if (typeof node === 'string') return [node];
  if (node.type === 'Button') return [node.props.plain ? node.props.label ?? '' : `[ ${node.props.label} ]`];
  const kids = ('children' in node && Array.isArray(node.children) ? node.children : []).map(treeLines);
  if (node.type === 'Text') return [kids.map(kid => kid.join('')).join('')];
  const props = ('props' in node ? node.props : {}) as { flexDirection?: string; gap?: number };
  return props.flexDirection === 'column' ? kids.flat() : [kids.map(kid => kid.join('')).join(' '.repeat(props.gap ?? 0))];
}

test('the dashboard filters agents by kind and requests by type, across all agents', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(275000);
  expect(world.forks.length).toBe(1);
  world.roster = [{ id: 'child', type: 'agent-router:scout', description: 'Search', status: 'running' }];
  await step($, { agentId: 'child', turnId: 'child-turn' });
  await dashboard($);
  let drawn = await $.ui.render(pane);
  expect(keys(drawn, 'cache-agent:').length).toBe(2);
  await press($, 'cache-agents:subagents');
  drawn = await $.ui.render(pane);
  expect(keys(drawn, 'cache-agent:')).toEqual([`cache-agent:${loopKey('cache-session', 'child')}`]);
  await press($, 'cache-agents:all');
  await press($, 'cache-requests:keepalives');
  drawn = await $.ui.render(pane);
  expect(text(drawn).includes('keepalive ')).toBe(true);
  expect(text(drawn).includes('same-turn:0')).toBe(false);
  await press($, 'cache-requests:all');
  await press($, 'cache-history:all');
  drawn = await $.ui.render(pane);
  expect(text(drawn).includes('Recent requests · all agents')).toBe(true);
  expect(text(drawn).includes('child-turn:0')).toBe(true);
  expect(text(drawn).includes('same-turn:0')).toBe(true);
  await press($, 'cache-requests:misses');
  expect(text(await $.ui.render(pane)).includes('No requests match')).toBe(true);
});

test('only the main conversation names the keepalive prices it is warmed at', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(2000);
  const now = clock.now();
  world.linked = [applyCacheCreation({ sessionId: 'pane-session', agentId: null, turnId: 'pane-turn', index: 0, model: 'vendor/main',
    startedAt: now, completedAt: now, read: 800, write: 100, fresh: 100, output: 20, ttlMs: null, ttlSource: 'response cache_creation', disabled: false },
    { fiveMinute: 100, oneHour: 0 })];
  await dashboard($);
  const lines = treeLines(await $.ui.render(pane));
  expect(lines.filter(line => line.includes('vendor/main · response')).length).toBe(2);
  expect(lines.filter(line => line.includes('priced by')).length).toBe(1);
});

const intro = (world: { logs: string[] }) => world.logs.filter(log => log.startsWith('Prompt cache'));

test('the first session with the cache bar shows a short intro, once', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  const lines = intro(world);
  expect(lines.length).toBe(1);
  const all = world.logs.slice(world.logs.indexOf(lines[0])).filter(log => !log.startsWith('Agent Router'));
  const words = all.join(' ').split(/\s+/).filter(Boolean).length;
  expect(words <= 220).toBe(true);
  for (const part of ['/agent-cache', 'off', 'warm', 'compact', 'warmcomp', '/agent-models']) expect(all.join(' ').includes(part)).toBe(true);
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  world.sessionId = 'another-session';
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(intro(world).length).toBe(1);
});

test('a returning user does not see the intro', async ($, on) => {
  response(on);
  const { world } = await setup($, on, undefined, { 'cache-intro': 1 });
  expect(intro(world).length).toBe(0);
});

test('the intro is never sent to the model', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  expect(intro(world).length).toBe(1);
  expect(world.calls.some(call => JSON.stringify(call).includes('Prompt cache'))).toBe(false);
});

const ttlButton = async ($: Engine, agentId?: string) => button(await $.ui.render(band(agentId)), 'agent-cache-ttl')?.label;
const pressTtl = async ($: Engine, agentId?: string) => {
  await $.ui.render(band(agentId));
  await $.ui.press({ plugin: 'agent-router', key: 'agent-cache-ttl', requestId: 'cache-band' });
};
const seen = (at: string, agentId: string | null) => ttlSeen.filter(entry => entry.at === at && entry.agentId === agentId).map(entry => entry.value);

test('the TTL button shows what Claude Code would use before any request is sent', async ($, on) => {
  response(on);
  await setup($, on);
  expect(await ttlButton($)).toBe('TTL 5m');
  expect((await dashboard($)).includes('TTL 5m · Claude Code default for API keys and gateways')).toBe(true);
});

test('Claude Code settings and a subscription change the default the button shows', async ($, on) => {
  response(on);
  await setup($, on, undefined, undefined, { settings: { promptCacheTtl: '1h' } });
  expect(await ttlButton($)).toBe('TTL 1h');
  expect((await dashboard($)).includes('TTL 1h · promptCacheTtl in your Claude Code settings')).toBe(true);
});

test('a Claude subscription defaults the main conversation to 1h and its subagents to 5m', async ($, on) => {
  response(on);
  const { world } = await setup($, on, '', undefined, { auth: 'bearer' });
  world.roster = [{ id: 'child', type: 'agent-router:scout', description: 'Search', status: 'running' }];
  await step($, { agentId: 'child' });
  expect(await ttlButton($)).toBe('TTL 1h');
  expect(await ttlButton($, 'child')).toBe('TTL 5m');
});

test('switching the main conversation TTL never reaches its subagents', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  world.roster = [{ id: 'child', type: 'agent-router:scout', description: 'Search', status: 'running' }];
  await pressTtl($);
  expect(await ttlButton($)).toBe('TTL 1h');
  expect(world.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h');
  await step($);
  await step($, { agentId: 'child' });
  expect(seen('step', null)).toEqual(['1h']);
  expect(seen('step', 'child')).toEqual([undefined]);
  expect(world.samples.find(sample => sample.agentId === null)?.requested).toBe('1h');
  expect(await ttlButton($, 'child')).toBe('TTL 5m');
  await pressTtl($);
  expect(await ttlButton($)).toBe('TTL 5m');
  expect(world.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe(undefined);
});

test('a subagent keeps its own TTL, carried only by its own requests', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  world.roster = [{ id: 'child', type: 'agent-router:scout', description: 'Search', status: 'running' },
    { id: 'other', type: 'agent-router:task', description: 'Other', status: 'running' }];
  await pressTtl($, 'child');
  expect(await ttlButton($, 'child')).toBe('TTL 1h');
  expect(await ttlButton($, 'other')).toBe('TTL 5m');
  expect(await ttlButton($)).toBe('TTL 5m');
  await step($, { agentId: 'child' });
  await step($, { agentId: 'other' });
  await step($);
  expect(seen('step', 'child')).toEqual(['1h']);
  expect(seen('step', 'other')).toEqual([undefined]);
  expect(seen('step', null)).toEqual([undefined]);
  expect(world.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL).toBe(undefined);
  expect(world.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe(undefined);
});

test('in-process teammates start in the teammate TTL setting, subagents in the subagent one', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  world.roster = [{ id: 'mate', type: 'teammate', description: 'Probe', status: 'running', name: 'probe' },
    { id: 'child', type: 'agent-router:scout', description: 'Search', status: 'running' }];
  expect(await ttlButton($, 'mate')).toBe('TTL 1h');
  expect(await ttlButton($, 'child')).toBe('TTL 5m');
  await step($, { agentId: 'mate' });
  await step($, { agentId: 'child' });
  expect(seen('step', 'mate')).toEqual(['1h']);
  expect(seen('step', 'child')).toEqual([undefined]);
  expect((await dashboard($)).includes('TTL 1h · teammate TTL in /agent-models')).toBe(true);
});

test('keepalives and compaction use the main conversation TTL, and a different reported TTL shows', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await pressTtl($);
  await cycleTo($, 'warm');
  await step($);
  expect(/TTL 1h\s+█+\s*░+\s+80%\s+· 5m reported/.test(text(await $.ui.render(band())))).toBe(true);
  await clock.advance(275000);
  expect(world.forks.length).toBe(1);
  expect(seen('keepalive', null)).toEqual(['1h']);
  expect(world.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL).toBe(undefined);
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'assistant', text: 'Summary', toolUses: [] }] });
  expect(seen('compaction', null)).toEqual(['1h']);
  expect(world.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL).toBe(undefined);
});

test('a TTL choice lasts for its own conversation across a reload, and a new session starts from the defaults', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  world.roster = [{ id: 'child', type: 'agent-router:scout', description: 'Search', status: 'running' }];
  await pressTtl($, 'child');
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(await ttlButton($, 'child')).toBe('TTL 1h');
  expect(await ttlButton($)).toBe('TTL 5m');
  world.sessionId = 'another-session';
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(await ttlButton($, 'child')).toBe('TTL 5m');
});

test('a variable you set yourself stays the default, and switching back restores it', async ($, on) => {
  response(on);
  const { world } = await setup($, on, undefined, undefined, { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } });
  expect(await ttlButton($)).toBe('TTL 1h');
  await pressTtl($);
  expect(world.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m');
  await pressTtl($);
  expect(world.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h');
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(await ttlButton($)).toBe('TTL 1h');
});

test('FORCE_PROMPT_CACHING_5M locks every TTL at 5m', async ($, on) => {
  response(on);
  const { world } = await setup($, on, undefined, undefined, { env: { FORCE_PROMPT_CACHING_5M: '1' } });
  world.roster = [{ id: 'mate', type: 'teammate', description: 'Probe', status: 'running', name: 'probe' }];
  const rendered = await $.ui.render(band());
  expect(button(rendered, 'agent-cache-ttl')).toBe(undefined);
  expect(text(rendered).includes('TTL 5m')).toBe(true);
  await step($, { agentId: 'mate' });
  expect(seen('step', 'mate')).toEqual([undefined]);
  expect((await dashboard($)).includes('TTL 5m · FORCE_PROMPT_CACHING_5M')).toBe(true);
});

test('a session that cannot set environment variables still routes and draws the bar', async ($, on) => {
  response(on);
  const { world } = await setup($, on, undefined, undefined, { settings: { promptCacheTtl: '1h' }, refuseEnv: true });
  await pressTtl($);
  await step($);
  expect(world.samples.length).toBe(1);
  expect(world.logs.some(log => log.includes('cache TTL could not be applied'))).toBe(true);
  expect(world.logs.some(log => log.includes('cache observation could not be saved'))).toBe(false);
});

test('the dashboard names Anthropic pricing for a Claude model', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  world.prices['claude-opus-5-5'] = { read: 0.05, fiveMinute: 1.25, oneHour: 2, output: 5, provider: 'anthropic', id: 'claude-opus-5-5', source: 'Anthropic pricing' };
  await cycleTo($, 'warm');
  await step($, { model: 'claude-opus-5-5' });
  await clock.advance(2000);
  expect((await dashboard($)).includes('priced by Anthropic pricing (claude-opus-5-5)')).toBe(true);
});
