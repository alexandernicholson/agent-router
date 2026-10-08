// Sends the keepalive request through the same provider the session used.
import { endpointFor, usageFromBody, type ReplayApi, type Tokens } from "./replay.ts";
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
 * Fallback (OMP exposes no streaming API to extensions): POST the replayed body non-streaming to the model's base URL.
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
  const body = { ...payload, stream: false } as Record<string, unknown>;
  delete body.stream_options;
  const out: Record<string, string> = { "content-type": "application/json", ...(model?.headers ?? {}), ...(a.headers ?? {}) };
  for (const [k, v] of Object.entries(headers ?? {})) if (!SKIP_HEADERS.has(k.toLowerCase())) out[k] = v;
  const api = source.api as ReplayApi;
  if (a.apiKey) {
    if (api === "anthropic-messages") { out["x-api-key"] = a.apiKey; out["anthropic-version"] = "2023-06-01"; } else out.authorization = `Bearer ${a.apiKey}`;
  }
  if (sessionId) { out["x-session-affinity"] = sessionId; out["x-session-id"] = sessionId; }
  const res = await fetch(endpointFor(api, a.baseUrl ?? source.baseUrl), { method: "POST", headers: out, body: JSON.stringify(body), signal, redirect: "error" });
  if (!res.ok) return { answered: false, reason: `HTTP ${res.status}` };
  const usage = usageFromBody(api, await res.json());
  return usage ? { answered: true, usage } : { answered: false, reason: "no usage" };
}
