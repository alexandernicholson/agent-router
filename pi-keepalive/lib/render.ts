// Text rendering of the cache bar, dashboard and request history (ANSI, truecolor), ported from cache-panel.ts.
import {
  cacheBar, cacheBarParts, cacheClock, cacheDial, cacheGap, cacheGrade, cachePercent, cacheTokens, isCompaction, isKeepalive, keepalivesLeft,
  lifeGrade, MISS_WINDOW_MS, RATE_REQUESTS, recentMisses, recentUsage, sampleTtl, sessionMatrix, sessionUsage,
} from "./core/cache.js";
import { CACHE_COLORS, themeFamily } from "./core/cache-colors.js";
import { displayText } from "./core/shared/text.js";
import type { Ctx, Panel } from "./panel.ts";

export const REQUEST_FILTERS = ["all", "real", "keepalives", "compactions", "misses"] as const;
export type RequestFilter = (typeof REQUEST_FILTERS)[number];
export const MISS_FRESH_MS = 300000;
const MISS_WORDS: Record<string, string> = { "prefix changed": "prefix", "model changed": "model", "TTL changed": "TTL", expired: "expired", "cache miss": "unknown" };
const MARKERS: Record<string, string[]> = { off: [], warm: ["warm"], compact: ["compact"], warmcomp: ["warm", "compact"] };

const rgb = (hex: string): string => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export function painter(env: Record<string, string | undefined>, plain = false) {
  const family = themeFamily(env.PI_KEEPALIVE_THEME, env.COLORFGBG);
  const palette = CACHE_COLORS[family];
  const color = (name: keyof typeof palette, text: string) => (plain || !text ? text : `${rgb(palette[name])}${text}${RESET}`);
  const dim = (text: string) => (plain || !text ? text : `${DIM}${text}${RESET}`);
  return { color, dim, palette };
}
type Paint = ReturnType<typeof painter>;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function rate(p: Paint, usage: { read: number; write: number; fresh: number } | undefined, width = 10, column = false): string {
  const total = usage ? usage.read + usage.write + usage.fresh : 0;
  const percent = cachePercent(usage);
  const grade = cacheGrade(usage);
  const { fill, empty } = cacheBarParts(total ? usage!.read / total : null, width, grade);
  const label = percent === null ? "n/a" : `${percent}%`;
  const paint = (text: string) => (grade ? p.color(grade, text) : text);
  return paint(fill) + p.dim(empty) + paint(` ${column ? label.padStart(4) : label}`);
}

export function policyText(panel: Panel, c: Ctx, row: any): string | undefined {
  const policy = panel.policyOf(c, row);
  if (!policy?.safe) return undefined;
  const [minutes, seconds] = [Math.floor(policy.safe / 60), policy.safe % 60];
  const safe = minutes ? `${minutes}m${seconds ? ` ${seconds}s` : ""}` : `${seconds}s`;
  return `${row.last.model}${policy.provider ? ` via ${policy.provider}` : ""} · safe ${safe} · ${policy.status.replace("_", " ")}`;
}

export function segments(panel: Panel, c: Ctx, p: Paint, row: any): string {
  const status = panel.state(c, row);
  const result = rate(p, status.state === "compacted" ? status.sample : (recentUsage(row) ?? status.sample));
  if (status.state === "compacted") {
    const { before, after } = status.compacted!;
    return `${result} · cmpt ✓${before !== undefined && after !== undefined ? ` ${cacheTokens(before)} → ${cacheTokens(after)}` : ""}`;
  }
  if (!status.ttl) return `${result} · ${policyText(panel, c, row) ?? status.state}`;
  const wanted = panel.wantedTtl(c);
  const reported = wanted && status.ttl !== wanted ? ` · ${status.ttl} reported` : "";
  const life = lifeGrade(status.leftMs);
  return `${result}${reported}${status.leftMs && life ? p.color(life, ` · ETA ~${cacheClock(status.leftMs)}`) : p.color("poor", " · expired")}`;
}

export function misses(c: Ctx, rows: any[]) {
  return recentMisses(rows, c.now);
}

export function missChip(c: Ctx, p: Paint, rows: any[]): string {
  const found = misses(c, rows);
  if (!found.total) return "";
  const stale = c.now - found.latest! > MISS_FRESH_MS;
  const label = `${found.total} ${found.causes.slice(0, 2).map(([cause]) => MISS_WORDS[cause]).join("·")}${found.causes.length > 2 ? "…" : ""}`;
  return ` ${stale ? p.dim(`✕ ${label}`) : p.color("fair", `✕ ${label}`)}`;
}

export function missLine(c: Ctx, rows: any[]): string | undefined {
  const found = misses(c, rows);
  if (!found.total) return undefined;
  const causes = found.causes.map(([cause, count]) => `${count} ${cause}`).join(", ");
  return `✕ ${found.total} cache ${found.total === 1 ? "miss" : "misses"} in the last ${MISS_WINDOW_MS / 60000} min: ${causes} · latest ${cacheClock(c.now - found.latest!)} ago`;
}

export function keepaliveNote(panel: Panel, c: Ctx, row: any, short = false): string | undefined {
  if (c.upkeep !== "warm" && c.upkeep !== "warmcomp") return undefined;
  if (!row.last || c.pending) return undefined;
  const status = panel.state(c, row);
  const known = c.prices.get(row.last.model);
  if (!status.ttl || !status.leftMs || (c.settings.limit === undefined && !known?.settled)) return undefined;
  const left = keepalivesLeft(row, known?.value, c.settings.limit);
  if (left === null) return undefined;
  if (left === Infinity) return short ? "↻∞" : "keepalives until your next request";
  const compacts = c.upkeep === "warmcomp" && row.last.read + row.last.write + row.last.fresh >= c.settings.compactAt;
  if (short) return [left || !compacts ? `↻${left}` : "", compacts ? "➜ cmpt" : ""].filter(Boolean).join(" ");
  if (!compacts) return `${plural(left, "keepalive")} left`;
  return left ? `${plural(left, "keepalive")}, then compact` : "compact next";
}

function marker(p: Paint, upkeep: string): string {
  const marks = MARKERS[upkeep];
  return marks.length ? marks.map((name) => p.color(name as "warm" | "compact", "⬥")).join("") : p.dim("⬦");
}

/** The footer line: dial, upkeep mode, TTL, hit-rate bar, ETA or policy text, miss chip, counts. */
export function statusLine(panel: Panel, c: Ctx, p: Paint): string {
  const row = panel.mainRow(c);
  const status = panel.state(c, row);
  const latest = status.sample;
  const note = keepaliveNote(panel, c, row, true);
  const counts = `${note ? ` · ${note}` : ""}${latest ? ` · read ${cacheTokens(latest.read)} · write ${cacheTokens(latest.write)} · new ${cacheTokens(latest.fresh)}` : ""}`;
  const ttl = panel.wantedTtl(c) ?? latest?.requested ?? "5m";
  const parts = row.last || row.compaction ? segments(panel, c, p, row) : "no observation";
  const [head, ...rest] = parts.split(" · ");
  const body = [head + missChip(c, p, [row]), ...rest].join(" · ");
  return `[ ${cacheDial(status)} ] ${marker(p, c.upkeep)} ${c.upkeep} TTL ${ttl} ${body}${counts}${c.available ? "" : " · storage unavailable"}`;
}

export function matrixLines(p: Paint, rows: any[], columns: number): string[] {
  const cells = sessionMatrix(rows);
  const width = Math.max(20, Math.min(80, columns - 2));
  const shown = cells.slice(-width * 4);
  const lines: string[] = [];
  if (cells.length > shown.length) lines.push(p.dim(`… ${cells.length - shown.length} earlier`));
  for (let start = 0; start < shown.length; start += width) {
    lines.push(shown.slice(start, start + width).map((cell) => (cell.tone === "quiet" ? p.dim(cell.glyph) : p.color(cell.tone, cell.glyph))).join(""));
  }
  return lines;
}

function overview(p: Paint, rows: any[], columns: number): string[] {
  const usage = sessionUsage(rows);
  if (!usage) return ["Prompt cache", p.dim("No requests yet. Each request this session gets a dot here.")];
  return [
    "Prompt cache",
    `Now      ${rate(p, usage.recent)}${p.dim(` over the last ${plural(usage.recent.requests, "request")}`)}`,
    `Session  ${rate(p, usage.session)}${p.dim(` over ${plural(usage.session.requests, "request")} · read ${cacheTokens(usage.session.read)} · write ${cacheTokens(usage.session.write)} · new ${cacheTokens(usage.session.fresh)}`)}`,
    ...matrixLines(p, rows, columns),
    p.dim("One dot per request, oldest first: ● good ◐ fair ○ poor ✕ miss · keepalive ◆ compaction"),
  ];
}

const requestName = (s: any) => (isKeepalive(s) ? "keepalive" : isCompaction(s) ? "compaction" : `${displayText(s.turnId, 12)}:${s.index}`);
const wanted = (filter: RequestFilter, s: any) =>
  filter === "all" || (filter === "keepalives" && isKeepalive(s)) || (filter === "compactions" && isCompaction(s)) ||
  (filter === "real" && !isKeepalive(s) && !isCompaction(s)) || (filter === "misses" && !!s.miss);

export function requestLines(p: Paint, row: any, filter: RequestFilter): string[] {
  const samples = row.samples.filter((s: any) => wanted(filter, s)).sort((a: any, b: any) => b.startedAt - a.startedAt || b.index - a.index).slice(0, 30);
  const lines = [`Recent requests (last 30${filter === "all" ? "" : ` ${filter}`})`];
  if (!samples.length) return [...lines, p.dim("No requests match these filters.")];
  const widest = (values: string[], least: number) => Math.max(least, ...values.map((v) => v.length)) + 2;
  const name = widest(samples.map(requestName), 7);
  const ttl = widest(samples.map((s: any) => sampleTtl(s) ?? "–"), 3);
  const miss = widest(samples.map((s: any) => s.miss ?? ""), 4);
  lines.push(p.dim(`${"request".padEnd(name)}${"hit".padEnd(11)}  ${"TTL".padEnd(ttl)}${"miss".padEnd(miss)}${["read", "write", "new", "out"].map((h) => h.padStart(7)).join("")}  model`));
  samples.forEach((s: any, index: number) => {
    if (index) lines.push(p.dim(`↕ ${cacheGap(samples[index - 1].startedAt - s.startedAt)}`));
    const counts = [s.read, s.write, s.fresh, s.output].map((v) => cacheTokens(v).padStart(7)).join("");
    lines.push(`${requestName(s).padEnd(name)}${rate(p, s, 6, true)}  ${(sampleTtl(s) ?? "–").padEnd(ttl)}${(s.miss ?? "").padEnd(miss)}${counts}  ${displayText(s.model, 160)}`);
  });
  return lines;
}

export function upkeepText(c: Ctx): string {
  const limit = c.settings.limit;
  const rule = limit === undefined ? "while keepalives cost less than rewriting the cache" : limit === Infinity ? "until your next request, whatever they cost" : `up to ${plural(limit, "keepalive")} after each request, whatever they cost`;
  const compacts = `compacts a conversation of ${cacheTokens(c.settings.compactAt)}+ tokens 30s before its TTL ends`;
  return {
    off: "off · no requests are sent for upkeep",
    warm: `warm · a keepalive request 30s before the TTL ends, ${rule}`,
    compact: `compact · ${compacts.replace("a conversation", "an idle conversation")}`,
    warmcomp: limit === Infinity ? `warmcomp · keepalives ${rule}, so it never compacts` : `warmcomp · keepalives ${rule}, then ${compacts}`,
  }[c.upkeep]!;
}

function priceNote(c: Ctx, row: any): string {
  const known = row.last && c.prices.get(row.last.model);
  if (!known?.settled) return "";
  if (!known.value) return " · no price found";
  const v = known.value;
  const listing = v.provider && v.id ? ` (${displayText(v.provider === "anthropic" ? v.id : `${v.provider}/${v.id}`, 120)})` : "";
  return ` · priced by ${displayText(v.source ?? "models.dev", 40)}${listing}`;
}

export function dashboard(panel: Panel, c: Ctx, p: Paint, filter: RequestFilter, columns = 100): string[] {
  const row = panel.mainRow(c);
  const status = panel.state(c, row);
  const out = overview(p, [row], columns);
  const line = missLine(c, [row]);
  if (line) out.push(p.color("fair", line));
  if (!c.available) out.push(p.color("fair", "Storage unavailable · showing last known observations"));
  out.push(p.dim(`Upkeep: ${upkeepText(c)}`));
  out.push(p.dim(`Bars show the hit rate over the last ${RATE_REQUESTS} requests, coloured for the context size. Time left counts from the last request that read or wrote the cache.`));
  out.push("", `Main`);
  out.push(`${cacheDial(status)} ${marker(p, c.upkeep)} ${c.upkeep} TTL ${panel.wantedTtl(c) ?? row.last?.requested ?? "5m"} ${segments(panel, c, p, row)}`);
  out.push(p.dim(`TTL ${panel.wantedTtl(c) ?? "5m"} · ${c.ttl ? "chosen with /keepalive ttl" : c.settings.ttl ? "ttl in /keepalive settings" : "the request's own cache_control"}`));
  for (const part of status.lifetimes) {
    out.push(p.color(lifeGrade(part.leftMs)!, `TTL ${part.ttl} · ${cacheTokens(part.tokens)} written · ${cacheBar(part.leftMs / part.ttlMs)} ~${cacheClock(part.leftMs)} left${status.awaiting ? " · awaiting report" : ""}`));
  }
  const upkeepLine = [row.keepalives.length ? `${plural(row.keepalives.length, "keepalive")} since the last request` : "", keepaliveNote(panel, c, row) ?? ""].filter(Boolean).join(" · ");
  if (upkeepLine) out.push(p.dim(upkeepLine));
  const window = recentUsage(row)?.requests;
  const t = row.totals;
  out.push(p.dim(`${window ? `hit rate over the last ${plural(window, "request")} · ` : ""}${plural(t.requests, "request")} · read ${cacheTokens(t.read)} · write ${cacheTokens(t.write)} · new ${cacheTokens(t.fresh)} · out ${cacheTokens(t.output)}`));
  out.push(p.dim(row.last ? `${displayText(row.last.model, 160)} · ${displayText(row.last.ttlSource, 120)}${priceNote(c, row)}` : "No usage observed in this context"));
  out.push("", ...requestLines(p, row, filter));
  return out;
}
