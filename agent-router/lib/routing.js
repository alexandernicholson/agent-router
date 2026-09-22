// Pure policy logic shared by the sandboxed Mod and its Node bridge.
export const ROLES = ['scout', 'reviewer', 'security-reviewer', 'task', 'sonic'];
// The engine's effort levels; a role without one keeps the engine's own effort.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function isExactModelId(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value) &&
    !['inherit', 'sonnet', 'opus', 'haiku', 'fable'].includes(value.toLowerCase());
}

export function validatePolicy(value) {
  if (!value || value.version !== 1 || !value.roles || typeof value.roles !== 'object') {
    throw new Error('Routing policy must have version 1 and a roles object.');
  }
  if (Object.keys(value).some(key => !['version', 'roles'].includes(key))) {
    throw new Error('Unknown routing policy field.');
  }
  if (Object.keys(value.roles).sort().join() !== [...ROLES].sort().join()) {
    throw new Error(`Routing policy must define exactly ${ROLES.join(', ')}.`);
  }
  const aliases = new Set(ROLES.map(role => `agent-router:${role}`));
  for (const role of ROLES) {
    const entry = value.roles[role];
    if (!entry || Object.keys(entry).some(key => !['model', 'aliases', 'effort'].includes(key)) ||
        !isExactModelId(entry.model)) {
      throw new Error(`Role ${role} requires an exact model ID, not a family alias.`);
    }
    if ('effort' in entry && !EFFORTS.includes(entry.effort)) {
      throw new Error(`Role ${role} has an invalid effort; use one of ${EFFORTS.join(', ')}.`);
    }
    if (!Array.isArray(entry.aliases) || entry.aliases.some(alias =>
      typeof alias !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(alias) || alias === 'fork')) {
      throw new Error(`Role ${role} has invalid aliases.`);
    }
    for (const alias of entry.aliases) {
      if (aliases.has(alias)) throw new Error(`Duplicate agent alias: ${alias}`);
      aliases.add(alias);
    }
  }
  return value;
}

export function resolveRole(policy, type) {
  return ROLES.find(role => type === `agent-router:${role}` || policy.roles[role].aliases.includes(type));
}

/** @returns {{ role: string, type: string, model: string, effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }} */
export function routeAgent(policy, input) {
  if (input.fork === true || input.subagentType === 'fork') {
    throw new Error('Agent Router cannot assign a model to a fork: forks inherit the parent. Use a named role.');
  }
  const type = input.subagentType;
  const role = resolveRole(policy, type);
  if (!role || !policy.roles[role]) {
    throw new Error(`No routing policy for agent type ${JSON.stringify(type)}. Select a configured Agent Router role.`);
  }
  // Keep the native read-only Plan definition while assigning the task model.
  const selected = { role, type: type === 'Plan' ? 'Plan' : `agent-router:${role}`, model: policy.roles[role].model };
  return policy.roles[role].effort === undefined ? selected : { ...selected, effort: policy.roles[role].effort };
}

export function isTruthy(value) {
  return typeof value === 'string' && !['', '0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

// Context suffixes affect request options; Claude sometimes omits them in telemetry.
export function sameModel(left, right) {
  return typeof left === 'string' && typeof right === 'string' &&
    left.replace(/\[1m\]$/i, '') === right.replace(/\[1m\]$/i, '');
}
