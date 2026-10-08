# e2e results (real Pi 1.0.4 and OMP 18.8.0, Ubuntu container, Sonnet 5.5 `claude-sonnet-5-5`)

Setup check: `pi -p` and `omp -p "Reply with only: OK"` answered `OK`. Run: `e2e/run.sh ... -- bash /e2e/in-container.sh pi|omp`. Test-only TTL shortening: `PI_KEEPALIVE_E2E=1` plus `PI_KEEPALIVE_E2E_TTL_MS` (both required, read only by the e2e run). Keys are redacted from all output.

## Pi (TTL stands for 20 s, i.e. keepalive in the last 2 s)
- Extension loaded; status line traced: `[ ◑ ] ⬥ warm TTL 5m ▒▒░ 17% · ETA ~2:30 · ↻1 · read 2.2k · write 10.1k · new 4`.
- Policy: the gateway has no `/v1/cache/policy` yet (404), so native 5m logic applied.
- `cache_warming_decision` (Pi `cacheWarming=idle`) answered `{"action":"stop"}`.
- Keepalive request body's last message: `<keepalive v="0.2.0"/> Reply with only: K`; response `read 12306, write 0, fresh 27, output 1` (cache hit). Second keepalive also read 12306. A third was aborted by the next real turn (logged, not counted).
- Real turn after the gap: `cacheRead 12306`.

## OMP
- Same flow. Keepalive 1: read 11177 / write 10360 (partial hit while the first write was still settling); keepalive 2: read 21537, write 0 (full hit). Marker present in both.
- OMP's own second turn re-wrote part of the prefix (read 7272): OMP changes its request between turns (system reminders), independent of the extension.
- OMP route used: `<gateway>/ai/pi/claude` (same as Pi).
