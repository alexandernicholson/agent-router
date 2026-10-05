import type { AgentInfo, Elements, EngineInterface, RenderElement, RenderSurface, TurnStepInput, TurnUsage } from 'claude-code';
import { applyCacheCreation, reportedCacheCreation, reportedLifetimes, cacheBar, cacheClock, cachePolicy, cacheRows, cacheStatus, cacheTokens, loopKey, sampleKey, validSample } from '../lib/cache.js';
import type { CacheRow, CacheSample, CacheReset } from '../lib/cache.js';
import { displayText } from '../lib/catalog.js';
import { sameModel } from '../lib/routing.js';

export const CACHE_PANE = 'agent-cache';
// Claude can flush a response to its transcript after Stop has run. Recheck an
// unenriched response this long after it completed, then leave its TTL unknown.
const RECHECK_MS = [1000, 3000, 10000, 30000];
type Bridge = (request: Record<string, unknown>) => Promise<any>;
export type CachePanelHost = {
  session: Pick<EngineInterface['session'], 'id'>;
  agent: Pick<EngineInterface['agent'], 'list'>;
  clock: Pick<EngineInterface['clock'], 'now'>;
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
  samples: Map<string, CacheSample>;
  resets: CacheReset[];
  labels: Map<string, string>;
  roster: AgentInfo[];
  now: number;
  pending: Map<string, { request: string; changed: boolean }>;
  requested: Map<string, string>;
  rechecks: Map<string, number>;
  rechecking?: Promise<void>;
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
    } catch { /* Missing or delayed transcript metadata leaves the estimate intact. */ }
  }

  const send = (current: Context, request: Record<string, unknown>) => current.bridge({ ...request, session_id: current.sessionId });

  function redraw(current: Context) {
    if (context !== current) return;
    try { current.host.ui.invalidate('ui.render'); } catch { /* Closed surface. */ }
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
          samples: [], totals: { requests: 0, read: 0, write: 0, fresh: 0, output: 0 } });
      }
    }
    return result.sort((a, b) => {
      const mainA = a.sessionId === current.sessionId && a.agentId === null;
      const mainB = b.sessionId === current.sessionId && b.agentId === null;
      return Number(mainB) - Number(mainA) || a.label.localeCompare(b.label) || loopKey(a.sessionId, a.agentId).localeCompare(loopKey(b.sessionId, b.agentId));
    });
  }

  function state(current: Context, row: CacheRow) {
    const value = cacheStatus(row.last, current.now);
    const pending = current.pending.get(loopKey(row.sessionId, row.agentId));
    if (pending?.changed && row.last) {
      return { ...value, state: 'model changed · awaiting usage', leftMs: null };
    }
    return value;
  }

  function meter(current: Context, row: CacheRow): string {
    const { ratio, leftMs, state: status } = state(current, row);
    const hit = ratio === null ? 'n/a' : `${Math.round(ratio * 100)}%`;
    const life = leftMs === null ? status : `${status} ~${cacheClock(leftMs)}`;
    return `${cacheBar(ratio)} ${hit} hit · ${life}`;
  }

  async function refresh(): Promise<void> {
    const current = context;
    if (!current) return;
    if (current.refresh) return current.refresh;
    current.refresh = (async () => {
      try {
        const [snapshot, roster, now] = await Promise.all([
          send(current, { action: 'cache-snapshot' }), current.host.agent.list(), current.host.clock.now(),
        ]);
        if (context !== current) return;
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

  async function initialize(host: CachePanelHost, bridge: Bridge, sessionId: string, endpoint?: string, selfLabel?: string,
    configuration: { env: Record<string, string | undefined> } = { env: {} }) {
    const current: Context = { host, bridge, sessionId, endpoint, selfLabel, ...configuration,
      samples: new Map(), resets: [], labels: new Map(), roster: [], now: 0, pending: new Map(), requested: new Map(), rechecks: new Map(), available: true };
    context = current;
    selected = undefined;
    open = false;
    lastDisplay = '';
    await refresh();
    if (context !== current) return;
    await host.command.register({ name: CACHE_PANE, immediate: true, description: 'Cache bars, token counts and request history for the main agent and subagents.' });
  }

  async function begin(request: TurnStepInput) {
    const prior = context ?? previous;
    if (prior) {
      const id = await prior.host.session.id();
      if (!context || id !== prior.sessionId) await initialize(prior.host, prior.bridge, id, prior.endpoint, undefined, { env: prior.env });
    }
    const current = context;
    if (!current) return undefined;
    const startedAt = await current.host.clock.now();
    const key = loopKey(current.sessionId, request.agentId);
    const identity = JSON.stringify([request.turnId, request.index]);
    // Response labels need not echo the requested ID: Claude drops the [1m]
    // suffix and a gateway may answer under an upstream name. Compare requests
    // with requests; a response label is the only evidence before the first.
    const lastRequested = current.requested.get(key);
    const priorModel = rows(current).find(row => loopKey(row.sessionId, row.agentId) === key)?.last?.model;
    const changed = lastRequested !== undefined ? lastRequested !== request.model
      : priorModel !== undefined && !sameModel(priorModel, request.model);
    current.requested.set(key, request.model);
    current.pending.set(key, { request: identity, changed });
    if (changed) redraw(current);
    return { current, startedAt, key, identity, changed };
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
      if (validSample(sample)) {
        if (!current.samples.has(sampleKey(sample))) current.samples.set(sampleKey(sample), sample);
        try {
          const result = await send(current, { action: 'cache-sample', sample, transcript_path: transcript(current, sample.agentId) });
          if (context === current && validSample(result.sample)) current.samples.set(sampleKey(result.sample), result.sample);
        }
        catch { current.available = false; current.host.ui.log('Agent Router: cache observation could not be saved.', { to: 'debug' }); }
      }
    }
    current.now = await current.host.clock.now();
    if (usage || ticket.changed) redraw(current);
  }

  async function reset(agentId: string | null = null) {
    const current = context;
    if (!current) return;
    const resetAt = await current.host.clock.now();
    current.resets = current.resets.filter(r => r.sessionId !== current.sessionId || r.agentId !== agentId);
    current.resets.push({ sessionId: current.sessionId, agentId, resetAt });
    try { await send(current, { action: 'cache-reset', agent_id: agentId, reset_at: resetAt }); }
    catch { current.available = false; }
    redraw(current);
  }

  async function recheck(current: Context) {
    const loops = new Map<string, string | null>();
    for (const sample of current.samples.values()) {
      if (sample.sessionId !== current.sessionId || sample.cacheCreation || !sample.write || sample.completedAt === undefined) continue;
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

  async function tick() {
    const current = context;
    if (!current) return;
    current.now = await current.host.clock.now();
    if (!current.rechecking) current.rechecking = recheck(current).finally(() => { current.rechecking = undefined; });
    await current.rechecking;
    const display = rows(current).map(row => `${meter(current, row)} ${reportedLifetimes(row.last, current.now).map(part => cacheClock(part.leftMs)).join(' ')}`).join('\n');
    if (display !== lastDisplay) { lastDisplay = display; redraw(current); }
  }

  async function show() {
    const prior = context ?? previous;
    if (prior) {
      const id = await prior.host.session.id();
      if (!context || id !== prior.sessionId) await initialize(prior.host, prior.bridge, id, prior.endpoint, undefined,
        { env: prior.env });
    }
    const current = context;
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
    const latest = row?.last;
    return Box({ flexDirection: 'column', children: [content, Box({ flexDirection: 'row', gap: 1, children: [
      Button({ key: 'agent-cache-open', label: 'Cache', onPress: show }),
      Text({ wrap: 'truncate-end', children: [row ? `${meter(current, row)}${latest ? ` · read ${cacheTokens(latest.read)} · wrote ${cacheTokens(latest.write)} · new ${cacheTokens(latest.fresh)}` : ''}${current.available ? '' : ' · storage unavailable'}` : 'no observation'] }),
    ] })] });
  }

  function renderPane(elements: Elements[RenderSurface], agentId?: string): RenderElement | undefined {
    const current = context;
    if (!current || !open) return undefined;
    const { Box, Button, Text } = elements;
    const all = rows(current);
    const chosen = all.find(row => loopKey(row.sessionId, row.agentId) === (selected ?? loopKey(current.sessionId, agentId)));
    const children: RenderElement[] = [Text({ bold: true, children: ['Prompt cache · all agents'] }),
      Text({ dimColor: true, children: ['Bars show the last request hit rate. Expiry is an estimate. Select an agent for recent requests.'] })];
    if (!current.available) children.push(Text({ color: 'yellow', children: ['Storage unavailable · showing last known observations'] }));
    for (const row of all) {
      const key = loopKey(row.sessionId, row.agentId);
      const counts = row.totals;
      const status = state(current, row);
      const reported = reportedLifetimes(row.last, current.now);
      const life: RenderElement[] = reported.length ? reported.map(part => Text({
        color: part.leftMs === 0 ? 'red' : part.leftMs < 60000 ? 'yellow' : 'green',
        children: [`Reported ${part.ttl} writes ${cacheTokens(part.tokens)} · ${cacheBar(part.leftMs / part.ttlMs)} ~${cacheClock(part.leftMs)} left`],
      })) : [];
      children.push(Box({ flexDirection: 'column', children: [
        Button({ key: `cache-agent:${key}`, label: displayText(row.label, 120), onPress: () => { selected = key; redraw(current); } }),
        Text({ children: [meter(current, row)] }),
        ...life,
        Text({ dimColor: true, children: [`${counts.requests} requests · read ${cacheTokens(counts.read)} · wrote ${cacheTokens(counts.write)} · new ${cacheTokens(counts.fresh)} · out ${cacheTokens(counts.output)}`] }),
        Text({ dimColor: true, children: [row.last ? `${displayText(row.last.model, 160)} · ${displayText(row.last.ttlSource, 120)}` : 'No usage observed in this context'] }),
      ] }));
    }
    if (chosen) {
      children.push(Text({ bold: true, children: [`Recent requests · ${displayText(chosen.label, 120)} (last 30)`] }));
      for (const sample of [...chosen.samples].reverse()) {
        const status = cacheStatus(sample, current.now);
        children.push(Text({ wrap: 'truncate-end', children: [`${displayText(sample.turnId, 12)}:${sample.index} ${cacheBar(status.ratio, 6)} ${status.ratio === null ? 'n/a' : `${Math.round(status.ratio * 100)}%`} · read ${cacheTokens(sample.read)} · wrote ${cacheTokens(sample.write)} · new ${cacheTokens(sample.fresh)} · out ${cacheTokens(sample.output)} · ${displayText(sample.model, 160)}`] }));
      }
    }
    children.push(Button({ key: 'agent-cache-close', label: 'Close', onPress: () => current.host.ui.close({ id: CACHE_PANE }) }));
    return Box({ flexDirection: 'column', gap: 1, children });
  }

  return { initialize, begin, finish, reset, refresh, tick, show, renderBand, renderPane, setTranscript, enrich, close: () => { open = false; },
    clear: () => { previous = context ?? previous; context = undefined; open = false; selected = undefined; } };
}
