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

test('records surface every error but a missing file, and listing skips names it did not write', async t => {
  const directory = await temp(t);
  await mkdir(join(directory, 'kind', 'not-a-hash'), { recursive: true });
  const session = idKey('session');
  await mkdir(join(directory, 'kind', session), { recursive: true });
  await writeFile(join(directory, 'kind', session, 'stray.txt'), 'x');
  await writeRecord(recordPath(directory, 'kind', 'session', 'one'), { value: 1 });
  assert.deepEqual(await listRecords(directory, 'kind'), [{ value: 1 }]);
  assert.deepEqual(await listRecords(directory, 'kind', 'absent'), []);
  assert.deepEqual(await listRecords(directory, 'missing'), []);
  const broken = join(directory, 'broken.json');
  await writeFile(broken, '{');
  await assert.rejects(readRecord(broken), SyntaxError);
  await writeFile(join(directory, 'flat'), 'x');
  await assert.rejects(listRecords(directory, 'flat'), /ENOTDIR/);
  await mkdir(join(directory, 'nested', session), { recursive: true });
  await writeFile(join(directory, 'nested', idKey('x')), 'x');
  await assert.rejects(listRecords(directory, 'nested', 'x'), /ENOTDIR/);
  await mkdir(join(directory, 'taken'));
  await assert.rejects(writeRecord(join(directory, 'taken'), { a: 1 }), /EISDIR|EPERM|ENOTEMPTY|EEXIST/);
  await mkdir(join(directory, 'exclusive'));
  await assert.rejects(writeRecord(join(directory, 'exclusive', 'dir', 'x.json'), 1, true).then(async () => {
    await mkdir(join(directory, 'exclusive', 'blocked.json'));
    await writeRecord(join(directory, 'exclusive', 'blocked.json', 'nope', 'deeper'), 1);
    const { chmod } = await import('node:fs/promises');
    await chmod(join(directory, 'exclusive', 'blocked.json'), 0o500);
    try { await writeRecord(join(directory, 'exclusive', 'blocked.json', 'locked.json'), 1, true); }
    finally { await chmod(join(directory, 'exclusive', 'blocked.json'), 0o700); }
  }), /EACCES/);
  const { chmod } = await import('node:fs/promises');
  const locked = join(directory, 'locked');
  await mkdir(locked);
  await chmod(locked, 0o000);
  try { await assert.rejects(listRecords(directory, 'locked'), /EACCES/); }
  finally { await chmod(locked, 0o700); }
});

test('published routes refuse a malformed teammate, and a handover keeps only well-formed values', async t => {
  const { validHandover, readRoutes: read, routesFile } = await import('../lib/routes.mjs');
  const base = { version: 1, sessionId: 'lead', leadSessionId: null, self: null, agents: [], teammates: [] };
  assert.equal(validRoutes({ ...base, teammate: { agentId: '' , name: null } }), null);
  assert.equal(validRoutes({ ...base, teammate: { agentId: 'a', name: 7 } }), null);
  assert.equal(validRoutes({ ...base, teammate: null }) !== null, true);
  assert.deepEqual(validHandover({ 'cache-intro': 'yes', 'cache-upkeep': [['s', 'warm']] }), { 'cache-upkeep': [['s', 'warm']] });
  assert.equal(validHandover({ 'cache-ttl': Array(10).fill(['s', 'k', 'x'.repeat(8000)]) }), null);
  assert.equal(validHandover([]), null);
  const directory = await temp(t);
  await mkdir(routesFile(directory, 'lead'), { recursive: true });
  assert.equal(await read(directory, 'lead'), null);
});

test('the sync script copies, updates and prunes shared files, and --check reports drift without writing', async t => {
  const directory = await temp(t);
  const script = join(root, 'scripts', 'sync-shared.mjs');
  const run = (...args) => spawnSync(process.execPath, [script, `--root=${directory}`, ...args], { encoding: 'utf8' });
  await mkdir(join(directory, 'shared', 'lib'), { recursive: true });
  await mkdir(join(directory, 'shared', 'hooks'), { recursive: true });
  await writeFile(join(directory, 'shared', 'lib', 'a.js'), 'one');
  await writeFile(join(directory, 'shared', 'hooks', 'b.ts'), 'two');
  await mkdir(join(directory, 'keepalive', 'lib', 'shared', 'nested'), { recursive: true });
  await writeFile(join(directory, 'keepalive', 'lib', 'shared', 'stale.js'), 'old');
  const checked = run('--check');
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /keepalive\/lib\/shared\/stale\.js \(not in shared\/lib\)/);
  assert.match(checked.stderr, /agent-router\/lib\/shared\/a\.js/);
  const synced = run();
  assert.equal(synced.status, 0, synced.stderr);
  assert.match(synced.stdout, /Synced 6 file\(s\)/);
  assert.equal(await readFile(join(directory, 'pi-keepalive', 'lib', 'core', 'shared', 'a.js'), 'utf8'), 'one');
  assert.equal(await readFile(join(directory, 'agent-router', 'hooks', 'shared', 'b.ts'), 'utf8'), 'two');
  assert.equal(run().stdout, 'Shared library copies are current.\n');
  assert.equal(run('--check').status, 0);
  await writeFile(join(directory, 'shared', 'lib', 'a.js'), 'changed');
  assert.match(run().stdout, /Synced 3 file\(s\)/);
  await rm(join(directory, 'shared', 'hooks'), { recursive: true });
  await writeFile(join(directory, 'shared', 'hooks'), 'not a folder');
  const broken = run();
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /ENOTDIR/);
});
