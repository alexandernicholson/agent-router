import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { upkeepOptions } from './fixtures.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'keepalive-mod-tests-'));
try {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const plugin = join(temporary, 'plugin');
  const config = join(temporary, 'config');
  await mkdir(plugin, { mode: 0o700 });
  await mkdir(config, { mode: 0o700 });
  for (const name of ['.claude-plugin', 'hooks', 'lib', 'scripts', 'tests', 'package.json']) {
    await cp(join(root, name), join(plugin, name), { recursive: true });
  }
  const manifestPath = join(plugin, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const [key, value] of Object.entries(upkeepOptions)) manifest.userConfig[key].default = value;
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', DISABLE_TELEMETRY: '1' };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const child = spawn(process.env.CLAUDE_BINARY || 'claude', ['plugin', 'test', plugin], { env, stdio: 'inherit' });
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => child.kill(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code ?? 1));
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
