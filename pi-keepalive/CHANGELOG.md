# Changelog

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
