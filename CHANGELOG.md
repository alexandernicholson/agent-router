# Changelog

Each release explains what changed for you, in 120 words or less.

## Keepalive 0.4.1

- **Countdowns for non-Claude models.** A gateway or TTL-setting lifetime now counts down to the refresh time (`◇ 2m 9s · once`) with a live dial and colours, then reads `sent · once`, `idle` or `missed`.
- **New gateway lifetimes.** `⟳` marks a gateway's probe lifetime, which it shortens when keepalives miss; administrator overrides show as `◇`. Prices come from your gateway's feed first, Claude included.
- **No useless TTL button.** The 5m/1h request toggle shows only for Claude rows, where it works.

## Keepalive 0.4.0

- **Warm, compact and warmcomp work on any model.** Pick **TTL for models that don't report one** in `/keepalive-settings`, globally or per model; a gateway's own lifetime always wins, and Claude is untouched.
- **See where a lifetime comes from.** Icons mark it: ◉ provider, ✦ learned, ▣ documented, ◇ default, ✎ yours, ⊘ no cache.
- **One keepalive per idle period** unless reads are known to extend the cache, and only when it pays off.
- **Prices from your gateway.** Reads `/v1/cache/prices` or your own feed URL.

## Pi Keepalive 0.3.1

- **Live countdown for gateway and client lifetimes**, the `⟳` probe and `◇` override sources, Claude-only native TTL, and price feeds with `patterns` and `write_1h`. Same as Keepalive 0.4.1.

## Pi Keepalive 0.3.0

- **Warm, compact and warmcomp work on any model.** Set `unreported_ttl` (`off`, `5m`, `15m`, `30m`, `45m`, `1h`) with `/keepalive set`, or per model with `unreported_ttl_models` (`kimi*=15m, glm-5.3=off`). A gateway's own lifetime wins, and Claude is untouched.
- **See where a lifetime comes from.** The bar and dashboard show ◉ ✦ ▣ ◇ ✎ ⊘ ◌, and keepalives say which with `src="…"`.
- **Prices from your gateway** (`/v1/cache/prices`) or `keepalive_price_url`; keepalives fire only when they pay off.
- **Safer gateway handling.** Unknown or stale policy answers are monitored, and `warmcomp` compacts a big conversation instead of a single unchained keepalive.

## Pi Keepalive 0.2.1

- **One keepalive when the gateway can't promise more.** Same as Keepalive 0.3.1: an unconfirmed cache gets a single keepalive timed from your last message, shown as `· once`.

## Pi Keepalive 0.2.0

- **Keepalive for Pi and OMP.** New `pi-keepalive` extension brings the Keepalive cache bar, dashboard (`/keepalive`), upkeep modes, keepalive limits and gateway cache policy to Pi and OMP sessions. Install by linking `pi-keepalive` into `~/.pi/agent/extensions` or `~/.omp/agent/extensions`.
- **No double warming.** While it manages a session, it tells the built-in cache warmer to stop.
- **What differs from Claude Code.** One conversation per session (no subagent or teammate rows), commands instead of buttons, and keepalives replay the last request with the keepalive prompt appended. See `pi-keepalive/PARITY.md`.

## Keepalive 0.3.1

- **One keepalive when the gateway can't promise more.** If the gateway hasn't learned whether a cache read extends its lifetime, `warm` times a single keepalive from your last message and stops, instead of chaining. The bar shows `kimi-k3 via phala · safe 8m · once`. Gateways that confirm reads extend the cache keep the chained behaviour.

## Keepalive 0.3.0

- **Keepalives say who sent them.** The request now opens with `<keepalive v="0.3.0"/>` and asks for one letter, so a gateway can tell a keepalive from your own prompt.
- **Keep non-Anthropic caches warm.** Behind a gateway that publishes a cache policy, `warm` follows the gateway's published safe refresh time for models that don't report their cache lifetime, and the bar shows it (`kimi-k3 via phala · safe 8m · enabled`). Models the gateway has not enabled are shown, never warmed. Claude keeps its 5-minute and 1-hour behaviour.

## Keepalive 0.2.0

- **Choose the upkeep every session starts in.** `/keepalive-settings` now has **Main conversation upkeep**: `off`, `warm`, `compact` or `warmcomp`. New sessions start in it; the mode button still changes it for the session you're in.
- **A keepalive limit for teammates.** **Teammate keepalive limit** lets split-pane teammates warm more or less than your main conversation. `same`, the default, keeps them on your keepalive limit.
- **Choose when to compact.** **Compaction threshold** sets the smallest conversation `compact` and `warmcomp` compact. It stays at 100k tokens unless you change it; type any size, such as `60k`.

## Agent Router 0.17.0 · Keepalive 0.1.0

- **Two plugins.** The cache bar is now **Keepalive**, a separate plugin in the same marketplace: `/plugin install keepalive@agent-router-tools`. Agent Router keeps model routing. Either works without the other.
- **Nothing lost.** Keepalive copies your cache history and keeps your saved cache settings. Its settings are in `/keepalive-settings`; `/agent-cache` still opens the dashboard, now also `/keepalive`.
- **The whole session at a glance.** The dashboard opens with the hit rate now and overall, and one coloured dot per request.
- **Clearer filters.** The option in use is highlighted.
- **Denser history.** One line per request, in columns, with the time between requests in the gap.

## 0.16.2

- **No vanishing countdowns on gateway models.** Some gateway models never report how long their cache lasts. Their bar now says `TTL not reported` from the start instead of counting down for 30 seconds and then switching.
- **A brief gateway hiccup no longer turns routing off.** If the model list check at session start gets a server error, Agent Router tries twice more before giving up.

## 0.16.1

- **Teammates keep their models.** A teammate started with a role now runs on the teammate model, and on the teammate TTL, as set in `/agent-models` → Teammates.
- **Split-pane teammates show their cache.** Their bar and the lead's dashboard now fill in from the first request, and each teammate appears once.
- **Teammate keepalives hit the cache.** A split-pane teammate whose role sets an effort sends keepalives and compactions at that effort, so they reuse its cache instead of rewriting it.
- **A tidier miss chip.** `✕` now has a space after it.

## 0.16.0

- **Choose how many keepalives to send.** `/agent-models` → Prompt cache has a keepalive limit: `default` warms while it costs less than rewriting the cache, a number sends exactly that many, and `infinite` warms until you're back.
- **A steadier hit rate.** The bar shows the hit rate over your last 10 requests.
- **Misses you won't miss.** A small `✕ 2 prefix` chip shows cache misses from the last 15 minutes and their causes. It dims after 5 minutes; click it for details.
- **No more "TTL not reported" flicker.** A new cache counts down from your chosen TTL until the actual one arrives.
- **Each request's TTL** now shows in the dashboard's history.

## 0.15.0

- **Choose each conversation's cache lifetime.** Click `TTL 5m` on the cache bar to switch that conversation between 5 minutes and 1 hour. Subagents and teammates keep their own setting. Defaults for each are in `/agent-models`, and show exactly what Claude Code would use.
- **Accurate Claude prices.** Keepalive costs now use Anthropic's published prices, including 1-hour caches, whatever your gateway calls the model.
- **A quick guide.** The first time the cache bar appears, a short guide explains it. It shows once and is never sent to the model.
