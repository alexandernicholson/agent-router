import { cp, copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readRecord, writeRecord } from './shared/records.mjs';

const KINDS = ['cache-samples', 'cache-resets'];

export async function migrateFromRouter(root, source) {
  const marker = join(root, 'migrated.json');
  if (await readRecord(marker)) return { migrated: false };
  const copied = [];
  for (const kind of KINDS) {
    const from = join(source, kind);
    try { if (!(await stat(from)).isDirectory()) continue; } catch { continue; }
    await cp(from, join(root, kind), { recursive: true, force: false, errorOnExist: false });
    copied.push(kind);
  }
  await copyFile(join(source, 'models-dev.json'), join(root, 'models-dev.json')).then(() => copied.push('models-dev.json'), () => undefined);
  await writeRecord(marker, { from: 'agent-router', at: new Date().toISOString(), copied });
  return { migrated: copied.length > 0, copied };
}
