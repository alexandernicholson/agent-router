import { ANTHROPIC_PRICES } from './anthropic-prices.js';
import { priceIndex, matchPrices } from './model-match.js';
import { modelPrices } from './model-prices.mjs';
import { validPrices } from './cache.js';

/**
 * @typedef {{read: number, output: number, fiveMinute?: number, oneHour?: number, provider?: string, id?: string}} SourcePrices
 * @typedef {{root?: string, env?: Record<string, string | undefined>, fetcher?: typeof fetch}} SourceContext
 * @typedef {{id: string, label: string, prices: (models: string[], context: SourceContext) => Promise<Record<string, SourcePrices | null>>}} PriceSource
 */

const anthropicIndex = priceIndex(ANTHROPIC_PRICES);

/** @type {PriceSource} */
export const anthropicPrices = {
  id: 'anthropic',
  label: 'Anthropic pricing',
  async prices(models) {
    return Object.fromEntries(models.map(model => [model, matchPrices(anthropicIndex, model)]));
  },
};

/** @type {PriceSource} */
export const modelsDevPrices = {
  id: 'models.dev',
  label: 'models.dev',
  async prices(models, { root, env = {}, fetcher }) {
    if (!root) return {};
    return (await modelPrices(root, models, env, fetcher)).prices;
  },
};

export const PRICE_SOURCES = [anthropicPrices, modelsDevPrices];

/**
 * @param {string[]} models
 * @param {SourceContext} context
 * @param {PriceSource[]} [sources]
 */
export async function lookUpPrices(models, context, sources = PRICE_SOURCES) {
  /** @type {Record<string, (SourcePrices & {source: string}) | null>} */
  const prices = Object.fromEntries(models.map(model => [model, null]));
  for (const source of sources) {
    const missing = models.filter(model => !prices[model]);
    if (!missing.length) break;
    let found;
    try { found = await source.prices(missing, context); } catch { continue; }
    for (const model of missing) if (validPrices(found?.[model])) prices[model] = { ...found[model], source: source.label };
  }
  return { prices };
}
