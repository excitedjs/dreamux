# Workflow Stop Ownership and Team Dissolve

- **Status:** Implemented historical proposal; current behavior is documented in
  [Dynamic Workflow usage](../../reference/dynamic-workflow-usage.md#44-stop),
  [Current architecture](../../reference/current-architecture.md#dynamic-workflows),
  and the bundled `workflow` skill
- **Date:** 2026-08-13
- **Affects:** Workflow stop/finalization, owned TeamMate release, server
  shutdown broadcast, Team dissolve runner, workflow admin method, bundled
  workflow skill, Workflow references

## Intent

Make a successful `workflow_stop` response one truthful terminal barrier: the
Workflow record and journal are terminal and every TeamMate exclusively owned by
that run has been released before the call returns. Prevent a submitted turn
that never settles naturally from holding either the Workflow or its owning Team
open forever.

## Scope

- Change active single-run stop from immediate terminal reservation to an await
  of the existing finalization task.
- Give submitted Workflow agent turns up to five seconds to settle naturally
  after stop reservation, then cancel the remaining turns by releasing the
  run's existing exclusive TeamMate ownership.
- Stop Team-owned Workflows during accepted Team dissolve before the dissolve
  runner waits for all captured shared-worktree writers to become idle.
- Interrupt Workflow terminal waits before Server shutdown drains accepted
  admin requests, so shutdown cannot wait on a public stop that is itself
  waiting for shutdown takeover.
- Update focused Workflow and Team dissolve tests, the bundled Workflow skill,
  current architecture/user guidance, and the Rush change entry.

## Hard Constraints

- Keep the existing public result shape and durable Workflow record/journal
  versions. Do not add a `stopping` value that older readers cannot parse.
- `stopped` remains terminal everywhere. A successful active `workflow_stop`
  may return it only after status/list, the durable record and end journal, and
  owned TeamMate release agree.
- Preserve the normal natural-settle path during the five-second grace window.
  Queued, not-yet-submitted calls become stopped without spawning a TeamMate.
- Cancellation stays behind the existing `OwnedTeammateOps.releaseAllOwned`
  boundary. Workflow core must not learn Codex, Claude Code, process, or signal
  details.
- Team dissolve retains its one durable lifecycle and accepted `closing`
  receipt. It must not add a second close state machine or bypass the existing
  shared-worktree idle and safety checks.
- Dispatcher/server shutdown keeps its current fast handoff to the
  collection-wide owned-TeamMate sweep; it does not wait for the stop grace
  window.
- Do not modify installed packages, a live daemon, persistent user state,
  credentials, or global configuration.

## Lifecycle Contract

1. The first stop intent records one process-local absolute deadline of
   `intent time + 5 seconds`, closes Workflow admission, and aborts the runner.
   A stop may join a natural `completed`/`failed` terminal attempt that is
   already in progress: that attempt begins using the same deadline without
   changing its original terminal status. Repeated public stop, Team close, and
   retry attempts never reset the deadline.
2. Finalization stops the runner and drains already-accepted runner messages.
   Before any owner sweep, every established call either reaches its existing
   `submissionReady` boundary or durably settles/completes without publishing,
   so an in-flight `spawnOwned()` cannot publish a new owned TeamMate after
   cleanup snapshots the owner set. A pre-spawn stop therefore cannot strand a
   publication wait. Shutdown may interrupt this publication cutoff; under
   normal stop it is outside the natural-settle grace budget. Queued calls are
   recorded `stopped` without spawning.
3. Submitted calls may settle naturally only for the deadline's remaining
   time. Five seconds is the natural-settle grace, not a total stop SLA: runner
   message drain, ownership publication, runtime stop, persistence, and terminal
   routing retain their owner-defined completion semantics.
4. If submitted calls remain at the deadline, the run first awaits
   `releaseAllOwned(owner)`. A runtime settle whose owner route completed before
   release returns keeps its natural result. Immediately after successful
   release, without an intervening await, the run claims every still-incomplete
   call as `stopped`, appends each ordinary `result` journal event, and drains
   agent tasks and mutation persistence. Later callbacks lose to the existing
   completed-call guard.
5. Only after owner release and agent-result persistence succeed does the run
   append `end`, write the terminal record, wait until CompletionRouter reaches
   a terminal routing outcome, and evict the live entity. A Team closing fence
   may terminalize routing as unsupported; the barrier promises terminal
   routing, not actual TeamLeader receipt. Active `workflow_stop` then returns
   the durable record's real status in the unchanged `{ run_id, status }`
   shape.
6. Concurrent stops join one terminal attempt. Successful owner release is a
   prerequisite for every normal terminal status, including natural
   `completed`/`failed`; a public stop joining either path must not observe a
   terminal record while an exclusive owner remains live. If owner release
   fails before terminal commit, the attempt rejects without `end`, terminal
   record, delivery, or eviction; the run remains process-live with durable
   `running` status and closed admission. The failed attempt is cleared so a
   later stop or owner-close path retries against the original deadline when
   one exists. Runner-stop and terminal-routing cleanup errors remain contained
   by their existing compatibility behavior.
7. Stopping an already-terminal durable run remains an idempotent read of its
   terminal status. A journal failure that changes the terminal status to
   `failed` is returned as `failed`, never hard-coded back to `stopped`.
8. Server shutdown first rejects new admin admission, then synchronously
   broadcasts Workflow-terminal shutdown signals and Team-dissolve interrupts
   through already-materialized Dispatchers and Teams before draining accepted
   admin requests. This is a narrow owner capability, not early full Dispatcher
   shutdown. It wakes publication and grace waits; shutdown finalization freezes
   unresolved calls, skips a per-run release that has not begun and leaves
   cleanup to the collection-wide sweep. A release already in progress remains
   joined: skipping the grace period is not a new timeout or cancellation
   contract for `AgentRuntime.stop()`.

   A public stop taken over by shutdown throws a named
   `WorkflowStopInterruptedError`, mapped by the admin boundary to the existing
   `SERVER_SHUTTING_DOWN` code, instead of reporting a false terminal barrier.
   That rejection belongs only to the public stop wrapper after shared
   finalization; internal shutdown and sweep callers still resolve and do not
   turn takeover into a Server shutdown failure.
9. An accepted Team dissolve still only persists its receipt and raises the
   closing fence. When its runner starts, it races the existing Team-owned
   Workflow stop capability against the dissolve shutdown interrupt before
   waiting on the original captured writers. Interruption, including Workflow
   shutdown takeover, suspends the durable operation. A non-shutdown stop
   failure in the initial `waiting_for_team_idle` phase uses existing fail-open
   handling; a recovered/already-closing operation uses the existing deferred
   retry. The original writer idle barrier, second worktree assessment, and
   `closeLogically()` stop backstop remain intact.

If exclusive owner release itself fails, stop must fail loudly and retain its
retryable pre-terminal owner rather than persist a false terminal fact. Team
dissolve uses its existing fail-open/retry error handling instead of remaining
indefinitely in an unobservable wait.

## Acceptance

- A queued call is stopped without spawn, and stop returns only after the run is
  durably terminal.
- A submitted call that settles inside the grace window keeps its natural agent
  result and is released normally before stop returns.
- A submitted call that never settles is owner-cancelled after the grace window;
  missing runtime settle notification is normalized to a durable stopped agent
  result after successful release.
- An in-flight owned spawn cannot appear after a successful stop, a pre-spawn
  completed call cannot deadlock the publication cutoff, and the first-intent
  deadline is not extended by publication drain, a joined natural terminal
  attempt, or retries.
- Immediately after a successful stop response, status and list return stopped,
  the journal ends in stopped, the live run is evicted, terminal completion has
  reached a terminal routing outcome, and all run-owned TeamMates are
  closed/released.
- Concurrent stops share one attempt; a pre-terminal release failure on any
  normal terminal path is loud and retryable without any false
  `end`/terminal record/delivery/eviction.
- Shutdown interrupts both dispatcher- and Team-scope public stop waits and
  Team dissolves before admin drain, rejects only the public stop wrappers with
  `SERVER_SHUTTING_DOWN`, and leaves not-yet-started owned cleanup to the
  existing sweep without waiting five seconds. An owner release already in
  progress remains joined under the existing runtime contract.
- Team dissolve with a never-settling Workflow-owned TeamMate progresses past
  `waiting_for_team_idle` and reaches logical close after bounded cancellation.
- Team dissolve Workflow stop happens before the captured-writer idle barrier,
  remains interruptible, and routes stop failures through the existing
  fail-open or deferred-retry phase contract.
- Existing normal completion/failure status behavior and fast shutdown sweep
  behavior remain covered, with owner release now a truthful terminal
  prerequisite on those natural paths too.

## Out of Scope

- A new persisted `stopping` state, Workflow record migration, replay/resume, or
  configurable stop policy.
- Provider-specific interrupt APIs or changes to the neutral `AgentRuntime`
  interface.
- A general timeout for arbitrary `AgentRuntime.stop()` implementations; built-in
  runtimes already own bounded process teardown, and owner-release failure stays
  fail-loud.
- Replay or reconstruction of process-local Workflow ownership after restart.
  Recovery still marks durable `running` records stopped and collection shutdown
  remains the owner of orphan runtime cleanup; broader Workflow replay/resume is
  a separate architecture change.
- A guarantee that a third-party runtime violating the neutral `waitIdle()`
  contract becomes safe to delete. Team dissolve continues to preserve its
  captured-writer barrier.
- Replacing or restarting the live Dreamux daemon.
