// Sends the keepalive request through the same provider the session used.
import { anthropicBetas, endpointFor, usageFromBody, usageFromSse, type ReplayApi, type Tokens } from "./replay.ts";
import { keepalivePrompt } from "./version.ts";
import type { ForkResult, Source } from "./panel.ts";

const SKIP_HEADERS = new Set(["content-length", "host", "connection", "accept-encoding", "transfer-encoding"]);
const TIMEOUT_MS = 60000;

async function auth(ctx: any, model: any): Promise<{ apiKey?: string; headers?: Record<string, string>; baseUrl?: string }> {
  const reg = ctx?.modelRegistry;
  try {
    if (typeof reg?.getApiKeyAndHeaders === "function") {
      const r = await reg.getApiKeyAndHeaders(model);
      if (typeof r === "string") return { apiKey: r };
      if (r && r.ok !== false) return { apiKey: r.apiKey, headers: r.headers, baseUrl: r.baseUrl };
    }
  } catch { /* fall through to no auth */ }
  return {};
}

const tokens = (u: any): Tokens & { write1h?: number } => ({ read: u.cacheRead, write: u.cacheWrite, fresh: u.input, output: u.output, write1h: u.cacheWrite1h });

/**
 * Preferred (Pi): the runtime builds auth, URL and session-affinity headers itself; only the body is swapped via onPayload.
 * Fallback (OMP exposes no streaming API to extensions): POST the replayed body to the model's base URL, non-streaming, or for
 * the Codex backend, which only streams, as SSE. Codex routes a request to its cached prefix by the `session_id` header, which
 * OMP sets to the body's `prompt_cache_key`; without it the replay reads nothing.
 */
export async function sendKeepalive(ctx: any, source: Source, payload: Record<string, unknown>, outer: AbortSignal, sessionId: string, forceFetch: boolean, headers?: Record<string, string>): Promise<ForkResult> {
  const model = source.modelRef ?? ctx?.model;
  const signal = AbortSignal.any([outer, AbortSignal.timeout(TIMEOUT_MS)]);
  const a = await auth(ctx, model);
  const reg = ctx?.modelRegistry;
  if (!forceFetch && typeof reg?.streamSimple === "function") {
    const msg = await reg.streamSimple(model, { systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: keepalivePrompt() }], timestamp: Date.now() }] },
      { sessionId: sessionId || undefined, maxTokens: 1, maxRetries: 0, signal, apiKey: a.apiKey, headers: a.headers, onPayload: () => payload }).result();
    if (msg.stopReason === "error" || msg.stopReason === "aborted") return { answered: false, reason: String(msg.errorMessage ?? msg.stopReason) };
    return { answered: true, usage: tokens(msg.usage) };
  }
  const api = source.api as ReplayApi;
  const codex = api === "openai-codex-responses";
  let body = codex ? { ...payload } : ({ ...payload, stream: false } as Record<string, unknown>);
  if (!codex) delete body.stream_options;
  const out: Record<string, string> = { "content-type": "application/json", ...(model?.headers ?? {}), ...(a.headers ?? {}) };
  for (const [k, v] of Object.entries(headers ?? {})) if (!SKIP_HEADERS.has(k.toLowerCase())) out[k] = v;
  if (api === "anthropic-messages") {
    const betas = anthropicBetas(body);
    body = betas.body;
    const given = Object.keys(out).find((k) => k.toLowerCase() === "anthropic-beta");
    const merged = [...new Set([...(given ? out[given].split(",") : []), ...(betas.beta ? betas.beta.split(",") : [])].map((b) => b.trim()).filter(Boolean))];
    if (given) delete out[given];
    if (merged.length) out["anthropic-beta"] = merged.join(",");
  }
  if (a.apiKey) {
    if (api === "anthropic-messages") { out["x-api-key"] = a.apiKey; out["anthropic-version"] = "2023-06-01"; } else out.authorization = `Bearer ${a.apiKey}`;
  }
  if (codex) {
    out.accept = "text/event-stream";
    const key = typeof payload.prompt_cache_key === "string" ? payload.prompt_cache_key : sessionId;
    if (key) { out.session_id = key; out.conversation_id = key; }
  } else if (sessionId) { out["x-session-affinity"] = sessionId; out["x-session-id"] = sessionId; }
  const res = await fetch(endpointFor(api, a.baseUrl ?? source.baseUrl), { method: "POST", headers: out, body: JSON.stringify(body), signal, redirect: "error" });
  if (!res.ok) {
    // The status alone says too little to fix a refused replay; the start of the body names the field or limit.
    const detail = await res.text().then((t) => t.replace(/\s+/g, " ").trim().slice(0, 200), () => "");
    return { answered: false, reason: `HTTP ${res.status}${detail ? `: ${detail}` : ""}` };
  }
  const usage = codex ? usageFromSse(await res.text()) : usageFromBody(api, await res.json());
  return usage ? { answered: true, usage } : { answered: false, reason: "no usage" };
}
