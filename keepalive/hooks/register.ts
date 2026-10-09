import type { On, PluginOptions, Timer } from 'claude-code';
import { createCachePanel, CACHE_PANE, CACHE_COMMANDS, upkeepMode, ttlOption, keepaliveLimit, compactThreshold } from './cache-panel';
import { createSettingsPane, SETTINGS_PANE, type SettingsHost } from './settings-pane';
import { createBridge, type Bridge } from './shared/bridge';
import { fallbackTtl, parseTtlOverrides } from '../lib/cache.js';
import { resolveDefaultTtl } from '../lib/cache-ttl.js';
import type { TtlAuth } from '../lib/cache-ttl.js';

type Teammate = { agentId: string; agentName?: string; parentSessionId: string };
type StoredConfigs = Record<string, { options?: Record<string, unknown> }>;
const HANDED_KEY = 'handed-over';
const LEGACY = ['cache_ttl', 'subagent_cache_ttl', 'teammate_cache_ttl', 'teammate_cache_upkeep', 'keepalive_limit'];

export function legacyOptions(options: PluginOptions, stored: StoredConfigs) {
  const own = Object.entries(stored).find(([id]) => id === 'keepalive' || id.startsWith('keepalive@'))?.[1]?.options ?? {};
  const router = Object.entries(stored).find(([id]) => id === 'agent-router' || id.startsWith('agent-router@'))?.[1]?.options ?? {};
  return (key: string) => LEGACY.includes(key) && !(key in own) && typeof router[key] === 'string' ? router[key] : options[key];
}

export function register(on: On, options: PluginOptions) {
  const cachePanel = createCachePanel();
  const settings = createSettingsPane();
  let cacheTimer: Timer | undefined;
  let cacheTicks = 0;
  let bridge: Bridge | undefined;
  let settingsHost: SettingsHost | undefined;
  let started: Promise<void> = Promise.resolve();

  on('classic.SessionStart', ($, e, next) => {
    cachePanel.setTranscript(e.session_id, null, e.transcript_path);
    return next(e);
  });
  on('classic.SubagentStart', ($, e, next) => {
    cachePanel.setTranscript(e.session_id, null, e.transcript_path);
    return next(e);
  });
  on('classic.PostToolUse', async ($, e, next) => {
    cachePanel.setTranscript(e.session_id, null, e.transcript_path);
    await cachePanel.enrich(e.session_id, e.agent_id ?? null);
    return next(e);
  });
  on('classic.Stop', async ($, e, next) => {
    cachePanel.setTranscript(e.session_id, null, e.transcript_path);
    await cachePanel.enrich(e.session_id, e.agent_id ?? null);
    return next(e);
  });
  on('classic.SubagentStop', async ($, e, next) => {
    await cachePanel.enrich(e.session_id, e.agent_id, e.agent_transcript_path);
    return next(e);
  });

  on('session.start', async ($, e, next) => {
    let finish!: () => void;
    started = new Promise(resolve => { finish = resolve; });
    try {
      cacheTimer?.cancel();
      const sessionId = await $.session.id();
      bridge = createBridge((argv, init) => $.process.run(argv, init), $.plugin.root, () => ({ session_id: sessionId }), 'Keepalive bridge failed.');
      const migrated = await bridge({ action: 'migrate' }).catch(() => undefined);
      const handed = migrated?.handover as Record<string, unknown> | null | undefined;
      if (handed && !await $.store.get(HANDED_KEY).catch(() => true)) {
        for (const [key, value] of Object.entries(handed)) if (await $.store.get(key) === undefined) await $.store.set(key, value);
        await $.store.set(HANDED_KEY, 1);
      }
      const identity = await bridge({ action: 'identity' }).then(found => found.teammate as Teammate | null, () => null);
      const teammate = identity && identity.parentSessionId !== sessionId ? identity : null;
      if (teammate) await bridge({ action: 'link', lead_session_id: teammate.parentSessionId, label: `${teammate.agentName || 'Teammate'} (${teammate.agentId})` }).catch(() => undefined);
      const stored = await $.settings.read().catch(() => ({})) as { pluginConfigs?: Record<string, { options?: Record<string, unknown> }> };
      const option = legacyOptions(options, stored.pluginConfigs ?? {});
      const ownLimit = teammate ? option('teammate_keepalive_limit') : 'same';
      const cacheEnv = {
        DISABLE_PROMPT_CACHING: await $.env.get('DISABLE_PROMPT_CACHING').catch(() => undefined),
        DISABLE_PROMPT_CACHING_HAIKU: await $.env.get('DISABLE_PROMPT_CACHING_HAIKU').catch(() => undefined),
        DISABLE_PROMPT_CACHING_SONNET: await $.env.get('DISABLE_PROMPT_CACHING_SONNET').catch(() => undefined),
        DISABLE_PROMPT_CACHING_OPUS: await $.env.get('DISABLE_PROMPT_CACHING_OPUS').catch(() => undefined),
        COLORFGBG: await $.env.get('COLORFGBG').catch(() => undefined),
        CLAUDE_CODE_PROMPT_CACHE_TTL: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(() => undefined),
        CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL').catch(() => undefined),
        ENABLE_PROMPT_CACHING_1H: await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(() => undefined),
        ENABLE_PROMPT_CACHING_1H_BEDROCK: await $.env.get('ENABLE_PROMPT_CACHING_1H_BEDROCK').catch(() => undefined),
        CLAUDE_CODE_USE_BEDROCK: await $.env.get('CLAUDE_CODE_USE_BEDROCK').catch(() => undefined),
        FORCE_PROMPT_CACHING_5M: await $.env.get('FORCE_PROMPT_CACHING_5M').catch(() => undefined),
      };
      const auth = async (): Promise<TtlAuth> => {
        const credential = await $.session.authorize().catch(() => null);
        if (credential?.kind === 'bearer') return 'subscription';
        return credential ? 'api-key' : 'gateway';
      };
      const ttlDefaults = async () => {
        const [read, kind] = await Promise.all([$.settings.read().catch(() => ({})), auth()]);
        const resolve = (scope: 'main' | 'subagent') => resolveDefaultTtl({ scope, env: cacheEnv, settings: read as Record<string, unknown>, auth: kind });
        return { main: resolve('main'), subagent: resolve('subagent') };
      };
      settingsHost = {
        plugin: { name: $.plugin.name },
        ui: { invalidate: event => $.ui.invalidate(event), open: input => $.ui.open(input), close: input => $.ui.close(input),
          log: (text, logSettings) => $.ui.log(text, logSettings), resolve: input => $.ui.resolve(input) },
        config: { list: () => $.config.list(), set: input => $.config.set(input) },
        command: { register: input => $.command.register(input) },
        ttlDefaults,
        store: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), delete: key => $.store.delete(key) },
        release: () => cachePanel.release(),
      };
      await settings.register(settingsHost);
      await cachePanel.initialize({
        session: { id: () => $.session.id(), compact: input => $.session.compact(input) },
        config: { list: () => $.config.list() },
        agent: { list: () => $.agent.list() },
        clock: { now: () => $.clock.now(), sleep: ms => $.clock.sleep(ms) },
        model: { fork: request => $.model.fork(request) },
        store: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) },
        ui: { invalidate: event => $.ui.invalidate(event), open: input => $.ui.open(input),
          close: input => $.ui.close(input), log: (text, logSettings) => $.ui.log(text, logSettings) },
        command: { register: input => $.command.register(input) },
        env: { set: (name, value) => name === 'CLAUDE_CODE_PROMPT_CACHE_TTL' ? $.env.set('CLAUDE_CODE_PROMPT_CACHE_TTL', value)
          : $.env.set('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', value) },
        settings: { read: input => $.settings.read(input) },
        auth,
        http: { fetch: (url, init) => $.http.fetch(url, init) },
        credentials: async (): Promise<Record<string, string>> => {
          const token = await $.env.get('ANTHROPIC_AUTH_TOKEN').catch(() => undefined);
          const key = await $.env.get('ANTHROPIC_API_KEY').catch(() => undefined);
          return token ? { authorization: `Bearer ${token}` } : key ? { 'x-api-key': key } : {};
        },
      }, bridge, sessionId, await $.env.get('ANTHROPIC_BASE_URL').catch(() => undefined), teammate ? teammate.agentName || teammate.agentId : undefined, {
        env: cacheEnv,
        ttl: teammate
          ? { main: ttlOption(option('teammate_cache_ttl')), subagent: ttlOption(option('subagent_cache_ttl')), teammate: ttlOption(option('teammate_cache_ttl')) }
          : { main: ttlOption(option('cache_ttl')), subagent: ttlOption(option('subagent_cache_ttl')), teammate: ttlOption(option('teammate_cache_ttl')) },
        upkeep: upkeepMode(option(teammate ? 'teammate_cache_upkeep' : 'cache_upkeep')),
        limit: keepaliveLimit(String(ownLimit).trim().toLowerCase() === 'same' ? option('keepalive_limit') : ownLimit),
        compactAt: compactThreshold(option('compact_threshold')),
        fallback: { ttl: fallbackTtl(String(option('unreported_ttl')).trim().toLowerCase()), models: parseTtlOverrides(option('unreported_ttl_models')),
          priceUrl: String(option('keepalive_price_url')).trim() },
      });
      if (e.isInteractive && e.surface === 'terminal') {
        await cachePanel.introduce();
        cacheTicks = 0;
        cacheTimer = $.clock.every(1000, async () => {
          await cachePanel.tick();
          if (++cacheTicks % 5 === 0) await cachePanel.refresh();
        });
      }
    } catch {
      $.ui.log('Keepalive: the cache bar could not start in this session.', { to: 'debug' });
    } finally { finish(); }
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    await started;
    const ticket = await cachePanel.begin(e).catch(() => undefined);
    let usage;
    try {
      const result = yield* next(e);
      usage = result.usage;
      return result;
    } finally {
      await cachePanel.finish(ticket, e, usage).catch(() => undefined);
    }
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const content = await next(e);
    const viewed = e.props.view.agentId;
    await cachePanel.view(viewed);
    return cachePanel.renderBand($.ui.resolve(e), content, viewed);
  });

  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute') return next(e);
    const startedAt = await $.clock.now();
    const result = await cachePanel.holdTtlFor(e.agentId ?? null, () => next(e));
    if (result.messages) await cachePanel.compacted(e.agentId ?? null, startedAt, result).catch(() => undefined);
    return result;
  });

  on('session.end', async ($, e, next) => {
    await cachePanel.settle();
    if (e.reason === 'clear') cachePanel.clear();
    else { cacheTimer?.cancel(); cacheTimer = undefined; }
    return next(e);
  });

  on('ui.render', { component: 'Pane' }, ($, e, next) =>
    (e.requestId === CACHE_PANE && cachePanel.renderPane($.ui.resolve(e), e.props.view.agentId, e.props.bodyColumns)) ||
    (settingsHost && settings.uiRender(settingsHost, e)) || next(e));
  for (const command of CACHE_COMMANDS) on('command.run', { command }, async () => ({ text: await cachePanel.show()
    ? 'Keepalive dashboard opened. Select an agent to inspect recent requests.'
    : 'Keepalive dashboard is unavailable. Check session setup or widen the terminal.' }));
  on('command.run', { command: SETTINGS_PANE }, ($, e) => settingsHost
    ? settings.commandRun(settingsHost, e) : { text: 'Run /keepalive-settings after session setup completes.' });
  on('ui.close', { id: CACHE_PANE }, ($, e, next) => { cachePanel.close(); return next(e); });
  on('ui.close', { id: SETTINGS_PANE }, ($, e, next) => { settings.close(); return next(e); });
}
