import { sameModel } from './routing.js';
import { stateDirectory, idKey, recordPath, listRecords, writeRecord } from './shared/records.mjs';

export { stateDirectory, idKey, recordPath, readRecord, writeRecord, listRecords } from './shared/records.mjs';

export const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
const OBSERVATION_SCOPE = 'last response per completed turn';
const STATS_USAGE_KEYS = [
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['cache_read_input_tokens', 'cacheReadTokens'],
];

export async function agentAssignments(root, sessionId) {
  return listRecords(root, 'agents', sessionId);
}

// A pane teammate is its own session; its lead links it here so the lead's
// panel counts the teammate's completed turns with its own.
export async function linkTeammate(root, leadSessionId, teammateSessionId) {
  await writeRecord(recordPath(root, 'teammates', leadSessionId, teammateSessionId), { leadSessionId, sessionId: teammateSessionId });
}

export async function linkedTeammates(root, leadSessionId) {
  return (await listRecords(root, 'teammates', leadSessionId))
    .filter(link => link.leadSessionId === leadSessionId && typeof link.sessionId === 'string' && link.sessionId);
}

export async function sessionStats(root, sessionId) {
  idKey(sessionId);
  const linked = await linkedTeammates(root, sessionId);
  const [routes, ...observationSets] = await Promise.all([
    listRecords(root, 'routes', sessionId),
    listRecords(root, 'observations', sessionId),
    ...linked.map(link => listRecords(root, 'observations', link.sessionId)),
  ]);
  const sessions = new Set([sessionId, ...linked.map(link => link.sessionId)]);
  const observations = observationSets.flat();
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
    if (!sessions.has(observation.sessionId) || typeof observation.agentId !== 'string' || !observation.agentId ||
        typeof observation.turnId !== 'string' || !observation.turnId ||
        !Array.isArray(observation.responseModels) || !observation.usage || typeof observation.usage !== 'object') continue;
    const agentKey = JSON.stringify([observation.sessionId, observation.agentId]);
    let agentTurns = turns.get(agentKey);
    if (!agentTurns) {
      agentTurns = new Set();
      turns.set(agentKey, agentTurns);
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
