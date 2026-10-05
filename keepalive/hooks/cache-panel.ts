import type { AgentInfo, Elements, EngineInterface, RenderElement, RenderSurface, SessionCompacted, TurnStepInput, TurnUsage } from 'claude-code';
import { applyCacheCreation, reportedCacheCreation, cacheBar, cacheBarParts, cacheClock, cacheDial, cacheGrade, cachePercent, cachePolicy, cacheRows, cacheStatus, cacheTokens, isCompaction, isKeepalive, keepaliveWorthwhile, keepalivesLeft, lifeGrade, loopKey, recentMisses, recentUsage, sampleKey, sampleTtl, unreportedModels, validSample, sessionMatrix, sessionUsage, cacheGap, MISS_WINDOW_MS, RATE_REQUESTS } from '../lib/cache.js';
import { validPrices } from '../lib/cache.js';
import type { CachePrices, CacheRow, CacheSample, CacheReset, CacheStatus } from '../lib/cache.js';
import { CACHE_COLORS, themeFamily } from '../lib/cache-colors.js';
import { displayText } from '../lib/shared/text.js';
import { isPaneTeammate, isTeammate, sameModel } from '../lib/shared/models.js';
import { createTtlGate, isTtl, resolveDefaultTtl } from '../lib/cache-ttl.js';
import type { Ttl, TtlAuth, TtlDefault } from '../lib/cache-ttl.js';

export const CACHE_PANE = 'keepalive';
export const CACHE_COMMANDS = ['keepalive', 'agent-cache'] as const;
const RECHECK_MS = [1000, 3000, 10000, 30000];
const UPKEEP_MS = 30000;
const COMPACT_MIN_TOKENS = 100000;
const UPKEEP = ['off', 'warm', 'compact', 'warmcomp'] as const;
const UPKEEP_KEY = 'cache-upkeep';
const KEEPALIVE_PROMPT = 'Reply with only: OK';
const PRICES_MS = 3600000;
const MISS_FRESH_MS = 300000;
const TTL_KEY = 'cache-ttl';
const TTL_ENV = { main: 'CLAUDE_CODE_PROMPT_CACHE_TTL', subagent: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL' } as const;
type TtlScope = keyof typeof TTL_ENV;
type TtlChoice = { ttl: Ttl; reason: string; locked: boolean; chosen: boolean };
export type TtlDefaults = { main?: Ttl; subagent?: Ttl; teammate?: Ttl };
export const ttlOption = (value: unknown): Ttl | undefined => isTtl(value) ? value : undefined;
const INTRO_KEY = 'cache-intro';
const INTRO = [
  'Prompt cache bar: Keepalive shows how well each conversation reuses its prompt cache.',
  '  [ ◕ ] dial: time until the cache expires; it refills with each request. Click it, or run /keepalive, for every agent\'s cache and request history.',
  '  96%: share of the last 10 requests served from cache, coloured blue (good), yellow (fair) or red (poor) for the context size.',
  '  ✕ 2 prefix: cache misses in the last 15 minutes and their causes; click for details. It dims after 5 minutes.',
  '  TTL 5m: this conversation\'s cache lifetime; click to switch between 5m and 1h. ETA ~3:44 is the time left.',
  '  Mode button: click to cycle what happens 30 seconds before an idle main conversation\'s cache expires:',
  '    off (default) sends nothing.',
  '    warm sends cheap keepalive requests, by default while they cost less than rewriting the cache; ↻ shows how many are left.',
  '    compact summarises a conversation of 100k+ tokens while it is still cached.',
  '    warmcomp warms first, then compacts.',
  '  Keepalives and compactions are billed. Set how many, and each kind of conversation\'s defaults, with /keepalive-settings.',
];
type Upkeep = typeof UPKEEP[number];
export const upkeepMode = (value: unknown): Upkeep | undefined => UPKEEP.find(mode => mode === value);
export const keepaliveLimit = (value: unknown): number | undefined => {
  const text = String(value).trim().toLowerCase();
  if (text === 'infinite') return Infinity;
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : undefined;
};
const AGENT_FILTERS = ['all', 'main', 'subagents', 'teammates'] as const;
const REQUEST_FILTERS = ['all', 'real', 'keepalives', 'compactions', 'misses'] as const;
type Kind = 'main' | 'subagent' | 'in-process teammate' | 'split-pane teammate';
type Node = { row: CacheRow; kind: Kind; depth: number; prefix: string; body: string; upkeep?: Upkeep };
type Family = keyof typeof CACHE_COLORS;
type Palette = typeof CACHE_COLORS[Family];
const MARKERS: Record<Upkeep, (keyof Palette)[]> = { off: [], warm: ['warm'], compact: ['compact'], warmcomp: ['warm', 'compact'] };
type Segment = { text: string; color?: string; dim?: boolean };
type Bridge = (request: Record<string, unknown>) => Promise<any>;
type Routes = { self: { model: string } | null; agents: { agentId: string; model: string }[] } | null;
export type CachePanelHost = {
  session: Pick<EngineInterface['session'], 'id' | 'compact'>;
  config: Pick<EngineInterface['config'], 'list'>;
  agent: Pick<EngineInterface['agent'], 'list'>;
  clock: Pick<EngineInterface['clock'], 'now'>;
  model: Pick<EngineInterface['model'], 'fork'>;
  store: Pick<EngineInterface['store'], 'get' | 'set'>;
  ui: Pick<EngineInterface['ui'], 'invalidate' | 'open' | 'close' | 'log'>;
  command: Pick<EngineInterface['command'], 'register'>;
  env: Pick<EngineInterface['env'], 'set'>;
  settings: Pick<EngineInterface['settings'], 'read'>;
  auth: () => Promise<TtlAuth>;
};
type Context = {
  host: CachePanelHost;
  bridge: Bridge;
  sessionId: string;
  endpoint?: string;
  selfLabel?: string;
  env: Record<string, string | undefined>;
  upkeep: Upkeep;
  limit?: number;
  family: Family;
  samples: Map<string, CacheSample>;
  resets: CacheReset[];
  labels: Map<string, string>;
  roster: AgentInfo[];
  routes: Routes;
  now: number;
  pending: Map<string, { request: string; changed: boolean; startedAt: number }>;
  requested: Map<string, string>;
  rechecks: Map<string, number>;
  rechecking?: Promise<void>;
  prices: Map<string, { at: number; value: CachePrices | null; settled: boolean; lookup?: Promise<void> }>;
  actedAt?: number;
  upkeeping?: Promise<void>;
  refresh?: Promise<void>;
  available: boolean;
  defaults: Record<TtlScope, TtlDefault>;
  ttlDefaults: TtlDefaults;
  ttls: Map<string, Ttl>;
  kinds: Map<string, 'subagent' | 'teammate'>;
  gate: ReturnType<typeof createTtlGate>;
  mainApplied: string | undefined;
};

export function createCachePanel() {
  let context: Context | undefined;
  let open = false;
  let selected: string | undefined;
  let agentFilter: typeof AGENT_FILTERS[number] = 'all';
  let requestFilter: typeof REQUEST_FILTERS[number] = 'all';
  let historyScope: 'agent' | 'all' = 'agent';
  let paneModes = new Map<string, Upkeep>();
  let lastDisplay = '';
  let previous: Context | undefined;
  const transcripts = new Map<string, string>();

  function setTranscript(sessionId: string, agentId: string | null, path: string) {
    if (path.endsWith('.jsonl')) transcripts.set(loopKey(sessionId, agentId), path);
  }

  function transcript(current: Context, agentId: string | null) {
    const exact = transcripts.get(loopKey(current.sessionId, agentId));
    if (exact || !agentId || !/^[A-Za-z0-9_-]+$/.test(agentId)) return exact;
    const main = transcripts.get(loopKey(current.sessionId, null));
    return main ? `${main.slice(0, -6)}/subagents/agent-${agentId}.jsonl` : undefined;
  }

  async function enrich(sessionId: string, agentId: string | null, path?: string) {
    const current = context;
    if (!current || current.sessionId !== sessionId) return;
    if (path) setTranscript(sessionId, agentId, path);
    const source = transcript(current, agentId);
    if (!source) return;
    try {
      const result = await send(current, { action: 'cache-enrich', agent_id: agentId, transcript_path: source });
      if (context !== current || !Array.isArray(result.samples)) return;
      for (const sample of result.samples) if (validSample(sample)) current.samples.set(sampleKey(sample), sample);
      if (result.samples.length) redraw(current);
    } catch {}
  }

  const send = (current: Context, request: Record<string, unknown>) => current.bridge({ ...request, session_id: current.sessionId });

  function redraw(current: Context) {
    if (context !== current) return;
    try { current.host.ui.invalidate('ui.render'); } catch {}
  }

  function rows(current: Context): CacheRow[] {
    const labels = new Map(current.labels);
    if (current.selfLabel) labels.set(loopKey(current.sessionId, null), current.selfLabel);
    for (const agent of current.roster) {
      labels.set(loopKey(current.sessionId, agent.id), `${agent.name || agent.type} (${agent.id})`);
    }
    const result = cacheRows([...current.samples.values()], current.resets, labels);
    const linked = new Set(result.filter(row => row.sessionId !== current.sessionId && row.agentId === null).map(row => row.label));
    const placed = current.roster.filter(agent => !(isPaneTeammate(agent) && linked.has(labels.get(loopKey(current.sessionId, agent.id))!)));
    for (const agentId of [null, ...placed.map(agent => agent.id)]) {
      if (!result.some(row => row.sessionId === current.sessionId && row.agentId === agentId)) {
        result.push({ sessionId: current.sessionId, agentId, label: labels.get(loopKey(current.sessionId, agentId)) ?? 'Main',
          samples: [], keepalives: [], totals: { requests: 0, read: 0, write: 0, fresh: 0, output: 0 } });
      }
    }
    return result.sort((a, b) => {
      const mainA = a.sessionId === current.sessionId && a.agentId === null;
      const mainB = b.sessionId === current.sessionId && b.agentId === null;
      return Number(mainB) - Number(mainA) || a.label.localeCompare(b.label) || loopKey(a.sessionId, a.agentId).localeCompare(loopKey(b.sessionId, b.agentId));
    });
  }

  const mainRow = (current: Context) => rows(current).find(row => row.sessionId === current.sessionId && row.agentId === null);

  function kindOf(current: Context, row: CacheRow): Kind {
    if (row.agentId === null) return row.sessionId === current.sessionId ? 'main' : 'split-pane teammate';
    const agent = row.sessionId === current.sessionId ? current.roster.find(item => item.id === row.agentId) : undefined;
    return isPaneTeammate(agent) ? 'split-pane teammate' : isTeammate(agent) ? 'in-process teammate' : 'subagent';
  }

  function tree(current: Context): Node[] {
    const all = rows(current);
    const parents = new Map<string, string>();
    for (const row of all) {
      const key = loopKey(row.sessionId, row.agentId);
      if (row.agentId === null) { if (row.sessionId !== current.sessionId) parents.set(key, loopKey(current.sessionId, null)); continue; }
      const parentId = row.sessionId === current.sessionId ? current.roster.find(item => item.id === row.agentId)?.parentId : undefined;
      const parent = loopKey(row.sessionId, parentId ?? null);
      parents.set(key, all.some(other => loopKey(other.sessionId, other.agentId) === parent) ? parent : loopKey(row.sessionId, null));
    }
    const children = new Map<string, CacheRow[]>();
    for (const row of all) {
      const parent = parents.get(loopKey(row.sessionId, row.agentId));
      if (parent) children.set(parent, [...(children.get(parent) ?? []), row]);
    }
    const nodes: Node[] = [];
    const visit = (row: CacheRow, depth: number, lead: string, last: boolean) => {
      const key = loopKey(row.sessionId, row.agentId);
      const kind = kindOf(current, row);
      const upkeep = kind === 'main' ? current.upkeep : kind === 'split-pane teammate' && row.sessionId !== current.sessionId ? paneModes.get(row.sessionId) ?? 'off' : undefined;
      nodes.push({ row, kind, depth, upkeep, prefix: depth ? `${lead}${last ? '└─ ' : '├─ '}` : '', body: depth ? `${lead}${last ? '   ' : '│  '}` : '' });
      const kids = children.get(key) ?? [];
      kids.forEach((kid, index) => visit(kid, depth + 1, depth ? `${lead}${last ? '   ' : '│  '}` : '', index === kids.length - 1));
    };
    visit(all.find(row => row.sessionId === current.sessionId && row.agentId === null)!, 0, '', true);
    for (const row of all) if (!nodes.some(node => node.row === row)) visit(row, 1, '', true);
    return nodes;
  }

  function marker(elements: Elements[RenderSurface], current: Context, upkeep: Upkeep | undefined): RenderElement[] {
    if (!upkeep) return [elements.Text({ dimColor: true, children: ['–'] })];
    const marks = MARKERS[upkeep];
    return marks.length ? marks.map(name => elements.Text({ color: palette(current)[name], children: ['⬥'] })) : [elements.Text({ dimColor: true, children: ['⬦'] })];
  }

  async function readPaneModes(current: Context) {
    const saved = await savedUpkeep(current.host);
    paneModes = new Map(saved.filter(([id]) => id !== current.sessionId));
  }

  function state(current: Context, row: CacheRow): CacheStatus {
    const pending = current.pending.get(loopKey(row.sessionId, row.agentId));
    const value = cacheStatus(row, current.now, pending?.startedAt, unreportedModels(rows(current), current.now));
    if (pending?.changed && row.last) {
      return { ...value, state: 'model changed · awaiting usage', leftMs: null, lifetimes: [], ttl: undefined };
    }
    return value;
  }

  const palette = (current: Context) => CACHE_COLORS[current.family];

  function rate(current: Context, usage: Pick<CacheSample, 'read' | 'write' | 'fresh'> | undefined, width = 10, column = false): Segment[] {
    const total = usage ? usage.read + usage.write + usage.fresh : 0;
    const percent = cachePercent(usage);
    const grade = cacheGrade(usage);
    const color = grade ? palette(current)[grade] : undefined;
    const { fill, empty } = cacheBarParts(total ? usage!.read / total : null, width, grade);
    const label = percent === null ? 'n/a' : `${percent}%`;
    return [{ text: fill, color }, { text: empty, dim: true }, { text: ` ${column ? label.padStart(4) : label}`, color }];
  }

  function segments(current: Context, row: CacheRow): Segment[] {
    const status = state(current, row);
    const result = rate(current, status.state === 'compacted' ? status.sample : recentUsage(row) ?? status.sample);
    if (status.state === 'compacted') {
      const { before, after } = status.compacted!;
      return [...result, { text: ` · cmpt ✓${before !== undefined && after !== undefined ? ` ${cacheTokens(before)} → ${cacheTokens(after)}` : ''}` }];
    }
    if (!status.ttl) return [...result, { text: ` · ${status.state}` }];
    const wanted = row.sessionId === current.sessionId ? ttlChoice(current, row.agentId).ttl : undefined;
    if (wanted && status.ttl !== wanted) result.push({ text: ` · ${status.ttl} reported` });
    const life = lifeGrade(status.leftMs);
    result.push(status.leftMs && life ? { text: ` · ETA ~${cacheClock(status.leftMs)}`, color: palette(current)[life] }
      : { text: ' · expired', color: palette(current).poor });
    return result;
  }

  function paint(elements: Elements[RenderSurface], parts: Segment[]): RenderElement[] {
    return parts.filter(part => part.text).map(part => elements.Text({ ...(part.color ? { color: part.color } : {}), ...(part.dim ? { dimColor: true } : {}), children: [part.text] }));
  }

  async function refresh(): Promise<void> {
    const current = context;
    if (!current) return;
    if (current.refresh) return current.refresh;
    current.refresh = (async () => {
      try {
        const [snapshot, roster, now, theme] = await Promise.all([
          send(current, { action: 'cache-snapshot' }), current.host.agent.list(), current.host.clock.now(),
          current.host.config.list().then(rows => rows.find(row => row.key === 'theme')?.value, () => undefined),
        ]);
        if (context !== current) return;
        if (theme !== undefined) current.family = themeFamily(theme, current.env.COLORFGBG);
        await readPaneModes(current);
        if (!Array.isArray(snapshot.samples) || !Array.isArray(snapshot.resets) || !Array.isArray(snapshot.labels)) throw new Error('Invalid cache snapshot');
        for (const sample of snapshot.samples) if (validSample(sample)) current.samples.set(sampleKey(sample), sample);
        current.resets = snapshot.resets;
        current.labels = new Map(snapshot.labels);
        current.routes = snapshot.routes ?? null;
        current.roster = roster;
        current.now = now;
        current.available = true;
      } catch {
        if (context === current) current.available = false;
      }
      redraw(current);
    })().finally(() => { current.refresh = undefined; });
    return current.refresh;
  }

  async function savedUpkeep(host: CachePanelHost): Promise<[string, Upkeep][]> {
    try {
      const saved = await host.store.get(UPKEEP_KEY);
      return Array.isArray(saved) ? saved.filter((entry): entry is [string, Upkeep] =>
        Array.isArray(entry) && typeof entry[0] === 'string' && UPKEEP.includes(entry[1])) : [];
    } catch { return []; }
  }

  async function saveUpkeep(current: Context) {
    try {
      const others = (await savedUpkeep(current.host)).filter(([id]) => id !== current.sessionId);
      await current.host.store.set(UPKEEP_KEY, [...others, [current.sessionId, current.upkeep]].slice(-16));
    } catch { current.host.ui.log('Keepalive: cache upkeep choice could not be saved.', { to: 'debug' }); }
  }

  function ttlKind(current: Context, agentId: string | null): 'main' | 'subagent' | 'teammate' {
    if (agentId === null) return 'main';
    const known = current.kinds.get(agentId);
    if (known) return known;
    return isTeammate(current.roster.find(agent => agent.id === agentId)) ? 'teammate' : 'subagent';
  }

  async function learnKind(current: Context, agentId: string) {
    if (current.kinds.has(agentId)) return;
    let agent = current.roster.find(item => item.id === agentId);
    if (!agent) {
      const roster = await current.host.agent.list().catch(() => undefined);
      if (roster) { current.roster = roster; agent = roster.find(item => item.id === agentId); }
    }
    if (agent) current.kinds.set(agentId, isTeammate(agent) ? 'teammate' : 'subagent');
  }

  function ttlChoice(current: Context, agentId: string | null): TtlChoice {
    const scope: TtlScope = agentId === null ? 'main' : 'subagent';
    const base = current.defaults[scope];
    if (base.locked) return { ...base, chosen: false };
    const own = current.ttls.get(loopKey(current.sessionId, agentId));
    if (own) return { ttl: own, reason: 'chosen with the TTL button', locked: false, chosen: true };
    const kind = ttlKind(current, agentId);
    const configured = kind === 'main' ? current.ttlDefaults.main : kind === 'teammate' ? current.ttlDefaults.teammate : current.ttlDefaults.subagent;
    if (configured) return { ttl: configured, reason: `${kind} TTL in /keepalive-settings`, locked: false, chosen: false };
    return { ...base, chosen: false };
  }

  async function savedTtls(host: CachePanelHost): Promise<[string, string, Ttl][]> {
    try {
      const saved = await host.store.get(TTL_KEY);
      return Array.isArray(saved) ? saved.filter((entry): entry is [string, string, Ttl] =>
        Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' && isTtl(entry[2])) : [];
    } catch { return []; }
  }

  async function saveTtls(current: Context) {
    try {
      const others = (await savedTtls(current.host)).filter(([id]) => id !== current.sessionId);
      const mine = [...current.ttls].map(([key, ttl]) => [current.sessionId, key, ttl] as [string, string, Ttl]);
      await current.host.store.set(TTL_KEY, [...others, ...mine].slice(-64));
    } catch { current.host.ui.log('Keepalive: cache TTL choice could not be saved.', { to: 'debug' }); }
  }

  async function setTtlEnv(host: CachePanelHost, name: string, value: string | undefined) {
    try { await host.env.set(name, value); }
    catch { host.ui.log('Keepalive: cache TTL could not be applied; Claude Code keeps its own.', { to: 'debug' }); }
  }

  async function applyMainTtl(current: Context) {
    const choice = ttlChoice(current, null);
    if (choice.locked) return;
    const value = choice.ttl === current.defaults.main.ttl && !choice.chosen && !current.ttlDefaults.main ? current.env[TTL_ENV.main] : choice.ttl;
    if (value === current.mainApplied) return;
    current.mainApplied = value;
    await setTtlEnv(current.host, TTL_ENV.main, value);
  }

  async function cycleTtl(agentId: string | null) {
    const current = context;
    if (!current) return;
    const choice = ttlChoice(current, agentId);
    if (choice.locked) return;
    const key = loopKey(current.sessionId, agentId);
    const next: Ttl = choice.ttl === '5m' ? '1h' : '5m';
    const kind = ttlKind(current, agentId);
    const configured = kind === 'main' ? current.ttlDefaults.main : kind === 'teammate' ? current.ttlDefaults.teammate : current.ttlDefaults.subagent;
    if (next === (configured ?? current.defaults[agentId === null ? 'main' : 'subagent'].ttl)) current.ttls.delete(key);
    else current.ttls.set(key, next);
    if (agentId === null) await applyMainTtl(current);
    redraw(current);
    await saveTtls(current);
  }

  async function holdSubagentTtl(current: Context, agentId: string | null) {
    const choice = ttlChoice(current, agentId);
    if (choice.locked) return async () => {};
    const base = current.defaults.subagent;
    return current.gate.acquire(choice.ttl === base.ttl && !choice.chosen ? null : choice.ttl);
  }

  async function introduce(host: CachePanelHost) {
    try {
      if (await host.store.get(INTRO_KEY)) return;
      await host.store.set(INTRO_KEY, 1);
    } catch { return; }
    for (const line of INTRO) host.ui.log(line);
  }

  async function initialize(host: CachePanelHost, bridge: Bridge, sessionId: string, endpoint: string | undefined, selfLabel: string | undefined,
    configuration: { env: Record<string, string | undefined>; upkeep?: Upkeep; ttl: TtlDefaults; limit?: number }) {
    const saved = (await savedUpkeep(host)).find(([id]) => id === sessionId)?.[1];
    const [settings, auth] = await Promise.all([host.settings.read().catch(() => ({})), host.auth()]);
    const resolve = (scope: TtlScope) => resolveDefaultTtl({ scope, env: configuration.env, settings: settings as Record<string, unknown>, auth });
    const subagent = resolve('subagent');
    const current: Context = { host, bridge, sessionId, endpoint, selfLabel, env: configuration.env, upkeep: saved ?? configuration.upkeep ?? 'off',
      limit: configuration.limit, family: themeFamily(undefined, configuration.env.COLORFGBG),
      samples: new Map(), resets: [], labels: new Map(), roster: [], routes: null, now: 0, pending: new Map(), requested: new Map(), rechecks: new Map(), prices: new Map(), available: true,
      defaults: { main: resolve('main'), subagent }, ttlDefaults: configuration.ttl,
      ttls: new Map((await savedTtls(host)).filter(([id]) => id === sessionId).map(([, key, ttl]) => [key, ttl])), kinds: new Map(),
      gate: createTtlGate(value => setTtlEnv(host, TTL_ENV.subagent, value ?? configuration.env[TTL_ENV.subagent])),
      mainApplied: configuration.env[TTL_ENV.main] };
    context = current;
    selected = undefined;
    open = false;
    lastDisplay = '';
    if (!saved && current.upkeep !== 'off') await saveUpkeep(current);
    await applyMainTtl(current);
    await refresh();
    if (context !== current) return;
    for (const name of CACHE_COMMANDS) await host.command.register({ name, immediate: true, description: name === CACHE_PANE
      ? 'Prompt cache bars, token counts and request history for the main conversation, subagents and teammates.' : 'Same as /keepalive.' });
  }

  async function active(): Promise<Context | undefined> {
    const prior = context ?? previous;
    if (prior) {
      const id = await prior.host.session.id();
      if (!context || id !== prior.sessionId) await initialize(prior.host, prior.bridge, id, prior.endpoint, undefined, { env: prior.env, upkeep: prior.upkeep, ttl: prior.ttlDefaults, limit: prior.limit });
    }
    return context;
  }

  function routedModel(current: Context, request: TurnStepInput) {
    const routed = request.agentId ? current.routes?.agents.find(agent => agent.agentId === request.agentId) : current.routes?.self;
    return routed?.model ?? request.model;
  }

  async function begin(request: TurnStepInput) {
    const current = await active();
    if (!current) return undefined;
    const startedAt = await current.host.clock.now();
    const key = loopKey(current.sessionId, request.agentId);
    const identity = JSON.stringify([request.turnId, request.index]);
    const model = routedModel(current, request);
    const lastRequested = current.requested.get(key);
    const priorModel = rows(current).find(row => loopKey(row.sessionId, row.agentId) === key)?.last?.model;
    const changed = lastRequested !== undefined ? lastRequested !== model
      : priorModel !== undefined && !sameModel(priorModel, model);
    current.requested.set(key, model);
    current.pending.set(key, { request: identity, changed, startedAt });
    if (changed) redraw(current);
    const agentId = request.agentId ?? null;
    if (agentId !== null) await learnKind(current, agentId);
    const ttl = ttlChoice(current, agentId);
    const release = agentId === null ? async () => {} : await holdSubagentTtl(current, agentId);
    return { current, startedAt, key, identity, changed, release, ttl: ttl.ttl };
  }

  async function observe(current: Context, sample: CacheSample, transcriptPath?: string) {
    if (!validSample(sample)) return;
    if (!current.samples.has(sampleKey(sample))) current.samples.set(sampleKey(sample), sample);
    try {
      const result = await send(current, { action: 'cache-sample', sample, transcript_path: transcriptPath });
      if (context === current && validSample(result.sample)) current.samples.set(sampleKey(result.sample), result.sample);
    }
    catch { current.available = false; current.host.ui.log('Keepalive: cache observation could not be saved.', { to: 'debug' }); }
  }

  async function finish(ticket: Awaited<ReturnType<typeof begin>>, request: TurnStepInput, usage?: TurnUsage | null) {
    if (!ticket) return;
    await ticket.release();
    if (context !== ticket.current) return;
    const { current, startedAt, key, identity } = ticket;
    if (current.pending.get(key)?.request === identity) current.pending.delete(key);
    if (usage) {
      const model = usage.model || routedModel(current, request);
      let sample: CacheSample = { sessionId: current.sessionId, agentId: request.agentId ?? null, turnId: request.turnId,
        index: request.index, model, startedAt, read: usage.cache_read_input_tokens, write: usage.cache_creation_input_tokens,
        completedAt: await current.host.clock.now(), fresh: usage.input_tokens, output: usage.output_tokens,
        ...cachePolicy(current.env, model), requested: ticket.ttl };
      const reported = reportedCacheCreation(usage);
      if (reported) sample = applyCacheCreation(sample, reported);
      await observe(current, sample, transcript(current, sample.agentId));
    }
    current.now = await current.host.clock.now();
    if (usage || ticket.changed) redraw(current);
  }

  async function reset(current: Context, agentId: string | null, resetAt: number) {
    current.resets = current.resets.filter(r => r.sessionId !== current.sessionId || r.agentId !== agentId);
    current.resets.push({ sessionId: current.sessionId, agentId, resetAt });
    try { await send(current, { action: 'cache-reset', agent_id: agentId, reset_at: resetAt }); }
    catch { current.available = false; }
    redraw(current);
  }

  async function recheck(current: Context, final = false) {
    const loops = new Map<string, string | null>();
    for (const sample of current.samples.values()) {
      if (sample.sessionId !== current.sessionId || isKeepalive(sample) || isCompaction(sample) || sample.cacheCreation || !sample.write || sample.completedAt === undefined) continue;
      if (final) { loops.set(loopKey(sample.sessionId, sample.agentId), sample.agentId); continue; }
      const key = sampleKey(sample);
      const age = current.now - sample.completedAt;
      if (age > RECHECK_MS.at(-1)!) { current.rechecks.delete(key); continue; }
      const due = RECHECK_MS.filter(ms => age >= ms).length;
      if ((current.rechecks.get(key) ?? 0) >= due) continue;
      current.rechecks.set(key, due);
      loops.set(loopKey(sample.sessionId, sample.agentId), sample.agentId);
    }
    for (const agentId of loops.values()) await enrich(current.sessionId, agentId);
  }

  async function warm(current: Context, model: string) {
    const startedAt = await current.host.clock.now();
    const release = await holdSubagentTtl(current, null);
    let result;
    try { result = await current.host.model.fork({ prompt: KEEPALIVE_PROMPT }); }
    finally { await release(); }
    if (context !== current) return;
    if (!result.isAnswered) current.host.ui.log(`Keepalive: cache keepalive did not answer (${result.reason}).`, { to: 'debug' });
    if (!('usage' in result)) return;
    const { usage } = result;
    if (usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.input_tokens === 0) return;
    await observe(current, { sessionId: current.sessionId, agentId: null, turnId: `keepalive:${startedAt}`, index: 0, model, startedAt,
      completedAt: await current.host.clock.now(), read: usage.cache_read_input_tokens, write: usage.cache_creation_input_tokens,
      fresh: usage.input_tokens, output: usage.output_tokens, ...cachePolicy(current.env, model), requested: ttlChoice(current, null).ttl });
    current.now = await current.host.clock.now();
    redraw(current);
  }

  async function compacted(agentId: string | null, startedAt: number, result: SessionCompacted) {
    const current = context;
    if (!current) return;
    const key = loopKey(current.sessionId, agentId);
    const model = rows(current).find(row => loopKey(row.sessionId, row.agentId) === key)?.last?.model ?? 'unknown';
    const usage = result.usage;
    await reset(current, agentId, startedAt);
    await observe(current, { sessionId: current.sessionId, agentId, turnId: `compaction:${startedAt}`, index: 0, model, startedAt,
      completedAt: Math.max(startedAt, await current.host.clock.now()), read: usage?.cache_read_input_tokens ?? 0,
      write: usage?.cache_creation_input_tokens ?? 0, fresh: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0,
      ...cachePolicy(current.env, model), requested: ttlChoice(current, agentId).ttl,
      ...(result.tokensBefore !== undefined ? { tokensBefore: result.tokensBefore } : {}),
      ...(result.tokensAfter !== undefined ? { tokensAfter: result.tokensAfter } : {}) });
    redraw(current);
  }

  async function compact(current: Context) {
    try {
      const startedAt = await current.host.clock.now();
      const result = await holdTtlFor(null, () => current.host.session.compact());
      if (context !== current) return;
      if (!result.messages) { current.host.ui.log(`Keepalive: cache compaction skipped: ${result.skip}`, { to: 'debug' }); return; }
      current.host.ui.log('Keepalive compacted the conversation before its prompt cache expired.');
      await compacted(null, startedAt, result);
    } catch {
      current.host.ui.log('Keepalive: cache compaction could not run during a turn.', { to: 'debug' });
    }
  }

  async function holdTtlFor<T>(agentId: string | null, run: () => Promise<T>): Promise<T> {
    const current = context;
    if (!current) return run();
    const release = await holdSubagentTtl(current, agentId);
    try { return await run(); } finally { await release(); }
  }

  function lookUpPrices(current: Context, model: string) {
    const known = current.prices.get(model);
    if (known?.lookup || known && current.now - known.at < PRICES_MS) return known?.lookup;
    const lookup = (async () => {
      let value: CachePrices | null = null;
      let found = false;
      try {
        const result = await send(current, { action: 'cache-prices', models: [model] });
        const matched = result?.prices?.[model];
        value = validPrices(matched) ? matched : null;
        found = true;
      } catch {}
      if (found) current.prices.set(model, { at: current.now, value, settled: true });
      else if (known) current.prices.set(model, { ...known, lookup: undefined });
      else current.prices.delete(model);
      if (found && !value) current.host.ui.log(`Keepalive: no price found for ${displayText(model, 160)}; keepalives are off for it.`, { to: 'debug' });
      redraw(current);
    })();
    current.prices.set(model, { at: known?.at ?? current.now, value: known?.value ?? null, settled: known?.settled ?? false, lookup });
    return lookup;
  }

  async function upkeep(current: Context) {
    if (current.upkeep === 'off' || current.pending.has(loopKey(current.sessionId, null))) return;
    const row = mainRow(current);
    const sample = row?.last;
    if (!row || !sample || row.touchedAt === undefined || current.actedAt === row.touchedAt) return;
    const warms = current.upkeep === 'warm' || current.upkeep === 'warmcomp';
    if (warms && current.limit === undefined) await lookUpPrices(current, sample.model);
    const status = cacheStatus(row, current.now, undefined, unreportedModels(rows(current), current.now));
    if (!status.leftMs || status.leftMs > UPKEEP_MS) return;
    current.actedAt = row.touchedAt;
    if (warms && keepaliveWorthwhile(row, current.prices.get(sample.model)?.value, current.limit)) return warm(current, sample.model);
    if (current.upkeep !== 'warm' && sample.read + sample.write + sample.fresh >= COMPACT_MIN_TOKENS) return compact(current);
    if (warms) current.host.ui.log(current.limit !== undefined && row.keepalives.length >= current.limit
      ? `Keepalive: cache warming stopped at the keepalive limit of ${current.limit}.`
      : 'Keepalive: cache warming paused; another keepalive would cost more than rewriting the cache.', { to: 'debug' });
  }

  async function cycle() {
    const current = context;
    if (!current) return;
    current.upkeep = UPKEEP[(UPKEEP.indexOf(current.upkeep) + 1) % UPKEEP.length];
    current.actedAt = undefined;
    redraw(current);
    await saveUpkeep(current);
  }

  async function tick() {
    const current = context;
    if (!current) return;
    current.now = await current.host.clock.now();
    if (!current.rechecking) current.rechecking = recheck(current).finally(() => { current.rechecking = undefined; });
    await current.rechecking;
    if (!current.upkeeping) current.upkeeping = upkeep(current).catch(() => undefined).finally(() => { current.upkeeping = undefined; });
    const missed = misses(current, null);
    const display = current.upkeep + current.family + missed.total + (current.now - (missed.latest ?? current.now) > MISS_FRESH_MS) + rows(current).map(row => segments(current, row).map(part => `${part.color}${part.text}`).join('')).join('\n');
    if (display !== lastDisplay) { lastDisplay = display; redraw(current); }
  }

  async function show() {
    const current = await active();
    if (!current) return false;
    await refresh();
    const opened = await current.host.ui.open({ id: CACHE_PANE, title: 'Keepalive', focus: true, closeOnEscape: true, columns: 100, rows: 24 });
    if (!opened.isPlaced) { current.host.ui.log(`Agent cache pane: ${opened.reason}`); return false; }
    open = true;
    redraw(current);
    return true;
  }

  async function view(agentId?: string) {
    const current = context;
    if (current && agentId) await learnKind(current, agentId);
  }

  function renderBand(elements: Elements[RenderSurface], content: RenderElement, agentId?: string): RenderElement {
    const current = context;
    if (!current) return content;
    const row = rows(current).find(row => row.sessionId === current.sessionId && row.agentId === (agentId ?? null));
    const { Box, Button, Text } = elements;
    const status = row && state(current, row);
    const latest = status?.sample;
    const note = row && keepaliveNote(current, row, true);
    const counts = `${note ? ` · ${note}` : ''}${latest ? ` · read ${cacheTokens(latest.read)} · write ${cacheTokens(latest.write)} · new ${cacheTokens(latest.fresh)}` : ''}`;
    const upkeeps = !agentId;
    const ttl = ttlChoice(current, agentId ?? null);
    const parts = row ? segments(current, row) : [{ text: 'no observation' }];
    return Box({ flexDirection: 'column', children: [content, Box({ flexDirection: 'row', gap: 1, children: [
      Button({ key: 'agent-cache-open', label: cacheDial(status), onPress: show }),
      Box({ flexDirection: 'row', children: marker(elements, current, upkeeps ? current.upkeep : undefined) }),
      ...(upkeeps ? [Button({ key: 'agent-cache-upkeep', label: current.upkeep, plain: true, onPress: cycle })] : []),
      ttl.locked ? Text({ dimColor: true, children: [`TTL ${ttl.ttl}`] })
        : Button({ key: 'agent-cache-ttl', label: `TTL ${ttl.ttl}`, plain: true, onPress: () => cycleTtl(agentId ?? null) }),
      Box({ flexDirection: 'row', children: [...paint(elements, parts.slice(0, 3)), ...missChip(elements, current, agentId ?? null), ...paint(elements, parts.slice(3)),
        Text({ wrap: 'truncate-end', children: [`${counts}${current.available ? '' : ' · storage unavailable'}`] })] }),
    ] })] });
  }

  const MISS_WORDS: Record<string, string> = { 'prefix changed': 'prefix', 'model changed': 'model', 'TTL changed': 'TTL', expired: 'expired', 'cache miss': 'unknown' };

  function misses(current: Context, agentId: string | null) {
    const scope = rows(current).filter(row => row.sessionId === current.sessionId && (agentId === null || row.agentId === agentId));
    return recentMisses(scope, current.now);
  }

  function missChip(elements: Elements[RenderSurface], current: Context, agentId: string | null): RenderElement[] {
    const found = misses(current, agentId);
    if (!found.total) return [];
    const stale = current.now - found.latest! > MISS_FRESH_MS;
    const label = `${found.total} ${found.causes.slice(0, 2).map(([cause]) => MISS_WORDS[cause]).join('·')}${found.causes.length > 2 ? '…' : ''}`;
    return [elements.Text({ children: [' '] }), elements.Text(stale ? { dimColor: true, children: ['✕'] } : { color: palette(current).fair, children: ['✕'] }),
      elements.Text({ children: [' '] }), elements.Button({ key: 'agent-cache-misses', label, plain: true, ...(stale ? { dimColor: true } : {}),
        onPress: async () => { requestFilter = 'misses'; historyScope = agentId === null ? 'all' : 'agent'; selected = agentId === null ? undefined : loopKey(current.sessionId, agentId); await show(); } })];
  }

  function missLine(current: Context) {
    const found = misses(current, null);
    if (!found.total) return undefined;
    const causes = found.causes.map(([cause, count]) => `${count} ${cause}`).join(', ');
    return `✕ ${found.total} cache ${found.total === 1 ? 'miss' : 'misses'} in the last ${MISS_WINDOW_MS / 60000} min: ${causes} · latest ${cacheClock(current.now - found.latest!)} ago`;
  }

  function warmRule(limit: number | undefined) {
    if (limit === undefined) return 'while keepalives cost less than rewriting the cache';
    if (limit === Infinity) return 'until your next request, whatever they cost';
    return `up to ${plural(limit, 'keepalive')} after each request, whatever they cost`;
  }

  function upkeepText(current: Context) {
    const compacts = `compacts a main conversation of ${cacheTokens(COMPACT_MIN_TOKENS)}+ tokens 30s before its TTL ends`;
    const rule = warmRule(current.limit);
    return {
      off: 'off · no requests are sent for upkeep',
      warm: `warm · a keepalive request 30s before the main TTL ends, ${rule}`,
      compact: `compact · ${compacts.replace('a main', 'an idle main')}`,
      warmcomp: current.limit === Infinity ? `warmcomp · keepalives ${rule}, so it never compacts` : `warmcomp · keepalives ${rule}, then ${compacts}`,
    }[current.upkeep];
  }

  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

  function keepaliveNote(current: Context, row: CacheRow, short = false) {
    if (current.upkeep !== 'warm' && current.upkeep !== 'warmcomp') return undefined;
    if (row.sessionId !== current.sessionId || row.agentId !== null || !row.last) return undefined;
    if (current.pending.has(loopKey(current.sessionId, null))) return undefined;
    const status = state(current, row);
    const known = current.prices.get(row.last.model);
    if (!status.ttl || !status.leftMs || current.limit === undefined && !known?.settled) return undefined;
    const left = keepalivesLeft(row, known?.value, current.limit);
    if (left === null) return undefined;
    if (left === Infinity) return short ? '↻∞' : 'keepalives until your next request';
    const compacts = current.upkeep === 'warmcomp' && row.last.read + row.last.write + row.last.fresh >= COMPACT_MIN_TOKENS;
    if (short) return [left || !compacts ? `↻${left}` : '', compacts ? '➜ cmpt' : ''].filter(Boolean).join(' ');
    if (!compacts) return `${plural(left, 'keepalive')} left`;
    return left ? `${plural(left, 'keepalive')}, then compact` : 'compact next';
  }

  function ttlLabel(current: Context, row: CacheRow) {
    if (row.sessionId === current.sessionId) return ttlChoice(current, row.agentId).ttl;
    return row.last?.requested ?? '5m';
  }

  function priceNote(current: Context, row: CacheRow) {
    const known = row.last && current.prices.get(row.last.model);
    if (!known?.settled) return '';
    if (!known.value) return ' · no price found';
    const listing = known.value.provider && known.value.id ? ` (${displayText(known.value.provider === 'anthropic' ? known.value.id : `${known.value.provider}/${known.value.id}`, 120)})` : '';
    return ` · priced by ${displayText(known.value.source ?? 'models.dev', 40)}${listing}`;
  }

  const shown = (node: Node) => agentFilter === 'all' || agentFilter === 'main' && node.kind === 'main' ||
    agentFilter === 'subagents' && node.kind === 'subagent' || agentFilter === 'teammates' && node.kind.endsWith('teammate');
  const wanted = (sample: CacheSample) => requestFilter === 'all' ||
    requestFilter === 'keepalives' && isKeepalive(sample) || requestFilter === 'compactions' && isCompaction(sample) ||
    requestFilter === 'real' && !isKeepalive(sample) && !isCompaction(sample) || requestFilter === 'misses' && !!sample.miss;

  const HISTORY = ['agent', 'all'] as const;
  const HISTORY_LABELS: Record<typeof HISTORY[number], string> = { agent: 'this agent', all: 'all agents' };

  function chips<T extends string>(elements: Elements[RenderSurface], current: Context, group: string, values: readonly T[], value: T,
    choose: (next: T) => void, labels: Partial<Record<T, string>> = {}) {
    return values.map(option => {
      const label = labels[option] ?? option;
      const press = () => { choose(option); redraw(current); };
      return option === value
        ? elements.Button({ key: `${group}:${option}`, label, variant: 'primary', onPress: press })
        : elements.Button({ key: `${group}:${option}`, label, plain: true, dimColor: true, onPress: press });
    });
  }

  const MATRIX_ROWS = 4;

  function matrix(elements: Elements[RenderSurface], current: Context, all: CacheRow[], columns: number): RenderElement[] {
    const cells = sessionMatrix(all);
    const width = Math.max(20, Math.min(80, columns - 2));
    const shown = cells.slice(-width * MATRIX_ROWS);
    const lines: RenderElement[] = [];
    if (cells.length > shown.length) lines.push(elements.Text({ dimColor: true, children: [`… ${cells.length - shown.length} earlier`] }));
    for (let start = 0; start < shown.length; start += width) {
      const runs: { tone: string; text: string }[] = [];
      for (const cell of shown.slice(start, start + width)) {
        const last = runs.at(-1);
        if (last && last.tone === cell.tone) last.text += cell.glyph;
        else runs.push({ tone: cell.tone, text: cell.glyph });
      }
      lines.push(elements.Box({ flexDirection: 'row', children: runs.map(run => run.tone === 'quiet'
        ? elements.Text({ dimColor: true, children: [run.text] })
        : elements.Text({ color: palette(current)[run.tone as keyof Palette], children: [run.text] })) }));
    }
    return lines;
  }

  function overview(elements: Elements[RenderSurface], current: Context, all: CacheRow[], columns: number): RenderElement {
    const { Box, Text } = elements;
    const usage = sessionUsage(all);
    if (!usage) return Box({ flexDirection: 'column', children: [Text({ bold: true, children: ['Prompt cache · all agents'] }),
      Text({ dimColor: true, children: ['No requests yet. Each request this session gets a dot here.'] })] });
    return Box({ flexDirection: 'column', children: [
      Text({ bold: true, children: ['Prompt cache · all agents'] }),
      Box({ flexDirection: 'row', children: [Text({ children: ['Now      '] }), ...paint(elements, rate(current, usage.recent)),
        Text({ dimColor: true, children: [` over the last ${plural(usage.recent.requests, 'request')}`] })] }),
      Box({ flexDirection: 'row', children: [Text({ children: ['Session  '] }), ...paint(elements, rate(current, usage.session)),
        Text({ dimColor: true, children: [` over ${plural(usage.session.requests, 'request')} · read ${cacheTokens(usage.session.read)} · write ${cacheTokens(usage.session.write)} · new ${cacheTokens(usage.session.fresh)}`] })] }),
      ...matrix(elements, current, all, columns),
      Text({ dimColor: true, children: ['One dot per request, oldest first: ● good ◐ fair ○ poor ✕ miss · keepalive ◆ compaction'] }),
    ] });
  }

  function filters(elements: Elements[RenderSurface], current: Context): RenderElement {
    const { Box, Text } = elements;
    const line = (label: string, controls: RenderElement[]) => Box({ flexDirection: 'row', gap: 1, children: [Text({ dimColor: true, children: [label.padEnd(8)] }), ...controls] });
    return Box({ flexDirection: 'column', children: [
      Text({ bold: true, children: ['Show'] }),
      line('Agents', chips(elements, current, 'cache-agents', AGENT_FILTERS, agentFilter, next => { agentFilter = next; })),
      line('Requests', chips(elements, current, 'cache-requests', REQUEST_FILTERS, requestFilter, next => { requestFilter = next; })),
      line('From', chips(elements, current, 'cache-history', HISTORY, historyScope, next => { historyScope = next; }, HISTORY_LABELS)),
    ] });
  }

  const COUNT_WIDTH = 7;
  type Widths = { owner: number; name: number; ttl: number; miss: number };
  const requestName = (sample: CacheSample) => isKeepalive(sample) ? 'keepalive' : isCompaction(sample) ? 'compaction' : `${displayText(sample.turnId, 12)}:${sample.index}`;

  function requestLine(elements: Elements[RenderSurface], current: Context, sample: CacheSample, owner: string | undefined, widths: Widths): RenderElement {
    const { Box, Text } = elements;
    const counts = [sample.read, sample.write, sample.fresh, sample.output].map(value => cacheTokens(value).padStart(COUNT_WIDTH)).join('');
    return Box({ flexDirection: 'row', children: [
      Text({ children: [`${owner === undefined ? '' : owner.padEnd(widths.owner)}${requestName(sample).padEnd(widths.name)}`] }),
      ...paint(elements, rate(current, sample, 6, true)),
      Text({ wrap: 'truncate-end', children: [`  ${(sampleTtl(sample) ?? '–').padEnd(widths.ttl)}${(sample.miss ?? '').padEnd(widths.miss)}${counts}  ${displayText(sample.model, 160)}`] }),
    ] });
  }

  function requests(elements: Elements[RenderSurface], current: Context, scope: CacheRow[], title: string): RenderElement {
    const { Box, Text } = elements;
    const all = historyScope === 'all';
    const labels = new Map(scope.map(row => [loopKey(row.sessionId, row.agentId), displayText(row.label, 40)]));
    const samples = scope.flatMap(row => row.samples).filter(wanted).sort((a, b) => b.startedAt - a.startedAt || b.index - a.index).slice(0, 30);
    const lines: RenderElement[] = [Text({ bold: true, children: [`Recent requests · ${title} (last 30${requestFilter === 'all' ? '' : ` ${requestFilter}`})`] })];
    if (!samples.length) return Box({ flexDirection: 'column', children: [...lines, Text({ dimColor: true, children: ['No requests match these filters.'] })] });
    const owners = samples.map(sample => labels.get(loopKey(sample.sessionId, sample.agentId))!);
    const widest = (values: string[], least: number) => Math.max(least, ...values.map(value => value.length)) + 2;
    const widths: Widths = { owner: all ? widest(owners, 5) : 0, name: widest(samples.map(requestName), 7),
      ttl: widest(samples.map(sample => sampleTtl(sample) ?? '–'), 3), miss: widest(samples.map(sample => sample.miss ?? ''), 4) };
    lines.push(Text({ dimColor: true, children: [`${all ? 'agent'.padEnd(widths.owner) : ''}${'request'.padEnd(widths.name)}${'hit'.padEnd(11)}  ${'TTL'.padEnd(widths.ttl)}${'miss'.padEnd(widths.miss)}${['read', 'write', 'new', 'out'].map(head => head.padStart(COUNT_WIDTH)).join('')}  model`] }));
    samples.forEach((sample, index) => {
      if (index) lines.push(Text({ dimColor: true, children: [`${' '.repeat(widths.owner)}↕ ${cacheGap(samples[index - 1].startedAt - sample.startedAt)}`] }));
      lines.push(requestLine(elements, current, sample, all ? owners[index] : undefined, widths));
    });
    return Box({ flexDirection: 'column', children: lines });
  }

  function coldNote(elements: Elements[RenderSurface], nodes: Node[]): RenderElement[] {
    const kinds = (['subagent', 'in-process teammate'] as const).filter(kind => nodes.some(node => node.kind === kind && !node.upkeep));
    if (!kinds.length) return [];
    return [elements.Text({ dimColor: true, children: [`– can't be kept warm: Claude Code has no keepalive or compaction for ${kinds.map(kind => `${kind}s`).join(' and ')}.`] })];
  }

  function renderPane(elements: Elements[RenderSurface], agentId: string | undefined, columns: number): RenderElement | undefined {
    const current = context;
    if (!current || !open) return undefined;
    const { Box, Button, Text } = elements;
    const nodes = tree(current);
    const chosen = nodes.find(node => loopKey(node.row.sessionId, node.row.agentId) === (selected ?? loopKey(current.sessionId, agentId)))?.row;
    const notes: RenderElement[] = [
      ...(missLine(current) ? [Text({ color: palette(current).fair, children: [missLine(current)!] })] : []),
      ...(current.available ? [] : [Text({ color: palette(current).fair, children: ['Storage unavailable · showing last known observations'] })]),
      Text({ dimColor: true, children: [`Upkeep: ${upkeepText(current)}`] }),
      ...coldNote(elements, nodes.filter(shown)),
      Text({ dimColor: true, children: [`Bars show each loop's hit rate over its last ${RATE_REQUESTS} requests, coloured for its context size. Time left counts from the last request that read or wrote the cache. Select an agent for recent requests.`] }),
    ];
    const agents = nodes.filter(shown).map(node => {
      const { row } = node;
      const key = loopKey(row.sessionId, row.agentId);
      const counts = row.totals;
      const indent = node.body;
      const status = state(current, row);
      const life: RenderElement[] = status.lifetimes.map(part => Text({
        color: palette(current)[lifeGrade(part.leftMs)!],
        children: [`${indent}TTL ${part.ttl} · ${cacheTokens(part.tokens)} written · ${cacheBar(part.leftMs / part.ttlMs)} ~${cacheClock(part.leftMs)} left${status.awaiting ? ' · awaiting report' : ''}`],
      }));
      const window = recentUsage(row)?.requests;
      const upkeepLine = [row.keepalives.length ? `${plural(row.keepalives.length, 'keepalive')} since the last request` : '', keepaliveNote(current, row) ?? '']
        .filter(Boolean).join(' · ');
      const keepalives = upkeepLine ? [Text({ dimColor: true, children: [`${indent}${upkeepLine}`] })] : [];
      const kind = node.kind === 'main' || node.kind === 'subagent' ? '' : ` · ${node.kind}`;
      return Box({ flexDirection: 'column', children: [
        Box({ flexDirection: 'row', children: [Text({ dimColor: true, children: [node.prefix] }),
          Button({ key: `cache-agent:${key}`, label: `${displayText(row.label, 120)}${kind}`, plain: true, onPress: () => { selected = key; historyScope = 'agent'; redraw(current); } })] }),
        Box({ flexDirection: 'row', children: [Text({ children: [`${indent}${cacheDial(state(current, row))} `] }), ...marker(elements, current, node.upkeep),
          Text({ children: [node.upkeep ? ` ${node.upkeep} ` : ' '] }), Text({ children: [`TTL ${ttlLabel(current, row)} `] }), ...paint(elements, segments(current, row))] }),
        ...(row.sessionId === current.sessionId ? [Text({ dimColor: true, children: [`${indent}TTL ${ttlChoice(current, row.agentId).ttl} · ${ttlChoice(current, row.agentId).reason}`] })] : []),
        ...life,
        ...keepalives,
        Text({ dimColor: true, children: [`${indent}${window ? `hit rate over the last ${plural(window, 'request')} · ` : ''}${plural(counts.requests, 'request')} · read ${cacheTokens(counts.read)} · write ${cacheTokens(counts.write)} · new ${cacheTokens(counts.fresh)} · out ${cacheTokens(counts.output)}`] }),
        Text({ dimColor: true, children: [`${indent}${row.last ? `${displayText(row.last.model, 160)} · ${displayText(row.last.ttlSource, 120)}${node.kind === 'main' ? priceNote(current, row) : ''}` : 'No usage observed in this context'}`] }),
      ] });
    });
    const scope = historyScope === 'all' ? nodes.filter(shown).map(node => node.row) : chosen ? [chosen] : [];
    return Box({ flexDirection: 'column', gap: 1, children: [
      overview(elements, current, nodes.map(node => node.row), columns),
      Box({ flexDirection: 'column', children: notes }),
      filters(elements, current),
      ...agents,
      ...(scope.length ? [requests(elements, current, scope, historyScope === 'all' ? 'all agents' : displayText(chosen!.label, 120))] : []),
      Button({ key: 'agent-cache-close', label: 'Close', onPress: () => current.host.ui.close({ id: CACHE_PANE }) }),
    ] });
  }

  async function settle() {
    const current = context;
    if (current) await recheck(current, true);
  }

  return { initialize, begin, finish, compacted, refresh, tick, show, settle, renderBand, renderPane, setTranscript, enrich, holdTtlFor, view,
    introduce: () => context ? introduce(context.host) : Promise.resolve(), close: () => { open = false; },
    clear: () => { previous = context ?? previous; context = undefined; open = false; selected = undefined; } };
}
