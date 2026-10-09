import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const SETTINGS = ['default', '5m', '1h'];
const TTL_BUILD_MS = 1000;
const CONTENDED_MS = 2 * TTL_BUILD_MS + 1500;
const tmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else found.push(JSON.parse(await readFile(path, 'utf8')));
  }
  return found;
}

async function copyPlugin(temporary, name, parts, defaults, childModel) {
  const target = join(temporary, name);
  await mkdir(target);
  for (const part of parts) await cp(join(repo, name, part), join(target, part), { recursive: true });
  const manifestPath = join(target, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const [key, config] of Object.entries(manifest.userConfig)) {
    if (key.endsWith('_model')) config.default = childModel;
    if (key in defaults) config.default = defaults[key];
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  return target;
}

function marks(body) {
  const found = new Set();
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.cache_control) found.add(node.cache_control.ttl ?? '5m');
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk([body.system, body.messages, body.tools]);
  return [...found].sort().join(',') || 'none';
}

async function run(t, { keepalive = {}, mainModel = 'claude-opus-5-5', childModel = 'claude-opus-5-5', plan = [], env: extra = {}, settings, args = [],
  interactive = false, wait = 30, policy, unreported = false, plugins: more = [], keepaliveFirst = false, prompt = 'Use a probe to reply briefly.' } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'keepalive-ttl-live-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const router = await copyPlugin(temporary, 'agent-router', ['.claude-plugin', 'agents', 'commands', 'hooks', 'lib', 'scripts'], {}, childModel);
  const plugin = await copyPlugin(temporary, 'keepalive', ['.claude-plugin', 'hooks', 'lib', 'scripts'], keepalive, childModel);
  const started = Date.now();
  const requests = [];
  const counts = {};
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      if (request.url.includes('/v1/cache/policy') && policy) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ rows: policy, server_now: new Date().toISOString() }));
      }
      if (request.url.includes('/v1/cache/')) { response.writeHead(404); return response.end(); }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ data: [...new Set([mainModel, childModel])].map(id => ({ id, type: 'model', display_name: id })) }));
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    if (request.url.includes('count_tokens')) return response.end('{"input_tokens":100}');
    if (request.url.includes('/v1/cache/')) { response.writeHead(200); return response.end('{}'); }
    const body = JSON.parse(raw);
    const first = JSON.stringify(body.messages?.[0] ?? '');
    const last = JSON.stringify(body.messages?.at(-1) ?? '');
    const who = first.match(/TAG-([A-Z]+)/)?.[1] ?? (first.includes(prompt.slice(0, 20)) ? 'MAIN' : 'OTHER');
    const summary = JSON.stringify(body.messages ?? []).includes('Describe your most recent action in 3-5 words');
    const kind = last.includes('Reply with only: K') ? 'KEEPALIVE' : summary ? `${who}-SUMMARY`
      : who !== 'OTHER' && !(body.stream && body.tools?.length) ? `${who}-AUX` : who;
    counts[kind] = (counts[kind] ?? 0) + 1;
    const entry = { at: Date.now() - started, kind, n: counts[kind], ttl: marks(body), agent: request.headers['x-claude-code-agent-id'] ?? null };
    requests.push(entry);
    const rule = plan.find(item => item.kind === kind && (item.n === undefined || item.n === entry.n)) ?? {};
    if (rule.status) {
      response.writeHead(rule.status, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }));
    }
    const oneHour = entry.ttl.includes('1h');
    const usage = { input_tokens: 10, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 5,
      ...(unreported ? {} : { cache_creation: { ephemeral_5m_input_tokens: oneHour ? 0 : 500, ephemeral_1h_input_tokens: oneHour ? 500 : 0 } }) };
    const blocks = (rule.tools ?? []).map((tool, index) => ({ type: 'tool_use', id: `toolu_${kind}_${entry.n}_${index}`, name: tool.name ?? 'Agent', input: tool.input }));
    if (!blocks.length) blocks.push({ type: 'text', text: kind === 'KEEPALIVE' ? 'K' : 'done' });
    const stop = blocks[0].type === 'tool_use' ? 'tool_use' : 'end_turn';
    const message = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage };
    if (!body.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      entry.done = Date.now() - started;
      return response.end(JSON.stringify({ ...message, content: blocks, stop_reason: stop }));
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: 'message_start', message });
    for (const [index, block] of blocks.entries()) {
      if (block.type === 'tool_use') {
        send({ type: 'content_block_start', index, content_block: { ...block, input: {} } });
        send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
      } else {
        send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        for (const end = Date.now() + (rule.hold ?? 0); Date.now() < end;) {
          send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: '.' } });
          await sleep(Math.min(5000, end - Date.now()));
        }
        send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
      }
      send({ type: 'content_block_stop', index });
    }
    send({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage });
    send({ type: 'message_stop' });
    response.end();
    entry.done = Date.now() - started;
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const config = join(temporary, 'config');
  await mkdir(config);
  if (settings) await writeFile(join(config, 'settings.json'), JSON.stringify(settings));
  const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: 'dummy-test-key',
    CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_DATA: join(temporary, 'data'), AGENT_ROUTER_DATA: join(temporary, 'data'),
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' };
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_SUBAGENT_MODEL', 'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_PROMPT_CACHE_TTL', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', 'ENABLE_PROMPT_CACHING_1H', 'FORCE_PROMPT_CACHING_5M', 'TMUX']) delete env[key];
  Object.assign(env, extra);
  const flags = ['--model', mainModel, '--permission-mode', 'bypassPermissions', ...[...(keepaliveFirst ? [plugin, router] : [router, plugin]), ...more].flatMap(path => ['--plugin-dir', path]), ...args];
  if (interactive) {
    const work = join(temporary, 'work');
    await mkdir(work);
    await writeFile(join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
      customApiKeyResponses: { approved: [env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] },
      projects: { [realpathSync(work)]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }));
    const session = `keepalive-ttl-${process.pid}-${Date.now()}`;
    const exported = Object.entries(env).filter(([key]) => /^(ANTHROPIC_|CLAUDE_|DISABLE_|AGENT_ROUTER|ENABLE_|FORCE_|PATH$|HOME$)/.test(key));
    execFileSync('tmux', ['new-session', '-d', '-s', session, '-x', '220', '-y', '50',
      `cd ${quote(realpathSync(work))} && env -u TMUX ${exported.map(([key, value]) => `${key}=${quote(value)}`).join(' ')} ${[process.env.CLAUDE_BINARY || 'claude', ...flags].map(quote).join(' ')}`]);
    t.after(() => { try { execFileSync('tmux', ['kill-session', '-t', session]); } catch { /* already gone */ } });
    const screen = () => execFileSync('tmux', ['capture-pane', '-p', '-t', session], { encoding: 'utf8' });
    const keys = (...input) => execFileSync('tmux', ['send-keys', '-t', session, ...input]);
    for (let tries = 0; tries < 20 && !screen().includes('❯'); tries++) await sleep(500);
    for (let tries = 0; tries < 6; tries++) {
      const shown = screen();
      if (shown.includes('Yes, I accept') || shown.includes('trust this folder')) { keys('Down'); await sleep(300); keys('Enter'); await sleep(2000); }
      else if (shown.includes('Enter to continue')) { keys('Enter'); await sleep(1500); }
      else break;
    }
    keys('-l', prompt);
    await sleep(500);
    keys('Enter');
    for (const end = Date.now() + wait * 1000; Date.now() < end;) {
      await sleep(1000);
      if (screen().includes('Enter to continue')) keys('Enter');
    }
  } else {
    const child = spawn(process.env.CLAUDE_BINARY || 'claude', ['-p', prompt, '--output-format', 'json', ...flags], { env, cwd: temporary, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }), 0, stderr);
  }
  const samples = (await files(join(temporary, 'data', 'cache-samples'))).map(sample => ({ ...sample, at: sample.startedAt - started }));
  return { requests, samples, temporary };
}

const real = requests => requests.filter(request => !/-(AUX|SUMMARY)$/.test(request.kind) && request.kind !== 'OTHER');

function expectTtls(requests, wanted) {
  const seen = {};
  for (const request of real(requests)) (seen[request.kind] ??= new Set()).add(request.ttl);
  assert.deepEqual(Object.fromEntries(Object.entries(seen).map(([kind, ttls]) => [kind, [...ttls].join(',')])), wanted);
}

function delays(requests, samples, kind) {
  return real(requests).filter(request => request.kind === kind).map(request => {
    const own = samples.filter(sample => sample.at <= request.at + 50 && (kind === 'KEEPALIVE' ? sample.turnId.startsWith('keepalive:')
      : !sample.turnId.startsWith('keepalive:') && (request.agent === null ? sample.agentId === null
        : sample.agentId === request.agent || sample.agentId?.startsWith(`a${request.agent.split('@')[0]}-`))));
    return request.at - Math.max(...own.map(sample => sample.at));
  });
}

function expectRecorded(requests, samples, limit = 1500) {
  for (const kind of new Set(real(requests).map(request => request.kind))) {
    for (const delay of delays(requests, samples, kind)) assert.ok(delay >= -50 && delay <= limit, `${kind} was sent ${delay}ms after Keepalive saw it`);
  }
}

const TREE = [
  { kind: 'MAIN', n: 1, tools: [
    { input: { description: 'Foreground probe', subagent_type: 'agent-router:reviewer', prompt: 'TAG-CHILD reply briefly' } },
    { input: { description: 'Background probe', subagent_type: 'agent-router:scout', prompt: 'TAG-BACKGROUND reply briefly', run_in_background: true } }] },
  { kind: 'CHILD', n: 1, tools: [{ input: { description: 'Nested probe', subagent_type: 'agent-router:scout', prompt: 'TAG-NESTED reply briefly' } }] },
];
const resolved = (setting, fallback) => setting === 'default' ? fallback : setting;

for (const keepaliveFirst of [false, true]) {
  for (const main of SETTINGS) {
    for (const subagent of SETTINGS) {
      test(`live: with ${keepaliveFirst ? 'Keepalive' : 'Agent Router'} loaded first, cache_ttl ${main} and subagent_cache_ttl ${subagent}, the main conversation and its foreground, background and nested subagents each send their own TTL, every request recorded`,
        { timeout: 90000 }, async t => {
          const { requests, samples } = await run(t, { keepalive: { cache_ttl: main, subagent_cache_ttl: subagent }, plan: TREE, keepaliveFirst });
          const child = resolved(subagent, '5m');
          expectTtls(requests, { MAIN: resolved(main, '5m'), CHILD: child, BACKGROUND: child, NESTED: child });
          expectRecorded(requests, samples);
          for (const sample of samples) assert.equal(sample.requested, sample.agentId === null ? resolved(main, '5m') : child);
        });
    }
  }
}

const DEFAULTS = [
  { name: 'your own TTL variables are the default', env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' }, main: '1h', subagent: '1h' },
  { name: 'Keepalive settings override your own TTL variables', env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' },
    keepalive: { cache_ttl: '5m', subagent_cache_ttl: '5m' }, main: '5m', subagent: '5m' },
  { name: 'ENABLE_PROMPT_CACHING_1H is the default everywhere', env: { ENABLE_PROMPT_CACHING_1H: '1' }, main: '1h', subagent: '1h' },
  { name: 'FORCE_PROMPT_CACHING_5M wins over every setting', env: { FORCE_PROMPT_CACHING_5M: '1' }, keepalive: { cache_ttl: '1h', subagent_cache_ttl: '1h' }, main: '5m', subagent: '5m' },
  { name: 'Claude Code settings are the default', settings: { promptCacheTtl: '1h', subagentPromptCacheTtl: '1h' }, main: '1h', subagent: '1h' },
  { name: 'Keepalive settings override Claude Code settings', settings: { promptCacheTtl: '1h', subagentPromptCacheTtl: '1h' },
    keepalive: { cache_ttl: '5m', subagent_cache_ttl: '5m' }, main: '5m', subagent: '5m' },
];
for (const item of DEFAULTS) {
  test(`live: ${item.name}`, { timeout: 90000 }, async t => {
    const { requests, samples } = await run(t, { keepalive: item.keepalive, env: item.env, settings: item.settings, plan: TREE });
    expectTtls(requests, { MAIN: item.main, CHILD: item.subagent, BACKGROUND: item.subagent, NESTED: item.subagent });
    expectRecorded(requests, samples);
  });
}

const PANE = ['--agent-id', 'pane@team-live', '--agent-name', 'pane', '--team-name', 'team-live', '--parent-session-id', '11111111-2222-4333-8444-555555555555'];
for (const teammate of SETTINGS) {
  for (const subagent of SETTINGS) {
    test(`live: a split-pane teammate with teammate_cache_ttl ${teammate} and subagent_cache_ttl ${subagent} sends the teammate TTL from its own conversation and the subagent TTL from its subagents`,
      { timeout: 90000 }, async t => {
        const { requests, samples } = await run(t, { keepalive: { cache_ttl: '1h', teammate_cache_ttl: teammate, subagent_cache_ttl: subagent }, plan: TREE, args: PANE });
        const child = resolved(subagent, '5m');
        expectTtls(requests, { MAIN: resolved(teammate, '5m'), CHILD: child, BACKGROUND: child, NESTED: child });
        expectRecorded(requests, samples);
      });
  }
}

test('live: a request Claude Code retries keeps the TTL it was built with, even after another agent changed the variable', { timeout: 90000 }, async t => {
  const flipper = join(await mkdtemp(join(tmpdir(), 'keepalive-flipper-')), 'flipper');
  t.after(() => rm(join(flipper, '..'), { recursive: true, force: true }));
  await mkdir(join(flipper, '.claude-plugin'), { recursive: true });
  await mkdir(join(flipper, 'hooks'));
  await writeFile(join(flipper, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'flipper', version: '0.0.1', description: 'Changes the subagent TTL mid-request.' }));
  await writeFile(join(flipper, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }));
  await writeFile(join(flipper, 'hooks', 'register.ts'), `import type { On } from 'claude-code';
export function register(on: On) {
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) void $.clock.sleep(200).then(async () => {
      await $.env.set('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', '5m');
      await $.process.run(['/bin/sh', '-c', 'echo flipped >> "$FLIP_LOG"']);
    });
    return yield* next(e);
  });
}
`);
  const log = join(flipper, '..', 'flips.log');
  const { requests } = await run(t, { keepalive: { subagent_cache_ttl: '1h' }, plugins: [flipper], env: { FLIP_LOG: log },
    plan: [{ kind: 'MAIN', n: 1, tools: [TREE[0].tools[0]] }, { kind: 'CHILD', n: 1, status: 529 }, { kind: 'CHILD', n: 2, status: 529 }] });
  assert.ok((await readFile(log, 'utf8')).includes('flipped'));
  const attempts = requests.filter(request => request.kind === 'CHILD');
  assert.ok(attempts.length >= 3, JSON.stringify(requests));
  assert.ok(attempts.at(-1).at - attempts[0].at > 200, JSON.stringify(attempts));
  assert.deepEqual([...new Set(attempts.map(request => request.ttl))], ['1h']);
});

const TEAM = [
  { kind: 'MAIN', n: 1, tools: [
    { input: { name: 'mate', subagent_type: 'agent-router:task', description: 'Mate', prompt: 'TAG-MATE reply briefly' } },
    { input: { description: 'Background probe', subagent_type: 'agent-router:scout', prompt: 'TAG-BACKGROUND reply briefly', run_in_background: true } }] },
  { kind: 'MATE', n: 1, tools: [{ input: { description: 'Mate child', subagent_type: 'agent-router:scout', prompt: 'TAG-MATECHILD reply briefly' } }] },
];
for (const [main, subagent, teammate] of [['1h', '5m', '1h'], ['5m', '1h', '5m'], ['default', 'default', 'default'], ['1h', '1h', '5m'], ['5m', '5m', '1h']]) {
  test(`live: an in-process teammate with cache_ttl ${main}, subagent_cache_ttl ${subagent} and teammate_cache_ttl ${teammate} sends the teammate TTL, and its subagent the subagent TTL`,
    { timeout: 120000, skip: !tmux && 'needs tmux' }, async t => {
      const { requests, samples } = await run(t, { interactive: true, wait: 25, args: ['--teammate-mode', 'in-process'],
        keepalive: { cache_ttl: main, subagent_cache_ttl: subagent, teammate_cache_ttl: teammate }, plan: TEAM });
      expectTtls(requests, { MAIN: resolved(main, '5m'), MATE: resolved(teammate, '5m'), MATECHILD: resolved(subagent, '5m'), BACKGROUND: resolved(subagent, '5m') });
      expectRecorded(requests, samples, CONTENDED_MS);
    });
}

for (const keepaliveFirst of [false, true]) {
  test(`live: with ${keepaliveFirst ? 'Keepalive' : 'Agent Router'} loaded first, an in-process teammate wanting 1h and a subagent wanting 5m are sent one after the other, the subagent then starts at once while the teammate streams, and both keep their TTLs`,
    { timeout: 120000, skip: !tmux && 'needs tmux' }, async t => {
      const { requests, samples } = await run(t, { interactive: true, wait: 35, args: ['--teammate-mode', 'in-process'], keepaliveFirst,
        keepalive: { cache_ttl: '1h', subagent_cache_ttl: '5m', teammate_cache_ttl: '1h' },
        plan: [{ kind: 'MAIN', n: 1, tools: [
          { input: { name: 'mate', subagent_type: 'agent-router:task', description: 'Mate', prompt: 'TAG-MATE reply slowly' } },
          { input: { description: 'Background probe', subagent_type: 'agent-router:scout', prompt: 'TAG-BACKGROUND reply', run_in_background: true } }] },
        { kind: 'MATE', n: 1, hold: 20000 }, { kind: 'BACKGROUND', n: 1, tools: [{ name: 'Read', input: { file_path: '/etc/hosts' } }] }] });
      expectTtls(requests, { MAIN: '1h', MATE: '1h', BACKGROUND: '5m' });
      expectRecorded(requests, samples, CONTENDED_MS);
      const mate = real(requests).find(request => request.kind === 'MATE');
      const background = real(requests).filter(request => request.kind === 'BACKGROUND');
      assert.ok(background.length >= 2 && background.every(request => request.at < mate.at + 20000), JSON.stringify(requests));
      const firsts = ['MATE', 'BACKGROUND'].map(kind => delays(requests, samples, kind)[0]);
      assert.ok(Math.max(...firsts) >= TTL_BUILD_MS / 2, `neither waited for the other to be sent: ${firsts}`);
      assert.ok(delays(requests, samples, 'BACKGROUND').at(-1) <= 1500, 'the subagent waited for a teammate already answering');
    });
}

test('live: while a 1h background subagent and a 5m in-process teammate both stream long responses, progress summaries ask for the 5m default, which reads either cache',
  { timeout: 120000, skip: !tmux && 'needs tmux' }, async t => {
    const { requests, samples } = await run(t, { interactive: true, wait: 50, args: ['--teammate-mode', 'in-process'],
      keepalive: { cache_ttl: '5m', subagent_cache_ttl: '1h', teammate_cache_ttl: '5m' },
      plan: [{ kind: 'MAIN', n: 1, tools: [
        { input: { name: 'mate', subagent_type: 'agent-router:task', description: 'Mate', prompt: 'TAG-MATE reply slowly' } },
        { input: { description: 'Background probe', subagent_type: 'agent-router:scout', prompt: 'TAG-BACKGROUND reply slowly', run_in_background: true } }] },
      { kind: 'MATE', n: 1, hold: 40000 }, { kind: 'BACKGROUND', n: 1, hold: 40000 }] });
    expectTtls(requests, { MAIN: '5m', MATE: '5m', BACKGROUND: '1h' });
    expectRecorded(requests, samples, CONTENDED_MS);
    const summaries = requests.filter(request => request.kind.endsWith('-SUMMARY'));
    assert.ok(summaries.length && summaries.every(request => request.ttl === '5m'), JSON.stringify(requests));
  });

for (const mate of [false, true]) {
  test(`live: with a 1h default, a background subagent's progress summaries ask for ${mate ? '5m while a 5m in-process teammate is running' : '1h while every conversation wants 1h'}`,
    { timeout: 120000, skip: !tmux && 'needs tmux' }, async t => {
      const { requests, samples } = await run(t, { interactive: true, wait: 50, args: ['--teammate-mode', 'in-process'], env: { ENABLE_PROMPT_CACHING_1H: '1' },
        keepalive: mate ? { teammate_cache_ttl: '5m' } : {},
        plan: [{ kind: 'MAIN', n: 1, tools: [
          ...(mate ? [{ input: { name: 'mate', subagent_type: 'agent-router:task', description: 'Mate', prompt: 'TAG-MATE reply slowly' } }] : []),
          { input: { description: 'Background probe', subagent_type: 'agent-router:scout', prompt: 'TAG-BACKGROUND reply slowly', run_in_background: true } }] },
        { kind: 'MATE', n: 1, hold: 40000 }, { kind: 'BACKGROUND', n: 1, hold: 40000 }] });
      expectTtls(requests, { MAIN: '1h', BACKGROUND: '1h', ...(mate ? { MATE: '5m' } : {}) });
      expectRecorded(requests, samples, CONTENDED_MS);
      const summaries = requests.filter(request => request.kind === 'BACKGROUND-SUMMARY');
      assert.ok(summaries.length && summaries.every(request => request.ttl === (mate ? '5m' : '1h')), JSON.stringify(requests));
    });
}

const FAST = [{ alias: 'vendor/fast', resolution: 'exact', status: 'enabled', safe_refresh_s: 20, max_idle_s: null, refresh_on_read: true, source: 'documented', prefix_bucket: 0 }];
const SLOW_CHILD = [{ kind: 'MAIN', n: 1, tools: [{ input: { description: 'Slow probe', subagent_type: 'agent-router:scout', prompt: 'TAG-BACKGROUND reply slowly', run_in_background: true } }] },
  { kind: 'BACKGROUND', n: 1, hold: 40000 }];

test('live: warm sends its keepalive at once with the main TTL while a background subagent streams a long 1h response, and the subagent\'s progress summaries ask for the 5m default, which reads its 1h cache',
  { timeout: 120000, skip: !tmux && 'needs tmux' }, async t => {
    const { requests, samples } = await run(t, { interactive: true, wait: 50, mainModel: 'vendor/fast', childModel: 'vendor/fast', unreported: true, policy: FAST,
      keepalive: { subagent_cache_ttl: '1h', cache_upkeep: 'warm', keepalive_limit: '1' }, plan: SLOW_CHILD });
    expectTtls(requests, { MAIN: '5m', BACKGROUND: '1h', KEEPALIVE: '5m' });
    const summaries = requests.filter(request => request.kind === 'BACKGROUND-SUMMARY');
    assert.ok(summaries.length && summaries.every(request => request.ttl === '5m'), JSON.stringify(requests));
    const keepalive = real(requests).find(request => request.kind === 'KEEPALIVE');
    const child = real(requests).find(request => request.kind === 'BACKGROUND');
    assert.ok(keepalive.at < child.at + 40000, JSON.stringify(requests));
    expectRecorded(requests, samples);
  });

test('live: compact compacts at once with the main TTL while a background subagent streams a long 1h response, and the subagent\'s progress summaries ask for the 5m default, which reads its 1h cache',
  { timeout: 120000, skip: !tmux && 'needs tmux' }, async t => {
    const { requests, samples } = await run(t, { interactive: true, wait: 50, mainModel: 'vendor/fast', childModel: 'vendor/fast', unreported: true, policy: FAST,
      keepalive: { subagent_cache_ttl: '1h', cache_upkeep: 'compact', compact_threshold: '1000' }, plan: SLOW_CHILD });
    expectTtls(requests, { MAIN: '5m', BACKGROUND: '1h' });
    const summaries = requests.filter(request => request.kind === 'BACKGROUND-SUMMARY');
    assert.ok(summaries.length && summaries.every(request => request.ttl === '5m'), JSON.stringify(requests));
    const compaction = samples.find(sample => sample.turnId.startsWith('compaction:'));
    assert.ok(compaction, 'no compaction was recorded');
    const sent = real(requests).find(request => request.kind === 'MAIN' && request.at >= compaction.at);
    assert.ok(sent && sent.at - compaction.at <= 1500, JSON.stringify({ compaction: compaction.at, requests }));
    assert.ok(sent.at < real(requests).find(request => request.kind === 'BACKGROUND').done, 'the compaction waited for the subagent to finish');
    expectRecorded(requests, samples);
  });
