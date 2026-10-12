// Prompt-cache keepalive for Pi and OMP (oh-my-pi): feature parity with the Claude Code `keepalive` plugin.
// No package-specific type import: Pi and OMP expose the same extension API under different package names.
import { createCodexHistory, sideRequest } from "./lib/codex.ts";
import { createPanel, type CompactResult, type ForkResult, type PanelHost, type Source } from "./lib/panel.ts";
import { REQUEST_FILTERS, dashboard, painter, statusLine, type RequestFilter } from "./lib/render.ts";
import { replayApi, type Tokens } from "./lib/replay.ts";
import { fallbackTtl } from "./lib/core/cache.js";
import { SETTING_ROWS, keepaliveLimit, mergeSettings, resolveSettings, type Settings, UPKEEP, type Upkeep } from "./lib/settings.ts";
import { createStore, dataRoot, readJson, writeJson, trace } from "./lib/storage.ts";
import { lastControl, readControl, snapshot, ternActive, ternBridge, writePane } from "./lib/tern.ts";
import { VERSION } from "./lib/version.ts";
import { sendKeepalive } from "./lib/transport.ts";

const INTRO = [
  "Keepalive: a prompt-cache bar sits in the footer: [ ◕ ] dial (time until the cache expires), the upkeep mode, TTL, hit rate over the last 10 requests, ✕ recent misses, ETA.",
  "  /keepalive dashboard shows the session at a glance; /keepalive requests [real|keepalives|compactions|misses] lists requests.",
  "  /keepalive upkeep [off|warm|compact|warmcomp] picks what happens 30 seconds before an idle cache expires; warm sends cheap keepalives, compact summarises a large conversation while it is cached.",
  "  Keepalives and compactions are billed. /keepalive settings sets the TTL, keepalive limit and compaction threshold.",
];

export default function keepaliveExtension(pi: any): void {
  if (process.env.PI_KEEPALIVE === "0") return;
  const panel = createPanel();
  let agentDir: unknown;
  try { agentDir = pi?.pi?.getAgentDir?.(); } catch { agentDir = undefined; }
  const root = dataRoot(process.env, import.meta.url, agentDir);
  const store = createStore(root);
  const env = process.env;
  let ctxRef: any;
  let timer: { unref?(): void } | undefined;
  let lastText: string | undefined;
  let widget: RequestFilter | undefined;
  let abort = new AbortController();
  let ourCompaction = false;
  let enabled = true;
  let realHeaders: Record<string, string> | undefined;
  let codex = createCodexHistory();
  const settingsNow = (): Settings => mergeSettings(readJson(`${root}/settings.json`), env);
  let settingsText = "";
  const p = painter(env, !!env.NO_COLOR);
  // In a Tern pane: publish the pane's cache state for the Tern plugin, take its commands, and leave the footer bar to it while it runs.
  const bridge = ternBridge(env);
  let ternShown = false;
  let controlSeq = bridge ? lastControl(bridge) : 0;
  let published: { key: string; at: number } | undefined;

  const sessionId = (): string => String(ctxRef.sessionManager.getSessionId());
  const ui = (): any => ctxRef?.ui;
  const safe = (fn: () => void) => { try { fn(); } catch { /* the UI may be gone */ } };

  async function credentials(): Promise<Record<string, string>> {
    const reg = ctxRef?.modelRegistry;
    try {
      const r = await reg?.getApiKeyAndHeaders?.(ctxRef.model);
      const key = typeof r === "string" ? r : r?.ok === false ? undefined : r?.apiKey;
      return key ? { authorization: `Bearer ${key}`, "x-api-key": key } : {};
    } catch { return {}; }
  }

  const host: PanelHost = {
    now: () => Date.now(),
    root,
    env: { ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: env.PI_OFFLINE || env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC },
    async fetch(url, init) {
      const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(5000) } as any);
      return { status: res.status, text: await res.text() };
    },
    credentials,
    harness: () => (typeof ctxRef?.modelRegistry?.streamSimple === "function" ? "pi" : "omp"),
    async fork(payload, source): Promise<ForkResult> {
      abort = new AbortController();
      const result = await sendKeepalive(ctxRef, source, payload, abort.signal, sessionId(), env.PI_KEEPALIVE_TRANSPORT === "fetch", realHeaders);
      trace(env, "keepalive", { baseUrl: source.baseUrl, model: source.model, lastMessage: (payload.messages as any[] | undefined)?.at(-1), result });
      return result;
    },
    compact(): Promise<CompactResult> {
      return new Promise((resolve) => {
        ourCompaction = true;
        const done = (r: CompactResult) => { ourCompaction = false; resolve(r); };
        try {
          ctxRef.compact({
            onComplete: (r: any) => done({ ok: true, usage: usageOf(r?.usage), tokensBefore: r?.tokensBefore }),
            onError: (e: any) => done({ ok: false, skip: String(e) }),
          });
        } catch (e: any) { done({ ok: false, skip: String(e) }); }
      });
    },
    busy: () => typeof ctxRef?.isIdle === "function" && !ctxRef.isIdle(),
    store,
    log: (text, level) => { trace(env, "log", { text }); safe(() => (level === "info" ? ui()?.notify?.(text, "info") : undefined)); },
    redraw: () => render(),
  };

  function render(): void {
    const c = panel.get();
    if (!c || !enabled) return;
    const text = statusLine(panel, c, p);
    const shown = ternShown ? "" : text;
    if (shown !== lastText) {
      lastText = shown;
      trace(env, "status", { text: statusLine(panel, c, painter({}, true)), tern: ternShown });
      safe(() => ui()?.setStatus?.("keepalive", ternShown ? undefined : text));
    }
    if (widget) safe(() => ui()?.setWidget?.("keepalive", dashboard(panel, c, p, widget!)));
  }

  /** Writes the pane's snapshot when it changed, and at least every 5 s so the plugin can tell a live pane from a dead one. */
  function publish(open = true): void {
    if (!bridge) return;
    const now = Date.now();
    const c = panel.get();
    const snap = snapshot(panel, open ? c : undefined, { pane: bridge.pane, sessionId: c?.sessionId ?? "", root, cwd: ctxRef?.cwd ?? process.cwd(), settings: settingsNow(), enabled: enabled && open, now });
    const key = JSON.stringify({ ...snap, at: 0 });
    if (open && published?.key === key && now - published.at < 5000) return;
    published = { key, at: now };
    try { writePane(bridge, JSON.stringify(snap)); } catch (e) { trace(env, "tern", { error: String(e) }); }
  }

  /** Applies, in order, the upkeep/TTL commands the Tern plugin left for this pane since the last poll. */
  async function control(): Promise<void> {
    if (!bridge) return;
    for (const command of readControl(bridge, controlSeq)) {
      controlSeq = command.seq;
      if (command.upkeep === "cycle") await panel.cycle();
      else if (command.upkeep) await panel.setUpkeep(command.upkeep);
      if (command.ttl === "toggle") await panel.toggleTtl();
      else if (command.ttl) await panel.setTtl(command.ttl);
    }
  }

  /** One second: settings changed on disk (by /keepalive set in another session or Tern's settings page), Tern's commands, upkeep, redraw. */
  async function second(): Promise<void> {
    const settings = settingsNow();
    const text = JSON.stringify(settings);
    if (text !== settingsText) { settingsText = text; panel.setSettings(resolveSettings(settings)); }
    ternShown = ternActive(bridge, Date.now());
    await control();
    await panel.tick();
    render();
    publish();
  }

  // OMP runs task subagents in-process and may deliver their session events to this extension too; only the main conversation is
  // tracked and kept warm, so every handler ignores a subagent's context.
  const subagent = (ctx: { agent?: { kind?: unknown } } | undefined): boolean => ctx?.agent?.kind === "sub";

  async function start(ctx: any): Promise<void> {
    if (subagent(ctx)) return;
    ctxRef = ctx;
    stop();
    codex = createCodexHistory();
    const settings = settingsNow();
    settingsText = JSON.stringify(settings);
    ternShown = ternActive(bridge, Date.now());
    await panel.initialize(host, sessionId(), resolveSettings(settings), panel.get());
    await panel.introduce(INTRO);
    timer = setInterval(() => { void second().catch(() => undefined); }, 1000);
    timer.unref?.();
    render();
    publish();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
    abort.abort();
    lastText = undefined;
  }

  for (const ev of ["session_start", "session_switch", "session_branch", "session_tree"]) pi.on(ev, (_e: any, ctx: any) => start(ctx));
  pi.on("session_shutdown", (_e: any, ctx: any) => {
    if (subagent(ctx)) return;
    stop();
    publish(false);
    safe(() => { ui()?.setStatus?.("keepalive", undefined); ui()?.setWidget?.("keepalive", undefined); });
  });
  pi.on("model_select", (_e: any, ctx: any) => { if (subagent(ctx)) return; ctxRef = ctx; panel.forget(); });
  pi.on("agent_start", (_e: any, ctx: any) => { if (!subagent(ctx)) abort.abort(); });
  pi.on("agent_end", (_e: any, ctx: any) => { if (!subagent(ctx)) panel.settle(); });

  pi.on("before_provider_headers", (e: any, ctx: any) => {
    if (subagent(ctx)) return;
    realHeaders = Object.fromEntries(Object.entries(e.headers).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  });

  pi.on("before_provider_request", (e: any, ctx: any) => {
    if (subagent(ctx)) return undefined;
    ctxRef = ctx;
    const c = panel.get();
    const model = ctx?.model;
    if (!c || !model || c.warming) return undefined;
    const api = replayApi(model.api, model.baseUrl);
    if (api === "openai-codex-responses" && sideRequest(e.payload)) return undefined;
    // The ledger and the keepalive see Codex's full body; what is sent is never changed.
    const payload = api === "openai-codex-responses" ? codex.request(e.payload) : e.payload;
    const source: Source = { model: String(model.id), api, baseUrl: String(model.baseUrl), modelRef: model, payload };
    const next = panel.begin(source);
    return next === payload ? undefined : next;
  });

  const usageOf = (u: any): Tokens | undefined => (u ? { read: u.cacheRead, write: u.cacheWrite, fresh: u.input, output: u.output } : undefined);
  // Pi reports the 1h share of a cache write as `cacheWrite1h`; OMP as `cttl.ephemeral1h`, present only when non-zero, with `cttl` absent when unknown.
  const write1hOf = (u: { cacheWrite1h?: unknown; cttl?: unknown }): number | undefined => {
    if (typeof u.cacheWrite1h === "number") return u.cacheWrite1h;
    if (!u.cttl || typeof u.cttl !== "object") return undefined;
    const oneHour = "ephemeral1h" in u.cttl ? u.cttl.ephemeral1h : undefined;
    return typeof oneHour === "number" ? oneHour : 0;
  };

  pi.on("message_end", async (e: any, ctx: any) => {
    const m = e.message;
    if (m?.role !== "assistant" || subagent(ctx)) return;
    ctxRef = ctx;
    codex.response(m);
    const ok = m.stopReason !== "error" && m.stopReason !== "aborted" && m.usage;
    await panel.finish(ok ? { ...usageOf(m.usage)!, write1h: write1hOf(m.usage), model: String(m.upstreamModel ?? m.responseModel ?? m.model) } : undefined);
    render();
  });

  pi.on("session_compact", async (e: any, ctx: any) => {
    if (subagent(ctx)) return;
    ctxRef = ctx;
    if (ourCompaction) return;
    const entry = e.compactionEntry;
    await panel.compacted(Date.now(), { ok: true, usage: usageOf(entry.usage), tokensBefore: entry.tokensBefore });
    render();
  });

  // Suppress Pi/OMP's built-in warmer wherever this extension is handling the session.
  pi.on("cache_warming_decision", () => {
    const answer = enabled && panel.managed() ? { action: "stop" } : undefined;
    trace(env, "cache_warming_decision", { answer: answer ?? null });
    return answer;
  });

  const first = (args: string) => args.trim().split(/\s+/);
  async function setting(key: keyof Settings, value: string): Promise<string> {
    const next = { ...settingsNow(), [key]: value };
    const stored = readJson(`${root}/settings.json`);
    writeJson(root, "settings.json", { ...(stored && typeof stored === "object" ? (stored as object) : {}), [key]: value });
    panel.setSettings(resolveSettings(next));
    return `${key} = ${value}`;
  }

  pi.registerCommand?.("keepalive", {
    description: "Prompt cache keepalive: status | dashboard | requests | upkeep | ttl | settings | on | off",
    handler: async (args: string, ctx: any) => {
      ctxRef = ctx;
      const [cmd = "", a = ""] = first(String(args));
      const c = panel.get();
      const say = (text: string) => safe(() => ui()?.notify?.(text, "info"));
      if (cmd === "off" || cmd === "on") {
        enabled = cmd === "on";
        if (!enabled) { stop(); publish(); safe(() => ui()?.setStatus?.("keepalive", undefined)); } else await start(ctx);
      } else if (!c) say("Keepalive is not active in this session.");
      else if (cmd === "dashboard" || cmd === "requests") {
        widget = REQUEST_FILTERS.find((f) => f === a) ?? "all";
        render();
      } else if (cmd === "close") {
        widget = undefined;
        safe(() => ui()?.setWidget?.("keepalive", undefined));
      } else if (cmd === "upkeep") {
        if (UPKEEP.includes(a as Upkeep)) await panel.setUpkeep(a as Upkeep); else await panel.cycle();
        say(`Keepalive upkeep: ${panel.get()!.upkeep}`);
      } else if (cmd === "ttl") {
        if (a === "5m" || a === "1h") await panel.setTtl(a); else await panel.toggleTtl();
        say(`Keepalive TTL: ${panel.wantedTtl(panel.get()!)}`);
      } else if (cmd === "set") {
        const key = SETTING_ROWS.find(([k]) => k === a)?.[0];
        const value = String(args).trim().split(/\s+/).slice(2).join(" ");
        say(!key ? `Unknown setting. Known: ${SETTING_ROWS.map(([k]) => k).join(", ")}`
          : key === "unreported_ttl" && fallbackTtl(value.toLowerCase()) === undefined ? "unreported_ttl takes off, 5m, 15m, 30m, 45m or 1h."
          : await setting(key, value));
      } else if (cmd === "settings") {
        const chosen = await ui()?.select?.("Keepalive settings", SETTING_ROWS.filter(([, , choices]) => choices.length).map(([, title]) => title));
        const row = SETTING_ROWS.find(([, title]) => title === chosen);
        if (row) {
          const value = await ui()?.select?.(row[1], row[2]);
          if (value !== undefined && (row[0] !== "keepalive_limit" || keepaliveLimit(value) !== undefined || value === "default")) say(await setting(row[0], String(value)));
        }
      } else say(`keepalive v${VERSION}\n${statusLine(panel, c, painter(env, true))}`);
      render();
    },
  });
}
