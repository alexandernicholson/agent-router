# Changelog

## 0.3.0

- **Warm, compact and warmcomp work on any model.** Set `unreported_ttl` (`off`, `5m`, `15m`, `30m`, `45m`, `1h`) with `/keepalive set`, or per model with `unreported_ttl_models` (`kimi*=15m, glm-5.3=off`). A gateway's own lifetime wins, and Claude is untouched.
- **See where a lifetime comes from.** The bar and dashboard show ◉ ✦ ▣ ◇ ✎ ⊘ ◌, and keepalives say which with `src="…"`.
- **Safer gateway handling.** An unknown or over-an-hour-old policy answer is monitored, never replaced by your client TTL; `monitor` rows show `◌ monitor (reason)`. With `warmcomp`, a big conversation is compacted instead of a single unchained keepalive.
- **Prices from your gateway** (`/v1/cache/prices`) or `keepalive_price_url`; keepalives fire only when they pay off.

## 0.2.1

- **One keepalive when the gateway can't promise more.** If the gateway hasn't learned whether a cache read extends its lifetime, `warm` times a single keepalive from your last message and stops, instead of chaining. The bar shows `kimi-k3 via phala · safe 8m · once`. Gateways that confirm reads extend the cache keep the chained behaviour.

## 0.2.0

- Initial release: cache bar, `/keepalive` dashboard, upkeep modes, keepalive limits and gateway cache policy for Pi and OMP.
