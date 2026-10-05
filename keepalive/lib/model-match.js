const VENDOR_WORDS = new Set(['claude', 'anthropic']);
const AGREEMENT = 0.03;

function parse(model) {
  if (typeof model !== 'string') return null;
  let name = model.trim().toLowerCase();
  if (!name || name.length > 200) return null;
  name = name.replace(/\[[^\]]*\]$/, '');
  name = name.slice(name.lastIndexOf('/') + 1);
  name = name.replace(/@.*$/, '');
  name = name.replace(/-v\d+(?::\d+)?$/, '');
  name = name.replace(/^(?:[a-z][a-z-]*\.)+(?=[a-z])/, '');
  let date;
  name = name.replace(/(?:^|[-_.])(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})$/, (_, year, month, day) => { date = `${year}${month}${day}`; return ''; });
  const tokens = name.match(/[a-z]+|\d+/g) ?? [];
  const words = [...new Set(tokens.filter(token => /^[a-z]/.test(token) && !VENDOR_WORDS.has(token)))].sort();
  const numbers = tokens.filter(token => /^\d/.test(token)).map(token => String(Number(token)));
  if (!words.length || !numbers.length) return null;
  return { key: `${words.join('-')}:${numbers.join('.')}`, date };
}

/** @param {unknown} model */
export function modelKey(model) {
  return parse(model)?.key ?? null;
}

const price = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const usable = ([provider, id, , input, output, read]) => typeof provider === 'string' && typeof id === 'string' && id.length <= 200 &&
  price(input) && input > 0 && price(output) && price(read);

/** @param {unknown} data */
export function catalogEntries(data) {
  const entries = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return entries;
  for (const [provider, listing] of Object.entries(data)) {
    const models = listing?.models;
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue;
    for (const [id, model] of Object.entries(models)) {
      const cost = model?.cost;
      if (!cost || typeof cost !== 'object') continue;
      const canonical = typeof model.canonical_model_id === 'string' && model.canonical_model_id.includes('/') ? model.canonical_model_id.split('/')[0] : null;
      const entry = [provider, id, canonical, cost.input, cost.output, cost.cache_read, price(cost.cache_write) ? cost.cache_write : null];
      if (usable(entry)) entries.push(entry);
    }
  }
  return entries;
}

/** @param {unknown[]} entries */
export function priceIndex(entries) {
  const index = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!Array.isArray(entry) || !usable(entry)) continue;
    const [provider, id, owner, input, output, read, write, hour] = entry;
    const parsed = parse(id);
    if (!parsed) continue;
    const listing = { provider, id, owner: typeof owner === 'string' ? owner : null, date: parsed.date, input, output, read, write: price(write) ? write : null, hour: price(hour) ? hour : null };
    index.set(parsed.key, [...(index.get(parsed.key) ?? []), listing]);
  }
  return index;
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * @param {Map<string, any[]>} index
 * @param {unknown} model
 */
export function matchPrices(index, model) {
  const parsed = parse(model);
  if (!parsed) return null;
  let candidates = index.get(parsed.key) ?? [];
  if (parsed.date) {
    const dated = candidates.filter(listing => listing.date === parsed.date);
    if (dated.length) candidates = dated;
  }
  if (!candidates.length) return null;
  const firstParty = candidates.filter(listing => listing.owner && listing.provider === listing.owner);
  const pool = firstParty.length ? firstParty : candidates;
  const read = listing => listing.read / listing.input;
  let agreed = [];
  for (const listing of pool) {
    const group = pool.filter(other => Math.abs(read(other) - read(listing)) <= AGREEMENT * Math.max(read(other), read(listing)));
    if (group.length > agreed.length) agreed = group;
  }
  if (agreed.length * 3 < pool.length * 2) return null;
  const writes = agreed.filter(listing => listing.write !== null).map(listing => listing.write / listing.input);
  const hours = agreed.filter(listing => listing.hour !== null).map(listing => listing.hour / listing.input);
  const [chosen] = agreed;
  return { read: median(agreed.map(read)), ...(writes.length ? { fiveMinute: median(writes) } : {}), ...(hours.length ? { oneHour: median(hours) } : {}),
    output: median(agreed.map(listing => listing.output / listing.input)), provider: chosen.provider, id: chosen.id };
}
