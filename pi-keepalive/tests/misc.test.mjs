import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMPACT_MIN_TOKENS, DEFAULT_SETTINGS, SETTING_ROWS, compactThreshold, keepaliveLimit, mergeSettings, resolveSettings, ttlOption, upkeepMode } from "../lib/settings.ts";
import { applyTtl, buildKeepalivePayload, endpointFor, replayApi, requestedTtl, usageFromBody } from "../lib/replay.ts";
import { KEEPALIVE_PROMPT_TEMPLATE, VERSION, keepalivePrompt } from "../lib/version.ts";
import { createStore, dataRoot, readJson, writeJson, trace } from "../lib/storage.ts";
import { tempRoot } from "./helpers.mjs";

test("version matches package.json and the gateway prompt contract", () => {
  assert.equal(VERSION, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.equal(KEEPALIVE_PROMPT_TEMPLATE, '<keepalive v="{version}"/> Reply with only: K');
  assert.equal(keepalivePrompt("1.2.3"), '<keepalive v="1.2.3"/> Reply with only: K');
  assert.match(keepalivePrompt(), /^<keepalive v="[0-9A-Za-z.+-]{1,32}"\/>/);
});

test("settings parse like the Claude plugin's", () => {
  assert.equal(keepaliveLimit("infinite"), Infinity);
  assert.equal(keepaliveLimit(" 12 "), 12);
  for (const bad of ["default", "0", "-3", "1.5", "99999999999999999999", "", undefined]) assert.equal(keepaliveLimit(bad), undefined);
  assert.equal(compactThreshold("60k"), 60000);
  assert.equal(compactThreshold("1M"), 1000000);
  assert.equal(compactThreshold("60000"), 60000);
  for (const bad of ["0", "abc", "1.5k", "", undefined, "99999999999999999999m"]) assert.equal(compactThreshold(bad), undefined);
  assert.equal(ttlOption("1h"), "1h");
  assert.equal(ttlOption("default"), undefined);
  assert.equal(upkeepMode("warmcomp"), "warmcomp");
  assert.equal(upkeepMode("x"), undefined);
  assert.ok(SETTING_ROWS.every(([key]) => key in DEFAULT_SETTINGS));
});

test("settings: defaults < file < environment; resolved values fall back safely", () => {
  assert.deepEqual(mergeSettings(undefined, {}), DEFAULT_SETTINGS);
  assert.deepEqual(mergeSettings([], {}), DEFAULT_SETTINGS);
  const merged = mergeSettings({ ttl: "1h", upkeep: "warm", keepalive_limit: 5, compact_threshold: "50k" }, { PI_KEEPALIVE_UPKEEP: "compact" });
  assert.equal(merged.ttl, "1h");
  assert.equal(merged.upkeep, "compact");
  assert.equal(merged.keepalive_limit, "default");
  const r = resolveSettings(merged);
  assert.deepEqual([r.ttl, r.upkeep, r.limit, r.compactAt], ["1h", "compact", undefined, 50000]);
  const bad = resolveSettings({ ...DEFAULT_SETTINGS, upkeep: "x", compact_threshold: "x" });
  assert.deepEqual([bad.ttl, bad.upkeep, bad.compactAt], [undefined, "off", COMPACT_MIN_TOKENS]);
});

test("replay payloads keep the cached prefix and cap output", () => {
  const p = { model: "m", system: [{ type: "text", text: "S" }], tools: [{ name: "t" }], max_tokens: 8000, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
  const orig = structuredClone(p);
  const r = buildKeepalivePayload("anthropic-messages", p, "9.9.9");
  assert.deepEqual(p, orig);
  assert.deepEqual(r.payload.messages[0], p.messages[0]);
  assert.equal(r.payload.messages.at(-1).content[0].text, '<keepalive v="9.9.9"/> Reply with only: K');
  assert.equal(r.payload.max_tokens, 1);
  assert.deepEqual([r.payload.system, r.payload.tools], [p.system, p.tools]);
  assert.equal(buildKeepalivePayload("anthropic-messages", { messages: [], thinking: { type: "enabled" } }, "1").ok, false);
  assert.equal(buildKeepalivePayload("anthropic-messages", { messages: [], thinking: { type: "adaptive" } }, "1").ok, true);
  assert.equal(buildKeepalivePayload("anthropic-messages", { system: "x" }, "1").ok, false);
  const c = buildKeepalivePayload("openai-completions", { messages: [{ role: "user", content: "a" }], max_completion_tokens: 4000, prompt_cache_key: "k" }, "1");
  assert.equal(c.payload.max_completion_tokens, 1);
  assert.equal(c.payload.prompt_cache_key, "k");
  assert.equal(buildKeepalivePayload("openai-completions", { messages: [], max_tokens: 99 }, "1").payload.max_tokens, 1);
  assert.equal(buildKeepalivePayload("openai-completions", {}, "1").ok, false);
  const r2 = buildKeepalivePayload("openai-responses", { input: [] }, "1");
  assert.equal(r2.payload.max_output_tokens, 16);
  assert.equal(r2.payload.input[0].content[0].type, "input_text");
  assert.equal(buildKeepalivePayload("openai-responses", {}, "1").ok, false);
  assert.equal(buildKeepalivePayload("openai-responses", null, "1").ok, false);
});

test("TTL requested and rewritten through cache_control", () => {
  const five = { system: [{ cache_control: { type: "ephemeral" } }], messages: [{ content: [{ cache_control: { type: "ephemeral" } }, { text: "x" }] }] };
  assert.equal(requestedTtl(five), "5m");
  assert.equal(requestedTtl(null), "5m");
  const hour = applyTtl(five, "1h");
  assert.equal(requestedTtl(hour), "1h");
  assert.equal(five.system[0].cache_control.ttl, undefined, "input untouched");
  assert.equal(applyTtl(hour, "1h"), hour);
  assert.equal(requestedTtl(applyTtl(hour, "5m")), "5m");
  assert.equal(applyTtl(five, "5m"), five);
  assert.equal(applyTtl({ a: 1 }, "1h").a, 1);
  assert.equal(applyTtl(null, "1h"), null);
});

test("usage normalisation to disjoint tokens and endpoints", () => {
  assert.deepEqual(usageFromBody("anthropic-messages", { usage: { cache_read_input_tokens: 7, cache_creation_input_tokens: 1, input_tokens: 2, output_tokens: 3 } }), { read: 7, write: 1, fresh: 2, output: 3 });
  assert.deepEqual(usageFromBody("anthropic-messages", { usage: {} }), { read: 0, write: 0, fresh: 0, output: 0 });
  assert.deepEqual(usageFromBody("openai-completions", { usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 }, completion_tokens: 1 } }), { read: 60, write: 10, fresh: 30, output: 1 });
  assert.deepEqual(usageFromBody("openai-completions", { usage: { prompt_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } }), { read: 2, write: 1, fresh: 2, output: 0 });
  assert.deepEqual(usageFromBody("openai-responses", { usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 40 }, output_tokens: 1 } }), { read: 40, write: 0, fresh: 10, output: 1 });
  assert.equal(usageFromBody("anthropic-messages", {}), null);
  assert.equal(usageFromBody("anthropic-messages", null), null);
  assert.equal(endpointFor("anthropic-messages", "https://p/ai/claude"), "https://p/ai/claude/v1/messages");
  assert.equal(endpointFor("anthropic-messages", "https://p/v1/"), "https://p/v1/messages");
  assert.equal(endpointFor("openai-completions", "https://p/v1"), "https://p/v1/chat/completions");
  assert.equal(endpointFor("openai-responses", "https://p/v1"), "https://p/v1/responses");
  assert.equal(replayApi("google-generative-ai"), null);
  assert.equal(replayApi("openai-responses"), "openai-responses");
});

test("storage: data directory, JSON files and the key/value store", async (t) => {
  assert.equal(dataRoot({ PI_KEEPALIVE_DIR: "/x" }, "file:///a"), "/x");
  assert.match(dataRoot({}, "file:///home/u/.omp/agent/extensions/k/index.ts"), /\.omp\/agent\/keepalive$/);
  assert.match(dataRoot({}, "file:///home/u/.pi/agent/extensions/k/index.ts"), /\.pi\/agent\/keepalive$/);
  const root = await tempRoot(t);
  assert.equal(readJson(`${root}/none.json`), undefined);
  writeJson(root, "a.json", { a: 1 });
  assert.deepEqual(readJson(`${root}/a.json`), { a: 1 });
  const store = createStore(root);
  assert.equal(await store.get("k"), undefined);
  await store.set("k", 1);
  await store.set("j", 2);
  assert.equal(await store.get("k"), 1);
  writeJson(root, "store.json", [1]);
  assert.equal(await store.get("k"), undefined);
});

test("trace appends JSON lines only when asked, and never throws", async (t) => {
  const root = await tempRoot(t);
  trace({}, "x", {});
  trace({ PI_KEEPALIVE_TRACE: `${root}/t.jsonl` }, "a", { b: 1 });
  trace({ PI_KEEPALIVE_TRACE: `${root}/t.jsonl` }, "c", {});
  const lines = readFileSync(`${root}/t.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.event, l.b]), [["a", 1], ["c", undefined]]);
  trace({ PI_KEEPALIVE_TRACE: `${root}/missing/dir/t.jsonl` }, "d", {});
});
