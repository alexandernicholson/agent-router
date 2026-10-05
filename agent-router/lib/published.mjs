import { writeRoutes } from './shared/routes.mjs';
import { linkedTeammates } from './state.mjs';

export async function publishRoutes(root, session, agents) {
  if (!session?.sessionId) return null;
  const policy = session.active ? session.policy : null;
  const linked = session.active ? await linkedTeammates(root, session.sessionId) : [];
  return writeRoutes(root, {
    sessionId: session.sessionId,
    leadSessionId: session.leadSessionId ?? null,
    self: session.active && session.self ? { role: session.self.role, model: session.self.model, ...(session.self.effort ? { effort: session.self.effort } : {}) } : null,
    teammate: session.active && session.teammate ? { agentId: session.teammate.agentId, name: session.teammate.name ?? null } : null,
    agents: policy ? agents.filter(agent => typeof agent.agentId === 'string' && typeof agent.effectiveModel === 'string' && typeof agent.role === 'string').map(agent => ({
      agentId: agent.agentId, kind: agent.kind === 'teammate' ? 'teammate' : 'subagent', role: agent.role, model: agent.effectiveModel,
      ...(agent.effectiveEffort ? { effort: agent.effectiveEffort } : {}),
      ...(agent.kind === 'teammate' ? { name: agent.name ?? null, backend: agent.backend ?? null } : {}),
    })) : [],
    teammates: [...new Set(linked.map(link => link.sessionId))],
  });
}
