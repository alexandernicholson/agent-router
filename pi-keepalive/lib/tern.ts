// The Tern bridge: when OMP runs in a Tern pane (TERN_PANE is set), the extension publishes the pane's cache state as JSON
// for the Tern `keepalive` plugin, and takes upkeep/TTL choices back from it. While that plugin is running it draws the cache
// bar in Tern's status line, so the extension leaves its own footer bar out.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cacheDial, cacheGrade, cachePercent, isCompaction, isKeepalive, lifeGrade, sampleTtl, sessionMatrix, sessionUsage } from "./core/cache.js";
import type { CacheSample } from "./core/cache.js";
import type { Ctx, Panel } from "./panel.ts";
import { LIFETIME_LEGEND, mainSection, misses, missLine, painter, requestName, spanPainter, spans, statusLine, statusParts, upkeepText, type Span } from "./render.ts";
import { DEFAULT_SETTINGS, SETTING_ROWS, type Settings, type Ttl, type Upkeep, UPKEEP } from "./settings.ts";
import { VERSION } from "./version.ts";

/** The Tern plugin's id: its data directory is `<state>/plugin-data/keepalive`. */
export const PLUGIN_ID = "keepalive";
/** Snapshot schema version, read by the Tern plugin. */
export const SNAPSHOT_VERSION = 1;
/** The plugin's heartbeat (`active.json`, written every few seconds) counts as live for this long. */
export const ACTIVE_FOR_S = 20;
const REQUESTS = 30;
const CELLS = 240;

export interface TernBridge {
  dir: string;
  pane: string;
}

/**
 * Where the Tern plugin keeps its data: PI_KEEPALIVE_TERN_DIR (its spawn filter sets this in every new pane), else Tern's
 * state directory for the platform. Undefined outside a Tern pane.
 */
export function ternBridge(env: Record<string, string | undefined>, platform: string = process.platform, home: string = homedir()): TernBridge | undefined {
  const pane = env.TERN_PANE;
  if (!pane || !/^\d+$/.test(pane) || env.PI_KEEPALIVE_TERN === "0") return undefined;
  if (env.PI_KEEPALIVE_TERN_DIR) return { dir: env.PI_KEEPALIVE_TERN_DIR, pane };
  const state = env.TERN_CONFIG_DIR
    ?? (platform === "darwin" ? join(home, "Library", "Application Support", "Tern")
      : platform === "win32" ? join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Tern")
      : join(env.XDG_STATE_HOME || join(home, ".local", "state"), "tern"));
  return { dir: join(state, "plugin-data", PLUGIN_ID), pane };
}

function readObject(file: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch { return undefined; }
}

/** Whether the Tern plugin is running: its host half rewrites `active.json` with `{at: <unix seconds>}` every few seconds. */
export function ternActive(bridge: TernBridge | undefined, nowMs: number): boolean {
  if (!bridge) return false;
  const at = readObject(join(bridge.dir, "active.json"))?.at;
  return typeof at === "number" && Math.abs(nowMs / 1000 - at) <= ACTIVE_FOR_S;
}

export const paneFile = (bridge: TernBridge) => join(bridge.dir, "panes", `${bridge.pane}.json`);
export const controlFile = (bridge: TernBridge) => join(bridge.dir, "control", `${bridge.pane}.json`);

/** Writes the pane's snapshot whole, through a temporary file and a rename, so the plugin never reads half of it. */
export function writePane(bridge: TernBridge, text: string): void {
  const file = paneFile(bridge);
  mkdirSync(join(bridge.dir, "panes"), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, file);
}

/** One request from the Tern plugin. `seq` grows with every command, so each is applied once. */
export interface Control {
  seq: number;
  upkeep?: Upkeep | "cycle";
  ttl?: Ttl | "toggle";
}

/**
 * The pane's commands newer than `after`, oldest first. The file is `{seq, queue: [{seq, upkeep?, ttl?}, …]}`: the plugin
 * appends to the queue (keeping its last few) so commands given faster than the extension's one-second poll all arrive.
 */
export function readControl(bridge: TernBridge, after: number): Control[] {
  const queue = readObject(controlFile(bridge))?.queue;
  if (!Array.isArray(queue)) return [];
  const out: Control[] = [];
  for (const item of queue as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const { seq, upkeep, ttl } = item as Record<string, unknown>;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= after) continue;
    out.push({
      seq,
      ...(upkeep === "cycle" || UPKEEP.includes(upkeep as Upkeep) ? { upkeep: upkeep as Upkeep | "cycle" } : {}),
      ...(ttl === "5m" || ttl === "1h" || ttl === "toggle" ? { ttl } : {}),
    });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** The pane's last command, so a reloaded extension does not replay it. */
export function lastControl(bridge: TernBridge): number {
  const seq = readObject(controlFile(bridge))?.seq;
  return typeof seq === "number" && Number.isSafeInteger(seq) ? seq : 0;
}

const percentOf = (usage: { read: number; write: number; fresh: number } | undefined) => ({ percent: cachePercent(usage), grade: cacheGrade(usage) });

function requestOf(s: CacheSample) {
  return {
    name: requestName(s), kind: isKeepalive(s) ? "keepalive" : isCompaction(s) ? "compaction" : "real", ...percentOf(s),
    ttl: sampleTtl(s) ?? null, miss: s.miss ?? null, read: s.read, write: s.write, fresh: s.fresh, output: s.output, model: s.model, startedAt: s.startedAt,
  };
}

export interface SnapshotInfo {
  pane: string;
  sessionId: string;
  root: string;
  cwd: string;
  settings: Settings;
  enabled: boolean;
  now: number;
}

/** One piece of the status-line bar as Tern draws it: a tone for its colour and whether it sits flush against the previous one. */
export interface BarSpan {
  text: string;
  tone: string;
  join?: true;
}

const SEP = " · ";

/**
 * The footer bar as styled pieces for Tern's status line, carrying the same information as `statusLine` without the token
 * counts (the dashboard has those). Tones: `life-good|fair|poor|none` for the dial; `warm`, `compact` and `dim` for the mode
 * diamonds and painted runs as the footer colours them; `mode-<upkeep>`; `label` and `value` for the TTL; `good`, `fair`,
 * `poor` for grades; `text` for unpainted text; `note` for the keepalives left; `sep` between parts. Whitespace becomes
 * gaps between pieces; `join` marks a piece that had none before it, such as the two halves of the hit-rate bar.
 */
export function barSpans(panel: Panel, c: Ctx, life: string | null): BarSpan[] {
  const s = statusParts(panel, c, spanPainter);
  const runs: Span[] = [
    { text: s.dial, tone: `life-${life ?? "none"}` }, { text: " " }, ...spans(s.marks), { text: " " }, { text: s.upkeep, tone: `mode-${s.upkeep}` }, { text: " " },
    ...(s.ttl ? [{ text: "TTL", tone: "label" }, { text: " " }, { text: s.ttl, tone: "value" }, { text: " " }] : []),
    ...spans(s.body),
    ...(s.note ? [{ text: SEP }, { text: s.note, tone: "note" }] : []),
    ...(s.available ? [] : [{ text: SEP }, { text: "storage unavailable", tone: "poor" }]),
  ];
  const out: BarSpan[] = [];
  let gap = false;
  const push = (text: string, tone: string) => {
    const lead = /^\s/.test(text);
    const trimmed = text.trim();
    if (trimmed) {
      out.push({ text: trimmed, tone, ...(out.length && !gap && !lead ? { join: true as const } : {}) });
      gap = /\s$/.test(text);
    } else if (text) gap = true;
  };
  for (const run of runs) {
    run.text.split(SEP).forEach((piece, i) => {
      if (i) { out.push({ text: "·", tone: "sep" }); gap = true; }
      push(piece, run.tone ?? "text");
    });
  }
  return out;
}

/** Everything the Tern plugin draws for one pane: the status-line bar, the dashboard and the settings page. */
export function snapshot(panel: Panel, c: Ctx | undefined, info: SnapshotInfo) {
  const plain = painter({}, true);
  const head = { v: SNAPSHOT_VERSION, version: VERSION, pane: info.pane, pid: process.pid, session: info.sessionId, cwd: info.cwd, root: info.root, at: info.now, enabled: info.enabled,
    settings: info.settings, defaults: DEFAULT_SETTINGS, rows: SETTING_ROWS.map(([key, title, choices]) => ({ key, title, choices })) };
  if (!c || !info.enabled) return { ...head, bar: null, dashboard: null };
  const row = panel.mainRow(c);
  const status = panel.state(c, row);
  const usage = sessionUsage([row]);
  const found = misses(c, [row]);
  const samples = [...row.samples].sort((a, b) => b.startedAt - a.startedAt).slice(0, REQUESTS);
  return {
    ...head,
    bar: {
      text: statusLine(panel, c, plain),
      spans: barSpans(panel, c, lifeGrade(status.leftMs)),
      dial: cacheDial(status),
      upkeep: c.upkeep,
      ttl: panel.ownLifetime(c, row) ? null : (panel.wantedTtl(c) ?? row.last?.requested ?? "5m"),
      ...percentOf(status.state === "compacted" ? status.sample : (panel.recentUsage(row) ?? status.sample)),
      leftMs: status.leftMs,
      life: lifeGrade(status.leftMs),
      misses: found.total,
      available: c.available,
    },
    dashboard: {
      recent: usage ? { ...percentOf(usage.recent), requests: usage.recent.requests } : null,
      session: usage ? { ...percentOf(usage.session), requests: usage.session.requests, read: usage.session.read, write: usage.session.write, fresh: usage.session.fresh } : null,
      cells: sessionMatrix([row]).slice(-CELLS).map(({ glyph, tone }) => ({ glyph, tone })),
      misses: missLine(c, [row]) ?? null,
      upkeep: upkeepText(c),
      legend: LIFETIME_LEGEND,
      main: mainSection(panel, c, plain).slice(1),
      requests: samples.map(requestOf),
    },
  };
}
