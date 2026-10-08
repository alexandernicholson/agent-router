// Must equal package.json "version" (asserted in tests). Sent to gateways as the `client` heartbeat, never in a prompt.
export const VERSION = "0.3.2";

/** The exact keepalive prompt: no marker, so a keepalive is indistinguishable from a short user message to every provider. */
export const KEEPALIVE_PROMPT = "Reply with only: K";

export function keepalivePrompt(): string {
  return KEEPALIVE_PROMPT;
}
