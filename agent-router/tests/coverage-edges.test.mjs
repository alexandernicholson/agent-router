import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleRequest } from '../lib/bridge.mjs';
import { policyFromOptions } from '../lib/policy.mjs';
import { validatePolicy, routeAgent } from '../lib/routing.js';
import { normalizeCatalog } from '../lib/catalog.js';
import { fetchModels } from '../lib/connection.mjs';
import { publishRoutes } from '../lib/published.mjs';
import { readRoutes } from '../lib/shared/routes.mjs';
import { routingStatus, sessionStats, recordPath, writeRecord, linkTeammate } from '../lib/state.mjs';
import { modelOptions } from './fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const policy = policyFromOptions(modelOptions);
const catalog = async () => Object.values(policy.roles).map(({ model }) => ({ id: model }));

async function temp(t, name = 'agent-router-edges-') {
  const directory = await mkdtemp(join(tmpdir(), name));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const valid = () => JSON.parse(JSON.stringify(policy));

test('a policy object with a malformed shape is refused field by field', () => {
  assert.throws(() => validatePolicy(null), /version 1/);
  assert.throws(() => validatePolicy({ ...valid(), extra: 1 }), /Unknown routing policy field/);
  assert.throws(() => validatePolicy({ ...valid(), teammate: {} }), /teammate override/);
  assert.throws(() => validatePolicy({ ...valid(), teammate: { model: 'opus' } }), /teammate override/);
  assert.throws(() => validatePolicy({ ...valid(), roles: { ...valid().roles, extra: valid().roles.scout } }), /exactly/);
  const roles = valid().roles;
  assert.throws(() => validatePolicy({ ...valid(), roles: { ...roles, scout: { ...roles.scout, model: 'sonnet' } } }), /exact model ID/);
  assert.throws(() => validatePolicy({ ...valid(), roles: { ...roles, scout: { ...roles.scout, effort: 'turbo' } } }), /invalid effort/);
  assert.throws(() => validatePolicy({ ...valid(), roles: { ...roles, scout: { ...roles.scout, aliases: ['fork'] } } }), /invalid aliases/);
  assert.throws(() => validatePolicy({ ...valid(), roles: { ...roles, task: { ...roles.task, aliases: ['scout'] } } }), /Duplicate agent alias: scout/);
  assert.throws(() => policyFromOptions(null), /must be an object/);
  assert.throws(() => policyFromOptions([]), /must be an object/);
});

test('a catalog that is not a list is refused before anything is read from it', () => {
  assert.throws(() => normalizeCatalog({ data: [] }), /model catalog array/);
});

test('a route without a known parent agent, an unknown result shape, and an unknown action are refused', async t => {
  const data = await temp(t);
  const env = { CLAUDE_PLUGIN_DATA: data, ANTHROPIC_BASE_URL: 'https://gateway.example' };
  const request = (action, fields = {}) => handleRequest({ action, session_id: 'one', options: modelOptions, ...fields }, env, catalog);
  await request('bootstrap');
  await assert.rejects(request('route', { agent_id: '', tool_use_id: 'x', effectiveType: 'agent-router:scout' }), /identity/);
  await request('route', { agent_id: 'parent', tool_use_id: 'call', effectiveType: 'agent-router:scout' });
  await assert.rejects(request('result', { tool_use_id: 'call', result: [] }), /agent result object/);
  await assert.rejects(request('result', { tool_use_id: 'missing', result: {} }), /routing decision/);
  await assert.rejects(handleRequest(null, env, catalog), /bridge JSON object/);
  await assert.rejects(handleRequest([], env, catalog), /bridge JSON object/);
  assert.deepEqual(await request('handover', { values: { 'cache-intro': 1 } }), {});
});

test('a bootstrap that loses a race to another process refuses rather than mixing two policies', async t => {
  const data = await temp(t);
  const env = { CLAUDE_PLUGIN_DATA: data, ANTHROPIC_BASE_URL: 'https://gateway.example' };
  const file = recordPath(data, 'sessions', 'raced');
  const racing = async () => {
    await writeRecord(file, { sessionId: 'raced', digest: 'someone-else', gateway: 'https://gateway.example', active: true, policy });
    return Object.values(policy.roles).map(({ model }) => ({ id: model }));
  };
  await assert.rejects(handleRequest({ action: 'bootstrap', session_id: 'raced', options: modelOptions }, env, racing), /Conflicting concurrent/);
});

test('a split-pane teammate that loses its bootstrap race refuses, and an unnamed one is recorded without a name', async t => {
  const data = await temp(t);
  const config = await temp(t);
  const lead = 'lead-session';
  const team = 'session-lead';
  await mkdir(join(config, 'teams', team), { recursive: true });
  await writeFile(join(config, 'teams', team, 'config.json'), JSON.stringify({ name: team, leadSessionId: lead,
    members: [{ agentId: `mate@${team}`, name: 'mate' }] }));
  const env = { CLAUDE_PLUGIN_DATA: data, CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: 'https://gateway.example' };
  await handleRequest({ action: 'bootstrap', session_id: lead, options: modelOptions }, env, catalog);
  const identity = { agentId: `mate@${team}`, teamName: team, parentSessionId: lead };
  assert.equal((await handleRequest({ action: 'bootstrap', session_id: 'odd', options: modelOptions, teammate: 'not-an-object' }, env, catalog)).teammateNotice?.includes('could not confirm'), true);
  const snapshot = await handleRequest({ action: 'bootstrap', session_id: 'mate-session', options: modelOptions, teammate: identity }, env, catalog);
  assert.deepEqual(snapshot.teammate, { agentId: `mate@${team}`, name: null, teamName: team, agentType: null });
  assert.equal(snapshot.self.role, 'task');
  await writeFile(join(config, 'teams', team, 'config.json'), JSON.stringify({ name: team, leadSessionId: 'resumed-lead',
    members: [{ agentId: `mate@${team}`, name: 'mate' }] }));
  const stolen = recordPath(data, 'sessions', 'stolen');
  const racing = handleRequest({ action: 'bootstrap', session_id: 'stolen', options: modelOptions, teammate: identity }, env, catalog, { confirmMs: 400, stepMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 40));
  await writeRecord(stolen, { sessionId: 'stolen', leadSessionId: 'someone-else', active: true, gateway: 'https://gateway.example' });
  await writeRecord(recordPath(data, 'agents', lead, `mate@${team}`), { kind: 'teammate', agentId: `mate@${team}` });
  await assert.rejects(racing, /Conflicting concurrent/);
});

test('an unnamed teammate route and result are recorded without a name', async t => {
  const data = await temp(t);
  const env = { CLAUDE_PLUGIN_DATA: data, ANTHROPIC_BASE_URL: 'https://gateway.example' };
  const request = (action, fields = {}) => handleRequest({ action, session_id: 'one', options: modelOptions, ...fields }, env, catalog);
  await request('bootstrap');
  await request('route', { kind: 'teammate', tool_use_id: 'call', effectiveType: 'agent-router:task' });
  await request('result', { tool_use_id: 'call', result: { agentId: 'mate@t', model: 'vendor/task-v1' } });
  const routes = await readRoutes(data, 'one');
  assert.deepEqual(routes.agents, [{ agentId: 'mate@t', kind: 'teammate', role: 'task', model: 'vendor/task-v1', name: null, backend: null }]);
});

test('an empty routes report says so', async t => {
  const data = await temp(t);
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'status.mjs'), '--data', data], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.includes('No routing records found.'), true);
});

test('published routes fall back to empty names, backends and lists, and skip a session record without an id', async t => {
  const data = await temp(t);
  assert.equal(await publishRoutes(data, null, []), null);
  assert.equal(await publishRoutes(data, {}, []), null);
  await linkTeammate(data, 'lead', 'pane');
  const routes = await publishRoutes(data, { sessionId: 'lead', active: true, policy, self: { role: 'task', model: 'vendor/task-v1' }, teammate: { agentId: 'w@t' } },
    [{ agentId: 'mate@t', role: 'task', effectiveModel: 'vendor/task-v1', kind: 'teammate' }, { agentId: 7, role: 'task', effectiveModel: 'x' }]);
  assert.deepEqual(routes.self, { role: 'task', model: 'vendor/task-v1' });
  assert.deepEqual(routes.teammate, { agentId: 'w@t', name: null });
  assert.deepEqual(routes.agents, [{ agentId: 'mate@t', kind: 'teammate', role: 'task', model: 'vendor/task-v1', name: null, backend: null }]);
  assert.deepEqual(routes.teammates, ['pane']);
  assert.deepEqual((await readRoutes(data, 'lead')).teammates, ['pane']);
});

test('stats and status skip records that do not belong to the session they are read for', async t => {
  const data = await temp(t);
  await writeRecord(recordPath(data, 'routes', 'one', 'a'), { sessionId: 'other', toolUseId: 'a', effectiveModel: 'm', createdAt: '2026-01-01' });
  await writeRecord(recordPath(data, 'routes', 'one', 'b'), { sessionId: 'one', toolUseId: 'b', effectiveModel: 'm', createdAt: '2026-01-01' });
  await writeRecord(recordPath(data, 'routes', 'one', 'c'), { sessionId: 'one', toolUseId: 'c', effectiveModel: 'm', createdAt: '2026-01-01' });
  await writeRecord(recordPath(data, 'observations', 'one', 'x'), { sessionId: 'one', agentId: 'a', turnId: 't', responseModels: [], usage: {} });
  await writeRecord(recordPath(data, 'observations', 'one', 'y'), { sessionId: 'one', agentId: 'a', turnId: 't', responseModels: [], usage: {} });
  await writeRecord(recordPath(data, 'observations', 'one', 'z'), { sessionId: 'one', agentId: 'a', responseModels: [], usage: {} });
  assert.equal((await sessionStats(data, 'one')).routed, 2);
  const status = await routingStatus(data, 'one');
  assert.deepEqual(status.routes.map(route => route.toolUseId), ['a', 'b', 'c']);
});

test('discovery explains a refusal whether or not credentials were sent, and reads a cursor from the last row', async t => {
  const { createServer } = await import('node:http');
  const serve = handler => new Promise(resolve => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => { t.after(() => new Promise(done => server.close(done))); resolve(`http://127.0.0.1:${server.address().port}`); });
  });
  const refused = await serve((req, res) => { res.writeHead(403); res.end(); });
  await assert.rejects(fetchModels({ env: { ANTHROPIC_API_KEY: 'k' }, baseUrl: refused, retryMs: 1 }), /x-api-key set, Authorization unset.*Check these credentials/);
  await assert.rejects(fetchModels({ env: { ANTHROPIC_AUTH_TOKEN: 't' }, baseUrl: refused, retryMs: 1 }), /x-api-key unset, Authorization set/);
  await assert.rejects(fetchModels({ env: {}, baseUrl: refused, retryMs: 1 }), /Set ANTHROPIC_API_KEY/);
  let page = 0;
  const paged = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(page++ ? { data: [{ id: 'vendor/b' }], has_more: false } : { data: [{ id: 'vendor/a' }], has_more: true }));
  });
  assert.deepEqual((await fetchModels({ env: {}, baseUrl: paged })).map(m => m.id), ['vendor/a', 'vendor/b']);
  const empty = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [], has_more: true })); });
  await assert.rejects(fetchModels({ env: {}, baseUrl: empty }), /non-advancing/);
  const big = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(`{"data":[${'{"id":"vendor/x"},'.repeat(600000)}{"id":"vendor/y"}]}`); });
  await assert.rejects(fetchModels({ env: {}, baseUrl: big }), /size limit/);
  const malformed = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ name: 'no id' }] })); });
  await assert.rejects(fetchModels({ env: {}, baseUrl: malformed }), /exact string IDs/);
  const bare = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('null'); });
  await assert.rejects(fetchModels({ env: {}, baseUrl: bare }), /exact string IDs/);
  const headers = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'vendor/a' }] })); });
  await assert.rejects(fetchModels({ env: { ANTHROPIC_CUSTOM_HEADERS: 'no-colon-here' }, baseUrl: headers }), /headers are invalid/);
  assert.deepEqual((await fetchModels({ env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Empty:\n\nX-Real: 1' }, baseUrl: headers })).map(m => m.id), ['vendor/a']);
});

test('the gateway discovery cache is read from the home folder when no config folder is set, and a large cache is ignored', async t => {
  const { createServer } = await import('node:http');
  const home = await temp(t);
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'vendor/live' }] })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(done => server.close(done)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await mkdir(join(home, '.claude', 'cache'), { recursive: true });
  await writeFile(join(home, '.claude', 'cache', 'gateway-models.json'), JSON.stringify({ baseUrl, models: [{ id: 'vendor/cached' }] }));
  const ids = env => fetchModels({ env: { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1', ...env }, baseUrl }).then(models => models.map(m => m.id).sort());
  assert.deepEqual(await ids({ HOME: home }), ['vendor/cached', 'vendor/live']);
  assert.deepEqual(await ids({ USERPROFILE: home }), ['vendor/cached', 'vendor/live']);
  const { homedir } = await import('node:os');
  const real = join(homedir(), '.claude', 'cache', 'gateway-models.json');
  assert.ok((await ids({})).includes('vendor/live'), real);
  await writeFile(join(home, '.claude', 'cache', 'gateway-models.json'), JSON.stringify({ baseUrl, models: [{ id: 'vendor/cached' }], pad: 'x'.repeat(9 * 1024 * 1024) }));
  assert.deepEqual(await ids({ HOME: home }), ['vendor/live']);
});

test('the routes report runs from the command line, as text and as JSON, and refuses bad arguments', async t => {
  const data = await temp(t);
  const env = { CLAUDE_PLUGIN_DATA: data, ANTHROPIC_BASE_URL: 'https://gateway.example' };
  await handleRequest({ action: 'bootstrap', session_id: 'one', options: modelOptions }, env, catalog);
  await handleRequest({ action: 'route', session_id: 'one', options: modelOptions, tool_use_id: 'call', requestedType: 'Explore', effectiveType: 'agent-router:scout' }, env, catalog);
  await handleRequest({ action: 'result', session_id: 'one', options: modelOptions, tool_use_id: 'call', result: { agentId: 'a1', model: 'vendor/other' } }, env, catalog);
  const status = join(root, 'scripts', 'status.mjs');
  const run = (args, extra = {}) => spawnSync(process.execPath, [status, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...extra } });
  const text = run(['--data', data]);
  assert.equal(text.status, 0, text.stderr);
  for (const part of ['"one"', '"scout"', '"vendor/other"', 'not recorded']) assert.equal(text.stdout.includes(part), true, part);
  assert.equal(JSON.parse(run(['--data', data, '--json', '--session', 'one']).stdout).routes.length, 1);
  assert.equal(JSON.parse(run(['--json'], { CLAUDE_PLUGIN_DATA: data }).stdout).routes.length, 1);
  assert.equal(run(['--bogus']).status, 1);
  assert.equal(run(['--session', '']).status, 1);
  assert.equal(run(['--session', 'x'.repeat(513)]).status, 1);
  assert.equal(run([]).status, 1);
  const unreadable = join(data, 'routes');
  await chmod(unreadable, 0o000);
  const failed = run(['--data', data]);
  await chmod(unreadable, 0o700);
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
});

test('a route for a type no role covers names the type it could not route', () => {
  assert.throws(() => routeAgent(policy, { subagentType: 'other-plugin:agent' }), /other-plugin:agent/);
});
