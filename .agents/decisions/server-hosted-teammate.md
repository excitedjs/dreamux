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

## Issue #126: TeamMate MCP parity — PR1 (API/ledger foundation + event/wait)

Issue #126 makes the TeamMate MCP the executable normal path (beyond accept +
deliver). PR1 lands the contract foundation only — **no worker execution yet,
and the MCP never wraps or shells out to `tm`**.

Ledger task record bumped to **v2** (`/packages/dreamux/src/teammate/ledger.ts`):

- Lifecycle and delivery are separated into canonical `lifecycle_status`
  (`accepted|queued|running|completed|failed|cancelled`) and `delivery_status`
  (`none|pending|delivered|delivery_failed`). The old single `status` field is
  no longer persisted; it survives only as a back-compat projection
  (`legacyTaskStatus`) at the server/MCP read boundary.
- New fields: a monotonic per-task event stream `events[]` (`event_id` from 1 —
  the source of truth for the wait broker), a steerable session `inputs[]`,
  `close` metadata, and `runtime`/`target`/`target_mode`/`provider_ref`/
  `intent`/`operation_id` placeholders.
- The four delivery `record*` method signatures are unchanged, so
  `/packages/dreamux/src/teammate/delivery.ts` is untouched (it branches on
  `result.outcome`, never on `status`).
- **v1 read compatibility:** the reader migrates v1 (issue #110 PR7/PR8) records
  in memory losslessly (lifecycle/delivery/events derived from the old
  `status`/`result`/`history`) and fails loud only on an unknown future version
  (`> 2`).
- `operation_id` gives best-effort create idempotency (ledger scan; a
  cross-process index is deferred).

MCP / admin surface (`/packages/dreamux/src/mcp/teammate-mcp.ts`,
`/packages/dreamux/src/admin/methods.ts`, `/packages/dreamux/src/server.ts`):

- Existing `schedule`, `list_tasks`, `get_task`, `pull_result` stay compatible.
- New tools: `run_task` (create-and-execute normal path), `execute_task`,
  `send_input` (default mode `steer`; `queue`/`interrupt` explicit),
  `await_completion`, and read-only `get_capabilities`. With no worker wired,
  `run_task`/`execute_task` create/return but report `provider_unavailable`;
  `send_input` queues into `inputs[]`; `get_capabilities` lists both built-in
  runtimes (`builtin:codex`, `builtin:claude-code`) as worker-unavailable — PR1
  is not Codex-only.

Event/wait broker (`/packages/dreamux/src/teammate/wait-broker.ts`):

- Server-owned waiters keyed by dispatcher+task, woken after every ledger
  mutation. Race-safe: the ticket is armed before each ledger read, so a notify
  between read and wait is never lost.
- The wait is **bounded** (default 5s, hard max 30s); a timeout returns a
  structured `still_running` result with `after_event_id` to resume, never a
  tool error. The admin **server** has no idle timeout, but the admin **client**
  default is 10s, so the shim raises its client timeout to
  `waitMs + buffer` for `await_completion` only.

Target policy (owner decision): `target.path` is first-class and required for
`run_task`; absolute and relative paths are both accepted, relative resolves
against the dispatcher directory (`codex_cwd`), and the result is lexically
canonicalized and confined under that directory. Paths are local state and must
stay out of public artifacts; task summaries omit the path (realpath/symlink
hardening is deferred to the worker slice).

Team Mode reservation (owner decision — **reserved, not implemented in PR1**):
the record carries nullable `team` (`team_id`/`epic_id`/`role`/
`leader_task_id`), `origin`, and `branch` fields so a future Team (leader +
authors + reviewer over an Epic) can be added additively. The scheduling
authority boundary is `Server.assertTeamMateSchedulingAuthority`: ordinary
TeamMates still cannot nested-dispatch; a future leader's authority will be an
explicit role/capability there, never a relaxed ledger backstop.

Deferred to later #126 slices: real Codex/Claude worker execution and the
worker provider seam; `cancel_task`/`resume_task`/`get_logs`; standalone
`history`/`get_status` and `list_tasks` filters; startup redelivery/orphan
reconciliation; log redaction layer.

## Issue #126: TeamMate MCP parity — PR2 (worker provider seam + fake provider)

PR2 lands the **worker provider seam** PR1 deferred, plus an in-memory fake
provider that proves the Dispatcher Service execution orchestration end-to-end.
It still does **not** implement a real Codex/Claude Code worker and does **not**
wrap or shell out to `tm`.

Worker seam (`/packages/dreamux/src/teammate/worker/`):

- `TeamMateWorkerProvider` runs ONE task as a steerable, multi-input session
  against a local target. It is a different abstraction from the dispatcher's
  long-lived `AgentRuntimeProvider` (`/packages/dreamux/src/agent-runtime/`):
  that one models the dispatcher's own persistent runtime; a worker session is
  per-task. The seam carries no Codex-only assumptions — a Claude Code worker
  (still in epic scope) implements the same interface.
- A provider **never writes the ledger**. It drives lifecycle through callbacks
  (`onRunning`/`onCompleted`/`onFailed`/`onCancelled`); the execution service is
  the sole ledger writer, so the server-owned ledger stays the single source of
  truth.
- `TeamMateWorkerProviderCatalog` is a deliberately separate, permissive
  registry — NOT the agent-runtime catalog, which validates refs against the
  builtin capability registry and would reject an injected fake ref. Resolution
  never throws; an unknown ref maps to a retryable `provider_unavailable`.
- The fake provider (`FakeTeamMateWorkerProvider`, ref `fake`) is deterministic
  and timer-free: a test injects it and drives the lifecycle with explicit
  controls (`emitCompleted`/`emitFailed`/`emitCancelled`).

Execution service (`/packages/dreamux/src/teammate/worker-execution.ts`):

- Maps worker callbacks onto ledger transitions plus wait-broker notifies:
  `onRunning → markRunning`, `onCompleted/onFailed → reportCompletion` (the PR1
  delivery path — record-before-deliver, retain, pull fallback), `onCancelled →
  recordClose('cancelled')`. A provider-reported failure still lands a durable,
  pull-able `failed` result.
- Idempotent: a live session short-circuits a second `execute` (no double
  start); a terminal task is never re-executed.

Server wiring (`/packages/dreamux/src/server.ts`):

- A new injectable `teamMateWorkerProviders` catalog (empty by default).
  `run_task`/`execute_task` now go through the execution service; `send_input`
  records the input (`queued`) then routes it to a live session, promoting it to
  `submitted` on an accepted disposition (new `ledger.markInputSubmitted`).
- `get_capabilities` makes the worker catalog the source of truth:
  `execution_available` and each provider's `worker_available` come from it.
  **Production behaviour is unchanged from PR1** — with the default empty
  catalog every provider is worker-unavailable and `execution_available` is
  false; only an injected catalog (the fake in tests) flips them.

Deferred to later #126 slices (unchanged from PR1, plus): real Codex/Claude
worker execution; worker runtime-handle persistence on the task record; process
death / orphan reconciliation (PR2 proves "source of truth after failure" via a
provider-reported failure, not a real crash); `cancel_task`/`resume_task`/
`get_logs` MCP tools.

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
