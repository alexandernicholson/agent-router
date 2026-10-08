import test from "node:test";
import assert from "node:assert/strict";
import { createPanel } from "../lib/panel.ts";
import { anthropicPayload, fakeHost, realRequest, settings, source, started } from "./helpers.mjs";

test("a real request is observed, persisted and its TTL derived from the request for claude", async (t) => {
  const { panel, state } = await started(t);
  await realRequest(panel, state, source(), { write: 5000, fresh: 10 });
  const row = panel.mainRow(panel.get());
  assert.equal(row.last.write, 5000);
  assert.equal(row.last.requested, "5m");
  assert.equal(panel.state(panel.get(), row).ttl, "5m");
  await realRequest(panel, state, source(), { read: 5000, fresh: 20 });
  assert.equal(panel.mainRow(panel.get()).recent.length, 2);
  // a fresh panel on the same data directory sees the ledger again (persistence)
  const again = createPanel();
  await again.initialize(panel.get().host, "sess", settings());
  assert.equal(again.mainRow(again.get()).samples.length, 2);
});

test("a 1h request and reported 1h writes show a 1h lifetime", async (t) => {
  const { panel, state } = await started(t);
  const hour = source({ payload: anthropicPayload({ system: [{ type: "text", text: "S", cache_control: { type: "ephemeral", ttl: "1h" } }] }) });
  await realRequest(panel, state, hour, { write: 100 });
  assert.equal(panel.state(panel.get(), panel.mainRow(panel.get())).ttl, "1h");
  await realRequest(panel, state, hour, { write: 100, write1h: 40 });
  assert.equal(panel.state(panel.get(), panel.mainRow(panel.get())).ttl, "5m+1h");
});

test("a non-claude model on a direct provider reports no TTL", async (t) => {
  const { panel, state } = await started(t);
  const kimi = source({ model: "kimi-k3", api: "openai-completions", baseUrl: "https://llm.example.com" });
  await realRequest(panel, state, kimi, { write: 100 });
  assert.equal(panel.state(panel.get(), panel.mainRow(panel.get())).state, "TTL not reported");
  await realRequest(panel, state, { ...kimi, model: "claude-x", api: "openai-completions" }, { write: 100 });
  assert.equal(panel.state(panel.get(), panel.mainRow(panel.get())).state, "TTL not reported");
});

test("a request with no usage ends cleanly; finish without begin is a no-op", async (t) => {
  const { panel, state } = await started(t);
  await panel.finish({ read: 1, write: 0, fresh: 0, output: 0 });
  panel.begin(source());
  await panel.finish(undefined);
  assert.equal(panel.get().pending, undefined);
  assert.equal(panel.mainRow(panel.get()).samples.length, 0);
  assert.equal(state.logs.length, 0);
});

test("model change marks the next request and the status awaits usage", async (t) => {
  const { panel, state } = await started(t);
  await realRequest(panel, state, source(), { write: 5000 });
  const before = state.redraws;
  panel.begin(source({ model: "claude-opus-5-5" }));
  assert.ok(state.redraws > before);
  assert.equal(panel.state(panel.get(), panel.mainRow(panel.get())).state, "model changed · awaiting usage");
  state.now += 600_000;
  await panel.finish({ read: 0, write: 5000, fresh: 5, output: 1, model: "claude-opus-5-5" });
  assert.equal(panel.mainRow(panel.get()).last.miss, "model changed");
});

test("a TTL chosen with the button rewrites cache_control and is remembered per session", async (t) => {
  const { panel, state, host } = await started(t);
  await panel.setTtl("1h");
  const out = panel.begin(source());
  assert.equal(out.system[0].cache_control.ttl, "1h");
  assert.equal(panel.get().pending.requested, "1h");
  await panel.finish(undefined);
  await panel.setTtl("5m");
  assert.equal(panel.begin(source()).system[0].cache_control.ttl, undefined);
  await panel.finish(undefined);
  await panel.setTtl("1h");
  const again = createPanel();
  await again.initialize(host, "sess", settings());
  assert.equal(again.wantedTtl(again.get()), "1h");
  await again.setTtl(undefined);
  assert.equal(again.wantedTtl(again.get()), undefined);
  // non-anthropic APIs are never rewritten
  const other = source({ api: "openai-completions", payload: { messages: [] } });
  assert.equal(again.begin(other), other.payload);
});

test("configured TTL applies until a choice is made", async (t) => {
  const { panel } = await started(t, { set: { ttl: "1h" } });
  assert.equal(panel.wantedTtl(panel.get()), "1h");
  assert.equal(panel.begin(source()).system[0].cache_control.ttl, "1h");
});

test("begin and finish do nothing without a session or while warming", async (t) => {
  const idle = createPanel();
  const payload = {};
  assert.equal(idle.begin({ ...source(), payload }), payload);
  await idle.finish({ read: 1, write: 0, fresh: 0, output: 0 });
  await idle.compacted(1, { ok: true });
  assert.equal(await idle.tick(), false);
  await idle.setUpkeep("warm");
  await idle.cycle();
  await idle.setTtl("1h");
  await idle.introduce(["x"]);
  await idle.refresh();
  assert.equal(idle.managed(), false);
  const { panel } = await started(t);
  panel.get().warming = true;
  const mine = {};
  assert.equal(panel.begin(source({ payload: mine })), mine);
});

test("upkeep mode persists per session and cycles", async (t) => {
  const { panel, state, host } = await started(t);
  await panel.cycle();
  assert.equal(panel.get().upkeep, "warm");
  await panel.cycle();
  await panel.cycle();
  await panel.cycle();
  assert.equal(panel.get().upkeep, "off");
  await panel.setUpkeep("compact");
  const again = createPanel();
  await again.initialize(host, "sess", settings());
  assert.equal(again.get().upkeep, "compact");
  state.kv.set("cache-upkeep", [["sess", "bogus"], "junk"]);
  const third = createPanel();
  await third.initialize(host, "sess", settings({ upkeep: "warm" }));
  assert.equal(third.get().upkeep, "warm");
  host.store.set = async () => { throw new Error("x"); };
  await third.setUpkeep("off");
  assert.match(state.logs.at(-1)[0], /could not be saved/);
});

test("the intro is shown once", async (t) => {
  const { panel, state } = await started(t);
  await panel.introduce(["a", "b"]);
  await panel.introduce(["a", "b"]);
  assert.deepEqual(state.logs.map(([l]) => l), ["a", "b"]);
  state.kv.get = () => { throw new Error("x"); };
  const { host } = await fakeHost(t, { store: { get: async () => { throw new Error("x"); }, set: async () => {} } });
  const other = createPanel();
  await other.initialize(host, "s", settings());
  await other.introduce(["z"]);
});
