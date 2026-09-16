import { createHash } from 'node:crypto';
import { validatePolicy, ROLES } from './routing.js';

const aliases = {
  scout: ['scout', 'Explore'], reviewer: ['reviewer'],
  'security-reviewer': ['security-reviewer'], task: ['task', 'general-purpose', 'Plan'], sonic: ['sonic'],
};

export function policyFromOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Agent Router options must be an object.');
  }
  const missing = ROLES.map(role => `${role.replaceAll('-', '_')}_model`).filter(key => typeof options[key] !== 'string' || !options[key].trim());
  if (missing.length) throw new Error(`Choose a model for each role in /agent-models: ${missing.join(', ')}.`);
  const roles = {};
  for (const role of ROLES) {
    const key = `${role.replaceAll('-', '_')}_model`;
    roles[role] = { model: options[key], aliases: [...aliases[role]] };
  }
  return validatePolicy({ version: 1, roles });
}

export function policyDigest(policy) {
  const normalized = ROLES.map(role => [role, policy.roles[role].model, [...policy.roles[role].aliases].sort()]);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
