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
 * @param {{base: Ttl, buildMs: number, sleep: (ms: number) => Promise<void>, live: () => Ttl[]}} timing
 */
export function createTtlGate(write, { base, buildMs, sleep, live }) {
  /** @type {Ttl | null} */
  let applied = null;
  /** @type {Map<object, Ttl | null>} */
  const answering = new Map();
  /** @type {{value: Ttl | null, holders: Set<object>} | undefined} */
  let building;
  /** @type {{value: Ttl | null, start: () => void}[]} */
  const queue = [];
  let writing = Promise.resolve();
  const apply = value => {
    if (applied === value) return writing;
    applied = value;
    writing = writing.then(() => write(value)).catch(() => undefined);
    return writing;
  };
  const settle = () => {
    if (queue.length) {
      const value = queue[0].value;
      const waiters = queue.filter(waiter => waiter.value === value);
      queue.splice(0, queue.length, ...queue.filter(waiter => waiter.value !== value));
      building = { value, holders: new Set() };
      for (const waiter of waiters) waiter.start();
      return apply(value);
    }
    building = undefined;
    const wanted = [...answering.values()].map(value => value ?? base).concat(live());
    return apply(base === '1h' && wanted.includes('5m') ? '5m' : null);
  };
  const hold = () => {
    const token = {};
    const own = /** @type {{value: Ttl | null, holders: Set<object>}} */ (building);
    own.holders.add(token);
    answering.set(token, own.value);
    const built = () => {
      if (own.holders.delete(token) && !own.holders.size && building === own) void settle();
    };
    sleep(buildMs).then(built, built);
    return async () => {
      if (!answering.delete(token)) return;
      const wasBuilding = own.holders.delete(token);
      if (wasBuilding ? !own.holders.size && building === own : !building) await settle();
    };
  };
  return {
    /**
     * @param {Ttl | null} value
     * @returns {Promise<() => Promise<void>>}
     */
    async acquire(value) {
      if (!queue.length && (!building || building.value === value)) {
        building ??= { value, holders: new Set() };
        const release = hold();
        await apply(value);
        return release;
      }
      /** @type {() => Promise<void>} */
      const release = await new Promise(granted => queue.push({ value, start: () => granted(hold()) }));
      await writing;
      return release;
    },
    async refresh() {
      if (!building && !queue.length) await settle();
    },
  };
}
