// Prompt-cache keepalive for Pi and OMP (oh-my-pi): feature parity with the Claude Code `keepalive` plugin.
// No package-specific type import: Pi and OMP expose the same extension API under different package names.
import { createPanel, type CompactResult, type ForkResult, type PanelHost, type Source } from "./lib/panel.ts";
import { REQUEST_FILTERS, dashboard, painter, statusLine, type RequestFilter } from "./lib/render.ts";
import { replayApi, type Tokens } from "./lib/replay.ts";
import { SETTING_ROWS, keepaliveLimit, mergeSettings, resolveSettings, type Settings, UPKEEP, type Upkeep } from "./lib/settings.ts";
import { createStore, dataRoot, readJson, writeJson, trace } from "./lib/storage.ts";
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
  const root = dataRoot(process.env, import.meta.url);
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
  const settingsNow = (): Settings => mergeSettings(readJson(`${root}/settings.json`), env);
  const p = painter(env, !!env.NO_COLOR);

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
    if (text !== lastText) { lastText = text; trace(env, "status", { text: statusLine(panel, c, painter({}, true)) }); safe(() => ui()?.setStatus?.("keepalive", text)); }
    if (widget) safe(() => ui()?.setWidget?.("keepalive", dashboard(panel, c, p, widget!)));
  }

  async function start(ctx: any): Promise<void> {
    ctxRef = ctx;
    stop();
    const settings = resolveSettings(settingsNow());
    await panel.initialize(host, sessionId(), settings, panel.get());
    await panel.introduce(INTRO);
    timer = setInterval(() => {
      void panel.tick().then(render).catch(() => undefined);
    }, 1000);
    timer.unref?.();
    render();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
    abort.abort();
    lastText = undefined;
  }

  for (const ev of ["session_start", "session_switch", "session_branch", "session_tree"]) pi.on(ev, (_e: any, ctx: any) => start(ctx));
  pi.on("session_shutdown", () => { stop(); safe(() => { ui()?.setStatus?.("keepalive", undefined); ui()?.setWidget?.("keepalive", undefined); }); });
  pi.on("model_select", (_e: any, ctx: any) => { ctxRef = ctx; panel.forget(); });
  pi.on("agent_start", () => abort.abort());

  pi.on("before_provider_headers", (e: any) => {
    realHeaders = Object.fromEntries(Object.entries(e.headers).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  });

  pi.on("before_provider_request", (e: any, ctx: any) => {
    ctxRef = ctx;
    const c = panel.get();
    const model = ctx?.model;
    if (!c || !model || c.warming) return undefined;
    const source: Source = { model: String(model.id), api: replayApi(model.api), baseUrl: String(model.baseUrl), modelRef: model, payload: e.payload };
    const next = panel.begin(source);
    return next === e.payload ? undefined : next;
  });

  const usageOf = (u: any): Tokens | undefined => (u ? { read: u.cacheRead, write: u.cacheWrite, fresh: u.input, output: u.output } : undefined);

  pi.on("message_end", async (e: any, ctx: any) => {
    const m = e.message;
    if (m?.role !== "assistant") return;
    ctxRef = ctx;
    const ok = m.stopReason !== "error" && m.stopReason !== "aborted" && m.usage;
    await panel.finish(ok ? { ...usageOf(m.usage)!, write1h: m.usage.cacheWrite1h, model: String(m.responseModel ?? m.model) } : undefined);
    render();
  });

  pi.on("session_compact", async (e: any, ctx: any) => {
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
      const [cmd = "", a = "", b = ""] = first(String(args));
      const c = panel.get();
      const say = (text: string) => safe(() => ui()?.notify?.(text, "info"));
      if (cmd === "off" || cmd === "on") {
        enabled = cmd === "on";
        if (!enabled) { stop(); safe(() => ui()?.setStatus?.("keepalive", undefined)); } else await start(ctx);
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
        if (a === "5m" || a === "1h") await panel.setTtl(a); else await panel.setTtl(panel.wantedTtl(c) === "1h" ? "5m" : "1h");
        say(`Keepalive TTL: ${panel.wantedTtl(panel.get()!)}`);
      } else if (cmd === "set") {
        const key = SETTING_ROWS.find(([k]) => k === a)?.[0];
        say(key ? await setting(key, b) : `Unknown setting. Known: ${SETTING_ROWS.map(([k]) => k).join(", ")}`);
      } else if (cmd === "settings") {
        const chosen = await ui()?.select?.("Keepalive settings", SETTING_ROWS.map(([, title]) => title));
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
