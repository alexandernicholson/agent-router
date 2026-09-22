import { policyFromOptions, policyDigest } from './policy.mjs';
import { routeAgent, isTruthy, ROLES, sameModel } from './routing.js';
import { fetchModels, normalizeBaseUrl } from './connection.mjs';
import { normalizeCatalog } from './catalog.js';
import { stateDirectory, recordPath, readRecord, writeRecord, agentAssignments, sessionStats, idKey, USAGE_KEYS } from './state.mjs';


function assertOverrides(env) {
  if (isTruthy(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE)) {
    throw new Error('CLAUDE_CODE_SUBAGENT_MODEL_FORCE conflicts with per-role routing; unset it.');
  }
}

async function bootstrap(input, env, discover) {
  const root = stateDirectory(env);
  const file = recordPath(root, 'sessions', input.session_id);
  // Gateway and session identity are pinned before considering newly saved options.
  const baseUrl = env.ANTHROPIC_BASE_URL ? normalizeBaseUrl(env.ANTHROPIC_BASE_URL) : null;
  if (baseUrl) assertOverrides(env);
  const previous = await readRecord(file);
  if (previous) {
    if (previous.gateway !== baseUrl) {
      throw new Error('Agent Router endpoint changed during this session. Start a new Claude session to apply it.');
    }
    return { ...previous, pendingConfiguration: pendingConfiguration(previous, input.options), agents: await agentAssignments(root, input.session_id) };
  }
  const policy = baseUrl ? policyFromOptions(input.options) : null;
  const digest = policy ? policyDigest(policy) : null;
  const ids = baseUrl ? (await discover({ baseUrl, env })).map(model => model.id) : [];
  if (baseUrl) for (const role of ROLES) {
    if (!ids.includes(policy.roles[role].model)) {
      throw new Error(`Endpoint catalog does not advertise the model configured for ${role}: ${policy.roles[role].model}. No implicit model fallback is permitted.`);
    }
  }
  const snapshot = {
    sessionId: input.session_id, policy, digest, gateway: baseUrl, active: Boolean(baseUrl),
    mode: baseUrl ? 'mod' : 'inactive', createdAt: new Date().toISOString(),
  };
  await writeRecord(file, snapshot, true);
  const pinned = await readRecord(file);
  if (pinned.digest !== digest || pinned.gateway !== baseUrl) throw new Error('Conflicting concurrent Agent Router bootstrap.');
  return { ...pinned, pendingConfiguration: false, agents: await agentAssignments(root, input.session_id) };
}

function pendingConfiguration(snapshot, options) {
  if (!snapshot.active) return false;
  try { return snapshot.digest !== policyDigest(policyFromOptions(options)); }
  catch { return true; }
}

async function catalog(env, discover) {
  if (!env.ANTHROPIC_BASE_URL) {
    throw new Error('Set ANTHROPIC_BASE_URL to your Anthropic-compatible endpoint, then refresh the model picker.');
  }
  const endpoint = normalizeBaseUrl(env.ANTHROPIC_BASE_URL);
  return { endpoint, models: normalizeCatalog(await discover({ baseUrl: endpoint, env })) };
}

async function snapshotFor(input, env) {
  const snapshot = await readRecord(recordPath(stateDirectory(env), 'sessions', input.session_id));
  if (!snapshot) throw new Error('Agent Router is not ready. Check plugin configuration and restart Claude.');
  if (snapshot.active) assertOverrides(env);
  const baseUrl = env.ANTHROPIC_BASE_URL ? normalizeBaseUrl(env.ANTHROPIC_BASE_URL) : null;
  if (snapshot.gateway !== baseUrl) {
    throw new Error('Agent Router endpoint changed; start a new Claude session to apply it.');
  }
  return snapshot;
}

async function recordRoute(input, env, snapshot) {
  if (!snapshot.active) throw new Error('Configure an Anthropic-compatible endpoint before using an Agent Router role.');
  if (input.agent_id !== undefined) idKey(input.agent_id);
  const selected = routeAgent(snapshot.policy, { subagentType: input.effectiveType });
  const record = {
    sessionId: input.session_id, toolUseId: input.tool_use_id, parentAgentId: input.agent_id || null,
    requestedType: typeof input.requestedType === 'string' ? input.requestedType : null,
    requestedModel: typeof input.requestedModel === 'string' ? input.requestedModel : null,
    role: selected.role, effectiveType: selected.type, effectiveModel: selected.model, effectiveEffort: selected.effort ?? null,
    mode: 'mod', gateway: snapshot.gateway, policyDigest: snapshot.digest,
    state: 'dispatched', createdAt: new Date().toISOString(), upstreamVerified: false,
  };
  await writeRecord(recordPath(stateDirectory(env), 'routes', input.session_id, input.tool_use_id), record);
  return {};
}

async function recordResult(input, env) {
  const root = stateDirectory(env);
  const path = recordPath(root, 'routes', input.session_id, input.tool_use_id);
  const record = await readRecord(path);
  if (!record) throw new Error('Cannot record a result without a routing decision.');
  const result = input.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected an agent result object.');
  const failed = result.deny !== undefined;
  record.state = failed ? 'failed' : result.agentId ? 'started' : 'unresolved';
  if (!failed && result.agentId) {
    idKey(result.agentId);
    record.agentId = result.agentId;
  }
  if (typeof result.model === 'string') record.resolvedModel = result.model;
  record.updatedAt = new Date().toISOString();
  await writeRecord(path, record);
  if (!failed && record.agentId) await writeRecord(recordPath(root, 'agents', input.session_id, record.agentId), {
    sessionId: input.session_id, agentId: record.agentId, role: record.role,
    effectiveModel: record.effectiveModel, toolUseId: record.toolUseId,
  });
  if (record.resolvedModel && !sameModel(record.effectiveModel, record.resolvedModel)) {
    return { systemMessage: `Agent Router mismatch: ${record.role} selected ${record.effectiveModel}, Claude resolved ${record.resolvedModel}. The run is not verified; inspect /agent-router:routes.` };
  }
  return {};
}

async function observe(input, env) {
  const identity = `${idKey(input.agent_id)}:${idKey(input.turn_id)}`;
  const observation = {
    sessionId: input.session_id, agentId: input.agent_id, turnId: input.turn_id,
    reason: ['answer', 'aborted', 'refusal', 'error'].includes(input.reason) ? input.reason : 'unknown',
    responseModels: [], usage: {}, updatedAt: new Date().toISOString(),
  };
  if (typeof input.usage?.model === 'string') observation.responseModels.push(input.usage.model);
  for (const key of USAGE_KEYS) {
    const value = input.usage?.[key];
    if (Number.isSafeInteger(value) && value >= 0) observation.usage[key] = value;
  }
  await writeRecord(recordPath(stateDirectory(env), 'observations', input.session_id, identity), observation, true);
  return {};
}

export async function handleRequest(input, env = process.env, discover = fetchModels) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a bridge JSON object.');
  if (!['bootstrap', 'catalog', 'route', 'result', 'observe', 'stats'].includes(input.action)) throw new Error('Unknown Agent Router bridge action.');
  if (input.action === 'catalog') return catalog(env, discover);
  if (input.action === 'stats') return sessionStats(stateDirectory(env), input.session_id);
  if (input.action === 'bootstrap') return bootstrap(input, env, discover);
  const snapshot = await snapshotFor(input, env);
  if (input.action === 'route') return recordRoute(input, env, snapshot);
  if (input.action === 'result') return recordResult(input, env);
  return observe(input, env);
}
