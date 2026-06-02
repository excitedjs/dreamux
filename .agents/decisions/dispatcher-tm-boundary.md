# Dispatcher tm Boundary

- **Status:** Accepted
- **Date:** 2026-06-02
- **Affects:** `/packages/dreamux/src/server.ts`, dispatcher runtime, tm adapter boundary
- **PR / Issue:** [PR #15](https://github.com/excitedjs/dreamux/pull/15)

## Context

PR #15 initially explored server-owned Codex teammate runtimes. The clarified
architecture keeps the long-running process boundary narrower: the agent runtime
has one resident dispatcher, and that dispatcher is a Codex app server whose
lifecycle matches the dreamux server.

The `tm` boundary remains command-based. Dispatcher work invokes `tm` commands
to start and manage tm-backed work. `tm` must not recursively start another
`tm`.

## Decision

dreamux server hosts dispatcher processes only. It does not own server-side
`tm` teammate daemons, `codex_teammates` state, teammate admin methods, or
teammate resume/replacement semantics.

The dispatcher may invoke the `tm` CLI. The tm package owns whatever process
and routing behavior sits behind that command boundary.

## Consequences

- No `teammate.*` admin API or `dreamux teammate` CLI in dreamux.
- No `codex_teammates` database table or server runtime slot.
- Restart behavior for tm-launched work is not a dreamux server resume problem;
  the server's durable lifecycle concern remains the dispatcher.
- If future work needs loss or resume signaling for tm-managed work, add it to
  the tm or dispatcher protocol explicitly instead of inventing server-owned
  teammate state.
