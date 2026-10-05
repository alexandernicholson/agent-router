export function isTruthy(value) {
  return typeof value === 'string' && !['', '0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

export function sameModel(left, right) {
  return typeof left === 'string' && typeof right === 'string' &&
    left.replace(/\[1m\]$/i, '') === right.replace(/\[1m\]$/i, '');
}

/** @param {{id: string, type: string, teammateId?: string} | undefined} agent */
export const isTeammate = agent => !!agent && (agent.type === 'teammate' || typeof agent.teammateId === 'string');
/** @param {{id: string, type: string, teammateId?: string} | undefined} agent */
export const isPaneTeammate = agent => !!agent && typeof agent.teammateId === 'string' && agent.id === agent.teammateId;
