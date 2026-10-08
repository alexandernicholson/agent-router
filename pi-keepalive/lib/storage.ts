// Small JSON files in the extension's data directory: settings.json (user settings) and store.json (per-session choices).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** ~/.omp/agent/keepalive when loaded from an OMP directory, else ~/.pi/agent/keepalive; PI_KEEPALIVE_DIR overrides. */
export function dataRoot(env: Record<string, string | undefined>, moduleUrl: string): string {
  if (env.PI_KEEPALIVE_DIR) return env.PI_KEEPALIVE_DIR;
  return join(homedir(), moduleUrl.includes("/.omp/") ? ".omp" : ".pi", "agent", "keepalive");
}

export function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

export function writeJson(root: string, name: string, value: unknown): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export function createStore(root: string) {
  const file = join(root, "store.json");
  const all = (): Record<string, unknown> => {
    const value = readJson(file);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  };
  return {
    async get(key: string): Promise<unknown> { return all()[key]; },
    async set(key: string, value: unknown): Promise<void> { writeJson(root, "store.json", { ...all(), [key]: value }); },
  };
}

/** Append one JSON line to $PI_KEEPALIVE_TRACE when set (diagnostics and the e2e run; never records credentials). */
export function trace(env: Record<string, string | undefined>, event: string, data: object): void {
  if (!env.PI_KEEPALIVE_TRACE) return;
  try { appendFileSync(env.PI_KEEPALIVE_TRACE, `${JSON.stringify({ at: Date.now(), event, ...data })}\n`); } catch { /* diagnostics only */ }
}
