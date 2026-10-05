import { mkdir, readFile, writeFile, rename, readdir, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';

export function stateDirectory(env = process.env) {
  if (typeof env.CLAUDE_PLUGIN_DATA !== 'string' || !env.CLAUDE_PLUGIN_DATA.trim()) {
    throw new Error('CLAUDE_PLUGIN_DATA is required; diagnostics may supply --data PATH explicitly.');
  }
  return env.CLAUDE_PLUGIN_DATA;
}

export function idKey(id) {
  if (typeof id !== 'string' || !id || id.length > 512) throw new Error('Missing or invalid record identity.');
  return createHash('sha256').update(id).digest('hex');
}

export function recordPath(root, kind, sessionId, id = sessionId) {
  return join(root, kind, idKey(sessionId), `${idKey(id)}.json`);
}

export async function readRecord(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function writeRecord(file, value, exclusive = false) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    if (exclusive) {
      try { await link(temporary, file); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } else {
      await rename(temporary, file);
    }
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function listRecords(root, kind, sessionId) {
  const directory = join(root, kind);
  let sessions;
  try { sessions = sessionId ? [idKey(sessionId)] : await readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const session of sessions) {
    if (!/^[a-f0-9]{64}$/.test(session)) continue;
    let files;
    try { files = await readdir(join(directory, session)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const record = await readRecord(join(directory, session, file));
      if (record) records.push(record);
    }
  }
  return records;
}
