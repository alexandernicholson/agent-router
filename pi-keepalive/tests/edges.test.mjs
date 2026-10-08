import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanel } from "../lib/panel.ts";
import { dashboard, painter, requestLines } from "../lib/render.ts";
import { anthropicPayload, fakeHost, realRequest, settings, source, started } from "./helpers.mjs";

const plain = painter({}, true);

async function brokenStorage(t, over = {}) {
  const file = join(await mkdtemp(join(tmpdir(), "pk-broken-")), "file");
  await writeFile(file, "x");
  t.after(() => rm(file, { force: true }));
  const { host, state } = await fakeHost(t, { root: join(file, "under"), ...over });
  return { host, state };
}

test("storage that cannot be written degrades: observations stay in memory and are flagged", async (t) => {
  const { host, state } = await brokenStorage(t);
  const panel = createPanel();
  await panel.initialize(host, "b", settings({ upkeep: "compact", compact_threshold: "1k" }));
  assert.equal(panel.get().available, false);
  await realRequest(panel, state, source(), { write: 5000 });
  assert.match(state.logs.map(([l]) => l).join("\n"), /could not be saved/);
  assert.equal(panel.mainRow(panel.get()).last.write, 5000);
  state.now += 271_000;
  await panel.tick();
  assert.equal(state.compactions, 1);
  assert.equal(panel.get().available, false);
  host.root = "";
  await panel.lookUpPrices(panel.get(), "claude-sonnet-5-5");
  assert.equal(panel.get().prices.has("claude-sonnet-5-5"), false, "a failed lookup is forgotten and retried");
  panel.get().prices.set("m", { at: 0, value: { read: 0.1, output: 5 }, settled: true });
  await panel.lookUpPrices(panel.get(), "m");
  assert.equal(panel.get().prices.get("m").lookup, undefined);
  assert.equal(panel.get().prices.get("m").settled, true);
});

test("a replaced session drops late results", async (t) => {
  const { host, state } = await fakeHost(t);
  const panel = createPanel();
  await panel.initialize(host, "one", settings({ upkeep: "warm", keepalive_limit: "2" }));
  await realRequest(panel, state, source(), { write: 5000 });
  host.fork = async () => { await panel.initialize(host, "two", settings()); return { answered: true, usage: { read: 1, write: 0, fresh: 0, output: 0 } }; };
  state.now += 271_000;
  await panel.tick();
  assert.equal(panel.mainRow(panel.get()).keepalives.length, 0);
  const second = createPanel();
  await second.initialize(host, "s", settings({ upkeep: "compact", compact_threshold: "1k" }));
  host.compact = async () => { await second.initialize(host, "t", settings()); return { ok: true }; };
  await realRequest(second, state, source(), { write: 5000 });
  state.now += 271_000;
  await second.tick();
  const third = createPanel();
  await third.initialize(host, "u", settings({ upkeep: "warm", keepalive_limit: "1" }));
  const refreshed = third.refresh();
  await third.initialize(host, "v", settings());
  await refreshed;
  const fourth = createPanel();
  await fourth.initialize(host, "w", settings());
  await realRequest(fourth, state, source(), { write: 100 });
  const done = fourth.finish({ read: 1, write: 0, fresh: 0, output: 0 });
  await done;
});

test("invalid samples are ignored; a lookup in flight is reused", async (t) => {
  const { panel, state } = await started(t);
  panel.begin(source());
  await panel.finish({ read: -1, write: 0, fresh: 0, output: 0 });
  assert.equal(panel.mainRow(panel.get()).samples.length, 0);
  const a = panel.lookUpPrices(panel.get(), "claude-opus-5-5");
  assert.equal(panel.lookUpPrices(panel.get(), "claude-opus-5-5"), a);
  await a;
  assert.equal(panel.lookUpPrices(panel.get(), "claude-opus-5-5"), undefined, "fresh enough");
  void state;
});

test("an unpriced model logs once and keepalives stay off; price present but zero-cost rows say nothing", async (t) => {
  const { panel, state } = await started(t, { set: { upkeep: "warm", unreported_ttl: "5m" } });
  const odd = source({ model: "mystery-alias" });
  await realRequest(panel, state, { ...odd, api: "anthropic-messages" }, { write: 5000 });
  state.now += 271_000;
  await panel.tick();
  assert.match(state.logs.map(([l]) => l).join("\n"), /no price found for mystery-alias/);
  assert.equal(state.forks.length, 0);
});

test("dashboard details: keepalive count line, misses line, settings-sourced TTL, listing without id", async (t) => {
  const { panel, state } = await started(t, { set: { upkeep: "warm", keepalive_limit: "5", ttl: "5m" } });
  const c = panel.get();
  await realRequest(panel, state, source(), { write: 5000 });
  state.now += 271_000;
  await panel.tick();
  await realRequest(panel, state, source(), { read: 100, write: 9000, fresh: 20 }, 400_000);
  c.now = state.now;
  const text = dashboard(panel, c, plain, "all").join("\n");
  assert.match(text, /ttl in \/keepalive settings/);
  assert.match(text, /✕ \d cache miss/);
  c.prices.set("claude-sonnet-5-5", { at: 0, value: { read: 0.1, output: 5 }, settled: true });
  assert.match(dashboard(panel, c, plain, "all").join("\n"), /priced by models\.dev$/m);
  c.prices.set("claude-sonnet-5-5", { at: 0, value: { read: 0.1, output: 5, source: "Anthropic pricing", provider: "anthropic", id: "claude-sonnet-5-5" }, settled: true });
  assert.match(dashboard(panel, c, plain, "all").join("\n"), /priced by Anthropic pricing \(claude-sonnet-5-5\)/);
  const noTtl = await started(t);
  await realRequest(noTtl.panel, noTtl.state, source({ model: "kimi", api: "openai-completions" }), { write: 100 });
  await noTtl.panel.tick();
  assert.match(requestLines(plain, noTtl.panel.mainRow(noTtl.panel.get()), "all").join("\n"), /–/);
  assert.match(dashboard(noTtl.panel, noTtl.panel.get(), plain, "all").join("\n"), /the request's own cache_control/);
  const lifetime = await started(t);
  lifetime.panel.begin(source());
  await lifetime.panel.finish({ read: 0, write: 5000, fresh: 1, output: 1 });
  lifetime.panel.get().samples.clear();
});

test("awaiting-report lifetime is labelled", async (t) => {
  const { panel, state } = await started(t);
  const c = panel.get();
  await realRequest(panel, state, source(), { write: 500 });
  const row = panel.mainRow(c);
  const sample = { ...row.last };
  delete sample.cacheCreation;
  const status = panel.state(c, { ...row, creation: undefined, last: sample, samples: [sample] });
  assert.equal(status.awaiting, true);
  const fake = { ...panel, state: () => ({ ...status, lifetimes: status.lifetimes }) };
  assert.match(dashboard(fake, c, plain, "all").join("\n"), /awaiting report/);
});
