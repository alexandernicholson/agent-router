import test from "node:test";
import assert from "node:assert/strict";
import { createPanel } from "../lib/panel.ts";
import { VERSION } from "../lib/version.ts";
import { fakeHost, realRequest, settings, source, started } from "./helpers.mjs";

const TICK = async (panel, state, ms) => { state.now += ms; await panel.tick(); };

async function warmSession(t, set = {}, hostOver = {}) {
  const s = await started(t, { set: { upkeep: "warm", keepalive_limit: "3", ...set }, hostOver });
  await realRequest(s.panel, s.state, s.src, { write: 5000, fresh: 10 });
  return s;
}

test("off sends nothing; switching to warm sends in the last 30s and renews the countdown", async (t) => {
  const s = await started(t);
  await realRequest(s.panel, s.state, s.src, { write: 5000 });
  await TICK(s.panel, s.state, 285_000);
  assert.equal(s.state.forks.length, 0, "off");
  await s.panel.setUpkeep("warm");
  await TICK(s.panel, s.state, 1_000);
  assert.equal(s.state.forks.length, 1);
  assert.ok(s.panel.state(s.panel.get(), s.panel.mainRow(s.panel.get())).leftMs > 250_000, "countdown renewed by the keepalive's cache read");
});

test("warm with a number limit: keepalive has no marker, is counted, then stops at the limit", async (t) => {
  const { panel, state } = await warmSession(t);
  await TICK(panel, state, 250_000);
  assert.equal(state.forks.length, 0);
  await TICK(panel, state, 21_000); // 271s: inside the last 30s
  assert.equal(state.forks.length, 1);
  const sent = state.forks[0].payload;
  assert.equal(sent.messages.at(-1).content[0].text, "Reply with only: K");
  assert.equal(sent.max_tokens, 1);
  assert.equal(panel.mainRow(panel.get()).keepalives.length, 1);
  assert.equal(panel.get().warming, false);
  for (let i = 0; i < 2; i++) { await TICK(panel, state, 271_000); }
  assert.equal(state.forks.length, 3);
  await TICK(panel, state, 271_000);
  assert.equal(state.forks.length, 3, "limit reached");
  assert.match(state.logs.at(-1)[0], /stopped at the keepalive limit of 3/);
  // acting only once per countdown
  await TICK(panel, state, 1000);
  assert.equal(state.forks.length, 3);
});

test("never during a real request or while the host is busy; and not after the model changed", async (t) => {
  const { panel, state } = await warmSession(t);
  state.now += 271_000;
  panel.begin(source());
  await panel.tick();
  assert.equal(state.forks.length, 0, "request in flight");
  await panel.finish({ read: 5000, write: 0, fresh: 10, output: 1 });
  state.busy = true;
  state.now += 271_000;
  await panel.tick();
  assert.equal(state.forks.length, 0, "host busy");
  state.busy = false;
  panel.forget();
  await panel.tick();
  assert.equal(state.forks.length, 0, "nothing to replay after a model change");
});

test("a failed or empty keepalive is logged and not recorded", async (t) => {
  const { panel, state } = await warmSession(t);
  state.forkResult = { answered: false, reason: "HTTP 500" };
  await TICK(panel, state, 271_000);
  assert.match(state.logs.at(-1)[0], /did not answer \(HTTP 500\)/);
  assert.equal(panel.mainRow(panel.get()).keepalives.length, 0);
  state.forkResult = { answered: true, usage: { read: 0, write: 0, fresh: 0, output: 0 } };
  await TICK(panel, state, 271_000);
  assert.equal(panel.mainRow(panel.get()).keepalives.length, 0);
  state.forkResult = null;
  const { host } = await fakeHost(t, { fork: async () => { throw new Error("boom"); } });
  const p2 = createPanel();
  await p2.initialize(host, "e", settings({ upkeep: "warm", keepalive_limit: "2" }));
  p2.begin(source());
  await p2.finish({ read: 0, write: 100, fresh: 0, output: 1 });
  host.now = () => Date.now() + 271_000;
  p2.get().now = 0;
  await p2.tick();
  assert.equal(p2.get().warming, false);
});

test("a keepalive that cannot be built is skipped with a reason", async (t) => {
  const s = await started(t, { set: { upkeep: "warm", keepalive_limit: "3" } });
  const odd = source({ api: null });
  await realRequest(s.panel, s.state, odd, { write: 100 });
  s.panel.get().last = odd;
  await TICK(s.panel, s.state, 271_000);
  assert.equal(s.state.forks.length, 0);
  const pending = createPanel();
  assert.equal(pending.get(), undefined);
});

test("default limit: priced by Anthropic's table, pauses when another keepalive would cost more than a rewrite", async (t) => {
  const { panel, state } = await warmSession(t, { keepalive_limit: "default" });
  await TICK(panel, state, 271_000);
  assert.equal(state.forks.length, 1);
  assert.equal(panel.get().prices.get("claude-sonnet-5-5").settled, true);
  // 11 keepalives at 0.1x per 5m fit a 1.25x rewrite; the 12th does not
  for (let i = 0; i < 30; i++) await TICK(panel, state, 271_000);
  assert.ok(state.forks.length > 5 && state.forks.length < 30, String(state.forks.length));
  assert.match(state.logs.at(-1)[0], /paused; another keepalive would cost more/);
});

test("an unpriced model never warms with the default limit but does with a number", async (t) => {
  const { host, state } = await fakeHost(t);
  const panel = createPanel();
  await panel.initialize(host, "u", settings({ upkeep: "warm" }));
  const kimi = source({ model: "mystery-alias", api: "anthropic-messages", baseUrl: "https://gw.example.com" });
  await realRequest(panel, state, { ...kimi, model: "claude-x-unlisted-99" }, { write: 100 });
  panel.get().last = { ...kimi };
  await TICK(panel, state, 271_000);
  assert.equal(state.forks.length, 0);
  await TICK(panel, state, 1);
  assert.match(state.logs.map(([l]) => l).join("\n"), /no price found|paused/);
  // a failing price lookup is retried later and does not throw
  await panel.lookUpPrices(panel.get(), "x");
});

test("compact mode compacts a conversation over the threshold once per idle stretch and resets the ledger", async (t) => {
  const { panel, state } = await started(t, { set: { upkeep: "compact", compact_threshold: "1k" } });
  await realRequest(panel, state, source(), { write: 5000 });
  await TICK(panel, state, 271_000);
  assert.equal(state.compactions, 1);
  assert.match(state.logs.at(-1)[0], /compacted the conversation/);
  const status = panel.state(panel.get(), panel.mainRow(panel.get()));
  assert.equal(status.state, "compacted");
  assert.deepEqual(status.compacted, { before: 343000, after: 18000 });
  await TICK(panel, state, 271_000);
  assert.equal(state.compactions, 1);
  // below the threshold: left to expire
  const small = await started(t, { set: { upkeep: "compact", compact_threshold: "100k" } });
  await realRequest(small.panel, small.state, source(), { write: 500 });
  await TICK(small.panel, small.state, 271_000);
  assert.equal(small.state.compactions, 0);
});

test("compaction refused or failing is logged, not thrown", async (t) => {
  const { panel, state } = await started(t, { set: { upkeep: "compact", compact_threshold: "1k" } });
  state.compactResult = { ok: false, skip: "too short" };
  await realRequest(panel, state, source(), { write: 5000 });
  await TICK(panel, state, 271_000);
  assert.match(state.logs.at(-1)[0], /compaction skipped: too short/);
  const { host } = await fakeHost(t, { compact: async () => { throw new Error("x"); } });
  const p2 = createPanel();
  await p2.initialize(host, "c", settings({ upkeep: "compact", compact_threshold: "1k" }));
  p2.begin(source());
  await p2.finish({ read: 0, write: 5000, fresh: 0, output: 1 });
  p2.get().now = Date.now();
  host.now = () => Date.now() + 271_000;
  await p2.tick();
  assert.ok(true);
});

test("warmcomp warms to the limit, then compacts; infinite never compacts", async (t) => {
  const { panel, state } = await started(t, { set: { upkeep: "warmcomp", keepalive_limit: "1", compact_threshold: "1k" } });
  await realRequest(panel, state, source(), { write: 5000 });
  await TICK(panel, state, 271_000);
  await TICK(panel, state, 271_000);
  assert.equal(state.forks.length, 1);
  assert.equal(state.compactions, 1);
  const inf = await started(t, { set: { upkeep: "warmcomp", keepalive_limit: "infinite", compact_threshold: "1k" } });
  await realRequest(inf.panel, inf.state, source(), { write: 5000 });
  for (let i = 0; i < 4; i++) await TICK(inf.panel, inf.state, 271_000);
  assert.equal(inf.state.compactions, 0);
  assert.equal(inf.state.forks.length, 4);
});

test("natural compactions are recorded and reset the countdown", async (t) => {
  const { panel, state } = await started(t);
  await realRequest(panel, state, source(), { write: 5000 });
  await panel.compacted(state.now, { ok: true, usage: { read: 0, write: 7, fresh: 1, output: 3 }, tokensBefore: 1000 });
  const row = panel.mainRow(panel.get());
  assert.equal(row.compaction.tokensBefore, 1000);
  assert.equal(row.compaction.tokensAfter, undefined);
  assert.equal(panel.state(panel.get(), row).state, "compacted");
  await panel.compacted(state.now + 1, { ok: true });
  assert.equal(panel.mainRow(panel.get()).totals.requests, 2, "an empty compaction is not counted as a request");
  const none = createPanel();
  await none.initialize((await fakeHost(t)).host, "n", settings());
  await none.compacted(5, { ok: true });
});

test("the e2e time dilation exists only with both test variables", async (t) => {
  const make = async (env) => {
    const { host, state } = await fakeHost(t, { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ...env } });
    const panel = createPanel();
    await panel.initialize(host, "e", settings({ upkeep: "warm", keepalive_limit: "2" }));
    await realRequest(panel, state, source(), { write: 5000 });
    await TICK(panel, state, 17_500);
    return state.forks.length;
  };
  assert.equal(await make({}), 0);
  assert.equal(await make({ PI_KEEPALIVE_E2E_TTL_MS: "20000" }), 0, "ignored without PI_KEEPALIVE_E2E");
  assert.equal(await make({ PI_KEEPALIVE_E2E: "1", PI_KEEPALIVE_E2E_TTL_MS: "20000" }), 1);
});

test("managed: true only while upkeep acts for a session the extension handles", async (t) => {
  const { panel, state } = await started(t);
  assert.equal(panel.managed(), false);
  await realRequest(panel, state, source(), { write: 5000 });
  assert.equal(panel.managed(), false, "upkeep off: built-in stays");
  await panel.setUpkeep("warm");
  assert.equal(panel.managed(), true, "claude native");
  panel.get().last = source({ model: "kimi-k3", api: "openai-completions", baseUrl: "https://llm.example.com" });
  await realRequest(panel, state, panel.get().last, { write: 100 });
  assert.equal(panel.managed(), false, "an unmanaged provider keeps the built-in warmer");
});
