# Workflow stop blocks until durable terminal state and full owned release

- **Status:** Proposal
- **Date:** 2026-08-13
- **Affects:** `@excitedjs/dreamux` workflow service, teammate collection, teammate MCP surface, dispatcher/server shutdown
- **Issue:** [#328](https://github.com/excitedjs/dreamux/issues/328)

## Context

The current dynamic-workflow stop contract reserves `stopped` and returns
immediately while finalize runs fire-and-forget:

- `WorkflowRunTerminal.stop` (`packages/dreamux/src/service/workflow-service/run-terminal.ts:55-61`)
  calls `initiateStop` (`:76-82`), which reserves the outcome, sends the
  runner `abort`, and `observe`s finalize without awaiting it.
- `finalize` (`packages/dreamux/src/service/workflow-service/run.ts:560-664`)
  drains agent tasks **before** releasing owned teammates:
  `waitUnlessShutdown(drainAgentTasks())` (`run.ts:574-576`) parks on
  `await call.settled.promise` (`run.ts:397`), which only resolves on natural
  LLM turn completion. `releaseAllOwned` — the only path that force-settles
  in-flight turns — is unreachable until that drain completes (`run.ts:580-586`).
  This is the observed 30+ minute hang.
- Team dissolve sticks in `waiting_for_team_idle` for the same reason:
  `liveWriters()` has no ownership filter
  (`packages/dreamux/src/service/team-service/index.ts:385-398`),
  `waitForTeamIdle` waits on every captured `waitIdle`
  (`packages/dreamux/src/service/team-collection/dissolve-runner.ts:274-288`),
  and codex `waitIdle` only resolves via `turnManager.stop`
  (`packages/agent-runtime/codex/src/turn-manager.ts:272`), which finalize
  never reaches.

The kill primitives all exist and are proven: `releaseAllOwned` →
`releaseExclusive` → `entity.release()` → `transitionToClosed` →
`runtime.stop()` (`packages/dreamux/src/service/teammate-collection/index.ts:467-481,607-611`;
`packages/dreamux/src/service/teammate-service/index.ts:256-289`); codex
`turnManager.stop` synthesizes exactly-once `onTurnSettled{status:'stopped'}`
for pending turns (`packages/agent-runtime/codex/src/turn-manager.ts:249-273`);
the reap is bounded SIGTERM → 1s poll → SIGKILL group, idempotent
(`packages/dreamux-utils/src/supervised-child.ts:109-131`). The bug is ordering
plus a missing await, not a missing capability.

This proposal supersedes the "no mid-turn runtime stop" clause in the archived
dynamic-workflow proposal
(`.agents/archive/proposals/dynamic-workflow.md:191-196`).

## Decided semantics

A workflow that is stopped is useless — expired or off-track. Stop must not
preserve running teammates; it burns time and tokens for nothing. Therefore:

1. `workflow_stop` (MCP and admin) returns only after the run is durably
   terminal and every owned teammate is released. It returns the durable
   status. After a successful return the run is evicted from
   `WorkflowService.runs`, so `workflow_status` / `workflow_list` fall through
   to the terminal durable record (`packages/dreamux/src/service/workflow-service/index.ts:180-215`);
   no surface reads `running`.
2. On stop, ALL owned teammates are closed immediately — queued, in-flight,
   finished — runtime processes killed. No code path waits on natural LLM
   turn completion. Unfinished agent turns are durably marked `stopped`
   (record + journal `result` row).
3. Every finalize path — interactive stop, natural completion, runner crash,
   shutdown — runs one convergence sequence. Shutdown differs from an
   interactive stop in exactly one named way: the terminal completion is
   discarded, not delivered. The old "freeze in memory, skip the kill, leave
   cleanup to the collection sweep" mode is deleted; the sweep becomes an
   idempotent no-op for already-released entities.
4. Layering: `workflow-service` owns run lifecycle and call convergence;
   `teammate-collection` owns owned-entity release linearization; runtime
   providers own process kill. All force-kill semantics ride the existing
   neutral `OwnedTeammateOps` seam
   (`packages/dreamux/src/service/teammate-collection/owned-teammates.ts:36-42`);
   core names no provider.
5. Idempotent stop; concurrent callers get the same answer via the
   `this.task` latch (`run-terminal.ts:89`); stop after natural completion
   returns the natural status; persistence errors fail loud.
6. Teardown wall-clock is bounded by process reaps (≤1s each, parallel) plus
   local IO. Kill failures do not flip the run status; the error is persisted
   on `run.error` and the entity stays registered for sweep retry.

## Design

### The convergence capability — `WorkflowRun.convergeOwnedAgents`

A new private method on `WorkflowRun` replaces the
`waitUnlessShutdown(drainAgentTasks)` + conditional `releaseAllOwned` block
(`run.ts:574-586`). One sequence, no mode switch:

```ts
/**
 * Converge every agent call this run owns to a durable terminal state:
 * release owned runtimes first (their synthetic settles flow through the
 * normal idempotent path), backstop any call without a settle, then join
 * the agent tasks.
 */
private async convergeOwnedAgents(cleanupErrors: unknown[]): Promise<void> {
  await this.deps.ownedTeammates
    .releaseAllOwned(this.teammateOwner)
    .catch((releaseError: unknown) => { cleanupErrors.push(releaseError); });
  // Backstop, provider-neutral: not every runtime's stop() synthesizes
  // settles (codex does, turn-manager.ts:263-269; claude-code does not,
  // agent-runtime/claude-code/src/runtime.ts:284-302). Every unfinished
  // call — never-settled turn, queued call whose spawn was fenced, failed
  // release — is journaled 'stopped' here. completeAgent is idempotent
  // (run.ts:505-506) and resolves call.settled in its finally
  // (run.ts:550-552), so a synthetic settle racing this loop is dropped
  // without a double write.
  for (const call of this.calls.values()) {
    if (call.completed) continue;
    await this.completeAgent(call, 'stopped', null).catch((persistenceError: unknown) => {
      cleanupErrors.push(persistenceError);
    });
  }
  await this.drainAgentTasks();
}
```

Why this is bounded: after release + backstop, every `call.settled` has a
guaranteed resolver — a synthetic settle (codex), the backstop
`completeAgent`, the `executeAgent` catch for semaphore-rejected queued calls
(`run.ts:406-424`), or the fence catch for pre-registration spawns (see
below). `Deferred` has no reject (`run-support.ts:49-60`), so the drain cannot
hang on rejection. No path awaits natural LLM completion.

`freezeAgentCalls` (`run.ts:672-681`) is deleted as dead code: the backstop
completes every call durably (journal `result` row + record), which strictly
dominates the memory-only freeze. `waitUnlessShutdown(drainAgentTasks)`
(`run.ts:574-576`) is deleted; the drain is bounded unconditionally.
`waitUnlessShutdown` remains only for the delivery race (`run.ts:643`).

### Finalize reorder + fail-loud eviction

New finalize sequence:

```
runner.stop()                              // unchanged, catch → cleanupErrors
drain runnerMessageTasks                   // unchanged
await convergeOwnedAgents(cleanupErrors)   // was: drain-then-release (the bug)
await this.mutationTail                    // unchanged
aggregate cleanupErrors → run.error        // unchanged
persist terminal record (journal end + store.write)   // inside try/finally
deliver or discard                         // unchanged axis
evict (finally, now covering the persist)  // was: only wrapped delivery
```

The only structural change beyond the convergence substitution: the
`try/finally` at `run.ts:632-663` is extended to cover the terminal
`store.write` at `run.ts:617` (and the journal `end` append). Today a
persist failure skips eviction, leaving the run in the live map with a stale
durable `running` record and a permanently cached rejected task. After the
change: persist failure → task rejects → `stop()` rejects (fail loud) →
`finally` still evicts. The durable record stays `running` and is healed to
`stopped` by startup recovery (`index.ts:250-272`).

Runner crash (`onExit` → `observe('failed')`, `run.ts:88-97`) and natural
completion use the same finalize, so a crashed runner's in-flight turns are
force-stopped and journaled `stopped` instead of waiting for natural settle.
This is a consequence of one sequence, not a special case: with the runner
dead the settle was undeliverable anyway (`suppressDelivery`,
`run.ts:41-43,530`).

### Pre-registration release fence

Moving release before the drain opens a TOCTOU the old code never faced:
`spawnWithRoute` performs several awaits before `exclusivelyOwned.set`
(`allocateName` `:237`, `resolveSpawnWorkspace` `:245`,
`assertManagedWorktreeAvailable` `:253`, `identities.create` `:260`;
registration at `:284-286`). A `releaseAllOwned` snapshot (`:468-476`) taken
in that window misses the spawn; the spawn then starts a runtime no one
kills — process leak plus a drain that only the backstop saves.

Fix in the layer that owns the map:

```ts
private readonly releasedOwners = new Set<OwnedTeammateOwner>();
private collectionReleased = false;

async releaseAllOwned(owner?: OwnedTeammateOwner): Promise<void> {
  // Mark BEFORE the snapshot, synchronously. Sticky is correct: owner
  // symbols are per-run and never reused (run.ts:69), and the no-arg
  // callers (TeamService.closeLogically team-service/index.ts:431,
  // dispatcher shutdown sweep dispatcher-service/index.ts:279) are both
  // terminal for this collection — Team admission is closed and the
  // process is exiting.
  if (owner === undefined) this.collectionReleased = true;
  else this.releasedOwners.add(owner);
  // …existing snapshot + Promise.allSettled(releaseExclusive) unchanged;
  // NO early return on failure — failed releases stay registered and
  // retryable.
}
```

In `spawnWithRoute`, as the first statement inside the existing `try`
(`:287`):

```ts
if (route.kind === 'owned' &&
    (this.collectionReleased || this.releasedOwners.has(route.owner))) {
  throw new OwnedOperationReleasedError(route.owner);
}
```

The existing catch (`:305-308`) runs `cleanupFailedOwnedSpawn` (`:581-598`)
→ `entity.release()` (closes the just-created identity; `stop()` is a no-op
with no runtime, `teammate-service/index.ts:329-332`) → deletes ownership →
evicts → rethrows → `executeAgent` catch (`run.ts:398-424`) →
`completeAgent('stopped')`.

Exhaustiveness: the flag-set and the `set`+check are each synchronous with
no await between them. Either release's mark precedes spawn's registration
(spawn self-releases), or spawn's registration precedes release's snapshot
(release sees and kills it). The fence is keyed by owner symbol, so a
single-run stop cannot touch another run's or a Team's own entities in the
same collection.

`OwnedOperationReleasedError` is a new exported named error in
`teammate-collection` (diagnostics/tests; `executeAgent` treats it like any
spawn failure).

### Release single-flight that does not cache failure

The fence overlap (release snapshot sees the entity AND the fence fires)
calls `entity.release()` twice — once from `releaseExclusive`, once from
`cleanupFailedOwnedSpawn`. Single-flight it, but reset on failure so the
shutdown sweep remains a real retry path:

```ts
private releaseTask: Promise<AgentEntityCloseResult> | null = null;

async release(): Promise<AgentEntityCloseResult> {
  if (this.releaseTask === null) {
    this.releaseTask = this.transitionToClosed(null).then(
      (result) => result,
      (error) => { this.releaseTask = null; throw error; },
    );
  }
  return this.releaseTask;
}
```

Retry is safe: on `runtime.stop()` failure `this.runtime` is not cleared
(`teammate-service/index.ts:331-332`), so a retry reaps again (codex
`turnManager.stop` is idempotent via its `stopped` flag,
`turn-manager.ts:250`; `SupervisedChild.stop` latches,
`supervised-child.ts:109-112`); on identity-write failure the runtime is
already null and the write is retried.

### Public stop awaits finalize; `stopAndWait` deleted

```ts
async stop(): Promise<WorkflowTerminalStatus> {
  const currentStatus = this.deps.status();
  if (this.requestedStatus === null && currentStatus !== 'running') {
    return currentStatus;              // already terminal: natural status
  }
  const status = this.initiateStop();  // reserve + abort IPC + create this.task
  if (this.task !== null) await this.task;
  return status;
}
```

- `initiateStop` (`:76-82`), `request`/`observe` (`:84-113`), `signalStop`
  (`:123-133`) are unchanged.
- **Delete** `WorkflowRunTerminal.stopAndWait` (`:63-66`) and
  `WorkflowRun.stopAndWait` (`run.ts:153-156`); its only caller is
  `WorkflowService.stopAll` (`index.ts:219`), which becomes
  `this.stopRuns((run) => run.stop())`.
- `stopForShutdown` (`:68-74`) keeps exactly one job: set the
  delivery-vs-discard flag, initiate, await the same `this.task`.
- `WorkflowService.stop` (`index.ts:192-201`) already awaits `active.stop()`
  — no change there.

Idempotency: a concurrent `stop()` re-enters `initiateStop`; `reserveStop`
no-ops (`accepting` is false), `signalStop` latches, `request` returns the
same task. Same status, one finalize. A stop after natural completion skips
the abort signal (only sent when `requestedStatus === 'stopped'`, `:78`) and
awaits the in-flight task, returning the natural status. Shutdown arriving
mid-stop sets the flag and awaits the same task; finalize past the
interactive branch still completes bounded work, and delivery is discarded
by the existing `waitUnlessShutdown` race (`run.ts:643-650`).

### MCP transport timeout

The shim's `forwardToolCall` uses `sendAdminRequest` with the default 10s
timeout (`packages/dreamux/src/admin/client.ts:22,36`;
`packages/dreamux/src/mcp/teammate-mcp.ts:385`). A blocking stop under load
(many agents, serialized journal/store writes through `mutationTail`) can
exceed 10s and return a socket-timeout error while teardown succeeds —
recreating the surface ambiguity this proposal removes. The MCP shim is the
only socket caller of `workflow.stop` (the admin method `methods.ts:294` is
the sole server method; the TeamLeader path is in-process).

```ts
// workflow_stop blocks until every owned runtime is reaped
// (SIGTERM -> 1s -> SIGKILL group, parallel) and the terminal record is
// persisted. Allow headroom over the admin default for large runs.
const WORKFLOW_STOP_TIMEOUT_MS = 30_000;
// in forwardToolCall:
const result = await sendAdminRequest(method, params, {
  socketPath,
  ...(method === 'workflow.stop' ? { timeoutMs: WORKFLOW_STOP_TIMEOUT_MS } : {}),
});
```

On timeout the caller retries `workflow_stop` idempotently (task latch) and
gets the same answer.

### Type accuracy

Narrow `WorkflowStopResult.status` from `WorkflowRunStatus` to
`WorkflowTerminalStatus` (`packages/dreamux/src/service/workflow-service/types.ts:63-66`).
Close the hole in `WorkflowService.stop`'s non-live branch: after
`await this.initialize()` startup recovery has flipped every durable
`running` record to `stopped` (`index.ts:250-272`), so a durable `running`
read here means a prior finalize failed to persist — fail loud:

```ts
if (active === undefined) {
  const record = await this.status({ run_id: runId });
  if (record.status === 'running') {
    throw new Error(
      `workflow run ${JSON.stringify(runId)} has no live entity but durable state reads running`,
    );
  }
  return { run_id: runId, status: record.status };
}
```

### Team dissolve — no dissolve code changes

`workflow_stop` now actually kills the owned runtime inside the awaited
call, so `turnManager.stop` runs `resolveIdleWaitersIfIdle`
(`turn-manager.ts:272`) and `waitForTeamIdle` proceeds. `closeLogically`'s
own `stopAll` (`team-service/index.ts:430`) gains the same force-kill
semantics; its subsequent no-arg `releaseAllOwned()` (`:431`) is backstop.
If a kill failed, `stopAll`'s run reported `stopped` with the error but the
entity stayed registered; `closeLogically`'s backstop release retries it
(single-flight resets on failure), and a failed backstop rejects
`closeLogically` so dissolve retries and converges.

## Sequencing

```mermaid
sequenceDiagram
    participant Caller as workflow_stop caller
    participant Terminal as WorkflowRunTerminal
    participant Finalize as WorkflowRun.finalize
    participant Coll as TeammateCollection
    participant Runtime as Owned runtime (codex / claude-code)
    Caller->>Terminal: stop()
    Terminal->>Terminal: reserveStop → semaphore.close (reject queued agents)
    Terminal-->>Runtime: abort IPC to runner (best effort)
    Terminal->>Finalize: finalize (this.task, awaited)
    Finalize->>Runtime: runner.stop (SIGTERM→1s→SIGKILL group)
    Finalize->>Finalize: drain runnerMessageTasks
    Finalize->>Coll: releaseAllOwned(owner)
    Coll->>Runtime: entity.release → runtime.stop
    Runtime-->>Coll: onTurnSettled{stopped} (codex only)
    Coll-->>Finalize: released (errors → cleanupErrors, entity stays registered)
    Finalize->>Finalize: backstop completeAgent('stopped') per unfinished call
    Finalize->>Finalize: drainAgentTasks (bounded: every settled has a resolver)
    Finalize->>Finalize: persist terminal record (fail loud; evict in finally)
    Finalize->>Finalize: deliver (interactive) / discard (shutdown)
    Finalize-->>Terminal: task settled
    Terminal-->>Caller: durable terminal status
```

## Error handling and boundedness

- **Bound:** runner reap ≤ 1s (`stopTimeoutMs` default 1000,
  `supervised-child.ts:120`); owned runtimes reaped in parallel via
  `Promise.allSettled` (`teammate-collection/index.ts:468-476`), wall-clock
  ≈ max(reaps) ≈ 1s; plus turn.jsonl/journal/record IO (milliseconds each,
  serialized through `mutationTail`). Typical stop: 1–3s. The MCP timeout
  allows 30s.
- **Kill failure** (non-ESRCH/EPERM reap error, identity-store write
  failure): caught into `cleanupErrors`; the run persists as the requested
  status with the error appended to `run.error` and a warn log
  (`run.ts:587-596`). The run *is* stopped (runner dead, record terminal, no
  turns routed); flipping to `failed` would misreport. The failed entity
  stays registered; the shutdown no-arg sweep and `closeLogically`'s
  backstop retry it (single-flight resets on failure). A truly unkillable
  process leaks until process exit — the irreducible residual.
- **Persistence failure:** `stop()` rejects; the run is evicted anyway;
  startup recovery heals the stale durable record.
  `handleAgentCompletion`'s `observe('failed')` on a settle-write failure
  (`run.ts:491-496`) is a no-op during finalize (the task latch returns the
  existing task, `run-terminal.ts:89`) — it cannot spawn a second finalize
  or surface as an unhandled rejection, and the backstop journals the call.
- **Runner abort IPC failure:** unchanged soft failure
  (`run-terminal.ts:127-132`); `finalize`'s `runner.stop` does the bounded
  kill.

## File-by-file changes

| File | Change |
|---|---|
| `packages/dreamux/src/service/workflow-service/run.ts` | Add `convergeOwnedAgents`. In `finalize`, replace `:574-586` with `await this.convergeOwnedAgents(cleanupErrors)`; extend the `try/finally` so eviction covers the terminal persist. Delete `freezeAgentCalls` and `stopAndWait`; update doc comments. |
| `packages/dreamux/src/service/workflow-service/run-terminal.ts` | `stop()` awaits `this.task` after `initiateStop`. Delete `stopAndWait` (`:63-66`). `stopForShutdown` keeps only the delivery-vs-discard flag. |
| `packages/dreamux/src/service/workflow-service/index.ts` | `stopAll` calls `run.stop()`. `stop` non-live branch fails loud on durable `running`. |
| `packages/dreamux/src/service/workflow-service/types.ts` | `WorkflowStopResult.status`: `WorkflowTerminalStatus`. |
| `packages/dreamux/src/service/teammate-collection/index.ts` | `releasedOwners` + `collectionReleased` fence; mark-before-snapshot in `releaseAllOwned`; post-registration check in `spawnWithRoute` reusing the existing catch. Export `OwnedOperationReleasedError`. |
| `packages/dreamux/src/service/teammate-service/index.ts` | `release()` single-flight with reset-on-failure. |
| `packages/dreamux/src/mcp/teammate-mcp.ts` | Rewrite the `workflow_stop` descriptor to blocking semantics; `WORKFLOW_STOP_TIMEOUT_MS = 30_000` passed only for `workflow.stop`. |
| `packages/dreamux/skills/shared/workflow/SKILL.md` | Rewrite the `workflow_stop` bullet: blocks until the run is durably terminal and owned TeamMates are stopped; delete "returns immediately / status may still read running". |
| `.agents/reference/dynamic-workflow-usage.md` | Rewrite the stop section to the blocking contract. |
| `.agents/reference/current-architecture.md` | Replace the three-way stop distinction with the unified sequence and its single named shutdown difference. |
| `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/service-lifecycle.md` | Workflow Run State section: a persisted `stopped` agent record now means the turn was interrupted at stop (or at startup recovery), not natural-settle-after-stop. Shape/version unchanged. |
| `.agents/decisions/workflow-stop-semantics.md` | New decision record when this is implemented: reverses the archived no-mid-turn-stop clause; records kill-failure policy and the shutdown difference. |
| `common/changes/@excitedjs/dreamux/` | Rush change file, type `minor`: `BREAKING: workflow_stop now blocks until the run is durably terminal and force-closes owned TeamMates, killing in-flight agent turns; unfinished agents persist as stopped. Review: callers that fire workflow_stop in loops or assume immediate return must be reviewed — each stop now takes ~1-3s, bounded by process reaps (SIGTERM/1s/SIGKILL). State shape is unchanged; no rebuild is needed.` No `Rebuild:` line. |

No state-shape change: `'stopped'` already exists in both enums
(`types.ts:3-11`), startup recovery already writes the exact target end-state
(`index.ts:250-272`), and `WorkflowRunRecord` keeps version 1.

## Test plan

All tests live in `packages/dreamux/tests/workflow-service.test.ts` unless
noted. The harness builds a real `WorkflowService` on a tmp HOME with real
store/journal and three fakes; `FakeOwnedTeammates` (`:62-184`) is extended
first.

Fake extension (`FakeOwnedTeammates`):

- Add `releaseSettlesInFlight = false`. When true, `releaseOwned` /
  `releaseAllOwned` call `settleSpawn(spawn, 'stopped', null)` for every
  un-settled spawn of that owner before deleting ownership — models codex
  `turnManager.stop`'s synthetic settle. Track the route tasks in the
  existing `routeTasks` set.
- Add fence modeling: a `releasedOwners` set; `releaseAllOwned(owner)` marks
  the owner; `spawnOwned` after mark throws a modeled
  `OwnedOperationReleasedError` (mirrors the real collection fence so
  `executeAgent`'s catch path is exercised).

Rewrites (old contract = the bug; new contract asserted):

- `:1170-1221` → stops, kills owned turns, persists, and delivers before
  returning: `releaseSettlesInFlight` on; `service.stop` resolves only when
  `teammates.releases` contains the spawn AND `initiator.received` has the
  terminal completion; agent record `stopped` (not `completed`); journal
  `['run','submit','result','end']`; `activeRunCount` 0; a later
  `settle(0,'completed')` changes nothing. Abort IPC assertion kept.
- `:1402-1436` → fails on runner exit and releases the owned turn without
  natural settle: after `runner.exit(7)`, release happens with no manual
  settle; agent `stopped`; run `failed` with the exit error; delivery status
  `failed`.
- The five shutdown tests `:1223-1257`, `:1259-1316`, `:1318-1366`,
  `:1368-1400`, `:1438-1480` → new contract: release happens at shutdown,
  journal carries per-agent `result` rows, delivery is discarded.

New tests:

- Never-settling turn regression (the #328 lock): `releaseSettlesInFlight`
  OFF (models claude-code), never call `settle`; `stop` resolves bounded;
  agent durably `stopped` via backstop; journal has the `result` row. Hangs
  forever on the old code.
- Queued agent + single-run stop: `max_concurrency: 1`, two `agent_start`s;
  stop; both agents `stopped`, `spawnAttempts === 1`.
- `stopAll` with an in-flight never-settling owned turn (previously zero
  coverage of the shared path).
- Concurrent stop idempotency: two callers, identical `{status:'stopped'}`,
  `releaseAllAttempts === 1`.
- Stop after natural completion returns `'completed'` (fast path).
- Release failure policy: `releaseAllError` set; stop resolves `stopped`;
  `record.error` carries the failure; agent `stopped` via backstop; entity
  still registered (fake models ownership retained).
- Synthetic-settle persistence failure: spy `WorkflowRunStore.write` (or
  journal append) to throw `WorkflowPersistenceError` only for the agent's
  `result` write; stop resolves `stopped`; no unhandled rejection; durable
  record has agent `stopped`; journal ends with `end`.
- Terminal persistence failure: spy store.write to throw on the terminal
  write (record with `ended_at` set); `stop` rejects; `activeRunCount` 0
  (evicted); durable record still `running` (startup-recovery bait).

Other files:

- `packages/dreamux-utils/tests/utils.test.ts` (SupervisedChild describe):
  new reap-timing test — child traps SIGTERM; `stop({stopTimeoutMs: 200})`;
  assert exit signal `SIGKILL`, elapsed ≥ ~150ms (it waited) and < 5s
  (bounded). The entire bounded-teardown argument rests on this sequence,
  which has zero coverage today.
- `packages/dreamux/tests/teammate-mcp.test.ts`: mock the admin client
  module; assert `workflow_stop` forwarding passes `timeoutMs: 30000` and
  other methods pass no timeout.
- New `packages/dreamux/tests/teammate-collection-own.test.ts` (reuse the
  real-store harness and `FakeRuntime` from
  `team-dissolve-acceptance.test.ts:437`): (a) fence test — gate a spawn
  inside the pre-registration window (hold `identities.create`), call
  `releaseAllOwned(owner)`, release the gate; assert spawn throws
  `OwnedOperationReleasedError`, identity ends `closed`, no runtime leaks,
  no residual ownership; (b) overlap test — release snapshot and fence fire
  for one entity; assert exactly one identity `closed` write and one reap
  (single-flight).
- `packages/dreamux/tests/team-dissolve-acceptance.test.ts`: new e2e —
  in-flight workflow-owned teammate (`FakeRuntime` with `waitIdle` promise,
  `:437`) + accepted dissolve stuck at `waiting_for_team_idle`;
  `workflow_stop` resolves; assert dissolve proceeds to `logicalClosed`.

Cross-surface wiring tests (`workflow-admin.test.ts:83-106`,
`team-leader-handle.test.ts:38-65`) need no changes: the former asserts the
`{run_id,status}` shape (unchanged), the latter proves the Team lease is
released before stop settles (compatible with a bounded wait).

## Invariants

- After `WorkflowRun.stop()` resolves: run evicted from `WorkflowService.runs`;
  durable record terminal; every owned entity released (identity `closed`,
  runtime null, process reaped) or registered-with-error for sweep retry; no
  unresolved `call.settled`.
- No teardown path awaits natural LLM completion. The only awaits in
  finalize are bounded reaps, local IO, and drains whose every deferred has
  a guaranteed resolver.
- Exactly one `completeAgent` per call: `call.completed` is set
  synchronously before any await (`run.ts:505-506`); synthetic settle,
  backstop, `executeAgent` catch, and fence race harmlessly.
- Journal order is always `run, submit*, result*, end`: agent writes
  serialize through `mutate`; the drain and `mutationTail` precede the `end`
  row.
- Shutdown differs from interactive stop in exactly one named way: the
  terminal completion is discarded, not delivered.
- Fence exhaustiveness: for one owner, exactly one of {release snapshot
  sees the entity, spawn's post-set check sees the flag} holds — both steps
  synchronous.
- Release idempotency: single-flight with reset-on-failure;
  `releaseExclusive` deletes ownership and evicts, so the no-arg sweeps are
  no-ops for already-released entities.
- Stop idempotency: `requestedStatus`/`task` latch; concurrent callers,
  `stopAll`, and `stopForShutdown` converge on one finalize and one answer.
- Core stays provider-neutral: force-kill semantics ride
  `OwnedTeammateOps`/`AgentRuntime`; no provider-named symbol in shared
  layers.

## Alternatives considered

- **Return a non-terminal `stopping` state immediately, expose terminal
  completion separately.** Rejected: it preserves the ambiguity that broke
  #328 — callers must poll, and Team dissolve still blocks on owned
  runtimes. The teardown is bounded (~1-3s), so waiting is cheap and the
  contract becomes trivially honest: the return value is the durable fact.
- **Bounded cancellation policy that preserves in-flight turns.** Rejected:
  a stopped workflow is useless by definition; preserving its turns burns
  tokens for nothing. Kill first, record `stopped` durably.
- **Keep the two-mode shutdown split (freeze in memory, skip the kill).**
  Rejected: the modes existed only because interactive stop dead-waited
  natural settles. With release-before-drain the drain is bounded for
  shutdown too; finalize already persists at shutdown, so per-agent
  `result` rows add no new failure class. One sequence is easier to reason
  about and test; the collection sweep degrades to an idempotent backstop.
