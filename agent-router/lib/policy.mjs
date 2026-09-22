import { createHash } from 'node:crypto';
import { validatePolicy, ROLES, EFFORTS } from './routing.js';

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
    const effortKey = `${role.replaceAll('-', '_')}_effort`;
    const effort = options[effortKey];
    if (effort === undefined || effort === '' || effort === 'default') continue;
    if (!EFFORTS.includes(effort)) throw new Error(`Choose default or one of ${EFFORTS.join(', ')} for ${effortKey} in /agent-models.`);
    roles[role].effort = effort;
  }
  return validatePolicy({ version: 1, roles });
}

export function policyDigest(policy) {
  // Effort joins the digest only when set, so pre-effort sessions keep theirs.
  const normalized = ROLES.map(role => {
    const { model, aliases, effort } = policy.roles[role];
    return effort === undefined ? [role, model, [...aliases].sort()] : [role, model, [...aliases].sort(), effort];
  });
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
