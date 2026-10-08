// Pi/OMP port of keepalive/hooks/cache-panel.ts: the cache ledger, upkeep and policy logic, with no UI.
// Everything environmental (clock, storage, network, model calls, compaction) comes in through PanelHost.
import {
  applyCacheCreation, cachePolicy, cacheRows, cacheStatus, isCompaction, isKeepalive, keepaliveWorthwhile, keepalivesLeft, loopKey,
  policyAction, policyRow, recentUsage, sampleKey, unreportedModels, validPrices, validSample,
} from "./core/cache.js";
import { handleRequest } from "./core/bridge.mjs";
import { createPolicyClient, pickRow, policyUrl } from "./core/shared/policy.mjs";
import { sameModel } from "./core/shared/models.js";
import { displayText } from "./core/shared/text.js";
import { applyTtl, buildKeepalivePayload, requestedTtl, type ReplayApi, type Tokens } from "./replay.ts";
import { type Resolved, type Ttl, type Upkeep, UPKEEP } from "./settings.ts";
import { VERSION, keepalivePrompt } from "./version.ts";

export const UPKEEP_MS = 30000;
export const PRICES_MS = 3600000;
const UPKEEP_KEY = "cache-upkeep";
const TTL_KEY = "cache-ttl";
const INTRO_KEY = "cache-intro";

export interface ForkResult {
  answered: boolean;
  reason?: string;
  usage?: Tokens;
}
export interface CompactResult {
  ok: boolean;
  skip?: string;
  usage?: Tokens;
  tokensBefore?: number;
  tokensAfter?: number;
}
export interface PanelHost {
  now(): number;
  root: string;
  env: Record<string, string | undefined>;
  fetch(url: string, init: object): Promise<{ status: number; text: string }>;
  credentials(): Promise<Record<string, string>>;
  fork(payload: Record<string, unknown>, source: Source): Promise<ForkResult>;
  compact(): Promise<CompactResult>;
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  log(text: string, level?: "debug" | "info"): void;
  redraw(): void;
  busy(): boolean;
}
export interface Source {
  model: string;
  api: ReplayApi | null;
  baseUrl: string;
  /** The host's model object, for sending the keepalive through the same provider. */
  modelRef?: unknown;
  /** The payload as sent, for the keepalive replay. */
  payload: unknown;
}
export interface Ctx {
  host: PanelHost;
  sessionId: string;
  settings: Resolved;
  upkeep: Upkeep;
  samples: Map<string, any>;
  resets: any[];
  now: number;
  pending?: { startedAt: number; changed: boolean; requested: Ttl; source: Source };
  lastModel?: string;
  last?: Source;
  actedAt?: number;
  upkeeping?: Promise<void>;
  policy: ReturnType<typeof createPolicyClient>;
  prices: Map<string, { at: number; value: any; settled: boolean; lookup?: Promise<void> }>;
  ttl?: Ttl;
  available: boolean;
  warming: boolean;
  seq: number;
  timeScale: number;
}

const bridge = (c: Ctx, request: Record<string, unknown>): Promise<any> =>
  handleRequest({ ...request, session_id: c.sessionId }, { ...c.host.env, CLAUDE_PLUGIN_DATA: c.host.root });

const claudeNative = (source: Source | undefined, model: string) => source?.api === "anthropic-messages" && /claude/i.test(model);

export function createPanel() {
  let ctx: Ctx | undefined;

  const get = () => ctx;

  /** Rows of every loop in this session (Pi has one loop: the main conversation). */
  function rows(c: Ctx): any[] {
    const result = cacheRows([...c.samples.values()], c.resets, new Map([[loopKey(c.sessionId, null), "Main"]]));
    if (!result.length) result.push({ sessionId: c.sessionId, agentId: null, label: "Main", samples: [], keepalives: [], totals: { requests: 0, read: 0, write: 0, fresh: 0, output: 0 } });
    return result;
  }
  const mainRow = (c: Ctx) => rows(c)[0];

  /** Test-only time dilation (PI_KEEPALIVE_E2E_TTL_MS): counts the 5m TTL down faster so an e2e run need not wait 5 minutes. */
  const eff = (c: Ctx, row: any) => (c.timeScale === 1 || row?.touchedAt === undefined ? c.now : row.touchedAt + (c.now - row.touchedAt) * c.timeScale);

  function state(c: Ctx, row: any) {
    const pending = c.pending;
    const value = cacheStatus(row, eff(c, row), pending?.startedAt, unreportedModels(rows(c), c.now));
    if (pending?.changed && row.last) return { ...value, state: "model changed · awaiting usage", leftMs: null, lifetimes: [], ttl: undefined };
    return value;
  }

  function policyOf(c: Ctx, row: any) {
    if (!gatewayBase(c) || !policyRow(row)) return undefined;
    return pickRow(c.policy.peek(row.last.model, c.now), row.last.read + row.last.write);
  }

  /** Any non-Anthropic base URL may publish a cache policy; policyUrl refuses api.anthropic.com and unsafe URLs. */
  function gatewayBase(c: Ctx): string | undefined {
    const base = c.last?.baseUrl;
    return base && policyUrl(base, "x", "") ? base : undefined;
  }

  async function savedEntries(host: PanelHost, key: string, valid: (e: unknown[]) => boolean): Promise<any[]> {
    try {
      const saved = await host.store.get(key);
      return Array.isArray(saved) ? saved.filter((e) => Array.isArray(e) && valid(e)) : [];
    } catch { return []; }
  }
  const savedUpkeep = (host: PanelHost) => savedEntries(host, UPKEEP_KEY, (e) => typeof e[0] === "string" && UPKEEP.includes(e[1] as Upkeep));
  const savedTtl = (host: PanelHost) => savedEntries(host, TTL_KEY, (e) => typeof e[0] === "string" && (e[1] === "5m" || e[1] === "1h"));

  async function persist(c: Ctx, key: string, value: unknown, load: (h: PanelHost) => Promise<any[]>, what: string) {
    try {
      const others = (await load(c.host)).filter(([id]) => id !== c.sessionId);
      await c.host.store.set(key, [...others, [c.sessionId, value]].slice(-16));
    } catch { c.host.log(`Keepalive: cache ${what} choice could not be saved.`); }
  }

  async function initialize(host: PanelHost, sessionId: string, settings: Resolved, previous?: Ctx) {
    const scale = Number(host.env.PI_KEEPALIVE_E2E_TTL_MS) > 0 && host.env.PI_KEEPALIVE_E2E === "1" ? 300000 / Number(host.env.PI_KEEPALIVE_E2E_TTL_MS) : 1;
    const saved = (await savedUpkeep(host)).find(([id]) => id === sessionId)?.[1] as Upkeep | undefined;
    const ttl = (await savedTtl(host)).find(([id]) => id === sessionId)?.[1] as Ttl | undefined;
    const c: Ctx = {
      host, sessionId, settings, upkeep: saved ?? settings.upkeep, samples: new Map(), resets: [], now: host.now(), available: true, warming: false, seq: 0,
      prices: previous?.prices ?? new Map(), ttl, timeScale: scale,
      policy: previous?.policy ?? createPolicyClient({ fetch: (url, init) => host.fetch(url, init), headers: host.credentials }),
    };
    ctx = c;
    if (!saved) await persist(c, UPKEEP_KEY, c.upkeep, savedUpkeep, "upkeep");
    await refresh();
    return c;
  }

  async function refresh() {
    const c = ctx;
    if (!c) return;
    try {
      const snapshot = await bridge(c, { action: "cache-snapshot" });
      if (ctx !== c) return;
      for (const s of snapshot.samples) if (validSample(s)) c.samples.set(sampleKey(s), s);
      c.resets = snapshot.resets;
      c.available = true;
    } catch { if (ctx === c) c.available = false; }
    c.host.redraw();
  }

  /** The TTL this conversation asks for: the choice made with /keepalive ttl, else the configured one; undefined = leave it alone. */
  function wantedTtl(c: Ctx): Ttl | undefined {
    return c.ttl ?? c.settings.ttl;
  }

  /** Called with the payload about to be sent; returns the payload to send (TTL applied when one is chosen). */
  function begin(source: Source): unknown {
    const c = ctx;
    if (!c || c.warming) return source.payload;
    const wanted = source.api === "anthropic-messages" ? wantedTtl(c) : undefined;
    const payload = wanted ? applyTtl(source.payload, wanted) : source.payload;
    const sent: Source = { ...source, payload: structuredClone(payload) };
    const changed = c.lastModel !== undefined && !sameModel(c.lastModel, source.model);
    c.lastModel = source.model;
    c.pending = { startedAt: c.host.now(), changed, requested: requestedTtl(payload), source: sent };
    c.last = sent;
    if (changed) c.host.redraw();
    return payload;
  }

  function creationOf(usage: Tokens & { write1h?: number }, source: Source, model: string, requested: Ttl) {
    if (!usage.write) return undefined;
    if (usage.write1h !== undefined) return { fiveMinute: usage.write - usage.write1h, oneHour: usage.write1h };
    if (!claudeNative(source, model)) return undefined;
    return requested === "1h" ? { fiveMinute: 0, oneHour: usage.write } : { fiveMinute: usage.write, oneHour: 0 };
  }

  /** Only Anthropic requests record a requested TTL: elsewhere nothing is promised, so no lifetime is assumed. */
const requestedOf = (source: Source | undefined, model: string, requested: Ttl) => (claudeNative(source, model) ? { requested } : {});

function sampleOf(c: Ctx, fields: object) {
    const model = (fields as any).model;
    const policy = cachePolicy(c.host.env, model);
    return { sessionId: c.sessionId, agentId: null, index: 0, ...policy, disabled: policy.disabled || c.host.env.PI_CACHE_RETENTION === "none", ...fields };
  }

  async function observe(c: Ctx, sample: any) {
    if (!validSample(sample)) return;
    c.samples.set(sampleKey(sample), sample);
    try {
      const result = await bridge(c, { action: "cache-sample", sample });
      if (ctx === c && validSample(result.sample)) c.samples.set(sampleKey(result.sample), result.sample);
    } catch {
      c.available = false;
      c.host.log("Keepalive: cache observation could not be saved.");
    }
  }

  /** A real request completed (usage) or ended without usage (error/abort). */
  async function finish(usage: (Tokens & { write1h?: number; model?: string }) | undefined) {
    const c = ctx;
    const pending = c?.pending;
    if (!c || !pending) return;
    c.pending = undefined;
    if (usage) {
      const model = usage.model || pending.source.model;
      let sample: any = sampleOf(c, { turnId: `r${pending.startedAt.toString(36)}${c.seq++}`, model, startedAt: pending.startedAt, completedAt: Math.max(pending.startedAt, c.host.now()),
        read: usage.read, write: usage.write, fresh: usage.fresh, output: usage.output, ...requestedOf(pending.source, model, pending.requested) });
      const creation = creationOf(usage, pending.source, model, pending.requested);
      if (creation) sample = applyCacheCreation(sample, creation);
      await observe(c, sample);
    }
    c.now = c.host.now();
    if (usage || pending.changed) c.host.redraw();
  }

  async function reset(c: Ctx, resetAt: number) {
    c.resets = c.resets.filter((r) => r.sessionId !== c.sessionId);
    c.resets.push({ sessionId: c.sessionId, agentId: null, resetAt });
    try { await bridge(c, { action: "cache-reset", agent_id: null, reset_at: resetAt }); } catch { c.available = false; }
    c.host.redraw();
  }

  async function compacted(startedAt: number, result: CompactResult) {
    const c = ctx;
    if (!c) return;
    const model = mainRow(c).last?.model ?? "unknown";
    const usage = result.usage;
    await reset(c, startedAt);
    await observe(c, sampleOf(c, { turnId: `compaction:${startedAt}`, model, startedAt, completedAt: Math.max(startedAt, c.host.now()),
      read: usage?.read ?? 0, write: usage?.write ?? 0, fresh: usage?.fresh ?? 0, output: usage?.output ?? 0, ...requestedOf(c.last, model, c.last ? requestedTtl(c.last.payload) : "5m"),
      ...(result.tokensBefore !== undefined ? { tokensBefore: result.tokensBefore } : {}),
      ...(result.tokensAfter !== undefined ? { tokensAfter: result.tokensAfter } : {}) }));
    c.host.redraw();
  }

  async function warm(c: Ctx, model: string) {
    const startedAt = c.host.now();
    const source = c.last!;
    const built = buildKeepalivePayload(source.api, source.payload, VERSION);
    if (!built.ok) { c.host.log(`Keepalive: cache keepalive skipped (${built.reason}).`); return; }
    c.warming = true;
    let result: ForkResult;
    try { result = await c.host.fork(built.payload, source); } catch { result = { answered: false, reason: "request failed" }; } finally { c.warming = false; }
    if (ctx !== c) return;
    if (!result.answered) c.host.log(`Keepalive: cache keepalive did not answer (${result.reason}).`);
    const usage = result.usage;
    if (!usage || usage.read + usage.write + usage.fresh === 0) return;
    await observe(c, sampleOf(c, { turnId: `keepalive:${startedAt}`, model, startedAt, completedAt: c.host.now(), read: usage.read, write: usage.write, fresh: usage.fresh, output: usage.output,
      ...requestedOf(source, model, requestedTtl(source.payload)) }));
    c.now = c.host.now();
    c.host.redraw();
  }

  async function compact(c: Ctx) {
    try {
      const startedAt = c.host.now();
      const result = await c.host.compact();
      if (ctx !== c) return;
      if (!result.ok) { c.host.log(`Keepalive: cache compaction skipped: ${result.skip}`); return; }
      c.host.log("Keepalive compacted the conversation before its prompt cache expired.", "info");
      await compacted(startedAt, result);
    } catch { c.host.log("Keepalive: cache compaction could not run during a turn."); }
  }

  function lookUpPrices(c: Ctx, model: string) {
    const known = c.prices.get(model);
    if (known?.lookup || (known && c.now - known.at < PRICES_MS)) return known?.lookup;
    const lookup = (async () => {
      let value: any = null;
      let found = false;
      try {
        const matched = (await bridge(c, { action: "cache-prices", models: [model] }))?.prices?.[model];
        value = validPrices(matched) ? matched : null;
        found = true;
      } catch { /* retried at the next tick */ }
      if (found) c.prices.set(model, { at: c.now, value, settled: true });
      else if (known) c.prices.set(model, { ...known, lookup: undefined });
      else c.prices.delete(model);
      if (found && !value) c.host.log(`Keepalive: no price found for ${displayText(model, 160)}; keepalives are off for it.`);
      c.host.redraw();
    })();
    c.prices.set(model, { at: known?.at ?? c.now, value: known?.value ?? null, settled: known?.settled ?? false, lookup });
    return lookup;
  }

  async function policyUpkeep(c: Ctx, row: any, policy: any) {
    if (c.upkeep !== "warm" && c.upkeep !== "warmcomp") return;
    const model = row.last.model;
    if (c.settings.limit === undefined) await lookUpPrices(c, model);
    const { action, dueAt } = policyAction(row, { status: policy.status, safe: policy.safe, maxIdle: policy.maxIdle, refreshOnRead: policy.refreshOnRead }, eff(c, row));
    if (action !== "fire" || c.actedAt === dueAt) return;
    c.actedAt = dueAt;
    if (keepaliveWorthwhile(row, c.prices.get(model)?.value, c.settings.limit)) return warm(c, model);
    c.host.log("Keepalive: cache warming stopped at its limit.");
  }

  async function upkeep(c: Ctx) {
    if (c.upkeep === "off" || c.pending || c.warming || !c.last || c.host.busy()) return;
    const row = mainRow(c);
    const sample = row.last;
    const policy = policyOf(c, row);
    if (sample && policy) return policyUpkeep(c, row, policy);
    if (!sample || row.touchedAt === undefined || c.actedAt === row.touchedAt) return;
    const warms = c.upkeep === "warm" || c.upkeep === "warmcomp";
    if (warms && c.settings.limit === undefined) await lookUpPrices(c, sample.model);
    const status = cacheStatus(row, eff(c, row), undefined, unreportedModels(rows(c), c.now));
    if (!status.leftMs || status.leftMs > UPKEEP_MS) return;
    c.actedAt = row.touchedAt;
    if (warms && keepaliveWorthwhile(row, c.prices.get(sample.model)?.value, c.settings.limit)) return warm(c, sample.model);
    if (c.upkeep !== "warm" && sample.read + sample.write + sample.fresh >= c.settings.compactAt) return compact(c);
    if (warms) c.host.log(c.settings.limit !== undefined && row.keepalives.length >= c.settings.limit
      ? `Keepalive: cache warming stopped at the keepalive limit of ${c.settings.limit}.`
      : "Keepalive: cache warming paused; another keepalive would cost more than rewriting the cache.");
  }

  /** One clock tick: refresh time, the gateway policy, then upkeep; true when the display changed. */
  async function tick(): Promise<boolean> {
    const c = ctx;
    if (!c) return false;
    c.now = c.host.now();
    const base = gatewayBase(c);
    const governed = mainRow(c);
    if (base && policyRow(governed)) void c.policy.refresh(base, governed.last.model, c.sessionId, c.now);
    if (!c.upkeeping) c.upkeeping = upkeep(c).catch(() => undefined).finally(() => { c.upkeeping = undefined; });
    await c.upkeeping;
    return true;
  }

  async function setUpkeep(mode: Upkeep) {
    const c = ctx;
    if (!c) return;
    c.upkeep = mode;
    c.actedAt = undefined;
    c.host.redraw();
    await persist(c, UPKEEP_KEY, c.upkeep, savedUpkeep, "upkeep");
  }
  const cycle = () => (ctx ? setUpkeep(UPKEEP[(UPKEEP.indexOf(ctx.upkeep) + 1) % UPKEEP.length]) : Promise.resolve());

  async function setTtl(ttl: Ttl | undefined) {
    const c = ctx;
    if (!c) return;
    c.ttl = ttl;
    c.host.redraw();
    if (ttl) await persist(c, TTL_KEY, ttl, savedTtl, "TTL");
  }

  async function introduce(text: string[]) {
    const c = ctx;
    if (!c) return;
    try {
      if (await c.host.store.get(INTRO_KEY)) return;
      await c.host.store.set(INTRO_KEY, 1);
    } catch { return; }
    for (const line of text) c.host.log(line, "info");
  }

  /** Whether this extension is warming/compacting the session, so the host's built-in warmer must stand down. */
  function managed(): boolean {
    const c = ctx;
    if (!c || c.upkeep === "off" || !c.last) return false;
    const row = mainRow(c);
    if (!policyRow(row)) return state(c, row).ttl !== undefined;
    return policyOf(c, row)?.status === "enabled";
  }

  /** The model changed: nothing may be replayed until the next real request. */
  const forget = () => { if (ctx) ctx.last = undefined; };

  return { get, forget, initialize, refresh, begin, finish, compacted, tick, setUpkeep, cycle, setTtl, introduce, managed, rows, mainRow, state, policyOf, recentUsage, isKeepalive, isCompaction, keepalivesLeft, keepalivePrompt, eff, lookUpPrices, wantedTtl, gatewayBase, setSettings: (s: Resolved) => { if (ctx) ctx.settings = s; } };
}
export type Panel = ReturnType<typeof createPanel>;
