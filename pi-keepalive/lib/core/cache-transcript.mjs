import { open } from 'node:fs/promises';
import { reportedCacheCreation } from './cache.js';
import { sameModel } from './shared/models.js';

async function tail(file) {
  const { size } = await file.stat();
  const offset = Math.max(0, size - 1024 * 1024);
  const buffer = Buffer.alloc(size - offset);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
  const text = buffer.subarray(0, bytesRead).toString('utf8');
  return offset ? text.slice(text.indexOf('\n') + 1) : text;
}

export async function transcriptTail(path) {
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) return '';
  const file = await open(path, 'r').catch(() => null);
  if (!file) return '';
  return tail(file).catch(() => '').finally(() => file.close());
}

export function transcriptCreation(text, sample) {
  if (!Number.isSafeInteger(sample.completedAt)) return undefined;
  const matches = new Map();
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type !== 'assistant' || row.sessionId !== sample.sessionId ||
        (row.agentId ?? null) !== sample.agentId || typeof row.message?.id !== 'string') continue;
    const timestamp = Date.parse(row.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < sample.startedAt || timestamp > sample.completedAt) continue;
    const usage = row.message.usage;
    if (!sameModel(row.message.model, sample.model) || !usage ||
        usage.input_tokens !== sample.fresh || usage.output_tokens !== sample.output ||
        usage.cache_read_input_tokens !== sample.read || usage.cache_creation_input_tokens !== sample.write) continue;
    const creation = reportedCacheCreation(usage);
    if (!creation) continue;
    const key = row.message.id;
    const prior = matches.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(creation)) return undefined;
    matches.set(key, creation);
  }
  return matches.size === 1 ? matches.values().next().value : undefined;
}
