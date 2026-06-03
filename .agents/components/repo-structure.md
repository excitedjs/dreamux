# Component: repo structure

Rush + pnpm monorepo since issue #4. Three packages today, all wired
through pnpm `workspace:*` and installed via the rush path only (see
[the install-model decision](../decisions/install-model.md)):

| Package | Folder | Role |
|---|---|---|
| `@excitedjs/dreamux` | `/packages/dreamux/` | the host server |
| `@excitedjs/feishu-transport` | `/packages/channel/feishu-transport/` | platform-I/O core; **sole** importer of `@larksuiteoapi/node-sdk` |
| `@excitedjs/feishu-channel` | `/packages/channel/feishu-channel/` | per-host channel layer (placeholder today) |

The channel refactor (#4) extracted the Feishu platform I/O out of the
dreamux host into `@excitedjs/feishu-transport`, so the host and the
sibling claudemux repo import one implementation instead of drifting copies.

## Top-level

| Path | Purpose |
|---|---|
| `/.agents/plugins/marketplace.json` | Git Codex marketplace manifest for installing `codexmux` from the public repository root |
| `/codex-marketplace/` | Local Codex marketplace root for the `codexmux` plugin and dispatcher skill; not a Rush package |
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
| `src/cli/` | Entry-point CLIs: `dreamux.ts` (single public command tree), `server.ts` and `server-ctl.ts` as internal delegated modules |
| `src/codex/` | Codex WS+Unix JSON-RPC client, supervisor, turn collector, init handshake |
| `src/db/` | SQLite schema + repository |
| `src/dispatcher/` | DispatcherRuntime, TurnManager, fail-fast approval handler |
| `src/feishu/` | Thin bot adapter over `@excitedjs/feishu-transport` (`createFeishuTransport` + `parseInbound`); the drifted in-tree `content`/`render`/`types` copies were deleted by #4 |
| `src/runtime/` | Path builders, env-only secrets, codex-args parser |
| `src/server.ts` | Top-level `Server` class wiring everything together |
| `db/migrations/0001_init.sql` | Initial SQLite schema |
| `bin/dreamux` | Single public CLI launcher (`dreamux serve`, `dreamux dispatcher ...`) |
| `tests/` | vitest: smoke, bin-launcher, dispatcher Codex home doctor, codex live integration |

## Installation — the rush path only

```bash
node common/scripts/install-run-rush.js update   # then build / test
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js test
```

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

## Two home directories the server touches

| Path | Purpose | Source of truth |
|---|---|---|
| `~/.dreamux/` | User-editable global config (`config.toml`). Auto-created on first boot. | The operator |
| `~/.codex-host/` | Server-owned runtime state: SQLite (`state.db`), admin socket, dispatcher logs, and dispatcher-private Codex homes. | The server |
| `~/.codex-host/dispatchers/<id>/codex-home/` | Dispatcher-private `CODEX_HOME`: Codex config, `plugins/`, and runtime-created `app-server-control/as.sock` for that dispatcher app-server. | The server |

The split is load-bearing: a `rm -rf ~/.codex-host` recovery never loses
user-edited settings. See [the global-config decision](../decisions/global-config-dir.md).
