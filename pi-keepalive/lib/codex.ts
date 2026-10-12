// OMP talks to the ChatGPT Codex backend over a WebSocket. After the first request of a connection it sends only the new
// input items with `previous_response_id`, and the server supplies the rest. The HTTP endpoint a keepalive uses refuses
// `previous_response_id`, so the full body is rebuilt here: the last full input, then that response's output items (OMP hands
// them to `message_end` as `providerPayload.items`), then the new items. That is the prefix the server cached.

type Body = Record<string, unknown>;

/** A request OMP sends for its own UI (a session title): its `client_metadata.session_id` carries `:side:`. */
export function sideRequest(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || !("client_metadata" in payload)) return false;
  const meta = payload.client_metadata;
  const session = meta && typeof meta === "object" && "session_id" in meta ? meta.session_id : undefined;
  return typeof session === "string" && session.includes(":side:");
}

export function createCodexHistory() {
  // The last request's full input, waiting for its response; the last response's id and full context.
  let asked: unknown[] | undefined;
  let answered: { id: string; context: unknown[] } | undefined;

  return {
    /**
     * The body as the HTTP endpoint needs it: a delta joined to the history it continues. A delta that continues a response
     * not seen here (the extension loaded mid-conversation) is returned as sent and cannot be replayed.
     */
    request(payload: Body): Body {
      const input = Array.isArray(payload.input) ? payload.input : undefined;
      const previous = payload.previous_response_id;
      asked = undefined;
      if (!input) return payload;
      if (previous === undefined) {
        asked = input;
        return payload;
      }
      if (previous !== answered?.id) return payload;
      const context = [...answered.context, ...input];
      const full: Body = { ...payload, input: context };
      delete full.previous_response_id;
      asked = context;
      return full;
    },
    /** The assistant message that answered the last request. */
    response(message: { responseId?: unknown; providerPayload?: unknown }): void {
      const items = message.providerPayload && typeof message.providerPayload === "object" && "items" in message.providerPayload ? message.providerPayload.items : undefined;
      answered = asked && typeof message.responseId === "string" && Array.isArray(items) ? { id: message.responseId, context: [...asked, ...items] } : undefined;
      asked = undefined;
    },
  };
}
