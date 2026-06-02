# Server-owned Codex teammates

- **Status:** Accepted
- **Date:** 2026-06-02
- **Affects:** server runtime, admin socket methods, `dreamux teammate ...`, SQLite schema, runtime paths
- **PR / Issue:** this PR

## Context

Codex teammate daemons need to survive short-lived CLI invocations. A CLI-owned
detached daemon registry is fragile under parent-death cleanup: the caller can
successfully spawn a daemon, exit, and leave the next invocation with only a
stale registry entry. The long-running dreamux server is already the process
that owns Codex app-server lifecycles for Feishu dispatchers, so it is the
natural owner for Codex teammates too.

This is separate from Feishu dispatchers:

- Dispatchers bind bot identity, inbound buffering, outbound retries, and a
  per-dispatcher Codex daemon.
- Codex teammates bind only a name, cwd, Codex launch args, a thread id, and
  last-turn metadata.

## Decision

Host Codex teammate daemons inside the dreamux server and expose them through
the admin socket as `teammate.*` methods. CLI tooling can forward to those
methods with `dreamux teammate ...`; adapters such as `tm` should talk to the
server instead of spawning detached Codex daemons themselves.

Resume semantics are fail-loud and recoverable. If a saved thread id cannot be
resumed, dreamux keeps the error and the requested thread id visible; it does
not silently start a fresh thread. A later `send` retries the same thread, and
`teammate.resume` can explicitly replace the saved thread id and restart the
daemon.

The durable state lives in `codex_teammates`:

- `name` is the stable admin/CLI identifier.
- `cwd` is the existing repository/worktree directory for Codex turns.
- `codex_args_json` mirrors dispatcher-level launch overrides.
- `thread_id` lets a restarted server resume the same Codex thread lazily on
  the next send.
- `last_turn_id`, `last_assistant_text`, and `last_error` give status callers a
  cheap last-known view without parsing transcripts.

Runtime files live under `runtime_dir/teammates/<name>/`:

- `socket`
- `stdout.log`
- `stderr.log`

The teammate runtime does not create `cwd`. A missing cwd is an operator/config
error, not a directory dreamux should silently invent.

## Consequences

- A teammate daemon survives every short-lived `dreamux teammate send` or
  adapter invocation while the server process remains alive.
- A degraded runtime slot is not terminal. The next start/send tears down a
  non-ready slot and rebuilds a new Codex app-server process.
- Server restart does not keep the process alive, but it keeps the DB row and
  `thread_id`; the next `send` starts a new app-server process and resumes the
  saved thread. Boot reconciles persisted `starting`, `ready`, and `stopping`
  rows to `stopped` so status does not report a phantom live daemon.
- `teammate.spawn` creates and starts a row; if startup fails, the new row is
  rolled back so a corrected spawn does not hit a stale conflict.
- `teammate.resume` creates a row when absent, or reconfigures an existing row
  with an explicit thread id before restarting it.
- `teammate.kill` stops the daemon and removes the row. Keeping a stopped row is
  not part of this slice.
- The admin layer validates teammate names as single path-safe identifiers
  because runtime paths are server-owned filesystem contracts.
- `tm` integration is a client-adapter concern. The dreamux server owns the
  backend; the adapter still needs its own repo change to route Codex engine
  operations through the admin socket.

## Alternatives considered

- **Keep CLI-owned detached daemons:** rejected. It is the failure mode this
  decision fixes; detached children can still be killed when the parent shell is
  reaped.
- **Silent fresh-thread fallback on resume failure:** rejected. Programmatic
  teammate callers requested a specific thread; silently replacing it would lose
  context while making the caller believe continuity was preserved.
- **Fresh thread with explicit loss signal:** deferred. It would need schema and
  status fields comparable to the dispatcher `last_lost_thread_id`; this slice
  keeps the simpler fail-loud path.
- **Store teammate runtime in the existing dispatcher table:** rejected.
  Dispatchers carry Feishu-specific fields and inbound-buffer semantics that do
  not apply to direct Codex teammates.
- **Auto-create teammate cwd:** rejected. Dispatcher runtime cwd is server
  state and can be created; teammate cwd is a user-selected project/worktree and
  must already exist.
