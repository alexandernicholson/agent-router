// A real Claude process against an in-process third-party Messages API.
// No inference service or real credentials are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

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
  const temporary = await mkdtemp(join(tmpdir(), 'agent-router-cache-live-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const plugin = join(temporary, 'plugin');
  const root = fileURLToPath(new URL('..', import.meta.url));
  await mkdir(plugin);
  for (const name of ['.claude-plugin', 'agents', 'commands', 'hooks', 'lib', 'scripts']) {
    await cp(join(root, name), join(plugin, name), { recursive: true });
  }
  const manifestPath = join(plugin, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const [key, config] of Object.entries(manifest.userConfig)) if (key.endsWith('_model')) config.default = 'vendor/test';
  await writeFile(manifestPath, JSON.stringify(manifest));
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
    CLAUDE_CONFIG_DIR: join(temporary, 'config'), CLAUDE_PLUGIN_DATA: join(temporary, 'data'),
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_SUBAGENT_MODEL', 'ANTHROPIC_CUSTOM_HEADERS']) delete env[key];
  const childProcess = spawn(process.env.CLAUDE_BINARY || 'claude', ['-p', 'Use a scout to reply briefly.', '--model', 'vendor/test',
    '--permission-mode', 'default', '--allowedTools', 'Agent,Task',
    '--output-format', 'json', '--plugin-dir', plugin], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
