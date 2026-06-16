# Reference: repo structure

Rush + pnpm monorepo since issue #4. Packages are wired through pnpm
`workspace:*` and installed via the rush path only (see
[the install-model decision](../decisions/install-model.md)):

| Package | Folder | Role |
|---|---|---|
| `@excitedjs/dreamux` | `/packages/dreamux/` | the host server |
| `@excitedjs/dreamux-types` | `/packages/dreamux-types/` | declaration-only provider-authoring contracts |
| `@excitedjs/dreamux-utils` | `/packages/dreamux-utils/` | shared provider/runtime utility helpers |
| `@excitedjs/agent-runtime-codex` | `/packages/agent-runtime/codex/` | built-in Codex Agent Runtime provider behind `builtin:codex` |
| `@excitedjs/agent-runtime-claude-code` | `/packages/agent-runtime/claude-code/` | built-in Claude Code Agent Runtime provider behind `builtin:claude-code` |
| `@excitedjs/feishu-transport` | `/packages/channel/feishu-transport/` | platform-I/O core; **sole** importer of `@larksuiteoapi/node-sdk` |
| `@excitedjs/feishu-channel` | `/packages/channel/feishu-channel/` | built-in Feishu Channel provider behind `builtin:feishu`; owns Feishu session, target resolution, provider tools, and transport usage |
| `@excitedjs/eslint-config` | `/packages/eslint-config/` | private (unpublished) shared ESLint flat config; single source of the synchronous-blocking-IO ban (see [the no-sync-io decision](../decisions/no-sync-io-lint-gate.md)) |

The channel refactor (#4) extracted the Feishu platform I/O out of the
dreamux host into `@excitedjs/feishu-transport`, so the host and the
sibling claudemux repo import one implementation instead of drifting copies.

## Top-level

| Path | Purpose |
|---|---|
| `/rush.json` | Rush project list + pnpm/Node version pins |
| `/common/config/rush/` | Rush command definitions (`command-line.json`), pnpm `.npmrc`, version policies, generated `pnpm-lock.yaml` |
| `/common/scripts/install-run-rush.js` | Bootstrap that shells out to `npx @microsoft/rush@<version>` (see [the Rush + pnpm decision](../decisions/rush-pnpm-monorepo.md)) |
| `/common/temp/` | Rush working dir (gitignored) |
| `/packages/dreamux/` | The `@excitedjs/dreamux` package |
| `/bin/` | Source-checkout `dreamux` shim that forwards to `/packages/dreamux/bin/dreamux` |
| `/.agents/` | This knowledge base |
| `/.github/workflows/` | CI |
| `/CLAUDE.md` | Always-loaded agent operating rules; `/AGENTS.md` is a symlink |

## The `@excitedjs/dreamux` package

Source modules grouped by concern (issue #2's modular split is preserved
verbatim through the move):

| Path | Concern |
|---|---|
| `src/admin/` | Unix socket admin protocol + method handlers |
| `src/channel/` | Generic Channel provider catalog/loader; provider-specific implementations live in provider packages |
| `src/cli/` | Entry-point CLIs: `dreamux.ts` (single public command tree), `server.ts` and `server-ctl.ts` as internal delegated modules |
| `src/agent-runtime/` | Generic AgentRuntime provider catalog/loader, host create-context seams, and bundled skill source selection |
| `src/config/` | Operator config loading, provider ref validation, and provider-owned raw config parsing |
| `src/dispatcher-service/` | Dispatcher lifecycle, Team/TeamMate services, Team binding/routing, and runtime/channel session orchestration |
| `src/mcp/` | Dreamux-owned MCP shims: Team, TeamMate, and provider-tool channel shim |
| `src/platform/` | Centralized paths, logging, runtime sockets, and process helpers |
| `src/server.ts` | Top-level `Server` class wiring everything together |
| `bin/dreamux` | Public CLI launcher (`dreamux serve`, `dreamux dispatcher ...`) |
| `bin/tm` | Public wrapper that forwards to the package-local `@excitedjs/tm` executable |
| `skills/` | Bundled Dreamux skills injected at runtime by role (#209 slice 6): core hands them to Dispatcher/TeamLeader runtimes as `skillSources` and the runtime applies them (Codex `skills/extraRoots/set`, Claude Code `--add-dir`) — no longer symlinked into the workspace |
| `tests/` | vitest: smoke, bin-launcher, dispatcher Codex home doctor, codex live integration |

## Installation — the rush path only

```bash
node common/scripts/install-run-rush.js update   # then build / lint / test
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js lint
node common/scripts/install-run-rush.js test
```

`rush lint` is a Rush bulk command that runs each package's `eslint .` against
the shared `@excitedjs/eslint-config`. It enforces the synchronous-blocking-IO
ban (`src/**` is a hard error; `tests/**` is audited) — see
[the no-sync-io decision](../decisions/no-sync-io-lint-gate.md). CI runs it in
the `rush` job; the pre-commit hook lints staged `.ts` as a local pre-flight.

The per-package `cd packages/dreamux && npm install` path is **retired**:
`@excitedjs/dreamux` now depends on `@excitedjs/feishu-transport` via the
pnpm `workspace:*` protocol, which `npm` cannot resolve. There is no
committed per-package `package-lock.json`. External consumers are
unaffected — the release workflow publishes a pnpm-packed tarball, where pnpm
rewrites `workspace:*` to real registry versions before npm uploads it.
See [the install-model decision](../decisions/install-model.md) (which retires
the two-paths consequence of [the Rush + pnpm decision](../decisions/rush-pnpm-monorepo.md)).

## Rush change files

Release-facing changes need Rush change files under
`/common/changes/<package>/`. Always validate them before pushing:

```bash
node common/scripts/install-run-rush.js change --verify --no-fetch
```

Rush can generate change files non-interactively when every changed package
uses the same release type and message:

```bash
node common/scripts/install-run-rush.js change \
  --bulk \
  --message "Short release note" \
  --bump-type patch \
  --target-branch main \
  --no-fetch \
  --overwrite
```

Use `--email "<git author>"` only when Rush cannot infer the author from git.
Do not paste real email addresses into chat or issue comments; some channels
treat them as sensitive data.

When changed packages need different release notes, write one JSON file per
package instead of forcing `--bulk`. The accepted schema is:

```json
{
  "changes": [
    {
      "comment": "Short release note",
      "type": "patch",
      "packageName": "@excitedjs/dreamux"
    }
  ],
  "packageName": "@excitedjs/dreamux",
  "email": "<git author>"
}
```

Then run the same `rush change --verify --no-fetch` command. This keeps
multi-package release notes precise while still using Rush as the validator.

## Public surface

- npm package: `@excitedjs/dreamux`
- CLI binaries installed by the package:
  - `dreamux` (see [the global bin decision](../decisions/global-bin-onboard-serve.md))
  - `tm` (wrapper around the package dependency used by dispatcher skills; see
    [the dispatcher tm packaging decision](../decisions/dispatcher-tm-packaging.md))

## Runtime and Codex state

The current config, workspace, state, run, cache, log, and external-home
ownership map lives in [State and paths](state-and-paths.md). Keep detailed
path semantics there so the repo-structure page stays focused on package and
install shape.

At a high level, Dreamux owns `~/.dreamux/` for config/run/state/cache/logs, and
Codex owns `~/.codex/` for its auth, memory, and config. Dispatcher app-server
processes do not set `CODEX_HOME`; they use Codex's global default home.
Bundled skills are injected at runtime by role (#209 slice 6), not written into
the workspace. See [State and paths](state-and-paths.md),
[top-level-design](../decisions/top-level-design.md), and
[dispatcher-tm-packaging](../decisions/dispatcher-tm-packaging.md).
