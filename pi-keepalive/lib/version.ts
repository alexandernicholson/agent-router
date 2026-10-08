// Must equal package.json "version" (asserted in tests). Sent in the keepalive marker.
export const VERSION = "0.3.1";

/** Exact prompt contract shared with cache-policy gateways and the Claude Code plugin. */
export const KEEPALIVE_PROMPT_TEMPLATE = '<keepalive v="{version}"/> Reply with only: K';

/** `source` is the lifetime source that timed the keepalive: native, learned, documented, default or client. */
export function keepalivePrompt(version: string = VERSION, source?: string): string {
  return KEEPALIVE_PROMPT_TEMPLATE.replace("{version}", version).replace("/>", source ? ` src="${source}"/>` : "/>");
}
