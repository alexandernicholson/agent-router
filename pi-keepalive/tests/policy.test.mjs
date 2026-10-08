import test from "node:test";
import assert from "node:assert/strict";
import { createPanel } from "../lib/panel.ts";
import { fakeHost, realRequest, settings, source } from "./helpers.mjs";

const gw = (extra = {}) => source({ model: "kimi-k3", api: "openai-completions", baseUrl: "https://gateway.example.com/ai/openai/v1", payload: { messages: [], model: "kimi-k3" }, ...extra });
const rows = (r = {}) => ({ status: 200, text: JSON.stringify({ rows: [{ alias: "kimi-k3", status: "enabled", safe_refresh_s: 480, max_idle_s: 1500, prefix_bucket: 0, upstream_provider: "phala", ...r }] }) });

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
  assert.match(limited.state.logs.at(-1)[0], /stopped at its limit/);
});

test("other statuses only show; nothing is sent", async (t) => {
  for (const status of ["shadow", "insufficient_data", "demoted", "fixed_window", "native"]) {
    const { panel, state } = await gateway(t, { policy: rows({ status }) });
    await tick(panel, state, 100);
    await tick(panel, state, 478_000);
    assert.equal(state.forks.length, 0, status);
  }
});

test("warmcomp and compact ignore policy rows for compaction; compact mode sends nothing", async (t) => {
  const { panel, state } = await gateway(t, { set: { upkeep: "compact", compact_threshold: "1k" } });
  await tick(panel, state, 100);
  await tick(panel, state, 478_000);
  assert.equal(state.compactions, 0);
  assert.equal(state.forks.length, 0);
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
