# Agent Router tools

Prompt-cache and model-routing tools for Claude Code, OMP and Tern, installed from one marketplace. Each works on its own; together they share what each knows.

| Plugin | What it does | Commands |
| --- | --- | --- |
| [**agent-router**](agent-router/README.md) | Assigns an exact model and effort to each subagent role and to agent team teammates, from your Anthropic-compatible endpoint, and records routing and usage | `/agent-models`, `/agent-models-apply`, `/agent-router:routes` |
| [**keepalive**](keepalive/README.md) | Shows how well every conversation, subagent and teammate reuses its prompt cache, sets each one's cache TTL, and keeps an idle cache warm or compacts it before it expires | `/keepalive`, `/keepalive-settings` |
| [**pi-keepalive**](pi-keepalive/README.md) | Keepalive for OMP and Pi: the same cache bar, dashboard, upkeep and gateway cache policy, as an extension. In OMP it installs from the marketplace as `keepalive` | `/keepalive` |
| [**tern-keepalive**](tern-keepalive/README.md) | A Tern plugin for Keepalive in OMP panes: the cache bar in Tern's status line, a native dashboard and settings page, and palette commands | Tern palette: Keepalive |

## Install

For step-by-step setup, settings and troubleshooting, see [keepalive/INSTALL.md](keepalive/INSTALL.md).

### Claude Code

```text
/plugin marketplace add alexandernicholson/agent-router
/plugin install agent-router@agent-router-tools
/plugin install keepalive@agent-router-tools
```

Both need Claude Code 2.1.289 or newer with function hooks enabled (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`) and Node.js 22 or newer. Agent Router also needs an Anthropic-compatible endpoint; Keepalive works with any.

### OMP

OMP reads the same marketplace (its catalog is `.omp-plugin/marketplace.json`, which offers Keepalive):

```text
/marketplace add alexandernicholson/agent-router
/marketplace install keepalive@agent-router-tools
```

or from a shell, `omp plugin marketplace add alexandernicholson/agent-router` and `omp plugin install keepalive@agent-router-tools`. Restart the session (or `/reload`) to load it, and update with `omp plugin upgrade keepalive@agent-router-tools`. Agent Router isn't offered for OMP: OMP assigns models to agents itself (`modelRoles`, `task.agentModelOverrides`). Pi loads [pi-keepalive](pi-keepalive/README.md#install) as an extension directory.

### Tern

In Tern, add the [Tern plugin](tern-keepalive/README.md#install) beside Keepalive in OMP:

```sh
tern plugin install github.com/alexandernicholson/agent-router/tern-keepalive
```

## Together

Agent Router writes a small routes file for each session. Keepalive reads it, so each request is measured against the model Agent Router routed it to, subagents and teammates are named by their role, and a lead's dashboard finds every split-pane teammate. Neither plugin calls the other: each has its own data directory, and the routes file is the only thing they share.

Claude Code runs each plugin's hooks in the order the plugins are listed in your settings, the first listed outermost. Either order works: Keepalive takes each request's model from the published routes rather than from the hook chain.

## Development

GitHub Actions checks all Node suites and TypeScript components on Ubuntu/macOS with Node 22/24, plus a 100% Node coverage gate. See [CI and native test setup](docs/ci.md) for enabling Claude Code Mod tests, the full 100% coverage gate, and validation requiring Tern or real Pi/OMP clients.

```text
.claude-plugin/marketplace.json   Claude Code marketplace catalog (Agent Router, Keepalive)
.omp-plugin/marketplace.json      OMP marketplace catalog (Keepalive, from pi-keepalive/)
shared/                           Code both plugins use, and its tests
  lib/                            Records, bridge runner, routes contract, text and model helpers
  hooks/                          Bridge call used by both hooks modules
  types/claude-code.d.ts          Claude Code 2.1.289 function hook declarations
agent-router/                     The Agent Router plugin
keepalive/                        The Keepalive plugin
pi-keepalive/                     Keepalive as a Pi/OMP extension
tern-keepalive/                   Tern plugin (Luau) for pi-keepalive in OMP panes
scripts/sync-shared.mjs           Copies shared/ into each plugin
```

Claude Code only loads a plugin's own files, so each plugin carries a copy of `shared/` in `lib/shared/` and `hooks/shared/`. Edit `shared/`, then run `npm run sync`. `npm test` fails if a copy differs.

```bash
npm test             # shared library, copies, and each plugin's Node tests
npm run test:mod     # each plugin's function-hook tests, through claude plugin test
npm run typecheck
npm run coverage     # every suite with coverage; fails below 100%
npm --prefix keepalive run test:cache-live   # Keepalive and Agent Router against the real claude binary
```

Set `CLAUDE_BINARY` to test a particular Claude executable. The live suite runs both plugins against a local mock of the API and checks the cache TTL every request carries, for the main conversation, foreground, background and nested subagents, in-process and split-pane teammates, keepalives, compactions and retries, alone and while agents with other TTLs are answering. Its in-process teammate and upkeep cases drive an interactive session and need `tmux`; without it they are skipped.

`npm run coverage` measures the Node tests with c8 and the function-hook tests by instrumenting each hooks module before `claude plugin test` runs it, then writes one report to `coverage/`. Name `node`, `agent-router` or `keepalive` to run only those, add `--gaps` (with `--file=<part of a path>`) to list what is not covered, or `--html` for a browsable report.

## License

MIT
