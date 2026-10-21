# Continuous integration

`.github/workflows/ci.yml` runs on pull requests, pushes to `main`, and manual dispatches. Jobs use hosted, non-root runners with read-only repository access. No provider credentials are needed.

## Required deterministic checks

- **Tests and types:** Ubuntu and macOS, each on Node 22.x and 24.x. `npm test` checks shared-copy drift and runs the shared, Agent Router, Keepalive and Pi/OMP suites. `npm run typecheck` checks all three TypeScript components, including their native Mod test sources. The remote-agent fallback regression tests are included in Agent Router's Node suite.
- **Node coverage (100%):** Ubuntu on Node 24, using `npm run coverage -- node --html`. The existing script still fails on any test failure or any statements, branches, functions or lines metric below 100%. The report is uploaded for 14 days, including when the command fails. This job measures the Node suites; it does not claim native hook coverage.

Dependencies are installed with `npm ci` from the root, Agent Router and Keepalive lockfiles. Pi's typecheck deliberately uses Keepalive's TypeScript installation and has no separate dependencies. Keepalive's new lockfile pins the same TypeScript 5.9.3 artifact already used by Agent Router.

Coverage runs on Node 24 because the coverage runner uses `--test-isolation`, a flag name introduced in Node 23.6. Ordinary tests still verify the latest Node 22 release. POSIX permission tests require a non-root user; Windows is not in the matrix.

## Enable native Claude Code validation

The **Native Mod, full coverage (100%) and live cache** job is opt-in because a compatible Claude Code distribution must provide function hooks, `claude-code/testing`, and `claude plugin test`. It runs on an isolated GitHub-hosted Ubuntu runner, not a self-hosted developer machine.

Two ways to enable it:

1. Set the repository Actions variable `CLAUDE_CODE_VERSION` to an exact verified release, such as `2.1.304`. Native validation then runs on pushes to `main` and on every pull request, alongside deterministic checks.
2. Manually dispatch **CI**, select **run_native**, and supply an exact **claude_version** (default `2.1.304`). GitHub normally exposes manual dispatch after the workflow reaches the default branch.

The job installs that exact `@anthropic-ai/claude-code` npm release, enables `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, checks the executable's test command, and installs tmux. A release lacking native test support fails the job; tests are not silently skipped. The installed distribution must support these APIs; a version number alone is not a guarantee. No Anthropic key, auth token, or logged-in developer profile is supplied. Existing runners make disposable plugin/config copies and remove provider credentials for Mod tests.

It runs, in order:

```sh
npm run test:mod
npm run coverage -- --html
npm --prefix keepalive run test:cache-live
```

The full coverage command keeps the original combined Node + instrumented native hook report and its 100% requirement for all four metrics. It uploads `full-coverage` separately from `node-coverage`, including on failure. Neither the coverage script nor its source exclusions or thresholds have been changed. A skipped native job is **not** full-coverage validation. Enable the job and require its check in branch protection when compatible CLI releases are available.

The live cache suite uses a local mock HTTP API with synthetic credentials, not paid model calls. tmux enables its interactive in-process teammate and upkeep cases, which the suite otherwise skips. Native steps have explicit timeouts so an incompatible runtime cannot hang CI indefinitely.

## Validation that remains outside this workflow

| Area | Remaining requirements |
| --- | --- |
| Native hooks and combined coverage when native CI is disabled | Run the three commands above with a compatible Claude executable (`CLAUDE_BINARY` can select it), function hooks enabled, localhost listeners allowed, and tmux installed. Verify that the full report reaches 100% and no interactive cases are skipped. |
| Tern Luau plugin | There is no standalone Tern test runner or TypeScript target. Pi's Node suite includes `pi-keepalive/tests/tern.test.mjs`, covering the extension's file bridge, not Tern's Luau runtime or UI. On a Tern host, link the plugin, generate its declarations with `tern plugin types tern-keepalive`, then run `luau-lsp analyze --platform=standard --definitions=@tern=tern-keepalive/tern.d.luau tern-keepalive/*.luau`. Check `tern plugin list` for load errors and exercise the status line, dashboard, settings and palette with a focused OMP pane. See `tern-keepalive/README.md`. |
| Real Pi/OMP model integration | `pi-keepalive/e2e/` requires Docker, the documented Pi/OMP/Bun versions, a funded compatible gateway and a private credentials profile. Follow `pi-keepalive/e2e/SETUP-NOTES.md` and run the container probes for both clients. These paid, credential-dependent calls are excluded from pull-request CI. |
| Installation and interactive terminal acceptance | The Docker and interactive scripts in `keepalive/tests/install/` require the Claude installer/runtime and a terminal automation environment. Follow that directory's README; verify marketplace installation, plugin loading and rendered controls on supported clients. |

The workflow does not test actual upstream prompt-cache hits: its live Claude tests inspect requests and mocked usage. Real provider caching and client UI behavior still require the integration checks above.
