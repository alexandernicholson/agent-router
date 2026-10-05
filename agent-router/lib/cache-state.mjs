import { recordPath, readRecord, writeRecord, listRecords, linkedTeammates, agentAssignments, idKey } from './state.mjs';
import { validSample, validCreation, loopKey, applyCacheCreation } from './cache.js';
import { transcriptTail, transcriptCreation } from './cache-transcript.mjs';

export async function recordCacheSample(root, sessionId, input, transcriptPath) {
  // Whitelist fields: never persist an answer, prompt, credentials or arbitrary payload.
  let sample = Object.fromEntries(['agentId', 'turnId', 'index', 'model', 'startedAt', 'read', 'write', 'fresh', 'output', 'ttlMs', 'ttlSource', 'disabled'].map(k => [k, input?.[k]]));
  sample.sessionId = sessionId;
  if (input?.completedAt !== undefined) sample.completedAt = input.completedAt;
  if (validCreation(input?.cacheCreation, sample.write)) sample = applyCacheCreation(sample, input.cacheCreation);
  if (!validSample(sample)) throw new Error('Invalid cache sample.');
  idKey(sample.turnId);
  if (sample.agentId !== null) idKey(sample.agentId);
  const identity = JSON.stringify([sample.agentId, sample.turnId, sample.index]);
  const file = recordPath(root, 'cache-samples', sessionId, identity);
  await writeRecord(file, sample, true);
  let saved = await readRecord(file);
  if (!saved.cacheCreation) {
    const creation = transcriptCreation(await transcriptTail(transcriptPath), saved);
    if (creation) {
      saved = applyCacheCreation(saved, creation);
      await writeRecord(file, saved);
    }
  }
  return { sample: saved };
}

// Transcripts can flush after turn.step returns. Stop/PostToolUse provide a
// second opportunity to enrich the same immutable request identities.
export async function enrichCacheSamples(root, sessionId, agentId, transcriptPath) {
  idKey(sessionId);
  if (agentId !== null) idKey(agentId);
  const text = await transcriptTail(transcriptPath);
  const samples = (await listRecords(root, 'cache-samples', sessionId))
    .filter(s => validSample(s) && s.sessionId === sessionId && s.agentId === agentId && !s.cacheCreation && s.write > 0)
    .sort((a, b) => b.startedAt - a.startedAt || b.index - a.index).slice(0, 30);
  const enriched = [];
  for (const sample of samples) {
    const creation = transcriptCreation(text, sample);
    if (!creation) continue;
    const updated = applyCacheCreation(sample, creation);
    const identity = JSON.stringify([sample.agentId, sample.turnId, sample.index]);
    await writeRecord(recordPath(root, 'cache-samples', sessionId, identity), updated);
    enriched.push(updated);
  }
  return { samples: enriched };
}

export async function resetCache(root, sessionId, agentId, resetAt) {
  if (agentId !== null) idKey(agentId);
  if (!Number.isSafeInteger(resetAt) || resetAt < 0) throw new Error('Invalid cache reset time.');
  await writeRecord(recordPath(root, 'cache-resets', sessionId, JSON.stringify(agentId)), { sessionId, agentId, resetAt });
  return {};
}

export async function cacheSnapshot(root, sessionId) {
  idKey(sessionId);
  const links = await linkedTeammates(root, sessionId);
  const sessions = [sessionId, ...new Set(links.map(link => link.sessionId))];
  const data = await Promise.all(sessions.map(async id => ({
    id, samples: await listRecords(root, 'cache-samples', id), resets: await listRecords(root, 'cache-resets', id),
    agents: await agentAssignments(root, id),
  })));
  const labels = new Map([[loopKey(sessionId, null), 'Main']]);
  for (const { id, agents } of data) {
    for (const agent of agents) labels.set(loopKey(id, agent.agentId), `${agent.name || agent.role} (${agent.agentId})`);
  }
  // Split-pane main loops use their own session identity. Join only by the confirmed link.
  const leadAgents = data[0].agents;
  for (const id of sessions.slice(1)) {
    const records = await listRecords(root, 'sessions', id);
    const mate = records.find(r => r.sessionId === id && r.leadSessionId === sessionId)?.teammate;
    if (mate) {
      const assigned = leadAgents.find(a => a.agentId === mate.agentId);
      labels.set(loopKey(id, null), `${mate.name || assigned?.name || 'Teammate'} (${mate.agentId})`);
    }
  }
  return {
    samples: data.flatMap(d => d.samples.filter(s => s.sessionId === d.id && validSample(s))),
    resets: data.flatMap(d => d.resets.filter(r => r.sessionId === d.id && (r.agentId === null || typeof r.agentId === 'string') && Number.isSafeInteger(r.resetAt) && r.resetAt >= 0)),
    labels: [...labels],
  };
}
