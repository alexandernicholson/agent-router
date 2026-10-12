import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanel } from "../lib/panel.ts";
import { resolveSettings, mergeSettings } from "../lib/settings.ts";

export async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-keepalive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export const anthropicPayload = (extra = {}) => ({
  model: "claude-sonnet-5-5", max_tokens: 4096, system: [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }], ...extra,
});

export const source = (extra = {}) => ({ model: "claude-sonnet-5-5", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", payload: anthropicPayload(), modelRef: { id: "m" }, ...extra });

/** A PanelHost with a controllable clock and recorded effects. */
export async function fakeHost(t, over = {}) {
  const root = await tempRoot(t);
  const state = { now: 1_000_000, logs: [], redraws: 0, forks: [], compactions: 0, kv: new Map(), fetches: [], busy: false };
  const host = {
    now: () => state.now,
    root,
    env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    fetch: async (url, init) => { state.fetches.push({ url, init }); return state.policy ?? { status: 404, text: "" }; },
    credentials: async () => ({ "x-api-key": "k" }),
    fork: async (payload, src) => { state.forks.push({ payload, src }); return state.forkResult ?? { answered: true, usage: { read: 5000, write: 0, fresh: 11, output: 1 } }; },
    compact: async () => { state.compactions++; return state.compactResult ?? { ok: true, usage: { read: 0, write: 9, fresh: 1, output: 2 }, tokensBefore: 343000, tokensAfter: 18000 }; },
    busy: () => state.busy,
    store: { get: async (k) => state.kv.get(k), set: async (k, v) => void state.kv.set(k, v) },
    log: (text, level) => state.logs.push([text, level]),
    redraw: () => void state.redraws++,
    ...over,
  };
  return { host, state };
}

export const settings = (o = {}) => resolveSettings(mergeSettings(o, {}));

export async function started(t, { src = source(), set = {}, hostOver = {} } = {}) {
  const { host, state } = await fakeHost(t, hostOver);
  const panel = createPanel();
  await panel.initialize(host, "sess", settings(set));
  return { panel, host, state, src };
}

/** One real request: begin, then finish after `ms` with usage. */
export async function realRequest(panel, state, src, usage, ms = 1000) {
  panel.begin(src);
  state.now += ms;
  await panel.finish({ read: 0, write: 0, fresh: 0, output: 1, ...usage });
}

const EXTENSION_ENV = ["PI_KEEPALIVE_DIR", "PI_KEEPALIVE_UPKEEP", "PI_KEEPALIVE_LIMIT", "PI_KEEPALIVE", "PI_KEEPALIVE_TRANSPORT", "PI_KEEPALIVE_TERN", "PI_KEEPALIVE_TERN_DIR", "TERN_PANE"];

/**
 * Loads a fresh copy of the extension against a fake Pi/OMP API. The Tern bridge is off unless `env` turns it on, so a test run
 * inside a Tern pane never writes to the real plugin directory. `emit(e, ev, ctx?)` delivers an event as the main session or as `ctx`.
 */
export async function load(t, env = {}, api = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-keepalive-ext-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  Object.assign(process.env, { PI_KEEPALIVE_DIR: dir, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", PI_KEEPALIVE_UPKEEP: "warm", PI_KEEPALIVE_LIMIT: "2", PI_KEEPALIVE_TERN: "0" }, env);
  t.after(() => { for (const k of [...Object.keys(env), ...EXTENSION_ENV]) delete process.env[k]; });
  const mod = await import(`../index.ts?${Math.random()}`);
  const handlers = {};
  const commands = {};
  const pi = { on: (e, h) => (handlers[e] ||= []).push(h), registerCommand: (n, o) => (commands[n] = o), ...api };
  mod.default(pi);
  const ui = { status: [], widgets: [], notes: [], setStatus: (k, v) => ui.status.push(v), setWidget: (k, v) => ui.widgets.push(v), notify: (m) => ui.notes.push(m), select: async (_t, o) => o[0], input: async () => "9" };
  const compactions = [];
  const ctx = {
    model: { id: "claude-sonnet-5-5", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.anthropic.com" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test" }) },
    sessionManager: { getSessionId: () => "sess-1" }, ui, isIdle: () => true,
    compact: (o) => { compactions.push(o); o.onComplete({ usage: { cacheWrite: 7, input: 1, output: 2 }, tokensBefore: 3000 }); },
  };
  const emit = async (e, ev = {}, as = ctx) => { let out; for (const h of handlers[e] ?? []) out = (await h(ev, as)) ?? out; return out; };
  return { emit, ctx, ui, commands, handlers, compactions, dir };
}

export const turn = async (x, usage = { cacheRead: 0, cacheWrite: 5000, input: 10, output: 1 }) => {
  await x.emit("agent_start");
  const replaced = await x.emit("before_provider_request", { payload: anthropicPayload() });
  await x.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage, model: "claude-sonnet-5-5" } });
  await x.emit("agent_end");
  return replaced;
};
export const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
export const settle = () => new Promise((r) => setImmediate(r));
/** Advances mocked timers one second at a time, letting each tick's promises settle. */
export const run = async (t, seconds) => { for (let i = 0; i < seconds; i++) { t.mock.timers.tick(1000); await settle(); await settle(); } };
