import { test, expect, mock, tier } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { AgentInfo, On, RenderInput, RenderNode, TurnStepInput } from 'claude-code';
import { applyCacheCreation, loopKey } from '../lib/cache.js';
import { CACHE_COLORS } from '../lib/cache-colors.js';

tier('user');
const DARK = CACHE_COLORS.dark;

const pane: RenderInput<'Pane', 'terminal'> = { component: 'Pane', surface: 'terminal', requestId: 'keepalive',
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
  extra: { settings?: Record<string, unknown>; env?: Record<string, string>; auth?: 'bearer' | 'api-key'; refuseEnv?: boolean;
    teammate?: { agentId: string; agentName?: string; parentSessionId: string }; handover?: Record<string, unknown>; broken?: string[] } = {}) {
  const faults = new Set(extra.broken);
  if (faults.has('store')) for (const name of ['store.get', 'store.set'] as const) on(name, () => { throw new Error('store offline'); });
  else mock.store(on, stored);
  ttlSeen.length = 0;
  const env: Record<string, string | undefined> = { ...(endpoint ? { ANTHROPIC_BASE_URL: endpoint } : {}), ...extra.env };
  const envSets: [string, string | undefined][] = [];
  liveEnv = env;
  on('env.get', ($, e) => {
    if (faults.has('credentials') && /^ANTHROPIC_(AUTH_TOKEN|API_KEY)$/.test(e.name)) throw new Error('env offline');
    return { value: env[e.name] };
  });
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
    forks: [] as string[], fetches: [] as { url: string; headers?: Record<string, string>; method?: string; body?: string }[], reportStatus: 200, reportFail: false, policy: null as null | Record<string, unknown>[], policyStatus: 200, compactions: [] as string[], theme: 'dark',
    forkUsage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
    compaction: {} as Record<string, unknown>,
    prices: { 'vendor/main': { read: 0.1, fiveMinute: 1.25, output: 5, provider: 'example', id: 'main-1', source: 'models.dev' } } as Record<string, unknown>,
    priceLookups: [] as string[][], pricesFail: false,
    linked: [] as Record<string, any>[], labels: [] as [string, string][], env, envSets,
    teammate: extra.teammate ?? null as null | { agentId: string; agentName?: string; parentSessionId: string }, links: [] as Record<string, any>[],
    routes: null as null | { self: { model: string } | null; agents: { agentId: string; model: string }[] },
    handover: (extra.handover ?? null) as Record<string, unknown> | null, faults,
    before: {} as Partial<Record<'process.run' | 'model.fork' | 'session.compact', (e: any) => unknown>> };
  on('session.id', () => ({ value: world.sessionId }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('settings.read', () => {
    if (faults.has('settings.read')) throw new Error('settings offline');
    return { value: extra.settings ?? {} };
  });
  on('command.register', ($, e) => ({ value: { command: e.name } }));
  on('ui.open', () => ({ value: faults.has('ui.open') ? { isPlaced: false as const, reason: 'terminal too narrow' } : { isPlaced: true as const } }));
  on('ui.close', () => ({ value: undefined }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('ui.log', ($, e) => { world.logs.push(e.text); return { value: undefined }; });
  on('agent.list', () => {
    if (faults.has('agent.list')) throw new Error('roster offline');
    return { value: world.roster };
  });
  on('classic.SessionStart', () => ({}));
  on('classic.Stop', () => ({}));
  on('http.fetch', ($, e) => {
    world.fetches.push({ url: e.url, headers: e.init?.headers, method: e.init?.method, body: e.init?.body as string | undefined });
    if (e.init?.method === 'POST') {
      if (world.reportFail) throw new Error('reports offline');
      return { value: { status: world.reportStatus, ok: world.reportStatus === 200, headers: {}, text: '' } };
    }
    if (!world.policy) throw new Error('policy offline');
    return { value: { status: world.policyStatus, ok: world.policyStatus === 200, headers: {}, text: JSON.stringify({ rows: world.policy, server_now: 1 }) } };
  });
  on('model.fork', async ($, e) => {
    const early = await world.before['model.fork']?.(e);
    if (early) return early as any;
    world.forks.push(e.prompt);
    ttlSeen.push({ at: 'keepalive', agentId: null, value: env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL });
    return { value: { isAnswered: true as const, text: 'OK', usage: world.forkUsage } };
  });
  on('session.compact', async ($, e) => {
    const early = await world.before['session.compact']?.(e);
    if (early) return early as any;
    world.compactions.push('instructions' in e && e.instructions ? e.instructions : 'default');
    ttlSeen.push({ at: 'compaction', agentId: e.agentId ?? null, value: env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL });
    return { messages: [{ role: 'assistant' as const, text: 'Summary', toolUses: [] }], ...world.compaction };
  });
  on('config.list', () => {
    if (faults.has('config.list')) throw new Error('config offline');
    return { value: [{ key: 'theme', label: 'Theme', kind: 'enum', value: world.theme, provider: { plugin: 'engine', tier: 'core' }, isLocked: false }] as any };
  });
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: ['Existing prompt content'] }));
  on('process.run', async ($, e) => {
    const request = JSON.parse(e.init?.stdin || '{}');
    world.calls.push(request);
    const early = await world.before['process.run']?.(request);
    if (early) return early as any;
    if (request.action === 'cache-sample') {
      if (world.failSave) return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 1, stderr: 'storage failed', stdout: '' } };
      world.samples.push(world.reported ? applyCacheCreation(request.sample, world.reported) : request.sample);
    }
    if (request.action === 'cache-enrich') {
      const enriched = [];
      for (const [i, s] of world.samples.entries()) {
        if (!world.flushed || s.sessionId !== request.session_id || s.agentId !== (request.agent_id ?? null) || s.cacheCreation || !s.write) continue;
        world.samples[i] = applyCacheCreation(s, world.flushed);
        enriched.push(world.samples[i]);
      }
      return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 0, stderr: '', stdout: JSON.stringify({ samples: enriched }) } };
    }
    if (request.action === 'cache-prices') {
      world.priceLookups.push(request.models);
      if (world.pricesFail) return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 1, stderr: 'offline', stdout: '' } };
      const prices = Object.fromEntries(request.models.map((model: string) => [model, world.prices[model] ?? null]));
      return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 0, stderr: '', stdout: JSON.stringify({ catalog: 'fresh', prices }) } };
    }
    if (request.action === 'cache-reset') world.resets.push({ sessionId: request.session_id, agentId: request.agent_id ?? null, resetAt: request.reset_at });
    if (request.action === 'cache-snapshot' && world.failRead) return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 1, stderr: 'storage failed', stdout: '' } };
    if (request.action === 'identity') return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 0, stderr: '', stdout: JSON.stringify({ teammate: world.teammate }) } };
    if (request.action === 'link') world.links.push(request);
    if (request.action === 'migrate') return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 0, stderr: '', stdout: JSON.stringify({ migrated: false, handover: world.handover }) } };
    const output = request.action === 'cache-sample' ? { sample: world.samples.at(-1) }
      : request.action === 'cache-snapshot' ? { samples: [...world.samples.filter(s => s.sessionId === request.session_id), ...world.linked], resets: world.resets, labels: world.labels, routes: world.routes }
      : {};
    return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 0, stderr: '', stdout: JSON.stringify(output) } };
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
  await $.command.run({ command: 'keepalive', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } });
  return text(await $.ui.render(pane));
}

test('main and child cache bars remain distinct and native stream and response survive observation', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  const main = await step($, { model: 'claude-main' });
  expect(main.chunks).toEqual([{ kind: 'text', index: 0, text: 'PRIVATE_ANSWER' }]);
  expect(main.result.answer).toBe('PRIVATE_ANSWER');
  await step($, { model: 'claude-main', index: 1 });
  world.roster = [{ id: 'child', type: 'agent-router:scout', description: 'Search', status: 'running' }];
  await step($, { agentId: 'child', model: 'vendor/scout' });
  expect(world.samples.length).toBe(3);
  expect(world.samples[2].model).toBe('vendor/scout');
  expect(JSON.stringify(world.samples).includes('PRIVATE')).toBe(false);
  const contents = await dashboard($);
  expect(contents.includes('2 requests')).toBe(true);
  expect(contents.includes('1 request ')).toBe(true);
  expect(contents.includes('child')).toBe(true);
  expect(contents.includes('80%')).toBe(true);
  expect(contents.includes('awaiting report')).toBe(true);
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
  await $.ui.press({ plugin: 'keepalive', key: 'agent-cache-close', requestId: 'keepalive' });
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
  world.flushed = { fiveMinute: 100, oneHour: 0 };
  await clock.advance(1000);
  expect(world.samples[0].cacheCreation).toEqual({ fiveMinute: 100, oneHour: 0 });
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

test('a gateway model that never reports its TTL never shows a made-up countdown, while a Claude model awaiting its report does', async ($, on) => {
  response(on);
  const { clock } = await setup($, on);
  await step($, { model: 'gateway/alias-code[1m]' });
  let shown = text(await $.ui.render(band()));
  expect(shown.includes('ETA')).toBe(false);
  expect(shown.includes('not reported')).toBe(true);
  await clock.advance(31000);
  await step($, { model: 'gateway/alias-code[1m]', index: 1 });
  shown = text(await $.ui.render(band()));
  expect(shown.includes('not reported')).toBe(true);
  expect(shown.includes('ETA')).toBe(false);
  await step($, { model: 'claude-main', index: 2 });
  expect(text(await $.ui.render(band())).includes('ETA ~5:00')).toBe(true);
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
const upkeep = ($: Engine) => $.ui.press({ plugin: 'keepalive', key: 'agent-cache-upkeep', requestId: 'cache-band' });
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

test('each session\'s main conversation starts in the cache upkeep setting until its mode button changes it', { options: { cache_upkeep: 'compact' } }, async ($, on) => {
  response(on, 150000);
  const { world, clock } = await setup($, on);
  expect(await mode($)).toBe('compact');
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await step($);
  await clock.advance(275000);
  expect(world.compactions.length).toBe(1);
  await upkeep($);
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(await mode($)).toBe('warmcomp');
  world.sessionId = 'another-session';
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(await mode($)).toBe('compact');
});

test('a teammate upkeep saved under Agent Router that names no mode starts the teammate in off', async ($, on) => {
  response(on);
  await setup($, on, undefined, undefined, { teammate: { agentId: 'worker@team', agentName: 'worker', parentSessionId: 'lead-session' },
    settings: { pluginConfigs: { 'agent-router@agent-router-tools': { options: { teammate_cache_upkeep: 'always' } } } } });
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
  await step($, { model: 'claude-main' });
  const rendered = await $.ui.render(band());
  const shown = text(rendered);
  expect(shown.includes('Cache')).toBe(false);
  expect(shown.includes('ttl')).toBe(false);
  expect(/● ⬦ off TTL 5m █{8} ░{2}\s+80%/.test(shown)).toBe(true);
  expect(button(rendered, 'agent-cache-open')?.plain).toBe(undefined);
  await $.ui.press({ plugin: 'keepalive', key: 'agent-cache-open', requestId: 'cache-band' });
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
  expect(button(await $.ui.render(band()), 'agent-cache-misses')?.label).toBe('1 prefix');
  Object.assign(usage, { read: 0, write: 306000 });
  world.reported = { fiveMinute: 306000, oneHour: 0 };
  await clock.advance(400000);
  await step($, { index: 2 });
  expect(button(await $.ui.render(band()), 'agent-cache-misses')?.label).toBe('2 expired·prefix');
  const contents = await dashboard($);
  expect(contents.includes('prefix changed')).toBe(true);
  expect(/same-turn:2\s+\S+\s+0%\s+5m\s+expired\s/.test(contents)).toBe(true);
});

function flatBand(node: RenderNode): string {
  if (typeof node === 'string') return node;
  if (node.type === 'Button') return node.props.label ?? '';
  const kids = 'children' in node && Array.isArray(node.children) ? node.children.map(flatBand) : [];
  return kids.join('props' in node && (node.props as { gap?: number })?.gap ? ' ' : '');
}

function missWorld(on: On) {
  const usage = { read: 300000, write: 5000, fresh: 2 };
  on('turn.step', async function* ($, e) {
    yield { kind: 'text' as const, index: 0, text: 'answer' };
    return { turnId: e.turnId, index: e.index, answer: 'answer', toolUses: [], stopReason: 'end_turn' as const,
      usage: { model: e.model, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write, input_tokens: usage.fresh, output_tokens: 20 } };
  });
  return usage;
}

test('a cache miss leaves a short chip that dims after 5 minutes and clears after 15', async ($, on) => {
  const usage = missWorld(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 5000, oneHour: 0 };
  await step($);
  expect(button(await $.ui.render(band()), 'agent-cache-misses')).toBe(undefined);
  Object.assign(usage, { read: 48648, write: 257000 });
  world.reported = { fiveMinute: 257000, oneHour: 0 };
  await clock.advance(26000);
  await step($, { index: 1 });
  let rendered = await $.ui.render(band());
  expect(button(rendered, 'agent-cache-misses')?.label).toBe('1 prefix');
  expect(colorOf(rendered, /^✕$/)).toBe(DARK.fair);
  expect(text(rendered).includes('prefix changed')).toBe(false);
  expect(flatBand(rendered).includes('% ✕ 1 prefix ·')).toBe(true);
  Object.assign(usage, { read: 305000, write: 0 });
  await clock.advance(200000);
  await step($, { index: 2 });
  await clock.advance(110000);
  rendered = await $.ui.render(band());
  expect((button(rendered, 'agent-cache-misses') as { dimColor?: boolean })?.dimColor).toBe(true);
  expect(colorOf(rendered, /^✕$/)).toBe(undefined);
  await clock.advance(600000);
  expect(button(await $.ui.render(band()), 'agent-cache-misses')).toBe(undefined);
});

test('the miss chip opens the dashboard on the misses, with their causes and how long ago', async ($, on) => {
  const usage = missWorld(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 5000, oneHour: 0 };
  await step($);
  Object.assign(usage, { read: 48648, write: 257000 });
  world.reported = { fiveMinute: 257000, oneHour: 0 };
  await clock.advance(26000);
  await step($, { index: 1 });
  await clock.advance(64000);
  await $.ui.render(band());
  await $.ui.press({ plugin: 'keepalive', key: 'agent-cache-misses', requestId: 'cache-band' });
  const contents = text(await $.ui.render(pane));
  expect(contents.includes('✕ 1 cache miss in the last 15 min: 1 prefix changed · latest 1:04 ago')).toBe(true);
  expect(contents.includes('Recent requests · all agents (last 30 misses)')).toBe(true);
  expect(contents.includes('same-turn:1')).toBe(true);
  expect(contents.includes('same-turn:0')).toBe(false);
});

test('a new write shows the TTL it asked for until the transcript reports one, never a flash of TTL not reported', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  await $.classic.SessionStart({ source: 'startup', session_id: world.sessionId, transcript_path: transcript });
  await $.ui.render(band());
  await $.ui.press({ plugin: 'keepalive', key: 'agent-cache-ttl', requestId: 'cache-band' });
  await step($, { model: 'claude-main' });
  let shown = text(await $.ui.render(band()));
  expect(shown.includes('not reported')).toBe(false);
  expect(shown.includes('ETA ~60:00')).toBe(true);
  expect(await dial($)).toBe('●');
  expect((await dashboard($)).includes('awaiting report')).toBe(true);
  world.flushed = { fiveMinute: 0, oneHour: 100 };
  await clock.advance(1000);
  shown = text(await $.ui.render(band()));
  expect(shown.includes('ETA ~59:59')).toBe(true);
  expect(text(await $.ui.render(pane)).includes('awaiting report')).toBe(false);
  world.flushed = undefined;
  await step($, { model: 'claude-main', index: 1 });
  await clock.advance(29000);
  expect(text(await $.ui.render(band())).includes('not reported')).toBe(false);
  await clock.advance(1000);
  expect(text(await $.ui.render(band())).includes('not reported')).toBe(true);
});

test('recent requests show the TTL each one asked for, and a different one the response reported', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await step($);
  await $.ui.render(band());
  await $.ui.press({ plugin: 'keepalive', key: 'agent-cache-ttl', requestId: 'cache-band' });
  world.reported = { fiveMinute: 0, oneHour: 100 };
  await step($, { index: 1 });
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await step($, { index: 2 });
  const contents = await dashboard($);
  const lines = treeLines(await $.ui.render(pane));
  const ttl = (name: string) => lines.find(line => line.startsWith(name))?.match(/%\s+(\S+(?: \(\S+ reported\))?)/)?.[1];
  expect(ttl('same-turn:0')).toBe('5m');
  expect(ttl('same-turn:1')).toBe('1h');
  expect(ttl('same-turn:2')).toBe('1h (5m reported)');
  expect(lines.some(line => /^request\s+hit\s+TTL\s+miss\s+read\s+write\s+new\s+out\s+model$/.test(line))).toBe(true);
});

test('the bar shows the hit rate over the last 10 requests, not just the last one', async ($, on) => {
  const usage = missWorld(on);
  Object.assign(usage, { read: 0, write: 10000, fresh: 0 });
  const { world } = await setup($, on);
  world.reported = { fiveMinute: 10000, oneHour: 0 };
  await step($);
  expect(text(await $.ui.render(band())).includes(' 0%')).toBe(true);
  Object.assign(usage, { read: 10000, write: 0 });
  for (let i = 1; i <= 3; i++) await step($, { index: i });
  expect(text(await $.ui.render(band())).includes('75%')).toBe(true);
  expect((await dashboard($)).includes('hit rate over the last 4 requests')).toBe(true);
  for (let i = 4; i <= 12; i++) await step($, { index: i });
  expect(text(await $.ui.render(band())).includes('100%')).toBe(true);
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
  await clock.advance(30000);
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

test('warming stops at the keepalive limit, and a real request starts the count again', { options: { keepalive_limit: '3' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(2000);
  expect(text(await $.ui.render(band())).includes('· ↻3 ·')).toBe(true);
  expect((await dashboard($)).includes('up to 3 keepalives after each request, whatever they cost')).toBe(true);
  await clock.advance(273000);
  expect(world.forks.length).toBe(1);
  expect(text(await $.ui.render(band())).includes('· ↻2 ·')).toBe(true);
  for (let i = 0; i < 8; i++) await clock.advance(270000);
  expect(world.forks.length).toBe(3);
  expect(world.logs.some(log => log.includes('keepalive limit of 3'))).toBe(true);
  await step($, { index: 1 });
  await clock.advance(270000);
  expect(world.forks.length).toBe(4);
});

test('warmcomp compacts once the keepalive limit is reached', { options: { keepalive_limit: '2' } }, async ($, on) => {
  response(on, 120000, 1000, 100);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 1000, oneHour: 0 };
  world.forkUsage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 121000, cache_creation_input_tokens: 0 };
  await cycleTo($, 'warmcomp');
  await step($);
  await clock.advance(2000);
  expect(text(await $.ui.render(band())).includes('· ↻2 ➜ cmpt ·')).toBe(true);
  for (let i = 0; i < 4; i++) await clock.advance(270000);
  expect(world.forks.length).toBe(2);
  expect(world.compactions).toEqual(['default']);
});

test('the default keepalive limit leaves warming to the cost rule', { options: { keepalive_limit: 'default' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'warm');
  await step($);
  for (let i = 0; i < 15; i++) await clock.advance(270000);
  expect(world.forks.length).toBe(9);
  expect((await dashboard($)).includes('while keepalives cost less than rewriting the cache')).toBe(true);
});

test('an infinite keepalive limit warms until the next request, and warmcomp never compacts', { options: { keepalive_limit: 'infinite' } }, async ($, on) => {
  response(on, 120000, 1000, 100);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 1000, oneHour: 0 };
  world.forkUsage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 121000, cache_creation_input_tokens: 0 };
  await cycleTo($, 'warmcomp');
  await step($);
  await clock.advance(2000);
  const shown = text(await $.ui.render(band()));
  expect(shown.includes('· ↻∞ ·')).toBe(true);
  expect(shown.includes('cmpt')).toBe(false);
  for (let i = 0; i < 20; i++) await clock.advance(270000);
  expect(world.forks.length).toBe(20);
  expect(world.compactions.length).toBe(0);
  const contents = await dashboard($);
  expect(contents.includes('keepalives until your next request')).toBe(true);
  expect(contents.includes('so it never compacts')).toBe(true);
});

const worker = { agentId: 'worker@team', agentName: 'worker', parentSessionId: 'lead-session' };

test('split-pane teammates warm up to their own keepalive limit, and the main conversation up to its own', { options: { keepalive_limit: '1', teammate_keepalive_limit: '2' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, undefined, undefined, { teammate: worker });
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'warm');
  await step($);
  for (let i = 0; i < 6; i++) await clock.advance(270000);
  expect(world.forks.length).toBe(2);
  world.teammate = null;
  world.sessionId = 'lead-session';
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  await cycleTo($, 'warm');
  await step($, { index: 1 });
  for (let i = 0; i < 6; i++) await clock.advance(270000);
  expect(world.forks.length).toBe(3);
});

test('a teammate keepalive limit of same follows the keepalive limit', { options: { keepalive_limit: '1' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, undefined, undefined, { teammate: worker });
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'warm');
  await step($);
  for (let i = 0; i < 6; i++) await clock.advance(270000);
  expect(world.forks.length).toBe(1);
});

test('the compaction threshold sets the smallest conversation compact and warmcomp compact', { options: { compact_threshold: '40k' } }, async ($, on) => {
  response(on, 45000);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'compact');
  await step($);
  expect((await dashboard($)).includes('compacts an idle main conversation of 40k+ tokens')).toBe(true);
  await clock.advance(275000);
  expect(world.compactions).toEqual(['default']);
});

test('a compaction threshold that is not a number of tokens keeps 100k', { options: { compact_threshold: 'big' } }, async ($, on) => {
  response(on, 45000);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'compact');
  await step($);
  expect((await dashboard($)).includes('compacts an idle main conversation of 100k+ tokens')).toBe(true);
  await clock.advance(275000);
  expect(world.compactions.length).toBe(0);
});

test('a running session keeps the upkeep it started in when the setting changes, off included', async ($, on) => {
  response(on);
  const options: Record<string, string> = { teammate_cache_upkeep: 'off' };
  await setup($, on, undefined, undefined, { teammate: worker, settings: { pluginConfigs: { 'agent-router@agent-router-tools': { options } } } });
  expect(await mode($)).toBe('off');
  options.teammate_cache_upkeep = 'compact';
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(await mode($)).toBe('off');
});

test('a number of keepalives needs no price, so an unpriced model is warmed too', { options: { keepalive_limit: '2' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  world.prices = {};
  await cycleTo($, 'warm');
  await step($, { model: 'gateway/alias-code' });
  for (let i = 0; i < 6; i++) await clock.advance(270000);
  expect(world.forks.length).toBe(2);
  expect(world.priceLookups).toEqual([]);
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
const press = ($: Engine, key: string) => $.ui.press({ plugin: 'keepalive', key, requestId: 'keepalive' });

test('viewing an agent that cannot be warmed shows a dash in place of the mode button', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  await cycleTo($, 'warm');
  await step($, { model: 'claude-main' });
  world.roster = [{ id: 'child', type: 'agent-router:scout', description: 'Search', status: 'running' }];
  await step($, { model: 'claude-main', agentId: 'child' });
  const child = await $.ui.render(band('child'));
  expect(button(child, 'agent-cache-upkeep')).toBe(undefined);
  expect(/● – TTL 5m █/.test(text(child))).toBe(true);
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

test('the dashboard names what cannot be kept warm only when the tree shows such an agent', async ($, on) => {
  response(on);
  const { world } = await setup($, on, undefined, { 'cache-upkeep': [['pane-session', 'warm']] });
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await step($);
  expect((await dashboard($)).includes('kept warm')).toBe(false);
  world.linked = [applyCacheCreation({ sessionId: 'pane-session', agentId: null, turnId: 'pane-turn', index: 0, model: 'vendor/main',
    startedAt: 0, completedAt: 0, read: 800, write: 100, fresh: 100, output: 20, ttlMs: null, ttlSource: 'response cache_creation', disabled: false },
    { fiveMinute: 100, oneHour: 0 })];
  expect((await dashboard($)).includes('kept warm')).toBe(false);
  world.roster = [{ id: 'scout1', type: 'agent-router:scout', description: 'Search', status: 'running' }];
  await step($, { agentId: 'scout1' });
  expect((await dashboard($)).includes('– can\'t be kept warm: Claude Code has no keepalive or compaction for subagents.')).toBe(true);
  world.roster.push({ id: 'mate1', type: 'teammate', description: 'Probe', status: 'running', name: 'probe' });
  await step($, { agentId: 'mate1' });
  expect((await dashboard($)).includes('for subagents and in-process teammates.')).toBe(true);
  await $.ui.press({ plugin: 'keepalive', key: 'cache-agents:main', requestId: 'keepalive' });
  expect(text(await $.ui.render(pane)).includes('kept warm')).toBe(false);
  await $.ui.press({ plugin: 'keepalive', key: 'cache-agents:teammates', requestId: 'keepalive' });
  expect(text(await $.ui.render(pane)).includes('– can\'t be kept warm: Claude Code has no keepalive or compaction for in-process teammates.')).toBe(true);
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
  expect(treeLines(drawn).some(line => line.startsWith('keepalive '))).toBe(true);
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
  for (const part of ['/keepalive', 'off', 'warm', 'compact', 'warmcomp', '/keepalive-settings']) expect(all.join(' ').includes(part)).toBe(true);
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
  await $.ui.press({ plugin: 'keepalive', key: 'agent-cache-ttl', requestId: 'cache-band' });
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
  expect((await dashboard($)).includes('TTL 1h · teammate TTL in /keepalive-settings')).toBe(true);
});

test('an in-process teammate launched with a role is still a teammate, by its team address', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  world.roster = [{ id: 'amate-1', type: 'agent-router:scout', teammateId: 'probe@session-lead', description: 'Probe', status: 'running', name: 'probe' }];
  expect(await ttlButton($, 'amate-1')).toBe('TTL 1h');
  await step($, { agentId: 'amate-1' });
  expect(seen('step', 'amate-1')).toEqual(['1h']);
  const contents = await dashboard($);
  expect(contents.includes('probe (amate-1) · in-process teammate')).toBe(true);
  expect(contents.includes('TTL 1h · teammate TTL in /keepalive-settings')).toBe(true);
  expect(contents.includes('for in-process teammates.')).toBe(true);
});

test('a split-pane teammate in the lead roster is drawn once, from its own session', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  await step($);
  world.roster = [{ id: 'worker@session-lead', type: 'agent-router:task', teammateId: 'worker@session-lead', description: 'Work', status: 'idle', name: 'worker' }];
  let contents = await dashboard($);
  expect(contents.includes('worker (worker@session-lead) · split-pane teammate')).toBe(true);
  expect(contents.includes('kept warm')).toBe(false);
  const now = clock.now();
  world.linked = [applyCacheCreation({ sessionId: 'pane-session', agentId: null, turnId: 'pane-turn', index: 0, model: 'vendor/main',
    startedAt: now, completedAt: now, read: 800, write: 100, fresh: 100, output: 20, ttlMs: null, ttlSource: 'response cache_creation', disabled: false },
    { fiveMinute: 100, oneHour: 0 })];
  world.labels = [[loopKey('pane-session', null), 'worker (worker@session-lead)']];
  contents = await dashboard($);
  expect(contents.split('worker (worker@session-lead)').length - 1).toBe(1);
  expect(contents.includes('worker (worker@session-lead) · split-pane teammate')).toBe(true);
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

function chipStates(node: RenderNode, prefix: string, found: Record<string, string> = {}) {
  if (typeof node === 'string') return found;
  if (node.type === 'Button' && typeof node.props.key === 'string' && node.props.key.startsWith(prefix)) {
    const props = node.props as { key: string; variant?: string; dimColor?: boolean };
    found[props.key.slice(prefix.length)] = props.variant === 'primary' ? 'chosen' : props.dimColor ? 'dim' : 'plain';
  }
  if ('children' in node && Array.isArray(node.children)) for (const child of node.children) chipStates(child, prefix, found);
  return found;
}

test('the dashboard opens with the rate now, the session rate and one dot per request', async ($, on) => {
  const usage = missWorld(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 5000, oneHour: 0 };
  await step($);
  Object.assign(usage, { read: 48648, write: 257000 });
  world.reported = { fiveMinute: 257000, oneHour: 0 };
  await clock.advance(26000);
  await step($, { index: 1 });
  world.roster = [{ id: 'child', type: 'agent-router:scout', description: 'Search', status: 'running' }];
  Object.assign(usage, { read: 0, write: 3000, fresh: 10 });
  world.reported = { fiveMinute: 3000, oneHour: 0 };
  await step($, { agentId: 'child' });
  const contents = await dashboard($);
  expect(contents.indexOf('Now') < contents.indexOf('Main')).toBe(true);
  expect(/Now\s+[█▓▒░\s]+\d+%\s+over the last 3 requests/.test(contents)).toBe(true);
  expect(/Session\s+[█▓▒░\s]+\d+%\s+over 3 requests · read 348.6k/.test(contents)).toBe(true);
  expect(contents.includes('One dot per request, oldest first: ● good ◐ fair ○ poor ✕ miss · keepalive ◆ compaction')).toBe(true);
  const drawn = await $.ui.render(pane);
  expect(treeLines(drawn).includes('●✕◐')).toBe(true);
  expect(colorOf(drawn, /^●$/)).toBe(DARK.good);
  expect(colorOf(drawn, /^✕$/)).toBe(DARK.poor);
  expect(colorOf(drawn, /^◐$/)).toBe(DARK.fair);
});

test('an empty session says what the dots will show', async ($, on) => {
  await setup($, on);
  expect((await dashboard($)).includes('No requests yet. Each request this session gets a dot here.')).toBe(true);
});

test('filters sit under one heading, the chosen option stands out and the rest are dim', async ($, on) => {
  response(on);
  await setup($, on);
  await step($);
  await dashboard($);
  let drawn = await $.ui.render(pane);
  expect(treeLines(drawn).includes('Show')).toBe(true);
  expect(chipStates(drawn, 'cache-requests:')).toEqual({ all: 'chosen', real: 'dim', keepalives: 'dim', compactions: 'dim', misses: 'dim' });
  expect(chipStates(drawn, 'cache-history:')).toEqual({ agent: 'chosen', all: 'dim' });
  expect(treeLines(drawn).some(line => /^From\s+\[ this agent \] all agents$/.test(line))).toBe(true);
  await press($, 'cache-requests:misses');
  expect(chipStates(await $.ui.render(pane), 'cache-requests:').misses).toBe('chosen');
});

test('recent requests are one line each, with the time between them in the gap', async ($, on) => {
  const usage = missWorld(on);
  Object.assign(usage, { read: 800, write: 100, fresh: 100 });
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  Object.assign(usage, { read: 0, write: 900, fresh: 100 });
  world.reported = { fiveMinute: 900, oneHour: 0 };
  await step($);
  Object.assign(usage, { read: 800, write: 100, fresh: 100 });
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await clock.advance(12400);
  await step($, { index: 1 });
  await clock.advance(252000);
  await step($, { index: 2 });
  await dashboard($);
  const lines = treeLines(await $.ui.render(pane));
  const first = lines.findIndex(line => line.startsWith('same-turn:2'));
  expect(first > 0).toBe(true);
  expect(lines[first - 1].trimStart().startsWith('request')).toBe(true);
  expect(lines[first + 1].trim()).toBe('↕ 4m 12s');
  expect(lines[first + 2].startsWith('same-turn:1')).toBe(true);
  expect(lines[first + 3].trim()).toBe('↕ 12s');
  expect(lines[first + 4].startsWith('same-turn:0')).toBe(true);
  expect(lines[first + 4].includes('  0%')).toBe(true);
  for (const line of [lines[first], lines[first + 2]]) {
    expect(line.includes('5m')).toBe(true);
    expect(line.includes('800')).toBe(true);
    expect(line.includes('vendor/main')).toBe(true);
  }
  const header = lines[first - 1];
  for (const line of [lines[first], lines[first + 2], lines[first + 4]]) expect(line.indexOf('5m')).toBe(header.indexOf('TTL'));
  const gapColor = colorOf(await $.ui.render(pane), /↕/);
  expect(gapColor).toBe(undefined);
});

test('with Agent Router installed, a routed request is measured against its routed model, not a false model change', async ($, on) => {
  labelled(on, () => 'vendor/search-v1');
  const { world } = await setup($, on);
  world.routes = { self: null, agents: [{ agentId: 'child', model: 'vendor/search-v1' }] };
  await $.command.run({ command: 'keepalive', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } });
  world.roster = [{ id: 'child', type: 'agent-router:scout', description: 'Search', status: 'running' }];
  await step($, { agentId: 'child', model: 'claude-opus-5-5' });
  expect(world.samples[0].model).toBe('vendor/search-v1');
  const stream = $.turn.step({ turnId: 'same-turn', index: 1, messageCount: 1, model: 'claude-opus-5-5', agentId: 'child' });
  await stream.next();
  expect(text(await $.ui.render(band('child'))).includes('model changed')).toBe(false);
  while (!(await stream.next()).done);
});

test('a split-pane teammate links itself to its lead and starts in the teammate defaults, with or without Agent Router', async ($, on) => {
  response(on);
  const { world } = await setup($, on, undefined, undefined, { teammate: { agentId: 'worker@team', agentName: 'worker', parentSessionId: 'lead-session' } });
  expect(world.links).toEqual([expect.objectContaining({ action: 'link', lead_session_id: 'lead-session', label: 'worker (worker@team)' })]);
  expect(await mode($)).toBe('warm');
  expect(await ttlButton($)).toBe('TTL 1h');
});

test('settings saved under Agent Router before the split keep applying until changed here', { options: {} }, async ($, on) => {
  response(on);
  await setup($, on, undefined, undefined, { settings: { pluginConfigs: { 'agent-router@agent-router-tools': { options: { cache_ttl: '1h' } } } } });
  expect(await ttlButton($)).toBe('TTL 1h');
});

test('a returning user keeps the TTL choices and intro they had under Agent Router', async ($, on) => {
  response(on);
  const { world } = await setup($, on, undefined, undefined, { handover: { 'cache-intro': 1, 'cache-ttl': [['cache-session', loopKey('cache-session', null), '1h']] } });
  expect(await ttlButton($)).toBe('TTL 1h');
  expect(world.logs.some(log => log.startsWith('Prompt cache'))).toBe(false);
});

test('a handover that arrives on a later start is still taken, since Keepalive may start before Agent Router', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  expect(await ttlButton($)).toBe('TTL 5m');
  world.handover = { 'cache-ttl': [['cache-session', loopKey('cache-session', null), '1h']] };
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(await ttlButton($)).toBe('TTL 1h');
  world.handover = { 'cache-ttl': [['cache-session', loopKey('cache-session', null), '5m']] };
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(await ttlButton($)).toBe('TTL 1h');
});

const bridgeReply = (output: unknown, exitCode = 0) => ({ value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode,
  stderr: exitCode ? 'failed' : '', stdout: exitCode ? '' : JSON.stringify(output) } });
const clear = ($: Engine, sessionId: string) => $.session.end({ reason: 'clear', sessionId, resume: { id: sessionId } });
const run = async ($: Engine) => JSON.stringify(await $.command.run({ command: 'keepalive', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }));
const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });

test('before a session starts, requests, compactions and the band pass through untouched', async ($, on) => {
  response(on);
  mock.clock(on);
  on('session.end', ($, e) => ({ sessionId: e.sessionId }));
  on('session.compact', () => ({ messages: [{ role: 'assistant' as const, text: 'Summary', toolUses: [] }] }));
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: ['Existing prompt content'] }));
  expect((await step($)).result.answer).toBe('PRIVATE_ANSWER');
  expect((await $.session.compact({ trigger: 'manual', messages: [{ role: 'assistant', text: 'Summary', toolUses: [] }] })).messages?.length).toBe(1);
  expect(text(await $.ui.render(band()))).toBe('Existing prompt content');
  expect((await run($)).includes('Keepalive dashboard is unavailable')).toBe(true);
  await $.session.end({ reason: 'other', sessionId: 'none', resume: { id: 'none' } });
});

test('clearing a conversation while its bar is still loading leaves nothing behind', async ($, on) => {
  response(on);
  on('session.end', ($, e) => ({ sessionId: e.sessionId }));
  const { world, clock } = await setup($, on);
  await step($);
  await $.ui.render(band());
  for (const fail of [false, true]) {
    world.before['process.run'] = async request => {
      if (request.action !== 'cache-snapshot') return undefined;
      world.before['process.run'] = undefined;
      await clock.sleep(5000);
      return fail ? bridgeReply(null, 1) : undefined;
    };
    const starting = start($);
    await clock.settle();
    await clear($, world.sessionId);
    await clear($, world.sessionId);
    await clock.advance(5000);
    await starting;
  }
  await clock.advance(6000);
  await $.ui.press({ plugin: 'keepalive', key: 'agent-cache-ttl', requestId: 'cache-band' });
  await $.ui.press({ plugin: 'keepalive', key: 'agent-cache-upkeep', requestId: 'cache-band' });
  expect(text(await $.ui.render(band()))).toBe('Existing prompt content');
  expect(world.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe(undefined);
  await step($, { index: 1 });
  expect(text(await $.ui.render(band())).includes('TTL 5m')).toBe(true);
});

test('opening the dashboard twice while it loads waits for the one load', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  await step($);
  let hits = 0;
  world.before['process.run'] = async request => {
    if (request.action !== 'cache-snapshot') return undefined;
    world.before['process.run'] = undefined;
    hits++;
    await clock.sleep(3000);
    return undefined;
  };
  const first = dashboard($);
  const second = dashboard($);
  await clock.advance(3000);
  for (const contents of await Promise.all([first, second])) expect(contents.includes('Prompt cache')).toBe(true);
  expect(hits).toBe(1);
});

test('a theme or cache record that cannot be read leaves the last known observations on show', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  await step($);
  world.faults.add('config.list');
  let snapshot: unknown = { samples: [{ bogus: true }], resets: [], labels: [] };
  world.before['process.run'] = request => request.action === 'cache-snapshot' ? bridgeReply(snapshot) : undefined;
  const contents = await dashboard($);
  expect(contents.includes('80%')).toBe(true);
  expect(contents.includes('Storage unavailable')).toBe(false);
  expect(colorOf(await $.ui.render(pane), /80%/)).toBe(DARK.good);
  snapshot = { samples: [] };
  expect((await dashboard($)).includes('Storage unavailable')).toBe(true);
});

test('settings and a store that cannot be read or written still draw the bar and keep choices for the session', async ($, on) => {
  response(on);
  const { world } = await setup($, on, undefined, undefined, { broken: ['store', 'settings.read'] });
  expect(intro(world).length).toBe(0);
  expect(await mode($)).toBe('off');
  await upkeep($);
  expect(await mode($)).toBe('warm');
  await pressTtl($);
  expect(await ttlButton($)).toBe('TTL 1h');
  expect(world.logs.some(log => log.includes('cache upkeep choice could not be saved'))).toBe(true);
  expect(world.logs.some(log => log.includes('cache TTL choice could not be saved'))).toBe(true);
});

test('an agent the roster cannot list is still measured as a subagent', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  world.faults.add('agent.list');
  await step($, { agentId: 'ghost' });
  expect(world.samples.map(sample => sample.agentId)).toEqual(['ghost']);
  expect(seen('step', 'ghost')).toEqual([undefined]);
});

test('subagent transcripts are found beside the main one, and other sessions and odd answers are ignored', async ($, on) => {
  response(on);
  on('classic.SubagentStop', () => ({}));
  const { world, clock } = await setup($, on);
  await $.classic.SessionStart({ source: 'startup', session_id: world.sessionId });
  await clock.advance(1000);
  expect(enrichments(world)).toBe(0);
  await $.classic.SessionStart({ source: 'startup', session_id: world.sessionId, transcript_path: transcript });
  world.roster = [{ id: 'child', type: 'agent-router:scout', description: 'Search', status: 'running' }];
  await step($, { agentId: 'child' });
  await clock.advance(1000);
  const paths = () => world.calls.filter(call => call.action === 'cache-enrich').map(call => call.transcript_path);
  expect(paths().includes('/transcripts/cache-session/subagents/agent-child.jsonl')).toBe(true);
  const before = enrichments(world);
  await $.classic.Stop({ stop_hook_active: false, session_id: 'other-session', transcript_path: '/transcripts/other-session.jsonl' });
  expect(enrichments(world)).toBe(before);
  await $.classic.SubagentStop({ stop_hook_active: false, session_id: world.sessionId, agent_id: 'helper', agent_type: 'scout',
    agent_transcript_path: '/elsewhere/agent-helper.jsonl' });
  expect(paths().at(-1)).toBe('/elsewhere/agent-helper.jsonl');
  for (const answer of [{ samples: [{ bogus: true }] }, {}]) {
    world.before['process.run'] = request => request.action === 'cache-enrich' ? bridgeReply(answer) : undefined;
    await $.classic.Stop({ stop_hook_active: false, session_id: world.sessionId, transcript_path: transcript });
  }
  expect(text(await $.ui.render(band('child'))).includes('80%')).toBe(true);
});

test('a slow transcript check is never started twice at once', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  const flight = { now: 0, most: 0 };
  world.before['process.run'] = async request => {
    if (request.action !== 'cache-enrich') return undefined;
    flight.now++;
    flight.most = Math.max(flight.most, flight.now);
    await clock.sleep(3000);
    flight.now--;
    return undefined;
  };
  await $.classic.SessionStart({ source: 'startup', session_id: world.sessionId, transcript_path: transcript });
  await step($);
  await clock.advance(12000);
  expect(enrichments(world) > 1).toBe(true);
  expect(flight.most).toBe(1);
});

test('a request still running when its conversation is cleared records nothing', async ($, on) => {
  response(on);
  on('session.end', ($, e) => ({ sessionId: e.sessionId }));
  const { world } = await setup($, on);
  const stream = $.turn.step({ turnId: 'same-turn', index: 0, messageCount: 1, model: 'vendor/main' });
  await stream.next();
  await clear($, world.sessionId);
  while (!(await stream.next()).done);
  expect(world.samples.length).toBe(0);
});

test('a keepalive that fails, goes unanswered or reports no usage is not recorded', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  world.forkUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  await cycleTo($, 'warm');
  const answers = [() => { throw new Error('fork failed'); }, () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }), () => undefined];
  for (const [index, answer] of answers.entries()) {
    world.before['model.fork'] = answer;
    await step($, { index });
    await clock.advance(275000);
  }
  expect(world.forks.length).toBe(1);
  expect(world.samples.some(sample => sample.turnId.startsWith('keepalive:'))).toBe(false);
  expect(world.logs.some(log => log.includes('cache keepalive did not answer (nothing-to-fork)'))).toBe(true);
});

test('clearing the conversation during a keepalive or compaction records nothing for it', async ($, on) => {
  response(on, 120000, 1000, 100);
  on('session.end', ($, e) => ({ sessionId: e.sessionId }));
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 1000, oneHour: 0 };
  world.before['model.fork'] = world.before['session.compact'] = async () => { await clear($, world.sessionId); return undefined; };
  for (const [index, wanted] of ['warm', 'compact'].entries()) {
    await step($, { index });
    await cycleTo($, wanted);
    await clock.advance(275000);
  }
  expect(world.forks.length).toBe(1);
  expect(world.compactions.length).toBe(1);
  expect(world.samples.some(sample => /^(keepalive|compaction):/.test(sample.turnId))).toBe(false);
});

test('a compaction that is skipped or fails is logged and leaves the bar as it was', async ($, on) => {
  response(on, 120000, 1000, 100);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 1000, oneHour: 0 };
  await cycleTo($, 'compact');
  for (const [index, answer] of [() => ({ skip: 'a hook blocked it' }), () => { throw new Error('turn running'); }].entries()) {
    world.before['session.compact'] = answer;
    await step($, { index });
    await clock.advance(275000);
  }
  expect(world.logs.some(log => log.includes('cache compaction skipped: a hook blocked it'))).toBe(true);
  expect(world.logs.some(log => log.includes('cache compaction could not run during a turn'))).toBe(true);
  expect(text(await $.ui.render(band())).includes('cmpt')).toBe(false);
});

test('each compaction restarts the bar once, before any request and when its reset cannot be saved', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  const summary = { trigger: 'manual' as const, messages: [{ role: 'assistant' as const, text: 'Summary', toolUses: [] }] };
  await $.session.compact(summary);
  expect(world.samples.at(-1)?.model).toBe('unknown');
  await step($);
  world.before['process.run'] = request => request.action === 'cache-reset' ? bridgeReply(null, 1) : undefined;
  await $.session.compact(summary);
  expect(world.resets.length).toBe(1);
  const shown = text(await $.ui.render(band()));
  expect(shown.includes('cmpt ✓')).toBe(true);
  expect(shown.includes('storage unavailable')).toBe(true);
});

test('usage reports are measured as the response gave them, and impossible ones are ignored', async ($, on) => {
  const usage: Record<string, unknown> = { model: '', cache_read_input_tokens: 800, cache_creation_input_tokens: 100, input_tokens: 100, output_tokens: 20 };
  on('turn.step', async function* ($, e) {
    yield { kind: 'text' as const, index: 0, text: 'answer' };
    return { turnId: e.turnId, index: e.index, answer: 'answer', toolUses: [], stopReason: 'end_turn' as const, usage: usage as any };
  });
  const { world } = await setup($, on);
  await step($);
  expect(world.samples[0].model).toBe('vendor/main');
  Object.assign(usage, { model: 'vendor/main', cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 } });
  await step($, { index: 1 });
  expect(world.samples[1].cacheCreation).toEqual({ fiveMinute: 0, oneHour: 100 });
  world.before['process.run'] = request => request.action === 'cache-sample' ? bridgeReply({ sample: null }) : undefined;
  await step($, { index: 1 });
  Object.assign(usage, { cache_read_input_tokens: -1 });
  await step($, { index: 2 });
  expect(world.calls.filter(call => call.action === 'cache-sample').length).toBe(3);
  const shown = text(await $.ui.render(band()));
  expect(shown.includes('ETA ~60:00')).toBe(true);
  expect(shown.includes('storage unavailable')).toBe(false);
});

test('two requests in flight on one conversation each settle on their own', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  const first = $.turn.step({ turnId: 'same-turn', index: 1, messageCount: 1, model: 'claude-main' });
  await first.next();
  const second = $.turn.step({ turnId: 'same-turn', index: 2, messageCount: 1, model: 'claude-main' });
  await second.next();
  while (!(await first.next()).done);
  expect(await dial($)).toBe('●');
  while (!(await second.next()).done);
  expect(world.samples.length).toBe(2);
});

test('after a reload, a request for a different model is still marked as a model change', async ($, on) => {
  labelled(on, model => model);
  await setup($, on);
  await step($);
  await start($);
  expect((await inFlight($, 'vendor/other')).includes('model changed · awaiting usage')).toBe(true);
});

test('a dashboard the terminal cannot place says why, and an unopened pane draws nothing', async ($, on) => {
  on('ui.render', { component: 'Pane' }, ($, e) => $.ui.resolve(e).Text({ children: ['No pane'] }));
  const { world } = await setup($, on, undefined, undefined, { broken: ['ui.open'] });
  expect((await run($)).includes('Keepalive dashboard is unavailable')).toBe(true);
  expect(world.logs.includes('Agent cache pane: terminal too narrow')).toBe(true);
  expect(text(await $.ui.render(pane))).toBe('No pane');
});

test('a teammate TTL button switches away from the teammate default, and a locked TTL ignores a stale press', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  world.roster = [{ id: 'mate', type: 'teammate', description: 'Probe', status: 'running', name: 'probe' }];
  expect(await ttlButton($, 'mate')).toBe('TTL 1h');
  await pressTtl($, 'mate');
  expect(await ttlButton($, 'mate')).toBe('TTL 5m');
  await $.ui.render(band());
  world.env.FORCE_PROMPT_CACHING_5M = '1';
  await start($);
  await $.ui.press({ plugin: 'keepalive', key: 'agent-cache-ttl', requestId: 'cache-band' });
  expect(world.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe(undefined);
});

test('the keepalive count hides while a request is in flight or when keepalives cost nothing to judge', async ($, on) => {
  response(on, 120000, 1000, 100);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 1000, oneHour: 0 };
  world.forkUsage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 121000, cache_creation_input_tokens: 0 };
  await cycleTo($, 'warmcomp');
  await step($);
  await clock.advance(2000);
  expect((await dashboard($)).includes('11 keepalives, then compact')).toBe(true);
  expect((await inFlight($, 'vendor/main')).includes('↻')).toBe(false);
  world.prices['vendor/free'] = { read: 0, output: 0 };
  await step($, { index: 2, model: 'vendor/free' });
  await clock.advance(2000);
  expect(text(await $.ui.render(band())).includes('↻')).toBe(false);
});

test('a price listing without a source names models.dev, and a failed recheck keeps the last price', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  world.prices['vendor/main'] = { read: 0.1, fiveMinute: 1.25, output: 5 };
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(2000);
  const priced = (contents: string) => contents.includes('priced by models.dev') && !contents.includes('priced by models.dev (');
  expect(priced(await dashboard($))).toBe(true);
  world.pricesFail = true;
  await clock.advance(3700000);
  await step($, { index: 1 });
  await clock.advance(2000);
  expect(world.priceLookups.length > 1).toBe(true);
  expect(priced(await dashboard($))).toBe(true);
});

test('the dashboard draws agents from other sessions, orphans and lost parents, and filters requests by kind', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  world.roster = [{ id: 'kid', type: 'agent-router:task', description: 'Dig', status: 'running', parentId: 'ghost' }];
  await step($);
  await step($, { agentId: 'kid' });
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'assistant', text: 'Summary', toolUses: [] }] });
  const now = clock.now();
  const linked = (sessionId: string, agentId: string | null, index: number) => ({ sessionId, agentId, turnId: 'pane-turn', index, model: 'vendor/main',
    startedAt: now, completedAt: now, read: 800, write: 100, fresh: 100, output: 20, ttlMs: null, ttlSource: 'response TTL metadata absent', disabled: false });
  world.linked = [linked('pane-a', null, 0), linked('pane-a', null, 1), linked('pane-b', null, 0), linked('pane-c', 'stray', 0)];
  await dashboard($);
  const lines = treeLines(await $.ui.render(pane));
  expect(lines.filter(line => /^[├└]─\s+Main · split-pane teammate$/.test(line)).length).toBe(2);
  expect(lines.some(line => /^[├└]─\s+agent-router:task \(kid\)$/.test(line))).toBe(true);
  expect(lines.some(line => /^└─\s+stray$/.test(line))).toBe(true);
  await press($, `cache-agent:${loopKey('cache-session', 'kid')}`);
  expect(text(await $.ui.render(pane)).includes('Recent requests · agent-router:task (kid)')).toBe(true);
  await press($, 'cache-history:all');
  expect(treeLines(await $.ui.render(pane)).some(line => /pane-turn:\d+\s+\S+\s+\S+\s+–\s/.test(line))).toBe(true);
  await press($, 'cache-requests:compactions');
  let drawn = treeLines(await $.ui.render(pane));
  expect(drawn.some(line => /^\S+\s+compaction\s/.test(line))).toBe(true);
  expect(drawn.some(line => line.includes('same-turn:0'))).toBe(false);
  await press($, 'cache-requests:real');
  drawn = treeLines(await $.ui.render(pane));
  expect(drawn.some(line => line.includes('same-turn:0'))).toBe(true);
  expect(drawn.some(line => /^\S+\s+compaction\s/.test(line))).toBe(false);
});

test('a narrow dashboard keeps only the latest dots and counts the earlier ones', async ($, on) => {
  const { world } = await setup($, on);
  world.linked = Array.from({ length: 100 }, (_, index) => ({ sessionId: `pane-${index % 4}`, agentId: null, turnId: 'pane-turn', index, model: 'vendor/main',
    startedAt: index, completedAt: index, read: 800, write: 100, fresh: 100, output: 20, ttlMs: null, ttlSource: 'response TTL metadata absent', disabled: false }));
  await dashboard($);
  const lines = treeLines(await $.ui.render({ ...pane, props: { ...pane.props, bodyColumns: 22 } }));
  expect(lines.includes('… 20 earlier')).toBe(true);
  expect(lines.filter(line => /^●{20}$/.test(line)).length).toBe(4);
});

test('an agent with nothing selected and no history shows no request list', async ($, on) => {
  response(on);
  await setup($, on);
  await step($);
  await dashboard($);
  expect(text(await $.ui.render({ ...pane, props: { ...pane.props, view: { agentId: 'missing' } } })).includes('Recent requests')).toBe(false);
});

test('a subagent miss chip opens its own history, and more than two causes are cut short', async ($, on) => {
  const usage = missWorld(on);
  const { world, clock } = await setup($, on);
  world.roster = [{ id: 'child', type: 'agent-router:scout', description: 'Search', status: 'running' }];
  world.reported = { fiveMinute: 5000, oneHour: 0 };
  await step($);
  Object.assign(usage, { read: 48648, write: 257000 });
  world.reported = { fiveMinute: 257000, oneHour: 0 };
  await clock.advance(26000);
  await step($, { index: 1 });
  Object.assign(usage, { read: 0, write: 306000 });
  await step($, { index: 2, model: 'vendor/other' });
  world.reported = undefined;
  Object.assign(usage, { read: 300000, write: 5000 });
  await step($, { agentId: 'child' });
  Object.assign(usage, { read: 0, write: 305000 });
  await step($, { agentId: 'child', index: 1 });
  expect(button(await $.ui.render(band()), 'agent-cache-misses')?.label?.endsWith('…')).toBe(true);
  expect(button(await $.ui.render(band('child')), 'agent-cache-misses')?.label).toBe('1 unknown');
  await $.ui.press({ plugin: 'keepalive', key: 'agent-cache-misses', requestId: 'cache-band' });
  expect(text(await $.ui.render(pane)).includes('Recent requests · agent-router:scout (child) (last 30 misses)')).toBe(true);
});


const policyRow = (extra: Record<string, unknown> = {}) => ({ alias: 'vendor/main', status: 'enabled', safe_refresh_s: 480, max_idle_s: 3600, refresh_on_read: true,
  prefix_bucket: 8, upstream_provider: 'phala', upstream_model: 'moonshotai/kimi-k3', ...extra });
const GATEWAY = { env: { ANTHROPIC_AUTH_TOKEN: 'secret-token' } };

test('the keepalive prompt is always the neutral text', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(275000);
  expect(world.forks).toEqual(['Reply with only: K']);
});

const posts = (world: { fetches: { url: string; method?: string; body?: string }[] }) => world.fetches.filter(f => f.method === 'POST');

async function gatewayWarm($: Engine, on: On, base = 'https://gateway.example', mode = 'warm') {
  response(on);
  const made = await setup($, on, base, undefined, GATEWAY);
  made.world.reported = undefined;
  made.world.prices['gateway-code-task'] = { read: 0.1, fiveMinute: 1.25, output: 5 };
  made.world.policy = [policyRow({ alias: 'gateway-code-task', source: 'documented', safe_refresh_s: 600, refresh_on_read: true, max_idle_s: null })];
  await cycleTo($, mode);
  await step($, { model: 'gateway-code-task' });
  return made;
}

test('a confirmed keepalive behind a protocol gateway is reported to its reports endpoint', async ($, on) => {
  const { world, clock } = await gatewayWarm($, on);
  await clock.advance(597000);
  const sent = posts(world);
  expect(sent.length).toBeGreaterThan(0);
  expect(sent[0].url).toBe('https://gateway.example/v1/cache/reports');
  const body = JSON.parse(sent[0].body!);
  expect(body.client).toBe('keepalive/0.4.2');
  expect(body.harness).toBe('claude_cli');
  expect(body.reports[0]).toMatchObject({ kind: 'keepalive', session: 'cache-session', alias: 'gateway-code-task', src: 'documented' });
  expect(typeof body.reports[0].started_at_ms).toBe('number');
  expect(JSON.stringify(body)).not.toContain('<keepalive');
});

test('a gateway that answers 404 to reports is left alone, and a failing one is retried later', async ($, on) => {
  const missing = await gatewayWarm($, on);
  missing.world.reportStatus = 404;
  await missing.clock.advance(597000);
  await missing.clock.advance(600000);
  expect(posts(missing.world).length).toBe(1);
});

test('a failing reports endpoint backs off and then delivers the queue', async ($, on) => {
  const { world, clock } = await gatewayWarm($, on);
  world.reportFail = true;
  await clock.advance(597000);
  const failed = posts(world).length;
  expect(failed).toBeGreaterThan(0);
  world.reportFail = false;
  await clock.advance(600000);
  expect(posts(world).length).toBeGreaterThan(failed);
});

test('a native Claude keepalive behind a protocol gateway is reported with src native', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  world.policy = [];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(275000);
  const reports = posts(world).flatMap(post => JSON.parse(post.body!).reports);
  expect(reports.length).toBeGreaterThan(0);
  expect(reports[0]).toMatchObject({ kind: 'keepalive', src: 'native' });
  expect(Object.keys(reports[0]).sort()).toEqual(['alias', 'completed_at_ms', 'fresh', 'kind', 'output', 'read', 'session', 'src', 'started_at_ms', 'write']);
});

test('a Claude-only session behind a gateway sends the heartbeat at most once per ten minutes', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  world.policy = [];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(30000);
  const gets = () => world.fetches.filter(f => f.method !== 'POST');
  expect(gets().length).toBe(1);
  expect(gets()[0].url).toContain('client=keepalive%2F0.4.2&harness=claude_cli');
  expect(gets()[0].headers?.authorization).toBe('Bearer secret-token');
  await clock.advance(500000);
  expect(gets().length).toBe(1);
  await clock.advance(200000);
  expect(gets().length).toBe(2);
});

test('a gateway default lifetime is reported as override', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.reported = undefined;
  world.prices['gateway-code-task'] = { read: 0.1, fiveMinute: 1.25, output: 5 };
  world.policy = [policyRow({ alias: 'gateway-code-task', source: 'default', safe_refresh_s: 270, refresh_on_read: true, max_idle_s: null })];
  await cycleTo($, 'warm');
  await step($, { model: 'gateway-code-task' });
  await clock.advance(270000);
  expect(posts(world).flatMap(post => JSON.parse(post.body!).reports)[0].src).toBe('override');
});

test('a compaction behind a protocol gateway is reported', { options: { compact_threshold: '1000' } }, async ($, on) => {
  const { world, clock } = await gatewayWarm($, on, 'https://gateway.example', 'compact');
  await clock.advance(597000);
  const kinds = posts(world).flatMap(post => JSON.parse(post.body!).reports.map((r: { kind: string }) => r.kind));
  expect(kinds).toContain('compaction');
});

for (const base of ['https://api.anthropic.com', '']) {
  test(`nothing is reported with base URL "${base}"`, async ($, on) => {
    const { world, clock } = await gatewayWarm($, on, base);
    await clock.advance(597000);
    expect(posts(world).length).toBe(0);
  });
}

test('a gateway that answered 404 to the policy endpoint gets no reports', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.policyStatus = 404;
  world.reported = undefined;
  world.policy = [];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(300000);
  expect(posts(world).length).toBe(0);
});

test('a gateway policy keeps a row without reported cache lifetimes warm by its safe time, renewing on confirmed reads', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.policy = [policyRow()];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(2000);
  expect(world.fetches.length).toBe(1);
  expect(world.fetches[0].url).toBe('https://gateway.example/v1/cache/policy?alias=vendor%2Fmain&session=cache-session&client=keepalive%2F0.4.2&harness=claude_cli');
  expect(world.fetches[0].headers?.authorization).toBe('Bearer secret-token');
  await clock.advance(30000);
  expect(text(await $.ui.render(band()))).toMatch(/✦ 7m \d+s/);
  await clock.advance(438000);
  expect(world.forks.length).toBe(0);
  await clock.advance(10000);
  expect(world.forks.length).toBe(1);
  await clock.advance(460000);
  expect(world.forks.length).toBe(1);
  await clock.advance(10000);
  expect(world.forks.length).toBe(2);
  expect(world.fetches.length).toBeLessThan(5);
});

test('a gateway row without refresh_on_read fires one keepalive per idle period and says once', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.policy = [policyRow({ refresh_on_read: null })];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(2000);
  await clock.advance(30000);
  expect(text(await $.ui.render(band()))).toMatch(/✦ 7m \d+s · once/);
  await clock.advance(448000);
  expect(world.forks.length).toBe(1);
  await clock.advance(1200000);
  expect(world.forks.length).toBe(1);
});

test('a client TTL warms a model nobody else gives a lifetime for, once per idle period, and says so', { options: { unreported_ttl: '5m' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = undefined;
  world.policy = [];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(35000);
  expect(text(await $.ui.render(band()))).toMatch(/✎ 3m \d+s/);
  await clock.advance(225000);
  expect(world.forks.length).toBe(0);
  await clock.advance(12000);
  expect(world.forks).toEqual(['Reply with only: K']);
  await clock.advance(1200000);
  expect(world.forks.length).toBe(1);
  expect((await dashboard($)).includes('✎ 5m · your TTL setting')).toBe(true);
});

test('a client TTL works without any gateway base URL', { options: { unreported_ttl: '15m' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, '');
  world.reported = undefined;
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(3000);
  expect((await dashboard($)).includes('✎ 15m · your TTL setting')).toBe(true);
  expect(world.fetches.length).toBe(0);
});

test('an unreachable gateway never lets the client TTL take over, but a 404 does', { options: { unreported_ttl: '5m' } }, async ($, on) => {
  response(on);
  const down = await setup($, on);
  down.world.reported = undefined;
  await cycleTo($, 'warm');
  await step($);
  await down.clock.advance(700000);
  expect(down.world.forks.length).toBe(0);
  expect(text(await $.ui.render(band())).includes('✎')).toBe(false);
});

test('a 404 from the gateway means no opinion, so the client TTL applies', { options: { unreported_ttl: '5m' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = undefined;
  world.policy = [];
  world.policyStatus = 404;
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(35000);
  expect(text(await $.ui.render(band()))).toMatch(/✎ 3m \d+s/);
});

test('a monitor row shows its reason and is never warmed or replaced by the client TTL', { options: { unreported_ttl: '5m' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.policy = [policyRow({ status: 'monitor', reason: 'ttl_too_short' })];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(700000);
  expect(world.forks.length).toBe(0);
  expect(text(await $.ui.render(band())).includes('◌ monitor (ttl_too_short)')).toBe(true);
});

test('the last served rows keep governing while the policy is refreshed or unreachable, for up to an hour', { options: { unreported_ttl: '5m' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.policy = [policyRow({ safe_refresh_s: 1200, max_idle_s: null })];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(30000);
  world.policy = null;
  await clock.advance(1100000);
  expect(world.forks.length).toBe(0);
  await clock.advance(80000);
  expect(world.forks.length).toBe(1);
  expect(text(await $.ui.render(band())).includes('✎')).toBe(false);
});

test('past an hour without an answer the row is monitored, not handed to the client TTL', { options: { unreported_ttl: '5m' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.policy = [policyRow({ safe_refresh_s: 20000, max_idle_s: null })];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(30000);
  world.policy = null;
  await clock.advance(3700000);
  expect(world.forks.length).toBe(0);
  expect(text(await $.ui.render(band())).includes('✎')).toBe(false);
});

test('warmcomp on a fixed window compacts a big conversation instead of sending a keepalive', { options: { compact_threshold: '500' } }, async ($, on) => {
  response(on, 0, 900, 10);
  const { world, clock } = await setup($, on);
  world.policy = [policyRow({ refresh_on_read: false })];
  await cycleTo($, 'warmcomp');
  await step($);
  await clock.advance(480000);
  expect(world.forks.length).toBe(0);
  expect(world.compactions.length).toBe(1);
});

test('warmcomp with refresh_on_read unknown compacts a big conversation in the window instead of a keepalive', { options: { compact_threshold: '500' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.policy = [policyRow({ refresh_on_read: null })];
  await cycleTo($, 'warmcomp');
  await step($);
  await clock.advance(480000);
  expect(world.forks.length).toBe(0);
  expect(world.compactions.length).toBe(1);
});

test('warmcomp on a client TTL compacts a big conversation in the window instead of a keepalive', { options: { unreported_ttl: '5m', compact_threshold: '500' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = undefined;
  world.policy = [];
  await cycleTo($, 'warmcomp');
  await step($);
  await clock.advance(275000);
  expect(world.forks.length).toBe(0);
  expect(world.compactions.length).toBe(1);
});

test('warmcomp on a chained lifetime still warms first', { options: { compact_threshold: '500' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.policy = [policyRow({ refresh_on_read: true })];
  await cycleTo($, 'warmcomp');
  await step($);
  await clock.advance(480000);
  expect(world.forks.length).toBe(1);
  expect(world.compactions.length).toBe(0);
});

test('warmcomp on a fixed window sends a keepalive when the conversation is below the threshold', async ($, on) => {
  response(on, 0, 900, 10);
  const { world, clock } = await setup($, on);
  world.policy = [policyRow({ refresh_on_read: false })];
  await cycleTo($, 'warmcomp');
  await step($);
  await clock.advance(480000);
  expect(world.forks.length).toBe(1);
  expect(world.compactions.length).toBe(0);
});

test('per-model client TTLs override the global one and off leaves a model monitor-only', { options: { unreported_ttl: '5m', unreported_ttl_models: 'vendor/main=off' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = undefined;
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(700000);
  expect(world.forks.length).toBe(0);
  expect(text(await $.ui.render(band())).includes('◌ TTL not reported')).toBe(true);
});

test('a served enabled lifetime overrides the client TTL, and its source rides the keepalive marker', { options: { unreported_ttl: '1h' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.policy = [policyRow({ source: 'documented', safe_refresh_s: 240 })];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(32000);
  expect(text(await $.ui.render(band()))).toMatch(/▣ 3m \d+s/);
  await clock.advance(212000);
  expect(world.forks).toEqual(['Reply with only: K']);
  expect((await dashboard($)).includes('server controlled')).toBe(true);
});

test('a gateway that says no cache is never warmed or compacted, whatever the client TTL', { options: { unreported_ttl: '5m', compact_threshold: '1k' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.policy = [policyRow({ status: 'no_cache', safe_refresh_s: null })];
  await cycleTo($, 'warmcomp');
  await step($);
  await clock.advance(700000);
  expect(world.forks.length + world.compactions.length).toBe(0);
  expect(text(await $.ui.render(band())).includes('⊘ no cache')).toBe(true);
});

test('a demoted row shows its reason and falls to monitor only', { options: { unreported_ttl: '5m' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.policy = [policyRow({ status: 'demoted', reason: 'too many misses' })];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(700000);
  expect(world.forks.length).toBe(0);
  expect(text(await $.ui.render(band())).includes('◌ demoted · too many misses')).toBe(true);
});

test('compact runs on a client lifetime when the conversation is big enough', { options: { unreported_ttl: '5m', compact_threshold: '1k' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = undefined;
  world.policy = [];
  await cycleTo($, 'compact');
  await step($);
  await clock.advance(272000);
  expect(world.compactions).toEqual(['default']);
  expect(world.forks.length).toBe(0);
});

test('warmcomp sends the single keepalive on a client lifetime below the compaction threshold', { options: { unreported_ttl: '5m', keepalive_limit: '1' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.reported = undefined;
  world.policy = [];
  await cycleTo($, 'warmcomp');
  await step($);
  await clock.advance(272000);
  expect(world.forks.length).toBe(1);
});

test('the server resume hint decides a keepalive by savings, and a low one pauses warming', async ($, on) => {
  response(on);
  const low = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  low.world.policy = [policyRow({ p_resume: 0.05 })];
  await cycleTo($, 'warm');
  await step($);
  await low.clock.advance(500000);
  expect(low.world.forks.length).toBe(0);
  expect(low.world.logs.some(line => line.includes('not worth'))).toBe(true);
});

test('the server resume hint warms when the saving beats the cost', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.policy = [policyRow({ p_resume: 0.9 })];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(500000);
  expect(world.forks.length).toBe(1);
});

test('price lookups pass the gateway, the price URL and credentials to the bridge', { options: { keepalive_price_url: 'https://prices.example/p.json' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.policy = [policyRow()];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(40000);
  const lookup = world.calls.find(call => call.action === 'cache-prices');
  expect(lookup?.feed).toEqual({ base: 'https://gateway.example', url: 'https://prices.example/p.json', headers: { authorization: 'Bearer secret-token' } });
});

test('the dashboard explains the lifetime icons', async ($, on) => {
  response(on);
  await setup($, on);
  expect((await dashboard($)).includes('◉ provider-reported')).toBe(true);
});

test('a keepalive that read nothing does not renew a gateway countdown, and the missed window is not retried', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.policy = [policyRow()];
  world.forkUsage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 900 };
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(485000);
  expect(world.forks.length).toBe(1);
  await clock.advance(600000);
  expect(world.forks.length).toBe(1);
});

test('a gateway row whose policy is not enabled is only shown', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.policy = [policyRow({ status: 'shadow' })];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(700000);
  expect(world.forks.length).toBe(0);
  expect(text(await $.ui.render(band())).includes('◌ shadow')).toBe(true);
});

test('gateway warming stops after the policy max idle time', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.policy = [policyRow({ max_idle_s: 1000 })];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(2000000);
  expect(world.forks.length).toBe(2);
});

test('gateway warming obeys the default cost rule and a numeric keepalive limit', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.policy = [policyRow({ max_idle_s: null })];
  await cycleTo($, 'warm');
  await step($);
  for (let i = 0; i < 15; i++) await clock.advance(480000);
  expect(world.forks.length).toBe(9);
});

test('a numeric keepalive limit also stops gateway warming', { options: { keepalive_limit: '2' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.policy = [policyRow({ max_idle_s: null })];
  await cycleTo($, 'warm');
  await step($);
  for (let i = 0; i < 6; i++) await clock.advance(480000);
  expect(world.forks.length).toBe(2);
});

test('the policy is not fetched for api.anthropic.com or without a base URL, and a failing policy changes nothing', async ($, on) => {
  response(on);
  const first = await setup($, on, 'https://api.anthropic.com');
  await cycleTo($, 'warm');
  await step($);
  await first.clock.advance(60000);
  expect(first.world.fetches.length).toBe(0);
});

test('a gateway that cannot be reached leaves a row without reported lifetimes as it was, and backs off', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(700000);
  expect(world.forks.length).toBe(0);
  expect(world.fetches.length).toBeLessThan(6);
  expect(text(await $.ui.render(band())).includes('TTL not reported')).toBe(true);
});

test('Claude behind a gateway keeps the native 5m path even when the policy says enabled', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.policy = [policyRow()];
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(260000);
  expect(world.forks.length).toBe(0);
  await clock.advance(15000);
  expect(world.forks.length).toBe(1);
  expect(world.fetches.filter(f => f.method !== 'POST').length).toBe(1);
  expect(text(await $.ui.render(band())).includes('ETA ~4:55')).toBe(true);
});

test('the gateway policy is asked with the API key when there is no auth token, and with no credentials when there is neither', async ($, on) => {
  response(on);
  const keyed = await setup($, on, 'https://gateway.example', undefined, { env: { ANTHROPIC_API_KEY: 'secret-key' } });
  keyed.world.policy = [policyRow()];
  await cycleTo($, 'warm');
  await step($);
  await keyed.clock.advance(2000);
  expect(keyed.world.fetches[0].headers?.['x-api-key']).toBe('secret-key');
  expect(keyed.world.fetches[0].headers?.authorization).toBeUndefined();
});

test('a gateway request without credentials sends none', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on);
  world.policy = [policyRow()];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(2000);
  expect(world.fetches[0].headers?.authorization).toBeUndefined();
  expect(world.fetches[0].headers?.['x-api-key']).toBeUndefined();
});

for (const [safe, provider, shown] of [[45, undefined, '✦ 12s'], [95, 'phala', '✦ 1m 2s'], [120, undefined, '✦ 1m 27s']] as const) {
  test(`a policy safe time of ${safe}s counts down to "${shown}"`, async ($, on) => {
    response(on);
    const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
    world.reported = undefined;
    world.policy = [policyRow({ safe_refresh_s: safe, upstream_provider: provider })];
    await cycleTo($, 'warm');
    await step($);
    await clock.advance(2000);
    await clock.advance(31000);
    expect(text(await $.ui.render(band())).slice(0, 200)).toContain(shown);
  });
}

test('compact upkeep sends nothing for a gateway row', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.policy = [policyRow()];
  await cycleTo($, 'compact');
  await step($);
  await clock.advance(600000);
  expect(world.forks.length).toBe(0);
  expect(world.compactions.length).toBe(0);
});

test('a credential that cannot be read leaves the policy request without credentials', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, { env: { ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' }, broken: ['credentials'] });
  world.policy = [policyRow()];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(2000);
  expect(world.fetches[0].headers?.authorization).toBeUndefined();
  expect(world.fetches[0].headers?.['x-api-key']).toBeUndefined();
});

test('a served default shows time left counting down, a live dial and no TTL chip', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.reported = undefined;
  world.policy = [policyRow({ source: 'default', safe_refresh_s: 229, refresh_on_read: null, max_idle_s: null })];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(2000);
  await clock.advance(98000);
  const first = text(await $.ui.render(band()));
  expect(first).toContain('◇ 2m 9s · once');
  expect(first).not.toContain('TTL 1h');
  expect(first).not.toContain('TTL 5m');
  expect(first).not.toContain('[ ◌ ]');
  expect(first).toMatch(/[◔◑◕●]/);
  await clock.advance(5000);
  expect(text(await $.ui.render(band()))).toContain('◇ 2m 4s · once');
  expect((await dashboard($)).includes('TTL 5m ·')).toBe(false);
});

test('after its single keepalive the bar says sent, and after max idle it says idle', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.reported = undefined;
  world.policy = [policyRow({ source: 'default', safe_refresh_s: 100, refresh_on_read: null, max_idle_s: 400 })];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(98000);
  await clock.advance(5000);
  expect(world.forks.length).toBe(1);
  expect(text(await $.ui.render(band()))).toContain('◇ sent · once');
  await clock.advance(400000);
  expect(text(await $.ui.render(band()))).toContain('◇ idle');
});

test('a window that was missed reads missed', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.reported = undefined;
  world.policy = [policyRow({ source: 'default', safe_refresh_s: 100, refresh_on_read: null, max_idle_s: null })];
  await cycleTo($, 'off');
  await step($);
  await clock.advance(200000);
  expect(text(await $.ui.render(band()))).toContain('◇ missed');
});

test('a gateway OpenAI model with a documented lifetime shows a countdown from it, never a native 1h cache', async ($, on) => {
  response(on, 0, 30200, 10);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.reported = undefined;
  world.prices['gateway-code-task'] = { read: 0.1, fiveMinute: 1.25, output: 5 };
  world.policy = [policyRow({ alias: 'gateway-code-task', source: 'documented', safe_refresh_s: 1680, refresh_on_read: true, max_idle_s: null })];
  await cycleTo($, 'warmcomp');
  await step($, { model: 'gateway-code-task' });
  for (const wait of [0, 2000, 40000]) {
    await clock.advance(wait);
    const shown = text(await $.ui.render(band()));
    expect(shown).not.toContain('◉');
    expect(shown).not.toContain('TTL 1h');
    expect(shown).not.toContain('ETA ~59');
  }
  expect(text(await $.ui.render(band()))).toMatch(/▣ 2\dm \d+s/);
  await clock.advance(3500000);
  expect(world.forks.every(prompt => prompt === 'Reply with only: K')).toBe(true);
  expect(world.forks.length).toBeGreaterThan(0);
});

test('a Claude model behind a gateway still shows its requested TTL while the report is awaited', async ($, on) => {
  response(on, 0, 30200, 10);
  const { world } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.policy = [policyRow({ alias: 'claude-opus-5', status: 'enabled' })];
  await step($, { model: 'claude-opus-5' });
  const shown = text(await $.ui.render(band()));
  expect(shown).toContain('ETA ~');
  expect(shown).toContain('TTL 5m');
});

// ---- Panel matrix, generated: lifetime source × upkeep mode × conversation size -------------------------------------------------------
const WRITE = 300;
const TOTAL = WRITE + 10;
type Source = { name: string; row?: Record<string, unknown>; client?: string; native?: boolean; actionable: boolean; chained: boolean; advance: number; src?: string };
const SOURCES: Source[] = [
  { name: 'learned chained', row: { source: 'learned', refresh_on_read: true }, actionable: true, chained: true, advance: 482000, src: 'learned' },
  { name: 'probe unknown refresh', row: { source: 'probe', refresh_on_read: null }, actionable: true, chained: false, advance: 482000, src: 'probe' },
  { name: 'override chained', row: { source: 'override', refresh_on_read: true }, actionable: true, chained: true, advance: 482000, src: 'override' },
  { name: 'documented unknown refresh', row: { source: 'documented', refresh_on_read: null }, actionable: true, chained: false, advance: 482000, src: 'documented' },
  { name: 'default fixed window', row: { source: 'default', refresh_on_read: false }, actionable: true, chained: false, advance: 482000, src: 'default' },
  { name: 'client 5m', client: '5m', actionable: true, chained: false, advance: 275000, src: 'client' },
  { name: 'client 15m', client: '15m', actionable: true, chained: false, advance: 815000, src: 'client' },
  { name: 'insufficient_data with client 5m', row: { status: 'insufficient_data', safe_refresh_s: null }, client: '5m', actionable: true, chained: false, advance: 275000, src: 'client' },
  { name: 'deprecated shadow with client 5m', row: { status: 'shadow', safe_refresh_s: null }, client: '5m', actionable: true, chained: false, advance: 275000, src: 'client' },
  { name: 'native Claude', native: true, actionable: true, chained: true, advance: 275000, src: 'native' },
  { name: 'no_cache', row: { status: 'no_cache', safe_refresh_s: null }, client: '5m', actionable: false, chained: false, advance: 700000 },
  { name: 'monitor', row: { status: 'monitor', reason: 'ttl_too_short' }, client: '5m', actionable: false, chained: false, advance: 700000 },
  { name: 'monitor below_economic_floor', row: { status: 'monitor', reason: 'below_economic_floor' }, client: '5m', actionable: false, chained: false, advance: 700000 },
  { name: 'monitor unreliable_cache', row: { status: 'monitor', reason: 'unreliable_cache' }, client: '5m', actionable: false, chained: false, advance: 700000 },
  { name: 'demoted', row: { status: 'demoted', reason: 'misses' }, client: '5m', actionable: false, chained: false, advance: 700000 },
  { name: 'fixed_window status', row: { status: 'fixed_window' }, client: '5m', actionable: false, chained: false, advance: 700000 },
  { name: 'insufficient_data without client TTL', row: { status: 'insufficient_data', safe_refresh_s: null }, actionable: false, chained: false, advance: 700000 },
  { name: 'no server row without client TTL', actionable: false, chained: false, advance: 700000 },
  { name: 'client off', client: 'off', actionable: false, chained: false, advance: 700000 },
];
const SIZES: [string, string, boolean][] = [['below', String(TOTAL + 1), false], ['at', String(TOTAL), true], ['over', String(TOTAL - 1), true]];
const expectOutcome = (source: Source, mode: string, big: boolean) => {
  if (!source.actionable || mode === 'off') return 'nothing';
  if (mode === 'warm') return 'forks';
  if (mode === 'compact') return big ? 'compactions' : 'nothing';
  return big && !source.chained && !source.native ? 'compactions' : 'forks';
};
async function prepare($: Engine, on: On, source: Source) {
  response(on, 0, WRITE, 10);
  const made = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  const model = source.native ? 'claude-main' : 'vendor/main';
  made.world.prices['claude-main'] = { read: 0.1, fiveMinute: 1.25, output: 5 };
  made.world.reported = source.native ? { fiveMinute: WRITE, oneHour: 0 } : undefined;
  made.world.policy = source.row ? [policyRow({ alias: model, ...source.row })] : [];
  return { ...made, model };
}
for (const source of SOURCES) for (const mode of ['off', 'warm', 'compact', 'warmcomp']) for (const [size, threshold, big] of SIZES) {
  const outcome = expectOutcome(source, mode, big);
  const options = { compact_threshold: threshold, ...(source.client ? { unreported_ttl: source.client } : {}) };
  test(`matrix panel: ${source.name} × ${mode} × ${size} threshold → ${outcome}`, { options }, async ($, on) => {
    const { world, clock, model } = await prepare($, on, source);
    await cycleTo($, mode);
    await step($, { model });
    await clock.advance(source.advance);
    expect(world.forks.length > 0).toBe(outcome === 'forks');
    expect(world.compactions.length > 0).toBe(outcome === 'compactions');
    if (outcome === 'forks') expect(world.forks[0]).toBe('Reply with only: K');
    const shown = text(await $.ui.render(band()));
    if (!source.native) {
      expect(shown).not.toContain('TTL 1h');
      expect(shown).not.toContain('◉');
      if (source.actionable) expect(shown).not.toContain('[ ◌ ]');
    }
  });
}

// ---- in flight: nothing is sent while a turn is pending; afterwards the schedule restarts from that turn -----------------------------------
for (const source of SOURCES.filter(item => item.actionable && !item.native && item.name !== 'client 15m')) for (const mode of ['warm', 'compact', 'warmcomp']) {
  // A client TTL counts from the start of a request; this one started a whole lifetime ago, so its window is already lost and nothing may be sent late.
  const outcome = source.client ? 'nothing' : expectOutcome(source, mode, true);
  test(`matrix in flight: ${source.name} × ${mode}`, { options: { compact_threshold: String(TOTAL), ...(source.client ? { unreported_ttl: source.client } : {}) } }, async ($, on) => {
    const { world, clock } = await prepare($, on, source);
    await cycleTo($, mode);
    await step($);
    await clock.advance(source.advance - 200000);
    const pending = $.turn.step({ turnId: 'slow', index: 1, messageCount: 1, model: 'vendor/main' });
    await pending.next();
    await clock.advance(source.advance + 100000);
    expect(world.forks.length + world.compactions.length).toBe(0);
    while (!(await pending.next()).done);
    expect(world.forks.length + world.compactions.length).toBe(0);
    await clock.advance(source.advance);
    expect(world.forks.length > 0).toBe(outcome === 'forks');
    expect(world.compactions.length > 0).toBe(outcome === 'compactions');
  });
}

// ---- limits and the savings rule, crossed with each actionable lifetime -------------------------------------------------------------------
type Limit = { name: string; limit?: string; prices: boolean; p: number | null };
const LIMITS: Limit[] = [
  { name: 'default limit with prices', prices: true, p: null }, { name: 'default limit without prices', prices: false, p: null },
  { name: 'savings pass', prices: true, p: 0.9 }, { name: 'savings fail', prices: true, p: 0.05 }, { name: 'savings without prices', prices: false, p: 0.9 },
  { name: 'numeric limit 1', limit: '1', prices: false, p: 0.05 }, { name: 'infinite limit', limit: 'infinite', prices: false, p: 0.05 },
];
for (const source of SOURCES.filter(item => item.actionable && !item.native)) for (const limit of LIMITS) {
  if (limit.p !== null && !source.row?.refresh_on_read && source.client) continue;
  const served = !!source.row && source.row.status === undefined;
  const hint = served ? limit.p : null;
  const pays = limit.limit ? true : limit.prices && (hint === null || hint > 0.1);
  test(`matrix limits: ${source.name} × ${limit.name} → ${pays ? 'warms' : 'holds back'}`,
    { options: { ...(source.client ? { unreported_ttl: source.client } : {}), ...(limit.limit ? { keepalive_limit: limit.limit } : {}) } }, async ($, on) => {
      const { world, clock } = await prepare($, on, source);
      if (!limit.prices) world.prices = {};
      if (served && limit.p !== null) world.policy = [policyRow({ alias: 'vendor/main', ...source.row, p_resume: limit.p })];
      await cycleTo($, 'warm');
      await step($);
      await clock.advance(source.advance);
      expect(world.forks.length > 0).toBe(pays);
    });
}
for (const source of SOURCES.filter(item => item.actionable && !item.native)) {
  test(`matrix limits: ${source.name} stops at a numeric limit of 1`, { options: { keepalive_limit: '1', ...(source.client ? { unreported_ttl: source.client } : {}) } }, async ($, on) => {
    const { world, clock } = await prepare($, on, source);
    await cycleTo($, 'warm');
    await step($);
    await clock.advance(source.advance * 3);
    expect(world.forks.length).toBe(1);
  });
}

// ---- seeded random timelines through the whole panel --------------------------------------------------------------------------------------
function random(seed: number) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; }
const FIRING = SOURCES.filter(item => !item.native && item.name !== 'client 15m');
for (let run = 0; run < 20; run++) {
  const pick = random(7000 + run);
  const source = FIRING[Math.floor(pick() * FIRING.length)];
  const mode = ['off', 'warm', 'compact', 'warmcomp'][Math.floor(pick() * 4)];
  const [, threshold] = SIZES[Math.floor(pick() * 3)];
  const limit = [undefined, '1', '2', 'infinite'][Math.floor(pick() * 4)];
  const options = { compact_threshold: threshold, ...(source.client ? { unreported_ttl: source.client } : {}), ...(limit ? { keepalive_limit: limit } : {}) };
  test(`property: random timeline ${run} (${source.name}, ${mode}, limit ${limit ?? 'default'})`, { options }, async ($, on) => {
    const { world, clock } = await prepare($, on, source);
    await cycleTo($, mode);
    const ttl = source.client ? { '5m': 300, '15m': 900 }[source.client]! : 480;
    const safe = source.client ? ttl - Math.max(10, ttl / 10) : 480;
    let t = 0;
    let realAt = 0;
    let sinceReal = { forks: 0, compactions: 0 };
    let pending: AsyncGenerator<any, any> | undefined;
    let frozen: { forks: number; compactions: number } | undefined;
    await step($);
    for (let second = 0; second < 700; second++) {
      const before = { forks: world.forks.length, compactions: world.compactions.length };
      if (!pending && pick() < 0.002) {
        pending = $.turn.step({ turnId: `r${second}`, index: second, messageCount: 1, model: 'vendor/main' }) as AsyncGenerator<any, any>;
        await pending.next();
        frozen = { ...before };
      } else if (pending && pick() < 0.02) {
        while (!(await pending.next()).done);
        pending = undefined;
        expect({ forks: world.forks.length, compactions: world.compactions.length }).toEqual(frozen);
        realAt = t;
        sinceReal = { forks: world.forks.length, compactions: world.compactions.length };
      }
      await clock.advance(1000);
      t++;
      const sent = world.forks.length - before.forks;
      const compacted = world.compactions.length - before.compactions;
      if (pending) expect(sent + compacted).toBe(0);
      if (sent || compacted) {
        // never late: the first action after a real turn is within its lifetime, and never for something that cannot be warmed
        expect(source.actionable && mode !== 'off').toBe(true);
        if (world.forks.length - sinceReal.forks === sent && world.compactions.length - sinceReal.compactions === compacted) {
          expect(t - realAt).toBeLessThanOrEqual(source.client ? ttl : safe + 100);
        }
        if (compacted) expect(mode === 'compact' || mode === 'warmcomp').toBe(true);
      }
      if (!source.chained && !limit) expect(world.forks.length - sinceReal.forks).toBeLessThanOrEqual(1);
      if (limit === '1') expect(world.forks.length - sinceReal.forks).toBeLessThanOrEqual(1);
    }
    if (pending) while (!(await pending.next()).done);
  });
}

test('matrix panel: direct api.anthropic.com never asks a gateway and a non-Claude model stays monitor-only without a client TTL', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://api.anthropic.com');
  world.reported = undefined;
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(700000);
  expect(world.fetches.length).toBe(0);
  expect(world.forks.length).toBe(0);
});

test('a native Claude row asks the price feed too, with the gateway and credentials', async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.reported = { fiveMinute: 100, oneHour: 0 };
  await cycleTo($, 'warm');
  await step($, { model: 'claude-opus-5-5' });
  await clock.advance(2000);
  const lookup = world.calls.find(call => call.action === 'cache-prices');
  expect(lookup?.models).toEqual(['claude-opus-5-5']);
  expect(lookup?.feed).toEqual({ base: 'https://gateway.example', url: '', headers: { authorization: 'Bearer secret-token' } });
});

test('a probe lifetime shows ⟳ and overrides the client TTL', { options: { unreported_ttl: '5m' } }, async ($, on) => {
  response(on);
  const { world, clock } = await setup($, on, 'https://gateway.example', undefined, GATEWAY);
  world.policy = [policyRow({ source: 'probe', safe_refresh_s: 1620, refresh_on_read: null, max_idle_s: null })];
  await cycleTo($, 'warm');
  await step($);
  await clock.advance(40000);
  expect(text(await $.ui.render(band()))).toMatch(/⟳ 2\dm \d+s · once/);
  expect((await dashboard($)).includes('gateway probe')).toBe(true);
});
