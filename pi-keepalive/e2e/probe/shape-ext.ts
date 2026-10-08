export default function (pi: any) {
  pi.on("before_provider_request", (e: any) => {
    const p = e.payload; const marks: string[] = [];
    const walk = (v: any, path: string) => { if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`)); else if (v && typeof v === "object") for (const [k, c] of Object.entries(v)) { if (k === "cache_control") marks.push(`${path}.cache_control=${JSON.stringify(c)}`); else walk(c, `${path}.${k}`); } };
    walk(p, "");
    process.stderr.write("SHAPE " + JSON.stringify({ keys: Object.keys(p), thinking: p.thinking, max_tokens: p.max_tokens, system: Array.isArray(p.system) ? p.system.map((b: any) => b.type + ":" + (b.text ?? "").length) : typeof p.system, nmsg: p.messages?.length, lastRole: p.messages?.at(-1)?.role, lastContent: JSON.stringify(p.messages?.at(-1)?.content).slice(0, 120), ntools: p.tools?.length, marks }) + "\n");
  });
}
