import test from "node:test";
import assert from "node:assert/strict";
import { createPanel } from "../lib/panel.ts";
import { dashboard, painter, statusLine } from "../lib/render.ts";
import { fakeHost, realRequest, settings, source } from "./helpers.mjs";

const gw = (extra = {}) => source({ model: "kimi-k3", api: "openai-completions", baseUrl: "https://gateway.example.com/ai/openai/v1", payload: { messages: [], model: "kimi-k3" }, ...extra });
const rows = (r = {}) => ({ status: 200, text: JSON.stringify({ rows: [{ alias: "kimi-k3", status: "enabled", refresh_on_read: true, safe_refresh_s: 480, max_idle_s: 1500, prefix_bucket: 0, upstream_provider: "phala", ...r }] }) });

async function gateway(t, { policy = rows(), set = {} } = {}) {
  const { host, state } = await fakeHost(t);
  state.policy = policy;
  const panel = createPanel();
  await panel.initialize(host, "p", settings({ upkeep: "warm", keepalive_limit: "4", ...set }));
  await realRequest(panel, state, gw(), { write: 20_000 });
  return { panel, state };
}
const tick = async (panel, state, ms) => { state.now += ms; await panel.tick(); await Promise.resolve(); await new Promise((r) => setImmediate(r)); await panel.tick(); };

test("enabled policy: the countdown starts at the last cache-touching request and fires in the last 5s before safe", async (t) => {
  const { panel, state } = await gateway(t);
  await tick(panel, state, 100);
  assert.equal(state.fetches.length, 1);
  assert.match(state.fetches[0].url, /^https:\/\/gateway\.example\.com\/ai\/openai\/v1\/v1\/cache\/policy\?alias=kimi-k3&session=p$/);
  assert.equal(state.fetches[0].init.headers["x-api-key"], "k");
  assert.equal(panel.policyOf(panel.get(), panel.mainRow(panel.get())).status, "enabled");
  await tick(panel, state, 470_000);
  assert.equal(state.forks.length, 0, "before the last 5s");
  await tick(panel, state, 8_000);
  assert.equal(state.forks.length, 1);
  assert.equal(panel.mainRow(panel.get()).keepalives.length, 1);
  await tick(panel, state, 478_000);
  assert.equal(state.forks.length, 2, "renewed by the keepalive's read");
});

test("a missed window is not caught up", async (t) => {
  const { panel, state } = await gateway(t);
  await tick(panel, state, 100);
  await tick(panel, state, 600_000);
  assert.equal(state.forks.length, 0);
});

test("a keepalive that reads nothing does not renew the countdown", async (t) => {
  const { panel, state } = await gateway(t);
  state.forkResult = { answered: true, usage: { read: 0, write: 20_000, fresh: 5, output: 1 } };
  await tick(panel, state, 100);
  await tick(panel, state, 478_000);
  assert.equal(state.forks.length, 1);
  await tick(panel, state, 4_000);
  assert.equal(state.forks.length, 1, "the missed window stays missed");
});

test("stops after the maximum idle time and at the keepalive limit", async (t) => {
  const idle = await gateway(t, { policy: rows({ max_idle_s: 400, safe_refresh_s: 300 }) });
  await tick(idle.panel, idle.state, 100);
  await tick(idle.panel, idle.state, 301_000);
  assert.equal(idle.state.forks.length, 0, "idle limit already reached at the first due time");
  const limited = await gateway(t, { set: { keepalive_limit: "1" } });
  await tick(limited.panel, limited.state, 100);
  await tick(limited.panel, limited.state, 478_000);
  await tick(limited.panel, limited.state, 478_000);
  assert.equal(limited.state.forks.length, 1);
  assert.match(limited.state.logs.at(-1)[0], /not worth its cost or limit/);
});

test("other statuses only show; nothing is sent", async (t) => {
  for (const status of ["shadow", "insufficient_data", "demoted", "fixed_window", "native"]) {
    const { panel, state } = await gateway(t, { policy: rows({ status }) });
    await tick(panel, state, 100);
    await tick(panel, state, 478_000);
    assert.equal(state.forks.length, 0, status);
  }
});

test("compact mode compacts a large conversation on a served lifetime and sends no keepalive", async (t) => {
  const { panel, state } = await gateway(t, { set: { upkeep: "compact", compact_threshold: "1k" } });
  await tick(panel, state, 100);
  await tick(panel, state, 478_000);
  assert.equal(state.compactions, 1);
  assert.equal(state.forks.length, 0);
});

test("warmcomp compacts when the keepalive is not worth it", async (t) => {
  const { panel, state } = await gateway(t, { set: { upkeep: "warmcomp", compact_threshold: "1k", keepalive_limit: "1" } });
  await tick(panel, state, 100);
  await tick(panel, state, 478_000);
  await tick(panel, state, 478_000);
  assert.equal(state.forks.length, 1);
  assert.equal(state.compactions, 1);
});

test("a served p_resume decides by the savings rule", async (t) => {
  const priced = (p) => ({ status: 200, text: JSON.stringify({ rows: [{ alias: "kimi-k3", status: "enabled", refresh_on_read: true, safe_refresh_s: 480, max_idle_s: 1500, prefix_bucket: 0, p_resume: p }] }) });
  for (const [p, sent] of [[0.9, 1], [0.01, 0]]) {
    const { panel, state } = await gateway(t, { policy: priced(p), set: { keepalive_limit: "default" } });
    panel.get().prices.set("kimi-k3", { at: Infinity, value: { read: 0.1, write: 1.25, fiveMinute: 1.25, output: 5 }, settled: true });
    await tick(panel, state, 100);
    await tick(panel, state, 478_000);
    assert.equal(state.forks.length, sent, `p_resume ${p}`);
  }
});

test("the client TTL times keepalives for a model with no served lifetime, tagged src=client", async (t) => {
  for (const [set, expected] of [[{ unreported_ttl: "5m" }, 1], [{ unreported_ttl: "off" }, 0], [{ unreported_ttl: "off", unreported_ttl_models: "kimi*=5m" }, 1], [{ unreported_ttl: "5m", unreported_ttl_models: "kimi*=off" }, 0]]) {
    const { panel, state } = await gateway(t, { policy: { status: 404, text: "" }, set });
    await tick(panel, state, 100);
    await tick(panel, state, 266_000);
    assert.equal(state.forks.length, expected, JSON.stringify(set));
    if (expected) assert.match(state.forks[0].payload.messages.at(-1).content, /^<keepalive v="0\.3\.0" src="client"\/>/);
    assert.equal(panel.managed(), expected === 1);
    if (expected) assert.equal(panel.lifetime(panel.get(), panel.mainRow(panel.get())).source, "client");
  }
});

test("the dashboard shows the lifetime line and the icon legend", async (t) => {
  const { panel, state } = await gateway(t, { policy: rows({ refresh_on_read: true, source: "learned" }) });
  await tick(panel, state, 100);
  const text = dashboard(panel, panel.get(), painter({ NO_COLOR: "1" }, false), "all").join("\n");
  assert.match(text, /✦ 8m · learned by the gateway via phala · server controlled/);
  assert.match(text, /Lifetime icons: ◉/);
});

test("the price feed is asked for with the session's credentials on a gateway base", async (t) => {
  const { panel, state } = await gateway(t, { set: { keepalive_limit: "default" } });
  await tick(panel, state, 100);
  await tick(panel, state, 478_000);
  assert.ok(state.fetches.some((f) => /\/v1\/cache\/policy/.test(f.url)));
});

test("the endpoint missing (404) falls back to native: claude warms natively, others only show", async (t) => {
  const { panel, state } = await gateway(t, { policy: { status: 404, text: "" } });
  await tick(panel, state, 100);
  assert.equal(panel.policyOf(panel.get(), panel.mainRow(panel.get())), undefined);
  await tick(panel, state, 478_000);
  assert.equal(state.forks.length, 0, "no TTL reported for kimi: nothing to count down");
  // claude on a gateway base URL never consults the policy
  const { host, state: s2 } = await fakeHost(t);
  const claude = createPanel();
  await claude.initialize(host, "c", settings({ upkeep: "warm", keepalive_limit: "2" }));
  await realRequest(claude, s2, source({ baseUrl: "https://gateway.example.com/ai/claude" }), { write: 5000 });
  await tick(claude, s2, 271_000);
  assert.equal(s2.fetches.length, 0);
  assert.equal(s2.forks.length, 1);
});

test("the policy is never queried on api.anthropic.com or an unusable base URL; any other host is asked", async (t) => {
  for (const baseUrl of ["https://api.anthropic.com", "http://insecure.example.com/v1", "not a url"]) {
    const { host, state } = await fakeHost(t);
    const panel = createPanel();
    await panel.initialize(host, "x", settings({ upkeep: "warm", keepalive_limit: "2" }));
    await realRequest(panel, state, gw({ baseUrl }), { write: 100 });
    await tick(panel, state, 1000);
    assert.equal(state.fetches.length, 0, baseUrl);
  }
  const { host, state } = await fakeHost(t);
  const panel = createPanel();
  await panel.initialize(host, "x", settings({ upkeep: "warm" }));
  await realRequest(panel, state, gw({ baseUrl: "https://any.example/ai/pi/claude" }), { write: 100 });
  await tick(panel, state, 1000);
  assert.match(state.fetches[0].url, /^https:\/\/any\.example\/ai\/pi\/claude\/v1\/cache\/policy\?/);
  await tick(panel, state, 10_000);
  assert.equal(state.fetches.length, 1, "a failed lookup backs off");
});

test("managed follows the policy: enabled yes, shadow no", async (t) => {
  const on = await gateway(t);
  await tick(on.panel, on.state, 100);
  assert.equal(on.panel.managed(), true);
  const off = await gateway(t, { policy: rows({ status: "shadow" }) });
  await tick(off.panel, off.state, 100);
  assert.equal(off.panel.managed(), false);
});

test("single-shot: without refresh_on_read one keepalive fires, then nothing is chained", async (t) => {
  for (const extra of [{ refresh_on_read: null }, { refresh_on_read: undefined }]) {
    const { panel, state } = await gateway(t, { policy: rows(extra) });
    await tick(panel, state, 100);
    await tick(panel, state, 478_000);
    assert.equal(state.forks.length, 1, "one keepalive at the last 5s before safe");
    await tick(panel, state, 478_000);
    await tick(panel, state, 478_000);
    assert.equal(state.forks.length, 1, "the keepalive's read does not renew the countdown");
  }
});

test("refresh_on_read false fires one keepalive inside the fixed window, then no more", async (t) => {
  const { panel, state } = await gateway(t, { policy: rows({ refresh_on_read: false }) });
  await tick(panel, state, 100);
  await tick(panel, state, 478_000);
  assert.equal(state.forks.length, 1);
  await tick(panel, state, 478_000);
  assert.equal(state.forks.length, 1);
});

test("warmcomp compacts instead of a single keepalive over the threshold; below it sends one; chained still warms", async (t) => {
  for (const [name, policy, set] of [["false", rows({ refresh_on_read: false }), {}], ["null", rows({ refresh_on_read: null }), {}],
    ["client", { status: 404, text: "" }, { unreported_ttl: "5m" }]]) {
    const wait = name === "client" ? 266_000 : 478_000;
    const over = await gateway(t, { policy, set: { upkeep: "warmcomp", compact_threshold: "1k", ...set } });
    await tick(over.panel, over.state, 100);
    await tick(over.panel, over.state, wait);
    assert.equal(over.state.compactions, 1, `${name}: compacts`);
    assert.equal(over.state.forks.length, 0, `${name}: no keepalive`);
    const under = await gateway(t, { policy, set: { upkeep: "warmcomp", compact_threshold: "1m", ...set } });
    await tick(under.panel, under.state, 100);
    await tick(under.panel, under.state, wait);
    assert.equal(under.state.forks.length, 1, `${name}: one keepalive`);
    assert.equal(under.state.compactions, 0);
  }
  const chained = await gateway(t, { set: { upkeep: "warmcomp", compact_threshold: "1k" } });
  await tick(chained.panel, chained.state, 100);
  await tick(chained.panel, chained.state, 478_000);
  assert.equal(chained.state.forks.length, 1);
  assert.equal(chained.state.compactions, 0);
});

test("an unknown or stale answer is not an opinion: no client TTL; a real 404 is", async (t) => {
  const bad = await gateway(t, { policy: { status: 500, text: "" }, set: { unreported_ttl: "5m" } });
  await tick(bad.panel, bad.state, 100);
  await tick(bad.panel, bad.state, 266_000);
  assert.equal(bad.state.forks.length, 0, "answer unknown: monitor only");
  assert.equal(bad.panel.lifetime(bad.panel.get(), bad.panel.mainRow(bad.panel.get())).source, "unknown");
  assert.equal(bad.panel.policyOf(bad.panel.get(), bad.panel.mainRow(bad.panel.get())), undefined);
  const none = await gateway(t, { policy: { status: 404, text: "" }, set: { unreported_ttl: "5m" } });
  await tick(none.panel, none.state, 100);
  assert.equal(none.panel.lifetime(none.panel.get(), none.panel.mainRow(none.panel.get())).source, "client");
});

test("a monitor row is shown as monitor with its reason and never warmed", async (t) => {
  const { panel, state } = await gateway(t, { policy: rows({ status: "monitor", reason: "ttl_too_short" }), set: { unreported_ttl: "5m" } });
  await tick(panel, state, 100);
  await tick(panel, state, 478_000);
  assert.equal(state.forks.length, 0);
  assert.match(statusLine(panel, panel.get(), painter({ NO_COLOR: "1" }, true)), /◌ monitor \(ttl_too_short\)/);
});
