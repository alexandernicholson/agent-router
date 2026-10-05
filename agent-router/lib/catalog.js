import { isExactModelId } from './routing.js';
import { displayText } from './shared/text.js';

export { displayText };

function positiveLimit(...values) {
  return values.find(value => Number.isSafeInteger(value) && value > 0);
}

export function normalizeCatalog(rawModels) {
  if (!Array.isArray(rawModels)) throw new Error('Refresh after the endpoint returns a model catalog array.');
  const models = [];
  const seen = new Set();
  for (const row of rawModels) {
    if (!row || !isExactModelId(row.id) || seen.has(row.id)) continue;
    // Match discovery's first-row-wins rule across paginated catalogs.
    seen.add(row.id);
    const model = {
      id: row.id,
      name: displayText(row.display_name, 160) || displayText(row.name, 160) || displayText(row.id, 160),
      description: displayText(row.description, 640),
    };
    const contextWindow = positiveLimit(row.max_input_tokens, row.context_window);
    const outputLimit = positiveLimit(row.max_tokens, row.max_output_tokens);
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    if (outputLimit !== undefined) model.outputLimit = outputLimit;
    models.push(model);
  }
  if (!models.length) {
    throw new Error('Ask your endpoint administrator to advertise exact model IDs in /v1/models, then refresh the picker.');
  }
  return models;
}

export function filterModels(models, query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return models;
  return models.filter(model => {
    const text = `${model.name}\n${model.id}\n${model.description}`.toLowerCase();
    return tokens.every(token => text.includes(token));
  });
}
