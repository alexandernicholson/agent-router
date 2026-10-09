# Keepalive: install and use

Keepalive shows how well your prompt cache is reused and keeps an idle cache warm, so you pay the cheap cache-read price on your next turn instead of rewriting the whole prompt.

Tested on a fresh Ubuntu 24.04 container with Claude Code 2.1.295 and Node.js 22.

## 1. Before you start

| Need | Check |
|---|---|
| Claude Code 2.1.289 or newer | `claude --version` |
| Node.js 22 or newer | `node --version` |
| `git` (the plugin marketplace is a git repository) | `git --version` |
| Function hooks enabled | `export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in your shell profile, or in the `env` block of `~/.claude/settings.json` |

Set up your inference gateway first.

## 2. Install

From a terminal:

```sh
claude plugin marketplace add alexandernicholson/agent-router
claude plugin install keepalive@agent-router-tools
```

Or inside Claude Code:

```text
/plugin marketplace add alexandernicholson/agent-router
/plugin install keepalive@agent-router-tools
```

Restart Claude Code (or run `/reload-plugins`). The cache bar appears above the prompt after your first request.

## 3. Turn on warming

Keepalive starts in **monitor-only** mode: it shows the cache but does not send keepalives. Choose an upkeep mode:

```sh
claude plugin install keepalive@agent-router-tools --config cache_upkeep=warm
```

or run `/keepalive-settings` inside Claude Code and set **Main conversation upkeep**:

| Mode | What it does |
|---|---|
| `off` | Shows the cache only (default) |
| `warm` | Sends a tiny keepalive just before the cache expires, while it saves more than it costs |
| `compact` | Compacts a large conversation while it is still cached instead of letting it expire |
| `warmcomp` | Warms first; compacts large conversations it would not be worth warming |

Click the mode button on the bar to change it for the current session only.

## 4. Read the cache bar

```text
[ ● ] ⬥ warm TTL 5m ██████████ 99% · ◉ ETA ~4:59 · ↻9 · read 51.3k · write 9 · new 1
```

| Part | Meaning |
|---|---|
| `[ ● ]` dial | Time left: `●` just used → `◕ ◑ ◔` → `○` expired. Click it to open the dashboard |
| `⬥ warm` | Current upkeep mode (click to change) |
| `↻9` | Keepalives left before warming stops |
| `TTL 5m` | Requested cache lifetime for Claude models (click to switch 5m / 1h) |
| `99%` | Cache hit rate over the last 10 requests |
| `◉ ETA ~4:59` | Where the lifetime comes from, and the countdown to the next keepalive or expiry |
| `read / write / new` | Last request's tokens read from cache, written to cache, and sent uncached |

**Lifetime icons**

| Icon | Source |
|---|---|
| `◉` | Reported by the provider (Claude) |
| `✦` | Learned by the gateway from real traffic |
| `▣` | Documented by the provider (e.g. OpenAI's 30-minute guarantee) |
| `◇` | Set by your gateway administrator |
| `⟳` | Gateway is still probing (starts at 30 minutes, shortens on misses) |
| `✎` | Your own TTL setting |
| `⊘` | The model does not cache |
| `◌` | Unknown or monitor only: nothing is warmed |

A red `✕ 2 prefix` chip means recent cache misses and their cause (`prefix`, `expired`, `model`, `TTL`).

## 5. Dashboard

Run `/keepalive` (or click the dial):

```text
Prompt cache · all agents
Now      ██████████ 99% over the last 2 requests
Session  ██████████ 99% over 2 requests · read 102.4k · write 9 · new 20
●●
```

One dot per request, oldest first: `●` good, `◐` fair, `○` poor, `✕` miss, `·` keepalive, `◆` compaction. Select an agent to see its requests, lifetime and keepalives.

## 6. Settings

Run `/keepalive-settings`, or pass `--config KEY=VALUE` to `claude plugin install`:

| Setting | Default | What it controls |
|---|---|---|
| `cache_upkeep` | `off` | Upkeep mode for the main conversation |
| `teammate_cache_upkeep` | `off` | Upkeep mode for split-pane teammates |
| `cache_ttl` | `default` | Starting TTL for Claude: `5m` or `1h` |
| `subagent_cache_ttl`, `teammate_cache_ttl` | `default` | Starting TTL for subagents and teammates |
| `keepalive_limit` | `default` | Stop warming after this many keepalives per idle period; `default` stops when a keepalive no longer pays for itself |
| `compact_threshold` | `100k` | Smallest conversation `compact` and `warmcomp` will compact |
| `unreported_ttl` | `off` | Your TTL for models whose lifetime nobody reports (`5m`, `15m`, `30m`, `45m`, `1h`). The gateway's lifetime always takes precedence |
| `unreported_ttl_models` | — | Per-model TTLs, e.g. `kimi*=15m, glm-5.3=off` (first match wins; never applies to Claude) |
| `keepalive_price_url` | — | Your own price feed; leave empty to use the gateway's |

## 7. Update

```sh
claude plugin marketplace update agent-router-tools
claude plugin update keepalive@agent-router-tools
```

or `/plugin` → **keepalive** → **Update** inside Claude Code, then `/reload-plugins`. Check the version with `claude plugin list`.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `Executable not found in $PATH: "git"` when adding the marketplace | Install git |
| No cache bar | Check `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` and Claude Code 2.1.289+; run `/reload-plugins` |
| Bar shows `◌` and nothing is warmed | Upkeep is `off`, or the model's lifetime is unknown / not worth warming. Set `cache_upkeep`, or `unreported_ttl` for models with no reported lifetime |
| `no price found` on the dashboard | Keepalives cannot be priced, so `warm` stays cautious and `warmcomp` compacts. Prices refresh hourly; restart the session to pick them up sooner |
| Many `✕ expired` misses | Your breaks are longer than the cache lifetime; switch Claude to `TTL 1h`, or use `warm` |

## Pi and OMP

Install `pi-keepalive` from the same repository — see [`pi-keepalive/README.md`](../pi-keepalive/README.md). It shows the same bar and uses the same settings through `/keepalive set <key> <value>`.
