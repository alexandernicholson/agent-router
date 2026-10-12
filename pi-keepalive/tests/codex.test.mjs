import test from "node:test";
import assert from "node:assert/strict";
import { createCodexHistory, sideRequest } from "../lib/codex.ts";
import { buildKeepalivePayload } from "../lib/replay.ts";

const item = (text) => ({ role: "user", content: [{ type: "input_text", text }] });
const answer = (id, ...texts) => ({ responseId: id, providerPayload: { type: "openaiResponsesHistory", items: texts.map((text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] })) } });
const texts = (body) => body.input.map((i) => i.content[0].text);

test("a chain of WebSocket deltas, tool loops included, rebuilds into the full conversation", () => {
  const h = createCodexHistory();
  assert.deepEqual(texts(h.request({ input: [item("a")] })), ["a"]);
  h.response(answer("r1", "A"));
  const second = h.request({ input: [item("b")], previous_response_id: "r1" });
  assert.deepEqual([texts(second), second.previous_response_id], [["a", "A", "b"], undefined]);
  h.response(answer("r2", "B1", "B2"));
  assert.deepEqual(texts(h.request({ input: [item("tool result")], previous_response_id: "r2" })), ["a", "A", "b", "B1", "B2", "tool result"]);
});

test("a delta continuing an unknown response stays as sent, and a keepalive refuses it", () => {
  const h = createCodexHistory();
  const delta = { input: [item("b")], previous_response_id: "r9" };
  assert.equal(h.request(delta), delta);
  h.response(answer("r1", "A"));
  assert.equal(h.request({ input: [item("c")], previous_response_id: "r1" }).previous_response_id, "r1", "no full request was seen, so nothing answers r1");
  assert.deepEqual(buildKeepalivePayload("openai-codex-responses", delta), { ok: false, reason: "conversation started before keepalive loaded" });
});

test("answers without history items, and bodies without input, break the chain safely", () => {
  const h = createCodexHistory();
  h.request({ input: [item("a")] });
  h.response({ responseId: "r1", providerPayload: { type: "other" } });
  assert.equal(h.request({ input: [item("b")], previous_response_id: "r1" }).previous_response_id, "r1");
  const odd = { input: "text" };
  assert.equal(h.request(odd), odd);
  h.response({ responseId: "r2" });
  h.response({});
});

test("side requests are recognised by their client_metadata session id", () => {
  assert.equal(sideRequest({ client_metadata: { session_id: "k:side:1" } }), true);
  assert.equal(sideRequest({ client_metadata: { session_id: "k" } }), false);
  assert.equal(sideRequest({ client_metadata: {} }), false);
  assert.equal(sideRequest({ client_metadata: null }), false);
  assert.equal(sideRequest({}), false);
  assert.equal(sideRequest(null), false);
});
