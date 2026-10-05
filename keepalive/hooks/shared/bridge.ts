export type Bridge = (request: Record<string, unknown>) => Promise<any>;
type Run = (argv: string[], init: { stdin: string; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export function createBridge(run: Run, root: string, base: () => Record<string, unknown>, failure: string): Bridge {
  return async request => {
    const result = await run(['node', `${root}/scripts/bridge.mjs`], { stdin: JSON.stringify({ ...base(), ...request }), timeoutMs: 20_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || failure);
    return JSON.parse(result.stdout);
  };
}
