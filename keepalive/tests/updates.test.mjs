import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkVersion, isNewer } from '../lib/updates.mjs';
import { handleRequest } from '../lib/bridge.mjs';

const DAY = 24 * 3600000;

async function world(t, { installed = '0.4.5', clone = '0.4.5', source = { source: 'github', repo: 'owner/tools' }, entry, inline = false, others = {} } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'keepalive-updates-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const write = async (path, value) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value)); };
  const plugin = join(base, 'cache', 'keepalive', installed);
  const market = join(base, 'market');
  const config = join(base, 'config');
  const data = join(base, 'data');
  await mkdir(data);
  await write(join(plugin, '.claude-plugin', 'plugin.json'), { name: 'keepalive', version: installed });
  await write(join(market, '.claude-plugin', 'marketplace.json'), { name: 'tools', plugins: [entry ?? { name: 'keepalive', source: './keepalive' }] });
  await write(join(market, 'keepalive', '.claude-plugin', 'plugin.json'), { name: 'keepalive', version: clone });
  await write(join(config, 'plugins', 'installed_plugins.json'), { version: 2, plugins: { ...others, ...(inline ? {} : { 'keepalive@tools': [{ scope: 'user', installPath: plugin, version: installed }] }) } });
  await write(join(config, 'plugins', 'known_marketplaces.json'), { tools: { source, installLocation: market } });
  return { plugin, config, data };
}

function remote(files) {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (files === 'offline') throw new Error('offline');
    const body = files[url];
    return body === undefined ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetcher, calls };
}

const RAW = 'https://raw.githubusercontent.com/owner/tools/HEAD';
const published = version => ({ [`${RAW}/.claude-plugin/marketplace.json`]: { plugins: [{ name: 'keepalive', source: './keepalive' }] },
  [`${RAW}/keepalive/.claude-plugin/plugin.json`]: { version } });

test('versions compare by their numbers, so 0.10.0 is newer than 0.9.9, and anything unreadable is never newer', () => {
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('0.4.5', '0.4.5'), false);
  assert.equal(isNewer('0.4.4', '0.4.5'), false);
  assert.equal(isNewer('v1.0.0', '0.9.0'), true);
  assert.equal(isNewer('1.0.0-beta', '0.9.0'), false);
  assert.equal(isNewer(null, '0.9.0'), false);
  assert.equal(isNewer('0.4.6', undefined), true);
});

test('a newer version in the marketplace copy Claude Code keeps is found without going online', async t => {
  const { plugin, config, data } = await world(t, { clone: '0.4.6' });
  const { fetcher, calls } = remote({});
  const found = await checkVersion({ root: data, pluginRoot: plugin, configDir: config, env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, fetcher });
  assert.deepEqual(found, { current: '0.4.5', latest: '0.4.6', plugin: 'keepalive@tools', marketplace: 'tools' });
  assert.deepEqual(calls, []);
});

test('a newer version published on GitHub is found, checked once a day, and the newer of the two copies wins', async t => {
  const { plugin, config, data } = await world(t, { clone: '0.4.6' });
  const { fetcher, calls } = remote(published('0.5.0'));
  const now = 1_000_000;
  const check = at => checkVersion({ root: data, pluginRoot: plugin, configDir: config, env: {}, fetcher, now: at });
  assert.equal((await check(now)).latest, '0.5.0');
  assert.deepEqual(calls, [`${RAW}/.claude-plugin/marketplace.json`, `${RAW}/keepalive/.claude-plugin/plugin.json`]);
  assert.equal((await check(now + DAY - 1)).latest, '0.5.0');
  assert.equal(calls.length, 2);
  await check(now + DAY);
  assert.equal(calls.length, 4);
});

test('a failed check keeps what the marketplace copy says and is retried after an hour, not before', async t => {
  const { plugin, config, data } = await world(t, { clone: '0.4.6' });
  const { fetcher, calls } = remote('offline');
  const check = at => checkVersion({ root: data, pluginRoot: plugin, configDir: config, env: {}, fetcher, now: at });
  assert.equal((await check(0)).latest, '0.4.6');
  await check(3600000 - 1);
  assert.equal(calls.length, 1);
  await check(3600000);
  assert.equal(calls.length, 2);
});

test('nothing newer, an older published version, or a plugin not installed from a marketplace shows no update', async t => {
  const same = await world(t);
  assert.equal((await checkVersion({ root: same.data, pluginRoot: same.plugin, configDir: same.config, env: {}, fetcher: remote(published('0.4.4')).fetcher })).latest, null);
  const inline = await world(t, { inline: true, clone: '0.9.0', others: { 'agent-router@tools': [{ installPath: join(tmpdir(), 'nowhere') }, { installPath: 7 }], broken: 'not a list' } });
  const { fetcher, calls } = remote(published('0.9.0'));
  assert.deepEqual(await checkVersion({ root: inline.data, pluginRoot: inline.plugin, configDir: inline.config, env: {}, fetcher }),
    { current: '0.4.5', latest: null, plugin: null, marketplace: null });
  assert.deepEqual(calls, []);
});

test('a version the marketplace lists itself is used, and sources outside the marketplace or not on GitHub are never followed', async t => {
  const listed = await world(t, { entry: { name: 'keepalive', source: './keepalive', version: '0.6.0' }, source: { source: 'git', url: 'https://example.com/tools.git' } });
  const { fetcher, calls } = remote({});
  assert.equal((await checkVersion({ root: listed.data, pluginRoot: listed.plugin, configDir: listed.config, env: {}, fetcher })).latest, '0.6.0');
  assert.deepEqual(calls, []);
  const escaping = await world(t, { entry: { name: 'keepalive', source: '../elsewhere' }, source: { source: 'github', repo: 'owner/tools; rm -rf', ref: '../main' } });
  const unsafe = remote({});
  assert.equal((await checkVersion({ root: escaping.data, pluginRoot: escaping.plugin, configDir: escaping.config, env: {}, fetcher: unsafe.fetcher })).latest, null);
  assert.deepEqual(unsafe.calls, []);
});

test('a marketplace pinned to a ref is checked at that ref', async t => {
  const pinned = await world(t, { source: { source: 'github', repo: 'owner/tools', ref: 'release/1' } });
  const base = 'https://raw.githubusercontent.com/owner/tools/release/1';
  const { fetcher, calls } = remote({ [`${base}/.claude-plugin/marketplace.json`]: { plugins: [{ name: 'keepalive', source: './keepalive/' }] },
    [`${base}/keepalive/.claude-plugin/plugin.json`]: { version: '0.4.7' } });
  assert.equal((await checkVersion({ root: pinned.data, pluginRoot: pinned.plugin, configDir: pinned.config, env: {}, fetcher })).latest, '0.4.7');
  assert.equal(calls[0], `${base}/.claude-plugin/marketplace.json`);
});

test('the bridge answers version requests for the installed plugin', async t => {
  const { plugin, config, data } = await world(t, { clone: '0.4.8' });
  const found = await handleRequest({ action: 'version' }, { CLAUDE_PLUGIN_DATA: data, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, { root: plugin, configDir: config });
  assert.equal(found.latest, '0.4.8');
});

test('a GitHub answer that is not a success or is too large counts as a failed check', async t => {
  const { plugin, config, data } = await world(t);
  const check = (fetcher, now) => checkVersion({ root: data, pluginRoot: plugin, configDir: config, env: {}, fetcher, now });
  let cancelled = 0;
  const missing = async () => ({ ok: false, status: 404, body: { cancel: async () => { cancelled++; } }, text: async () => '' });
  assert.equal((await check(missing, 0)).latest, null);
  assert.equal(cancelled, 1);
  const huge = async () => ({ ok: true, status: 200, text: async () => ' '.repeat(300 * 1024) });
  assert.equal((await check(huge, 3600000)).latest, null);
  const fine = remote(published('0.4.9'));
  assert.equal((await check(fine.fetcher, 3600000 + 1)).latest, null);
  assert.equal((await check(fine.fetcher, 2 * 3600000)).latest, '0.4.9');
});
