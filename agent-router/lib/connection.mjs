import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isExactModelId, isTruthy } from './routing.js';

const PROVIDER_FLAGS = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_GATEWAY',
];

export function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Model discovery requires a valid ANTHROPIC_BASE_URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
    throw new Error('Gateway URL must use HTTP(S), without embedded credentials, query, or fragment.');
  }
  if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '[::1]' && !/^127\.\d+\.\d+\.\d+$/.test(url.hostname)) {
    throw new Error('Use HTTPS for remote gateways; HTTP is only allowed on loopback.');
  }
  return url.href.replace(/\/+$/, '');
}

function discoveryHeaders(env, gatewayDiscovery) {
  const headers = new Headers({
    'User-Agent': gatewayDiscovery ? 'claude-code/agent-router' : 'agent-router',
    'anthropic-version': '2023-06-01',
  });
  try {
    if (env.ANTHROPIC_API_KEY) headers.set('x-api-key', env.ANTHROPIC_API_KEY);
    if (env.ANTHROPIC_AUTH_TOKEN) headers.set('Authorization', `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`);
    for (const line of (env.ANTHROPIC_CUSTOM_HEADERS || '').split('\n')) {
      if (!line.trim()) continue;
      const colon = line.indexOf(':');
      if (colon < 1) throw new Error();
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      // Claude's non-empty custom headers override built-ins case-insensitively.
      if (value) headers.set(name, value);
    }
  } catch {
    throw new Error('Model discovery headers are invalid; check gateway credentials and ANTHROPIC_CUSTOM_HEADERS.');
  }
  return headers;
}

async function fetchEndpointModels(env, base, gatewayDiscovery) {
  const headers = discoveryHeaders(env, gatewayDiscovery);
  const rows = new Map();
  const cursors = new Set();
  let after;
  let bytes = 0;
  const signal = AbortSignal.timeout(15_000);
  for (let page = 0; page < 100; page++) {
    const url = new URL(`${base.replace(/\/v1$/, '')}/v1/models`);
    url.searchParams.set('limit', '1000');
    if (after) url.searchParams.set('after_id', after);
    let response;
    try { response = await fetch(url, { headers, redirect: 'manual', signal }); }
    catch { throw new Error('Model discovery failed or timed out; check gateway connectivity and credentials.'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) {
        const hasKey = Boolean(headers.get('x-api-key'));
        const hasAuthorization = Boolean(headers.get('authorization'));
        const context = `Discovery headers: x-api-key ${hasKey ? 'set' : 'unset'}, Authorization ${hasAuthorization ? 'set' : 'unset'}. Gateway discovery: ${gatewayDiscovery ? 'on' : 'off'}.`;
        const guidance = hasKey || hasAuthorization
          ? 'Check these credentials and gateway permission for GET /v1/models.'
          : 'Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN, or gateway-required ANTHROPIC_CUSTOM_HEADERS, in the environment that launches Claude. CLAUDE_CODE_OAUTH_TOKEN is not sent as a gateway discovery credential.';
        throw new Error(`Model discovery returned HTTP ${response.status}. ${context} ${guidance}`);
      }
      throw new Error(`Model discovery returned HTTP ${response.status}; check the gateway URL and credentials (redirects are refused).`);
    }
    let text = '';
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body || []) {
        bytes += chunk.byteLength;
        if (bytes > 8 * 1024 * 1024) throw new Error();
        text += decoder.decode(chunk, { stream: true });
      }
      text += decoder.decode();
    } catch {
      throw new Error('Model discovery response exceeded its size limit, failed, or timed out.');
    }
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error('Gateway model catalog is not valid JSON.'); }
    if (!payload || !Array.isArray(payload.data) || payload.data.some(row => !row || typeof row.id !== 'string' || !row.id)) {
      throw new Error('Gateway model catalog must contain data rows with exact string IDs.');
    }
    for (const row of payload.data) if (!rows.has(row.id)) rows.set(row.id, row);
    if (!payload.has_more) return [...rows.values()];
    after = payload.last_id || payload.data.at(-1)?.id;
    if (typeof after !== 'string' || !after || cursors.has(after)) throw new Error('Gateway returned a non-advancing model catalog cursor.');
    cursors.add(after);
  }
  throw new Error('Gateway model catalog exceeded the pagination limit.');
}

async function readGatewayModels(env, base, gatewayDiscovery) {
  if (!gatewayDiscovery) return [];
  const config = env.CLAUDE_CONFIG_DIR || join(env.HOME || env.USERPROFILE || homedir(), '.claude');
  const file = await open(join(config, 'cache', 'gateway-models.json'), 'r');
  try {
    if ((await file.stat()).size > 8 * 1024 * 1024) return [];
    const cached = JSON.parse(await file.readFile('utf8'));
    if (normalizeBaseUrl(cached.baseUrl) !== base || !Array.isArray(cached.models)) return [];
    return cached.models.filter(model => model && isExactModelId(model.id));
  } finally {
    await file.close();
  }
}

export async function fetchModels({ env = process.env, baseUrl = env.ANTHROPIC_BASE_URL } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const gatewayDiscovery = isTruthy(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY) &&
    !PROVIDER_FLAGS.some(key => isTruthy(env[key])) && new URL(base).hostname !== 'api.anthropic.com';
  const [endpoint, discovery] = await Promise.allSettled([
    fetchEndpointModels(env, base, gatewayDiscovery), readGatewayModels(env, base, gatewayDiscovery),
  ]);
  // Claude owns this optional cache, including authentication-helper discovery.
  const cached = discovery.status === 'fulfilled' ? discovery.value : [];
  if (endpoint.status === 'rejected' && !cached.length) throw endpoint.reason;
  const models = endpoint.status === 'fulfilled' ? endpoint.value : [];
  if (!cached.length) return models;
  const ids = new Set(models.map(model => model.id));
  for (const model of cached) {
    if (ids.has(model.id)) continue;
    ids.add(model.id);
    models.push(model);
  }
  return models;
}
