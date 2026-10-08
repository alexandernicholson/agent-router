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
