# 0002 — Package name `@excitedjs/dreamux`, unified `dreamux` CLI

- **Status:** Accepted
- **Date:** 2026-05-28
- **Affects:** public CLI surface, npm package name, all bin entries
- **PR / Issue:** [issue #4](https://github.com/excitedjs/dreamux/issues/4)

## Context

Pre-monorepo we shipped two binaries:

- `dreamux-server` — start the long-running server
- `server-ctl` — admin Unix-socket client (`server status`,
  `dispatcher add|remove|list|status|start|stop`)

Issue #4 specified one outward-facing CLI named `dreamux` under the
package `@excitedjs/dreamux`. Two questions to settle: what does `dreamux`
do, and what happens to the two old binaries?

## Decision

- npm package name is **`@excitedjs/dreamux`** (per issue #4).
- The primary CLI is **`dreamux`**, a router. Subcommands:
  ```
  dreamux server start
  dreamux server status
  dreamux dispatcher list
  dreamux dispatcher add --id <ID> --bot-app-id <APP_ID> --bot-secret-ref env:<VAR>
  dreamux dispatcher status --id <ID>
  dreamux dispatcher start --id <ID>
  dreamux dispatcher stop --id <ID>
  dreamux dispatcher remove --id <ID>
  ```
  `server start` execs the long-running server (the old
  `dreamux-server`); everything else forwards to the admin Unix socket
  (the old `server-ctl`).
- **Keep `dreamux-server` and `server-ctl` as aliases**: same package
  declares all three under `package.json#bin`. Operators who already
  put `<repo>/bin` on their PATH (PR #6 shipped that path; the server
  process under their session likely references it) keep working
  without touching shell config.

## Consequences

- New code, docs, and READMEs introduce `dreamux <verb>`.
- Aliases are documented as legacy in the unified CLI's help text so
  new operators discover the canonical surface.
- The aliases add zero implementation cost — they're tiny bash shims
  that exec the same underlying entrypoints (`src/cli/server.ts` and
  `src/cli/server-ctl.ts`). No code duplication.
- Repo-root `/bin/{dreamux,server,server-ctl}` shims forward to
  `packages/dreamux/bin/` for the same PATH-compat reason — the
  pre-monorepo path stays alive.
- Deprecating the aliases is a future decision (probably tied to a major
  version bump). Until then both surfaces are first-class.

## Alternatives considered

- **Drop the aliases**: rejected. The running server under any
  operator's session was launched via `<repo>/bin/server`; renaming
  silently breaks their next restart with no upgrade prompt.
- **`dreamux` shadows the server-only behavior** (no router; bare
  `dreamux` = start server): rejected. It collapses admin commands
  into a separate binary again and re-creates the two-binary split.
- **`dreamux <verb>` where each verb is its own bin**: rejected. npm's
  `bin` field would pollute `node_modules/.bin/` with many short
  names that risk collision with other globally-installed packages
  (e.g. a `start` binary).
