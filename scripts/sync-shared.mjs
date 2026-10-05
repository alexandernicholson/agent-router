import { readdir, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv.find(arg => arg.startsWith('--root='))?.slice(7) ?? fileURLToPath(new URL('..', import.meta.url));
const PLUGINS = ['agent-router', 'keepalive'];
const TARGETS = [['shared/lib', 'lib/shared'], ['shared/hooks', 'hooks/shared']];
const check = process.argv.includes('--check');

async function files(directory) {
  try { return (await readdir(directory)).filter(name => !name.startsWith('.')).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

const drift = [];
for (const plugin of PLUGINS) {
  for (const [source, target] of TARGETS) {
    const from = join(root, source);
    const to = join(root, plugin, target);
    const wanted = await files(from);
    const present = await files(to);
    for (const name of wanted) {
      const text = await readFile(join(from, name), 'utf8');
      const current = await readFile(join(to, name), 'utf8').catch(() => null);
      if (current === text) continue;
      drift.push(relative(root, join(to, name)));
      if (!check) { await mkdir(to, { recursive: true }); await writeFile(join(to, name), text); }
    }
    for (const name of present.filter(name => !wanted.includes(name))) {
      if ((await stat(join(to, name))).isDirectory()) continue;
      drift.push(`${relative(root, join(to, name))} (not in ${source})`);
      if (!check) await rm(join(to, name));
    }
  }
}
if (check && drift.length) {
  process.stderr.write(`Shared library copies differ from shared/; run npm run sync:\n${drift.map(item => `  ${item}`).join('\n')}\n`);
  process.exitCode = 1;
} else if (!check) {
  process.stdout.write(drift.length ? `Synced ${drift.length} file(s):\n${drift.map(item => `  ${item}`).join('\n')}\n` : 'Shared library copies are current.\n');
}
