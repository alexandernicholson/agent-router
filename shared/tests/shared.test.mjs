import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { displayText } from '../lib/text.js';
import { sameModel, isTeammate, isPaneTeammate, isTruthy } from '../lib/models.js';
import { recordPath, writeRecord, readRecord, listRecords, idKey } from '../lib/records.mjs';
import { resolvePluginData, dataName } from '../lib/bridge-main.mjs';
import { writeRoutes, readRoutes, validRoutes, ROUTER_DATA } from '../lib/routes.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-router-shared-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('display text drops terminal controls and keeps a safe length', () => {
  assert.equal(displayText('a\u001b[31mred\u001b[0m\u0007 b', 40), 'ared b');
  assert.equal(displayText(42, 10), '');
  assert.equal(displayText('x'.repeat(50), 10), 'x'.repeat(10));
});

test('model and agent helpers agree in both plugins', () => {
  assert.equal(sameModel('claude-opus-5-5[1m]', 'claude-opus-5-5'), true);
  assert.equal(sameModel('a', 'b'), false);
  assert.equal(isTruthy('1'), true);
  assert.equal(isTruthy('off'), false);
  assert.equal(isTeammate({ id: 'a', type: 'teammate' }), true);
  assert.equal(isTeammate({ id: 'a', type: 'agent-router:scout', teammateId: 'x@team' }), true);
  assert.equal(isPaneTeammate({ id: 'x@team', type: 'agent-router:task', teammateId: 'x@team' }), true);
  assert.equal(isPaneTeammate({ id: 'a', type: 'agent-router:task', teammateId: 'x@team' }), false);
});

test('records are written privately and listed by session', async t => {
  const directory = await temp(t);
  const file = recordPath(directory, 'kind', 'session', 'one');
  await writeRecord(file, { value: 1 });
  await writeRecord(file, { value: 2 }, true);
  assert.deepEqual(await readRecord(file), { value: 1 });
  assert.deepEqual(await listRecords(directory, 'kind', 'session'), [{ value: 1 }]);
  assert.equal(await readRecord(join(directory, 'missing.json')), null);
  assert.throws(() => idKey(''), /identity/);
});

test('each plugin finds its own data folder from its installed identity', async t => {
  const directory = await temp(t);
  const config = join(directory, 'config');
  const plugin = join(directory, 'keepalive');
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
  await mkdir(join(config, 'plugins'), { recursive: true });
  await writeFile(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'keepalive' }));
  await writeFile(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'agent-router@agent-router-tools': [{ installPath: join(directory, 'router') }],
    'keepalive@agent-router-tools': [{ installPath: join(directory, 'elsewhere') }] } }));
  const found = resolvePluginData(plugin, { CLAUDE_CONFIG_DIR: config });
  assert.equal(found.dataDir, join(config, 'plugins', 'data', 'keepalive-agent-router-tools'));
  assert.equal(found.pluginId, 'keepalive@agent-router-tools');
  assert.equal(ROUTER_DATA, dataName('agent-router@agent-router-tools'));
  assert.equal(resolvePluginData(plugin, { CLAUDE_PLUGIN_DATA: '/explicit' }).dataDir, '/explicit');
});

test('published routes are versioned, validated, and nothing else is accepted', async t => {
  const directory = await temp(t);
  const routes = { sessionId: 'lead', leadSessionId: null, self: { role: 'task', model: 'vendor/task-v1', effort: 'low' },
    teammate: { agentId: 'w@team', name: null }, agents: [{ agentId: 'a1', kind: 'subagent', role: 'scout', model: 'vendor/search-v1' }], teammates: ['pane'] };
  await writeRoutes(directory, routes);
  assert.deepEqual(await readRoutes(directory, 'lead'), { version: 1, ...routes });
  assert.equal(validRoutes({ ...routes, version: 2 }), null);
  assert.equal(validRoutes({ version: 1, ...routes, self: { role: 'task', model: 'x', effort: 'turbo' } }), null);
  assert.equal(validRoutes({ version: 1, ...routes, agents: [{ agentId: 'a', kind: 'robot', role: 'scout', model: 'm' }] }), null);
  await assert.rejects(writeRoutes(directory, { ...routes, teammates: 'pane' }), /Invalid/);
});

test('both plugins carry an exact copy of the shared library', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'sync-shared.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('the router hands over only its cache choices, once, and keeps nothing else', async t => {
  const { writeHandover, readHandover } = await import('../lib/routes.mjs');
  const directory = await temp(t);
  await writeHandover(directory, { 'cache-intro': 1, 'cache-ttl': [['s', 'k', '1h']], 'agent-models:x': { secret: 1 }, 'cache-upkeep': 'bad' });
  assert.deepEqual(await readHandover(directory), { 'cache-intro': 1, 'cache-ttl': [['s', 'k', '1h']] });
  await writeHandover(directory, { 'cache-intro': 2 });
  assert.deepEqual((await readHandover(directory))['cache-intro'], 1);
  assert.equal(await readHandover(join(directory, 'none')), null);
});
