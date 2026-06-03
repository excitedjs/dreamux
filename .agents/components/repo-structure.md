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
| `src/channel/` | Host-side Feishu gate, access state, outbound target mapping, and received-reaction ownership |
| `src/cli/` | Entry-point CLIs: `dreamux.ts` (single public command tree), `server.ts` and `server-ctl.ts` as internal delegated modules |
| `src/codex/` | Codex WS+Unix JSON-RPC client, supervisor, turn collector, init handshake |
| `src/db/` | Legacy SQLite schema + repository; targeted for removal by [top-level-design](../decisions/top-level-design.md) |
| `src/dispatcher/` | DispatcherRuntime, TurnManager, fail-fast approval handler |
| `src/feishu/` | Thin bot adapter over `@excitedjs/feishu-transport` (`createFeishuTransport` + `parseInbound`); the drifted in-tree `content`/`render`/`types` copies were deleted by #4 |
| `src/runtime/` | Path builders, env-only secrets, codex-args parser |
| `src/server.ts` | Top-level `Server` class wiring everything together |
| `db/migrations/0001_init.sql` | Legacy SQLite schema; targeted for removal by [top-level-design](../decisions/top-level-design.md) |
| `bin/dreamux` | Public CLI launcher (`dreamux serve`, `dreamux dispatcher ...`) |
| `bin/tm` | Public wrapper that forwards to the package-local `@excitedjs/tm` executable |
| `skills/dispatcher/SKILL.md` | Bundled dispatcher Codex skill copied into each dispatcher's `<cwd>/.codex/skills/dispatcher/` by onboarding |
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
  - `tm` (wrapper around the package dependency used by dispatcher skills; see
    [the dispatcher tm packaging decision](../decisions/dispatcher-tm-packaging.md))

## Runtime and Codex state

| Path | Purpose | Source of truth |
|---|---|---|
| `~/.dreamux/config.json` | User-editable dreamux config, dispatcher declarations, and local Feishu credentials. Created by `dreamux onboard`; `dreamux serve` fails loudly if it is missing. | The operator |
| `~/.dreamux/state/` | Server-owned state: `server.json`, admin socket, and per-dispatcher status/access/socket files. | The server |
| `~/.dreamux/state/<id>/status.json` | Dispatcher runtime status and saved Codex `thread_id`. | The server |
| `~/.dreamux/state/<id>/access.json` | Dispatcher-local Feishu access gate state. | The server / operator tools |
| `~/.dreamux/state/<id>/codex.sock` | Runtime-created Codex app-server Unix socket for that dispatcher. | The server |
| `~/.dreamux/logs/` | Server and per-dispatcher logs, including Codex app-server logs. | The server |
| `~/.codex/` | Codex global default home: auth, memory, and config used by dispatcher app-server processes. | The operator / Codex |
| `<dispatcher cwd>/.codex/skills/dispatcher/SKILL.md` | Dispatcher skill copied by `dreamux onboard`. | dreamux installer |

The split is load-bearing: a `rm -rf ~/.dreamux/state ~/.dreamux/logs`
recovery never loses user-edited dreamux settings or global Codex auth.
Dispatcher app-server processes do not set `CODEX_HOME`; they use Codex's
global default home for auth, memory, and config. The dispatcher skill is
workspace-local. See [top-level-design](../decisions/top-level-design.md) and
[dispatcher-tm-packaging](../decisions/dispatcher-tm-packaging.md).
