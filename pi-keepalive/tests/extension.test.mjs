import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { sendKeepalive } from "../lib/transport.ts";
import { anthropicPayload, load, run, source, strip, turn } from "./helpers.mjs";

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
  assert.match(x.ui.notes.at(-1), /^keepalive v\d+\.\d+\.\d+\n\[ ● \]/);
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
  assert.match(calls[0].body.messages.at(-1).content[0].text, /^Reply with only: K$/);
  assert.equal(calls[0].body.stream, false);
  await new Promise((r) => setTimeout(r, 150));
  assert.match(x.ui.status.at(-1), /↻1/);
  await x.emit("agent_start");
});

test("a request that never gets an answer (an OMP side request) is not replayed and stops holding upkeep off once the agent ends", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ usage: { cache_read_input_tokens: 5000, input_tokens: 9, output_tokens: 1 } }) };
  });
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 5_000_000 });
  const x = await load(t, { PI_KEEPALIVE_E2E: "1", PI_KEEPALIVE_E2E_TTL_MS: "20000" });
  await x.emit("session_start");
  await x.emit("agent_start");
  await x.emit("before_provider_request", { payload: anthropicPayload() });
  await x.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { cacheRead: 0, cacheWrite: 5000, input: 10, output: 1 }, model: "claude-sonnet-5-5" } });
  await x.emit("before_provider_request", { payload: anthropicPayload({ messages: [{ role: "user", content: "<title-request>" }] }) });
  await run(t, 19);
  assert.equal(calls.length, 0, "while the agent runs, the unanswered request still counts as in flight");
  await x.emit("agent_end");
  await run(t, 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 0, "the countdown moved past its window while the agent ran; nothing is sent late");
  await x.emit("agent_start");
  await x.emit("before_provider_request", { payload: anthropicPayload() });
  await x.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { cacheRead: 5000, cacheWrite: 0, input: 10, output: 1 }, model: "claude-sonnet-5-5" } });
  await x.emit("before_provider_request", { payload: anthropicPayload({ messages: [{ role: "user", content: "<title-request>" }] }) });
  await x.emit("agent_end");
  await run(t, 19);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.messages[0].content[0].text, "hi", "the replay is the answered request, not the side request");
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
  assert.match(sent[0].context.messages[0].content[0].text, /^Reply with only: K$/);
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
  reply = { ok: false, status: 400, text: async () => '{"detail":\n  "Unsupported parameter: prompt_cache_retention"}' };
  assert.deepEqual(await sendKeepalive({ modelRegistry: {} }, kimi, {}, new AbortController().signal, "", true),
    { answered: false, reason: 'HTTP 400: {"detail": "Unsupported parameter: prompt_cache_retention"}' }, "the provider's reason, on one line");
  reply = { ok: false, status: 500, text: async () => { throw new Error("reset"); } };
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
  assert.match(policy.url, /&harness=omp$/, "no streamSimple means OMP");
  assert.deepEqual(await x.emit("cache_warming_decision"), { action: "stop" });
  await run(t, 18);
  await new Promise((r) => setTimeout(r, 100));
  const keepalive = calls.find((c) => String(c.url).endsWith("/chat/completions"));
  assert.ok(keepalive, "keepalive sent to the same base URL");
  assert.match(JSON.parse(keepalive.init.body).messages.at(-1).content, /^Reply with only: K$/);
  x.ctx.modelRegistry.getApiKeyAndHeaders = async () => { throw new Error("no auth"); };
});

test("Codex: a documented 30m lifetime renewed by reads, side requests ignored, and keepalives replaying the rebuilt WebSocket conversation over SSE", async (t) => {
  const calls = [];
  const completed = { type: "response.completed", response: { prompt_cache_retention: "24h", usage: { input_tokens: 7201, input_tokens_details: { cached_tokens: 6656, cache_write_tokens: 0 }, output_tokens: 5 } } };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, text: async () => `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n` };
  });
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 9_000_000 });
  const x = await load(t, { PI_KEEPALIVE_UPKEEP: "warm" });
  x.ctx.model = { id: "gpt-6-luna", api: "openai-codex-responses", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" };
  const user = (text) => ({ role: "user", content: [{ type: "input_text", text }] });
  const frame = (extra) => ({ type: "response.create", model: "gpt-6-luna", stream: true, prompt_cache_key: "cache-key-1", store: false, client_metadata: { session_id: "cache-key-1" }, ...extra });
  const answer = (id, text, usage) => x.emit("message_end", { message: { role: "assistant", stopReason: "stop", model: "gpt-6-luna", usage, responseId: id,
    providerPayload: { type: "openaiResponsesHistory", items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] } } });
  // What OMP sends: a full first request, an answer, a title side request that never gets a message, then a WebSocket delta.
  const side = frame({ input: [user("hi"), user("<title-request>")], client_metadata: { session_id: "cache-key-1:side:1" } });
  await x.emit("session_start");
  await x.emit("agent_start");
  assert.equal(await x.emit("before_provider_request", { payload: frame({ input: [user("hi")] }) }), undefined, "the request is never rewritten");
  await answer("resp_1", "OK", { cacheRead: 0, cacheWrite: 0, input: 7192, output: 5 });
  await x.emit("before_provider_request", { payload: side });
  await x.emit("agent_end");
  await x.emit("agent_start");
  assert.equal(await x.emit("before_provider_request", { payload: frame({ input: [user("again")], previous_response_id: "resp_1" }) }), undefined);
  await answer("resp_2", "OK2", { cacheRead: 6656, cacheWrite: 0, input: 545, output: 5 });
  await x.emit("before_provider_request", { payload: { ...side, client_metadata: { session_id: "cache-key-1:side:2" } } });
  await x.emit("agent_end");
  await run(t, 1);
  const bar = strip(x.ui.status.at(-1));
  assert.match(bar, /⬥ warm ▓*█*.* · ▣ 26m 59s/, "the documented lifetime counts down; no 5m/1h TTL is offered");
  assert.doesNotMatch(bar, /TTL 5m/);
  await x.commands.keepalive.handler("dashboard", x.ctx);
  assert.match(strip(x.ui.widgets.at(-1).join("\n")), /▣ 30m · documented by the provider/);
  assert.deepEqual(await x.emit("cache_warming_decision"), { action: "stop" });
  await run(t, 1612);
  assert.equal(calls.length, 0, "nothing before the last 5 s of the lifetime, and no policy request to chatgpt.com");
  await run(t, 5);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1);
  const [keepalive] = calls;
  assert.equal(keepalive.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.deepEqual([keepalive.init.headers.session_id, keepalive.init.headers.conversation_id, keepalive.init.headers.authorization, keepalive.init.headers.accept],
    ["cache-key-1", "cache-key-1", "Bearer sk-test", "text/event-stream"]);
  const body = JSON.parse(keepalive.init.body);
  assert.deepEqual([body.type, body.stream, body.prompt_cache_key, body.previous_response_id], [undefined, true, "cache-key-1", undefined]);
  assert.deepEqual(body.input.map((item) => item.content[0].text), ["hi", "OK", "again", "Reply with only: K"], "the whole conversation, not the delta or the title request");
  await run(t, 1);
  assert.match(strip(x.ui.status.at(-1)), /▣ 26m 5\ds · ↻1/, "the keepalive read the cache, so the lifetime starts again");
  calls.length = 0;
  const codex = source({ api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", model: "gpt-6-luna" });
  assert.equal((await sendKeepalive({}, codex, { input: [], stream: true }, new AbortController().signal, "sess-9", true)).usage.read, 6656);
  assert.equal(calls[0].init.headers.session_id, "sess-9", "a body without prompt_cache_key is routed by the session id");
});

test("the harness is pi when the model registry can stream", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { calls.push({ url, init }); return { status: 404, text: async () => "" }; });
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 9_000_000 });
  const x = await load(t, { PI_KEEPALIVE_UPKEEP: "warm" });
  x.ctx.modelRegistry.streamSimple = () => ({ result: async () => ({ stopReason: "stop", usage: {} }) });
  x.ctx.model = { id: "kimi-k3", api: "openai-completions", provider: "gw", baseUrl: "https://gateway.example.com/ai/openai/v1" };
  await x.emit("session_start");
  await x.emit("agent_start");
  await x.emit("before_provider_request", { payload: { model: "kimi-k3", messages: [{ role: "user", content: "hi" }] } });
  await x.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { cacheRead: 0, cacheWrite: 5000, input: 10, output: 1 }, model: "kimi-k3" } });
  await x.emit("agent_end");
  await run(t, 2);
  await new Promise((r) => setTimeout(r, 100));
  assert.match(calls.find((c) => String(c.url).includes("/v1/cache/policy")).url, /&harness=pi$/);
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

test("OMP usage: the 1h write share comes from cttl.ephemeral1h and the model from upstreamModel", async (t) => {
  const x = await load(t);
  await x.emit("session_start");
  await x.emit("agent_start");
  await x.emit("before_provider_request", { payload: anthropicPayload() });
  await x.emit("message_end", { message: { role: "assistant", stopReason: "stop", model: "claude-sonnet-5-5", upstreamModel: "claude-sonnet-5-5-20261001",
    usage: { cacheRead: 0, cacheWrite: 5000, input: 10, output: 1, cttl: { ephemeral1h: 5000 } } } });
  await x.commands.keepalive.handler("dashboard", x.ctx);
  const shown = strip(x.ui.widgets.at(-1).join("\n"));
  assert.match(shown, /TTL 1h · 5k written · \S+ ~60:00 left/, "the write is booked as 1h although the request asked for the default");
  assert.match(shown, /claude-sonnet-5-5-20261001/);
});

test("OMP usage without the 1h share in cttl books the write as 5m", async (t) => {
  const x = await load(t);
  await x.emit("session_start");
  await x.commands.keepalive.handler("ttl 1h", x.ctx);
  await x.emit("agent_start");
  await x.emit("before_provider_request", { payload: anthropicPayload() });
  await x.emit("message_end", { message: { role: "assistant", stopReason: "stop", model: "claude-sonnet-5-5", usage: { cacheRead: 0, cacheWrite: 800, input: 1, output: 1, cttl: { ephemeral5m: 800 } } } });
  assert.match(strip(x.ui.status.at(-1)), /5m reported/);
});

test("Pi usage: the 1h write share comes from cacheWrite1h", async (t) => {
  const x = await load(t);
  await x.emit("session_start");
  await x.emit("agent_start");
  await x.emit("before_provider_request", { payload: anthropicPayload() });
  await x.emit("message_end", { message: { role: "assistant", stopReason: "stop", model: "claude-sonnet-5-5", usage: { cacheRead: 0, cacheWrite: 900, cacheWrite1h: 900, input: 1, output: 1 } } });
  await x.commands.keepalive.handler("dashboard", x.ctx);
  assert.match(strip(x.ui.widgets.at(-1).join("\n")), /TTL 1h · 900 written/);
});

test("OMP subagent sessions get no keepalive: no status, no TTL rewrite, no warmer override", async (t) => {
  const x = await load(t);
  x.ctx.agent = { kind: "sub", id: "0-Explore", name: "explore", depth: 1 };
  await x.emit("session_start");
  assert.deepEqual(x.ui.status, []);
  assert.equal(await turn(x), undefined);
  assert.equal(await x.emit("cache_warming_decision"), undefined);
});

test("the data directory follows OMP's agent directory", async (t) => {
  const agent = await mkdtemp(join(tmpdir(), "pi-keepalive-agent-"));
  t.after(() => rm(agent, { recursive: true, force: true }));
  const x = await load(t, { PI_KEEPALIVE_DIR: "" }, { pi: { getAgentDir: () => agent } });
  await x.emit("session_start");
  await x.commands.keepalive.handler("set compact_threshold 50k", x.ctx);
  assert.equal(JSON.parse(readFileSync(join(agent, "keepalive", "settings.json"), "utf8")).compact_threshold, "50k");
});

test("an agent directory that cannot be read falls back to the module path", async (t) => {
  const x = await load(t, {}, { pi: { getAgentDir: () => { throw new Error("no profile"); } } });
  await x.emit("session_start");
  assert.match(strip(x.ui.status.at(-1)), /TTL/);
});
