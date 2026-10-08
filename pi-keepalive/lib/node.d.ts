declare module "node:fs" {
  export function appendFileSync(path: string, data: string): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string, options?: { mode?: number }): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void;
}
declare module "node:os" {
  export function homedir(): string;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
}
declare const process: { env: Record<string, string | undefined> };
declare function setInterval(fn: () => void, ms: number): { unref?(): void };
declare function clearInterval(handle: unknown): void;
declare function setTimeout(fn: () => void, ms: number): { unref?(): void };
declare function clearTimeout(handle: unknown): void;
