import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

async function plugins(temporary, settings = {}) {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const copy = async (name, parts, defaults) => {
    const target = join(temporary, name);
    await mkdir(target);
    for (const part of parts) await cp(join(repo, name, part), join(target, part), { recursive: true });
    const manifestPath = join(target, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const [key, config] of Object.entries(manifest.userConfig)) {
      if (key.endsWith('_model')) config.default = 'vendor/test';
      if (key in defaults) config.default = defaults[key];
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    return target;
  };
  return { plugin: await copy('keepalive', ['.claude-plugin', 'hooks', 'lib', 'scripts'], settings),
    router: await copy('agent-router', ['.claude-plugin', 'agents', 'commands', 'hooks', 'lib', 'scripts'], {}) };
}

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.name.endsWith('.json')) result.push(JSON.parse(await readFile(path, 'utf8')));
  }
  return result;
}

test('live third-party main and child responses report mixed TTLs without configured lifetimes', { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'keepalive-cache-live-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { plugin, router } = await plugins(temporary);
  let requests = 0;
  const toolResults = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ data: [{ id: 'vendor/test', type: 'model', display_name: 'Test' }] }));
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    for (const message of body.messages || []) for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_result') toolResults.push(block.content);
    }
    if (request.url.includes('count_tokens')) return response.end('{"input_tokens":100}');
    requests++;
    const usage = { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 1500, output_tokens: 20,
      cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 1000 } };
    const block = requests === 1 ? { type: 'tool_use', id: 'toolu_child', name: 'Agent',
      input: { description: 'Cache probe', subagent_type: 'agent-router:scout', prompt: 'Reply briefly' } }
      : { type: 'text', text: 'cache probe complete' };
    const message = { id: `msg_probe_${requests}`, type: 'message', role: 'assistant', model: 'vendor/test',
      content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } };
    if (!body.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ ...message, content: [block], usage, stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn' }));
    }
    const start = block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' };
    const delta = block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
      : { type: 'text_delta', text: block.text };
    const events = [
      { type: 'message_start', message }, { type: 'content_block_start', index: 0, content_block: start },
      { type: 'content_block_delta', index: 0, delta }, { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage },
      { type: 'message_stop' },
    ];
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: 'dummy-test-key',
    CLAUDE_CONFIG_DIR: join(temporary, 'config'), CLAUDE_PLUGIN_DATA: join(temporary, 'data'), AGENT_ROUTER_DATA: join(temporary, 'data'),
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_SUBAGENT_MODEL', 'ANTHROPIC_CUSTOM_HEADERS']) delete env[key];
  const childProcess = spawn(process.env.CLAUDE_BINARY || 'claude', ['-p', 'Use a scout to reply briefly.', '--model', 'vendor/test',
    '--permission-mode', 'default', '--allowedTools', 'Agent,Task',
    '--output-format', 'json', '--plugin-dir', router, '--plugin-dir', plugin], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => childProcess.kill());
  let stdout = '', stderr = '';
  childProcess.stdout.on('data', chunk => { stdout += chunk; });
  childProcess.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { childProcess.once('error', reject); childProcess.once('close', resolve); });
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout.trim());
  assert.equal(result.is_error, false);
  assert.equal(result.subagent_stats.completed, 1, JSON.stringify({ result, stderr, toolResults }));
  const samples = await files(join(temporary, 'data', 'cache-samples'));
  const main = samples.filter(s => s.agentId === null);
  const agent = samples.find(s => s.agentId !== null);
  assert.ok(main.length >= 2);
  assert.ok(agent, 'subagent sample was persisted');
  for (const sample of main) {
    assert.equal(sample.ttlMs, null);
    assert.deepEqual(sample.cacheCreation, { fiveMinute: 500, oneHour: 1000 });
    assert.equal(sample.ttlSource, 'response cache_creation');
  }
  assert.equal(agent.ttlMs, null);
  assert.deepEqual(agent.cacheCreation, { fiveMinute: 500, oneHour: 1000 });
  assert.equal(agent.ttlSource, 'response cache_creation');
});

test('live: the main conversation asks for its own TTL and a subagent keeps the subagent default', { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'keepalive-cache-ttl-live-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { plugin, router } = await plugins(temporary, { cache_ttl: '1h' });
  const seen = [];
  let requests = 0;
  const marks = body => {
    const found = new Set();
    const walk = node => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if (node.cache_control) found.add(node.cache_control.ttl ?? '5m');
      for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
    };
    walk([body.system, body.messages]);
    return [...found].sort();
  };
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ data: [{ id: 'vendor/test', type: 'model', display_name: 'Test' }] }));
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    if (request.url.includes('count_tokens')) return response.end('{"input_tokens":100}');
    const body = JSON.parse(raw);
    const text = JSON.stringify(body.messages ?? []);
    const kind = text.includes('Use a scout') ? 'main' : text.includes('Reply briefly') ? 'subagent' : 'other';
    if (kind === 'other') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ id: `msg_other_${seen.length}`, type: 'message', role: 'assistant', model: 'vendor/test',
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    }
    if (kind === 'main') requests++;
    seen.push({ kind, ttls: marks(body) });
    const usage = { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 20 };
    const block = kind === 'main' && requests === 1 ? { type: 'tool_use', id: 'toolu_child', name: 'Agent',
      input: { description: 'Cache probe', subagent_type: 'agent-router:scout', prompt: 'Reply briefly' } } : { type: 'text', text: 'done' };
    const message = { id: `msg_${seen.length}`, type: 'message', role: 'assistant', model: 'vendor/test', content: [], stop_reason: null, stop_sequence: null, usage };
    if (!body.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ ...message, content: [block], stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn' }));
    }
    const start = block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' };
    const delta = block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text };
    const events = [{ type: 'message_start', message }, { type: 'content_block_start', index: 0, content_block: start },
      { type: 'content_block_delta', index: 0, delta }, { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage }, { type: 'message_stop' }];
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: 'dummy-test-key',
    CLAUDE_CONFIG_DIR: join(temporary, 'config'), CLAUDE_PLUGIN_DATA: join(temporary, 'data'), AGENT_ROUTER_DATA: join(temporary, 'data'),
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_SUBAGENT_MODEL', 'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_PROMPT_CACHE_TTL', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', 'ENABLE_PROMPT_CACHING_1H', 'FORCE_PROMPT_CACHING_5M']) delete env[key];
  const childProcess = spawn(process.env.CLAUDE_BINARY || 'claude', ['-p', 'Use a scout to reply briefly.', '--model', 'vendor/test',
    '--permission-mode', 'default', '--allowedTools', 'Agent,Task', '--output-format', 'json', '--plugin-dir', router, '--plugin-dir', plugin], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => childProcess.kill());
  let stderr = '';
  childProcess.stderr.on('data', chunk => { stderr += chunk; });
  assert.equal(await new Promise((resolve, reject) => { childProcess.once('error', reject); childProcess.once('close', resolve); }), 0, stderr);
  const main = seen.filter(request => request.kind === 'main');
  const subagent = seen.filter(request => request.kind === 'subagent');
  assert.ok(main.length >= 2 && subagent.length >= 1, JSON.stringify(seen));
  for (const request of main) assert.deepEqual(request.ttls, ['1h'], JSON.stringify(seen));
  for (const request of subagent) assert.deepEqual(request.ttls, ['5m'], JSON.stringify(seen));
});

test('live: Keepalive on its own measures a plain Claude Code session with no Agent Router installed', { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'keepalive-alone-live-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { plugin } = await plugins(temporary);
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ data: [{ id: 'vendor/test', type: 'model', display_name: 'Test' }] }));
    }
    for await (const chunk of request) void chunk;
    if (request.url.includes('count_tokens')) return response.end('{"input_tokens":100}');
    const usage = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000, output_tokens: 5,
      cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 } };
    const message = { id: 'msg_alone', type: 'message', role: 'assistant', model: 'vendor/test', content: [], stop_reason: null, stop_sequence: null, usage };
    const events = [{ type: 'message_start', message }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }, { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }, { type: 'message_stop' }];
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: 'dummy-test-key',
    CLAUDE_CONFIG_DIR: join(temporary, 'config'), CLAUDE_PLUGIN_DATA: join(temporary, 'data'),
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AGENT_ROUTER_DATA', 'CLAUDE_CODE_PROMPT_CACHE_TTL']) delete env[key];
  const childProcess = spawn(process.env.CLAUDE_BINARY || 'claude', ['-p', 'Say hi.', '--model', 'vendor/test', '--output-format', 'json', '--plugin-dir', plugin],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => childProcess.kill());
  let stderr = '';
  childProcess.stderr.on('data', chunk => { stderr += chunk; });
  assert.equal(await new Promise((resolve, reject) => { childProcess.once('error', reject); childProcess.once('close', resolve); }), 0, stderr);
  const samples = await files(join(temporary, 'data', 'cache-samples'));
  assert.equal(samples.length, 1);
  assert.equal(samples[0].agentId, null);
  assert.deepEqual(samples[0].cacheCreation, { fiveMinute: 2000, oneHour: 0 });
});
