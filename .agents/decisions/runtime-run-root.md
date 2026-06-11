# Volatile run root and ephemeral runtime sockets

- **Status:** Accepted. Supersedes the socket-placement and
  `state/admin.sock` / `state/restart-intent.json` / `server.json` parts of
  [top-level-design](top-level-design.md).
- **Date:** 2026-06-10
- **Affects:** `~/.dreamux` layout, admin IPC path contract, Codex app-server
  socket placement, `dreamux serve` startup, `dreamux uninstall`
- **PR / Issue:** Epic issue #182, PR-1

## Decision

`~/.dreamux` splits volatile run files from durable state:

```text
~/.dreamux/
  run/                     volatile; safe to clear while no server runs
    admin.sock             stable cross-process admin IPC endpoint (+ .lock)
    restart-intent.json    one-shot daemon restart marker
    sockets/               fallback root for runtime rendezvous sockets
  state/                   durable server-owned state only
```

Path builders stay centralized: neutral builders in
`/packages/dreamux/src/platform/paths.ts` (`runRoot()`, `adminSocketPath()`,
`restartIntentPath()`); volatile socket allocation in
`/packages/dreamux/src/platform/runtime-sockets.ts`.

### Two socket classes, two contracts

- **`admin.sock` is a stable path contract.** Packaged CLI commands and MCP
  shims resolve it through `adminSocketPath()`; it stays at a fixed
  `run/admin.sock` and fails loudly when an extreme `$HOME` blows the
  `sun_path` budget. Moving it is a cross-process change: an old shim and a
  new server disagree on the path (mixed-version caveat in the changelog).
- **Runtime sockets are ephemeral rendezvous endpoints.** A Codex app-server
  socket exists only so dreamux can start
  `codex app-server --listen unix://<path>` and connect with
  `ws+unix://<path>`; resume/checkpoint never depends on the path. Each
  runtime start allocates a fresh short random name
  (`allocateRuntimeSocketPath`) under, in preference order:
  1. `$XDG_RUNTIME_DIR/dreamux/sockets/` (operator input — shared-tmp values
     like `/tmp` are rejected);
  2. `~/.dreamux/run/sockets/`.
  Shared `/tmp` / `/var/tmp` are never used; if no candidate fits the budget,
  allocation fails loudly. The old descriptive `state/<id>/codex.sock` path
  and its digest-named fallback are deleted.

### Invariants

- **Owner-only run dirs.** Dreamux-owned run/socket dirs are adopted through
  `ensureOwnerOnlyDir` (`platform/owner-only-dir.ts`), not a bare
  `mkdir(mode: 0o700)`: mode-on-create does nothing to a dir that already
  exists, so the helper also rejects a symlinked leaf, fails loud on a dir
  owned by another uid, and tightens a pre-existing group/world-traversable
  dir to 0700. Operator-owned parents (`$XDG_RUNTIME_DIR` itself) are never
  passed to it.
- **Mixed-version single-server guard.** The new server locks
  `run/admin.sock.lock`, but a still-running OLD-version server locks the
  legacy `state/admin.sock.lock` — a different path the new lock cannot see.
  Before binding, the new server probes the legacy lock
  (`assertNoLegacyAdminServer`) and fails loud if a *live* holder is found, so
  two servers never run at once (which would also break the sweep's
  single-server premise). Detection only: a stale/dead-PID legacy lock is
  ignored, and the legacy file is never read for migration, removed, or
  rewritten. The CLI injects the real legacy path; the changelog tells
  operators to stop the old daemon before upgrading.
- **No persistence.** Runtime socket paths live in supervisor/runtime memory
  only — never in identity, history, ledger, checkpoint, `status.json`, or any
  public status surface. There is deliberately **no live socket registry**
  (operator decision on issue #182): diagnostics rely on failure logs and live
  process context.
- **Supervisor owns the lifecycle.** mkdir (0700 parent), stale-socket removal
  before bind, socket removal on stop/reap — unchanged from the previous
  design.
- **Startup sweep.** `dreamux serve` clears the runtime-socket dirs wholesale
  once the admin lock is held (single-server guarantee makes every entry a
  dead crash orphan). The sweep is injected by the CLI
  (`Server` option `runtimeSocketSweep`), so tests and embedded servers never
  touch the operator's run root. This is the new root's own volatility
  contract, **not** a cleanup of old-layout files — dreamux ships no automatic
  migration/pruning of the old layout (changelog documents manual cleanup).
- **`server.json` is gone.** The path builder had no production consumer; it
  was removed rather than carried as a dead declaration.

## Why

A long TeamLeader name blew the 103-byte socket budget because the socket path
embedded the human-readable runtime tree
(`state/<dispatcher>/teammate/runtime/<name>/codex.sock`). Human-readable
identity belongs in status/history/ledger surfaces, not in volatile socket
paths; random bounded names remove the whole path-length failure class and the
digest-fallback complexity. Splitting `run/` from `state/` gives every file a
single volatility class, which the rest of epic #182 (cache, worktrees, logs)
builds on.
