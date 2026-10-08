// Build the keepalive request from the last real provider payload, and read its usage back.
import { keepalivePrompt } from "./version.ts";

export type ReplayApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export function replayApi(api: string | undefined): ReplayApi | null {
  return api === "anthropic-messages" || api === "openai-completions" || api === "openai-responses" ? api : null;
}

type Obj = Record<string, any>;

/**
 * Clone `payload` (the exact body of the last real request) and append the keepalive user message,
 * capping output. Everything before the appended message stays byte-identical so the cached prefix is reused.
 */
export function buildKeepalivePayload(api: ReplayApi | null, payload: unknown, version: string): { ok: true; payload: Obj } | { ok: false; reason: string } {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "no payload" };
  if (!api) return { ok: false, reason: "unsupported API" };
  const p = structuredClone(payload) as Obj;
  const text = keepalivePrompt(version);
  if (api === "anthropic-messages") {
    if (!Array.isArray(p.messages)) return { ok: false, reason: "no messages" };
    // Budget thinking derives budget_tokens from max_tokens, which is part of the cache key.
    if (p.thinking?.type === "enabled") return { ok: false, reason: "budget thinking cannot be replayed" };
    p.messages.push({ role: "user", content: [{ type: "text", text }] });
    p.max_tokens = 1;
  } else if (api === "openai-completions") {
    if (!Array.isArray(p.messages)) return { ok: false, reason: "no messages" };
    p.messages.push({ role: "user", content: text });
    if ("max_tokens" in p) p.max_tokens = 1;
    else p.max_completion_tokens = 1;
  } else {
    if (!Array.isArray(p.input)) return { ok: false, reason: "no input" };
    p.input.push({ role: "user", content: [{ type: "input_text", text }] });
    p.max_output_tokens = 16; // OpenAI rejects smaller values
  }
  return { ok: true, payload: p };
}

const cacheControls = (payload: Obj): Obj[] => {
  const found: Obj[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "cache_control" && child && typeof child === "object") found.push(child as Obj);
      else walk(child);
    }
  };
  walk(payload);
  return found;
};

/** The TTL this request asks Anthropic for: 1h when any cache_control carries ttl "1h". */
export function requestedTtl(payload: unknown): "5m" | "1h" {
  return cacheControls((payload ?? {}) as Obj).some((c) => c.ttl === "1h") ? "1h" : "5m";
}

/** Rewrite every cache_control marker to the chosen TTL; returns the same object when nothing changes. */
export function applyTtl(payload: unknown, ttl: "5m" | "1h"): unknown {
  const marks = cacheControls((payload ?? {}) as Obj);
  if (!marks.length || marks.every((c) => (ttl === "1h" ? c.ttl === "1h" : c.ttl === undefined))) return payload;
  const clone = structuredClone(payload) as Obj;
  for (const mark of cacheControls(clone)) {
    if (ttl === "1h") mark.ttl = "1h";
    else delete mark.ttl;
  }
  return clone;
}

export interface Tokens {
  read: number;
  write: number;
  fresh: number;
  output: number;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Normalise a raw (non-streaming) provider response body to Anthropic-style disjoint tokens. */
export function usageFromBody(api: ReplayApi, body: unknown): Tokens | null {
  const u = (body as Obj | null)?.usage;
  if (!u) return null;
  if (api === "anthropic-messages") {
    return { read: n(u.cache_read_input_tokens), write: n(u.cache_creation_input_tokens), fresh: n(u.input_tokens), output: n(u.output_tokens) };
  }
  if (api === "openai-completions") {
    const read = n(u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens);
    const write = n(u.prompt_tokens_details?.cache_write_tokens ?? u.cache_creation_input_tokens);
    return { read, write, fresh: Math.max(0, n(u.prompt_tokens) - read - write), output: n(u.completion_tokens) };
  }
  const read = n(u.input_tokens_details?.cached_tokens);
  return { read, write: 0, fresh: Math.max(0, n(u.input_tokens) - read), output: n(u.output_tokens) };
}

/** Same URL construction the vendor SDKs use: Anthropic appends /v1/messages, OpenAI appends the route. */
export function endpointFor(api: ReplayApi, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (api === "anthropic-messages") return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  return api === "openai-completions" ? `${base}/chat/completions` : `${base}/responses`;
}
