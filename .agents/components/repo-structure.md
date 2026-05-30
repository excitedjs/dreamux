# Component: repo structure

Rush + pnpm monorepo since issue #4. The `@excitedjs/dreamux` package
under `/packages/dreamux/` is the only project today, but the layout is
ready for additional packages without a second restructure.

## Top-level

| Path | Purpose |
|---|---|
| `/rush.json` | Rush project list + pnpm/Node version pins |
| `/common/config/rush/` | Rush command definitions (`command-line.json`), pnpm `.npmrc`, version policies, generated `pnpm-lock.yaml` |
| `/common/scripts/install-run-rush.js` | Bootstrap that shells out to `npx @microsoft/rush@<version>` (see [decision 0001](../decisions/0001-rush-pnpm-monorepo.md)) |
| `/common/temp/` | Rush working dir (gitignored) |
| `/packages/dreamux/` | The `@excitedjs/dreamux` package |
| `/bin/` | Thin shims that forward to `/packages/dreamux/bin/` so pre-monorepo PATH entries keep working |
| `/.agents/` | This knowledge base |
| `/.github/workflows/` | CI |
| `/CLAUDE.md` | Always-loaded agent operating rules; `/AGENTS.md` is a symlink |

## The `@excitedjs/dreamux` package

Source modules grouped by concern (issue #2's modular split is preserved
verbatim through the move):

| Path | Concern |
|---|---|
| `src/admin/` | Unix socket admin protocol + method handlers |
| `src/cli/` | Entry-point CLIs: `dreamux.ts` (new unified router), `server.ts`, `server-ctl.ts` |
| `src/codex/` | Codex WS+Unix JSON-RPC client, supervisor, turn collector, init handshake |
| `src/db/` | SQLite schema + repository |
| `src/dispatcher/` | DispatcherRuntime, TurnManager, fail-fast approval handler |
| `src/feishu/` | Bot adapter, content / render (copied verbatim from claudemux) |
| `src/runtime/` | Path builders, env-only secrets, codex-args parser |
| `src/server.ts` | Top-level `Server` class wiring everything together |
| `db/migrations/0001_init.sql` | Initial SQLite schema |
| `bin/dreamux` | Unified CLI launcher (`dreamux server start`, `dreamux dispatcher ...`) |
| `bin/server`, `bin/server-ctl` | Backward-compat aliases shipped before the monorepo split |
| `tests/` | vitest: smoke (16), bin-launcher (8), codex-0134-live (4) |

## Two installation paths

| Method | When |
|---|---|
| `cd packages/dreamux && npm install && npm test` | Single-package workflow; matches pre-monorepo muscle memory |
| `node common/scripts/install-run-rush.js update` then `rush build && rush test` | Monorepo workflow; required once a second package lands |

Both paths must keep working. CI runs the rush path; per-package
package-lock.json is kept committed so the npm path stays reproducible.
See [decision 0001](../decisions/0001-rush-pnpm-monorepo.md) for the
rationale.

## Public surface

- npm package: `@excitedjs/dreamux`
- CLI binaries installed by the package:
  - `dreamux` (preferred, see [decision 0002](../decisions/0002-cli-and-package-naming.md))
  - `dreamux-server` (legacy alias)
  - `server-ctl` (legacy alias)

## Two home directories the server touches

| Path | Purpose | Source of truth |
|---|---|---|
| `~/.dreamux/` | User-editable global config (`config.toml`). Auto-created on first boot. | The operator |
| `~/.codex-host/` | Server-owned runtime state: SQLite (`state.db`), admin socket, per-dispatcher codex sockets and logs. | The server |

The split is load-bearing: a `rm -rf ~/.codex-host` recovery never loses
user-edited settings. See [decision 0003](../decisions/0003-global-config-dir.md).
