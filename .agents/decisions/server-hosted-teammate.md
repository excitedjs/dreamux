# Server-hosted TeamMate

- **Status:** Accepted
- **Date:** 2026-06-06
- **Affects:** Dispatcher Service, TeamMate scheduling MCP, dispatcher state,
  task history/result retrieval, runtime completion delivery
- **PR / Issue:** [issue #110](https://github.com/excitedjs/dreamux/issues/110);
  supersedes [dispatcher-tm-boundary](dispatcher-tm-boundary.md)

## Context

The previous dispatcher/tm boundary kept teammate lifecycle behind the `tm` CLI
and explicitly rejected Dreamux server-owned teammate state. Issue #110 changes
that target. The operator confirmed that server-hosted TeamMate belongs inside
the Epic.

The new requirement is not "let the dispatcher agent recursively start more
agents". It is a Dispatcher Service capability with durable task ownership,
delivery retry, history, and result retrieval.

## Decision

Dispatcher Service owns TeamMate scheduling and task state.

The TeamMate scheduling MCP accepts work and returns immediately with an
accepted task id. It does not block until the task completes.

Dispatcher Service owns:

- task id allocation;
- task status and history;
- file-backed task ledger;
- delivery retry state;
- final result retention;
- result retrieval after push delivery fails.

The default ledger lives under the existing dispatcher state layout:

```text
~/.dreamux/state/<dispatcher-id>/teammate/
```

TeamMates cannot nested-dispatch TeamMates. Future TeamMate-to-TeamMate
communication, if needed, must be routed by Dispatcher Service instead of by a
dispatcher agent recursively scheduling more TeamMates.

Completion delivery is runtime-specific and goes through the selected
AgentRuntimeProvider:

- Codex: inbox plus turn trigger;
- Claude Code: task notification path.

The public retrieval UX does not have to preserve `history` or `last` names, but
the functionality must exist: list tasks, fetch a task result, fetch the latest
relevant result, and recover a final result after delivery failure.

## Current Implementation

Issue #110 PR7 implements the first server-owned TeamMate surface:

- a versioned file-backed task ledger under
  `~/.dreamux/state/<dispatcher-id>/teammate/`;
- a dispatcher-scoped `teammate-mcp` stdio shim contributed to the selected
  AgentRuntimeProvider as a runtime-neutral MCP server descriptor;
- an admin method that accepts a task, allocates a task id, persists the
  accepted task record, and returns immediately;
- a nested-dispatch guard that rejects callers marked as `teammate`.

PR7 deliberately does not start worker runtimes, deliver completions back into a
dispatcher runtime, retry failed delivery, or expose final-result/history UX.
Those remain follow-up work in the issue #110 sequence. The ledger version must
fail loudly on incompatible metadata; it must not silently rewrite or discard
completed task data.

Issue #110 PR8 adds completion delivery, bounded retry, and result retrieval on
top of PR7:

- The task record gains additive, optional `result` and `delivery` fields — no
  version bump, so PR7-written `accepted` tasks still load (absent → null; a
  present-but-malformed value still fails loud). The result is persisted BEFORE
  any delivery attempt, so it can never be lost; delivery only transitions an
  already-saved result to `delivered` / `delivery_failed`.
- Delivery goes through the runtime's `deliverTeamMateCompletion` seam — Codex
  via the public `enqueueInbound` turn path (inbox + turn trigger), Claude Code
  via its task-notification path (PR6). The delivery driver consumes only the
  `AgentRuntime` interface, never turn-manager internals, so it survives the
  planned per-dispatcher state-owner move.
- Bounded retry with backoff ends in `delivery_failed` when exhausted (or when
  the runtime is down / lacks the capability); the result stays pull-able.
- Retrieval is exposed as read-only `teammate-mcp` tools — `list_tasks`,
  `get_task`, `pull_result` — covering recent / specified / failed results and
  the post-delivery-failure pull fallback. `list_tasks` skips corrupt task files
  (reported, not fatal); `get_task` stays fail-loud for one named task.
- Completion ingest (`mcp.teammate.complete` / `Server.reportTeamMateCompletion`)
  is an admin/server seam, deliberately NOT a dispatcher-facing MCP tool, so a
  dispatcher model cannot fake a completion. Autonomous worker execution and
  cross-process redelivery-on-recovery remain follow-up work.

## Consequences

- The old "Dreamux never owns teammate state" decision is superseded.
- The `tm` packaging surface can remain useful during transition, but it no
  longer defines the long-term server boundary.
- TeamMate task state is server-owned and separated from operator config.
- Runtime adapters report delivery outcomes to Dispatcher Service; they do not
  own task history.
- Delivery implementation must coordinate with the per-dispatcher state owner
  before it lands, so completion-as-turn delivery does not bind to soon-to-move
  turn-manager internals.

## Alternatives considered

- **Keep all teammate work behind the existing `tm` CLI:** rejected because the
  server would not own task history, retry, or pull fallback.
- **Let TeamMates schedule more TeamMates directly:** rejected because recursive
  dispatch hides authority and makes task ownership unclear.
- **Make completion delivery a channel reply:** rejected because TeamMate output
  belongs in dispatcher context, not necessarily in any external channel.
