import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { barSpans, lastControl, readControl, ternActive, ternBridge } from "../lib/tern.ts";
import { painter, spans, statusLine } from "../lib/render.ts";
import { load, realRequest, run, source, started, tempRoot, turn } from "./helpers.mjs";

const brief = (list) => list.map((s) => `${s.join ? "+" : ""}${s.text}/${s.tone}`).join(" ");

test("Tern's bar pieces carry the footer bar's information and colours: dial by life, a diamond per mode, grades, flush halves", async (t) => {
  const { panel, state } = await started(t, { set: { upkeep: "warmcomp" } });
  await realRequest(panel, state, source(), { write: 5000, fresh: 10 });
  state.now += 20000;
  await realRequest(panel, state, source(), { read: 3000, write: 2000, fresh: 10 });
  const c = panel.get();
  assert.equal(brief(barSpans(panel, c, "good")),
    "●/life-good ⬥/warm +⬥/compact warmcomp/mode-warmcomp TTL/label 5m/value ▓▓▓/fair +░░░░░░░/dim 29%/fair ✕ 1 prefix/fair ·/sep ◉ ETA ~4:59/good");
  assert.equal(statusLine(panel, c, painter({}, true)), "[ ● ] ⬥⬥ warmcomp TTL 5m ▓▓▓░░░░░░░ 29% ✕ 1 prefix · ◉ ETA ~4:59 · read 3k · write 2k · new 10",
    "the footer bar is unchanged");
  for (const [mode, marks] of [["off", "⬦/dim"], ["warm", "⬥/warm"], ["compact", "⬥/compact"]]) {
    await panel.setUpkeep(mode);
    assert.match(brief(barSpans(panel, c, null)), new RegExp(`^●/life-none ${marks} ${mode}/mode-${mode} `));
  }
  c.available = false;
  assert.match(brief(barSpans(panel, c, "fair")), /·\/sep storage unavailable\/poor$/);
});

test("Tern's bar keeps keepalives left and hides the TTL where the lifetime is not the request's", async (t) => {
  const { panel, state } = await started(t, { set: { upkeep: "warm", keepalive_limit: "3" } });
  await realRequest(panel, state, source(), { write: 5000, fresh: 10 });
  assert.match(brief(barSpans(panel, panel.get(), "good")), / ·\/sep ↻3\/note$/);
  const codex = await started(t);
  const src = source({ api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", model: "gpt-6-luna" });
  await realRequest(codex.panel, codex.state, src, { read: 6000, fresh: 100 });
  const text = brief(barSpans(codex.panel, codex.panel.get(), "good"));
  assert.doesNotMatch(text, /label/);
  assert.match(text, /▣ 26m 59s\/good$/);
});

test("the footer's miss chip keeps its colour and the countdown after it keeps its own", async (t) => {
  const { panel, state } = await started(t);
  await realRequest(panel, state, source(), { write: 5000, fresh: 10 });
  state.now += 20000;
  await realRequest(panel, state, source(), { read: 3000, write: 2000, fresh: 10 });
  const ansi = painter({});
  const line = statusLine(panel, panel.get(), ansi);
  assert.match(line, /\x1b\[38;2;250;223;39m✕ 1 prefix\x1b\[0m · \x1b\[38;2;25;175;254m◉ ETA/, "the separator sits between the two coloured runs, so the countdown keeps its colour");
  assert.deepEqual(spans("a\u0001good\u0002b\u0003c"), [{ text: "a" }, { text: "b", tone: "good" }, { text: "c" }]);
});

const NOW = 5_000_000;

// Tests whose clock is already mocked: a test may load the extension more than once.
const clocked = new WeakSet();
async function inTern(t, env = {}, stale) {
  const tern = await tempRoot(t);
  const command = (value) => { mkdirSync(join(tern, "control"), { recursive: true }); writeFileSync(join(tern, "control", "7.json"), JSON.stringify(value)); };
  if (stale) command(stale);
  if (!clocked.has(t)) { t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW }); clocked.add(t); }
  const x = await load(t, { PI_KEEPALIVE_TERN: "", TERN_PANE: "7", PI_KEEPALIVE_TERN_DIR: tern, ...env });
  const pane = () => JSON.parse(readFileSync(join(tern, "panes", "7.json"), "utf8"));
  const heartbeat = (at) => { mkdirSync(tern, { recursive: true }); writeFileSync(join(tern, "active.json"), JSON.stringify({ at })); };
  return { ...x, tern, pane, heartbeat, command };
}

test("the plugin's data directory: override, TERN_CONFIG_DIR, then each platform's state directory; only in a Tern pane", () => {
  assert.equal(ternBridge({}), undefined);
  assert.equal(ternBridge({ TERN_PANE: "x" }), undefined);
  assert.equal(ternBridge({ TERN_PANE: "3", PI_KEEPALIVE_TERN: "0" }), undefined);
  assert.deepEqual(ternBridge({ TERN_PANE: "3", PI_KEEPALIVE_TERN_DIR: "/d" }), { dir: "/d", pane: "3" });
  assert.equal(ternBridge({ TERN_PANE: "3", TERN_CONFIG_DIR: "/c" }, "darwin", "/h").dir, "/c/plugin-data/keepalive");
  assert.equal(ternBridge({ TERN_PANE: "3" }, "darwin", "/h").dir, "/h/Library/Application Support/Tern/plugin-data/keepalive");
  assert.equal(ternBridge({ TERN_PANE: "3" }, "linux", "/h").dir, "/h/.local/state/tern/plugin-data/keepalive");
  assert.equal(ternBridge({ TERN_PANE: "3", XDG_STATE_HOME: "/s" }, "linux", "/h").dir, "/s/tern/plugin-data/keepalive");
  assert.equal(ternBridge({ TERN_PANE: "3", LOCALAPPDATA: "/l" }, "win32", "/h").dir, "/l/Tern/plugin-data/keepalive");
});

test("heartbeat: live within 20 s either side of now; missing, malformed or old is not", async (t) => {
  const dir = await tempRoot(t);
  const bridge = { dir, pane: "1" };
  assert.equal(ternActive(bridge, 100_000), false);
  assert.equal(ternActive(undefined, 100_000), false);
  writeFileSync(join(dir, "active.json"), "{");
  assert.equal(ternActive(bridge, 100_000), false);
  writeFileSync(join(dir, "active.json"), JSON.stringify({ at: 100 }));
  assert.equal(ternActive(bridge, 120_000), true);
  assert.equal(ternActive(bridge, 121_000), false);
});

test("control: the queued commands newer than the last applied, in order; unknown values are dropped", async (t) => {
  const dir = await tempRoot(t);
  const bridge = { dir, pane: "1" };
  assert.equal(lastControl(bridge), 0);
  assert.deepEqual(readControl(bridge, 0), []);
  mkdirSync(join(dir, "control"));
  const queue = [{ seq: 5, upkeep: "cycle" }, { seq: 3, upkeep: "warm" }, { seq: 4, upkeep: "boil", ttl: "toggle" }, null, { seq: 1.5, ttl: "1h" }];
  writeFileSync(join(dir, "control", "1.json"), JSON.stringify({ seq: 5, queue }));
  assert.deepEqual(readControl(bridge, 3), [{ seq: 4, ttl: "toggle" }, { seq: 5, upkeep: "cycle" }]);
  assert.deepEqual(readControl(bridge, 5), []);
  assert.equal(lastControl(bridge), 5);
  writeFileSync(join(dir, "control", "1.json"), JSON.stringify({ seq: 6, queue: "x" }));
  assert.deepEqual(readControl(bridge, 0), []);
});

test("in a Tern pane the extension publishes the bar and dashboard, hides its footer bar while the plugin runs, and closes on shutdown", async (t) => {
  const x = await inTern(t);
  await x.emit("session_start");
  assert.equal(x.pane().pane, "7");
  assert.equal(x.pane().bar.text, "[ ◌ ] ⬥ warm TTL 5m no observation");
  await turn(x);
  await run(t, 1);
  const snap = x.pane();
  assert.equal(snap.v, 1);
  assert.equal(snap.session, "sess-1");
  assert.equal(snap.at, NOW + 1000);
  assert.deepEqual([snap.bar.upkeep, snap.bar.ttl, snap.bar.percent, snap.bar.grade, snap.bar.life], ["warm", "5m", 0, "poor", "good"]);
  assert.match(snap.bar.text, /^\[ ● \] ⬥ warm TTL 5m ░+ 0% · ◉ ETA ~4:59/);
  assert.equal(brief(snap.bar.spans), "●/life-good ⬥/warm warm/mode-warm TTL/label 5m/value ░░░░░░░░░░/dim 0%/poor ·/sep ◉ ETA ~4:59/good ·/sep ↻2/note");
  assert.equal(snap.dashboard.requests.length, 1);
  assert.deepEqual([snap.dashboard.requests[0].kind, snap.dashboard.requests[0].write], ["real", 5000]);
  assert.deepEqual(snap.dashboard.cells, [{ glyph: "○", tone: "poor" }]);
  assert.match(snap.dashboard.main[0], /warm TTL 5m/);
  assert.ok(snap.rows.some((r) => r.key === "upkeep" && r.choices.includes("warmcomp")));
  assert.match(x.ui.status.at(-1), /TTL 5m/, "no plugin heartbeat: the footer bar stays");

  x.heartbeat(NOW / 1000);
  await run(t, 1);
  assert.equal(x.ui.status.at(-1), undefined, "the plugin draws the bar now");
  assert.match(x.pane().bar.text, /ETA ~4:58/, "the snapshot still updates");
  await run(t, 25);
  assert.match(x.ui.status.at(-1), /TTL 5m/, "a stale heartbeat brings the footer bar back");

  await x.emit("session_shutdown");
  assert.deepEqual([x.pane().enabled, x.pane().bar], [false, null]);
});

test("Tern commands change upkeep and TTL once each, all of a burst arrive, and a reload does not replay old ones", async (t) => {
  const x = await inTern(t, { PI_KEEPALIVE_UPKEEP: "off" }, { seq: 1, queue: [{ seq: 1, upkeep: "warm" }] });
  await x.emit("session_start");
  await run(t, 1);
  assert.equal(x.pane().bar.upkeep, "off", "a command left from before the session started is not replayed");
  x.command({ seq: 3, queue: [{ seq: 1, upkeep: "warm" }, { seq: 2, upkeep: "compact" }, { seq: 3, ttl: "1h" }] });
  await run(t, 1);
  assert.deepEqual([x.pane().bar.upkeep, x.pane().bar.ttl], ["compact", "1h"], "both commands of the burst applied");
  await x.commands.keepalive.handler("upkeep off", x.ctx);
  await run(t, 1);
  assert.equal(x.pane().bar.upkeep, "off", "the same seq is not applied twice");
  x.command({ seq: 4, queue: [{ seq: 4, upkeep: "cycle", ttl: "toggle" }] });
  await run(t, 1);
  assert.deepEqual([x.pane().bar.upkeep, x.pane().bar.ttl], ["warm", "5m"]);
});

test("settings written to disk apply to a running session; /keepalive off publishes an empty pane", async (t) => {
  const x = await inTern(t, { PI_KEEPALIVE_UPKEEP: "compact" });
  await x.emit("session_start");
  await turn(x);
  await run(t, 1);
  assert.match(x.pane().dashboard.upkeep, /100k\+ tokens/);
  writeFileSync(join(x.dir, "settings.json"), JSON.stringify({ compact_threshold: "50k" }));
  await run(t, 1);
  assert.match(x.pane().dashboard.upkeep, /50k\+ tokens/);
  assert.equal(x.pane().settings.compact_threshold, "50k");
  await x.commands.keepalive.handler("off", x.ctx);
  assert.deepEqual([x.pane().enabled, x.pane().bar], [false, null]);
});

test("a subagent's events leave the main session and its pane alone", async (t) => {
  const x = await inTern(t);
  const sub = { ...x.ctx, agent: { kind: "sub", id: "0-Explore", name: "explore", depth: 1 }, sessionManager: { getSessionId: () => "child" } };
  await x.emit("session_start");
  await turn(x);
  await x.emit("session_start", {}, sub);
  await x.emit("model_select", {}, sub);
  await x.emit("agent_start", {}, sub);
  await x.emit("before_provider_headers", { headers: { "x-child": "1" } }, sub);
  await x.emit("before_provider_request", { payload: { messages: [] } }, sub);
  await x.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { cacheRead: 0, cacheWrite: 1, input: 1, output: 1 }, model: "other" } }, sub);
  await x.emit("session_compact", { compactionEntry: { usage: { cacheWrite: 1, input: 0, output: 0 } } }, sub);
  await x.emit("session_shutdown", {}, sub);
  await run(t, 1);
  const snap = x.pane();
  assert.deepEqual([snap.enabled, snap.session, snap.dashboard.requests.length], [true, "sess-1", 1]);
  assert.match(snap.bar.text, /TTL 5m/, "the child's model_select did not drop the main conversation's replay source");
});

test("the dashboard names keepalives, compactions and misses; a compacted cache and a gateway's own lifetime show in the bar", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => ({ usage: { cache_read_input_tokens: 5000, input_tokens: 9, output_tokens: 1 } }) }));
  const x = await inTern(t, { PI_KEEPALIVE_E2E: "1", PI_KEEPALIVE_E2E_TTL_MS: "20000" });
  await x.emit("session_start");
  await turn(x);
  await run(t, 19);
  await new Promise((r) => setTimeout(r, 150));
  await turn(x, { cacheRead: 0, cacheWrite: 5000, input: 10, output: 1 });
  await run(t, 1);
  const kinds = x.pane().dashboard.requests.map((r) => [r.kind, r.miss]);
  assert.deepEqual(kinds, [["real", "prefix changed"], ["keepalive", null], ["real", null]]);
  assert.match(x.pane().dashboard.misses, /1 cache miss/);
  await x.emit("session_compact", { compactionEntry: { usage: { cacheRead: 0, cacheWrite: 900, input: 1, output: 1 }, tokensBefore: 9000 } });
  await run(t, 1);
  assert.equal(x.pane().dashboard.requests[0].kind, "compaction");
  assert.match(x.pane().bar.text, /cmpt ✓/);
  assert.equal(x.pane().bar.percent, 0, "a compacted bar rates the compaction itself");

  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => ({ status: 404, text: async () => "" }));
  const y = await inTern(t, { PI_KEEPALIVE_UNREPORTED_TTL: "15m" });
  y.ctx.model = { id: "kimi-k3", api: "openai-completions", provider: "gw", baseUrl: "https://gateway.example.com/v1" };
  await y.emit("session_start");
  await y.emit("before_provider_request", { payload: { model: "kimi-k3", messages: [] } });
  await y.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { cacheRead: 0, cacheWrite: 5000, input: 10, output: 1 }, model: "kimi-k3" } });
  await run(t, 2);
  await new Promise((r) => setTimeout(r, 50));
  await run(t, 1);
  assert.equal(y.pane().bar.ttl, null, "the client TTL rules this row, so the 5m/1h choice is hidden");
});

test("odd bridges: a shutdown before any session, an unwritable directory, a heartbeat that is not an object", async (t) => {
  const x = await inTern(t);
  await x.emit("session_shutdown");
  assert.deepEqual([x.pane().session, x.pane().bar], ["", null]);
  const file = join(x.tern, "not-a-dir");
  writeFileSync(file, "");
  const y = await inTern(t, { PI_KEEPALIVE_TERN_DIR: file, PI_KEEPALIVE_TRACE: join(x.tern, "trace.jsonl") });
  await y.emit("session_start");
  assert.match(readFileSync(join(x.tern, "trace.jsonl"), "utf8"), /"event":"tern","error"/);
  writeFileSync(join(x.tern, "active.json"), "[1]");
  assert.equal(ternActive({ dir: x.tern, pane: "7" }, NOW), false);
  assert.equal(ternBridge({ TERN_PANE: "3" }, "win32", "/h").dir, "/h/AppData/Local/Tern/plugin-data/keepalive");
});
