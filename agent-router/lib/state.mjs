import { mkdir, readFile, writeFile, rename, readdir, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { sameModel } from './routing.js';

export const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
const OBSERVATION_SCOPE = 'last response per completed turn';
const STATS_USAGE_KEYS = [
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['cache_read_input_tokens', 'cacheReadTokens'],
];

export function stateDirectory(env = process.env) {
  if (typeof env.CLAUDE_PLUGIN_DATA !== 'string' || !env.CLAUDE_PLUGIN_DATA.trim()) {
    throw new Error('CLAUDE_PLUGIN_DATA is required; diagnostics may supply --data PATH explicitly.');
  }
  return env.CLAUDE_PLUGIN_DATA;
}

export function idKey(id) {
  if (typeof id !== 'string' || !id || id.length > 512) throw new Error('Missing or invalid routing identity.');
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

async function listRecords(root, kind, sessionId) {
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

export async function agentAssignments(root, sessionId) {
  return listRecords(root, 'agents', sessionId);
}

export async function sessionStats(root, sessionId) {
  idKey(sessionId);
  const [routes, observations] = await Promise.all([
    listRecords(root, 'routes', sessionId),
    listRecords(root, 'observations', sessionId),
  ]);
  const stats = { routed: 0, overrides: 0, mismatches: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const decisions = new Set();
  for (const route of routes) {
    if (route.sessionId !== sessionId || typeof route.toolUseId !== 'string' || !route.toolUseId ||
        decisions.has(route.toolUseId)) continue;
    decisions.add(route.toolUseId);
    stats.routed++;
    if (typeof route.requestedModel === 'string' && !sameModel(route.requestedModel, route.effectiveModel)) stats.overrides++;
    if (route.resolvedModel && !sameModel(route.effectiveModel, route.resolvedModel)) stats.mismatches++;
  }
  const turns = new Map();
  for (const observation of observations) {
    if (observation.sessionId !== sessionId || typeof observation.agentId !== 'string' || !observation.agentId ||
        typeof observation.turnId !== 'string' || !observation.turnId ||
        !Array.isArray(observation.responseModels) || !observation.usage || typeof observation.usage !== 'object') continue;
    let agentTurns = turns.get(observation.agentId);
    if (!agentTurns) {
      agentTurns = new Set();
      turns.set(observation.agentId, agentTurns);
    }
    if (agentTurns.has(observation.turnId)) continue;
    agentTurns.add(observation.turnId);
    for (const [usageKey, statsKey] of STATS_USAGE_KEYS) {
      const value = observation.usage[usageKey];
      if (Number.isSafeInteger(value) && value >= 0) stats[statsKey] += value;
    }
  }
  return stats;
}

export async function routingStatus(stateDir = stateDirectory(), sessionId) {
  const sessions = await listRecords(stateDir, 'sessions', sessionId);
  const routes = await listRecords(stateDir, 'routes', sessionId);
  const observations = await listRecords(stateDir, 'observations', sessionId);
  const agents = new Map();
  for (const observation of observations) {
    if (typeof observation.turnId !== 'string' || !observation.turnId ||
        !Array.isArray(observation.responseModels) || !observation.usage || typeof observation.usage !== 'object') continue;
    const key = JSON.stringify([observation.sessionId, observation.agentId]);
    let aggregate = agents.get(key);
    if (!aggregate) {
      aggregate = { models: new Set(), turns: new Set(), usage: {}, latest: observation };
      agents.set(key, aggregate);
    }
    if (aggregate.turns.has(observation.turnId)) continue;
    aggregate.turns.add(observation.turnId);
    for (const model of observation.responseModels) aggregate.models.add(model);
    for (const key of USAGE_KEYS) {
      if (observation.usage[key] !== undefined) {
        aggregate.usage[key] = (aggregate.usage[key] || 0) + observation.usage[key];
      }
    }
    if (observation.updatedAt >= aggregate.latest.updatedAt) aggregate.latest = observation;
  }
  routes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.toolUseId.localeCompare(b.toolUseId));
  const latestRoutes = new Map();
  for (const route of routes) {
    if (route.agentId) latestRoutes.set(JSON.stringify([route.sessionId, route.agentId]), route);
    route.resolutionMismatch = route.resolvedModel ? !sameModel(route.effectiveModel, route.resolvedModel) : null;
    route.observationScope = OBSERVATION_SCOPE;
    route.upstreamVerified = false;
  }
  for (const [key, route] of latestRoutes) {
    const aggregate = agents.get(key);
    if (!aggregate) continue;
    route.responseModels = [...aggregate.models].sort();
    route.usage = aggregate.usage;
    route.completedTurns = aggregate.turns.size;
    route.lastTurnReason = aggregate.latest.reason;
    route.stoppedAt = aggregate.latest.updatedAt;
    if (route.state === 'started' && route.stoppedAt >= route.createdAt) route.state = 'stopped';
  }
  return {
    sessions: sessions.map(({ sessionId: id, mode, gateway, digest, createdAt }) =>
      ({ sessionId: id, mode, gateway, policyDigest: digest, createdAt })),
    observationScope: OBSERVATION_SCOPE,
    routes,
  };
}
