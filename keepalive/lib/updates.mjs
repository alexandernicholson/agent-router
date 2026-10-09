import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { writeRecord } from './state.mjs';
import { isTruthy } from './shared/models.js';

const FRESH_MS = 24 * 3600000;
const RETRY_MS = 3600000;
const LIMIT = 256 * 1024;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const REF = /^[\w./-]+$/;

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

/** @param {unknown} value */
function parts(value) {
  const match = typeof value === 'string' ? /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim()) : null;
  return match ? match.slice(1).map(Number) : null;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
export function isNewer(a, b) {
  const left = parts(a);
  const right = parts(b);
  if (!left) return false;
  if (!right) return true;
  const index = left.findIndex((part, at) => part !== right[at]);
  return index >= 0 && left[index] > right[index];
}

function pluginSource(catalog, name) {
  const entry = Array.isArray(catalog?.plugins) ? catalog.plugins.find(item => item?.name === name) : undefined;
  if (typeof entry?.version === 'string') return { version: entry.version };
  const source = entry?.source;
  if (typeof source !== 'string' || !source.startsWith('./') || source.split('/').includes('..')) return null;
  return { path: source.slice(2).replace(/\/+$/, '') };
}

async function installedId(configDir, pluginRoot) {
  const registry = await readJson(join(configDir, 'plugins', 'installed_plugins.json'));
  const own = await realpath(pluginRoot).catch(() => pluginRoot);
  for (const [id, installs] of Object.entries(registry?.plugins ?? {})) {
    if (!Array.isArray(installs)) continue;
    for (const install of installs) {
      if (typeof install?.installPath === 'string' && await realpath(install.installPath).catch(() => null) === own) return id;
    }
  }
  return null;
}

async function cloneVersion(location, name) {
  if (typeof location !== 'string') return null;
  const source = pluginSource(await readJson(join(location, '.claude-plugin', 'marketplace.json')), name);
  if (!source) return null;
  if (source.version) return source.version;
  return (await readJson(join(location, source.path, '.claude-plugin', 'plugin.json')))?.version ?? null;
}

async function fetchJson(fetcher, url) {
  const response = await fetcher(url, { headers: { accept: 'application/json', 'user-agent': 'keepalive' }, redirect: 'follow', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text.length > LIMIT) throw new Error(`${url} is too large`);
  return JSON.parse(text);
}

async function githubVersion(fetcher, source, name) {
  if (source?.source !== 'github' || typeof source.repo !== 'string' || !REPO.test(source.repo)) return null;
  const ref = typeof source.ref === 'string' && REF.test(source.ref) && !source.ref.split('/').includes('..') ? source.ref : 'HEAD';
  const base = `https://raw.githubusercontent.com/${source.repo}/${ref}`;
  const found = pluginSource(await fetchJson(fetcher, `${base}/.claude-plugin/marketplace.json`), name);
  if (!found) return null;
  if (found.version) return found.version;
  return (await fetchJson(fetcher, `${base}/${found.path}/.claude-plugin/plugin.json`))?.version ?? null;
}

/**
 * @param {{ root: string, pluginRoot: string, configDir: string, env: Record<string, string | undefined>, fetcher?: typeof fetch, now?: number }} input
 */
export async function checkVersion({ root, pluginRoot, configDir, env, fetcher = fetch, now = Date.now() }) {
  const manifest = await readJson(join(pluginRoot, '.claude-plugin', 'plugin.json'));
  const current = typeof manifest?.version === 'string' ? manifest.version : null;
  const id = await installedId(configDir, pluginRoot);
  const at = id?.lastIndexOf('@') ?? -1;
  if (!id || at < 1 || !current) return { current, latest: null, plugin: id, marketplace: null };
  const name = id.slice(0, at);
  const marketplace = id.slice(at + 1);
  const known = (await readJson(join(configDir, 'plugins', 'known_marketplaces.json')))?.[marketplace];
  const local = await cloneVersion(known?.installLocation, name);
  const file = join(root, 'updates.json');
  let cached = await readJson(file);
  if (cached?.plugin !== id) cached = null;
  const fresh = Number.isSafeInteger(cached?.checkedAt) && now - cached.checkedAt < FRESH_MS;
  const waiting = Number.isSafeInteger(cached?.failedAt) && now - cached.failedAt < RETRY_MS;
  if (!fresh && !waiting && !isTruthy(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)) {
    try { cached = { plugin: id, checkedAt: now, latest: await githubVersion(fetcher, known?.source, name) }; }
    catch { cached = { ...(cached ?? { plugin: id }), failedAt: now }; }
    await writeRecord(file, cached).catch(() => {});
  }
  const remote = typeof cached?.latest === 'string' ? cached.latest : null;
  const latest = [local, remote].filter(version => isNewer(version, current)).sort((a, b) => isNewer(a, b) ? -1 : 1)[0] ?? null;
  return { current, latest, plugin: id, marketplace };
}
