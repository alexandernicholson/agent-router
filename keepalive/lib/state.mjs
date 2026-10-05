import { join } from 'node:path';
import { listRecords } from './shared/records.mjs';
import { readRoutes, ROUTER_DATA } from './shared/routes.mjs';

export { stateDirectory, idKey, recordPath, readRecord, writeRecord, listRecords } from './shared/records.mjs';

export const routerData = configDir => join(configDir, 'plugins', 'data', ROUTER_DATA);

export async function routerRoutes(dataDir, sessionId) {
  return dataDir ? readRoutes(dataDir, sessionId) : null;
}

export async function linkedSessions(root, sessionId) {
  return (await listRecords(root, 'links', sessionId))
    .filter(link => link.leadSessionId === sessionId && typeof link.sessionId === 'string' && link.sessionId)
    .map(link => ({ sessionId: link.sessionId, label: typeof link.label === 'string' ? link.label : null }));
}
