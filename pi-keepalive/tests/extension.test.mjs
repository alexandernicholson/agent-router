import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendKeepalive } from "../lib/transport.ts";
import { anthropicPayload, source } from "./helpers.mjs";

async function load(t, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-keepalive-ext-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  Object.assign(process.env, { PI_KEEPALIVE_DIR: dir, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", PI_KEEPALIVE_UPKEEP: "warm", PI_KEEPALIVE_LIMIT: "2" }, env);
  t.after(() => { for (const k of Object.keys(env)) delete process.env[k]; for (const k of ["PI_KEEPALIVE_DIR", "PI_KEEPALIVE_UPKEEP", "PI_KEEPALIVE_LIMIT", "PI_KEEPALIVE", "PI_KEEPALIVE_TRANSPORT"]) delete process.env[k]; });
  const mod = await import(`../index.ts?${Math.random()}`);
  const handlers = {};
  const commands = {};
  const pi = { on: (e, h) => (handlers[e] ||= []).push(h), registerCommand: (n, o) => (commands[n] = o) };
  mod.default(pi);
  const ui = { status: [], widgets: [], notes: [], setStatus: (k, v) => ui.status.push(v), setWidget: (k, v) => ui.widgets.push(v), notify: (m) => ui.notes.push(m), select: async (_t, o) => o[0], input: async () => "9" };
  const compactions = [];
  const ctx = {
    model: { id: "claude-sonnet-5-5", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.anthropic.com" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test" }) },
    sessionManager: { getSessionId: () => "sess-1" }, ui, isIdle: () => true,
    compact: (o) => { compactions.push(o); o.onComplete({ usage: { cacheWrite: 7, input: 1, output: 2 }, tokensBefore: 3000 }); },
  };
  const emit = async (e, ev = {}) => { let out; for (const h of handlers[e] ?? []) out = (await h(ev, ctx)) ?? out; return out; };
  return { emit, ctx, ui, commands, handlers, compactions };
}
const turn = async (x, usage = { cacheRead: 0, cacheWrite: 5000, input: 10, output: 1 }) => {
  await x.emit("agent_start");
  const replaced = await x.emit("before_provider_request", { payload: anthropicPayload() });
  await x.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage, model: "claude-sonnet-5-5" } });
  await x.emit("agent_end");
  return replaced;
};
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const run = async (t, seconds) => { for (let i = 0; i < seconds; i++) { t.mock.timers.tick(1000); await settle(); await settle(); } };
const settle = () => new Promise((r) => setImmediate(r));

test("loads, shows a status line and a built-in warmer override only while managing", async (t) => {
  const x = await load(t);
  await x.emit("session_start");
  assert.match(x.ui.notes.join("\n"), /prompt-cache bar/);
  assert.equal(await x.emit("cache_warming_decision"), undefined);
  await turn(x);
  assert.match(strip(x.ui.status.at(-1)), /^\[ ● \] ⬥ warm TTL 5m/);
  assert.deepEqual(await x.emit("cache_warming_decision"), { action: "stop" });
  await x.emit("session_shutdown");
  assert.equal(x.ui.status.at(-1), undefined);
});

test("PI_KEEPALIVE=0 disables everything", async (t) => {
  const x = await load(t, { PI_KEEPALIVE: "0" });
  assert.deepEqual(Object.keys(x.handlers), []);
});

test("the chosen TTL rewrites the real request; model_select forgets the replay source; events without a session are ignored", async (t) => {
  const x = await load(t);
  assert.equal(await x.emit("before_provider_request", { payload: {} }), undefined, "no session yet");
  await x.emit("session_start");
  await x.commands.keepalive.handler("ttl 1h", x.ctx);
  const replaced = await turn(x);
  assert.equal(replaced.system[0].cache_control.ttl, "1h");
  assert.equal((await turn(x)).system[0].cache_control.ttl, "1h");
  assert.deepEqual(await x.emit("cache_warming_decision"), { action: "stop" });
  await x.emit("model_select");
  assert.equal(await x.emit("message_end", { message: { role: "user" } }), undefined);
  await x.emit("agent_start");
});

test("a failed or aborted request records nothing; compaction events are recorded unless we caused them", async (t) => {
  const x = await load(t);
  await x.emit("session_start");
  await x.emit("agent_start");
  await x.emit("before_provider_request", { payload: anthropicPayload() });
  await x.emit("message_end", { message: { role: "assistant", stopReason: "error", usage: { cacheWrite: 5 } } });
  await x.emit("session_compact", { compactionEntry: { usage: { cacheWrite: 3, input: 1, output: 1 }, tokensBefore: 900 } });
  assert.match(x.ui.status.at(-1), /cmpt ✓/);
  await x.emit("session_compact", { compactionEntry: {} });
  await x.emit("session_switch");
  await x.emit("session_branch");
});

test("slash commands: status, upkeep, ttl, set, settings, dashboard, requests, close, off/on", async (t) => {
  const x = await load(t);
  const run = (a) => x.commands.keepalive.handler(a, x.ctx);
  await run("status");
  assert.match(x.ui.notes.at(-1), /Keepalive is not active/);
  await x.emit("session_start");
  await turn(x);
  await run("");
  assert.match(x.ui.notes.at(-1), /^keepalive v0\.3\.1\n\[ ● \]/);
  await run("upkeep compact");
  assert.match(x.ui.notes.at(-1), /upkeep: compact/);
  await run("upkeep");
  assert.match(x.ui.notes.at(-1), /upkeep: warmcomp/);
  await run("ttl");
  assert.match(x.ui.notes.at(-1), /TTL: 1h/);
  await run("ttl 5m");
  assert.match(x.ui.notes.at(-1), /TTL: 5m/);
  await run("set keepalive_limit 4");
  assert.match(x.ui.notes.at(-1), /keepalive_limit = 4/);
  await run("set unreported_ttl 7m");
  assert.match(x.ui.notes.at(-1), /takes off, 5m, 15m/);
  await run("set unreported_ttl 15M");
  assert.match(x.ui.notes.at(-1), /unreported_ttl = 15M/);
  await run("set unreported_ttl_models kimi*=15m, glm-5.3=off");
  assert.match(x.ui.notes.at(-1), /unreported_ttl_models = kimi\*=15m, glm-5\.3=off/);
  await run("set nope 1");
  assert.match(x.ui.notes.at(-1), /Unknown setting/);
  await run("settings");
  assert.match(x.ui.notes.at(-1), /ttl = default/);
  const choose = async (title, options) => (title === "Keepalive settings" ? options[3] : options[1]);
  x.ctx.ui.select = choose;
  await run("settings");
  x.ctx.ui.select = async (title, o) => (title === "Keepalive settings" ? o[2] : "banana");
  await run("settings");
  x.ctx.ui.select = async (title, o) => (title === "Keepalive settings" ? o[4] : undefined);
  await run("settings");
  x.ctx.ui.select = async () => undefined;
  await run("settings");
  await run("dashboard");
  assert.match(x.ui.widgets.at(-1).join("\n"), /Prompt cache/);
  await run("requests misses");
  assert.match(x.ui.widgets.at(-1).join("\n"), /last 30 misses/);
  await run("close");
  assert.equal(x.ui.widgets.at(-1), undefined);
  await run("off");
  assert.equal(x.ui.status.at(-1), undefined);
  assert.equal(await x.emit("cache_warming_decision"), undefined);
  await run("on");
  assert.match(x.ui.status.at(-1), /TTL/);
});

test("the keepalive timer sends a marked request through the fetch fallback with the session's auth and base URL", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ usage: { cache_read_input_tokens: 5000, input_tokens: 9, output_tokens: 1 } }) };
  });
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 5_000_000 });
  const x = await load(t, { PI_KEEPALIVE_E2E: "1", PI_KEEPALIVE_E2E_TTL_MS: "20000" });
  await x.emit("session_start");
  await x.emit("before_provider_headers", { headers: { "x-extra": "1", "content-length": "9", n: 3 } });
  await turn(x);
  await run(t, 19); // time dilation: a 20s TTL stands for 5m, so the last 30s are the last 2s
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].init.headers["x-api-key"], "sk-test");
  assert.equal(calls[0].init.headers["x-extra"], "1");
  assert.equal(calls[0].init.headers["content-length"], undefined);
  assert.match(calls[0].body.messages.at(-1).content[0].text, /^<keepalive v="0\.3\.1" src="native"\/> Reply with only: K$/);
  assert.equal(calls[0].body.stream, false);
  await new Promise((r) => setTimeout(r, 150));
  assert.match(x.ui.status.at(-1), /↻1/);
  await x.emit("agent_start");
});

test("compaction upkeep goes through the host's compact()", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 5_000_000 });
  const x = await load(t, { PI_KEEPALIVE_UPKEEP: "compact", PI_KEEPALIVE_COMPACT_THRESHOLD: "1k", PI_KEEPALIVE_E2E: "1", PI_KEEPALIVE_E2E_TTL_MS: "20000" });
  await x.emit("session_start");
  await turn(x);
  const original = x.ctx.compact;
  x.ctx.compact = (o) => { void x.emit("session_compact", { compactionEntry: {} }); original(o); };
  await run(t, 19);
  assert.equal(x.compactions.length, 1);
  assert.match(x.ui.notes.join("\n"), /compacted the conversation/);
  await x.emit("session_compact", { compactionEntry: { usage: { cacheRead: 0, cacheWrite: 1, input: 0, output: 0 } } });
  x.ctx.compact = (o) => o.onError(new Error("nope"));
  const y = await load(t, { PI_KEEPALIVE_UPKEEP: "compact", PI_KEEPALIVE_COMPACT_THRESHOLD: "1k", PI_KEEPALIVE_E2E: "1", PI_KEEPALIVE_E2E_TTL_MS: "20000" });
  y.ctx.compact = (o) => o.onError(new Error("nope"));
  await y.emit("session_start");
  await turn(y);
  await run(t, 19);
  assert.match(y.ui.notes.join("\n") + "|", /^(?!.*compacted)/s);
  const z = await load(t, { PI_KEEPALIVE_UPKEEP: "compact", PI_KEEPALIVE_COMPACT_THRESHOLD: "1k", PI_KEEPALIVE_E2E: "1", PI_KEEPALIVE_E2E_TTL_MS: "20000" });
  z.ctx.compact = () => { throw new Error("sync"); };
  await z.emit("session_start");
  await turn(z);
  await run(t, 19);
  await z.emit("session_shutdown");
});

test("transport: streamSimple path (Pi) swaps the body and reports usage; errors and OMP fallbacks", async () => {
  const sent = [];
  const reg = (result) => ({
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: { h: "1" } }),
    streamSimple: (model, context, options) => { sent.push({ model, context, options }); return { result: async () => result }; },
  });
  const payload = { model: "m", messages: [] };
  const ok = await sendKeepalive({ modelRegistry: reg({ stopReason: "stop", usage: { cacheRead: 9, cacheWrite: 0, input: 1, output: 1, cacheWrite1h: 0 } }) }, source(), payload, new AbortController().signal, "sess", false);
  assert.deepEqual(ok, { answered: true, usage: { read: 9, write: 0, fresh: 1, output: 1, write1h: 0 } });
  assert.equal(sent[0].options.onPayload(), payload);
  assert.equal(sent[0].options.maxTokens, 1);
  assert.equal(sent[0].options.apiKey, "k");
  assert.equal(sent[0].options.sessionId, "sess");
  assert.match(sent[0].context.messages[0].content[0].text, /^<keepalive v=/);
  const bad = await sendKeepalive({ modelRegistry: reg({ stopReason: "error", errorMessage: "boom" }) }, source(), payload, new AbortController().signal, "", false);
  assert.deepEqual(bad, { answered: false, reason: "boom" });
  const aborted = await sendKeepalive({ modelRegistry: reg({ stopReason: "aborted" }) }, source(), payload, new AbortController().signal, "", false);
  assert.equal(aborted.reason, "aborted");
  const noUsage = await sendKeepalive({ modelRegistry: reg({ stopReason: "stop", usage: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 } }) }, source(), payload, new AbortController().signal, "", false);
  assert.equal(noUsage.usage.read, 0);
});

test("transport: fetch fallback covers openai styles, bad responses and registries without auth", async (t) => {
  const seen = [];
  let reply = { ok: true, status: 200, json: async () => ({ usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 8 }, completion_tokens: 1 } }) };
  t.mock.method(globalThis, "fetch", async (url, init) => (seen.push({ url, init }), reply));
  const kimi = source({ api: "openai-completions", baseUrl: "https://gw.example.com/v1", model: "kimi", modelRef: { id: "k", headers: { "x-model": "1" } } });
  const reg = { getApiKeyAndHeaders: async () => "plain-key" };
  const r = await sendKeepalive({ modelRegistry: reg }, kimi, { messages: [], stream_options: {} }, new AbortController().signal, "s1", true);
  assert.deepEqual(r.usage, { read: 8, write: 0, fresh: 2, output: 1 });
  assert.equal(seen[0].url, "https://gw.example.com/v1/chat/completions");
  assert.equal(seen[0].init.headers.authorization, "Bearer plain-key");
  assert.equal(seen[0].init.headers["x-session-affinity"], "s1");
  assert.equal(seen[0].init.headers["x-model"], "1");
  assert.equal(JSON.parse(seen[0].init.body).stream_options, undefined);
  reply = { ok: false, status: 500 };
  assert.deepEqual(await sendKeepalive({ modelRegistry: {} }, kimi, {}, new AbortController().signal, "", true), { answered: false, reason: "HTTP 500" });
  reply = { ok: true, status: 200, json: async () => ({}) };
  assert.deepEqual(await sendKeepalive({ modelRegistry: { getApiKeyAndHeaders: async () => { throw new Error("x"); } } }, kimi, {}, new AbortController().signal, "", true), { answered: false, reason: "no usage" });
  assert.equal(seen.at(-1).init.headers.authorization, undefined);
  await sendKeepalive({ modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false }) } }, source({ modelRef: undefined }), {}, new AbortController().signal, "", true).catch(() => {});
  await sendKeepalive({ modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "a", baseUrl: "https://b.example.com" }) }, model: { id: "m" } }, source({ modelRef: undefined }), {}, new AbortController().signal, "", true).catch(() => {});
  assert.equal(seen.at(-1).url, "https://b.example.com/v1/messages");
  assert.equal(seen.at(-1).init.headers["anthropic-version"], "2023-06-01");
});

test("on a gateway the extension asks the policy with the session's credentials and warms an enabled cohort", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes("/v1/cache/policy")) return { status: 200, text: async () => JSON.stringify({ rows: [{ alias: "kimi-k3", status: "enabled", safe_refresh_s: 20, max_idle_s: 600, upstream_provider: "phala" }] }) };
    return { ok: true, status: 200, json: async () => ({ usage: { prompt_tokens: 5010, prompt_tokens_details: { cached_tokens: 5000 }, completion_tokens: 1 } }) };
  });
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 9_000_000 });
  const x = await load(t, { PI_KEEPALIVE_UPKEEP: "warm" });
  x.ctx.model = { id: "kimi-k3", api: "openai-completions", provider: "gw", baseUrl: "https://gateway.example.com/ai/openai/v1" };
  await x.emit("session_start");
  await x.emit("agent_start");
  await x.emit("before_provider_request", { payload: { model: "kimi-k3", messages: [{ role: "user", content: "hi" }] } });
  await x.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { cacheRead: 0, cacheWrite: 5000, input: 10, output: 1 }, model: "kimi-k3" } });
  await x.emit("agent_end");
  await run(t, 2);
  await new Promise((r) => setTimeout(r, 100));
  const policy = calls.find((c) => String(c.url).includes("/v1/cache/policy"));
  assert.ok(policy, "policy fetched");
  assert.equal(policy.init.headers.authorization, "Bearer sk-test");
  assert.equal(policy.init.redirect, "error");
  assert.deepEqual(await x.emit("cache_warming_decision"), { action: "stop" });
  await run(t, 18);
  await new Promise((r) => setTimeout(r, 100));
  const keepalive = calls.find((c) => String(c.url).endsWith("/chat/completions"));
  assert.ok(keepalive, "keepalive sent to the same base URL");
  assert.match(JSON.parse(keepalive.init.body).messages.at(-1).content, /^<keepalive v="0\.3\.1" src="learned"\/>/);
  x.ctx.modelRegistry.getApiKeyAndHeaders = async () => { throw new Error("no auth"); };
});

test("odd hosts: failing UI, credential errors, our own compaction event, and the TTL toggle back to 5m", async (t) => {
  const x = await load(t);
  x.ctx.ui.setStatus = () => { throw new Error("gone"); };
  await x.emit("session_start");
  await turn(x);
  for (const reply of [async () => { throw new Error("x"); }, async () => "key", async () => ({ ok: false }), async () => ({ ok: true })]) {
    x.ctx.modelRegistry.getApiKeyAndHeaders = reply;
    const gw = await load(t, { PI_KEEPALIVE_UPKEEP: "warm" });
    gw.ctx.model = { id: "kimi", api: "openai-completions", provider: "p", baseUrl: "https://gateway.example.com/v1" };
    gw.ctx.modelRegistry.getApiKeyAndHeaders = reply;
    t.mock.method(globalThis, "fetch", async () => ({ status: 404, text: async () => "" }));
    await gw.emit("session_start");
    await gw.emit("before_provider_request", { payload: { messages: [] } });
    await gw.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { cacheRead: 0, cacheWrite: 50, input: 1, output: 1 }, model: "kimi" } });
    await new Promise((r) => setTimeout(r, 1100));
    t.mock.restoreAll();
  }
  const y = await load(t, { PI_KEEPALIVE_UPKEEP: "off" });
  await y.emit("session_start");
  await y.commands.keepalive.handler("ttl 1h", y.ctx);
  await y.commands.keepalive.handler("ttl", y.ctx);
  assert.match(y.ui.notes.at(-1), /TTL: 5m/);
});
