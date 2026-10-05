# Agent Router tools

Two Claude Code Mods, installed from one marketplace. Each works on its own; together they share what each knows.

| Plugin | What it does | Commands |
| --- | --- | --- |
| [**agent-router**](agent-router/README.md) | Assigns an exact model and effort to each subagent role and to agent team teammates, from your Anthropic-compatible endpoint, and records routing and usage | `/agent-models`, `/agent-models-apply`, `/agent-router:routes` |
| [**keepalive**](keepalive/README.md) | Shows how well every conversation, subagent and teammate reuses its prompt cache, sets each one's cache TTL, and keeps an idle cache warm or compacts it before it expires | `/keepalive`, `/keepalive-settings` |

## Install

Inside Claude Code:

```text
/plugin marketplace add alexandernicholson/agent-router
/plugin install agent-router@agent-router-tools
/plugin install keepalive@agent-router-tools
```

Both need Claude Code 2.1.289 or newer with function hooks enabled (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`) and Node.js 22 or newer. Agent Router also needs an Anthropic-compatible endpoint; Keepalive works with any.

## Together

Agent Router writes a small routes file for each session. Keepalive reads it, so each request is measured against the model Agent Router routed it to, subagents and teammates are named by their role, and a lead's dashboard finds every split-pane teammate. Neither plugin calls the other: each has its own data directory, and the routes file is the only thing they share.

Claude Code runs each plugin's hooks in the order the plugins are listed in your settings, the first listed outermost. Either order works: Keepalive takes each request's model from the published routes rather than from the hook chain.

## Development

```text
.claude-plugin/marketplace.json   Marketplace catalog
shared/                           Code both plugins use, and its tests
  lib/                            Records, bridge runner, routes contract, text and model helpers
  hooks/                          Bridge call used by both hooks modules
  types/claude-code.d.ts          Claude Code 2.1.289 function hook declarations
agent-router/                     The Agent Router plugin
keepalive/                        The Keepalive plugin
scripts/sync-shared.mjs           Copies shared/ into each plugin
scripts/coverage.mjs              Coverage of the Node code and of both hooks modules
```

Claude Code only loads a plugin's own files, so each plugin carries a copy of `shared/` in `lib/shared/` and `hooks/shared/`. Edit `shared/`, then run `npm run sync`. `npm test` fails if a copy differs.

```bash
npm test             # shared library, copies, and each plugin's Node tests
npm run test:mod     # each plugin's function-hook tests, through claude plugin test
npm run typecheck
npm run coverage     # every suite with coverage; fails below 100%
npm --prefix keepalive run test:cache-live   # Keepalive and Agent Router against the real claude binary
```

Set `CLAUDE_BINARY` to test a particular Claude executable.

`npm run coverage` measures the Node tests with c8 and the function-hook tests by instrumenting each hooks module before `claude plugin test` runs it, then writes one report to `coverage/`. Name `node`, `agent-router` or `keepalive` to run only those, add `--gaps` (with `--file=<part of a path>`) to list what is not covered, or `--html` for a browsable report.

## License

MIT
