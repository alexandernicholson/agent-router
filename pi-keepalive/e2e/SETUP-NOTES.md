# Pi / OMP Docker e2e environment

Image `pi-keepalive-e2e` (Ubuntu 24.04, Node 22.20.0, Bun 1.3.14, Pi 1.0.4, OMP 18.8.0). No secrets baked in.

- Pi: npm `@earendil-works/pi-coding-agent@1.0.4` (CLI `pi`; repo earendil-works/pi; the old `@mariozechner/pi-coding-agent` is deprecated). Needs Node >= 22.19.
- OMP: `bun install -g @oh-my-pi/pi-coding-agent@18.8.0` (CLI `omp`; needs Bun >= 1.3.14). Also `curl -fsSL https://omp.sh/install | sh`.

## Files
- `Dockerfile`, `entrypoint.sh` - entrypoint writes Pi/OMP config from env at start (key referenced by env var name, never written).
- `run.sh [--mount host:ctr[:ro]] [--env K=V] -- <cmd...>` - builds image if missing, builds 0600 temp env-file from `~/.cvm/profiles/gateway.env` (only ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY), trap-deletes it, pipes ALL output through a redactor (exact key, `sk-*`, `Bearer ...`, `x-api-key`). Exit code = container's.
- `rpc-probe.sh`, `probe/probe-ext.ts` - dependency-free probe extension (timer + hooks) and a stdin-driven RPC session with an idle gap.

## IMPORTANT: base URL
Profile `ANTHROPIC_BASE_URL` is `https://GATEWAY.example/ai/claude` (Claude Code route). Pi/OMP post to `{baseUrl}/v1/messages`.
- A raw request without Claude-Code-ish UA to `/ai/claude` returned 500, and Pi via `/ai/claude` got "Anthropic stream ended without a stop reason" (0 tokens).
- The gateway has a dedicated `/ai/pi/claude` route (ClaudeProxy proxy_type="pi"). Pi AND OMP worked through it. Use:
  `--env E2E_PI_BASE_URL=https://GATEWAY.example/ai/pi/claude --env E2E_OMP_BASE_URL=https://GATEWAY.example/ai/pi/claude`
  (defaults to ANTHROPIC_BASE_URL when unset).
- Gateway is flaky/rate-limited: one rpc run got HTTP 200 with an empty stream 3x in a row ("stream ended without a stop reason"; Pi auto-retries 3x with 2/4/8s delay, so a failure costs 3-4 requests); a raw curl got upstream 429 once. An immediate repeat succeeded.

## Generated config (placeholders)
`~/.pi/agent/models.json`:
```json
{"providers":{"anthropic":{"baseUrl":"<BASE>","apiKey":"$ANTHROPIC_API_KEY","api":"anthropic-messages",
 "models":[{"id":"claude-sonnet-5-5","name":"Claude Sonnet 5.5 (e2e)","reasoning":false,"input":["text"],
 "contextWindow":200000,"maxTokens":16000,"cost":{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75},
 "promptCache":{"short":300}}]}}}
```
`~/.pi/agent/settings.json`: `{"cacheWarming":"off","defaultProvider":"anthropic","defaultModel":"claude-sonnet-5-5","quietStartup":true}`
(`apiKey` supports `$ENV` interpolation. Models absent from the bundled catalog must be declared; `pi --list-models` is empty without auth.)

`~/.omp/agent/models.yml`:
```yaml
providers:
  gateway:
    baseUrl: <BASE>
    api: anthropic-messages
    apiKey: ANTHROPIC_API_KEY      # env var NAME
    models:
      - {id: claude-sonnet-5-5, name: "Claude Sonnet 5.5 (e2e)", contextWindow: 200000, maxTokens: 16000}
```
`~/.omp/agent/config.yml`: `modelRoles:\n  default: gateway/claude-sonnet-5-5`
(OMP also honours plain ANTHROPIC_BASE_URL/ANTHROPIC_CUSTOM_HEADERS env for custom gateways, per `omp --help`; not tested.)

## Commands (verified)
```
./run.sh --env E2E_PI_BASE_URL=.../ai/pi/claude -- pi  -p "Reply with only: OK"   # -> OK
./run.sh --env E2E_OMP_BASE_URL=.../ai/pi/claude -- omp -p "Reply with only: OK"  # -> OK
```
Interactive shell: `./run.sh --` (bash). Mount your extension: `--mount "$PWD/..:/ext:ro"`.

## Loading extensions non-interactively
- Pi: `pi -e /ext/index.ts ...` (repeatable; `--no-extensions` disables discovery but explicit -e still loads). Auto-discovery dirs: `~/.pi/agent/extensions`, project `.pi/`. TS is loaded directly (no build).
- OMP: `omp -e /ext/index.ts ...` (also `--hook`, `--no-extensions`; `--trusted-extension` allowlist). Auto-dir `~/.omp/agent/extensions`.
- Both accept `pi.on(event, handler)`. Probe extension loaded and worked in both (`extension loaded`, hooks fired).
- Note `@earendil-works/pi-coding-agent` types import: not resolvable from a mounted dir unless imported as type-only / `node_modules` is on the path; the probe avoids imports (`pi: any`). For OMP the extension API package is `@oh-my-pi/pi-coding-agent`.

## Keeping the process alive across an idle gap (timer must fire)
`-p` exits after the turn. Use RPC over stdin (JSONL, LF framing), keeping stdin open with sleeps:
```
{ echo '{"id":"p1","type":"prompt","message":"..."}'; sleep 35; echo '{"id":"p2","type":"prompt","message":"..."}'; sleep 5; } | pi --mode rpc --no-session -e /ext/index.ts
```
Same for `omp --mode rpc --no-session -e ...` (`--no-ui` runs extensions headless). Closing stdin ends the process - OMP aborted an in-flight request when stdin closed, so sleep long enough after the last prompt (wait for `agent_settled` in Pi; OMP emits `prompt_result`). Verified: timer ticks (setInterval, unref'd) fired every 4s during idle in both. Extension stderr (process.stderr.write) shows through; stdout is the protocol channel - don't write to stdout from extensions in rpc/json mode.
`./rpc-probe.sh pi|omp /e2e/probe/probe-ext.ts 10` automates one prompt + idle + stats (mount `e2e/` at `/e2e`).

## Debug / usage visibility
- Request logging: extension hooks `pi.on("before_provider_request", e => e.payload)` and `pi.on("after_provider_response", e => e.status/e.headers)` exist in both (Pi example: `examples/extensions/provider-payload.ts`). Pi payload keys: model,messages,max_tokens,stream,system,tools. OMP payload also has metadata, thinking, context_management, output_config.
- Usage: `message_end` (assistant) event has `message.usage {input,output,cacheRead,cacheWrite,totalTokens,cost}`; streaming `message_update` also carries usage (observed cacheRead 2255 on second identical Pi request, i.e. gateway/Anthropic cache works). RPC `{"type":"get_session_stats"}` returns tokens/cost/contextUsage. `--mode json` prints the full event stream (incl. system prompt - large; cut it). Status line: `ctx.ui.setStatus` is TUI/rpc `extension_ui_request` only; not shown in `-p`.
- Pi `/session` shows the next cache-warming decision.

## Surprises
- **Pi 1.0.4 has built-in cache warming** (`cacheWarming`: off|streaming|idle, default `streaming`; needs model `promptCache` lifetime, and est. >= $0.05 avoided cost; extension hook `cache_warming_decision`). entrypoint sets `"off"` so it does not interfere with the extension under test; set `"idle"` to compare.
- `--mode json` / rpc dump `message_start` of role `system` with the whole prompt.
- Pi `--version` 1.0.4; OMP prints `omp/18.8.0`. OMP has ~10k-token baseline context (vs Pi ~1.4k).
- Pi json/rpc empty-stream failures trigger auto retry (see above); watch for hidden extra requests.
- entrypoint exports PI_OFFLINE=1 and PI_TELEMETRY=0 (no startup network calls); run with `--entrypoint bash` to skip config generation if env is not supplied.
- OMP in a throwaway cwd: `--allow-home` is only needed when cwd is ~; container cwd is /home/agent/work.
