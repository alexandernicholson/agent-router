import { open } from 'node:fs/promises';
import { reportedCacheCreation } from './cache.js';
import { sameModel } from './routing.js';

// Transcript paths come from classic hooks. Read only a bounded tail, and
// return usage metadata only; no transcript text crosses the bridge or enters records.
export async function transcriptTail(path) {
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) return '';
  let file;
  try {
    file = await open(path, 'r');
    const { size } = await file.stat();
    const offset = Math.max(0, size - 1024 * 1024);
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return offset ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return ''; }
  finally { await file?.close(); }
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
    // One API response may have several transcript blocks. Conflicting copies
    // or two matching API responses are ambiguous, so leave the TTL unknown.
    if (prior && JSON.stringify(prior) !== JSON.stringify(creation)) return undefined;
    matches.set(key, creation);
  }
  return matches.size === 1 ? matches.values().next().value : undefined;
}
