# Agent Router

Agent Router is a Claude Code Mod that assigns an exact model to each subagent role. It connects Claude Code's delegation workflow to the models offered by your Anthropic-compatible endpoint and records the routing decisions and completed-turn usage locally.

## Capabilities

- Choose separate models for scouting, code review, security review, delegated tasks, and mechanical work through a searchable endpoint catalog.
- Route built-in `Explore` and `general-purpose` calls to OMP-derived roles, and select the task model for Claude's built-in `Plan` agent.
- Apply model assignments at `agent.spawn` and maintain them through child `turn.step` requests.
- Pin endpoint and model configuration for each session.
- Inspect requested, configured, resolved, and response model identifiers with `/agent-router:routes`.
- Collect completed-turn token counts and restore saved agent assignments when a session resumes.

## Requirements

- **Claude Code with function hooks enabled.** Agent Router is verified with Claude Code **2.1.272**. Function hooks are an early-access API; keep your Claude version and generated type declarations aligned when updating the Mod.
- **Node.js 22 or newer**, available on `PATH`.
- An explicitly configured **Anthropic-compatible endpoint** that supports inference and model discovery through `GET /v1/models`.
- Five role assignments, selected from your endpoint's catalog with `/agent-models`.

Remote endpoints use HTTPS. Local endpoints can use HTTP on loopback addresses, including `localhost`, `127.0.0.1`, and `::1`.

## Install

### 1. Configure your endpoint

Use your existing Claude Code environment configuration to set `ANTHROPIC_BASE_URL` and the credentials required by your endpoint. For example, replace this reserved example URL with your endpoint:

```bash
export ANTHROPIC_BASE_URL="https://gateway.example"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
claude
```

Agent Router activates routing when `ANTHROPIC_BASE_URL` is set. An explicit `https://api.anthropic.com` endpoint is supported as well.

Model discovery reads these standard environment variables:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_BASE_URL` | Base URL of the Anthropic-compatible API |
| `ANTHROPIC_API_KEY` | Sends the `x-api-key` header when supplied |
| `ANTHROPIC_AUTH_TOKEN` | Sends a bearer `Authorization` header when supplied |
| `ANTHROPIC_CUSTOM_HEADERS` | Adds service-specific headers; nonempty values override matching headers case-insensitively |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | Includes Claude Code's endpoint-matched gateway discovery cache when enabled |

The discovery client sends `agent-router` as its User-Agent. Services with a specific client-header requirement can provide that header through `ANTHROPIC_CUSTOM_HEADERS`. Endpoints that allow unauthenticated model discovery can use their own authentication policy.

With `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, Agent Router combines fresh endpoint results with Claude Code's [gateway discovery cache](https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery). This preserves models discovered using Claude's resolved credentials, including `apiKeyHelper`, while retaining non-Claude models from the endpoint. Fresh metadata takes precedence for duplicate IDs. If direct discovery fails, the matching cached models remain available.

Claude Code owns `~/.claude/cache/gateway-models.json`; `CLAUDE_CONFIG_DIR` selects its configuration root. Agent Router reads that cache for the same endpoint and provider mode. Restart Claude Code after enabling gateway discovery so Claude can populate it.

Keep credentials in your local environment or secret-management system.

### 2. Install the plugin

Inside Claude Code:

```text
/plugin marketplace add alexandernicholson/agent-router
/plugin install agent-router@agent-router-tools
/agent-models
```

Run `/agent-models` to open the model picker. Select a role, search by model name, ID, or description, then select a catalog entry. Each selection saves through Claude Code's standard configuration system and advances to the next unassigned role.

The picker shows exact IDs and the context and output limits advertised by your endpoint. Search filters the loaded catalog locally; **Refresh catalog** fetches its latest entries. Select a model for all five roles to initialize routing.

Use **Tab** and **Shift+Tab** to move between controls; **Enter** saves the focused model.

Use a terminal at least **110 columns** wide. During interactive setup, Claude Code can also show the picker automatically at **144 columns** or wider; narrower terminals display the setup command.

## Configure roles

| Role | Configuration key | Purpose |
| --- | --- | --- |
| `scout` | `scout_model` | Read-only code discovery and research |
| `reviewer` | `reviewer_model` | Evidence-backed code quality and security review |
| `security-reviewer` | `security_reviewer_model` | Read-only vulnerability analysis |
| `task` | `task_model` | General-purpose delegated work |
| `sonic` | `sonic_model` | Mechanical updates and data collection |

The picker saves the exact model ID advertised by your endpoint. The same model can serve several roles. Model IDs may include provider prefixes, local paths, and Unicode names. For direct ID entry, use `/plugin configure agent-router@agent-router-tools`. Administrator-managed settings remain under their existing policy.

The scout and security-reviewer roles use read-only inspection tools. Reviewer uses inspection tools, read-only diff/history commands through Bash, and scouting delegation where available. Task and sonic receive the ordinary editing, command, research, and delegation tools. Claude Code's permissions, organization-managed policies, and delegation depth govern execution.

The plugin exposes OMP-derived agents such as `agent-router:scout`. Its aliases map as follows:

| Requested agent | Managed role |
| --- | --- |
| `Explore` or `scout` | `agent-router:scout` |
| `Plan` | Built-in `Plan`, using `task_model` and its original read-only definition |
| `general-purpose` or `task` | `agent-router:task` |
| `reviewer` | `agent-router:reviewer` |
| `security-reviewer` | `agent-router:security-reviewer` |
| `sonic` | `agent-router:sonic` |

The dispatch guard enforces local named roles and validates their configured models against the same discovery catalog used by the picker. Per-role assignments take precedence over the caller's requested model. Keep `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` unset when using differentiated role models.

Each initialized session retains its endpoint and model-policy snapshot. You can update saved role assignments with `/agent-models` while routing continues with that snapshot. Start a new session to apply the updated assignments. A fresh session becomes routing-ready once its five roles are configured.

The terminal prompt area shows `⇄` while routing is active. `⇄*` means saved model changes apply to your next session. Setup failures use Claude Code's warning line.

## Inspect routing

Run:

```text
/agent-router:routes
```

The report separates four kinds of evidence:

| Field | Meaning |
| --- | --- |
| Requested | Agent type and model requested by the caller |
| Effective | Role and exact model selected by the routing policy |
| Resolved | Model Claude selected when starting the child |
| Observed | Response model labels and token counts from completed turns |

`resolutionMismatch` compares the effective and resolved models. An intentional rewrite of the caller's model is recorded as a routing decision. Claude's `[1m]` context-window suffix may be omitted from response model labels.

Usage observations are keyed by agent and turn, allowing repeated completion events to be counted once. Reports include the latest turn outcome and completed-turn count. Response-model labels describe the last response of each completed turn; the usage counters describe that turn's aggregate usage.

These records provide client-side routing and usage evidence. Gateway logs supply authoritative upstream-provider and billing attribution. Gateway-side policies provide organization-wide access and spending enforcement.

## Configuration and storage

Claude Code stores plugin options through its standard plugin configuration system. Agent Router keeps routing records in the plugin's persistent data directory, represented by `${CLAUDE_PLUGIN_DATA}`. For this marketplace installation, the directory is normally:

```text
~/.claude/plugins/data/agent-router-agent-router-tools/
```

`CLAUDE_CONFIG_DIR` selects the Claude configuration root when you use a custom location. Routing records contain session and agent identities, model selections, turn outcomes, and usage counters. Prompts, answers, and credentials stay with their originating systems.

Agent Router uses Claude Code's normal startup, plugin installation, configuration, and permissions workflow.

## Development

Clone this repository and install the development dependency:

```bash
cd agent-router
npm ci
npm test
npm run test:mod
npm run typecheck
```

- `npm test` exercises policy validation, endpoint discovery, storage, and the bridge scripts.
- `npm run test:mod` exercises native routing and model-picker interactions in Claude Code using an isolated copy with explicit test fixtures.
- `npm run typecheck` checks the Mod against the bundled API declarations.

Set `CLAUDE_BINARY` to select a particular Claude executable for native tests:

```bash
CLAUDE_BINARY=/path/to/claude npm run test:mod
```

From the repository root, validate the distribution manifests:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate .
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate agent-router
```

The declarations in `agent-router/types/claude-code.d.ts` were generated by Claude Code 2.1.272 through `/plugin-types`. Regenerate them from the runtime you target when updating API usage.

### Repository layout

```text
.claude-plugin/marketplace.json   Marketplace catalog
agent-router/
  .claude-plugin/plugin.json     Plugin metadata and role configuration
  agents/                        OMP-derived role instructions and tool sets
    LICENSE                      Upstream MIT license for the agent definitions
  commands/                      User-facing routing report
  hooks/                         Native function-hook registration
  lib/                           Routing policy, discovery, and storage
  scripts/                       Plugin-owned bridge and reporting helpers
  tests/                         Regression tests and native test fixtures
  types/                         Generated Claude Code API declarations
```

## License

Agent Router's routing implementation is available under the [project MIT License](LICENSE), also included in the [plugin distribution](agent-router/LICENSE). The agent definitions are adapted from [Oh My Pi](https://github.com/can1357/oh-my-pi) and carry its complete MIT notice in [agent-router/agents/LICENSE](agent-router/agents/LICENSE). Third-party materials retain their respective licensing terms.
