/** @typedef {'5m' | '1h'} Ttl */
/** @typedef {'main' | 'subagent'} TtlScope */
/** @typedef {'subscription' | 'api-key' | 'gateway'} TtlAuth */
/** @typedef {{ttl: Ttl, reason: string, locked: boolean}} TtlDefault */

/** @param {unknown} value */
export const isTtl = value => value === '5m' || value === '1h';
const truthy = value => typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());

const SCOPES = {
  main: { env: 'CLAUDE_CODE_PROMPT_CACHE_TTL', setting: 'promptCacheTtl' },
  subagent: { env: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', setting: 'subagentPromptCacheTtl' },
};

/**
 * @param {{scope: TtlScope, env: Record<string, unknown>, settings: Record<string, unknown>, auth: TtlAuth}} input
 * @returns {TtlDefault}
 */
export function resolveDefaultTtl({ scope, env, settings, auth }) {
  const { env: variable, setting } = SCOPES[scope];
  if (truthy(env.FORCE_PROMPT_CACHING_5M)) return { ttl: '5m', reason: 'FORCE_PROMPT_CACHING_5M', locked: true };
  if (isTtl(env[variable])) return { ttl: /** @type {Ttl} */ (env[variable]), reason: variable, locked: false };
  if (isTtl(settings?.[setting])) return { ttl: /** @type {Ttl} */ (settings[setting]), reason: `${setting} in your Claude Code settings`, locked: false };
  if (truthy(env.ENABLE_PROMPT_CACHING_1H)) return { ttl: '1h', reason: 'ENABLE_PROMPT_CACHING_1H', locked: false };
  if (truthy(env.CLAUDE_CODE_USE_BEDROCK) && truthy(env.ENABLE_PROMPT_CACHING_1H_BEDROCK)) {
    return { ttl: '1h', reason: 'ENABLE_PROMPT_CACHING_1H_BEDROCK', locked: false };
  }
  if (scope === 'subagent') return { ttl: '5m', reason: 'Claude Code default outside the main conversation', locked: false };
  return auth === 'subscription' ? { ttl: '1h', reason: 'Claude Code default for a Claude subscription', locked: false }
    : { ttl: '5m', reason: 'Claude Code default for API keys and gateways', locked: false };
}

/**
 * @param {(value: Ttl | null) => Promise<void>} write
 */
export function createTtlGate(write) {
  /** @type {Ttl | null} */
  let applied = null;
  /** @type {Ttl | null | undefined} */
  let current;
  let holders = 0;
  /** @type {{value: Ttl | null, start: () => void}[]} */
  const queue = [];
  let writing = Promise.resolve();
  const apply = value => {
    if (applied === value) return writing;
    applied = value;
    writing = writing.then(() => write(value)).catch(() => undefined);
    return writing;
  };
  const releaser = () => {
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      holders--;
      if (holders > 0) return;
      current = undefined;
      if (!queue.length) return apply(null);
      const value = queue[0].value;
      const batch = [];
      while (queue.length && queue[0].value === value) batch.push(/** @type {{value: Ttl | null, start: () => void}} */ (queue.shift()));
      current = value;
      holders += batch.length;
      await apply(value);
      for (const waiter of batch) waiter.start();
    };
  };
  return {
    /**
     * @param {Ttl | null} value
     * @returns {Promise<() => Promise<void>>}
     */
    async acquire(value) {
      if (!queue.length && (holders === 0 || current === value)) {
        current = value;
        holders++;
        await apply(value);
        return releaser();
      }
      await new Promise(start => queue.push({ value, start: () => start(undefined) }));
      return releaser();
    },
  };
}
