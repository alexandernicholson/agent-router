# Changelog

## 0.4.1

- **Install from the OMP marketplace.** `omp plugin marketplace add alexandernicholson/agent-router`, then `omp plugin install keepalive@agent-router-tools`. The repository now carries an OMP catalog (`.omp-plugin/marketplace.json`) beside Claude Code's, and the package declares its extension under `omp.extensions` as well as `pi.extensions`.
- **ChatGPT Codex.** Sessions on OMP's `openai-codex` provider (or one wrapping `chatgpt.com/backend-api`) now have a lifetime and can be kept warm: OpenAI documents 30 minutes after the latest write or read, so the bar counts `▣ 30m` down from each request, a keepalive goes out at 27 minutes and a keepalive that read the cache starts it again. OMP sends Codex turns over a WebSocket as deltas; the keepalive rebuilds the whole conversation and replays it over HTTP SSE to `/codex/responses`, routed to the session's cache by `session_id`. There is no 5m/1h choice (the backend sets retention itself), and no cache-policy request is sent to chatgpt.com. Before, a Codex session showed `TTL 5m` and could not be warmed.
- **Side requests no longer stop upkeep.** OMP asks the model for a session title after a turn; that request never produces a message, so it held upkeep off for the rest of the session and could be replayed as the keepalive. A request now becomes the replay source only once it is answered, and an unanswered one is dropped when the agent ends.
- **A switch of model drops the old model's lifetime.** After a Claude turn, a Codex (or any other) turn no longer shows the Claude write's `5m reported` countdown.
- **A styled bar for Tern.** The pane snapshot carries the bar as styled pieces (`bar.spans`: dial by remaining lifetime, a diamond per upkeep mode, mode, TTL label and value, grades, separators), so the Tern plugin draws it in the footer bar's colours.
- **The countdown keeps its colour after a miss.** In the footer bar, the `✕` miss chip was placed inside the countdown's coloured run, so after a miss the countdown (`◉ ETA …`, `expired`) lost its colour.
- **OpenAI cache writes.** `cache_write_tokens` in Responses usage counts as written, not new.

## 0.4.0

- **Tern.** In a Tern pane (`TERN_PANE` set), the extension publishes the pane's cache bar, dashboard and settings to the [Tern Keepalive plugin](../tern-keepalive/README.md) and takes upkeep and TTL commands back from it. While that plugin runs, the bar sits in Tern's status line and the footer bar is left out; without it the footer bar stays. `PI_KEEPALIVE_TERN=0` turns the bridge off.
- **Settings apply live.** A change to `settings.json`, from `/keepalive set` in another session or Tern's settings page, reaches every running session within a second.
- **OMP 18.10 usage.** The 1h share of a cache write is read from `usage.cttl.ephemeral1h` (OMP) as well as `cacheWrite1h` (Pi), and the response model from `upstreamModel`; before, OMP's 1h writes were booked as 5m.
- **OMP subagents are left alone.** OMP runs task subagents in-process with extensions rebound to them; their requests, compactions and shutdowns no longer touch the main conversation's ledger, replay source or timer.
- **OMP data directory.** Settings and ledger live in `<OMP agent dir>/keepalive` (`pi.getAgentDir()`), so a symlinked install no longer falls back to `~/.pi/agent/keepalive`.

## 0.3.5

- **Reduced motion.** `/keepalive set reduced_motion on`, or `PI_KEEPALIVE_REDUCED_MOTION=on`, shows the footer and dashboard countdowns in whole minutes, changing once a minute, with `soon` in the last one. Off by default.

## 0.3.4

- **No upstream names shown.** The dashboard no longer says which provider or model a gateway routes to (`via …`); a served lifetime reads `✦ 8m · learned by the gateway · server controlled`.

## 0.3.3

- **Start-anchored lifetimes.** A gateway row with `anchor: "start"` is timed from when the request was dispatched, as providers measure cache lifetime from request start; keepalives fire by start + safe. Completion-anchored rows are unchanged. The `client=pi-keepalive/0.3.3` heartbeat is what makes a gateway serve these rows.
- **`max_age_s`** shortens how long a policy answer is trusted before it is asked again (30s to 10 minutes).

## 0.3.2

- **The keepalive prompt is always `Reply with only: K`.** No marker, so providers and gateways see an ordinary short message.
- **Gateways learn about you out of band.** Policy requests carry `client=pi-keepalive/<version>`, and a gateway that speaks the cache-policy protocol is told, after each keepalive and compaction, what it read, wrote and which lifetime timed it (`POST /v1/cache/reports`). Nothing is sent to a gateway that doesn't answer the policy.
- **The harness is named.** Policy requests carry `harness=pi` (`omp` under OMP) and reports a top-level `"harness"` field; a report's `session` is the same id sent with model requests.
- **Gateways are asked at least every 10 minutes**, even for Claude rows with their own native lifetime.

## 0.3.1

- **A live countdown for gateway and client lifetimes.** The bar shows time left to the refresh (`✦ 7m 12s`), coloured as it runs down, from the same deadline the keepalive fires on. The 5m/1h TTL control is hidden for these rows, since it does nothing for them.
- **New lifetime sources.** `⟳` gateway probe and `◇` administrator override, with `src="probe"` / `src="override"` on keepalives. New monitor reasons `below_economic_floor` and `unreliable_cache`.
- **Claude-only native TTL.** A model that is not Claude is never given a provider-reported TTL, and a base URL with no valid policy URL has no gateway opinion.
- **Price feeds** may carry `patterns` (`*` wildcard, first match wins) and `write_1h`, and are asked first for every model, including native rows.

## 0.3.0

- **Warm, compact and warmcomp work on any model.** Set `unreported_ttl` (`off`, `5m`, `15m`, `30m`, `45m`, `1h`) with `/keepalive set`, or per model with `unreported_ttl_models` (`kimi*=15m, glm-5.3=off`). A gateway's own lifetime wins, and Claude is untouched.
- **See where a lifetime comes from.** The bar and dashboard show ◉ ✦ ▣ ◇ ✎ ⊘ ◌, and keepalives say which with `src="…"`.
- **Safer gateway handling.** An unknown or over-an-hour-old policy answer is monitored, never replaced by your client TTL; `monitor` rows show `◌ monitor (reason)`. With `warmcomp`, a big conversation is compacted instead of a single unchained keepalive.
- **Prices from your gateway** (`/v1/cache/prices`) or `keepalive_price_url`; keepalives fire only when they pay off.

## 0.2.1

- **One keepalive when the gateway can't promise more.** If the gateway hasn't learned whether a cache read extends its lifetime, `warm` times a single keepalive from your last message and stops, instead of chaining. The bar shows `kimi-k3 via phala · safe 8m · once`. Gateways that confirm reads extend the cache keep the chained behaviour.

## 0.2.0

- Initial release: cache bar, `/keepalive` dashboard, upkeep modes, keepalive limits and gateway cache policy for Pi and OMP.
