import { test, expect, mock, tier } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { ConfigRow, On, RenderInput, RenderNode } from 'claude-code';

tier('user');

const band: RenderInput<'AbovePrompt', 'terminal'> = { component: 'AbovePrompt', surface: 'terminal', requestId: 'cache-band', props: {
  hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 110, scroll: { offset: 0, bodyRows: 5 }, view: {} } };
const settingsPane: RenderInput<'Pane', 'terminal'> = { component: 'Pane', surface: 'terminal', requestId: 'keepalive-settings',
  props: { title: 'Keepalive settings', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } };

function text(node: RenderNode | undefined): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const label = node.type === 'Button' || node.type === 'Select' ? String(node.props.label) : '';
  return [label, ...('children' in node && Array.isArray(node.children) ? node.children.map(text) : [])].filter(Boolean).join(' ');
}
function choices(node: RenderNode | undefined, key: string): string[] {
  if (!node || typeof node === 'string') return [];
  if (node.type === 'Select' && node.props.key === key) return (node.props.options as readonly { label: string }[]).map(option => option.label);
  return 'children' in node && Array.isArray(node.children) ? node.children.flatMap(child => choices(child, key)) : [];
}

const ROWS: ConfigRow[] = ['cache_ttl', 'subagent_cache_ttl', 'teammate_cache_ttl'].map(field => ({ key: `owner.${field}`, label: field, kind: 'choice' as const,
  value: 'default', options: ['default', '5m', '1h'], provider: { plugin: 'keepalive', tier: 'user' as const }, isLocked: false }));

type Knobs = { fail?: string[]; teammate?: { agentId: string; agentName?: string; parentSessionId: string }; handover?: Record<string, unknown>;
  stored?: Record<string, unknown>; auth?: 'bearer' | 'api-key'; placed?: boolean; clock?: boolean };

function world(on: On, knobs: Knobs = {}) {
  const fail = new Set(knobs.fail);
  const state = { calls: [] as Record<string, any>[], logs: [] as string[], compactions: 0, classic: [] as string[], stored: { ...knobs.stored }, clockFails: false };
  const refuse = (name: string) => { if (fail.has(name)) throw new Error(`${name} refused`); };
  on('store.get', ($, e) => { refuse('store.get'); return { value: state.stored[e.key] }; });
  on('store.set', ($, e) => { state.stored[e.key] = e.value; return { value: undefined }; });
  on('env.get', ($, e) => { refuse('env.get'); return { value: e.name === 'ANTHROPIC_BASE_URL' ? 'https://gateway.example' : undefined }; });
  on('env.set', () => ({ value: undefined }));
  if (knobs.clock) on('clock.now', () => { if (state.clockFails) throw new Error('clock refused'); return { value: 1000 }; });
  else mock.clock(on);
  on('session.id', () => ({ value: 'register-session' }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('session.authorize', () => { refuse('session.authorize'); return { value: knobs.auth ? { handle: 'opaque', kind: knobs.auth } : null }; });
  on('settings.read', () => { refuse('settings.read'); return { value: {} }; });
  on('command.register', ($, e) => { refuse('command.register'); return { value: { command: e.name } }; });
  on('ui.open', () => ({ value: knobs.placed === false ? { isPlaced: false, reason: 'the terminal is too narrow' } : { isPlaced: true } }));
  on('ui.close', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.log', ($, e) => { state.logs.push(e.text); return { value: undefined }; });
  on('agent.list', () => ({ value: [] }));
  on('config.list', () => ({ value: ROWS }));
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: ['Survey'] }));
  on('session.compact', ($, e) => {
    state.compactions++;
    if (knobs.clock) state.clockFails = true;
    return e.instructions === 'skip' ? { skip: 'nothing to compact' } : { messages: [{ role: 'assistant' as const, text: 'Summary', toolUses: [] }] };
  });
  for (const event of ['SessionStart', 'SubagentStart', 'PostToolUse', 'Stop', 'SubagentStop'] as const) {
    on(`classic.${event}`, () => { state.classic.push(event); return {}; });
  }
  on('process.run', ($, e) => {
    const request = JSON.parse(e.init?.stdin || '{}');
    state.calls.push(request);
    if (fail.has(request.action)) return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 1, stderr: '', stdout: '' } };
    const output = request.action === 'migrate' ? { migrated: false, handover: knobs.handover ?? null }
      : request.action === 'identity' ? { teammate: knobs.teammate ?? null }
      : request.action === 'cache-snapshot' ? { samples: [], resets: [], labels: [], routes: null }
      : request.action === 'cache-enrich' ? { samples: [] } : {};
    return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 0, stderr: '', stdout: JSON.stringify(output) } };
  });
  return state;
}

const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive });
const command = ($: Engine, name: string) => $.command.run({ command: name, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } });

test('classic tool, stop and subagent events pass through while the bar keeps each transcript in view', async ($, on) => {
  const state = world(on);
  await start($);
  await $.classic.SessionStart({ source: 'startup', transcript_path: '/work/main.jsonl' });
  await $.classic.SubagentStart({ agent_id: 'agent-1', agent_type: 'scout', transcript_path: '/work/main.jsonl' });
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'tool-1', transcript_path: '/work/main.jsonl' });
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'tool-2', agent_id: 'agent-1', agent_type: 'scout' });
  await $.classic.Stop({ stop_hook_active: false, transcript_path: '/work/main.jsonl' });
  await $.classic.Stop({ stop_hook_active: false, agent_id: 'agent-1', agent_type: 'scout' });
  await $.classic.SubagentStop({ stop_hook_active: false, agent_id: 'agent-1', agent_type: 'scout', agent_transcript_path: '/work/agent-1.jsonl' });
  expect(state.classic).toEqual(['SessionStart', 'SubagentStart', 'PostToolUse', 'PostToolUse', 'Stop', 'Stop', 'SubagentStop']);
});

test('a session whose environment, settings, sign-in and bridge all fail still draws the bar and its settings', async ($, on) => {
  const state = world(on, { fail: ['env.get', 'settings.read', 'session.authorize', 'migrate', 'identity'] });
  await start($);
  expect(state.logs).not.toContain('Keepalive: the cache bar could not start in this session.');
  expect(text(await $.ui.render(band))).toContain('Survey');
  await command($, 'keepalive-settings');
  expect(choices(await $.ui.render(settingsPane), 'cache-ttl')[0]).toBe('Default (5m)');
});

test('a session that cannot register its commands logs that the bar could not start', async ($, on) => {
  const state = world(on, { fail: ['command.register'] });
  await start($);
  expect(state.logs).toContain('Keepalive: the cache bar could not start in this session.');
});

test('an API key sign-in keeps the main conversation default at 5m', async ($, on) => {
  world(on, { auth: 'api-key' });
  await start($, false);
  await command($, 'keepalive-settings');
  expect(choices(await $.ui.render(settingsPane), 'cache-ttl')[0]).toBe('Default (5m)');
});

test('a handover never replaces what Keepalive already stored, and is taken only once', async ($, on) => {
  const state = world(on, { handover: { intro: 1, upkeep: [['other', 'warm']] }, stored: { intro: 2 } });
  await start($, false);
  expect(state.stored.intro).toBe(2);
  expect(state.stored.upkeep).toEqual([['other', 'warm']]);
  expect(state.stored['handed-over']).toBe(1);
});

test('a store that cannot be read skips the handover rather than overwriting', async ($, on) => {
  const state = world(on, { handover: { intro: 1 }, fail: ['store.get'] });
  await start($, false);
  expect(state.stored['handed-over']).toBeUndefined();
});

test('an unnamed split-pane teammate links under its agent id, and a failed link still starts the bar', async ($, on) => {
  const state = world(on, { teammate: { agentId: 'worker@team', parentSessionId: 'lead-session' }, fail: ['link'] });
  await start($);
  expect(state.calls.find(call => call.action === 'link')).toMatchObject({ lead_session_id: 'lead-session', label: 'Teammate (worker@team)' });
  expect(state.logs).not.toContain('Keepalive: the cache bar could not start in this session.');
});

test('a survey above the prompt is left alone', async ($, on) => {
  world(on);
  await start($);
  expect(text(await $.ui.render({ ...band, props: { ...band.props, hasSurvey: true } }))).toBe('Survey');
});

test('a compaction computed ahead of time is passed through, and a real one is measured', async ($, on) => {
  const state = world(on);
  await start($);
  const messages = [{ role: 'user' as const, text: 'Earlier', toolUses: [] }];
  const ahead = await $.session.compact({ trigger: 'precompute', messages });
  expect(ahead.messages?.length).toBe(1);
  const before = state.calls.filter(call => call.action === 'cache-reset').length;
  await $.session.compact({ trigger: 'auto', messages, agentId: 'agent-1' });
  expect(state.compactions).toBe(2);
  expect(state.calls.filter(call => call.action === 'cache-reset').length).toBe(before + 1);
  expect((await $.session.compact({ trigger: 'manual', messages, instructions: 'skip' })).skip).toBe('nothing to compact');
  expect(state.calls.filter(call => call.action === 'cache-reset').length).toBe(before + 1);
});

test('the dashboard command says when the pane cannot be placed', async ($, on) => {
  world(on, { placed: false });
  await start($);
  expect((await command($, 'keepalive')).text).toBe('Keepalive dashboard is unavailable. Check session setup or widen the terminal.');
  expect((await command($, 'agent-cache')).text).toBe('Keepalive dashboard is unavailable. Check session setup or widen the terminal.');
});

const closer = { name: 'closer', register(on: On) {
  on('command.run', { command: 'close-keepalive' }, async $ => { await $.ui.close({ id: 'keepalive' }); return { text: 'closed' }; });
} };

test('the dashboard opens, and closing it from elsewhere releases it', { plugins: [closer] }, async ($, on) => {
  world(on);
  await start($);
  expect((await command($, 'keepalive')).text).toBe('Keepalive dashboard opened. Select an agent to inspect recent requests.');
  expect((await command($, 'close-keepalive')).text).toBe('closed');
});

test('a cache bar that fails before, after or around a request never breaks the answer or the compaction', async ($, on) => {
  const state = world(on, { clock: true });
  let failAfter = false;
  on('turn.step', async function* ($, e) {
    if (failAfter) state.clockFails = true;
    yield { kind: 'text' as const, index: 0, text: 'Answer' };
    return { turnId: e.turnId, index: e.index, answer: 'Answer', toolUses: [], stopReason: 'end_turn' as const,
      usage: { model: e.model, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, input_tokens: 1, output_tokens: 1 } };
  });
  await start($, false);
  const step = async () => {
    const stream = $.turn.step({ turnId: 'turn', index: 0, messageCount: 1, model: 'vendor/main' });
    for (;;) { const part = await stream.next(); if (part.done) return part.value; }
  };
  state.clockFails = true;
  expect((await step()).answer).toBe('Answer');
  state.clockFails = false;
  failAfter = true;
  expect((await step()).answer).toBe('Answer');
  state.clockFails = false;
  const compacted = await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'Earlier', toolUses: [] }] });
  expect(compacted.messages?.length).toBe(1);
});
