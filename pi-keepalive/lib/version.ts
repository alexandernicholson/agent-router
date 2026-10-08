// Must equal package.json "version" (asserted in tests). Sent in the keepalive marker.
export const VERSION = "0.2.1";

/** Exact prompt contract shared with cache-policy gateways and the Claude Code plugin. */
export const KEEPALIVE_PROMPT_TEMPLATE = '<keepalive v="{version}"/> Reply with only: K';

export function keepalivePrompt(version: string = VERSION): string {
  return KEEPALIVE_PROMPT_TEMPLATE.replace("{version}", version);
}
