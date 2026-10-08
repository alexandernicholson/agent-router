import test from "node:test";
import assert from "node:assert/strict";
import { createPanel } from "../lib/panel.ts";
import { buildKeepalivePayload } from "../lib/replay.ts";
import { dashboard, keepaliveNote, painter } from "../lib/render.ts";
import { fakeHost, realRequest, settings, source, started } from "./helpers.mjs";

const plain = painter({}, true);

test("a keepalive that cannot be built, or whose request throws, is handled", async (t) => {
  const bad = await started(t, { set: { upkeep: "warm", keepalive_limit: "2" } });
  await realRequest(bad.panel, bad.state, source({ payload: { system: "no messages" } }), { write: 5000 });
  bad.state.now += 271_000;
  await bad.panel.tick();
  assert.match(bad.state.logs.at(-1)[0], /skipped \(no messages\)/);
  assert.equal(bad.state.forks.length, 0);
  assert.equal(buildKeepalivePayload(null, {}, "1").ok, false);

  const boom = await started(t, { set: { upkeep: "warm", keepalive_limit: "2" }, hostOver: { fork: async () => { throw new Error("x"); } } });
  await realRequest(boom.panel, boom.state, source(), { write: 5000 });
  boom.state.now += 271_000;
  await boom.panel.tick();
  assert.match(boom.state.logs.at(-1)[0], /did not answer \(request failed\)/);
  assert.equal(boom.panel.get().warming, false);
});

test("a compaction that throws is logged", async (t) => {
  const s = await started(t, { set: { upkeep: "compact", compact_threshold: "1k" }, hostOver: { compact: async () => { throw new Error("x"); } } });
  await realRequest(s.panel, s.state, source(), { write: 5000 });
  s.state.now += 271_000;
  await s.panel.tick();
  assert.match(s.state.logs.at(-1)[0], /could not run during a turn/);
});

test("price lookups refresh stale entries and keep old prices when a refresh fails", async (t) => {
  const { panel, state, host } = await started(t);
  const c = panel.get();
  c.prices.set("claude-sonnet-5-5", { at: -10_000_000, value: null, settled: false });
  await panel.lookUpPrices(c, "claude-sonnet-5-5");
  assert.equal(c.prices.get("claude-sonnet-5-5").settled, true);
  assert.ok(c.prices.get("claude-sonnet-5-5").value.read > 0);
  c.prices.set("claude-sonnet-5-5", { at: -10_000_000, value: { read: 0.1, output: 5 }, settled: true });
  host.root = "";
  await panel.lookUpPrices(c, "claude-sonnet-5-5");
  assert.equal(c.prices.get("claude-sonnet-5-5").lookup, undefined);
  assert.deepEqual(c.prices.get("claude-sonnet-5-5").value, { read: 0.1, output: 5 });
  void state;
});

test("gateway rows with the default keepalive limit look prices up and keep warming while worthwhile", async (t) => {
  const { host, state } = await fakeHost(t);
  state.policy = { status: 200, text: JSON.stringify({ rows: [{ alias: "claude-gw", status: "enabled", safe_refresh_s: 100, max_idle_s: 3000 }] }) };
  const panel = createPanel();
  await panel.initialize(host, "g", settings({ upkeep: "warm" }));
  const gw = source({ model: "claude-gw", api: "openai-completions", baseUrl: "https://gateway.example.com/v1", payload: { messages: [] } });
  await realRequest(panel, state, gw, { write: 20_000 });
  for (let i = 0; i < 3; i++) { state.now += 50_000; await panel.tick(); await new Promise((r) => setImmediate(r)); }
  assert.equal(panel.get().prices.get("claude-gw").settled, true);
  assert.equal(panel.get().prices.get("claude-gw").value, null);
  assert.match(state.logs.map(([l]) => l).join("\n"), /no price found for claude-gw/);
  assert.equal(state.forks.length, 0, "unpriced model, default limit: no keepalive");
  const wc = createPanel();
  const other = await fakeHost(t);
  other.state.policy = state.policy;
  await wc.initialize(other.host, "w", settings({ upkeep: "compact" }));
  await realRequest(wc, other.state, gw, { write: 20_000 });
  other.state.now += 99_000;
  await wc.tick();
  await new Promise((r) => setImmediate(r));
  await wc.tick();
  assert.equal(other.state.forks.length, 0);
});

test("keepalive note is silent when the next keepalive would cost nothing", async (t) => {
  const { panel, state } = await started(t, { set: { upkeep: "warm" } });
  await realRequest(panel, state, source(), { write: 5000 });
  const c = panel.get();
  c.prices.set("claude-sonnet-5-5", { at: 0, value: { read: 0, output: 0 }, settled: true });
  assert.equal(keepaliveNote(panel, c, panel.mainRow(c)), undefined);
});

test("the dashboard counts keepalives sent since the last request", async (t) => {
  const { panel, state } = await started(t, { set: { upkeep: "warm", keepalive_limit: "3" } });
  await realRequest(panel, state, source(), { write: 5000 });
  state.now += 271_000;
  await panel.tick();
  const text = dashboard(panel, panel.get(), plain, "all").join("\n");
  assert.match(text, /1 keepalive since the last request · 2 keepalives left/);
});
