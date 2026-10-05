import type { AgentInfo, Elements, EngineInterface, RenderElement, RenderSurface, SessionCompactResult, TurnStepInput, TurnUsage } from 'claude-code';
import { applyCacheCreation, reportedCacheCreation, cacheBar, cacheBarParts, cacheClock, cacheDial, cacheGrade, cachePercent, cachePolicy, cacheRows, cacheStatus, cacheTokens, isCompaction, isKeepalive, keepaliveWorthwhile, lifeGrade, loopKey, sampleKey, validSample } from '../lib/cache.js';
import { validPrices } from '../lib/cache.js';
import type { CachePrices, CacheRow, CacheSample, CacheReset, CacheStatus } from '../lib/cache.js';
import { CACHE_COLORS, themeFamily } from '../lib/cache-colors.js';
import { displayText } from '../lib/catalog.js';
import { sameModel } from '../lib/routing.js';

export const CACHE_PANE = 'agent-cache';
const RECHECK_MS = [1000, 3000, 10000, 30000];
const UPKEEP_MS = 30000;
const COMPACT_MIN_TOKENS = 100000;
const UPKEEP = ['off', 'warm', 'compact', 'warmcomp'] as const;
const UPKEEP_KEY = 'cache-upkeep';
const KEEPALIVE_PROMPT = 'Reply with only: OK';
const PRICES_MS = 3600000;
type Upkeep = typeof UPKEEP[number];
type Family = keyof typeof CACHE_COLORS;
type Palette = typeof CACHE_COLORS[Family];
const MARKERS: Record<Upkeep, (keyof Palette)[]> = { off: [], warm: ['warm'], compact: ['compact'], warmcomp: ['warm', 'compact'] };
type Segment = { text: string; color?: string; dim?: boolean };
type Bridge = (request: Record<string, unknown>) => Promise<any>;
export type CachePanelHost = {
  session: Pick<EngineInterface['session'], 'id' | 'compact'>;
  config: Pick<EngineInterface['config'], 'list'>;
  agent: Pick<EngineInterface['agent'], 'list'>;
  clock: Pick<EngineInterface['clock'], 'now'>;
  model: Pick<EngineInterface['model'], 'fork'>;
  store: Pick<EngineInterface['store'], 'get' | 'set'>;
  ui: Pick<EngineInterface['ui'], 'invalidate' | 'open' | 'close' | 'log'>;
  command: Pick<EngineInterface['command'], 'register'>;
};
type Context = {
  host: CachePanelHost;
  bridge: Bridge;
  sessionId: string;
  endpoint?: string;
  selfLabel?: string;
  env: Record<string, string | undefined>;
  upkeep: Upkeep;
  family: Family;
  samples: Map<string, CacheSample>;
  resets: CacheReset[];
  labels: Map<string, string>;
  roster: AgentInfo[];
  now: number;
  pending: Map<string, { request: string; changed: boolean; startedAt: number }>;
  requested: Map<string, string>;
  rechecks: Map<string, number>;
  rechecking?: Promise<void>;
  prices: Map<string, { at: number; value: CachePrices | null; lookup?: Promise<void> }>;
  actedAt?: number;
  upkeeping?: Promise<void>;
  refresh?: Promise<void>;
  available: boolean;
};

export function createCachePanel() {
  let context: Context | undefined;
  let open = false;
  let selected: string | undefined;
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
    for (const agentId of [null, ...current.roster.map(agent => agent.id)]) {
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

  function state(current: Context, row: CacheRow): CacheStatus {
    const pending = current.pending.get(loopKey(row.sessionId, row.agentId));
    const value = cacheStatus(row, current.now, pending?.startedAt);
    if (pending?.changed && row.last) {
      return { ...value, state: 'model changed · awaiting usage', leftMs: null, lifetimes: [], ttl: undefined };
    }
    return value;
  }

  const palette = (current: Context) => CACHE_COLORS[current.family];

  function rate(current: Context, sample: CacheSample | undefined, width = 10): Segment[] {
    const total = sample ? sample.read + sample.write + sample.fresh : 0;
    const percent = cachePercent(sample);
    const grade = cacheGrade(sample);
    const color = grade ? palette(current)[grade] : undefined;
    const { fill, empty } = cacheBarParts(total ? sample!.read / total : null, width, grade);
    return [{ text: fill, color }, { text: empty, dim: true }, { text: ` ${percent === null ? 'n/a' : `${percent}%`}`, color }];
  }

  function segments(current: Context, row: CacheRow): Segment[] {
    const status = state(current, row);
    const result = rate(current, status.sample);
    if (status.sample?.miss) result.push({ text: ` · ${status.sample.miss}` });
    if (status.state === 'compacted') {
      const { before, after } = status.compacted ?? {};
      return [...result, { text: ` · cmpt ✓${before !== undefined && after !== undefined ? ` ${cacheTokens(before)} → ${cacheTokens(after)}` : ''}` }];
    }
    if (!status.ttl) return [...result, { text: ` · ${status.state}` }];
    result.push({ text: ` · TTL ${status.ttl}` });
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
        if (!Array.isArray(snapshot.samples) || !Array.isArray(snapshot.resets) || !Array.isArray(snapshot.labels)) throw new Error('Invalid cache snapshot');
        for (const sample of snapshot.samples) if (validSample(sample)) current.samples.set(sampleKey(sample), sample);
        current.resets = snapshot.resets;
        current.labels = new Map(snapshot.labels);
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
    } catch { current.host.ui.log('Agent Router: cache upkeep choice could not be saved.', { to: 'debug' }); }
  }

  async function initialize(host: CachePanelHost, bridge: Bridge, sessionId: string, endpoint?: string, selfLabel?: string,
    configuration: { env: Record<string, string | undefined>; upkeep?: Upkeep } = { env: {} }) {
    const saved = (await savedUpkeep(host)).find(([id]) => id === sessionId)?.[1];
    const current: Context = { host, bridge, sessionId, endpoint, selfLabel, env: configuration.env, upkeep: saved ?? configuration.upkeep ?? 'off',
      family: themeFamily(undefined, configuration.env.COLORFGBG),
      samples: new Map(), resets: [], labels: new Map(), roster: [], now: 0, pending: new Map(), requested: new Map(), rechecks: new Map(), prices: new Map(), available: true };
    context = current;
    selected = undefined;
    open = false;
    lastDisplay = '';
    if (!saved && current.upkeep !== 'off') await saveUpkeep(current);
    await refresh();
    if (context !== current) return;
    await host.command.register({ name: CACHE_PANE, immediate: true, description: 'Cache bars, token counts and request history for the main agent and subagents.' });
  }

  async function active(): Promise<Context | undefined> {
    const prior = context ?? previous;
    if (prior) {
      const id = await prior.host.session.id();
      if (!context || id !== prior.sessionId) await initialize(prior.host, prior.bridge, id, prior.endpoint, undefined, { env: prior.env, upkeep: prior.upkeep });
    }
    return context;
  }

  async function begin(request: TurnStepInput) {
    const current = await active();
    if (!current) return undefined;
    const startedAt = await current.host.clock.now();
    const key = loopKey(current.sessionId, request.agentId);
    const identity = JSON.stringify([request.turnId, request.index]);
    const lastRequested = current.requested.get(key);
    const priorModel = rows(current).find(row => loopKey(row.sessionId, row.agentId) === key)?.last?.model;
    const changed = lastRequested !== undefined ? lastRequested !== request.model
      : priorModel !== undefined && !sameModel(priorModel, request.model);
    current.requested.set(key, request.model);
    current.pending.set(key, { request: identity, changed, startedAt });
    if (changed) redraw(current);
    return { current, startedAt, key, identity, changed };
  }

  async function observe(current: Context, sample: CacheSample, transcriptPath?: string) {
    if (!validSample(sample)) return;
    if (!current.samples.has(sampleKey(sample))) current.samples.set(sampleKey(sample), sample);
    try {
      const result = await send(current, { action: 'cache-sample', sample, transcript_path: transcriptPath });
      if (context === current && validSample(result.sample)) current.samples.set(sampleKey(result.sample), result.sample);
    }
    catch { current.available = false; current.host.ui.log('Agent Router: cache observation could not be saved.', { to: 'debug' }); }
  }

  async function finish(ticket: Awaited<ReturnType<typeof begin>>, request: TurnStepInput, usage?: TurnUsage | null) {
    if (!ticket || context !== ticket.current) return;
    const { current, startedAt, key, identity } = ticket;
    if (current.pending.get(key)?.request === identity) current.pending.delete(key);
    if (usage) {
      const model = usage.model || request.model;
      let sample: CacheSample = { sessionId: current.sessionId, agentId: request.agentId ?? null, turnId: request.turnId,
        index: request.index, model, startedAt, read: usage.cache_read_input_tokens, write: usage.cache_creation_input_tokens,
        completedAt: await current.host.clock.now(), fresh: usage.input_tokens, output: usage.output_tokens,
        ...cachePolicy(current.env, model) };
      const reported = reportedCacheCreation(usage);
      if (reported) sample = applyCacheCreation(sample, reported);
      await observe(current, sample, transcript(current, sample.agentId));
    }
    current.now = await current.host.clock.now();
    if (usage || ticket.changed) redraw(current);
  }

  async function reset(agentId: string | null = null, at?: number) {
    const current = context;
    if (!current) return;
    const resetAt = at ?? await current.host.clock.now();
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
    const result = await current.host.model.fork({ prompt: KEEPALIVE_PROMPT });
    if (context !== current) return;
    if (!result.isAnswered) current.host.ui.log(`Agent Router: cache keepalive did not answer (${result.reason}).`, { to: 'debug' });
    if (!('usage' in result)) return;
    const { usage } = result;
    if (usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.input_tokens === 0) return;
    await observe(current, { sessionId: current.sessionId, agentId: null, turnId: `keepalive:${startedAt}`, index: 0, model, startedAt,
      completedAt: await current.host.clock.now(), read: usage.cache_read_input_tokens, write: usage.cache_creation_input_tokens,
      fresh: usage.input_tokens, output: usage.output_tokens, ...cachePolicy(current.env, model) });
    current.now = await current.host.clock.now();
    redraw(current);
  }

  async function compacted(agentId: string | null, startedAt: number, result: SessionCompactResult) {
    const current = context;
    if (!current || !result.messages) return;
    const key = loopKey(current.sessionId, agentId);
    const model = rows(current).find(row => loopKey(row.sessionId, row.agentId) === key)?.last?.model ?? 'unknown';
    const usage = result.usage;
    await reset(agentId, startedAt);
    await observe(current, { sessionId: current.sessionId, agentId, turnId: `compaction:${startedAt}`, index: 0, model, startedAt,
      completedAt: Math.max(startedAt, await current.host.clock.now()), read: usage?.cache_read_input_tokens ?? 0,
      write: usage?.cache_creation_input_tokens ?? 0, fresh: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0,
      ...cachePolicy(current.env, model),
      ...(result.tokensBefore !== undefined ? { tokensBefore: result.tokensBefore } : {}),
      ...(result.tokensAfter !== undefined ? { tokensAfter: result.tokensAfter } : {}) });
    redraw(current);
  }

  async function compact(current: Context) {
    try {
      const startedAt = await current.host.clock.now();
      const result = await current.host.session.compact();
      if (context !== current) return;
      if (!result.messages) { current.host.ui.log(`Agent Router: cache compaction skipped: ${result.skip}`, { to: 'debug' }); return; }
      current.host.ui.log('Agent Router compacted the conversation before its prompt cache expired.');
      await compacted(null, startedAt, result);
    } catch {
      current.host.ui.log('Agent Router: cache compaction could not run during a turn.', { to: 'debug' });
    }
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
      if (found) current.prices.set(model, { at: current.now, value });
      else if (known) current.prices.set(model, { ...known, lookup: undefined });
      else current.prices.delete(model);
      if (found && !value) current.host.ui.log(`Agent Router: no models.dev price for ${displayText(model, 160)}; keepalives are off for it.`, { to: 'debug' });
      redraw(current);
    })();
    current.prices.set(model, { at: known?.at ?? current.now, value: known?.value ?? null, lookup });
    return lookup;
  }

  async function upkeep(current: Context) {
    if (current.upkeep === 'off' || current.pending.has(loopKey(current.sessionId, null))) return;
    const row = mainRow(current);
    const sample = row?.last;
    if (!row || !sample || row.touchedAt === undefined || current.actedAt === row.touchedAt) return;
    const warms = current.upkeep === 'warm' || current.upkeep === 'warmcomp';
    if (warms) await lookUpPrices(current, sample.model);
    const status = cacheStatus(row, current.now);
    if (!status.leftMs || status.leftMs > UPKEEP_MS) return;
    current.actedAt = row.touchedAt;
    if (warms && keepaliveWorthwhile(row, current.prices.get(sample.model)?.value)) return warm(current, sample.model);
    if (current.upkeep !== 'warm' && sample.read + sample.write + sample.fresh >= COMPACT_MIN_TOKENS) return compact(current);
    if (warms) current.host.ui.log('Agent Router: cache warming paused; another keepalive would cost more than rewriting the cache.', { to: 'debug' });
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
    const display = current.upkeep + current.family + rows(current).map(row => segments(current, row).map(part => `${part.color}${part.text}`).join('')).join('\n');
    if (display !== lastDisplay) { lastDisplay = display; redraw(current); }
  }

  async function show() {
    const current = await active();
    if (!current) return false;
    await refresh();
    const opened = await current.host.ui.open({ id: CACHE_PANE, title: 'Agent cache', focus: true, closeOnEscape: true, columns: 100, rows: 24 });
    if (!opened.isPlaced) { current.host.ui.log(`Agent cache pane: ${opened.reason}`); return false; }
    open = true;
    redraw(current);
    return true;
  }

  function renderBand(elements: Elements[RenderSurface], content: RenderElement, agentId?: string): RenderElement {
    const current = context;
    if (!current) return content;
    const row = rows(current).find(row => row.sessionId === current.sessionId && row.agentId === (agentId ?? null));
    const { Box, Button, Text } = elements;
    const status = row && state(current, row);
    const latest = status?.sample;
    const counts = latest ? ` · read ${cacheTokens(latest.read)} · write ${cacheTokens(latest.write)} · new ${cacheTokens(latest.fresh)}` : '';
    const marks = MARKERS[current.upkeep];
    const marker = marks.length ? marks.map(name => Text({ color: palette(current)[name], children: ['⬥'] })) : [Text({ dimColor: true, children: ['⬦'] })];
    return Box({ flexDirection: 'column', children: [content, Box({ flexDirection: 'row', gap: 1, children: [
      Button({ key: 'agent-cache-open', label: cacheDial(status), onPress: show }),
      Box({ flexDirection: 'row', children: marker }),
      Button({ key: 'agent-cache-upkeep', label: current.upkeep, plain: true, onPress: cycle }),
      Box({ flexDirection: 'row', children: [...paint(elements, row ? segments(current, row) : [{ text: 'no observation' }]),
        Text({ wrap: 'truncate-end', children: [`${counts}${current.available ? '' : ' · storage unavailable'}`] })] }),
    ] })] });
  }

  const UPKEEP_TEXT: Record<Upkeep, string> = {
    off: 'off · no requests are sent for upkeep',
    warm: 'warm · a keepalive request 30s before the main TTL ends, while keepalives cost less than rewriting the cache',
    compact: `compact · compacts an idle main conversation of ${cacheTokens(COMPACT_MIN_TOKENS)}+ tokens 30s before its TTL ends`,
    warmcomp: `warmcomp · keepalives while they cost less than rewriting the cache, then compacts a main conversation of ${cacheTokens(COMPACT_MIN_TOKENS)}+ tokens 30s before its TTL ends`,
  };

  function priceNote(current: Context, row: CacheRow) {
    const known = row.last && current.prices.get(row.last.model);
    if (!known || known.lookup && !known.at) return '';
    return known.value ? ` · prices from models.dev ${displayText(`${known.value.provider}/${known.value.id}`, 120)}` : ' · no models.dev price';
  }

  function renderPane(elements: Elements[RenderSurface], agentId?: string): RenderElement | undefined {
    const current = context;
    if (!current || !open) return undefined;
    const { Box, Button, Text } = elements;
    const all = rows(current);
    const chosen = all.find(row => loopKey(row.sessionId, row.agentId) === (selected ?? loopKey(current.sessionId, agentId)));
    const children: RenderElement[] = [Text({ bold: true, children: ['Prompt cache · all agents'] }),
      Text({ dimColor: true, children: ['Bars show each loop\'s last request hit rate, coloured for its context size. Time left counts from the last request that read or wrote the cache. Select an agent for recent requests.'] }),
      Text({ dimColor: true, children: [`Upkeep: ${UPKEEP_TEXT[current.upkeep]}`] })];
    if (!current.available) children.push(Text({ color: palette(current).fair, children: ['Storage unavailable · showing last known observations'] }));
    for (const row of all) {
      const key = loopKey(row.sessionId, row.agentId);
      const counts = row.totals;
      const life: RenderElement[] = state(current, row).lifetimes.map(part => Text({
        color: palette(current)[lifeGrade(part.leftMs)!],
        children: [`TTL ${part.ttl} · ${cacheTokens(part.tokens)} written · ${cacheBar(part.leftMs / part.ttlMs)} ~${cacheClock(part.leftMs)} left`],
      }));
      const keepalives = row.keepalives.length ? [Text({ dimColor: true, children: [`${row.keepalives.length} keepalives since the last request`] })] : [];
      children.push(Box({ flexDirection: 'column', children: [
        Button({ key: `cache-agent:${key}`, label: displayText(row.label, 120), onPress: () => { selected = key; redraw(current); } }),
        Box({ flexDirection: 'row', children: paint(elements, [{ text: `${cacheDial(state(current, row))} ` }, ...segments(current, row)]) }),
        ...life,
        ...keepalives,
        Text({ dimColor: true, children: [`${counts.requests} requests · read ${cacheTokens(counts.read)} · write ${cacheTokens(counts.write)} · new ${cacheTokens(counts.fresh)} · out ${cacheTokens(counts.output)}`] }),
        Text({ dimColor: true, children: [row.last ? `${displayText(row.last.model, 160)} · ${displayText(row.last.ttlSource, 120)}${priceNote(current, row)}` : 'No usage observed in this context'] }),
      ] }));
    }
    if (chosen) {
      children.push(Text({ bold: true, children: [`Recent requests · ${displayText(chosen.label, 120)} (last 30)`] }));
      for (const sample of [...chosen.samples].reverse()) {
        const name = isKeepalive(sample) ? 'keepalive' : isCompaction(sample) ? 'compaction' : `${displayText(sample.turnId, 12)}:${sample.index}`;
        children.push(Box({ flexDirection: 'row', children: [
          Text({ children: [`${name} `] }),
          ...paint(elements, rate(current, sample, 6)),
          Text({ wrap: 'truncate-end', children: [`${sample.miss ? ` · ${sample.miss}` : ''} · read ${cacheTokens(sample.read)} · write ${cacheTokens(sample.write)} · new ${cacheTokens(sample.fresh)} · out ${cacheTokens(sample.output)} · ${displayText(sample.model, 160)}`] }),
        ] }));
      }
    }
    children.push(Button({ key: 'agent-cache-close', label: 'Close', onPress: () => current.host.ui.close({ id: CACHE_PANE }) }));
    return Box({ flexDirection: 'column', gap: 1, children });
  }

  async function settle() {
    const current = context;
    if (current) await recheck(current, true).catch(() => undefined);
  }

  return { initialize, begin, finish, reset, compacted, refresh, tick, show, settle, renderBand, renderPane, setTranscript, enrich, close: () => { open = false; },
    clear: () => { previous = context ?? previous; context = undefined; open = false; selected = undefined; } };
}
