import { recordCacheSample, enrichCacheSamples, resetCache, cacheSnapshot, linkSession } from './cache-state.mjs';
import { lookUpPrices } from './price-sources.mjs';
import { stateDirectory } from './state.mjs';
import { migrateFromRouter } from './migrate.mjs';
import { readHandover } from './shared/routes.mjs';

const ACTIONS = ['cache-sample', 'cache-snapshot', 'cache-reset', 'cache-enrich', 'cache-prices', 'identity', 'link', 'migrate'];

export async function handleRequest(input, env = process.env, context = {}, pricesFetch = fetch) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a bridge JSON object.');
  if (!ACTIONS.includes(input.action)) throw new Error('Unknown Keepalive bridge action.');
  if (input.action === 'identity') return { teammate: input.teammate ?? null };
  const root = stateDirectory(env);
  if (input.action === 'cache-prices') {
    const { models } = input;
    if (!Array.isArray(models) || models.length > 16 || models.some(model => typeof model !== 'string' || !model || model.length > 200)) {
      throw new Error('cache-prices takes up to 16 model names in models.');
    }
    return lookUpPrices(models, { root, env, fetcher: pricesFetch });
  }
  if (input.action === 'migrate') {
    if (!context.routerData) return { migrated: false, handover: null };
    return { ...await migrateFromRouter(root, context.routerData), handover: await readHandover(context.routerData) };
  }
  if (input.action === 'link') return linkSession(root, input.lead_session_id, input.session_id, input.label);
  if (input.action === 'cache-snapshot') return cacheSnapshot(root, input.session_id, context.routerData);
  if (input.action === 'cache-sample') return recordCacheSample(root, input.session_id, input.sample, input.transcript_path);
  if (input.action === 'cache-enrich') return enrichCacheSamples(root, input.session_id, input.agent_id ?? null, input.transcript_path);
  return resetCache(root, input.session_id, input.agent_id ?? null, input.reset_at);
}
