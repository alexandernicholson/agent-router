import { join } from 'node:path';
import { readRecord, writeRecord, idKey } from './records.mjs';
import { dataName } from './bridge-main.mjs';

export const ROUTES_VERSION = 1;
export const ROUTER_DATA = dataName('agent-router@agent-router-tools');
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const text = (value, limit = 512) => typeof value === 'string' && value.length > 0 && value.length <= limit;
const route = value => value && typeof value === 'object' && text(value.model) && (value.effort === undefined || EFFORTS.includes(value.effort));

export const routesFile = (dataDir, sessionId) => join(dataDir, 'published', `${idKey(sessionId)}.json`);

/**
 * @param {unknown} value
 * @returns {null | {version: number, sessionId: string, leadSessionId: string | null, self: null | {role: string, model: string, effort?: string}, teammate: null | {agentId: string, name: string | null}, agents: {agentId: string, kind: 'subagent' | 'teammate', role: string, model: string, effort?: string, name?: string | null, backend?: string | null}[], teammates: string[]}}
 */
export function validRoutes(value) {
  if (!value || typeof value !== 'object' || value.version !== ROUTES_VERSION || !text(value.sessionId)) return null;
  if (value.leadSessionId !== null && !text(value.leadSessionId)) return null;
  if (value.self !== null && !(route(value.self) && text(value.self.role))) return null;
  if (value.teammate !== null && !(value.teammate && text(value.teammate.agentId) && (value.teammate.name === null || text(value.teammate.name)))) return null;
  if (!Array.isArray(value.agents) || value.agents.length > 1000 || !value.agents.every(agent => route(agent) && text(agent.agentId) && text(agent.role) &&
    (agent.kind === 'subagent' || agent.kind === 'teammate') && (agent.name === undefined || agent.name === null || text(agent.name)) &&
    (agent.backend === undefined || agent.backend === null || text(agent.backend, 32)))) return null;
  if (!Array.isArray(value.teammates) || value.teammates.length > 256 || !value.teammates.every(id => text(id))) return null;
  return value;
}

export async function writeRoutes(dataDir, routes) {
  const value = validRoutes({ version: ROUTES_VERSION, ...routes });
  if (!value) throw new Error('Invalid published routes.');
  await writeRecord(routesFile(dataDir, value.sessionId), value);
  return value;
}

export async function readRoutes(dataDir, sessionId) {
  try { return validRoutes(await readRecord(routesFile(dataDir, sessionId))); }
  catch { return null; }
}

const HANDOVER_KEYS = ['cache-intro', 'cache-ttl', 'cache-upkeep'];
export const handoverFile = dataDir => join(dataDir, 'published', 'handover.json');

export function validHandover(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kept = Object.fromEntries(Object.entries(value).filter(([key]) => HANDOVER_KEYS.includes(key)));
  if (kept['cache-intro'] !== undefined && typeof kept['cache-intro'] !== 'number') delete kept['cache-intro'];
  for (const key of ['cache-ttl', 'cache-upkeep']) if (kept[key] !== undefined && (!Array.isArray(kept[key]) || kept[key].length > 64)) delete kept[key];
  return JSON.stringify(kept).length <= 65536 ? kept : null;
}

export async function writeHandover(dataDir, values) {
  const kept = validHandover(values);
  if (!kept || !Object.keys(kept).length) return {};
  if (await readRecord(handoverFile(dataDir)).catch(() => null)) return {};
  await writeRecord(handoverFile(dataDir), kept);
  return {};
}

export async function readHandover(dataDir) {
  try { return validHandover(await readRecord(handoverFile(dataDir))); }
  catch { return null; }
}
