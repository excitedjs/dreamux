# Architecture Proposal: Unified Teammate Membership Lifecycle

Requirement: `.agents/tasks/workflow/unified-teammate-lifecycle/requirement.md`
Frozen SHA-256: `863d7c8faa08f6a344654bd74a093fc5a6e1b13380641a323416a2e085ee9e08`
Source baseline inspected: `6b8ec14b080389bf6c6ae36fa336ec0451e401ec`

## 1. Problem summary

Today `TeammateCollection.releaseExclusive()` and `releaseAllOwned(owner)` own the close side-effect path: they synchronously call `entity.release()` (or `entity.close()`), then mutate collection-owned maps (`exclusivelyOwned`, `entities`) as part of the same command. Three symptoms follow:

1. **Workflow depends on a collection-owned bulk lifecycle verb.** `WorkflowRun.finalize` calls `ownedTeammates.releaseAllOwned(owner)` rather than closing each borrowed TeamMate through an entity-scoped handle, so "close my members" is orchestrated by the collection, not by the membership owner.
2. **The collection is in the entity's close command path solely to do its own bookkeeping.** Per the operator red line, a subscriber's need to observe a fact (eviction) must not force the fact-owner's command to route through that subscriber.
3. **A second shutdown-only lifecycle path exists.** `stopForShutdown` skips release entirely and relies on a collection-wide `releaseAllOwned()` sweep. Combined with `transitionToClosed` waiting for natural submission drain, this split lets a never-settling turn hold Team dissolve indefinitely (acceptance criterion 17) and motivates workflow-specific grace windows.

The reverse edges are not limited to close: `TeammateService` imports `resolveAgent`, `foldLastTurns`, `toStatus`, `validateLastTurns` from `teammate-collection/*`, which violates "no TeammateService implementation imports a capability from teammate-collection."

## 2. Current dependency graph

Solid arrow = import / direct method call. Dashed arrow = injected narrow dependency. Arrow label = representative verb.

```
                DispatcherService                TeamService
                (composition root)              (composition root)
                     |    |                          |    |
          constructs |    | injects        constructs |    | injects
                     v    v                          v    v
            TeammateCollection  --spawnOwned/releaseAllOwned-> WorkflowService
                  |      ^                                              |
   creates/caches |      | (close/release, evict as part of command)    | holds
                  v      |                                              v
              TeammateService  <--routeSettledCompletion/trackSettleCapture--
                  |
                  +--> agent-runtime (provider-neutral)
                  +--> agent-entity stores (identities, turns, runtime-state)
                  +--> completion-router (injected, OK)
                  +--> worktree manager
                  +--> ../teammate-collection/agent-config   (REVERSE EDGE: resolveAgent)
                  +--> ../teammate-collection/read-helpers  (REVERSE EDGE: toStatus/foldLastTurns/validateLastTurns)

   WorkflowRun --(uses)--> Pick<OwnedTeammateOps, 'spawnOwned' | 'releaseAllOwned'>
        |
        | spawnOwned returns { teammate: AgentEntityRuntimeStatus, turn }
        | WorkflowRun records name+turnId in its own agent record (business fact),
        | but close/release authority is the collection, not entity handles.
        v
   (no direct reference to TeammateService; close is mediated)
```

Pathologies highlighted by the graph:
- `TeammateCollection.close()` → `entity.close()` → `evictEntity()` couples cache eviction to the entity command (P1 violation).
- `releaseExclusive()` / `releaseAllOwned()` do the same for owner-initiated close (operator red line).
- `stopAll()` branches on `exclusivelyOwned.has(name)` to pick `entity.stop()` vs `releaseExclusive(entity)`, encoding close-policy knowledge in the container.
- `trackSettleCapture` wires entity settle promises into a collection set for drain-at-shutdown, giving the container a second reason to touch entity runtime lifecycle.
- `TeammateService` depends on `teammate-collection/*` for helpers, so the lower layer is not actually lower.

## 3. Target dependency graph

```
                DispatcherService                TeamService
                (composition root)              (composition root)
                     |   \                           /   |
          constructs |    \---subscribe 'closed'----/    | constructs
                     v                                 v
            TeammateCollection                    WorkflowService
             (factory + cache                    (membership owner;
              + roster + reads)                    holds handles)
                  |  ^                                 |  ^
      creates via |  | 'closed' event (post-commit)    |  | TeammateHandle
      factory, no |  | (evict cache on observe)        |  | (close + closed promise)
      close verbs v  |                                 v  |
              TeammateService  <--spawnOwned returns {handle,turn,status}--
                  |
                  +--> agent-runtime
                  +--> agent-entity stores
                  +--> agent-config/        (neutral, moved out of collection)
                  +--> agent-entity/read-helpers/  (neutral, moved out of collection)
                  +--> worktree manager
                  +--> Typed lifecycle event source (emits 'closed' post-commit)

   WorkflowRun --(uses)--> TeammateFactory { spawnOwned(input, opts): Promise<{handle, turn, status}> }
        |
        | holds TeammateHandle per spawned agent
        | calls handle.close() on stop; awaits handle.closed for terminal consistency
        | NO reference to TeammateCollection for lifecycle verbs
        v
   (close runs on entity; collection learns via 'closed' event and evicts cache)
```

Arrow directions now satisfy the red line:
- `TeammateService` has **zero** imports from `teammate-collection/`.
- `TeammateCollection` depends on `TeammateService` (factory + event subscription for cache eviction), not the reverse.
- `WorkflowService` / `WorkflowRun` depend on a narrow `TeammateFactory` interface that returns entity-scoped `TeammateHandle`s; they do not import the collection or bulk release verbs.
- Both `TeammateCollection` and `WorkflowService` subscribe to entity lifecycle events as post-commit observers; subscribers do not participate in the entity's close state machine.
- All lifecycle commands (send, close, stop-runtime, reopen, apply-worktree-cleanup) live on `TeammateService` or on handles that delegate directly to the entity.

## 4. Owner / Command / Query / Event matrix

Rows = owned capability; columns = owning module. C = command (mutates owner's authoritative state), Q = read query (pure projection of authoritative state), E = post-commit event (subscriber reaction only), X = must not exist in that module.

| Capability / fact | TeammateService | TeammateCollection | WorkflowService / WorkflowRun | Composition root (Dispatcher/Team) |
|---|---|---|---|---|
| Durable TeamMate identity CRUD | C (create via factory, update closed/reopened) | Q (list/status/history/last via stores) | — | — |
| Runtime start / stop / kill | C (ensureStarted, stop, transitionToClosed) | — | — | — |
| Single-flight close, admission fence, idempotency | C (close, closeByClaim, release) | — | — | — |
| Bounded runtime termination (SIGTERM→wait→SIGKILL) | C (uses SupervisedChild via AgentRuntime.stop) | — | — | — |
| Unfinished-turn stopped outcome | C (transitionToClosed converges active submissions) | — | — | — |
| Settle-write drain + turn persistence on close | C (transitionToClosed drains settleWrites + turnSubmissions) | — | — | — |
| Owned-worktree cleanup on close | C (transitionToClosed via ownsWorktreeOnClose) | — | — | — |
| Durable `closed` commit | C (identities.update) | — | — | — |
| Public close (note-bearing, no active claim) | C (close) | C (adapter: resolves entity, asserts no claim, delegates) | — | — |
| Claim-holder close (no note, or with note) | C (closeByClaim) | — | C (calls handle.close) | — |
| Exclusive write-claim acquire/release | C (acquireWriteClaim, releaseWriteClaim) | C (factory acquires at spawnOwned) | C (holds handle, claim released when handle.close resolves via event) | — |
| Public send / channelInput / scheduledInput gating | C (assertNoActiveClaim in send path) | Q (assertPubliclyAddressable queries entity state) | — | — |
| TeamMate creation path | — | C (spawn, spawnOwned, attachExisting) | C (borrows via factory.spawnOwned; records name/turnId) | — |
| Live entity cache (entities map) | — | C (add on spawn/lookup-miss, evict on 'closed' event) | — | — |
| Identity roster / list / status / history / last | Q (status/last on entity) | C (list/history iterate roster; status/last delegate) | — | C (MCP/read surfaces project through collection) |
| `closed` lifecycle fact | E (emits post-commit) | E (subscriber: evict cache, drop claim bookkeeping only) | E (subscriber via handle.closed: resolve agent terminal state, don't orchestrate close) | — |
| Settled-turn routing (routeSettledCompletion) | E (emits turn-settled internally; route injected) | C (wires router path for public teammates at factory) | C (wires handleAgentCompletion for owned teammates at spawnOwned) | — |
| `trackSettleCapture` drain-at-container-stop | X | X (deleted — entity close drains itself) | X | — |
| `releaseAllOwned(owner)` bulk verb | X | X (deleted) | X | X |
| `releaseExclusive(entity)` collection-orchestrated release | X | X (deleted — handle.close + 'closed' event replace it) | X | X |
| Runtime kill / grace-period logic inside Workflow finalize | X | X | X (deleted — calls handle.close which is entity-owned) | — |
| Process-shutdown sweep of any still-live runtime | — | Q (liveRuntimes() — read-only projection for safety net) | — | C (after stopping WorkflowService, stops any remaining live runtimes defensively) |
| Team dissolve idle barrier over member/leader runtimes | — | Q (liveRuntimes() projection) | — | C (TeamService/Collection drives via waitIdle on projected runtimes; close still flows through entity) |
| Workflow membership record (run → agent name/turn/result) | — | — | C (record per run; durable source of truth for run↔teammate relationship) | — |
| Workflow terminal persistence + completion delivery | — | — | C (finalize after all handles closed) | — |
| Claim/lease map for public-mutation rejection | C (entity.claim) | C (read-only view for safety net; not an orchestration path) | C (holds handle/claim) | — |
| reverse imports from service into collection | X (eliminated: helpers moved to neutral module) | — | — | — |

Key ownership rules made explicit in this matrix:

1. **Every close execution path is a command on `TeammateService`.** Adapters exist (`TeammateCollection.close()` for public close, `TeammateHandle.close()` for owner close) but they resolve to the entity and call one `close*` method; they do not perform shutdown steps or cache eviction synchronously before returning.
2. **Cache eviction from the collection is a subscriber reaction to the `closed` event**, not a step inside the close command.
3. **Workflow terminal consistency** is achieved by awaiting `handle.closed` on each borrowed handle before the Workflow records its terminal state — not by a bulk collection verb.
4. **Public-mutation rejection** is an entity-owned admission check (claim gating). The collection queries entity state for error surfacing but does not own the claim state machine.
5. **Settle-capture draining** moves into the entity's `transitionToClosed`, removing the container's reason to observe in-flight captures.

## 5. Lifecycle and event contracts

### 5.1 Typed lifecycle source

`TeammateService` gains a narrow typed event source. We do NOT expose raw `EventEmitter`; we expose a constrained subscription API so subscribers cannot emit, cannot inspect listener sets, and can revoke subscriptions:

```ts
// new file: packages/dreamux/src/service/teammate-service/lifecycle.ts
export interface TeammateLifecycleEvents {
  closed: (result: TeammateClosedEvent) => void;
}

export interface TeammateClosedEvent {
  readonly name: string;
  /** Durable identity has been committed to status: 'closed'. */
  readonly durableClosed: boolean;
  /** The close note if one was supplied; null for owner/release closes. */
  readonly closeNote: string | null;
  /** Populated when runtime was killed but durable persistence failed. */
  readonly persistenceError?: Error;
  /** Monotonic close generation (entity-local), used to ignore stale reopen races. */
  readonly generation: number;
}

export interface TeammateLifecycleSource {
  on<K extends keyof TeammateLifecycleEvents>(
    event: K,
    handler: TeammateLifecycleEvents[K],
  ): TeammateLifecycleSubscription;
}

export interface TeammateLifecycleSubscription {
  off(): void;
}
```

Publication rules:

- `'closed'` fires **after** `identities.update(..., { status: 'closed' })` commits successfully (normal success path) — subscribers may assume no runtime is live and the durable fact holds.
- If runtime was killed but persistence fails, `'closed'` fires with `durableClosed: false` and `persistenceError` set, so subscribers can evict (no runtime remains) but recovery logic on restart knows to reconcile. This satisfies acceptance criterion 9 (runtime terminated is reported as a fact even when persistence fails).
- Events are emitted fire-and-forget inside a try/catch; handler errors are logged and do not surface to the close caller or roll back the transition (requirement invariant: "A listener failure must not fail or roll back an already committed TeamMate lifecycle transition").
- The event is NOT replayed to late subscribers. Subscribers that subscribe after the fact must reconcile from authoritative state, just as restart reconciliation does today.

### 5.2 TeammateHandle (narrow owner command handle)

The factory (`TeammateCollection.spawnOwned` and future `attachExisting`) returns a handle, not just a status/turn DTO:

```ts
// new file: packages/dreamux/src/service/teammate-service/handle.ts
export interface TeammateHandle {
  readonly name: string;
  /**
   * Close by the write-claim holder. Equivalent to today's release(): no user-
   * visible close note; cancels any active turn; terminates runtime; converges
   * settlement; persists closed. Resolves once the durable 'closed' commit
   * completes (or rejects if the command itself errors — runtime killed but
   * persistence failed surfaces as CloseResult.runtimeTerminated with
   * persistenceError set, not a rejection, so caller can decide).
   */
  close(opts?: { note?: string | null }): Promise<TeammateCloseResult>;
  /** Resolves when the entity's 'closed' event fires. Same payload. */
  readonly closed: Promise<TeammateClosedEvent>;
}
```

`TeammateHandle` is an interface; the concrete class holds a weak reference to the entity and the `MembershipClaim` token. `WorkflowRun` stores handles alongside its current `name` / `turn_id` fields; it does not import `TeammateService` or `TeammateCollection` directly.

### 5.3 MembershipClaim (exclusive write lease)

The current branded-symbol `OwnedTeammateOwner` is renamed and lifted into a neutral module so entity and factory both reference it without reverse edges:

```ts
// moved+renamed to: packages/dreamux/src/service/teammate-service/membership.ts
export type MembershipClaimId = symbol & { readonly [membershipBrand]: never };
export function createMembershipClaim(): MembershipClaimId;

export interface Membership {
  /** Acquire exclusive write claim; throws if already held. */
  acquire(claim: MembershipClaimId): void;
  /** Release claim; throws if claim does not match. */
  release(claim: MembershipClaimId): void;
  /** Returns the current holder or null. Read-only; not an orchestration hook. */
  currentHolder(): MembershipClaimId | null;
  /** Throw if a claim held by anyone other than `except` is active. */
  assertPubliclyMutable(except?: MembershipClaimId): void;
}
```

Properties:
- `TeammateService` owns one `Membership` instance per entity.
- `TeammateCollection.spawnOwned` creates a `MembershipClaimId` (encapsulated in the returned `TeammateHandle`), passes it at construction (via options or a post-construct `attachClaim`), and the entity's `Membership` is held for the handle's lifetime.
- `send` / public `close` / `channelInput` / `completionInput` / `scheduledInput` entry points call `membership.assertPubliclyMutable()` before mutating state. This satisfies acceptance criteria 13 and 14.
- `TeammateHandle.close` calls the entity's claim-holder close path. When close completes, the entity releases the claim (claim is released inside close as part of entity-owned lifecycle, NOT by the collection or Workflow). Wait — actually, if close persists the entity as closed, the claim is irrelevant because the entity is closed. A reopened entity starts with no claim. So `release` happens naturally when close commits; we don't need a separate release step.
- Future `attachExisting` will also return a `TeammateHandle` backed by a fresh `MembershipClaimId` (acquired against the already-running entity), so an existing ordinary TeamMate can join a Workflow without a new entity (acceptance criterion 20).

### 5.4 TeammateFactory (the new narrow seam for Workflow)

Replace `OwnedTeammateOps.spawnOwned / releaseAllOwned` with:

```ts
// new file: packages/dreamux/src/service/teammate-service/factory-contract.ts
export interface TeammateFactory {
  spawnOwned(
    input: SpawnTeamMateInput,
    options: SpawnOwnedTeamMateOptions,
  ): Promise<{ handle: TeammateHandle; teammate: AgentEntityRuntimeStatus; turn: AgentRuntimeTurnResult }>;
}
```

- `releaseAllOwned` is deleted.
- `SpawnOwnedTeamMateOptions.routeSettledCompletion` is preserved (turn-settled routing is a separate concern from lifecycle).
- `SpawnOwnedTeamMateOptions.owner: OwnedTeammateOwner` is replaced by the factory creating the `MembershipClaimId` internally and returning it inside the handle; callers do not construct owner symbols.

`WorkflowService` / `WorkflowRun` depend on `TeammateFactory` only.

For shutdown/cleanup safety net, we add a separate neutral read projection:

```ts
export interface LiveRuntimeProbe {
  /** Read-only snapshot of currently live runtimes; used only by shutdown safety net. */
  liveRuntimes(): ReadonlyArray<{ name: string; runtime: AgentRuntime }>;
}
```

This is the ONLY collection verb used during shutdown, and it is a query, not a command. The composition root (Dispatcher/Team) uses it after stopping WorkflowService to defensively kill any leaked runtime via `runtime.stop()` directly (no entity-level command needed for leak mitigation).

### 5.5 Revised OwnedTeammateOps

The existing `OwnedTeammateOps` interface is replaced entirely:
- `spawnOwned` moves to `TeammateFactory` and returns a `TeammateHandle`.
- `releaseAllOwned` is deleted.
- File `teammate-collection/owned-teammates.ts` is removed; `MembershipClaimId` moves to `teammate-service/membership.ts`.

## 6. Lifecycle flows

### 6.1 Create (spawnOwned by Workflow)

1. `WorkflowRun.executeAgent` calls `factory.spawnOwned(input, { routeSettledCompletion, systemPromptAppend, outputSchema })`.
2. `TeammateCollection.spawnOwned` (still the single creation path):
   a. Runs admission gate, name allocation, workspace resolution, identity store create — same as today.
   b. Constructs a fresh `MembershipClaimId`.
   c. Calls `createTeammateService(...)` passing `initialClaim` (or calls `entity.acquireMembership(claim)` after construction).
   d. Caches the entity in `entities` map (no separate `exclusivelyOwned` bookkeeping required for lifecycle; the claim lives on the entity).
   e. Calls `entity.ensureStarted()`, then `entity.submitInitialPromptRuntime(...)` (same as today).
   f. Registers no CompletionRouter key (owned route replaces it — same as today).
   g. Returns `{ handle: new TeammateHandle(entity, claim), teammate: entity.status(), turn }`.
3. `WorkflowRun` stores `handle` on its `AgentCall` (alongside name, turn_id).
4. The entity publishes NO lifecycle event on creation by default (an implementation may add `started` later but it is not needed for this proposal).

### 6.2 Ordinary send (public teammate, not in a Workflow)

1. Admin/MCP `teammate.send` resolves through `DispatcherService.teammates.send`, which calls `TeammateCollection.send`.
2. Collection resolves entity via `mustEntity(name)`.
3. Collection calls `entity.send({...})`.
4. `entity.send()` calls `membership.assertPubliclyMutable()` — if a Workflow claim is active, throws "exclusively owned by active operation" (preserves current error surface but enforcement is entity-owned).
5. Normal send path proceeds (ensureStarted, submitPromptRuntime, etc.).
6. Collection calls `registerCompletion(entity, turnId)` to register the initiator (unchanged).

Note: the collection can keep its own `assertPubliclyAddressable` for user-facing error specificity, but it now queries `entity.membership.currentHolder()` rather than reading its own map.

### 6.3 Explicit workflow_stop

1. MCP/Admin `workflow.stop` → `WorkflowService.stop(runId)` → `run.stop()` → `terminal.stop()` (same as today; returns as soon as stop is initiated? — see §6.4).
2. `terminal.request('stopped', ...)` triggers `finalize('stopped',...)`. The finalize sequence changes:
   a. Stop runner (same), drain runnerMessageTasks (same).
   b. Close agent admission via semaphore; await `agentTasks` drain (same; immediate cancellation means in-flight executeAgent calls that are past semaphore acquire will get stopped via the close below, but we still need to wait for them to observe terminal.requested).
   c. **Replace `releaseAllOwned(owner)` with parallel close of every handle held in `this.calls` that was successfully spawned:**
      ```ts
      await Promise.allSettled(
        [...this.calls.values()]
          .filter(c => c.handle !== undefined)
          .map(c => c.handle.close().catch(e => cleanupErrors.push(e)))
      );
      ```
      Each `handle.close()` invokes the entity's claim-holder close path, which:
      - Sets entity admission fence (`closing` flag) → rejects subsequent sends/start/reopen races.
      - Calls `runtime.stop()` (which sends SIGTERM, waits bounded interval, SIGKILLs — already existing in SupervisedChild).
      - Drains `turnSubmissions` and `settleWrites` (entity-owned; no container help).
      - Converges in-flight submissions to `stopped` results (turns that were submitted but not settled get a stopped outcome recorded; see §6.6).
      - Performs entity-owned worktree cleanup per `ownsWorktreeOnClose`.
      - Persists `identities.update(..., { status: 'closed', closedAt, ... })`.
      - Releases entity membership claim.
      - Emits `'closed'` event (post-commit).
      - Returns `TeammateCloseResult` (same shape as current `AgentEntityCloseResult`, plus optional `persistenceError`).
   d. After all handles resolve, persist terminal WorkflowRun record, deliver completion, evict from WorkflowService.runs (same as today).
3. After the `'closed'` event fires:
   - `TeammateCollection` subscriber evicts entity from its `entities` cache via `evictEntity` (CAS-guarded, same as today).
   - `WorkflowRun`'s `handle.closed` promise resolves (already awaited in step 2c implicitly via `handle.close()` since close resolves after emit).
4. `workflow_stop` return value: same as today (`{run_id, status}`). The question of whether `workflow_stop` waits for full close or returns early is a separate decision (see §6.4).

### 6.4 When does the `workflow.stop` MCP command return?

Re-reading the requirement: "A successful workflow_stop must not claim a terminal Workflow while its borrowed TeamMates continue running." This means the terminal record cannot be committed until all TeamMates are closed. It does NOT mean the MCP caller must wait for that — the current MCP method returns the `WorkflowTerminalStatus` immediately and the run continues finalizing in the background.

Design: preserve current return behavior. `WorkflowRun.stop()` returns the requested status string immediately after requesting terminal transition (as today). The `finalize` method runs in the background (via `terminal.task`), and the `close()` await inside finalize ensures no terminal record is written until handles close.

For callers that need to wait (Team dissolve, shutdown, DispatcherWorkflows.rollbackStart), they call `stopAndWait()` which awaits `terminal.task` (full finalize completion). This is unchanged — what changes is that finalize now does the work via handles rather than via `releaseAllOwned`, and because entity.close is immediate-cancel + bounded, `stopAndWait` is now O(bounded-kill-wait + persistence) ≈ 1–2 seconds worst case, instead of unbounded.

### 6.5 Team dissolve

Today's `TeamService.closeLogically` calls `workflowService.stopAll()` (stopAndWait per run, which waits for full finalize including releaseAllOwned), then `teammateCollection.releaseAllOwned()` (safety net), then closes each member and the leader with a note. After refactor:

1. `workflowService.stopAll()` calls `run.stopAndWait()` per run (same entry point). Each run's finalize closes its handles and waits for entity close (bounded). No more separate releaseAllOwned.
2. The `teammateCollection.releaseAllOwned()` safety net is replaced by reading `teammateCollection.liveRuntimes()` (query, not command) and defensively calling `runtime.stop()` on any that are still up — this catches leaks (e.g., a future extension that creates entities outside Workflow) without owning close semantics.
3. Member and leader close flow through the same entity `close({note})` path (collection adapter resolves entity, delegates to entity.close; cache eviction happens via `'closed'` event, not synchronously after the call).

Idle-barrier wait (`waitIdle` on live writers in dissolve-runner) is unchanged — it queries `liveRuntimes()` from the collection and waits for each runtime's idle signal, which continues to work because `waitIdle` is a runtime-level query (not a lifecycle command).

Acceptance criterion 17 (never-settling turn cannot hold dissolve indefinitely) is satisfied because (a) `stopAll` is now stopAndWait (bounded by immediate-cancel close), not `stopForShutdown` that skipped release, and (b) entity.close does not wait for natural model completion — it kills the runtime.

### 6.6 Close vs send/start/settle interleaving

Concurrency guarantees for `transitionToClosed` (entity-owned):

1. **Close-vs-start race:** `transitionToClosed` sets a `closing` flag before calling `stop()`. `ensureStarted()` checks `closing` at entry and after awaiting in-flight `starting`; if set, it throws `TeamMate is closing/closed`. The current `starting` promise serialization (issue #233) is preserved; `stop()` awaits `starting` before calling `runtime.stop()`, so a concurrent `ensureStarted` that committed to starting a runtime will have its runtime stopped by `stop()`.
2. **Close-vs-send race:** `send()` calls `ensureStarted()` first, then submits to the runtime. If close has begun, either `ensureStarted` throws (admission fence) or `submitRuntimeTurn` submits to a runtime that is about to be stopped; the runtime returns `stopped` (as it already does when stopped mid-submission, see runtime stop contract).
3. **Close-vs-settle race:** After `stop()` returns (runtime dead), `turnSubmissions.drain()` waits for in-flight submissions to finish persisting their submitted-turn rows; then `settleWrites` are drained via allSettled. Turns that were submitted but whose runtime was killed before producing a settled signal are recorded as `stopped` outcomes in the turn store. This convergence is done by `turnSubmissions.drain()` knowing the close generation and synthesizing stopped outcomes for submissions that never received a settle (requires a small extension to `TurnSubmissionReadiness`).
4. **Concurrent close:** `transitionToClosed` is guarded by a single-flight promise (`closing: Promise<AgentEntityCloseResult> | null`), analogous to today's `starting`. Second callers await the same promise; idempotent.
5. **Late settle/completion after close:** After `'closed'` is emitted, the entity state is closed. Any residual async settlement callbacks that arrive must detect that the entity is closed (or the close generation has advanced) and must not overwrite closed state with running state. This is enforced by checking `this.identity.status` and generation in `deliverSettledTurn` before writing; late settles are logged and dropped. Today's code has a comment about this (lines 458–462) but relies on ordering; we harden it with an explicit generation check.

### 6.7 Reopen after Workflow

After Workflow finalizes, all borrowed handles are closed; their entities emitted `'closed'`, which caused collection cache eviction. The durable identities remain (with `status: 'closed'`, closeNote: null for owner close). Work membership has ended (claim released on close). Public send is now allowed (assertPubliclyMutable passes because no claim is held).

When the operator calls `teammate.send(name, ...)` later:
1. `TeammateCollection.send` resolves the name via `mustEntity(name)`. The entity is not in `entities` (evicted), so it loads the durable identity via `mustIdentity` and constructs a fresh entity via `entityFor(identity)`.
2. `entity.send()` calls `ensureStarted({ reopenClosed: true })`, which reprepares a managed worktree, clears closed markers, starts a new runtime.
3. The reopened entity starts with no membership claim (reopened entities are always publicly mutable).
4. The send proceeds; new turns do not touch the already-terminal Workflow (acceptance criteria 15, 16).

This behavior is largely unchanged from today — what changes is that cache eviction is triggered by event subscription rather than by the collection calling `evictEntity` synchronously inside release.

### 6.8 Server shutdown

The current `DispatcherService.doStop` has a special-case path: workflows stopped with `stopAllForShutdown` (which skips releaseAllOwned), then `_teammates.releaseAllOwned()` sweeps all owned, then `teams.stopAll()` which again stops workflows-for-shutdown and stops teammates. This creates a second lifecycle model.

Target shutdown sequence (DispatcherService.shutdown → doStop):

1. `stopping = true`, revoke session leases, close admission (unchanged).
2. `workflowOwner.stopAllForShutdown()`:
   - Close admission, await in-flight run creations.
   - For each run, invoke `run.stopForShutdown()` which triggers finalize with shutdown semantics.
   - `finalize` under shutdown: stops runner, drains runner messages, invokes `handle.close({ shutdown: true })` on each held handle (rather than skipping release).
   - `handle.close({shutdown:true})` still runs the normal entity close: admission fence, immediate runtime kill (bounded), drain submissions. The persistence step gets a short time budget (e.g., 2s); if persistence does not complete in that window, close resolves with `{ runtimeTerminated: true, persistenceError: ShuttingDown }` and fires `'closed'` with `durableClosed: false`. This satisfies "server shutdown reuses the same close capability" (acceptance criterion 18) while still bounding process exit.
   - Persist terminal Workflow record with `status: 'stopped'` (same as today), discard terminal completion (same).
3. Stop channels, scheduler, drain admitted tasks (unchanged).
4. **Defensive runtime sweep:** iterate `_teammates.liveRuntimes()` (query) and force-stop any leaked runtimes via `runtime.stop()`. This is a safety net, not the primary close path. It logs a warning for every leaked runtime (which would indicate a bug, not normal operation).
5. Drain collaboration spaces, stop team runtimes (`teams.stopAll()`: same treatment — workflows stop via stopForShutdown, liveRuntimes sweep for leaks, then leader stop).
6. Stop dispatcher agent (unchanged).

Key changes from today:
- No more `releaseAllOwned()` in shutdown.
- No more distinction between "stopAll (waits and releases)" and "stopAllForShutdown (skips release and leaves to sweep)" at the collection level — both go through handle.close; the only difference is whether persistence of closed state gets a short budget.
- The collection is no longer the owner of any close orchestration during shutdown.

### 6.9 Settlement, completion routing, worktree synchronization

These concerns are outside the lifecycle refactor but must continue working:

- `routeSettledCompletion` remains an injected callback; it is not an event in the lifecycle-pub/sub sense because delivery can fail and be retried by the `CompletionRouter`, which is a separate concern from lifecycle facts.
- `SettledCompletionRoute` for owned teammates is still `WorkflowRun.handleAgentCompletion`; after close, any late settle is dropped at the entity (generation check) rather than resurrecting the workflow agent.
- `applyWorktreeCleanup` remains an entity command (called by TeamService during dissolve after physical cleanup). It is a mutation command on the entity, not a lifecycle event — ownership stays with TeamService (it owns the shared worktree lifecycle). The entity updates its own identity in response. No dependency direction change.
- `trackSettleCapture` is deleted. Container stop does not need to drain captures because every entity that has captures is closed via `close()` which drains them internally. The defensive sweep kills runtimes without draining captures (best-effort at shutdown is fine because process exits).
- `CompletionRouter.register` for public sends stays on the collection (it is routing bookkeeping tied to the public send adapter, not lifecycle).

## 7. Future attach-existing compatibility

The architecture admits a future `attachExisting(input, options)` capability on `TeammateFactory`:

```ts
interface TeammateFactory {
  spawnOwned(...): Promise<{handle, teammate, turn}>;
  attachExisting(input: { name: string }, options: AttachOptions): Promise<{handle, teammate}>;
}
```

Properties of the future extension that this design already supports:

1. **No "created by Workflow" type is encoded in the entity identity.** `role` ('teammate' | 'team_member' | 'team_leader') is set at identity create time and is scope/role-based, not membership-based. An ordinary teammate created via `teammate.spawn` has `role: 'teammate'` and can later have a MembershipClaim acquired against it.
2. **MembershipClaim is entity-owned and acquirable post-construction.** `entity.acquireMembership(claim)` works regardless of whether the entity was started with a claim or not; it throws only if another claim is already active (i.e., the TeamMate is already in another active Workflow).
3. **Close always releases the claim and closes the entity**, regardless of whether the entity was spawned or attached. A closed previously-attached entity is later reopenable as an ordinary TeamMate (same as spawn-then-closed). After close, prior Workflow linkage is preserved only in the WorkflowRun's durable records (which list the agent name) — not in the entity.
4. **The collection's `entities` cache is name-keyed; attaching an existing entity is a no-op for the cache** (the entity is already there, or is loaded via mustEntity just like a post-eviction send).
5. **The WorkflowRun agent record already stores {index, name, turn_id, status, result}**; it does not assume it was the creator. `attachExisting` returns a handle and (optionally) null turn_id (no initial turn submitted); WorkflowRun records `turn_id: null` and subsequent completion routing works the same.
6. **The `exclusivelyOwned` map is deleted**; if we kept it, the map would be a barrier to attach because it conflates "created by X" with "currently claimed by X". Replacing it with the entity-owned Membership means attach is just acquire + return handle.

## 8. Concrete code touchpoints

List of files to modify or create, grouped by module. New files are marked **NEW**; deletions are marked **DELETE**.

### Shared / neutral (new homes for reverse-edge helpers)

- **NEW** `packages/dreamux/src/service/agent-entity/agent-config.ts`: move `resolveAgent`, `defaultAgentRuntime`, `agentRuntimeCapability` from `service/teammate-collection/agent-config.ts`. These are pure config-resolution helpers with no collection dependency.
- **NEW** `packages/dreamux/src/service/agent-entity/read-helpers.ts`: move `foldLastTurns`, `toStatus`, `validateLastTurns`, `toRecordRow`, `matchesRecordQuery`, `clampHistoryLimit`, `encodeCursor`, `decodeCursor` from `service/teammate-collection/read-helpers.ts`.
- **DELETE** `packages/dreamux/src/service/teammate-collection/agent-config.ts` after moving.
- **DELETE** `packages/dreamux/src/service/teammate-collection/read-helpers.ts` after moving. Update all importers (collection itself, team-service, dispatcher-service, tests) to import from the new neutral location.

### TeammateService

- **NEW** `packages/dreamux/src/service/teammate-service/lifecycle.ts`: `TeammateLifecycleEvents`, `TeammateClosedEvent`, `TeammateLifecycleSource`, `TeammateLifecycleSubscription` (see §5.1).
- **NEW** `packages/dreamux/src/service/teammate-service/membership.ts`: `MembershipClaimId`, `createMembershipClaim()`, `Membership` interface + implementation (see §5.3).
- **NEW** `packages/dreamux/src/service/teammate-service/handle.ts`: `TeammateHandle`, `TeammateCloseResult` interfaces; `CloseTeammateOptions` with optional `shutdownBudgetMs` for shutdown persistence bound (see §5.2).
- `packages/dreamux/src/service/teammate-service/types.ts`:
  - Remove `trackSettleCapture?: (capture: Promise<void>) => void` from `TeammateServiceDeps`.
  - Add `lifecycle: TeammateLifecycleSource` (expose for subscriber wiring — actually, the service IS the source; it exposes an `events` getter).
  - Add `initialClaim?: MembershipClaimId` to `TeammateServiceOptions` so factory can attach claim at construction.
  - Update `SettledCompletionRoute` location stays (still entity-owned).
- `packages/dreamux/src/service/teammate-service/index.ts`:
  - Fix imports: replace `../teammate-collection/agent-config` with `../agent-entity/agent-config`; replace `../teammate-collection/read-helpers` with `../agent-entity/read-helpers`.
  - Add membership field: `private readonly membership: Membership;` initialized from options.
  - Add lifecycle source: `private readonly lifecycle = createTeammateLifecycle();` (simple EventEmitter-backed narrow source, not exposed as raw EventEmitter). Add `get events(): TeammateLifecycleSource { return this.lifecycle; }`.
  - Add single-flight close guard: `private closing: Promise<AgentEntityCloseResult> | null = null;` and `private closeGeneration = 0;`.
  - Add `closeByClaim(claim, opts)` method (claim-holder close); make `close({note})` (public) and `release()` delegate to shared internal `transitionToClosed` with claim check.
  - Refactor `transitionToClosed(closeNote, opts?)`:
    - Set `closing` promise, bump `closeGeneration`.
    - Set `closing` admission flag.
    - Cancel/stop runtime as today (bounded via SupervisedChild).
    - Drain `turnSubmissions` (extended to synthesize stopped outcomes for submissions that were never settled because runtime was killed).
    - Drain `settleWrites`.
    - Worktree cleanup (existing).
    - Persist `closed` (or under shutdown budget, give up and mark runtimeTerminated).
    - Release membership claim (so entity is publicly mutable post-close for reopens — note reopen path clears status anyway, but releasing is clean).
    - Emit `lifecycle.emit('closed', {...})` post-commit.
    - Resolve single-flight promise.
  - Add admission checks in `send`, `channelInput`, `scheduledInput`, `completionInput`, `ensureStarted`: (a) assert membership if public-facing (`assertPubliclyMutable()`), (b) check `closing` flag.
  - Harden `deliverSettledTurn` against late settles after close: if `closeGeneration > settleStartGeneration` or `identity.status === 'closed'`, log and drop.
  - Remove dependency on `trackSettleCapture` dep; captures are always tracked in entity-local `settleWrites`.
- **NEW** `packages/dreamux/src/service/teammate-service/factory-contract.ts`: `TeammateFactory`, `SpawnOwnedTeamMateOptions` (moved/adapted from owned-teammates), `AttachOptions` (future).

### TeammateCollection

- `packages/dreamux/src/service/teammate-collection/owned-teammates.ts`: **DELETE**. `OwnedTeammateOwner` replaced by `MembershipClaimId`; `SpawnOwnedTeamMateOptions` moves to `teammate-service/factory-contract.ts`; `OwnedTeammateOps` is deleted.
- `packages/dreamux/src/service/teammate-collection/types.ts`:
  - `TeammateOps` stays (admin surface for spawn/send/close/list/status/history/last/capabilities).
  - Remove any `OwnedTeammateOps` re-exports.
- `packages/dreamux/src/service/teammate-collection/index.ts`:
  - Remove `exclusivelyOwned: Map<string, OwnedTeammateOwner>` field.
  - Remove `inFlightSettleCaptures` field and drain loops in `stopAll`.
  - After constructing every entity in `entityFor()`, subscribe to `entity.events.on('closed', ...)`, which calls `this.onEntityClosed(entity, event)`. The handler:
    - `evictEntity(entity)` (CAS-guarded as today).
    - Logs a debug line.
    - Must NOT throw (wrapped in try/catch; subscriber errors never propagate to publisher).
  - Unsubscribe on eviction? Optional: store subscription handle and call `sub.off()` when evicting to avoid retaining GC references; not strictly necessary because the entity is being dropped.
  - Rewrite `spawnOwned`: create `MembershipClaimId` via `createMembershipClaim()`, pass `initialClaim` to factory, return `{ handle: new DefaultTeammateHandle(entity, claim), teammate: entity.status(), turn }`.
  - Rewrite `close(input)`: resolve entity, assert no active claim (via `entity.membership.assertPubliclyMutable()` — public close entry point), await `entity.close({ note: input.note })`, return result. **Do NOT call `evictEntity` here** — eviction happens in the `'closed'` subscriber.
  - Delete `releaseExclusive(entity)` entirely.
  - Delete `releaseAllOwned(owner?)` entirely.
  - Simplify `stopAll()`: iterate `entities.values()`, call `entity.stop()` (stop runtime only, no durable close — used by shutdown safety net? Actually we're moving shutdown to handle.close; keep `stopAll` as "stop all runtimes without persisting closed" for the defensive safety net but rename to `forceStopAllForShutdown()` and make it call `runtime.stop()` directly OR keep entity.stop() which is runtime-only). Add `liveRuntimes()` query (already exists today at line 170).
  - Update `cleanupFailedOwnedSpawn`: instead of calling `entity.release()`, call a new internal `entity.cancelSpawnFailure()` or just use the same `closeByClaim` path with the claim it created. This should still result in the entity emitting 'closed' and being evicted by subscriber.
  - Keep `assertPubliclyAddressable(entity)` but have it delegate to `entity.membership.assertPubliclyMutable()`.
  - Update `entityFor` construction to remove the injected `trackSettleCapture`.
  - Fix imports of agent-config and read-helpers to use the new neutral paths.

### WorkflowService / WorkflowRun

- `packages/dreamux/src/service/workflow-service/index.ts`:
  - Change `ownedTeammates: Pick<OwnedTeammateOps,'spawnOwned'|'releaseAllOwned'>` dependency to `teammates: TeammateFactory`.
  - Update constructor and `createRun` to pass `teammates` (factory) to WorkflowRun.
  - `stopAllForShutdown()` stays as an entry point but per-run finalize now calls `handle.close({shutdown:true})` rather than skipping release; see §6.8.
- `packages/dreamux/src/service/workflow-service/run.ts`:
  - Change deps: replace `ownedTeammates: Pick<OwnedTeammateOps,'spawnOwned'|'releaseAllOwned'>` with `teammates: TeammateFactory`.
  - Add `handle?: TeammateHandle` field to `AgentCall`.
  - Remove `private readonly teammateOwner = createOwnedTeammateOwner();` — no longer needed; claims are created by the factory.
  - In `executeAgent`, after calling `teammates.spawnOwned(...)`, store `call.handle = spawned.handle;` alongside name and turn_id.
  - In `finalize`, replace `ownedTeammates.releaseAllOwned(this.teammateOwner)` with `Promise.allSettled` over `call.handle.close()` for every call that has a handle. Under shutdown, pass `{shutdownBudgetMs: 2000}` or similar.
  - Remove `freezeAgentCalls` dependence on "release will happen later" — handles are closed in finalize even under shutdown (bounded). `freezeAgentCalls` still freezes calls that never spawned (queued/running that didn't get a handle yet).
- `packages/dreamux/src/service/workflow-service/types.ts`: no semantic changes; ensure `WorkflowAgentRecord.name` remains the durable source of truth for run→teammate linkage.

### Composition roots

- `packages/dreamux/src/service/dispatcher-service/index.ts`:
  - Wire `WorkflowService` with `teammates: _teammates` (as `TeammateFactory`). The collection implements `TeammateFactory` natively (it exposes `spawnOwned` returning handle).
  - In `doStop`/`shutdown`, replace `_teammates.releaseAllOwned()` with defensive `liveRuntimes()` sweep after workflows stop.
  - Remove releaseAllOwned from admittedTeammateOps/relevant wrappers.
- `packages/dreamux/src/service/dispatcher-service/dispatcher-workflows.ts`:
  - Adapt `ownedTeammates` wiring to new `TeammateFactory` shape. `spawnOwned` wraps in admit as before. There is no more `releaseAllOwned` to unwrap.
  - Update `rollbackStart`: call `service.stopAll()` (stopAndWait) then defensive `liveRuntimes()` sweep; remove `teammates.releaseAllOwned()`.
- `packages/dreamux/src/service/team-service/index.ts`:
  - Wire WorkflowService with `teammates` as `TeammateFactory`. The team-level `spawnOwnedTeamMate(input, options)` currently wraps shared workspace injection; adapt to return the handle and pass through.
  - Update `closeLogically` (`workflowService.stopAll()` then defensive `liveRuntimes()` sweep instead of `releaseAllOwned()`; then close each member/leader via entity.close which fires events).
  - `stopAll`: workflows via stopAllForShutdown, defensive liveRuntimes sweep, leader stop.
- `packages/dreamux/src/service/dispatcher-service/teammate-ops.ts`: admittedTeammateOps wrapper unchanged in shape (spawn/send/close/list/status/history/last/capabilities); close delegates to entity as before, but close now delegates directly (no more eviction bookkeeping).

### MCP / admin surface

- No changes required to `mcp/teammate-mcp.ts` or `admin/methods.ts`; they talk to `TeammateOps` / `WorkflowOps` which are unchanged as interfaces (close is still close; spawn is still spawn; workflow_stop return behavior is unchanged).

### Docs (.agents/)

- Update `.agents/reference/current-architecture.md` to describe:
  - TeammateService as lifecycle owner with event source.
  - TeammateCollection as factory/cache/roster + event subscriber.
  - TeammateHandle as narrow owner seam; MembershipClaim as write exclusivity.
  - Deletion of releaseAllOwned / releaseExclusive as lifecycle orchestration.
- Update `.agents/reference/repo-structure.md` if it references owned-teammates.
- Update maintenance skill doc if it describes teammate close flow.
- Add a new `.agents/reference/teammate-lifecycle.md` describing the lifecycle state machine, event contract, and shutdown budget semantics (per "Config/state maintenance synchronization" rule in AGENTS.md — this change touches lifecycle semantics so maintenance reference must be updated in the same PR).

## 9. Deletion list

Concrete items to delete:

1. `packages/dreamux/src/service/teammate-collection/owned-teammates.ts` — entire file.
2. `TeammateCollection.exclusivelyOwned: Map<string, OwnedTeammateOwner>` field and all reads/writes.
3. `TeammateCollection.releaseExclusive(entity)` method.
4. `TeammateCollection.releaseAllOwned(owner?)` method and the `OwnedTeammateOps` shape that exposed it.
5. `TeammateServiceDeps.trackSettleCapture` and `TeammateCollection.inFlightSettleCaptures` (entity close drains its own settleWrites).
6. The reverse-edge imports: move helpers to neutral modules, then delete from `teammate-collection/agent-config.ts` and `teammate-collection/read-helpers.ts` (only move, but the old paths go away).
7. `WorkflowRun.teammateOwner: OwnedTeammateOwner` symbol — replaced by per-handle MembershipClaimIds created by the factory.
8. The `releaseAllOwned` step in WorkflowRun.finalize (replaced by `handle.close()` on each held handle).
9. The `releaseAllOwned()` call in DispatcherService.doStop (replaced by defensive `liveRuntimes()` sweep).
10. The `releaseAllOwned()` call in DispatcherWorkflows.rollbackStart (replaced by `service.stopAll()` + defensive sweep).
11. The `teammateCollection.releaseAllOwned()` safety net in TeamService.closeLogically (replaced by defensive sweep; primary close happens via workflowService.stopAll).
12. The early-skip of releaseAllOwned in WorkflowRun.finalize's shutdownRequested branch — shutdown now also closes handles (with bounded budget), removing the two-path lifecycle.
13. Any tests that assert collection.evictEntity is called synchronously during close (they will be rewritten to await the `'closed'` event).
14. `OwnedTeammateOwner` type brand; all references replaced by `MembershipClaimId`.

Not deleted (intentionally):

- `TeammateCollection.entities` live cache (still useful for fast status/list projections; eviction just moves to event subscriber).
- `TeammateCollection.liveRuntimes()` query (needed for defensive shutdown sweep and Team dissolve idle barrier).
- `TeammateService.stop()` (runtime-only stop primitive, still used by the defensive sweep and tests).
- `CompletionRouter` registration paths (separate concern from lifecycle).
- `routeSettledCompletion` injection and `SettledCompletionRoute` (turn routing is not lifecycle).
- `applyWorktreeCleanup` command (entity-owned update triggered by TeamService after its own worktree lifecycle).
- WorkflowRunTerminal's separate `stop` / `stopAndWait` / `stopForShutdown` entry points; the difference between them shrinks to whether they wait for the terminal task and what persistence budget is passed to handle.close, but the MCP-return semantics are preserved.

## 10. Verification plan

### 10.1 Unit tests

- `teammate-service/close.test.ts` (new or extended):
  - Close idempotency: concurrent `close()` calls resolve to the same result.
  - Close-vs-send: send begun before close either completes or gets stopped; send begun after close admission fence throws.
  - Close-vs-start: concurrent ensureStarted is serialized; a runtime started in the race is stopped by `stop()`.
  - Immediate cancellation: `close()` called while a (mock) runtime is processing a turn causes runtime.stop() to be invoked; result is stopped, not waiting for natural completion.
  - Settle convergence: submitted-but-unsettled turns at close time are recorded as stopped outcomes.
  - Late settle: a settle callback that fires after close commits does not overwrite closed identity (generation fence).
  - `'closed'` event fires AFTER durable commit; if persistence throws, the event fires with `durableClosed: false` and runtime is still terminated.
  - Listener throw does not propagate to close caller.
  - Public close throws when a membership claim is held; closeByClaim succeeds with the correct claim, fails with wrong claim.
- `teammate-collection/eviction.test.ts` (rewrite existing release tests):
  - After entity.close() resolves, the collection has evicted the entity asynchronously (event subscriber) within a microtask.
  - After spawnOwned failure cleanup, entity is evicted via event subscriber.
  - A publicly-closed entity remains visible in durable roster (list/status after close show closed, do not throw "does not exist").
  - liveRuntimes() snapshot is consistent after close events.
- `workflow-service/stop.test.ts` (extended):
  - `workflow_stop` issued while an agent turn is in flight: finalize closes handles; terminal run record is persisted only after all entity closes resolve; no workflow-claimed runtime remains live after stopAndWait.
  - `stopAndWait` completes in bounded time (~1-2s) even when a runtime is in an infinite turn (immediate-cancel + SIGKILL proof via mock runtime with delay).
  - Agent tasks still queued when stop is requested (never made it to spawnOwned) are frozen to stopped status without attempting to spawn (existing behavior preserved).
- Membership claim gating:
  - send/close/completionInput/scheduledInput on an entity with an active claim throws the exclusive-ownership error.
  - handle.close() releases the claim; after close resolves, public send succeeds (on reopened entity).
  - Double-acquire throws; mismatched release throws.
- Reopen after workflow: workflow creates agent, stop closes it, then teammate.send on the closed agent reopens and sends normally; the workflow run record remains terminal.

### 10.2 Concurrency / race tests (deterministic, with mock runtime and controlled promise queues)

- Create-vs-stop: spawnOwned and stop called concurrently; one of two outcomes: (a) spawn completes, handle is created, close runs via finalize, entity closes; (b) spawn is rejected by admission fence, no entity or runtime leaks. Assert no half-entities (either durable identity exists and was closed, or no identity was created).
- Close-vs-settle: settle fires between runtime.stop() and identities.update(closed); late settle is either absorbed (recorded before close) or dropped (if after commit); no overwriting of closed state.
- Concurrent close: multiple callers (e.g. workflow.stop and server shutdown racing) resolve to same result; runtime.stop called once.
- Close-vs-attach (future extension, test the seam): after spawnOwned, attachExisting on the same entity throws; after close, attachExisting on a different workflow acquires a fresh claim.

### 10.3 Integration tests

- Team dissolve path: workflow with a long-running agent is started; team dissolve is requested; dissolve completes within bounded time (no waiting_for_team_idle stuck); all runtimes are terminated after dissolve.
- Server shutdown: dispatcher with a running workflow-agent receives shutdown; shutdown completes within bounded time; no child processes remain (assert by pid wait); workflow and teammate records are either durably closed or durably stopped (consistent); after restart, no stale "running" teammates have live runtimes (reconciliation test).
- DispatcherWorkflows.rollbackStart: if workflow start fails, stopAll completes bounded and defensive sweep finds no leaked runtimes.
- MCP surface: teammate.list/status/history/last show workflow-created teammates during the run (with "running" status), and show them closed (not missing) after workflow.stop.
- Public side-effect rejection: MCP teammate.send / teammate.close on an active workflow member returns the exclusive-ownership error before any runtime submission.

### 10.4 Existing load-bearing tests that must remain green

- Issue #63 non-blocking-inbound live gate (preserve — does not touch lifecycle).
- Issue #233 concurrent-start serialization (ensureStarted starting-promise guard — preserved; close coordination added alongside).
- Worktree safety tests (owned worktree cleanup on close; shared worktree NOT cleaned up by member release; TeamService.synchronizeWorktreeCleanup still propagates).
- Shutdown ordering tests (admission closes before runtimes killed; etc.).
- Persistence failure tests (close with failing identities.update must NOT report runtime live).
- Codex live tests (behind DREAMUX_SKIP_LIVE_CODEX=1 gate as today) — built-in runtime close must still trigger SIGTERM→SIGKILL escalation.

### 10.5 Static checks

- `rush lint` must still pass; in particular, verify no-sync-IO rule.
- `rush build` / `rush test` green.
- `.agents/scripts/check.sh` green after knowledge-base updates (§8).
- No import from `teammate-collection/` into any `teammate-service/` file (enforceable with a simple grep-based lint or import-boundary test).

### 10.6 Verification of dependency direction

After implementation, verify with a simple grep / import graph:
- Files under `service/teammate-service/` must not import from `service/teammate-collection/`.
- Files under `service/workflow-service/` must not import from `service/teammate-collection/` (only from `service/teammate-service/factory-contract` and other neutral modules).
- `TeammateHandle` is the only lifecycle type passed across the Workflow↔TeamMate seam.
- The string `releaseAllOwned` and `releaseExclusive` do not appear in product source.

## 11. Risks

1. **Event-subscription timing for immediate eviction.** If eviction happens asynchronously via microtask, there is a brief window where the cache still holds a closed entity. Mitigation: (a) emit `'closed'` synchronously inside `transitionToClosed` before returning (which is allowed because emit is synchronous for in-process EventEmitter), so subscribers run before close() resolves; (b) keep CAS-guarded evictEntity to handle double-evict from races; (c) add a defensive check in `send`/`close` adapters that detects `entity.current().status === 'closed'` and triggers eviction on-demand if event delivery was delayed (not expected, but safe).

2. **Test flakiness around event-driven eviction.** Existing tests that assert cache state immediately after close may need to await a setImmediate or process.nextTick, or be restructured to assert via the public `list()` projection after close resolves. Mitigation: write tests against public projections (list/status) rather than against internal `entities.size`, which is the behavior we actually commit to.

3. **Shutdown persistence budget choice.** A 2-second budget for durable closure during shutdown is a heuristic. Too short and we skip persistence routinely (relying on recovery); too long and shutdown hangs if disk IO is wedged. Mitigation: make the budget configurable via a small `SHUTDOWN_CLOSE_BUDGET_MS` constant, default 2000, and log a warning whenever persistence is abandoned so operators notice. The defensive runtime sweep is independent and always runs.

4. **Membership claim lifecycle during entity crash.** If a runtime crashes and the entity auto-closes internally (not via handle.close), the MembershipClaim needs to be released. Mitigation: the entity's internal crash path (any path that calls transitionToClosed outside of handle.close) must also release the claim. In this proposal, claim release is inside transitionToClosed, not inside handle.close, so all close paths release the claim.

5. **Settlement convergence details.** Converging submitted-but-unsettled turns to "stopped" requires extending `TurnSubmissionReadiness` to track submissions that never received a settle signal. This is straightforward (add an active-submissions set that is consulted at drain), but risks miscounting if a late settle arrives after drain and is dropped. Mitigation: the generation-fence check in deliverSettledTurn explicitly drops late settles, which is already the desired behavior (resurrecting a closed entity is worse than dropping one late completion).

6. **reverse-edge helper move may touch many files.** Moving agent-config and read-helpers to a neutral module updates imports in both the collection and (currently) the service plus tests. Mitigation: this is a mechanical codemod; do it as a separate first commit with no behavior change, then layer lifecycle changes on top for easier review.

## 12. Rejected alternatives

1. **Keep releaseAllOwned but rename it or move it to a "Workflow owns release" adapter.** Rejected because this is exactly the kind of renaming-without-fixing that the operator red line calls out: the collection (or a thin wrapper) still orchestrates entity close, only with a different name. The requirement explicitly says renaming `close` / `releaseAllOwned` / DTOs is insufficient.

2. **Make WorkflowService directly subscribe to entity events to know when to evict handles, instead of awaiting handle.close().** Rejected because: (a) Workflow finalize needs to know when close completes to persist terminal state — an event is overkill when the handle's close promise already provides that; (b) finalize should drive close, not merely observe it. The handle.closed promise is a convenient observer hook for OTHER subscribers (e.g., a future UI); for the owner, calling close() and awaiting its result is the right shape.

3. **Add a separate WorkflowAgent entity wrapping TeammateService.** Rejected because the requirement explicitly prohibits a Workflow-specific Agent entity or parallel runtime tree (non-goal #1). Workflow agents MUST be ordinary TeammateService entities visible through the normal TeamMate MCP surface.

4. **Use the existing DispatcherCoreEventBus for teammate lifecycle events.** Rejected because that bus is scoped to ChannelCoreEvent fan-out for route binding; reusing it for entity lifecycle events would create coupling between the channel-binding use case and teammate lifecycle, and would force all lifecycle events through the dispatcher scope even though team-scope teammates have their own collections. We add a per-entity narrow lifecycle source instead.

5. **Persist membership claim durably.** Rejected because the claim is a process-local exclusive write lease (like a lock), not a durable fact. It protects against cross-Workflow misuse of the entity within one dispatcher lifetime; after process restart, the entity is stopped (reconciled to stopped in recoverRunningRecords / WorkflowRun recovery) and the claim is gone. Persisting it would couple TeamMate identity to one Workflow, violating acceptance criterion 20 (future attachExisting must work).

6. **Have the collection wrap handle.close in a released adapter.** Rejected because that wraps TeammateService.close() just so the collection can do bookkeeping, which is exactly the forbidden pattern per the requirement ("The collection must not wrap TeammateService.close() merely so it can perform post-close bookkeeping"). The collection subscribes to the event; it does not wrap the command.

7. **Make stopForShutdown skip handle.close entirely (keep today's two-path behavior) but with a shorter grace window.** Rejected because the requirement says "Server shutdown reuses the same TeamMate close capability and does not need a separate Workflow-Agent resource lifecycle" (acceptance criterion 18) and "It does not preserve an in-flight turn for an additional natural-completion grace period" (criterion for immediate cancellation). The shutdown-close budget is a small persistence-only budget, not a separate kill path.

8. **Introduce a general-purpose domain event bus across all services.** Rejected as over-engineering for this task. The only cross-module lifecycle fact needed today is `'closed'`; per-entity narrow sources satisfy the need without a global bus. A bus can be introduced later if more subscribers need more event types.

9. **Remove the collection's live `entities` cache entirely and resolve everything from durable stores per-call.** Rejected because the cache is used for fast status projections, in-memory runtime lookup for liveRuntimes()/waitIdle, and identity-scope checks; rebuilding it per call would be expensive and would lose the ability to wire per-entity event subscriptions. The cache is not the problem; synchronous eviction-as-part-of-command is.

10. **Move owned-worktree cleanup out of TeammateService into a separate WorktreeLifecycle observer.** Plausible but out of scope for this refactor; the requirement does not name worktree ownership as broken, and moving it would add a new subscriber/layer without resolving the lifecycle dependency issue addressed here. Keep entity-owned cleanup on the entity.

---

## 13. Cross-review and revised position

This section was added in the second-round cross-review. It challenges the two sibling proposals (`arch-entity.md` and `arch-events.md`, at the frozen SHAs recorded in the task header) against current source, performs a self-audit against the operator red line and success semantics, and converges on a revised recommended architecture.

### 13.1 Challenges to `arch-entity.md`

**Accepted, with minor adjustments:**

1. **Post-KILL liveness re-check on `SupervisedChild` (§4.2).** Current source at `dreamux-utils/src/supervised-child.ts` performs SIGTERM→1s wait→SIGKILL but does not re-confirm process exit after SIGKILL. Adding a bounded post-KILL poll (e.g., 200ms) that throws if the PID still exists is a small, correct strengthening: it converts "runtime terminated" from an assumption to a proven fact. This is in scope because shutdown persistence budget and close-return semantics depend on the runtime actually being gone.
2. **Scoped-source per-entity lifecycle emitter (§5.1).** Mirrors `DispatcherCoreEventBus` (`service/dispatcher-core-events/index.ts`) which already uses a narrow `{unsubscribe(): void}` shape with per-listener try/catch and frozen payloads. Adopt this pattern for the `closed` event emitter on `TeammateService`.
3. **Tagged, schema-versioned event payload (§5.2).** A `{schema_version, kind, action, ...}` envelope is a small forward-compat cost that aligns with the existing core-event convention. Adopt for the `closed` event.
4. **CAS-guarded eviction in the collection subscriber (§5.3).** `evictEntity` must compare a `generation` counter on the entity so a late stale event cannot evict a newer (re-attached, future `attachExisting`) instance. This is consistent with my own proposal's generation fence; make it explicit on the collection side too.
5. **Listener isolation.** Listener throw must not roll back the committed transition. `emit` iterates listeners with try/catch and logs; this is already how `DispatcherCoreEventBus` behaves. Affirm.

**Rejected:**

1. **Membership map owned by Collection (`activeMembership: Map<name, Membership>`) instead of entity (§3.2).** This is the central boundary disagreement. Source-grounded reasons to keep membership on the entity:
   - Current code places `exclusivelyOwned` on `TeammateCollection` (line ~24 of `teammate-collection/index.ts`). The collection ALREADY owns the entities cache and the dispatch/registerCompletion bookkeeping. Putting membership there too makes every public mutation on the entity (send, ensureStarted, close) need to check a map that lives outside the entity. That forces the entity to consult the collection on every write — a reverse dependency in spirit even if wired via callback.
   - The entity is the fact-owner for "am I closed?" and "who currently holds the write claim on me?" If membership lives on the collection, a crashed/restarted entity whose map entry is stale (the collection still sees it as claimed but the entity's own state is closed) creates a split-brain that must be reconciled. Entity-owned membership makes the claim and the entity state always co-located; CAS-claim by the factory and release on `transitionToClosed` is atomic with respect to await ordering on the entity.
   - Future `attachExisting` (acceptance criterion 20) requires that an entity already in the collection can be claimed by a NEW Workflow without being recreated. If membership is on the entity, the claim-CAS is a single atomic `claim.compareExchange(null, newClaim)` on the entity; if membership is on the collection, attach requires mutating a collection-owned map from outside the collection's spawn/close flows, reintroducing cross-module mutation.
   - The entity's own admission gate (rejecting send/ensureStarted after close or when claim mismatches) is the fast-path defense. A collection-owned map makes that gate a slow call back to the collection, which is exactly the "core re-deriving state a lower layer already owns authoritatively" smell called out in AGENTS.md architecture discipline.
   - **Revised position:** membership stays entity-owned. The collection still exposes a narrow `assertCanWrite(name, claim)` for user-facing error messages (e.g., "that TeamMate is owned by another workflow"), but this method READS the entity's membership — it doesn't own it.

2. **Retention of `trackSettleCapture` / `inFlightSettleCaptures` (§3.4, §6.2).** `arch-entity` keeps the current `stopAll` pattern of draining `inFlightSettleCaptures` after issuing stops. Source shows `trackSettleCapture` is wired through `TeammateServiceDeps` (`service/teammate-service/types.ts`) and is called by the collection's `registerCompletion` immediately after submitting a turn. Its purpose is to ensure that even after a runtime is killed, in-flight settle-promise writes finish before `stopAll` resolves. But:
   - `TeammateService.transitionToClosed` (lines 260-289) ALREADY drains `this.settleWrites` after stopping the runtime. `stopAll`'s second drain is a second layer for settles whose promise was obtained by the collection BEFORE the entity was asked to stop, but which hadn't been awaited yet.
   - If we route all close through `handle.close()` → `entity.close()` → `transitionToClosed` (which drains settleWrites), AND the collection's registerCompletion always attaches its thenable to the entity's settleWrites set (instead of the collection's own `inFlightSettleCaptures`), then a single drain inside `transitionToClosed` is sufficient. The collection no longer needs to track captures because it never drives close; the entity does.
   - Keeping `inFlightSettleCaptures` on the collection is residual glue from the era when the collection owned close. Retaining it preserves a secondary drain that masks missed regressions (a settle write not attached to `entity.settleWrites` would still be awaited by the collection, hiding the ownership bug).
   - **Revised position:** delete `trackSettleCapture` / `inFlightSettleCaptures`. All settle-write tracking moves onto the entity; `registerCompletion` attaches the write to `entity.settleWrites` (or an equivalent per-entity write-set) at submission time.

3. **`workflow_stop` MCP command awaits full close before returning (§6.4).** Re-reading requirement acceptance criterion 11: "A successful `workflow_stop` must not claim a terminal Workflow while its borrowed TeamMates continue running." This constrains DURABLE terminal-state commit — the WorkflowRun must not be persisted as terminal until close is done. It does NOT require the MCP response to block until that commit. Current source at `run-terminal.ts` `initiateStop` returns `'stopped'` immediately after requesting stop (detached `void this.request`). Requirement acceptance criterion 12 says "'Stopping' is visible before terminal 'stopped' (stop feedback is immediate)." Making the MCP command itself block until full close would break that feedback contract.
   - **Revised position:** keep immediate-return UX. The detached finalize path awaits `handle.close()` for every owned teammate BEFORE persisting the terminal workflow record. The MCP returns `'stopped'` immediately; a subsequent `workflow/get` sees `status: 'stopping'` until finalize completes the closes and the terminal persist; then `'stopped'`. `stopAndWait` (used by team dissolve and shutdown) still awaits full finalize and therefore full close.

4. **`DispatcherCoreEventBus` reused directly for teammate lifecycle events (§5.1 note).** As stated in my rejected alternative #4, that bus is scoped to channel-core route-binding events. Reusing it forces lifecycle events through dispatcher scope even for team-collection teammates. Per-entity emitter is the narrower, owner-correct choice. Revise: per-entity narrow emitter; we can add a shared utility type for the scoped-source shape if both sites converge on the same envelope, but we do not merge busses.

### 13.2 Challenges to `arch-events.md`

`arch-events.md` is substantially larger in scope (submission_id, canonical-JSON request fingerprints, durable runtime-resource lease sidecars, arm/guard/terminate handshake, `TurnHandle` with settled promises, `TeammateMutationClaims`, `WorkflowTeammatePort`, removal of `getRuntime()`/`stop()`, multi-phase restart bootstrap, async `EventBridge` for strict stores, additive durable schema changes with BREAKING note, strict JSONL with torn-tail repair, Workflow-runner lease/reaper, `TeamAgentWorktreeProjection`).

**Accepted subset:**

1. **Membership/claim release only after Workflow terminal persistence (§4.3).** Releasing the MembershipClaim inside `entity.close()` (as my round-1 proposal did) allows a narrow window between entity-close and Workflow terminal persist where the entity is closed (new turns rejected) but the claim is already freed. Refinement: release the MembershipClaim as the LAST step of `handle.close()`, after `entity.close()` resolves. This keeps name-claim held until the handle is done, which preserves the invariant that no new spawn can claim the same name while the handle is still held by the finalizing Workflow.
   - Concrete ordering inside `handle.close()`: (a) await `entity.close(note)` which runs stop → drain settleWrites → durable identities.update to status:'closed' → resolve; (b) `entity.membership.release(claim)` (CAS null). After step (a) the entity rejects all new writes; after step (b) the name is free for future spawn/attachExisting.
   - WorkflowRun.finalize ordering then becomes: (1) freezeAgentCalls(), (2) await agentTasksDrained, (3) for each handle `await handle.close()`, (4) persist terminal Workflow record. Since step 3 releases claims only after entity close, and step 4 follows step 3, the "no terminal claim while teammates run" invariant (criterion 11) holds: terminal persist cannot happen until close (kill+drain+durable close) completes. Critically, this also means claim release happens BEFORE terminal persist, which is safe because the entity is already closed (new turns rejected) by that point.
   - Handle GC-without-close logs a warning via WeakRef finalizer and releases the claim to avoid permanent leaks on bug paths.

2. **Async bridge for strict store events (§7.2).** If a future strict-ledger initiative adds synchronous-committed store hooks, emitting the `closed` event from inside the store commit breaks listener isolation. A small async microtask deferral (`void Promise.resolve().then(() => emit(...))` inside try/catch) ensures the event fires after commit and never propagates listener throws into the commit path. This is cheap and correct; adopt even though today's `identities.update` is already async.

3. **Narrow writer-activity indicator instead of public `getRuntime()` for dissolve idle barrier (§8.2 note).** `getRuntime()` exposes the runtime internals too broadly. Replace with a narrow `isWriterActive(): boolean` (or `waitForWriterIdle(): Promise<void>`) that `TeamService` can use for dissolve-idle gating without exposing the runtime object. This is a follow-up tightening, not in the mandatory root-cause set.

**Rejected — out of scope or not authorized by this requirement:**

1. **`submission_id`, request fingerprints, canonical-JSON SHA-256, strict JSONL with torn-tail repair, BREAKING durable schema changes.** These are crash-safety hardening for the turn/settlement ledger. The requirement does not mention turn-ledger corruption, torn writes, or submission deduplication as a problem to solve. These changes require a BREAKING schema change, which per AGENTS.md "Config/state maintenance synchronization" and "Changelog Responsibility" rules needs explicit operator approval and a `Rebuild:` / `Review:` note. This task has not been granted that approval. Adding these here conflates lifecycle dependency reversal with an unrelated strict-ledger initiative, bloating the change surface and delaying the root-cause fix. Move to a separate proposal/task.
2. **Durable runtime-resource lease sidecars (files) + arm/guard/terminate handshake + runner lease/reaper.** This targets a real but separate bug: that `SupervisedChild` termination without post-KILL proof can leave leaked runtime processes on crash. The operator red line is about dependency direction, not about runtime-resource crash-proofing. The lightweight post-KILL liveness poll accepted from `arch-entity` §4.2 is sufficient to close the "stop is proven" gap for this task. A full lease/reaper system is a separate piece of work.
3. **`WorkflowTeammatePort` adapter removing direct Workflow→Collection dependency.** This is a plausible architectural direction (a port/anti-corruption layer between workflow-service and teammate-collection) but is not required by the requirement. The requirement targets the reverse edge: Collection must not drive entity close. Workflow→Collection (or Workflow→Factory) is the forward direction and is not the bug. Adding a port layer here is premature abstraction; it should follow a separate decision.
4. **Removing public `TeammateCollection.send/close/stop` adapters entirely, forcing one-shot handles.** The requirement says: "A public adapter may resolve a TeamMate through the collection, but the collection must not wrap TeammateService.close() merely so it can perform post-close bookkeeping." It explicitly permits resolution adapters. Removing them breaks the MCP surface that uses `teammate/close` / `teammate/send` going through the collection. Keep the adapters; ensure `collection.close(name, input)` does `entity = this.get(name); await entity.close(input)` and then returns — no synchronous evict, no bookkeeping. Eviction happens on the event subscriber.
5. **Removing `stop()` from `TeammateService`.** `stop()` is used today by `stopAll` for non-exclusive entities (line 454) and is a lower-layer primitive for "kill the runtime without closing the durable record." Shutdown's defensive sweep needs exactly this primitive (liveRuntimes().stop() on leaked runtimes that have no handle). Keep it, but: (a) remove it from the `TeammateHandle` public surface (handles only expose close), (b) keep it accessible to composition-root services (TeammateCollection for defensive sweep, tests), (c) rename or comment it as a low-level primitive not to be used as lifecycle API. No need to delete to satisfy this task.
6. **`TurnHandle` with settled promises and `TeammateMutationClaims` neutral module.** Plausible future direction, but replacing the existing `turnSubmissions.drain()` + `settleWrites` pattern in the same change as lifecycle reversal piles on risk. Not required by the requirement. Defer.
7. **Multi-phase restart bootstrap and `TeamAgentWorktreeProjection`.** Out of scope. Restart/recovery reconciliation is an existing behavior; this task does not change it (entity-owned membership is process-local, so restart clears all claims naturally as entities start in non-claimed state).

### 13.3 Self-audit against operator red line and success semantics

Auditing my round-1 proposal point by point:

1. **Entity-owned membership claim.** After review (§13.1 challenge 1, §13.2 accepted 1), refined: entity owns the `Membership` object (CAS claim from null → claim, release to null), the `TeammateHandle` holds the claim, and `handle.close()` releases the claim after awaiting `entity.close()`. This satisfies future `attachExisting` (claim-CAS on the entity), avoids Collection re-deriving write-authorization state, and keeps the admission gate on the entity.
2. **`durableClosed: false` on the event payload.** Meaning: entity.stop() succeeded, settleWrites drained, but durable `identities.update` to `status: 'closed'` failed. The runtime is killed, but the persisted record still says 'running'. This is a real state (partial failure). The event MUST still fire so the collection can evict (the entity is unusable in memory), but listeners MUST treat it as "crashed closed" rather than "clean closed." The payload includes `persistenceError?: Error` to distinguish. Self-check: firing the event on persistence failure does not violate listener isolation because the emit is post-commit-attempt (we tried and failed; the error is captured). The Workflow's finalize will also throw from `handle.close()` if persistence fails (since close throws on identities.update failure), preventing terminal persist. Correct.
3. **Shutdown persistence budget.** Round-1 proposed a small budget (default 3s) for `identities.update` during shutdown; if budget expires, close returns with `durableClosed: false` and the event fires with `persistenceError: 'shutdown-budget-exceeded'`. Self-check: this is NOT a natural-completion grace period (which is forbidden by acceptance criterion 18); it's a persistence-only budget to give the durable update a chance to flush before process exit. If the host is killing us, we issue SIGKILL first, then race persistence against the budget. If the budget expires, we exit without durable close; the next startup reconciles via `recoverRunningRecords`. This is consistent with criterion 18 ("Server shutdown reuses the same TeamMate close capability") — same close() call, just with a shorter persistence budget.
4. **Defensive raw-runtime sweep on shutdown.** Round-1 proposed that after closing all known handles, shutdown does a `teammateCollection.liveRuntimes()` query and stops any runtime not associated with a handle (leaked). This is a QUERY, not a command path: it discovers orphans and kills them. It does NOT go through collection.close() or any bookkeeping wrapper; it calls the low-level `runtime.stop()` on orphaned runtime objects. Self-check: this is acceptable defensive programming for shutdown (analogous to `SIGCHLD`-wait on POSIX), it is not part of the normal lifecycle path, and it does not re-route entity close through the collection. Correct.
5. **Public `TeammateCollection.close(name, input)` adapter.** Round-1 kept this adapter as `entity = this.get(name); entity.close(input)` with no post-close bookkeeping; eviction happens via event subscription. Self-check against requirement: "The collection must not wrap TeammateService.close() merely so it can perform post-close bookkeeping." My adapter does NO post-close bookkeeping — it's a pass-through. It does NOT evict synchronously, does NOT touch `exclusivelyOwned`, does NOT touch `inFlightSettleCaptures`. It resolves and delegates. This satisfies the requirement.
6. **Retained callbacks (`routeSettledCompletion`, `trackSettleCapture`).** `trackSettleCapture` is deleted per §13.1 rejection 2. `routeSettledCompletion` remains as an INJECTED callback on `TeammateServiceDeps` because completion routing (which producer/channel to deliver a settled turn to) is owned by the dispatcher/router layer, not by the entity. The entity calls the callback when a turn settles; it does not know or care about routing. This is a standard dependency-injected output port, not a lifecycle dependency. It does not create a reverse edge because it is set at construction time and flows one direction (entity → deps.router). Self-check: the operator red line is about command direction (Collection telling Entity to close), not about dependency-injected completion notification. Keep `routeSettledCompletion`; delete `trackSettleCapture`.
7. **Event emission timing.** Per §13.2 accepted 2, emit asynchronously (microtask after close's return) inside try/catch. Listener throw is logged and does not affect close's return. This matches listener isolation.
8. **Reverse-edge import move.** `teammate-service/index.ts` currently imports `read-helpers` and `agent-config` from `../teammate-collection/` (lines 18-23). These move to a neutral shared module (new dir `service/agent-entity/` or under `dreamux-utils` — choice to be made in implementation, but direction is "shared, owned by neither"). `teammate-service` drops its imports from `../teammate-collection/`. Build graph becomes: `workflow-service` → `teammate-collection` → `teammate-service`; `teammate-service` → `agent-entity` (neutral). No service → collection edge.

### 13.4 Revised recommended architecture (converged)

**Membership:**
- `Membership` is a small class on `TeammateService` (entity-owned).
- State: `claim: MembershipClaim | null` where `MembershipClaim` is a branded opaque token created by `TeammateFactory`.
- CAS transitions: `tryClaim(claim): boolean` (null→claim), `release(claim): void` (asserts matching claim, sets null).
- `TeammateHandle` holds the `MembershipClaim` for its lifetime; `handle.close()` calls `entity.close()` then `entity.membership.release(claim)`.
- Releasing the claim is the LAST step of handle disposal (after entity.close() resolves), matching current ordering where releaseAllOwned follows transitionToClosed.
- Collection exposes a delegated `assertCanWrite(name)` for user-facing errors that reads `entity.membership.claim` — does not own the state.

**Handle (`TeammateHandle`):**
- Created ONLY by `TeammateFactory.spawnOwned({name, runtimeId, config, ownerNote})`.
- Surface: `{name, close(opts?: {note?: string, persistenceBudgetMs?: number}): Promise<CloseResult>, closed: Promise<CloseResult>, membership: MembershipClaim (package-private)}`.
- No `release()` alias; one `close()` method. Owner-silent close (current `release()` path with null note) is `close({note: undefined, silent: true})` or equivalent — single method.
- `closed` promise is idempotent (multi-close safe).
- Disposal without close logs a warning via WeakRef finalizer.

**Entity lifecycle events:**
- Per-entity lifecycle emitter (mirrors `DispatcherCoreEventBus` scoped-source shape).
- `'closed'` event emitted asynchronously (post-commit-attempt, microtask-deferred), per-listener try/catch, frozen payload.
- Payload envelope: `{schema_version: 1, kind: 'teammate', action: 'closed', name, durableClosed, closeNote: string|null, persistenceError?: {code: string, message: string}, generation: number}`.
- `generation` is a monotonic counter on the entity incremented on each spawn/close cycle, used by Collection subscriber for CAS evict.

**Collection subscriber:**
- On entity creation (factory returns entity), collection subscribes: `entity.lifecycle.on('closed', ev => this.evictIfCurrent(ev))`.
- `evictIfCurrent`: if `this.entities.get(ev.name)?.generation === ev.generation`, remove from `entities` map, unsubscribe. Otherwise no-op (stale event).
- Subscriber errors are logged, never thrown.

**Reverse-edge fix:**
- Move `read-helpers` and `agent-config` (the symbols imported by `teammate-service` from `teammate-collection/`) into a neutral shared module.
- `teammate-service` drops its imports from `../teammate-collection/`.
- Build graph becomes strictly layered.

**Shutdown:**
- Single path. `stopAllForShutdown` / `doStop` / team dissolve all go through handles: iterate owned handles, `handle.close({persistenceBudgetMs: 3000})`.
- After all handles close (or budget out), do a defensive `liveRuntimes()` query sweep and force-kill orphans via low-level `runtime.stop()` (no bookkeeping, no membership touch — just process kill).
- `SupervisedChild.doStop` strengthened with post-KILL bounded liveness re-check (accepted from arch-entity §4.2).

**WorkflowRun.finalize ordering:**
1. `freezeAgentCalls()` (existing).
2. Await agent-tasks-drained (existing, `agentTasksDrained` flag).
3. For each owned handle: `await handle.close({note: 'workflow-finalize'})`. This (a) stops runtime, (b) drains settleWrites, (c) persists status:'closed', (d) releases MembershipClaim.
4. Persist terminal WorkflowRun record (success/failed/canceled).
5. Respond to waiters (stopAndWait resolves, dissolve completes, etc.).

This ordering ensures acceptance criterion 11 (no terminal claim while teammates run): step 4 cannot happen until step 3 completes all closes.

**MCP `workflow_stop` UX:** stays immediate-return. `initiateStop` detaches finalize; MCP returns 'stopped'; status flips to 'stopping' then 'stopped' as terminal persist completes. Note: this is a disputed point (§13.6 escalation 3); the TeamLeader will adjudicate against requirement text.

### 13.5 Mandatory root-cause work vs. optional follow-ups

**Mandatory (this proposal, gated by the requirement):**
- Move reverse-edge helpers (`agent-config`, `read-helpers`) to a neutral module; remove service→collection imports.
- Introduce entity-owned `Membership` with CAS claim/release; `TeammateHandle` returned by `TeammateFactory.spawnOwned`.
- Add per-entity lifecycle emitter on `TeammateService`; emit `'closed'` async post-commit-attempt with envelope `{schema_version, kind, action, name, durableClosed, closeNote, persistenceError?, generation}`.
- `TeammateCollection` subscribes on entity creation; CAS-guarded evict via generation compare; no synchronous post-close bookkeeping in adapter.
- Delete `OwnedTeammateOwner`, `OwnedTeammateOps`, `releaseExclusive`, `releaseAllOwned`, `stopAll`/`releaseAllOwned` two-path split, finalize's shutdown-skip branch, `doStop`'s standalone releaseAllOwned.
- Delete `trackSettleCapture`/`inFlightSettleCaptures`; entity is sole owner of settle-write tracking.
- Unify `close()`/`release()` into a single `handle.close({note?, silent?, persistenceBudgetMs?})`.
- WorkflowRun.finalize awaits handle.close() for all owned teammates BEFORE terminal persist.
- Shutdown reuses same handle.close() with persistence budget; defensive liveRuntimes() sweep as last-resort orphan kill.
- Strengthen `SupervisedChild.doStop` with post-KILL bounded liveness re-check.
- One public `Collection.close(name, input)` adapter that resolves and delegates, no bookkeeping.

**Optional follow-ups (separate proposals/tasks, NOT in this change):**
- Strict turn ledger (submission_id, fingerprints, strict JSONL, torn-tail repair).
- Durable runtime-resource lease sidecars + arm/guard/terminate + runner reaper.
- `WorkflowTeammatePort` anti-corruption layer between workflow-service and teammate-collection.
- Removal of public entity mutation methods in favor of one-shot handles.
- Narrow writer-activity indicator replacing `getRuntime()` for dissolve idle barrier.
- `TurnHandle` settled-promise wrapper for submission lifecycle.
- Global domain event bus (if more subscribers need more event types beyond 'closed').
- Owned-worktree lifecycle observer (separate subscriber for worktree cleanup).

### 13.6 Escalations / points for adjudicator resolution

Items where sibling positions materially differ and the adjudicator must choose:

1. **Membership ownership: entity (this proposal) vs. collection (entity proposal).** I recommend entity-owned for the reasons in §13.1.1; adjudicators should weigh future `attachExisting` and admission-gate locality.
2. **Deletion vs. retention of `trackSettleCapture`/`inFlightSettleCaptures`.** I recommend delete; entity proposal retains. Risk of retention: masks ownership bugs by having two drains.
3. **`workflow_stop` MCP blocking vs. immediate return.** Entity proposal suggests blocking; events proposal's TurnHandle leans toward blocking settlement. I recommend immediate return with detached finalize, per acceptance criterion 12's "stop feedback is immediate" wording.
4. **Scope of this change: lifecycle reversal only (this proposal) vs. including crash-safety hardening (events proposal).** I recommend narrow scope; broad hardening should be a separate task with explicit BREAKING approval.
5. **Retention of `TeammateService.stop()` as low-level primitive.** Events proposal removes it; I keep it (for defensive sweep and non-exclusive stopAll) restricted from handle surface.
6. **Public Collection.close/send adapter retention vs. removal.** Events proposal removes; I keep (requirement explicitly allows resolution adapters; removal breaks the existing MCP surface).

### 13.7 Final recommendation

Adopt the entity-owned membership + per-entity `'closed'` lifecycle event + async subscriber eviction design described above. The root cause of the current design defect is that close is a fact about an entity, but today the Collection owns the close command and performs post-close bookkeeping synchronously, which creates the forward command dependency the operator red line prohibits. Fixing that requires: (a) the entity owns its close and emits a closed event after commit, (b) the Collection (and any other subscriber) listens and performs its own bookkeeping (cache eviction), (c) owners (WorkflowRun, Dispatcher, TeamService for dissolve) close through handles, not through Collection-owned release methods, (d) shutdown reuses the same handle.close path with a persistence budget, (e) the reverse-edge imports move to a neutral module to restore a clean build graph.

The post-KILL liveness poll from entity proposal is a small, worthwhile strengthening of the runtime-termination proof. The crash-safety hardening in events proposal is deferred to follow-up work — it targets a different defect class and requires BREAKING schema approval not granted by this task.

### 13.8 Updated deletion list

Carried from round-1, adjusted for cross-review:

- `packages/dreamux/src/service/teammate-collection/owned-teammates.ts` (entire file).
- Symbols: `OwnedTeammateOwner`, `createOwnedTeammateOwner`, `OwnedTeammateOps`, `TeammateCollection.exclusivelyOwned` (map), `TeammateCollection.releaseExclusive`, `TeammateCollection.releaseAllOwned`, `TeammateCollection.inFlightSettleCaptures` (set), `TeammateCollection.trackSettleCapture` (deps field / method).
- `TeammateServiceDeps.trackSettleCapture` from `service/teammate-service/types.ts`.
- `TeammateService.release()` method (merged into `close()`; silent-owner-close uses `close({silent: true})` or undefined-note variant).
- `WorkflowRun.teammateOwner` symbol and associated ownership plumbing; replaced by `ownedTeammateHandles: Set<TeammateHandle>`-style tracking.
- `WorkflowRun.finalize`'s shutdown-skip branch (the `!shutdownRequested` gate around releaseAllOwned at lines 580-586 in current run.ts).
- `DispatcherService.doStop` standalone `this._teammates.releaseAllOwned()` call (line 279); replaced by handle iteration.
- Reverse imports in `teammate-service/index.ts` of `../teammate-collection/agent-config` and `../teammate-collection/read-helpers`; these symbols move to a neutral module with no dependents in the collection.
- `WorkflowService.stopAllForShutdown`'s skip-release-then-sweep pattern; merged into the single handle.close path.
