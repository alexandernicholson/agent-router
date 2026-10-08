// Settings: defaults < settings.json in the data directory < PI_KEEPALIVE_* environment.
// The same four knobs as the Claude plugin's userConfig (cache_ttl, cache_upkeep, keepalive_limit, compact_threshold).

export const UPKEEP = ["off", "warm", "compact", "warmcomp"] as const;
export type Upkeep = (typeof UPKEEP)[number];
export type Ttl = "5m" | "1h";
const UNITS: Record<string, number> = { "": 1, k: 1000, m: 1000000 };

export const COMPACT_MIN_TOKENS = 100000;

export const ttlOption = (value: unknown): Ttl | undefined => (value === "5m" || value === "1h" ? value : undefined);
export const upkeepMode = (value: unknown): Upkeep | undefined => UPKEEP.find((mode) => mode === value);

/** `infinite` -> Infinity, a whole number -> that number, anything else (incl. `default`) -> undefined = the economic rule. */
export const keepaliveLimit = (value: unknown): number | undefined => {
  const text = String(value).trim().toLowerCase();
  if (text === "infinite") return Infinity;
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : undefined;
};

/** `100k`, `60000`, `1m`; anything else -> undefined (caller uses 100k). */
export const compactThreshold = (value: unknown): number | undefined => {
  const match = /^([1-9]\d*)([km]?)$/.exec(String(value).trim().toLowerCase());
  const tokens = match ? Number(match[1]) * UNITS[match[2]] : NaN;
  return Number.isSafeInteger(tokens) ? tokens : undefined;
};

export interface Settings {
  ttl: string;
  upkeep: string;
  keepalive_limit: string;
  compact_threshold: string;
}

export const DEFAULT_SETTINGS: Settings = { ttl: "default", upkeep: "off", keepalive_limit: "default", compact_threshold: "100k" };

const ENV: Record<keyof Settings, string> = {
  ttl: "PI_KEEPALIVE_TTL", upkeep: "PI_KEEPALIVE_UPKEEP", keepalive_limit: "PI_KEEPALIVE_LIMIT",
  compact_threshold: "PI_KEEPALIVE_COMPACT_THRESHOLD",
};

export function mergeSettings(stored: unknown, env: Record<string, string | undefined>): Settings {
  const file = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(out) as (keyof Settings)[]) {
    const fromFile = file[key];
    if (typeof fromFile === "string") out[key] = fromFile;
    const fromEnv = env[ENV[key]];
    if (fromEnv) out[key] = fromEnv;
  }
  return out;
}

export interface Resolved {
  ttl: Ttl | undefined;
  upkeep: Upkeep;
  limit: number | undefined;
  compactAt: number;
}

export function resolveSettings(s: Settings): Resolved {
  return {
    ttl: ttlOption(s.ttl),
    upkeep: upkeepMode(s.upkeep) ?? "off",
    limit: keepaliveLimit(s.keepalive_limit),
    compactAt: compactThreshold(s.compact_threshold) ?? COMPACT_MIN_TOKENS,
  };
}

/** Rows of `/keepalive settings`: [key, title, choices]. */
export const SETTING_ROWS: [keyof Settings, string, string[]][] = [
  ["ttl", "Prompt cache TTL (Anthropic requests)", ["default", "5m", "1h"]],
  ["upkeep", "Cache upkeep", [...UPKEEP]],
  ["keepalive_limit", "Keepalive limit (default, infinite or a number)", ["default", "infinite", "3", "6", "12", "24"]],
  ["compact_threshold", "Compaction threshold (tokens, e.g. 100k)", ["50k", "100k", "200k", "500k"]],
];
