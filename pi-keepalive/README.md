# pi-keepalive

Keeps the prompt cache warm for [Pi](https://github.com/badlogic/pi-mono) and
OMP (oh-my-pi) sessions by sending a tiny cache-reading request shortly before
the cache expires. Same idea as the Claude Code `keepalive` plugin, and it
follows the gateway cache-policy protocol (`<keepalive v="X.Y.Z" src="SRC"/> Reply with only: K`, SRC = native, learned, documented, default, override, probe or client,
max output ~1 token).

## Install

Pi and OMP load extensions from a directory with an `index.ts`. Copy or symlink this
directory (no build step, no dependencies):

```sh
# Pi
mkdir -p ~/.pi/agent/extensions && ln -s "$PWD/pi-keepalive" ~/.pi/agent/extensions/pi-keepalive
# OMP
mkdir -p ~/.omp/agent/extensions && ln -s "$PWD/pi-keepalive" ~/.omp/agent/extensions/pi-keepalive
```

Restart the agent (or `/reload`). Try one-off: `pi -e ./pi-keepalive/index.ts`.
Slash command: `/keepalive [status|on|off]`.

## What it does

| Provider | Policy |
|---|---|
| Any non-Anthropic base URL | `GET {base}/v1/cache/policy?alias=<model>&session=<session id>`; warms only rows with `status: "enabled"`, using `safe_refresh_s`, `max_idle_s`, `refresh_on_read`. Cached 10 min, 5 s timeout, no redirects, exponential backoff on failure. |
| `api.anthropic.com` | Documented TTL: 5 min (or 1 h if the request uses `ttl: "1h"`), refresh at TTL − 30 s (5 m) / TTL − 120 s (1 h); max idle 30 min. |
| Anything else | Not warmed unless you set a client TTL (`unreported_ttl`, `off` by default; `5m` to `1h`; `unreported_ttl_models` overrides per model, first match wins, never Claude). |

Gateways are not detected by name: the policy is asked of any base URL other than `api.anthropic.com` (https, or http on loopback); no answer (404, error, redirect) means no policy and Claude models use the native 5m/1h logic. The protocol is described in [`../keepalive/docs/cache-policy-protocol.md`](../keepalive/docs/cache-policy-protocol.md).

Upkeep modes (`/keepalive upkeep off|warm|compact|warmcomp`), keepalive limit, compaction threshold, TTL, price sources, ledger and miss reasons behave as in the Claude Code plugin; see [PARITY.md](PARITY.md). Gateway rows: the countdown starts at the last cache-touching request, a keepalive fires in the last 5 s before `safe_refresh_s` (never after, no catch-up), only a keepalive that read the cache renews it, warming stops at `max_idle_s` and at the keepalive limit.

Lifetime chain: native (reported) → the gateway's row (learned, documented or default; `no_cache` is never warmed) → your client TTL → monitor only. Icons: ◉ native, ✦ learned, ▣ documented, ◇ default or override, ⟳ probe, ✎ client, ⊘ no cache, ◌ unknown. `refresh_on_read` true chains keepalives; null sends one per idle period timed from the last real turn; false sends one inside the fixed window counted from the write that established the prefix. With `warmcomp`, a conversation at or over the compaction threshold is compacted instead of sending that single keepalive; below it, one keepalive is sent. A gateway that has no policy (404 or empty) leaves room for your client TTL; an answer that is unknown or older than 1 h does not, and the row is monitored (`◌ monitor (reason)` for a `monitor` row). The bar counts down to the refresh for these lifetimes (the 5m/1h control is hidden for them). Warm, compact and warmcomp all run on the active lifetime, and a keepalive fires only if it pays (`p_resume × (write − read) > read`, else the price-based limit). Prices (feed `models`, `patterns`, `write_1h`) come from `keepalive_price_url`, default `{base}/v1/cache/prices` behind a gateway, then Anthropic, then models.dev.

Footer: `[ ◕ ] ⬥ warm TTL 5m ██████████ 96% ✕ 2 prefix · ◉ ETA ~3:44 · ↻11 · read 148.1k · write 5.7k · new 2`. `/keepalive dashboard` opens the session overview as a widget.

## Built-in warmer

Pi and OMP ship their own cache warmer. Where this extension manages the session
(enabled gateway row, or direct Anthropic) it answers the `cache_warming_decision`
event with `{ action: "stop" }`, so nothing is double-warmed and our idle/miss limits
stand. Elsewhere it returns nothing and the built-in behaviour is unchanged.

## Settings (env)

| Var | Default | |
|---|---|---|
| `PI_KEEPALIVE` | on | `0` disables the extension |
| `PI_KEEPALIVE_UPKEEP` | off | off, warm, compact, warmcomp |
| `PI_KEEPALIVE_LIMIT` | default | `default`, `infinite` or a number |
| `PI_KEEPALIVE_TTL` | default | 5m or 1h |
| `PI_KEEPALIVE_UNREPORTED_TTL` | off | client TTL: off, 5m, 15m, 30m, 45m, 1h |
| `PI_KEEPALIVE_UNREPORTED_TTL_MODELS` | | per-model client TTL, e.g. `kimi*=15m, glm-5.3=off` |
| `PI_KEEPALIVE_PRICE_URL` | | custom price feed URL (`default` = gateway feed, `off` = none) |
| `PI_KEEPALIVE_COMPACT_THRESHOLD` | 100k | tokens |
| `PI_KEEPALIVE_TRANSPORT` | auto | `fetch` forces the HTTP replay path |

## How the hidden request is made

The extension API has no "complete with the session's context" call, so it replays
the **exact provider body** of the last real request, which it observes through the
`before_provider_request` event (observe only, never modified). The replay appends the
keepalive user message, caps output, and leaves everything before it byte-identical
(system, tools, history, `prompt_cache_key`/routing fields).

- **Pi**: sent through `ctx.modelRegistry.streamSimple(model, ctx, { onPayload, sessionId })`, so Pi builds auth, URL and session-affinity headers exactly as for a real request and only the body is swapped.
- **OMP 18.6.1**: `ModelRegistry` exposes `getApiKeyAndHeaders` / `getApiKeyForProvider` but no streaming call, so the body is POSTed non-streaming with `fetch` to the model's base URL (`/v1/messages`, `/chat/completions`, `/responses`), with registry auth and, where Pi provides them (`before_provider_headers`), the real request's headers.

Supported APIs: `anthropic-messages`, `openai-completions`, `openai-responses`. Anthropic budget thinking (`thinking.type: "enabled"`) is not replayable (its budget derives from `max_tokens` and is part of the cache key) and is skipped with status `cache: off (...)`.

## Limitations

- OMP fetch path: if a provider needs request headers the extension cannot see (OMP has no headers event), e.g. a different routing/affinity header, the keepalive may be served by a different upstream and read 0. That is detected (read must be > 0), counts as a miss and stops warming; it costs one small request.
- The keepalive appends a user message after the last request's final message, so it reads the prefix that request wrote; it does not include the assistant reply that followed.
- Each keepalive is billed like a cache read of the prefix plus ~1 output token.
- Only `message_end` assistant usage with `cacheRead`/`cacheWrite` > 0 anchors the cache; providers that do not report cache usage are never warmed.

## Develop

```sh
npm test           # node --test, no network
npm run typecheck  # uses ../keepalive/node_modules/.bin/tsc
```
