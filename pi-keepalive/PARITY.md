# Parity with the Claude Code `keepalive` plugin

The ledger, grading, miss reasons, TTL handling, pricing, upkeep rules and gateway-policy logic are the plugin's own modules, synced into `lib/core/` by `npm run sync` (`scripts/sync-shared.mjs`). Pi/OMP-specific code: `index.ts` (events, commands), `lib/panel.ts` (port of `hooks/cache-panel.ts` logic), `lib/render.ts` (text rendering), `lib/transport.ts` (keepalive request), `lib/settings.ts`, `lib/storage.ts`, `lib/replay.ts`.

| Feature | Claude plugin | Pi / OMP | Tests |
|---|---|---|---|
| Cache bar (dial, mode marker, TTL, hit-rate bar, ETA, read/write/new) | `renderBand` | footer status `statusLine` | render.test |
| Grades, colours (dark/light), bar shading, life colours | `cache-colors.js`, `cacheGrade` | same modules; `PI_KEEPALIVE_THEME`/`COLORFGBG`; `NO_COLOR` plain | render.test |
| Hit rate over last 10 requests, keepalives/compactions excluded | `recentUsage` | same | panel/render |
| Miss chip + causes (prefix/expired/model/TTL/unknown), fresh vs dim, miss line | `missChip`, `missLine` | same text | render.test |
| TTL detection 5m / 1h / mixed, `N reported`, `TTL not reported`, `expired`, uncached, awaiting report | `cacheStatus` | same; requested TTL read from `cache_control`; reported split from `usage.cacheWrite1h` | panel/render |
| TTL button + per-session choice | TTL button, env vars | `/keepalive ttl [5m\|1h]` rewrites `cache_control` of the outgoing request; persisted per session | panel/extension |
| Upkeep off/warm/compact/warmcomp, 30 s before expiry, once per countdown | `upkeep` | same, driven by a 1 s timer | upkeep.test |
| Keepalive prompt `Reply with only: K` (no marker), 1-token reply; `client` heartbeat, out-of-band reports to speaking gateways, policy GET every 10 min | `KEEPALIVE_PROMPT` | `lib/version.ts`, `createReportClient`; replay of the last real request body | misc/upkeep |
| Keepalive limit default (price rule) / number / infinite; `↻N`, `➜ cmpt` | `keepaliveWorthwhile` | same | upkeep/render |
| Compaction threshold; `cmpt ✓ before → after`; compaction history/reset | `compact`, `compacted` | host `ctx.compact()`; user compactions via `session_compact` | upkeep/extension |
| Price sources (Anthropic table, models.dev, matching, ETag cache) | `price-sources.mjs` | same modules, data in `~/.pi\|omp/agent/keepalive` | render/upkeep |
| Dashboard: overview, Now/Session, dot matrix, request history with gaps, filters | pane | `/keepalive dashboard`, `/keepalive requests [real\|keepalives\|compactions\|misses]` widget | render.test |
| Settings pane | `/keepalive-settings` | `/keepalive settings` (select dialogs) and `/keepalive set <key> <value>`; env `PI_KEEPALIVE_*`; `settings.json` | extension/misc |
| Ledger persistence, upkeep/TTL per-session memory, one-time intro | bridge + store | same bridge modules; `store.json` | panel/edges |
| Lifetime chain (native → server row by source → client TTL → unknown), `unreported_ttl` / `unreported_ttl_models`, source icons ◉✦▣◇⟳✎⊘◌ (probe, override), countdown via `lifetimeStatus`, monitor reasons, feed `patterns`/`write_1h`, single-shot vs chained by `refresh_on_read`, warm/compact/warmcomp on non-native rows, savings rule (`p_resume`), custom price URL | `lifetimeOf`, `clientTtl`, `lifetimeLabel`, `lifetimeStatus`, `feedPrice`, `savingsWorthwhile`, `customUrlPrices`, `keepalivePrompt` | same modules; settings via `/keepalive set` instead of a pane | policy.test, render.test |
| Unknown vs no-opinion policy answers (`peek` null / `[]`), `monitor` status label, warmcomp compacts instead of a single (unchained) keepalive when over the threshold, client-TTL anchor on start, served `anchor:"start"` rows (`anchorOnStart`, stamped at dispatch), `max_age_s` refetch interval, fixed-window anchor on a write of ≥ 50% of the current prefix | `servedRows`, `lifetime`, `policyAction` | same | policy.test |
| Gateway policy: enabled / shadow / insufficient / demoted / fixed window / native; safe time, max idle, 5 s tick, no catch-up, renew on read, 10 min cache, backoff; claude keeps native 5m/1h; 404 → native | `policyAction`, `createPolicyClient` | same shared client; any non-Anthropic base | policy.test |
| Built-in warmer | n/a | answers `cache_warming_decision` with stop while managed | extension |
| Never act mid-request | `pending` | `pending` + `ctx.isIdle()` | upkeep |

## Not reachable in Pi/OMP (evidence)

- **Subagent / teammate rows, tree, per-agent TTL and upkeep, split-pane linking, Agent Router routes**: Pi and OMP's extension API exposes one conversation per session; there are no teammate or subagent loops to observe.
- **Transcript-based TTL recovery** (`cache-enrich`): unnecessary; Pi/OMP report `cacheWrite1h` (Pi) / `cttl` (OMP) directly in usage.
- **Clickable buttons, mouse dial, pane**: the API has `setStatus`, `setWidget` and slash commands only; the dial and mode are shown in the footer and changed with `/keepalive upkeep`.
- **Hidden fork reusing the session context**: no such call exists; the extension replays the observed request body (Pi: through `modelRegistry.streamSimple` with `onPayload`; OMP, which exposes no streaming API: direct HTTP to the same base URL with the session's credentials).
