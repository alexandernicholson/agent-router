import { policyFromOptions, policyDigest } from './policy.mjs';
import { routeAgent, routeTeammate, isTruthy, ROLES, sameModel } from './routing.js';
import { teamMember } from './teammate.mjs';
import { fetchModels, normalizeBaseUrl } from './connection.mjs';
import { normalizeCatalog } from './catalog.js';
import { stateDirectory, recordPath, readRecord, writeRecord, agentAssignments, sessionStats, idKey, linkTeammate, USAGE_KEYS } from './state.mjs';


function assertOverrides(env) {
  if (isTruthy(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE)) {
    throw new Error('CLAUDE_CODE_SUBAGENT_MODEL_FORCE conflicts with per-role routing; unset it.');
  }
}

async function bootstrap(input, env, discover, timing) {
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
    const pending = previous.leadSessionId ? false : pendingConfiguration(previous, input.options);
    return { ...previous, pendingConfiguration: pending, agents: await agentAssignments(root, input.session_id) };
  }
  let teammateNotice;
  if (baseUrl && input.teammate) {
    const inherited = await inheritFromLead(root, input, baseUrl, env, timing);
    if (inherited.snapshot) {
      await writeRecord(file, inherited.snapshot, true);
      const pinned = await readRecord(file);
      if (pinned.leadSessionId !== inherited.snapshot.leadSessionId) throw new Error('Conflicting concurrent Agent Router bootstrap.');
      await linkTeammate(root, pinned.leadSessionId, input.session_id);
      return { ...pinned, pendingConfiguration: false, agents: await agentAssignments(root, input.session_id) };
    }
    teammateNotice = inherited.notice;
  }
  const policy = baseUrl ? await advertisedPolicy(input.options, baseUrl, env, discover) : null;
  const digest = policy ? policyDigest(policy) : null;
  const snapshot = {
    sessionId: input.session_id, policy, digest, gateway: baseUrl, active: Boolean(baseUrl),
    mode: baseUrl ? 'mod' : 'inactive', createdAt: new Date().toISOString(),
  };
  await writeRecord(file, snapshot, true);
  const pinned = await readRecord(file);
  if (pinned.digest !== digest || pinned.gateway !== baseUrl) throw new Error('Conflicting concurrent Agent Router bootstrap.');
  return { ...pinned, pendingConfiguration: false, agents: await agentAssignments(root, input.session_id), ...(teammateNotice && { teammateNotice }) };
}

// A split-pane teammate adopts its lead's pinned policy, never the settings
// saved when it happened to start; `self` is the route its own steps use.
// The lead writes its launch record as the launch returns, which can land a
// moment after the teammate's own session starts.
async function leadLaunched(root, identity, { confirmMs, stepMs }) {
  const file = recordPath(root, 'agents', identity.parentSessionId, identity.agentId);
  for (const deadline = Date.now() + confirmMs; ; await new Promise(done => setTimeout(done, stepMs))) {
    const launched = await readRecord(file);
    if (launched?.kind === 'teammate' && launched.agentId === identity.agentId) return true;
    if (Date.now() >= deadline) return false;
  }
}

async function inheritFromLead(root, input, baseUrl, env, timing) {
  const identity = input.teammate;
  const found = identity && typeof identity === 'object' ? teamMember(identity, env) : null;
  if (!found || !(found.leadConfirmed || await leadLaunched(root, identity, timing))) {
    return { notice: 'Agent Router could not confirm this teammate against its team config and lead session, so it routes as its own session.' };
  }
  const lead = await readRecord(recordPath(root, 'sessions', identity.parentSessionId));
  if (!lead?.active) {
    return { notice: 'Agent Router is not routing in this teammate\'s lead session, so the teammate routes as its own session.' };
  }
  if (lead.gateway !== baseUrl) {
    throw new Error('This teammate\'s endpoint differs from its lead session\'s endpoint. Start the lead and its teammates with the same ANTHROPIC_BASE_URL.');
  }
  const self = routeTeammate(lead.policy, { subagentType: identity.agentType });
  return { snapshot: {
    sessionId: input.session_id, policy: lead.policy, digest: lead.digest, gateway: lead.gateway, active: true,
    mode: 'mod', createdAt: new Date().toISOString(), leadSessionId: identity.parentSessionId, self,
    teammate: { agentId: identity.agentId, name: identity.agentName ?? null, teamName: identity.teamName, agentType: identity.agentType ?? null },
  } };
}

// Every configured model must be advertised; there is no implicit fallback.
async function advertisedPolicy(options, baseUrl, env, discover) {
  const policy = policyFromOptions(options);
  const ids = (await discover({ baseUrl, env })).map(model => model.id);
  for (const role of ROLES) {
    if (!ids.includes(policy.roles[role].model)) {
      throw new Error(`Endpoint catalog does not advertise the model configured for ${role}: ${policy.roles[role].model}. No implicit model fallback is permitted.`);
    }
  }
  if (policy.teammate?.model && !ids.includes(policy.teammate.model)) {
    throw new Error(`Endpoint catalog does not advertise the model configured for teammates: ${policy.teammate.model}. No implicit model fallback is permitted.`);
  }
  return policy;
}

// Re-pins a running session to the saved options; its endpoint stays pinned.
async function apply(input, env, discover, snapshot) {
  if (!snapshot.active) throw new Error('Configure an Anthropic-compatible endpoint before applying Agent Router settings.');
  if (snapshot.leadSessionId) throw new Error('This teammate follows its lead session\'s routing. Run /agent-models-apply in the lead; teammates started after that use the new settings.');
  const policy = await advertisedPolicy(input.options, snapshot.gateway, env, discover);
  const file = recordPath(stateDirectory(env), 'sessions', input.session_id);
  const updated = { ...snapshot, policy, digest: policyDigest(policy), appliedAt: new Date().toISOString() };
  await writeRecord(file, updated);
  return { ...updated, pendingConfiguration: false };
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
  const teammate = input.kind === 'teammate';
  const selected = teammate
    ? routeTeammate(snapshot.policy, { subagentType: input.effectiveType })
    : routeAgent(snapshot.policy, { subagentType: input.effectiveType });
  const record = {
    sessionId: input.session_id, toolUseId: input.tool_use_id, parentAgentId: input.agent_id || null,
    kind: teammate ? 'teammate' : 'subagent', ...(teammate && { name: typeof input.name === 'string' ? input.name : null }),
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
  if (record.kind === 'teammate' && ['in-process', 'tmux', 'iterm2'].includes(result.backend)) record.backend = result.backend;
  record.updatedAt = new Date().toISOString();
  await writeRecord(path, record);
  if (!failed && record.agentId) await writeRecord(recordPath(root, 'agents', input.session_id, record.agentId), {
    sessionId: input.session_id, agentId: record.agentId, role: record.role,
    effectiveModel: record.effectiveModel, toolUseId: record.toolUseId,
    ...(record.effectiveEffort && { effectiveEffort: record.effectiveEffort }),
    ...(record.kind === 'teammate' && { kind: 'teammate', name: record.name, backend: record.backend ?? null }),
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

export async function handleRequest(input, env = process.env, discover = fetchModels, timing = { confirmMs: 5000, stepMs: 250 }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a bridge JSON object.');
  if (!['bootstrap', 'catalog', 'route', 'result', 'observe', 'stats', 'apply'].includes(input.action)) throw new Error('Unknown Agent Router bridge action.');
  if (input.action === 'catalog') return catalog(env, discover);
  if (input.action === 'stats') return sessionStats(stateDirectory(env), input.session_id);
  if (input.action === 'bootstrap') return bootstrap(input, env, discover, timing);
  const snapshot = await snapshotFor(input, env);
  if (input.action === 'apply') return apply(input, env, discover, snapshot);
  if (input.action === 'route') return recordRoute(input, env, snapshot);
  if (input.action === 'result') return recordResult(input, env);
  return observe(input, env);
}
