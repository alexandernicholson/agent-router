import { createHash } from 'node:crypto';
import { validatePolicy, isExactModelId, ROLES, EFFORTS } from './routing.js';

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
  const policy = { version: 1, roles };
  const teammate = {};
  const mateModel = options.teammate_model;
  if (typeof mateModel === 'string' && mateModel.trim() && mateModel !== 'default') {
    if (!isExactModelId(mateModel)) throw new Error('Choose an exact model ID or default for teammate_model in /agent-models.');
    teammate.model = mateModel;
  }
  const mateEffort = options.teammate_effort;
  if (mateEffort !== undefined && mateEffort !== '' && mateEffort !== 'default') {
    if (!EFFORTS.includes(mateEffort)) throw new Error(`Choose default or one of ${EFFORTS.join(', ')} for teammate_effort in /agent-models.`);
    teammate.effort = mateEffort;
  }
  if (Object.keys(teammate).length) policy.teammate = teammate;
  return validatePolicy(policy);
}

export function policyDigest(policy) {
  // Effort joins the digest only when set, so pre-effort sessions keep theirs.
  const normalized = ROLES.map(role => {
    const { model, aliases, effort } = policy.roles[role];
    return effort === undefined ? [role, model, [...aliases].sort()] : [role, model, [...aliases].sort(), effort];
  });
  // The teammate override joins only when set, so earlier sessions keep theirs.
  if (policy.teammate) normalized.push(['teammate', policy.teammate.model ?? null, policy.teammate.effort ?? null]);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
