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
    reported: undefined as { fiveMinute: number; oneHour: number } | undefined,
    // TTL buckets the transcript holds once Claude flushes it; undefined until then.
    flushed: undefined as { fiveMinute: number; oneHour: number } | undefined,
    forks: [] as string[], compactions: [] as string[] };
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
  on('classic.SessionStart', () => ({}));
  on('classic.Stop', () => ({}));
  on('model.fork', ($, e) => {
    world.forks.push(e.prompt);
    return { value: { isAnswered: true as const, text: 'OK', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } } };
  });
  on('session.compact', ($, e) => {
    world.compactions.push('instructions' in e && e.instructions ? e.instructions : 'default');
    return { messages: [{ role: 'assistant' as const, text: 'Summary', toolUses: [] }] };
  });
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
  expect(contents.includes('80%')).toBe(true);
  expect(contents.includes('TTL unknown')).toBe(true);
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
  expect(text(await $.ui.render(band())).includes('no observation')).toBe(true);
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
  expect(text(await $.ui.render(band())).includes('TTL unknown')).toBe(true);
  expect(text(await $.ui.render(band('child'))).includes('TTL unknown')).toBe(true);
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
  // Stop runs before Claude writes the final response to the transcript.
  await $.classic.Stop({ stop_hook_active: false, session_id: world.sessionId, transcript_path: transcript });
  expect(text(await $.ui.render(band())).includes('TTL unknown')).toBe(true);
  world.flushed = { fiveMinute: 100, oneHour: 0 };
  await clock.advance(1000);
  const rendered = text(await $.ui.render(band()));
  expect(rendered.includes('TTL 5m')).toBe(true);
  expect(rendered.includes('TTL unknown')).toBe(false);
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
  expect(text(await $.ui.render(band())).includes('TTL unknown')).toBe(true);
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
// The upkeep button and the background of the chip that holds it.
function chip(node: RenderNode, parent?: RenderNode): { label?: string; color?: string } | undefined {
  if (typeof node === 'string') return undefined;
  if (node.type === 'Button' && node.props.key === 'agent-cache-upkeep') {
    const props = parent && typeof parent !== 'string' && 'props' in parent ? parent.props as { backgroundColor?: string } | undefined : undefined;
    return { label: node.props.label, color: props?.backgroundColor };
  }
  if ('children' in node && Array.isArray(node.children)) for (const child of node.children) {
    const found = chip(child, node);
    if (found) return found;
  }
  return undefined;
}
const mode = async ($: Engine) => chip(await $.ui.render(band()))?.label;
async function cycleTo($: Engine, wanted: string) {
  for (let i = 0; i < 3 && await mode($) !== wanted; i++) await upkeep($);
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
  expect(colorOf(rendered, /█/)).toBe('success');
  expect(colorOf(rendered, /96%/)).toBe('success');
  expect(colorOf(rendered, /ETA/)).toBe('success');
  await clock.advance(180000);
  expect(colorOf(await $.ui.render(band()), /ETA/)).toBe('warning');
  await clock.advance(91000);
  expect(colorOf(await $.ui.render(band()), /ETA/)).toBe('error');
  await clock.advance(30000);
  rendered = await $.ui.render(band());
  expect(text(rendered).includes('ETA')).toBe(false);
  expect(colorOf(rendered, /expired/)).toBe('error');
});

test('a hit rate that is fine on a small context is graded poor on a large one', async ($, on) => {
  response(on, 891000, 98000, 1000);
  await setup($, on);
  await step($);
  const rendered = await $.ui.render(band());
  expect(text(rendered).includes('90%')).toBe(true);
  expect(colorOf(rendered, /90%/)).toBe('error');
});

test('a small context with the same hit rate is graded good', async ($, on) => {
  response(on, 9000, 900, 100);
  await setup($, on);
  await step($);
  expect(colorOf(await $.ui.render(band()), /90%/)).toBe('success');
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

test('the upkeep button cycles off, warm and compact and keeps the choice for the session', async ($, on) => {
  response(on);
  const { world } = await setup($, on);
  expect(await mode($)).toBe('off');
  for (const next of ['warm', 'compact', 'off', 'warm']) {
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
  // Without a reported TTL the dial is dotted.
  expect(shown.includes('◌ off ████████░░ 80%')).toBe(true);
  expect(button(rendered, 'agent-cache-open')?.plain).toBe(undefined);
  await $.ui.press({ plugin: 'agent-router', key: 'agent-cache-open', requestId: 'cache-band' });
  expect(text(await $.ui.render(pane)).includes('Prompt cache')).toBe(true);
});

test('each upkeep mode has its own colour, none used elsewhere in the band', async ($, on) => {
  response(on, 144000, 5000, 1000);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 5000, oneHour: 0 };
  await step($);
  const chips = new Set<string | undefined>();
  const others = new Set(['success', 'warning', 'error']);
  for (let i = 0; i < 3; i++) {
    const rendered = await $.ui.render(band());
    chips.add(chip(rendered)?.color);
    for (const [, color] of colors(rendered)) others.add(color);
    await upkeep($);
    await clock.advance(100000);
  }
  expect([...chips].every(color => typeof color === 'string')).toBe(true);
  expect(chips.size).toBe(3);
  expect([...chips].some(color => others.has(color!))).toBe(false);
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
  // The bar keeps the last real request's rate; the keepalive restarted the countdown.
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
  // A 900-token prefix: rewriting costs 1035 base tokens more than reading;
  // each keepalive costs 90 read + 10 new + 2 output at 5x.
  expect(world.forks.length).toBe(9);
  // A real request starts a new allowance.
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

test('compact mode compacts a large idle conversation before its cache expires', async ($, on) => {
  response(on, 120000, 1000, 100);
  const { world, clock } = await setup($, on);
  world.reported = { fiveMinute: 1000, oneHour: 0 };
  await cycleTo($, 'compact');
  await step($);
  await clock.advance(260000);
  expect(world.compactions.length).toBe(0);
  await clock.advance(15000);
  expect(world.compactions).toEqual(['default']);
  expect(world.forks.length).toBe(0);
  expect(text(await $.ui.render(band())).includes('no observation')).toBe(true);
  await clock.advance(400000);
  expect(world.compactions.length).toBe(1);
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
  expect(/Main ◑\s+█/.test(contents)).toBe(true);
  expect(/\(child\) ◌\s+█/.test(contents)).toBe(true);
});
