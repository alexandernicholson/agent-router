import test from "node:test";
import assert from "node:assert/strict";
import { matrixLines, dashboard, keepaliveNote, missChip, missLine, painter, lifetimeLine, requestLines, segments, statusLine, upkeepText } from "../lib/render.ts";
import { createPanel } from "../lib/panel.ts";
import { fakeHost, realRequest, settings, source, started } from "./helpers.mjs";

const plain = painter({}, true);
const ansi = painter({ COLORFGBG: "0;15" });
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("no observation, then a warm bar with dial, mode, TTL, hit rate, ETA and counts", async (t) => {
  const { panel, state } = await started(t);
  assert.match(statusLine(panel, panel.get(), plain), /^\[ ◌ \] ⬦ off TTL 5m no observation/);
  await realRequest(panel, state, source(), { write: 5000, fresh: 10 });
  await realRequest(panel, state, source(), { read: 5000, fresh: 20 });
  const line = statusLine(panel, panel.get(), plain);
  assert.match(line, /^\[ ● \] ⬦ off TTL 5m .* \d+% · ◉ ETA ~4:5\d · read 5k · write 0 · new 20$/);
  panel.get().available = false;
  assert.match(statusLine(panel, panel.get(), plain), /storage unavailable$/);
});

test("colours follow the theme and grades; NO_COLOR style is plain", async (t) => {
  const { panel, state } = await started(t);
  await realRequest(panel, state, source(), { read: 5000, fresh: 20 });
  assert.match(statusLine(panel, panel.get(), ansi), /\x1b\[38;2;2;104;208m/); // light good
  assert.match(statusLine(panel, panel.get(), painter({})), /\x1b\[38;2;25;175;254m/); // dark good
  assert.doesNotMatch(statusLine(panel, panel.get(), plain), /\x1b/);
  assert.equal(plain.color("good", ""), "");
  const grades = [[5000, 0, 0, "good"], [3000, 2000, 1000, "fair"], [500, 4000, 4000, "poor"]];
  for (const [read, write, fresh] of grades) {
    const { panel: p, state: s } = await started(t);
    await realRequest(p, s, source(), { read, write, fresh });
    assert.ok(segments(p, p.get(), ansi, p.mainRow(p.get())).includes("\x1b["));
  }
});

test("TTL 1h, reported TTL differing from the request, expired, uncached and awaiting states", async (t) => {
  const { panel, state } = await started(t);
  await panel.setTtl("1h");
  await realRequest(panel, state, source(), { write: 100, write1h: 0 });
  assert.match(strip(statusLine(panel, panel.get(), ansi)), /TTL 1h .* · 5m reported · ◉ ETA/);
  state.now += 400_000;
  await panel.tick();
  assert.match(statusLine(panel, panel.get(), plain), /5m reported · expired/);
  const un = await started(t);
  await realRequest(un.panel, un.state, source(), { fresh: 100 });
  assert.match(statusLine(un.panel, un.panel.get(), plain), /uncached/);
  const cmp = await started(t);
  await realRequest(cmp.panel, cmp.state, source(), { write: 100 });
  await cmp.panel.compacted(cmp.state.now, { ok: true, usage: { read: 0, write: 5, fresh: 0, output: 1 }, tokensBefore: 343000, tokensAfter: 18000 });
  assert.match(statusLine(cmp.panel, cmp.panel.get(), plain), /cmpt ✓ 343k → 18k/);
  await cmp.panel.compacted(cmp.state.now + 1, { ok: true, usage: { read: 0, write: 5, fresh: 0, output: 1 } });
  assert.match(statusLine(cmp.panel, cmp.panel.get(), plain), /cmpt ✓ · read/);
  const awaiting = await started(t);
  awaiting.panel.begin(source());
  assert.match(statusLine(awaiting.panel, awaiting.panel.get(), plain), /no observation/);
});

test("model switch shows awaiting usage and a miss chip with causes, dimmed when stale", async (t) => {
  const { panel, state } = await started(t);
  await realRequest(panel, state, source(), { write: 5000 });
  panel.begin(source({ model: "claude-opus-5-5" }));
  assert.match(statusLine(panel, panel.get(), plain), /model changed · awaiting usage/);
  state.now += 400_000;
  await panel.finish({ read: 0, write: 5000, fresh: 5, output: 1, model: "claude-opus-5-5" });
  await realRequest(panel, state, source(), { read: 1000, write: 8000, fresh: 5 });
  await realRequest(panel, state, source(), { read: 1000, write: 8000, fresh: 5 }, 400_000);
  const c = panel.get();
  c.now = state.now;
  const rows = [panel.mainRow(c)];
  assert.match(missChip(c, plain, rows), /✕ \d model/);
  assert.match(missChip(c, ansi, rows), /\x1b\[38;2;157;88;12m/);
  assert.match(missLine(c, rows), /^✕ \d cache misses in the last 15 min: .* · latest \d+:\d\d ago$/);
  c.now += 600_000;
  assert.match(missChip(c, ansi, rows), /\x1b\[2m✕/);
  c.now += 600_000;
  assert.equal(missChip(c, plain, rows), "");
  assert.equal(missLine(c, rows), undefined);
  const many = { total: 3 };
  assert.ok(many);
});

test("miss chip with more than two causes ends in an ellipsis; one miss is singular", async (t) => {
  const { panel, state } = await started(t);
  const c = panel.get();
  const at = state.now;
  const sample = (miss) => ({ miss, startedAt: at, completedAt: at });
  c.now = at;
  const row = { samples: [sample("prefix changed"), sample("expired"), sample("model changed")] };
  assert.match(missChip(c, plain, [row]), /…$/);
  assert.match(missLine(c, [{ samples: [sample("cache miss")] }]), /1 cache miss in/);
});

test("keepalive note: ↻ counts, ∞, compaction hand-off", async (t) => {
  const s = await started(t, { set: { upkeep: "warm", keepalive_limit: "5", compact_threshold: "1k" } });
  await realRequest(s.panel, s.state, source(), { write: 5000 });
  const row = s.panel.mainRow(s.panel.get());
  assert.equal(keepaliveNote(s.panel, s.panel.get(), row, true), "↻5");
  assert.equal(keepaliveNote(s.panel, s.panel.get(), row), "5 keepalives left");
  assert.match(statusLine(s.panel, s.panel.get(), plain), /↻5/);
  const inf = await started(t, { set: { upkeep: "warm", keepalive_limit: "infinite" } });
  await realRequest(inf.panel, inf.state, source(), { write: 5000 });
  const ir = inf.panel.mainRow(inf.panel.get());
  assert.equal(keepaliveNote(inf.panel, inf.panel.get(), ir, true), "↻∞");
  assert.equal(keepaliveNote(inf.panel, inf.panel.get(), ir), "keepalives until your next request");
  const wc = await started(t, { set: { upkeep: "warmcomp", keepalive_limit: "1", compact_threshold: "1k" } });
  await realRequest(wc.panel, wc.state, source(), { write: 5000 });
  const wr = wc.panel.mainRow(wc.panel.get());
  assert.equal(keepaliveNote(wc.panel, wc.panel.get(), wr, true), "↻1 ➜ cmpt");
  assert.equal(keepaliveNote(wc.panel, wc.panel.get(), wr), "1 keepalive, then compact");
  wc.state.now += 271_000;
  await wc.panel.tick();
  const after = wc.panel.mainRow(wc.panel.get());
  assert.equal(keepaliveNote(wc.panel, wc.panel.get(), after, true), "➜ cmpt");
  assert.equal(keepaliveNote(wc.panel, wc.panel.get(), after), "compact next");
  const off = await started(t);
  await realRequest(off.panel, off.state, source(), { write: 5000 });
  assert.equal(keepaliveNote(off.panel, off.panel.get(), off.panel.mainRow(off.panel.get())), undefined);
  assert.equal(keepaliveNote(s.panel, { ...s.panel.get(), pending: {} }, row), undefined);
  assert.equal(keepaliveNote(s.panel, s.panel.get(), { samples: [], keepalives: [] }), undefined);
  const price = await started(t, { set: { upkeep: "warm" } });
  await realRequest(price.panel, price.state, source(), { write: 5000 });
  assert.equal(keepaliveNote(price.panel, price.panel.get(), price.panel.mainRow(price.panel.get())), undefined, "price lookup not settled yet");
  await price.panel.lookUpPrices(price.panel.get(), "claude-sonnet-5-5");
  assert.match(keepaliveNote(price.panel, price.panel.get(), price.panel.mainRow(price.panel.get()), true), /^↻\d+$/);
  const nopref = await started(t, { set: { upkeep: "warm", keepalive_limit: "3" } });
  const empty = { last: { read: 0, write: 0, fresh: 0, model: "x" }, keepalives: [], samples: [] };
  assert.equal(keepaliveNote(nopref.panel, nopref.panel.get(), empty), undefined);
});

test("upkeep text for every mode and limit", async (t) => {
  const { panel } = await started(t);
  const c = panel.get();
  const text = (upkeep, limit) => { c.upkeep = upkeep; c.settings = { ...c.settings, limit }; return upkeepText(c); };
  assert.match(text("off"), /^off/);
  assert.match(text("warm", undefined), /cost less than rewriting/);
  assert.match(text("warm", Infinity), /until your next request/);
  assert.match(text("warm", 1), /up to 1 keepalive after/);
  assert.match(text("warm", 12), /up to 12 keepalives/);
  assert.match(text("compact", 1), /^compact · compacts an idle conversation of 100k\+/);
  assert.match(text("warmcomp", 3), /then compacts a conversation/);
  assert.match(text("warmcomp", Infinity), /never compacts/);
});

test("dashboard: overview, dots, filters and request history with gaps", async (t) => {
  const { panel, state } = await started(t, { set: { upkeep: "warm", keepalive_limit: "3" } });
  const c = panel.get();
  assert.match(dashboard(panel, c, plain, "all").join("\n"), /No requests yet/);
  assert.match(dashboard(panel, c, plain, "all").join("\n"), /No usage observed in this context/);
  assert.match(dashboard(panel, c, plain, "all").join("\n"), /No requests match these filters/);
  await realRequest(panel, state, source(), { write: 5000, fresh: 10 });
  await realRequest(panel, state, source(), { read: 5000, fresh: 20 }, 12_000);
  state.now += 271_000;
  await panel.tick();
  await panel.compacted(state.now, { ok: true, usage: { read: 0, write: 5, fresh: 0, output: 1 }, tokensBefore: 10, tokensAfter: 5 });
  state.now += 1000;
  await realRequest(panel, state, source(), { read: 100, write: 9000, fresh: 20 }, 400_000);
  c.now = state.now;
  const text = dashboard(panel, c, plain, "all").join("\n");
  assert.match(text, /Prompt cache/);
  assert.match(text, /Now {6}.* over the last 3 requests/);
  assert.match(text, /Session {2}.* over 3 requests · read .* · write .* · new/);
  assert.match(text, /One dot per request, oldest first/);
  assert.match(text, /Upkeep: warm/);
  assert.match(text, /TTL 5m · the request's own cache_control/);
  assert.match(text, /TTL 5m · 9k written · .* left/);
  assert.match(text, /request +hit +TTL +miss +read +write +new +out +model/);
  assert.match(text, /↕ 6m 40s|↕ \d+m \d\ds/);
  assert.match(text, /keepalive/);
  assert.match(text, /compaction/);
  for (const filter of ["real", "keepalives", "compactions", "misses"]) {
    const lines = requestLines(plain, panel.mainRow(c), filter);
    assert.match(lines[0], new RegExp(`last 30 ${filter}`));
  }
  assert.ok(requestLines(plain, panel.mainRow(c), "real").every((l) => !/keepalive {2}/.test(l.slice(0, 11)) || true));
  const shown = dashboard(panel, { ...c, available: false }, plain, "all").join("\n");
  assert.match(shown, /Storage unavailable/);
  c.settings = { ...c.settings, limit: undefined };
  await panel.lookUpPrices(c, "claude-sonnet-5-5");
  c.prices.set("claude-sonnet-5-5", { at: 0, value: null, settled: true });
  assert.match(dashboard(panel, c, plain, "all").join("\n"), /no price found/);
  c.prices.set("claude-sonnet-5-5", { at: 0, value: { read: 0.1, output: 5, source: "models.dev", provider: "acme", id: "m1" }, settled: true });
  assert.match(dashboard(panel, c, plain, "all").join("\n"), /priced by models.dev \(acme\/m1\)/);
  assert.match(dashboard(panel, c, plain, "all", 10).join("\n"), /Prompt cache/);
});

test("the dot matrix keeps the newest four rows and counts the earlier dots", () => {
  const cells = Array.from({ length: 100 }, (_, i) => ({ glyph: "●", tone: i % 2 ? "good" : "quiet", at: i }));
  const lines = matrixLines(plain, [{ samples: cells.map((c, i) => ({ turnId: i % 2 ? `t${i}` : `keepalive:${i}`, index: 0, startedAt: i, read: 5000, write: 0, fresh: 1, output: 1, sessionId: "s", agentId: null })) }], 22);
  assert.match(lines[0], /… 20 earlier/);
  assert.equal(lines.length, 5);
});

test("lifetime line: source, provider, control; native and plain unknown rows have none", async (t) => {
  const { host, state } = await fakeHost(t);
  const panel = createPanel();
  await panel.initialize(host, "p", settings());
  const row = { last: { model: "kimi-k3" } };
  const c = panel.get();
  const fake = (life, served) => ({ lifetime: () => life, policyOf: () => served });
  assert.equal(lifetimeLine(fake({ source: "native" }), c, row), undefined);
  assert.equal(lifetimeLine(fake({ source: "unknown" }), c, row), undefined);
  assert.equal(lifetimeLine(fake({ source: "learned", shownS: 480, controlled: true }), c, row), "✦ 8m · learned by the gateway · server controlled");
  assert.equal(lifetimeLine(fake({ source: "learned", shownS: 480, once: true, controlled: true }), c, row), "✦ 8m · once · learned by the gateway · server controlled");
  assert.equal(lifetimeLine(fake({ source: "client", shownS: 900 }), c, row), "✎ 15m · your TTL setting");
  assert.equal(lifetimeLine(fake({ source: "none" }), c, row), "⊘ no cache · no cache");
  assert.equal(lifetimeLine(fake({ source: "unknown", status: "shadow" }), c, row), "◌ shadow · unknown");
  void state;
});

test("the dashboard legend names the probe icon", async () => {
  const { dashboard, painter } = await import("../lib/render.ts");
  const { createPanel } = await import("../lib/panel.ts");
  const { fakeHost, settings } = await import("./helpers.mjs");
  const { host } = await fakeHost({ after() {} });
  const panel = createPanel();
  await panel.initialize(host, "p", settings());
  assert.match(dashboard(panel, panel.get(), painter({ NO_COLOR: "1" }, false), "all").join("\n"), /⟳ gateway probe/);
});
