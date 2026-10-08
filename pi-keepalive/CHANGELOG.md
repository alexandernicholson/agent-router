# Changelog

## 0.2.1

- **One keepalive when the gateway can't promise more.** If the gateway hasn't learned whether a cache read extends its lifetime, `warm` times a single keepalive from your last message and stops, instead of chaining. The bar shows `kimi-k3 via phala · safe 8m · once`. Gateways that confirm reads extend the cache keep the chained behaviour.

## 0.2.0

- Initial release: cache bar, `/keepalive` dashboard, upkeep modes, keepalive limits and gateway cache policy for Pi and OMP.
