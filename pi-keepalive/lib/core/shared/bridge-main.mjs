import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readTeammateIdentity } from './teammate.mjs';

const LIMIT = 8 * 1024 * 1024;

export const dataName = id => id.replace(/[^a-zA-Z0-9_-]/g, '-');

export function resolvePluginData(root, env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  if (env.CLAUDE_PLUGIN_DATA !== undefined) return { dataDir: env.CLAUDE_PLUGIN_DATA, pluginId: null, configDir };
  const name = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).name;
  let registry;
  try { registry = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8')); }
  catch { throw new Error(`Install ${name} through /plugin install ${name}@agent-router-tools before using its Mod.`); }
  const entries = Object.entries(registry.plugins || {});
  const exact = entries.filter(([, installations]) => Array.isArray(installations) && installations.some(installation => {
    try { return realpathSync(installation.installPath) === root; } catch { return false; }
  })).map(([id]) => id);
  const ids = exact.length ? exact : entries.map(([id]) => id).filter(id => id.split('@')[0] === name);
  if (ids.length !== 1) throw new Error(`Cannot resolve an unambiguous ${name} installation identity; reinstall ${name}@agent-router-tools through the marketplace.`);
  return { dataDir: join(configDir, 'plugins', 'data', dataName(ids[0])), pluginId: ids[0], configDir };
}

export async function runBridge(scriptUrl, handle, { label, withoutData = [], withTeammate = ['bootstrap'] }) {
  process.umask(0o077);
  try {
    if (process.argv.length !== 2) throw new Error('The bridge accepts JSON stdin only.');
    process.stdin.setEncoding('utf8');
    let raw = '';
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > LIMIT) throw new Error('Bridge input exceeds 8 MiB.');
      raw += chunk;
    }
    const input = JSON.parse(raw);
    const env = { ...process.env };
    const root = realpathSync(resolve(dirname(fileURLToPath(scriptUrl)), '..'));
    const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    let context = { root, pluginId: null, configDir, routerData: env.AGENT_ROUTER_DATA || join(configDir, 'plugins', 'data', dataName('agent-router@agent-router-tools')) };
    if (!withoutData.includes(input?.action)) {
      const found = resolvePluginData(root, env);
      env.CLAUDE_PLUGIN_DATA = found.dataDir;
      context = { ...context, pluginId: found.pluginId };
    }
    if (withTeammate.includes(input?.action) && input.teammate === undefined) {
      const identity = readTeammateIdentity();
      if (identity) input.teammate = identity;
    }
    const output = await handle(input, env, context);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    let message = error instanceof Error ? error.message : 'Bridge failed.';
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
      if (process.env[key]) message = message.split(process.env[key]).join('[redacted]');
    }
    process.stderr.write(`${label}: ${message}\n`);
    process.exitCode = 1;
  }
}
