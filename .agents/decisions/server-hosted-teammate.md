# Server-hosted TeamMate

- **Status:** Superseded for current implementation by
  [provider-architecture-realignment](provider-architecture-realignment.md)
- **Date:** 2026-06-06
- **Affects:** Dispatcher Service, TeamMate scheduling MCP, dispatcher state,
  task history/result retrieval, runtime completion delivery
- **PR / Issue:** [issue #110](https://github.com/excitedjs/dreamux/issues/110);
  supersedes [dispatcher-tm-boundary](dispatcher-tm-boundary.md)

> Current code no longer has the task ledger or worker-provider tree described
> below. Issue #135 / PR D replaced them with named, semi-resident TeamMate
> agents owned by Dispatcher Service, backed by one `AgentRuntime` interface and
> identity/history state under `~/.dreamux/state/<dispatcher-id>/teammate/`.

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
  `execution_available` and each provider's `worker_available` come from it. In
  PR2 the default catalog is empty, so every provider is worker-unavailable and
  `execution_available` is false; only an injected catalog (the fake in tests)
  flips them. **PR3 supersedes this default** — see below.

Deferred to later #126 slices (unchanged from PR1, plus): real Codex/Claude
worker execution; worker runtime-handle persistence on the task record; process
death / orphan reconciliation (PR2 proves "source of truth after failure" via a
provider-reported failure, not a real crash); `cancel_task`/`resume_task`/
`get_logs` MCP tools.

## Issue #126: TeamMate MCP parity — PR3 (real Codex worker provider)

PR3 lands the first **real** worker behind the PR2 seam: `builtin:codex` now
performs actual execution, with **no hidden `tm` CLI shell-out**. A dispatcher
can `run_task` → real Codex executes → `await_completion` wakes on the real
completion → `pull_result` returns the real assistant text, MCP-only.

Real Codex worker (`/packages/dreamux/src/teammate/worker/codex-provider.ts`):

- **One task = one Codex turn.** A Codex turn is itself a full agentic loop, so
  the task prompt drives a single `turn/start`; `turn/completed` →
  `onCompleted(lastAssistantText)`, then the per-task app-server is reaped.
- It reuses the dispatcher's own Codex primitives (`CodexProcess`,
  `CodexWsClient`, `performInitializeHandshake`, the turn collector, the
  fail-fast approval handler) and the **same** per-dispatcher launch config
  (bin, `approval_policy=never`, sandbox, env, handshake timeout), so a worker is
  never more permissive than its dispatcher. It wires **no MCP servers** into the
  worker, which structurally enforces the no-nested-dispatch boundary.
- `startSession` returns once the turn is *submitted* (commit `running` →
  subscribe → `turn/start`); completion arrives asynchronously via the
  notification stream. It never blocks for the whole task, so `await_completion`
  stays meaningful. A pre-`onRunning` failure (spawn/handshake/thread-start)
  returns a retryable `unavailable` (task stays `accepted`); a failure after
  `running` (turn/start RPC failure, connection drop) fires `onFailed` and lands
  a durable, pull-able `failed` result. The session guarantees exactly one
  terminal callback.
- **Realpath target confinement (the PR1-deferred step).** PR1 confined the
  target lexically and deferred symlink/realpath confinement to this slice,
  "to be done when the path actually exists." Before spawning, the worker
  canonicalizes both the dispatcher dir and the target through their longest
  existing prefix and re-asserts containment, so a symlinked target cannot root
  a `sandbox=workspace-write` codex outside the dispatcher tree. A violation
  throws loudly (no process is created) — it is not a retryable `unavailable`.
- **Steer = a folded `turn/start` onto the active turn**, the exact mechanism the
  dispatcher runtime already relies on in production (`turn-manager.ts`:
  "inbound submission folds onto Codex's active turn"), so the worker advertises
  `modes.steer: true`. `queue`/`interrupt` are not distinct capabilities yet and
  their dispositions are rejected (the input then stays `queued` in the ledger).
- The provider never writes the ledger; the execution service remains the sole
  ledger writer.

Server wiring change (supersedes the PR2 "default empty catalog" note above):

- The **default** `teamMateWorkers` catalog now wires the real Codex worker
  (`defaultRef: builtin:codex`), so a production `dreamux serve` executes for
  real and `get_capabilities` reports `builtin:codex` as worker-available
  (`builtin:claude-code` stays unavailable until its own slice — **PR4 lands that
  slice, see below**). The worker
  reuses the server's `codexProcessFactory`/`codexClientFactory` test seams, so a
  fake-codex test drives it without spawning a real binary. Tests still fully
  control execution by injecting `teamMateWorkerProviders` — the fake provider,
  or an explicitly empty catalog for the deliberate no-worker (`provider_unavailable`)
  path.
- The default worker is Codex **regardless of the dispatcher's own runtime** — a
  `builtin:claude-code` dispatcher also gets TeamMate MCP, and its tasks run on
  the Codex worker until the Claude Code worker slice lands. So the server's
  worker codex-config resolver returns the dispatcher's own config only for a
  `builtin:codex` dispatcher and the built-in **defaults** for any other (or
  unknown) dispatcher; it must not call `dispatcherCodexConfig()` for a non-Codex
  dispatcher, which throws. This keeps `run_task` from a non-Codex dispatcher
  from accepting and then hard-failing.
- `Server.shutdown()` calls `execution.reapAll()` to release live worker
  app-servers (a new `TeamMateWorkerSession.dispose()` — reap with **no** ledger
  transition); the affected task stays `running` for the deferred
  orphan-reconciliation path rather than being force-failed.
- New path builders in `runtime/paths.ts`: the per-task worker Codex socket
  (`state/<id>/teammate/w/<hash>.sock`, hashed + budget-guarded so it fits the
  Unix socket byte limit) and per-task app-server logs
  (`logs/codex-app-server/teammate/<id>/<taskId>.log`).

Deferred to later #126 slices (in addition to PR2's list): multi-turn persistent
worker sessions, resume/recovery, a true `interrupt`/turn-abort primitive and a
distinct `queue` disposition; orphan reconciliation / restart re-execution of
`running` tasks; log redaction and a `get_logs` MCP tool; the real Claude Code
worker (the seam stays runtime-agnostic).

## Issue #126: TeamMate MCP parity — PR4 (real Claude Code worker provider)

PR4 lands the **second** real worker behind the PR2 seam: `builtin:claude-code`
now performs actual execution too, with **no hidden `tm` CLI shell-out**. TeamMate
MCP supports both workers; the seam stays runtime-agnostic.

Real Claude Code worker
(`/packages/dreamux/src/teammate/worker/claude-code-provider.ts`):

- **One task = one turn**, like the Codex worker, but over the dispatcher
  runtime's own resident stream-json primitive (`claude-code/supervisor.ts`,
  `claude-code/rpc.ts`, and `claude-code/stream.ts`) through the same injectable
  `ClaudeCodeSessionFactory` seam. The task prompt is submitted as the single
  `user` turn; `submitTurn` resolves only at the terminal `result` (a Claude Code
  turn is itself a full agentic loop) → `onCompleted(text)`, then the resident
  child is reaped. An error `result`, a mid-turn child exit, or the per-turn
  deadline → `onFailed`. `submitTurn`'s promise is the single terminal signal, so
  no separate `setOnExit` wiring is needed in the one-turn model.
- It reuses the dispatcher's per-dispatcher Claude Code launch config (bin, model,
  permission_mode, env, `turn_timeout_ms`) and wires **no MCP servers** — a worker
  is launched with an empty `{ mcpServers: {} }` `--mcp-config` doc, structurally
  enforcing the no-nested-dispatch boundary.
- `startSession` returns once the turn is *submitted* (commit `running` →
  fire-and-forget `submitTurn`); a pre-`onRunning` failure (spawn) returns a
  retryable `unavailable` (`TEAMMATE_CLAUDE_CODE_WORKER_START_FAILED`, task stays
  `accepted`). The session guarantees exactly one terminal callback under
  interleaved completion / child-exit / cancel / dispose.
- **steer:false (honest, not misleading).** Unlike the Codex worker's folded
  `turn/start`, the resident session is strictly serial with no mid-turn fold
  primitive (the dispatcher's own claude-code runtime queues a follow-up as a
  *subsequent* turn, never folding). So the single-turn worker advertises
  `modes.steer:false` and rejects `send_input` while live, which keeps the input
  `queued` in the ledger (PR1 behaviour). `get_capabilities` therefore reports
  `builtin:codex` (steer:true) and `builtin:claude-code` (worker_available:true,
  steer:false) side by side. Honest live steer/queue/interrupt for Claude Code is
  deferred.

Shared / server wiring changes:

- **Realpath target confinement is now a shared primitive**
  (`worker/confine.ts`: `resolveConfinedWorkerCwd` / `canonicalizeExisting`),
  extracted verbatim from PR3's codex-provider so both workers run the identical
  pre-spawn containment check (a symlinked target cannot root a worker outside the
  dispatcher tree; a violation throws loudly, no process created). PR3's
  codex-provider now imports it — this is why a Claude Code PR touches
  codex-provider.ts.
- The **default** `teamMateWorkers` catalog now wires **both** real workers.
  `defaultRef` stays `builtin:codex`; a task selects the Claude Code worker by
  pinning `provider_ref: builtin:claude-code` (`run_task` / `execute_task` already
  plumb `provider_ref`). Default routing is deliberately **not** dispatcher-aware
  (kept a pure addition); routing the claude-code dispatcher's tasks to the
  claude-code worker by default is a possible later decision.
- The server's worker claude-config resolver mirrors the codex one: it returns the
  dispatcher's own config only for a `builtin:claude-code` dispatcher and the
  built-in **defaults** for any other (or unknown) dispatcher — it must not call
  `dispatcherClaudeCodeConfig()` for a non-claude-code dispatcher, which throws.
  This keeps a `builtin:codex` dispatcher that pins the claude-code worker from
  accepting and then hard-failing (the mirror of PR3's non-Codex regression).
- A `claudeCodeWorkerSessionFactory` `ServerOptions` test seam threads a fake
  resident session into the default catalog's claude worker, so server/smoke
  tests drive the real provider path without spawning a real `claude`.
- New path builders in `runtime/paths.ts`: the per-task worker Claude MCP config
  doc (`state/<id>/teammate/workers/<taskId>.mcp.json`) and per-task resident-child
  stderr log (`logs/claude-code/teammate/<id>/<taskId>.stderr.log`).

Deferred (in addition to PR3's list): honest live steer/queue/interrupt for the
Claude Code worker; multi-turn persistent claude-code worker sessions and resume.

## Issue #126: TeamMate MCP parity — PR5 (control/query: cancel + logs)

PR5 closes the remaining gap that forced a dispatcher to shell out (a `tm` CLI,
a process kill, or tailing a log file) for normal orchestration. The seven `tm`
control/query verbs are dispositioned explicitly:

- **status / history / last / poll** — already served since PR1 by `list_tasks`,
  `get_task` (its `events[]` IS the history, plus `inputs[]`), `pull_result`
  (defaults to the latest result-bearing task), and `await_completion` (bounded
  server-side wait; a timeout returns a `still_running` snapshot, not an error).
  No new tool.
- **cancel / logs** — added this slice as two additive MCP tools.
- **resume / multi-turn** — deferred; both built-in workers are one-turn (Codex
  one turn, Claude single-turn), so resume of a terminal/orphaned task waits on
  the (still-deferred) orphan-reconciliation path.

Two new dispatcher-facing MCP tools (admin methods `mcp.teammate.cancel` /
`mcp.teammate.logs`):

- **`cancel_task(task_id, note?)`** — stop a task without an out-of-band kill.
  The execution service gains `cancel()`: it drives a live in-process session's
  `cancel()`, whose provider `onCancelled` callback is the SOLE writer of the
  `cancelled` ledger close + wait-broker notify (exactly one close, one notify).
  With no live session here (accepted/queued, or a `running` task orphaned across
  a restart) the server closes the ledger directly via `recordClose('cancelled')`
  and notifies. A terminal task is an idempotent no-op (`status:
  already_terminal`). An orphaned-running task's ledger is closed but its process
  cannot be reaped by a server that does not own it — consistent with the
  existing orphan deferral. The close status is fixed to `cancelled` (+ optional
  `note`); the richer `tm kill --status` disposition enum stays out of cancel.
- **`get_task_logs(task_id, max_bytes?, stream?)`** — a bounded tail of a
  worker's DIAGNOSTIC logs (Codex app-server stdout protocol frames + stderr;
  Claude resident-child stderr — the Claude stdout NDJSON data plane is consumed
  in-process and never lands on disk), NOT the clean result (that is
  `get_task`/`pull_result`/`await_completion`). The read side lives in
  `teammate/worker-logs.ts`: it maps the **effective** worker ref to its log
  file(s) via `runtime/paths.ts` and reads the last N bytes (default 16 KiB,
  capped at 128 KiB). The effective ref is resolved through the worker catalog,
  so a task that did not pin a provider (ran on the catalog default) still finds
  its logs instead of reporting `logs_supported: false`. Paths are server-built
  from the ledger-validated task id, never caller input — no traversal surface.
  This also fulfils the `logs: true` capability both workers already advertise.

No config schema, persisted-format, or runtime-path change — `get_task_logs`
reads the PR3/PR4 worker log paths; `cancel_task` reuses the PR1 `recordClose`
path. Read/wait parity tools are unchanged.

## Issue #126: TeamMate MCP parity — PR7 (installed-state fixes: honest capabilities + bounded Codex turn)

Beta install-state validation surfaced two blockers that only appear in a real
service environment, not in the fake-worker tests:

- **`get_capabilities` lied about a worker whose binary cannot start.** A provider's
  `capabilities()` returned a *static* `worker_available: true`; the missing-binary
  case (`spawn claude ENOENT` when `claude` is absent) only surfaced at execute
  time as `provider_unavailable`. PR7 adds a server-side binary probe to the
  advertisement path only: `get_capabilities` resolves each built-in worker's
  binary on the dispatcher service PATH (`resolveExecutableOnPath`, async — the
  `n/no-sync` gate bans a sync `which`), and a wired-but-unresolvable worker
  reports `worker_available: false` with a reason. `execution_available` is derived
  from the probed rows (one source of truth, no skew). The probe is an injectable
  `ServerOptions.workerBinaryProbe` seam so tests stay deterministic regardless of
  the CI host PATH; an unknown/injected ref is reported available (its static caps
  stand). `capabilities()` stays synchronous and the execute path is untouched —
  it already turns ENOENT into a structured `provider_unavailable`. The probe
  proves *resolvability* (the ENOENT signal), not a successful start; the
  spawn-time failure remains the backstop for a binary that resolves but cannot run.

- **A Codex worker turn could sit `running` forever.** The worker reached `running`
  (initialize + thread start + turn submission all succeeded) but `awaitTurn` had
  no deadline, so a turn that stalled in *execution* (auth, network, or model quota)
  never terminated, and its diagnostic log was legitimately empty (Codex frames flow
  over the WS socket, not the stdout log). PR7 adds `turn_timeout_ms` to
  `DispatcherCodexConfig` (mirroring the `builtin:claude-code` `turn_timeout_ms`
  from issue #120; default 600s), and the Codex worker session races the turn
  against it. On expiry the task fails with a **self-contained** message — it states
  what succeeded and that the stall is in turn execution — so `get_task` alone
  diagnoses it without the empty log. This makes the stall *visible and bounded*; it
  is not a fix for an underlying auth/network root cause (documented residual risk).

Config note: `turn_timeout_ms` is an additive, defaulted field — old configs load
unchanged (the parser defaults it), and `dreamux onboard` now writes it so a fresh
config matches the parser's view. No persisted-format or runtime-path change.

## Issue #126: TeamMate MCP parity — PR8 (push-delivery model: worker turn fix, diagnostics, Claude Code PATH)

PR7 made a stalled Codex worker turn *bounded*; PR8 makes the push-delivery model
actually work and removes the dispatcher-side polling anti-pattern.

- **Codex turn completion robustness.** The dispatcher never awaits
  `turn/completed` (it is submit-then-return; output comes via the reply MCP
  tool), so the worker is the only production consumer of turn-completion
  detection — and the live worker test deliberately stops at the `turn/start`
  ack, leaving the real-Codex completion-field shape unverified. The worker's
  app-server hosts exactly one thread, so `subscribeTurnCollection` now takes
  `acceptAnyThread` (in `/packages/dreamux/src/codex/events.ts`): the worker
  accepts a `turn/completed` even if its `threadId` field does not match,
  defending against a protocol field-shape drift the strict dispatcher path
  never exercises. The strict, thread-scoped default is unchanged.
- **Event-trace diagnostics.** Codex protocol frames flow over the WS socket,
  not stdout/stderr, so a stalled worker's logs are empty. The worker now records
  a redacted trace (method + ids + item type — never prompt/assistant text) of
  the WS notification stream to a new per-task `events` log
  (`dispatcherTeamMateWorkerEventsLogPath`), exposed as a third `get_task_logs`
  stream for `builtin:codex`, and summarizes it into the task failure text: zero
  events after `turn/start` ⇒ "no model output, a worker-environment problem
  (auth/network/proxy/quota)"; events but no completion ⇒ the observed methods.
  PR7's bounded `turn_timeout_ms` is preserved.
- **`await_completion` is no longer a dispatcher-facing tool.** Normal
  orchestration is `run_task` → the dispatcher turn ends → the server
  delivers/wakes the dispatcher into a new turn; `get_task`/`pull_result` are the
  recovery/read path. The dispatcher must not poll or hold a turn open waiting.
  The base prompt (`src/dispatcher/base-prompt.ts`) and bundled dispatcher skills
  drop it; the wait broker + `mcp.teammate.await` admin method remain as an
  internal/test/admin-diagnostic primitive only. **Migration:** a beta caller
  that invokes the `await_completion` MCP tool now gets an unknown-tool error.
- **Claude Code worker PATH.** The managed-service unit PATH (built by both
  `dreamux onboard` and `dreamux daemon install`) now also includes the Claude
  Code install directory, so server-hosted `builtin:claude-code` workers can
  resolve `claude` (the prior gap behind a PR7-honest `worker_available: false`).
  `DREAMUX_CLAUDE_BIN` overrides; resolution is best-effort so a codex-only
  install is unaffected (a warning names the missing bin). **Rebuild:** rerun
  `dreamux daemon install` / `onboard` to regenerate the unit PATH, then
  `daemon restart` to pick up the updated prompt/skills.

`tm` remains the explicit, documented fallback (resume/recovery, multi-turn
continuation, dead-session recovery, isolated worktrees, transition diagnostics);
it is never hidden behind or shelled out to from the MCP. Team Mode stays a
reservation only.

## Current TeamMate MCP capability output

After the agent-centric normalization, `spawn.agent_runtime` is an `agents[].id`,
not a provider ref. Dispatcher-facing `get_capabilities` therefore returns
`agent_runtimes[]`; each entry has an `id` that can be passed directly as
`spawn({ agent_runtime: id, ... })` plus the runtime capability fields
(`resume`, `steer`, `events`, `last`, `context`). Provider refs such as
`builtin:codex` and `builtin:claude-code` remain internal implementation
details and must not be exposed as dispatcher-facing callable selectors.

Two configured agents that use the same provider appear as distinct
`agent_runtimes[]` entries because the selector is the agent id and each entry
may carry different provider-owned config.

Claude Code Remote Control does not define the TeamMate steer contract.
Dispatcher-facing callers must trust the runtime's returned `steer.supported`
capability for Dreamux `send` steering. Remote-Control-driven external UI turns
have separate ownership/attribution semantics tracked in
[issue #161](https://github.com/excitedjs/dreamux/issues/161).

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
