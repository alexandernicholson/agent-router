#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { handleRequest } from '../lib/bridge.mjs';

process.umask(0o077);
let input;
try {
  if (process.argv.length !== 2) throw new Error('The Agent Router bridge accepts JSON stdin only.');
  process.stdin.setEncoding('utf8');
  let raw = '';
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 8 * 1024 * 1024) throw new Error('Bridge input exceeds 8 MiB.');
    raw += chunk;
  }
  input = JSON.parse(raw);
  const env = { ...process.env };
  if (input?.action !== 'catalog' && env.CLAUDE_PLUGIN_DATA === undefined) {
    // Function-hook process.run does not inject shell-hook variables. Resolve
    // the same documented data directory from Claude's installed plugin ID.
    // Never derive identity from a versioned cache-directory naming convention.
    const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
    const config = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    let registry;
    try { registry = JSON.parse(readFileSync(join(config, 'plugins', 'installed_plugins.json'), 'utf8')); }
    catch { throw new Error('Install Agent Router through /plugin install agent-router@agent-router-tools before using its Mod.'); }
    const entries = Object.entries(registry.plugins || {});
    const exact = entries.filter(([, installations]) => Array.isArray(installations) && installations.some(installation => {
      try { return realpathSync(installation.installPath) === root; } catch { return false; }
    })).map(([id]) => id);
    // A running plugin may retain its previous version's root after an update;
    // the registry then names only the new cache path. A unique manifest-name
    // identity remains valid; ambiguous installations must not share state.
    const name = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).name;
    const ids = exact.length ? exact : entries.map(([id]) => id).filter(id => id.split('@')[0] === name);
    if (ids.length !== 1) throw new Error('Cannot resolve an unambiguous Agent Router installation identity; reinstall agent-router@agent-router-tools through the marketplace.');
    env.CLAUDE_PLUGIN_DATA = join(config, 'plugins', 'data', ids[0].replace(/[^a-zA-Z0-9_-]/g, '-'));
  }
  const output = await handleRequest(input, env);
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  let message = error instanceof Error ? error.message : 'Agent Router bridge failed.';
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    if (process.env[key]) message = message.split(process.env[key]).join('[redacted]');
  }
  process.stderr.write(`Agent Router: ${message}\n`);
  process.exitCode = 1;
}
