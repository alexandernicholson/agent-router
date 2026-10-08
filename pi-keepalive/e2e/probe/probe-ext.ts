// Dependency-free probe extension: proves extension loading, event hooks and a background timer in rpc mode.
export default function (pi: any) {
  const log = (m: string) => process.stderr.write(`[probe] ${new Date().toISOString()} ${m}\n`);
  let n = 0;
  const t = setInterval(() => log(`timer tick ${++n}`), 4000);
  (t as any).unref?.();
  log("extension loaded");
  pi.on("before_provider_request", (e: any) => log(`before_provider_request keys=${Object.keys(e.payload ?? {}).join(",")}`));
  pi.on("after_provider_response", (e: any) => log(`after_provider_response status=${e.status}`));
  pi.on("agent_end", () => log("agent_end"));
  pi.on("message_end", (e: any) => { if (e.message?.role === "assistant") log(`usage=${JSON.stringify(e.message.usage)}`); });
}
