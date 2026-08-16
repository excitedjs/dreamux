# Architecture Proposal: Unified Teammate Lifecycle (entity/event-owned close)

Author seat: `arch-entity`. First-round independent proposal. Baseline
inspected: `6b8ec14b080389bf6c6ae36fa336ec0451e401ec`.

This proposal answers the frozen requirement
(`requirement.md`, SHA-256 `863d7c8f…5ee9e08`). It designs, does not implement.
No product code, tests, or requirement text are modified by this document.

---

## 0. Operator red line (binding)

The following operator wording is normative and is the rejection criterion for
this proposal and any competing one:

> 关闭 TeamMate 不应该经过 TeamMate Collection。而应该是 TeamMate 对外抛出事件，由
> TeamMate Collection 监听事件之后，把它从自己的引用中移除掉。

> 不要搞那种正向依赖关系，就是为了让 TeamMate Collection 感知到 TeamMate 关闭了，
> 需要通过 TeamMate Collection 的 Close 调用到 TeamMate 的 Close。

Restated as an acceptance rule I hold this design to: **a subscriber's need to
observe an entity fact must never force the fact-owning entity's command path to
route through that subscriber.** Renaming `close` / `releaseAllOwned` / their
DTOs does not satisfy the requirement; the *direction* of the dependency must
reverse. The current
`TeammateCollection.close()` → `entity.close()` → `this.evictEntity(entity)`
shape (`teammate-collection/index.ts:326-332`) is exactly the "collection is the
second lifecycle owner" pattern the red line forbids, and this proposal deletes
it.

---

## 1. The defect this task eliminates

Two facts from the current source define the failure mode:

1. **Collection owns close bookkeeping as a second lifecycle owner.** Every
   public teardown verb wraps the entity command and then mutates collection
   state as a mandatory second step:
   - `close()` → `entity.close()` then `this.evictEntity(entity)`
     (`teammate-collection/index.ts:326-332`);
   - `releaseExclusive()` → `entity.release()` then `exclusivelyOwned.delete` +
     `evictEntity` (`:607-611`);
   - `releaseAllOwned()` / `stopAll()` iterate entities and drive
     `releaseExclusive` (`:450-481`).
   The collection cannot learn that a TeamMate closed *except* by being the
   caller that closed it. That is the forbidden forward dependency.

2. **Workflow stop returns `stopped` before teardown, and skips it entirely on
   two branches.** `WorkflowRunTerminal.initiateStop()` returns the reserved
   `'stopped'` synchronously via a detached `void this.request(...)`
   (`run-terminal.ts:76-82`), while `releaseAllOwned(this.teammateOwner)` runs
   later inside `finalize`, *gated* on `agentTasksDrained && !shutdownRequested`
   (`run.ts:580-586`). So `workflow_stop` reports a terminal Workflow while its
   borrowed runtimes may still be live, and on the shutdown branch or a
   never-draining branch the release never happens at all — the Team-dissolve
   `waitIdle` barrier (`dissolve-runner.ts:274-288`) can then hang on a member
   whose runtime was never asked to stop.

The requirement's deeper instruction (operator quote 2) is that this reversal
must be applied to **every** three-module interaction that exists only so an
outer container can observe an inner entity fact — not just `close`.

---

## 2. Modules, capabilities, and authoritative facts

Three service modules plus the composition root. I name each module's
capability set, the facts it authoritatively owns, and its lifecycle closure.

### 2.1 `TeammateService` — the entity; owns and self-closes one TeamMate lifecycle

**Authoritative facts it owns:** the live `AgentRuntime` handle, the runtime
start/resume/stop, turn submission + settlement persistence, the durable
`identity.json` `status` transitions (via `AgentRuntimeStateStore` +
`AgentIdentityStore`), and entity-owned worktree cleanup on close
(`ownsWorktreeOnClose`).

**New capability it gains:** an **admission fence** and a **committed lifecycle
event source**. Close becomes a fully self-contained, admission-fenced,
single-flight, immediately-cancelling entity operation that ends by *publishing*
a committed `closed` fact — it does not call back into any container.

Capability set (target):

| Verb | Kind | Notes |
|---|---|---|
| `ensureStarted` / `send` / `channelInput` / `scheduledInput` / `completionInput` | command | unchanged, but now cross an **admission gate** (§4.1) that a concurrent close closes first |
| `close({ note })` / `release()` | command | converge on `transitionToClosed`; now fenced, single-flight, immediately-cancelling, and event-publishing |
| `status` / `last` / `current` / `getRuntime` | query | unchanged |
| `lifecycle` (new) | **event source** | a revocable `AgentEntityLifecycleSource` the entity exposes; publishes `closed` after the durable transition commits (§5) |
| `applyWorktreeCleanup` | command | unchanged (owner-performed shared-worktree sync) |

**Lifecycle state machine (single source of truth):**

```
        ensureStarted / send            close()/release()
 [durable status]  ── starting ──▶ running ──────────────┐
        ▲                              │                  ▼
        │ ensureStarted({reopenClosed})│           (admission closed)
        │                              │            immediate cancel
        └──────────── closed ◀─────────┴──────────  transitionToClosed
                                                     ├ stop runtime (bounded)
                                                     ├ drain submissions+settles
                                                     ├ entity worktree cleanup
                                                     ├ commit identity=closed  ← authoritative fact
                                                     └ publish lifecycle:closed ← post-commit
```

The durable `identity.status` is the single authoritative lifecycle fact. The
event is a *post-commit notification of that fact*, never a request for another
module to finish the transition. `reopenClosed` re-opens the same identity — it
is not a new entity, preserving the reuse contract (requirement §Visibility,
criterion 15).

### 2.2 `TeammateCollection` — the container/directory; observes, never owns close

**Authoritative facts it owns:** the one creation path + `TeammateService`
factory, durable roster/turn-store access, the live entity **cache**
(`entities: Map<name, TeammateService>`), and the normal read surfaces
(`list` / `status` / `history` / `last`).

**What it loses:** ownership of the close state machine. It no longer *drives*
`entity.close()` / `entity.release()` as a step in its own public verbs, and it
no longer evicts as a mandatory second step of a close it initiated.

**What it gains:** it **subscribes** to each cached entity's `lifecycle` source
at registration time and evicts the live reference in the `closed` handler — a
subscriber-owned reaction (§5, criteria 6 & 10). Its subscription is revocable
and re-established across `reopenClosed` recreation.

Capability set (target):

| Verb | Kind | Notes |
|---|---|---|
| `spawn` (router route) | command | creates + registers + subscribes; unchanged public shape |
| `send` / `close` (public `TeammateOps`) | command | forward to the resolved entity; **membership fence** (§6) rejects both while a Workflow membership is active; `close` no longer performs eviction — it awaits the entity command and lets the lifecycle event evict |
| `list` / `status` / `history` / `last` | query | unchanged |
| `createMember` (new internal capability) | command | the narrow creation capability Workflow borrows (§3) — returns a `TeammateHandle`, not bulk verbs |
| `liveRuntimes` / `recoverLiveRuntimesForOwnerClose` | query/command | unchanged (Team dissolve idle recovery) |
| `stopAll` | command | server-shutdown sweep; now `entity.stop()` only (runtime quiesce), close/eviction still event-driven where a full close is requested (§7) |
| *(deleted)* `spawnOwned` / `releaseAllOwned` / `exclusivelyOwned` map / `releaseExclusive` / `cleanupFailedOwnedSpawn` | — | replaced by `createMember` + membership lease + entity events (§3, §6, §10) |

The `exclusivelyOwned: Map<name, OwnedTeammateOwner>` and the
`assertPubliclyAddressable` fence it powers (`:600-605`) are **not deleted
outright** — their *purpose* (linearize creation, fence public mutation) is
real and required by the requirement's active-membership rules. They are
**relocated** to a membership lease that is *not* the close owner (§6).

### 2.3 `WorkflowService` / `WorkflowRun` — owns the business relationship + close timing

**Authoritative facts it owns:** Workflow membership (which concrete TeamMate is
which run agent, in the durable `WorkflowAgentRecord.name` + `turn_id`,
`workflow-service/types.ts:13-22`), orchestration state, and *the decision of
when* each borrowed TeamMate must close.

**What it loses:** the `OwnedTeammateOwner` symbol coupling
(`run.ts:69,329,581`) and the `releaseAllOwned(owner)` bulk verb. It stops
depending on a collection-owned bulk lifecycle verb.

**What it gains:** it holds a **`TeammateHandle`** per created agent (returned by
`createMember`, §3) and calls `handle.close({ reason })` per member as a
first-class command. It consumes the member's committed close outcome the same
way it already consumes settle completions (through the completion router
envelope it already registers, `run.ts:156-157`), so it never re-derives runtime
state.

Capability set (target): `run` / `status` / `stop` / `list` unchanged in shape.
The change is entirely *behind* `stop`: `stop` now (a) closes admission, (b)
closes each member handle via the entity-owned close, (c) awaits those closes,
then (d) commits terminal — so `stop` returning `stopped` proves no
Workflow-created runtime remains (criterion 16). The detached-`observe`
early-return (`run-terminal.ts:80`) is replaced by awaiting the member closes
before the terminal status is reported (§8).

**It must not** (requirement §WorkflowService, restated as design constraints):
construct a runtime; define wait/cancel/kill/persist/close mechanics; add a
natural-settle grace window; interpret provider process/turn behavior; or
recreate close single-flight/termination/settlement inside finalization. All of
those now live on `TeammateService` and its handle.

### 2.4 Composition root — `DispatcherWorkflows` / `DispatcherService` / `TeamService`

Constructs and wires `TeammateCollection`, `WorkflowService`, and the
subscription seam. `DispatcherWorkflows` (`dispatcher-workflows.ts`) stops
injecting `{ spawnOwned, releaseAllOwned }` and instead injects a narrow
`TeammateBorrowing` capability `{ createMember(request): Promise<TeammateHandle> }`
(§3), still wrapped in `admit()` for dispatcher admission. The
`completionInitiator` wiring is unchanged.

---

## 3. The borrow capability: `createMember` → `TeammateHandle`

This answers technical-design question 1 ("what exact narrow lifecycle handle
does the collection return to Workflow"). It also answers question 5 (MVP
create-and-attach vs future attach-existing) by making creation and handle
issuance separable.

The collection exposes **one internal creation capability** (not on the
admin-facing `TeammateOps` interface, mirroring how `OwnedTeammateOps` stays off
it today, `owned-teammates.ts:32-42`):

```ts
interface TeammateBorrowing {
  // MVP: create a fresh member and immediately take an exclusive membership
  // claim for the caller. Returns a per-entity handle, NOT bulk verbs.
  createMember(
    request: SpawnTeamMateRequest,
    membership: MembershipClaim,
  ): Promise<{ handle: TeammateHandle; turn: AgentRuntimeTurnResult }>;

  // Future extension point (NOT implemented this task, requirement §Non-goals):
  // attach an already-existing durable identity to a new membership.
  // attachMember(name: string, membership: MembershipClaim): Promise<TeammateHandle>;
}
```

`TeammateHandle` is an **entity-scoped command handle** — a thin, revocable view
onto one `TeammateService`, bound to one `MembershipClaim`:

```ts
interface TeammateHandle {
  readonly name: string;
  submit(prompt: string, opts: SubmitOpts): Promise<AgentRuntimeTurnResult>;
  // Entity-owned close. Runs TeammateService.transitionToClosed directly on the
  // resolved entity. The collection does NOT wrap this to do bookkeeping — it
  // learns of the close through the lifecycle event like any other subscriber.
  close(opts: { reason: string | null }): Promise<AgentEntityCloseResult>;
  // Released when membership ends; further calls throw. Does NOT close the entity.
  release(): void;
}
```

Key ownership properties:

- **The handle executes close on the entity, not through the collection.**
  `handle.close()` calls the resolved `TeammateService.close/release` directly.
  The collection is not on that call path (satisfies the red line + criterion 6).
- **The handle is a membership view, not the identity.** Releasing it (Workflow
  completes/leaves) does not close the entity or consume the identity; the
  durable TeamMate survives for later ordinary `send`/reopen (criteria 12, 15;
  requirement §Shared entity). This is what keeps "created by this Workflow"
  from becoming an irreversible entity kind (criterion 20).
- **`createMember` is the single linearization point** for create-vs-stop: it
  registers the identity, caches the entity, takes the membership claim, and
  subscribes the collection to the entity lifecycle *atomically under the
  membership lease* (§6, §Immediate cancellation). A close that races creation
  either sees a committed member (and closes it via its handle) or the creation
  is rejected and rolled back through the entity's own failure path — no leaked
  runtime or half-entity.

Why a handle and not "Workflow keeps the `TeammateService`": the requirement
forbids Workflow from owning entity mechanics. A raw `TeammateService` reference
would let Workflow call `stop()`, mutate state, etc. The handle exposes only the
two commands Workflow legitimately issues (submit the orchestrated turn; close
the membership) plus `release`, keeping Workflow off the entity's internals.

---

## 4. TeammateService close contract (the one close, §One TeamMate close contract)

`teammate_close`, `workflow_stop`, Team dissolve, and Server shutdown all rely on
**this** behavior. They differ in scope and initiation, not in what closing one
TeamMate means (criterion, requirement §One TeamMate close contract).

### 4.1 Admission fence + single-flight

`transitionToClosed` (`teammate-service/index.ts:260-289`) gains:

- an `admission` state (`open | closing | closed`) checked at the top of every
  start/reopen/submit path. `ensureStarted` (`:346`), `send` (`:175`),
  `channelInput` (`:218`), `completionInput` (`:141`), `scheduledInput` (`:227`)
  first assert admission is `open`; a close in flight flips it to `closing`
  *before* awaiting `stop()`, so a concurrent start/reopen/send cannot cross the
  close boundary (criterion 7; requirement §TeammateService bullet 1).
- a single-flight `closing: Promise<AgentEntityCloseResult> | null`. Concurrent
  `close`/`release` callers await the same promise and observe one idempotent
  `closed` result (criterion 7). This mirrors the existing `starting`
  single-flight guard (`:349-354`).

The existing `stop()` guard that awaits an in-flight `starting` before reading
`this.runtime` (`:328`) is preserved and is what makes close-vs-start safe: a
runtime about to be assigned is never missed.

### 4.2 Immediate cancellation + bounded runtime termination

`transitionToClosed` calls `stop()` → `runtime.stop()` (`:263,331`), which for
both built-in runtimes routes to `SupervisedChild.doStop()`
(`dreamux-utils/src/supervised-child.ts:114-131`): `SIGTERM` to the detached
process group, poll to a **1 s** default deadline, then **unconditional
`SIGKILL`** to the group. This is already immediate-cancel (no `waitIdle`, no
natural-completion wait) and bounded-then-force-kill — it satisfies criterion 8
as-is. Unfinished turns settle to `stopped` (the runtime emits stopped turn
results; `turnResultToCompletionDelivery` maps `stopped`, `:597-599`).

**One strengthening (from requirement §Assumptions to verify, question 3):**
`SupervisedChild.doStop` fires `SIGKILL` and returns without re-verifying the
group is gone (agent map §2). I propose adding a **bounded post-`SIGKILL`
liveness re-check** in `SupervisedChild` (one short poll for `!isProcessAlive`),
surfacing a distinct `RuntimeTerminationError` if the group is still alive after
force-kill. This keeps termination a *runtime-owned, provider-neutral fact*
(core never names signals) while making "runtime terminated" a proven fact
rather than a fire-and-forget assumption. This is the only lower-layer change
and it lives entirely in `dreamux-utils`, behind the neutral `AgentRuntime.stop`
seam.

### 4.3 Distinct facts, no collapsed "release failed"

The requirement (criterion 9, §One TeamMate close contract) demands four
distinct facts, not one ambiguous error:

1. **runtime terminated** — proven by `stop()` returning (post-kill re-check,
   §4.2);
2. **durable identity committed `closed`** — `identities.update(status:'closed')`
   (`:279-285`);
3. **turn settlement drained** — the `turnSubmissions.drain()` +
   `settleWrites` loop (`:264-267`);
4. **optional entity worktree cleanup** — the `shouldCleanup` gate (`:272-278`).

`AgentEntityCloseResult` (`agent-entity/types.ts:189-191`) is extended so a
successful close proves (1)+(2). A failure *after* runtime termination but
*before* durable closure returns an **operation error that carries
`runtimeTerminated: true`** — recovery preserves "no runtime remains" and never
reports the TeamMate as still executing (criterion 9; requirement
§One TeamMate close contract final bullet). Worktree-cleanup failure is recorded
in the existing `worktree.cleanup_state` / `cleanup_error` fields
(`agent-entity/types.ts:151-171`) and does not fake a live runtime.

---

## 5. Lifecycle event contract (answers question 2)

**Reuse the repository's existing pattern**, do not invent a new emitter shape.
The canonical shape is the scoped-source lease in
`dispatcher-core-events/scoped-source.ts:18-81` + the narrow publisher in
`dispatcher-core-events/index.ts:15-42` + the free-function publishers in
`binding-events.ts`. I mirror it exactly at entity scope.

### 5.1 Event

```ts
type AgentEntityLifecycleEvent = {
  schema_version: 1;
  kind: 'teammate.lifecycle';
  action: 'closed';
  dispatcher_id: string;
  team_id: string | null;
  name: string;
  // The committed durable fact, echoed for subscriber reconciliation:
  status: 'closed';
  closed_at: number;
  runtime_terminated: true;
};
```

Frozen at publish (like `binding-events.ts` `deepFreeze`), `schema_version` +
`kind`-tagged, and reporting an **already-committed** fact.

### 5.2 Publication point

Published by `TeammateService` **after** the durable `identities.update(status:
'closed')` returns inside `transitionToClosed` — i.e. after fact (2) of §4.3 is
committed. If the durable commit fails, no `closed` event is published (there is
no committed fact to report); the caller gets the §4.3 operation error instead.
This guarantees the event is never ahead of the authoritative state
(criterion 11; requirement §Constraints "events are post-transition facts").

### 5.3 Source + subscription seam

`TeammateService` exposes a narrow, revocable source built with the *same*
scoped-source helper family:

```ts
interface AgentEntityLifecycleSource {
  on(action: 'closed', listener: (e: AgentEntityLifecycleEvent) => void)
    : { unsubscribe(): void };
}
// TeammateService owns the emitter privately and exposes only `.lifecycle: Source`
// (frozen `{ on }`), never the raw emitter (mirrors DispatcherCoreEventBus.publisher).
```

The collection subscribes at the single composition boundary `entityFor`
(`teammate-collection/index.ts:532-579`) right after `entities.set`
(`:577`):

```ts
const sub = entity.lifecycle.on('closed', (e) => {
  // Subscriber-owned reaction: evict live reference + revoke this subscription.
  if (this.entities.get(e.name) === entity) this.entities.delete(e.name);
  sub.unsubscribe();
});
```

**Safe across recreation** (`reopenClosed`): because the subscription is created
per cached `TeammateService` instance in `entityFor`, and a reopened teammate is
the *same* cached instance (reopen mutates identity in place, `:369-376`; it does
not build a new `TeammateService`), the subscription survives reopen. If an
entity is evicted and later rebuilt (a fresh `entityFor`), a fresh subscription
is created — there is no stale cross-instance listener. Listener failures are
isolated by the scoped-source `dispatch` try/catch
(`scoped-source.ts:35-42`); a listener throw cannot roll back the committed
close (criterion 11; requirement §Constraints "listener failure must not roll
back").

### 5.4 Reconciliation, not event-as-truth

On process restart there is no event stream to replay. Each subscriber restores
its derived state from authoritative state, not from events (criterion 11):

- the collection's live cache is empty on restart and rebuilt lazily via
  `entityFor` from the durable roster — a `closed` identity is simply never
  cached as live;
- `recoverLiveRuntimesForOwnerClose` (`:184-189`) still reattaches non-closed
  members for the dissolve idle barrier;
- Workflow's terminal reconciliation (`recoverRunningRecords`,
  `workflow-service/index.ts:250-272`) rewrites orphaned `running` runs/agents to
  `stopped` from the durable record, never from a missed event.

---

## 6. Membership lease (answers question 4) — the fence, not the close owner

The requirement permits a process-local claim "if architecture review proves it
necessary to linearize creation, prevent cross-Workflow misuse, or protect an
in-flight operation" but forbids it from being business ownership or the close
owner. Review conclusion: **it is necessary** for the active-send/active-close
fence (requirement §Visibility, criteria 13, 14) and for create-vs-stop
linearization (§Immediate cancellation). It is **not** the durable membership
truth (that stays in `WorkflowAgentRecord`, criterion 4) and it is **not** the
close state machine.

Design:

```ts
type MembershipClaim = symbol & { readonly brand: unique symbol }; // process-local
// Collection holds: activeMembership: Map<TeamMateName, MembershipClaim>
```

This is the relocated, renamed successor of today's
`exclusivelyOwned: Map<name, OwnedTeammateOwner>` (`:152`). Differences that
make it honor the red line:

| Today (`exclusivelyOwned`) | Target (`activeMembership`) |
|---|---|
| Powers `releaseExclusive` which **calls `entity.release()`** then evicts (`:607-611`) — collection owns close | Powers **only** the mutation fence; close is issued by the `TeammateHandle` on the entity, eviction is event-driven |
| Cleared by the collection as a close step | Cleared when the entity publishes `closed` **or** when Workflow explicitly `handle.release()`s the membership (completion without close) |
| Conflates "who may mutate" with "who tears down" | `activeMembership` = write fence only; teardown = entity + event |

Fence behavior (criteria 13, 14; requirement §Visibility):

- while `activeMembership.has(name)`, the public `TeammateOps.send` and
  `TeammateOps.close` (`teammate-collection/index.ts:311-332`) reject **before
  runtime submission / before any entity or runtime side effect** — this is the
  relocated `assertPubliclyAddressable` (`:600-605`), now named
  `assertNoActiveMembership`;
- `list` / `status` / `history` / `last` remain available (read-only surface);
- `workflow_stop` is the only public cancellation for active members — it goes
  through the handle, not the public `close`;
- membership ends → fence lifts → ordinary `send`/`close` act on the retained
  identity again (criteria 13-15, requirement final §Visibility bullets).

Create-vs-close linearization: `createMember` takes `activeMembership[name]`
under the collection's existing single-threaded async construction path
(name allocation → identity create → entity cache → claim → subscribe) so a
`handle.close()` racing a not-yet-created sibling cannot observe a half-entity;
it either sees the claim+entity (closes it) or the creation throws and rolls
back via the entity's own failed-spawn path (the successor of
`cleanupFailedOwnedSpawn`, `:581-598`, which itself becomes "release membership +
let the entity close+publish").

---

## 7. Server shutdown & Team dissolve reuse the one contract

**Server shutdown** (criterion 18; requirement §Workflow terminal consistency):
`DispatcherService.doStop` already sweeps `_teammates.releaseAllOwned()`
(`dispatcher-service/index.ts:279`) then `_teammates.stopAll()` (`:332`). Under
this design:

- `releaseAllOwned` is deleted. Shutdown of Workflow-owned members happens via
  `WorkflowService.stopAllForShutdown()` (`:271,331`), which now closes each
  member **handle** (entity-owned close) rather than a bulk collection verb;
- `stopAll` (`teammate-collection/index.ts:450-464`) is simplified to a runtime
  quiesce sweep (`entity.stop()` for each cached entity) — it stops runtimes; it
  does not need the exclusive branch anymore because Workflow members are closed
  through their handles first. Any entity that fully closes during shutdown
  publishes `closed` and self-evicts through the same subscriber path.

No separate Workflow-Agent resource lifecycle is introduced (criterion 18): the
process-wide caller uses the same `TeammateService` close.

**Team dissolve** (criterion 17; requirement §Workflow terminal consistency):
the `waitIdle` barrier (`dissolve-runner.ts:274-288`) hangs today only when a
Workflow-owned member's runtime was never asked to stop (because
`releaseAllOwned` was skipped on the shutdown/never-drained branch, §1). Once
`workflow_stop` and shutdown both **await** entity-owned close of every member
(§4, §8), a Workflow-owned member cannot sit forever un-asked-to-close, so
`waiting_for_team_idle` cannot be held indefinitely by an un-closed Workflow
member. The dissolve barrier itself is unchanged and not weakened — this is a
load-bearing test surface (requirement §Constraints, final bullet).

---

## 8. Flows

### 8.1 Create (MVP create-and-attach)

```
Workflow agent()  ─▶ WorkflowRun.executeAgent
  ─▶ borrowing.createMember(spawnRequest, claim)          [admitted by dispatcher gate]
      collection: allocateName → identities.create(starting)
                → entityFor(identity)  → entities.set
                → activeMembership.set(name, claim)        ← write fence on
                → entity.lifecycle.on('closed', evict)     ← subscribe
                → entity.ensureStarted() → submitInitialPromptRuntime
      returns { handle, turn }
  ─▶ WorkflowRun records agent.name + agent.turn_id (durable truth)   [run.ts:345-346]
  ─▶ router.register(completionKey(name, turnId), workflowInitiator)   [existing path]
```

### 8.2 Attach (future — design-only, criterion 20)

`borrowing.attachMember(existingName, claim)` resolves the durable identity via
the collection, caches the entity if needed, takes `activeMembership`,
subscribes, and returns a handle — **no new identity, no second entity**. Because
membership is a claim + a handle (not an entity kind, not a durable field on the
identity), an ordinary or historical-Workflow TeamMate can attach without
creating a second entity. Nothing in the ownership/lease/event/routing/close
contracts encodes "created by this Workflow" as irreversible. This is the review
demonstration for criterion 20.

### 8.3 Close (workflow_stop path)

```
workflow_stop ─▶ WorkflowService.stop ─▶ WorkflowRun.stop
  1. terminal: close admission (reserveStop)               [existing]
  2. abort runner IPC (signalStop) → runner rejects pending agents [existing]
  3. FOR EACH live member handle: await handle.close({reason})     ← NEW: entity-owned
        TeammateService.transitionToClosed:
          admission=closing → stop() [SIGTERM→1s→SIGKILL(+recheck)]
          → drain submissions+settles → entity worktree cleanup
          → commit identity=closed → publish lifecycle:closed
              → collection evicts live ref (subscriber reaction)
              → activeMembership cleared on 'closed'
  4. persist terminal run record + end journal event       [existing]
  5. RETURN status='stopped'  ← only after step 3 completes ⇒ no live runtime remains
```

The change vs today: step 3 is awaited before step 5 returns. The detached
`void this.request(...)` early return (`run-terminal.ts:80`) is replaced by
`stop` awaiting member closes. Queued agents that never created a TeamMate are
handled as today (`executeAgent` marks `stopped` when `terminal.requested`,
`run.ts:300-311`; `freezeAgentCalls`, `:672-681`) — no TeamMate is created after
stop (§Immediate cancellation).

### 8.4 Settle (unchanged direction, audited)

Member turn settles → `TeammateService.deliverSettledTurn` records the settled
row then routes the completion envelope (`:464-507`) → `routeSettledCompletion`
→ `CompletionRouter.settle` (at-most-once, `completion-router/index.ts:97-118`).
Workflow's `handleAgentCompletion` matches on `record.name` + `record.turn_id`
(`run.ts:438-441`). This is already a fact-event flow (producer settles →
router delivers); no reversal needed. Late callbacks cannot resurrect a closed
TeamMate because admission is `closing/closed` and the router terminal-cache
drops duplicate settles (criterion; requirement §Workflow terminal consistency
"late callbacks must not resurrect").

---

## 9. Owner / command / query / event matrix (full audited surface)

Every direct three-module interaction the requirement enumerates
(§Dependency direction, "audit the full direct dependency surface"), classified.
"Reversed?" = did this change from a forward container→entity command into an
entity-owned fact + subscription.

| # | Interaction | Authoritative owner | Kind | Direction (target) | Reversed? / rationale |
|---|---|---|---|---|---|
| 1 | Public `send` forwarding | TeammateService (turn) | command | Collection→Entity | No. Command legitimately targets owner; fenced by membership (§6). |
| 2 | Public `close` forwarding | TeammateService (lifecycle) | command + event | Collection→Entity (cmd); Entity→Collection (event) | **Yes.** Collection no longer evicts as a close step; it evicts on the `closed` event (§5). |
| 3 | Workflow `spawnOwned` | TeammateCollection (creation) | command | Workflow→Collection (`createMember`) | Reshaped. Returns a handle, not an owner-keyed bulk contract. |
| 4 | Workflow `releaseAllOwned` | TeammateService (close) | command | Workflow→Entity (via handle) | **Yes.** Deleted bulk collection verb; close issued per-member on the entity; collection observes via event. |
| 5 | Live runtime enumeration (`liveRuntimes`) | TeammateService (runtime handle) | query | Collection reads entities | No. Pure read for the dissolve idle barrier; no lifecycle ownership. |
| 6 | Shutdown sweep (`stopAll`) | TeammateService (`stop`) | command | Collection→Entity | No, but simplified: runtime quiesce only; full closes go through handles+events (§7). |
| 7 | Spawn-failure rollback (`cleanupFailedOwnedSpawn`) | TeammateService (close) | command + event | Collection→Entity (cmd); Entity→Collection (event) | **Yes.** Rollback releases membership + triggers entity close; eviction via event, not a manual second step. |
| 8 | Settle capture/drain callbacks (`trackSettleCapture`) | TeammateService (settlement) | command (dep callback) | Entity→Collection tracker | No. Collection only tracks in-flight captures to drain on shutdown; not lifecycle ownership. Retained. |
| 9 | Completion routing callback (`routeSettledCompletion`) | TeammateService (produces) → CompletionRouter (delivers) | event (fact) | Entity→Router→Initiator | No. Already a post-settle fact flow; audited, unchanged. |
| 10 | Worktree-state sync (`applyWorktreeCleanup`) | TeamService/TeamCollection (shared worktree) owner | command | Owner→Entity | No. Owner-performed cleanup pushed to borrower's display; entity owns *its own* worktree only. |
| 11 | Runtime/config resolution imports (`resolveAgent`, `read-helpers`) | agent-config / read-helpers | import | Entity imports from `teammate-collection/*` | **Cleanup flagged (§11).** `teammate-service` importing `../teammate-collection/agent-config.js` + `read-helpers.js` (`teammate-service/index.ts:18,23`) violates "no `TeammateService` imports a capability from `teammate-collection`" (requirement §Dependency direction final bullet). Move to a neutral lower module. |
| 12 | Cache eviction | TeammateCollection (cache) | event reaction | Entity→Collection | **Yes.** The core reversal: eviction is a subscriber reaction to `closed`, not a collection-driven step (§5, criterion 6/10). |
| 13 | Restart/reopen materialization (`ensureStarted({reopenClosed})`) | TeammateService | command | Collection/entity self | No. Entity owns reopen of its own identity; membership fence gates who may trigger it. |

**Invariant satisfied for every row:** no event subscriber is called
synchronously as a required step for the publisher to complete its own
transition (requirement §Dependency direction; criterion 11). The collection's
`closed` handler runs *after* the entity has already committed and published;
the entity does not await it.

---

## 10. Dependency graphs

### 10.1 Current (forward container→entity teardown — the defect)

```
        composition root (DispatcherService / DispatcherWorkflows)
            │ constructs + injects { spawnOwned, releaseAllOwned }
            ▼
     WorkflowService/Run ──spawnOwned(owner)──▶ TeammateCollection
            │                                        │  owns exclusivelyOwned map
            └──releaseAllOwned(owner)───────────────▶│  releaseExclusive:
                                                      │    entity.release()  ──▶ TeammateService
                                                      │    exclusivelyOwned.delete
                                                      │    evictEntity           ◀── collection is 2nd
                                                      ▼                              lifecycle owner
     public close(): entity.close() ──▶ TeammateService ; then evictEntity  ◀── FORBIDDEN forward dep
```

Collection learns of close only by *being the closer*. Workflow stop returns
before `releaseAllOwned` runs, and skips it on shutdown/never-drained branches.

### 10.2 Target (entity owns close; collection & Workflow subscribe)

```
        composition root
            │ constructs; wires collection⇄entity lifecycle subscription
            ├────────────────────────────┬─────────────────────────────┐
            ▼                             ▼                             ▼
     WorkflowService/Run          TeammateCollection            TeammateService (entity)
        holds TeammateHandle         owns creation+cache            owns close state machine
            │ createMember ─────────────▶│ createMember:                │
            │                            │   identities.create          │
            │                            │   entityFor+cache ───────────▶ (construct)
            │                            │   activeMembership (fence)    │
            │                            │   lifecycle.on('closed') ◀────┤ (subscribe)
            │ handle.close() ───────────────────────────────────────────▶ transitionToClosed
            │                            │                               │   stop runtime (bounded+recheck)
            │                            │                               │   drain settles
            │                            │                               │   commit identity=closed  ← FACT
            │        evict live ref  ◀───┤◀────────── lifecycle:closed ──┤   publish (post-commit)
            │        (subscriber)        │                               │
            │ consume completion ◀───────── CompletionRouter ◀───────────┤ routeSettledCompletion (settle fact)
            ▼
     durable WorkflowAgentRecord = source of truth for Workflow↔TeamMate (criterion 4)
```

All lifecycle arrows into the collection and into Workflow are **events (facts)**
emitted after the entity commits. All command arrows point *at* the owner
(entity). No observer sits on the owner's transition path.

---

## 11. Concrete code touchpoints

| File | Change |
|---|---|
| `teammate-service/index.ts` | Add admission fence (`open/closing/closed`) checked in `ensureStarted`/`send`/`channelInput`/`completionInput`/`scheduledInput`; single-flight `closing` promise in `transitionToClosed`; private lifecycle emitter + `get lifecycle()` frozen source; publish `closed` after `identities.update(status:'closed')` commit; extend `AgentEntityCloseResult` with `runtime_terminated` and the post-termination-failure error shape. |
| `teammate-service/types.ts` | Add `AgentEntityLifecycleEvent` / `AgentEntityLifecycleSource` types (or a new `agent-entity/lifecycle.ts`, mirroring `dispatcher-core-events/scoped-source.ts`). |
| `agent-entity/` (new `lifecycle.ts`) | The neutral scoped lifecycle source helper (copy the `scoped-source.ts` lease shape at entity scope). Also the **new home** for `resolveAgent`/`read-helpers` pieces `TeammateService` needs, so the entity stops importing from `teammate-collection/*` (row 11). |
| `teammate-collection/index.ts` | Delete `spawnOwned`/`releaseAllOwned`/`exclusivelyOwned`/`releaseExclusive`/`cleanupFailedOwnedSpawn`/`spawnWithRoute` owned branch. Add `createMember` → `TeammateHandle`, `activeMembership: Map`, `assertNoActiveMembership` (relocated `assertPubliclyAddressable`), and the `entity.lifecycle.on('closed', evict)` subscription in `entityFor`. `close()` awaits the entity command and lets the event evict (no direct `evictEntity`). |
| `teammate-collection/owned-teammates.ts` | **Delete** (`OwnedTeammateOps`/`OwnedTeammateOwner`/`spawnOwned` options) and replace with `borrowing.ts` (`TeammateBorrowing`, `TeammateHandle`, `MembershipClaim`). |
| `teammate-collection/types.ts` | `TeammateOps` unchanged (still public admin surface); membership fence applied inside `send`/`close`. |
| `workflow-service/run.ts` | Delete `teammateOwner` symbol + `spawnOwned(owner)`/`releaseAllOwned(owner)`; hold `TeammateHandle` per `AgentCall`; `finalize`/stop awaits `handle.close()` per live member before terminal status; keep durable `record.name`/`turn_id` writes. |
| `workflow-service/index.ts` | `WorkflowServiceOptions.ownedTeammates` → `borrowing: TeammateBorrowing`; forward to runs. |
| `workflow-service/run-terminal.ts` | Replace detached `observe`→sync-return with awaiting the finalize path so `stop` reports terminal only after member closes complete. |
| `dispatcher-service/dispatcher-workflows.ts` | Inject `borrowing: { createMember: (r) => admit(() => teammates.createMember(r, claim)) }` instead of `{ spawnOwned, releaseAllOwned }`; drop `releaseAllOwned` from `rollbackStart` (rollback now closes member handles / relies on entity close+event). |
| `dispatcher-service/index.ts` | `doStop`: drop `_teammates.releaseAllOwned()` (`:279`); shutdown of Workflow members flows through `WorkflowService.stopAllForShutdown` closing handles; `stopAll` sweep unchanged in call site. |
| `dreamux-utils/src/supervised-child.ts` | Add bounded post-`SIGKILL` liveness re-check + distinct termination error (§4.2). Provider-neutral; the only lower-layer change. |
| `.agents/reference/service-topology.md`, `current-architecture.md`, `dynamic-workflow-usage.md`; `skills/dispatcher/dreamux-maintenance/` if any close/state semantics description changes | Knowledge-delta updates (requirement §Scope docs). Run `.agents/scripts/check.sh`. |

---

## 12. Deletion list

- `teammate-collection/owned-teammates.ts` — `OwnedTeammateOps`,
  `OwnedTeammateOwner`, `createOwnedTeammateOwner`, `SpawnOwnedTeamMateOptions`,
  `OwnedTeamMateSpawnResult`.
- `TeammateCollection.spawnOwned`, `.releaseAllOwned`, `.releaseExclusive`,
  `.cleanupFailedOwnedSpawn`, the `exclusivelyOwned` map, and the `owned` branch
  of `spawnWithRoute` (`teammate-collection/index.ts:152,208-213,306,450-481,
  581-611`).
- `WorkflowRun.teammateOwner` symbol and both its uses
  (`run.ts:69,329,581`); the `agentTasksDrained && !shutdownRequested` gate that
  skipped release (`run.ts:580`) — replaced by unconditional per-member handle
  close.
- The detached `observe`/sync `initiateStop` return contract that reports
  `stopped` before teardown (`run-terminal.ts:76-82`).
- `teammate-service` imports of `../teammate-collection/agent-config.js` and
  `../teammate-collection/read-helpers.js` (`index.ts:18,23`) — moved to a
  neutral module (row 11 / §11).

No durable state format is deleted: `WorkflowAgentRecord` (name/turn_id) and
identity `status` are preserved — they are the authoritative facts (criterion 4).

---

## 13. Verification plan (deterministic; criterion 19)

Focused tests, none weakening load-bearing gates (Team dissolve, non-blocking
inbound, worktree safety, shutdown, persistence — requirement §Constraints):

1. **create-vs-stop:** `workflow_stop` fired while an `agent()` is mid-
   `createMember` → either the member is created-then-closed (identity `closed`,
   no live runtime) or creation is rejected and rolled back; assert no leaked
   entity in the cache and no orphan runtime.
2. **close-vs-start:** `handle.close()` racing `ensureStarted({reopenClosed})` →
   admission fence rejects the reopen; identity ends `closed`; single runtime
   created at most once.
3. **close-vs-send:** ordinary `send` during active membership rejected before
   runtime submission (criterion 13); after membership ends, `send` reopens
   (criterion 15) without touching the terminal Workflow.
4. **concurrent close:** two `handle.close()` + a public `close` interleave →
   one idempotent `closed` result, one durable transition, one `closed` event,
   one eviction (criterion 7).
5. **close-vs-settle:** a settle landing during/after close → recorded row does
   not overwrite `closed` identity with running state; router terminal-cache
   drops the duplicate; no resurrection (criteria 11, §terminal consistency).
6. **event → eviction:** publish `closed` → collection evicts live ref and
   revokes subscription; a listener that throws does not roll back the durable
   close (criterion 11).
7. **post-termination persistence failure:** stub `identities.update` to fail
   after `stop()` → close returns an operation error carrying
   `runtime_terminated: true`; status never reports live runtime (criterion 9).
8. **bounded force-kill:** a runtime that ignores SIGTERM → close completes
   within the bound via SIGKILL + re-check; unfinished turn observed `stopped`
   (criterion 8).
9. **workflow terminal consistency:** after `workflow_stop`, assert no
   Workflow-created runtime live AND run status/list/journal/agent records all
   terminal-consistent (criterion 16).
10. **Team dissolve:** a never-settling Workflow member turn + Team dissolve →
    `workflow_stop` (or dissolve-driven member close) asks the member to close;
    dissolve `waitIdle` is not held indefinitely (criterion 17). Reuse the
    existing dissolve idle test harness; do not modify its assertions.
11. **Server shutdown:** shutdown closes Workflow member handles through the same
    entity close; no separate Workflow-Agent lifecycle path (criterion 18).
12. **visibility/reopen:** Workflow-created TeamMate visible via
    `list`/`status`/`history`/`last` during and after close; durable
    identity/history retained after eviction; post-completion `send` reopens as
    ordinary TeamMate (criteria 12, 15).
13. **future-attach guard (architecture test):** a unit assertion that no
    persisted identity field, `activeMembership` entry, `createMember` return, or
    close rule encodes "created by this Workflow" — i.e. attach-existing remains
    expressible (criterion 20). Extend
    `tests/architecture-ownership-gate.test.ts` with a "no collection-owned close
    forwarding" check (grep-style gate: `TeammateCollection` must not call
    `entity.close`/`entity.release` then mutate `entities`).

Plus the standing gate: `node common/scripts/install-run-rush.js build && test`
and `.agents/scripts/check.sh` for KB anchors.

---

## 14. Risks

1. **Event-vs-eviction timing under recreation.** If an entity is evicted then
   rebuilt (`entityFor`) while a stale `closed` event is in flight, a naive
   handler could delete the *new* instance. Mitigation: the handler guards
   `if (this.entities.get(e.name) === entity)` (identity check by instance,
   §5.3) before deleting — already in the design.
2. **Post-SIGKILL re-check latency.** Adding a liveness re-check to
   `SupervisedChild` extends worst-case close by the poll window. Mitigation:
   bound it small (reuse the existing 25 ms poll interval, cap at a few
   hundred ms); it is still far inside the "bounded then force" contract and
   only fires on a runtime that ignored SIGKILL (rare).
3. **Membership fence vs handle-close ordering.** `workflow_stop` closes via the
   handle while the fence rejects public `send`/`close`. If membership were
   cleared *before* the entity close committed, a public `send` could race in and
   reopen. Mitigation: clear `activeMembership` only on the `closed` event (or
   explicit `handle.release()` for completion-without-close), never before the
   commit (§6).
4. **Cross-scope reuse.** Team-scope and dispatcher-scope collections both host
   Workflow members. The lifecycle source/subscription must be per-collection-
   instance. Mitigation: subscription created in `entityFor`, which is per
   collection; no shared global emitter (unlike the dispatcher core-event bus,
   which is dispatcher-global by design).
5. **Doc/maintenance drift.** Close-semantics wording lives in several `.agents/`
   references and the maintenance skill. Mitigation: §11 lists them; run
   `.agents/scripts/check.sh` in the same PR (requirement §Knowledge Delta).

---

## 15. Rejected alternatives

1. **Rename `releaseAllOwned` → `closeMembers` but keep the collection driving
   `entity.close()` + evict.** Rejected: this is precisely the red-line
   violation (operator quote 3) — the collection remains the second lifecycle
   owner and learns of close only by being the closer. Renaming does not reverse
   the dependency.
2. **A Workflow-specific Agent close state machine / grace window inside
   finalization.** Rejected by requirement §Non-goals and §WorkflowService
   ("must not recreate TeamMate close single-flight, runtime termination, or
   settlement logic"). It also duplicates the entity's contract and reintroduces
   the "second close model" the task forbids.
3. **A dispatcher-global lifecycle bus (reuse `DispatcherCoreEventBus`
   directly) for teammate close.** Rejected: teammate lifecycle is an
   *entity* fact consumed by the *containing collection*; routing it through a
   dispatcher-global bus would make the collection subscribe by name-matching on
   a shared channel and blur which collection owns which entity across
   dispatcher/team scopes. A per-entity source subscribed at `entityFor` keeps
   ownership crisp. (The core-event bus pattern is still the *shape* I reuse.)
4. **Make the durable identity `status` change the event, and have the
   collection poll identity for `closed`.** Rejected: polling is not a fact
   event; it either races the commit or adds latency, and it makes the identity
   store a pub/sub bus. The requirement wants an explicit post-commit publish
   with a narrow revocable source.
5. **Workflow keeps a raw `TeammateService` reference instead of a handle.**
   Rejected: it would let Workflow call `stop`/mutate entity internals,
   violating §WorkflowService ("must not define how a TeamMate waits, cancels,
   kills, persists, or closes"). The handle exposes only the two legitimate
   commands.
6. **Keep `exclusivelyOwned` as-is and only fix the stop-ordering bug.**
   Rejected: it fixes the symptom (early `stopped` return) but leaves the
   forbidden forward dependency and the collection-as-close-owner shape intact,
   failing criterion 6 and the operator red line, and leaves the shutdown/
   never-drained branches that skip teardown (§1) unaddressed.

---

# Cross-review and revised position

Reviewer seat: `arch-entity`. I read `arch-membership.md`
(SHA-256 `751bec09…564c39`) and `arch-events.md`
(SHA-256 `791a0e90…f191d4c`) in full against the frozen `requirement.md`
(SHA-256 `863d7c8f…5ee9e08`) and re-verified every source anchor below against
baseline `6b8ec14`. This section is appended; nothing above is rewritten.

## A. Points of agreement across all three proposals

All three converge on the same load-bearing spine, which I now treat as settled
and not worth re-litigating in implementation:

1. `TeammateService` owns an admission-fenced, single-flight, immediately-
   cancelling `close()` that ends by publishing a committed `closed` fact;
   `TeammateCollection` evicts its live reference **only** as a subscriber
   reaction. This is the direct answer to the operator red line.
2. `spawnOwned` returns a per-entity **handle**; `releaseAllOwned` /
   `releaseExclusive` / `OwnedTeammateOwner` / `exclusivelyOwned` are deleted.
   Workflow closes each borrowed TeamMate through its handle, and the durable
   `WorkflowAgentRecord.name` remains the source of truth for membership.
3. The reverse imports `teammate-service/index.ts:18,23` →
   `teammate-collection/{agent-config,read-helpers}` are a real layering
   violation and move to a neutral lower module. (All three flag this; I
   under-weighted it in my body as a single matrix row — I accept it is
   mandatory, not cleanup.)
4. `SupervisedChild` needs a bounded post-`SIGKILL` liveness re-check; close
   success must prove runtime termination as a distinct fact from durable
   closure.
5. The event source reuses the repo's narrow-publisher / revocable
   scoped-source shape (`dispatcher-core-events/scoped-source.ts`), not a raw
   cross-module `EventEmitter`; listener failure cannot roll back the commit.
6. A process-local exclusive claim is the write fence (not durable membership,
   not the close owner), and it must **not** be released on `teammate.closed` —
   it releases only after the Workflow terminal record commits, or public `send`
   could reopen the entity mid-terminalization.

Point 6 is a correction to my own body. My §6 said `activeMembership` is cleared
"on the `closed` event **or** explicit `handle.release()`". Both siblings
correctly separate these: the closed event evicts the *cache*; the *claim* is a
distinct lifetime released at Workflow terminal commit. I **accept** their
version and revise mine accordingly (§D.1 below).

## B. Challenge — arch-membership.md

Source-grounded findings:

1. **Self-contradiction left unresolved in the design text (ownership clarity
   defect).** §5.3 contains a literal mid-paragraph reversal: *"When close
   completes, the entity releases the claim … Wait — actually, if close persists
   the entity as closed, the claim is irrelevant … So `release` happens naturally
   when close commits; we don't need a separate release step."* This lands on the
   wrong answer. Per requirement §Visibility ("only `workflow_stop` … as one
   coordinated Workflow transition") and criterion 15, the claim must outlive the
   entity close until the Workflow run record is terminal — otherwise a public
   `send` racing finalize can reopen the just-closed entity before the run
   commits. arch-events §"Collection subscription and eviction" and its rejected
   alternative "Release the Workflow claim on `teammate.closed`" get this right.
   **This is a material ownership error in arch-membership, not a wording nit.**

2. **`stopAll` renamed to a runtime-only sweep re-introduces a second teardown
   model.** §6.8 keeps `forceStopAllForShutdown()` / `entity.stop()` (runtime
   only, no durable close) plus a "defensive `liveRuntimes()` sweep" that calls
   `runtime.stop()` directly at the composition root. That is a collection/root
   path that terminates a runtime **without** driving the entity's durable close
   — i.e. a second lifecycle path that can leave a durable identity non-`closed`,
   which is exactly what requirement §"One TeamMate close contract" and criterion
   18 ("Server shutdown reuses the same … close capability … does not need a
   separate … lifecycle model") forbid. My own body has the identical smell (§7:
   "`stopAll` … simplified to a runtime quiesce sweep"). arch-events is stricter
   and correct: shutdown closes **every** handle through the one entity `close()`
   and the root "snapshot" is side-effect-free, never a `runtime.stop()` shortcut.
   I **accept** arch-events here and revise my §7 (§D.2).

3. **`waitIdle` still runs against a raw `AgentRuntime` projection.** §6.5 keeps
   `liveRuntimes()` returning `{name, runtime: AgentRuntime}` for the dissolve
   idle barrier. That preserves the current raw-runtime exposure
   (`teammate-collection/index.ts:170-177`) the requirement wants audited
   (§Dependency direction: "live runtime enumeration"). It works, but it is a
   missed reversal. arch-events replaces this with a neutral `writerActivity()`
   handle that exposes no raw runtime — cleaner against the "no runtime specifics
   leak" rule. Not a red-line violation; a completeness gap.

4. **Scope is proportionate; correctly rejects over-reach.** arch-membership's
   rejected-alternative 10 (leave worktree ownership alone) and its refusal to
   persist the claim (rejected alt 5) are well-judged. Its shutdown persistence
   **budget** (`SHUTDOWN_CLOSE_BUDGET_MS`, §6.8 + risk 3) is a pragmatic knob but
   is under-specified against criterion 9: abandoning persistence on a timer and
   emitting `closed` with `durableClosed:false` risks reporting a TeamMate whose
   durable identity is **not** `closed` while the process exits — recovery must
   then reconcile, but arch-membership has no runtime-resource lease to prove the
   child is actually gone on the next boot. This is where arch-events' lease is
   materially stronger (see C).

Net: arch-membership is the closest to my own altitude and the most implementable
as-is, but it has one real ownership bug (claim-release timing, B1) and one
red-line-adjacent regression (runtime-only shutdown sweep, B2).

## C. Challenge — arch-events.md

arch-events is far larger in scope. I separate its **mandatory root-cause** core
from its **optional/expansion** superstructure, because conflating them would
balloon the implementation boundary well past the requirement.

Mandatory and correct (I accept these over my own where they differ):

1. **Shutdown/dissolve close every handle through the one entity `close()`; no
   runtime-only sweep, no owned/unowned branch** (§"Server shutdown",
   §"Team dissolve"). This is the strict reading of criteria 17/18 and beats both
   my §7 and arch-membership's §6.8 defensive sweep.
2. **Team dissolve stops Workflows *before* the writer-idle wait** (§"Team
   dissolve" step 2 before step 3). This is the precise fix for criterion 17 —
   the never-settling turn is closed before `waitIdle` is even captured. My body
   asserted the outcome ("cannot be held indefinitely") without ordering the
   steps; arch-events makes the ordering explicit and irreversible, and correctly
   flags that irreversibility as a trade-off. Accept.
3. **Late-settle / reopen races need a generation/epoch check**, not just an
   instance-identity check. My §5.3 guarded eviction only with
   `entities.get(name) === entity`. arch-events adds instance-id + lifecycle
   generation + `closed_at` equality (§"Collection subscription and eviction").
   arch-membership independently adds a `generation` field to its closed event.
   Both are right; my instance-only guard is insufficient across a reopen that
   reuses the same cached instance. Accept the generation guard (§D.3).

Challenges — scope and owner-correctness:

4. **The runtime-resource lease + guarded-launch handshake is genuinely
   motivated but is the single largest scope expansion, and part of it is
   optional.** The motivating fact is real and I verified the shape:
   `SupervisedChild` spawns `detached:true` and holds the pid only in memory
   (`dreamux-utils/src/supervised-child.ts`), so after a daemon crash a
   replacement cannot prove a detached group is gone — writing durable `stopped`
   would then be a lie (criterion 9). That justifies **some** crash-reaping
   evidence. But arch-events layers *four* new durable artifacts on top:
   (a) `AgentRuntimeResourceLease` sidecars, (b) a `WorkflowRunnerResourceLease`,
   (c) guarded `prepareGuardedLaunch/armAndWaitReady/abortAndProveTerminated`
   provider seam, and (d) PID-reuse-resistant opaque locators. This is a new
   provider contract (`packages/dreamux-types/src/agent-runtime.ts`) plus new
   host-owned state files. **Assessment:** the daemon-crash-recovery leak is a
   *pre-existing* latent bug, not one this task introduces; the requirement's
   root cause is the Workflow-stop dependency reversal, not detached-child
   reaping. Per requirement §"smallest coherent end-to-end change" and the
   Non-goal against "picking an arbitrary MCP timeout before the bounded service
   lifecycle is designed", the *in-process* bounded-termination proof (post-KILL
   re-check) is **mandatory**; the full durable-lease/guarded-launch provider
   contract is a **legitimate but separable follow-up** that should be escalated,
   not silently bundled. Bundling it would also force a `dreamux-types` provider
   protocol bump (root `CLAUDE.md`: "Codex protocol bumps update the runtime
   package first") and a `BREAKING:` state change — heavy for this task.

5. **`submission_id` + `request_fingerprint` durable turn-ledger rewrite: partly
   mandatory, partly gold-plating.** The *host-minted `submission_id`* solves two
   real, source-grounded problems: (i) provider `turn_id` is not a reliable
   idempotency key, and (ii) the entity-submit → Workflow-record crash gap
   (`run.ts:345-346` records name/turn_id *after* spawn). I verified
   `AgentTurnsStore.append` **swallows write failures**
   (`agent-entity/turns-store.ts:200-217` — `catch` → `log.warn`, no rethrow), so
   arch-events' claim that today's settle notification "does not prove a committed
   settlement" is correct. So: a **strict (non-swallowing) settle path** and a
   **host submission id** are well-justified for truthful close/terminal
   consistency. However, the **versioned canonical `request_fingerprint`**
   (SHA-256 over canonicalized envelope, canonicalization-version negotiation,
   corruption-on-mismatch) is a large new durable-equality contract whose only
   cited driver is provider-turn-id reuse — which the `submission_id` alone
   already fixes. The fingerprint defends a *retry-with-same-id* idempotency
   property that the MVP create-once flow does not exercise. **Assessment:**
   `submission_id` + strict settle = mandatory; `request_fingerprint` +
   canonicalization-version machinery = optional hardening, escalate separately.

6. **JSONL torn-tail repair / `fsync` / per-file lock (`platform/jsonl.ts`
   rewrite).** Motivated only once you make the turn ledger the crash-truth for
   close convergence. If the strict settle path is adopted (5), some tail-repair
   is entailed; but the full "truncate torn tail, dedupe by submission_id, fsync
   parent on first create, corruption errors" is a storage-durability project of
   its own. **Optional/follow-up**, coupled to whether 5's strict ledger is taken
   now or staged.

7. **Generation-scoped launch profile + structured-output scope
   (per-turn vs create-context) is a genuine correctness find I under-weighted.**
   arch-events §"Narrow capability contracts" notes the current cache-hit in
   `entityFor` (`teammate-collection/index.ts:538-539`: `if (existing) return
   existing`) **silently ignores** a new constructor-time schema/prompt/route. I
   verified that line. My proposal's handle submits through the entity but I did
   not address that a reused cached entity ignores the Workflow's `outputSchema` /
   `systemPromptAppend`. For the **MVP** (fresh create per agent) this is latent —
   a freshly created entity has no prior generation — so it is **not** a
   correctness bug for this task's delivery. For the **future attach-existing**
   path it becomes mandatory. **Assessment:** binding profile to the runtime
   generation is the right target; implementing the full create-context-schema
   negotiation now is only mandatory if attach-existing were in scope, which it is
   not (Non-goal). Escalate as a documented seam, implement the minimal
   "fresh-generation profile" now.

8. **Workflow-runner lease/guarded-arm is the weakest scope claim.** The runner
   is a detached `SupervisedChild` (`runner-process.ts`), so the same
   crash-reaping argument applies in principle. But requirement §Scope names
   "Workflow stop and terminalization ordering" and the *TeamMate* close contract;
   it does not name the runner's own process-group durability as the defect. The
   mandatory fix is: `workflow_stop` must **await** runner stop + member closes
   before reporting terminal (fixing the detached `observe` early-return at
   `run-terminal.ts:76-82`). Proving the runner's process group absent via a
   durable per-run lease across daemon crash is a **follow-up**, same class as C4.

Owner-correctness check on arch-events: I found **no** red-line violation. It has
no `TeammateService → TeammateCollection` edge, no collection-forwarded close, no
observer-as-command. Its risk is **over-scoping**, not wrong ownership.

## D. Corrections to my own proposal (self-audit against the red line)

Per the review mandate, explicit findings against my own text:

1. **Claim-release timing (my §6) is wrong.** I allowed clearing
   `activeMembership` on the `closed` event. That lets a public `send` reopen the
   entity before the Workflow run record commits. **Revised:** the claim releases
   only after the Workflow terminal record commits (adopt arch-events /
   arch-membership position). The `closed` event evicts the *cache*; it does not
   touch the *claim*.

2. **My `stopAll` "runtime quiesce sweep" (my §7) is a latent second teardown
   path.** Same defect I flagged in arch-membership B2. **Revised:** server
   shutdown and dissolve close each Workflow member through its handle (one entity
   `close()`); the collection retains at most a *side-effect-free* snapshot for
   the composition root to close remaining handles. No `entity.stop()`-only path
   may leave a durable identity non-`closed`. `stop()` remains only as the
   internal runtime-termination phase reached through `close()`.

3. **My eviction guard (my §5.3) is too weak.** Instance-identity alone
   (`entities.get(name) === entity`) does not distinguish a reopened generation on
   the same cached instance. **Revised:** the `closed` fact carries a
   `lifecycle_generation`; the subscriber evicts only when the cached instance,
   its instance id, and its current generation all match the event.

4. **My post-`SIGKILL` re-check stays; the durable resource lease does not enter
   my recommendation as mandatory.** I keep the in-process bounded proof (my §4.2)
   and escalate the cross-crash detached-child lease as follow-up (C4).

Nothing else in my body forwards close through the collection, exposes a raw
runtime as a command, or uses an event as a command. My §5 event is post-commit
and read-only; my handle executes close on the entity directly.

## E. Resolved disagreements that change implementation boundaries

| Disagreement | arch-entity (mine, orig) | arch-membership | arch-events | Resolution |
|---|---|---|---|---|
| Claim release point | on closed event (wrong) | on close commit (ambiguous text, B1) | on Workflow terminal commit | **Workflow terminal commit.** |
| Shutdown teardown | runtime quiesce sweep | runtime-only + defensive sweep | one entity `close()` per handle | **One entity close; no runtime-only sweep.** |
| Dissolve vs Workflow-stop order | outcome asserted | stopAll waits, then idle | stop Workflows *then* wait idle (explicit) | **Stop Workflows before capturing writer-idle.** |
| Eviction race guard | instance identity | +generation | +instance-id+generation+closed_at | **Generation-guarded eviction.** |
| Strict settle path | not addressed | not addressed | strict, non-swallowing + submission_id | **Adopt strict settle + submission_id (mandatory).** |
| Durable runtime lease | escalate | absent | full guarded-launch contract | **Escalate as follow-up, not MVP-blocking.** |
| request_fingerprint | absent | absent | full canonicalization contract | **Follow-up; not required by MVP.** |
| Runner process-group lease | await stop only | not addressed | full per-run lease | **Await runner stop for terminal; lease is follow-up.** |
| `waitIdle` raw runtime | keep | keep | neutral writerActivity | **Prefer neutral handle; low priority.** |

The two disagreements that genuinely move the implementation boundary are
**claim-release timing** and **shutdown-via-one-close** — both resolve toward
arch-events. Everything else is either agreed or a scope decision (below).

## F. Mandatory root-cause work vs optional expansion

**Mandatory (this task; the smallest coherent end-to-end change):**

1. Delete `OwnedTeammateOps` / `OwnedTeammateOwner` / `exclusivelyOwned` /
   `releaseExclusive` / `releaseAllOwned` / `cleanupFailedOwnedSpawn` / the owned
   `SpawnRoute` branch (all three deletion lists agree).
2. Entity-owned close: admission fence, single-flight, immediate cancel, bounded
   runtime termination with **post-`SIGKILL` in-process liveness re-check**,
   distinct facts (runtime terminated vs durable closed), one idempotent result.
3. `TeammateService` publishes a post-commit `closed` fact via a narrow revocable
   source; collection evicts as a **generation-guarded** subscriber; listener
   failure cannot roll back the commit.
4. `spawnOwned` returns a handle; Workflow holds one handle per agent and closes
   each on stop; `workflow_stop` **awaits** member closes **and** runner stop
   before reporting terminal (kills the `run-terminal.ts:76-82` early return).
5. Process-local exclusive claim as the public-mutation fence for `send`/`close`;
   released only at Workflow terminal commit.
6. Move `resolveAgent` + read-helpers to a neutral module; add an
   architecture-gate test forbidding `teammate-service → teammate-collection`
   imports and forbidding collection-forwarded close.
7. Team dissolve stops Workflows **before** the writer-idle wait; server shutdown
   closes every member through the one entity close (no runtime-only sweep).
8. A **strict, non-swallowing settle/close persistence path** with a host
   `submission_id` — the minimum needed so a successful close/terminal is
   *truthful* (today's `turns-store.ts:200-217` swallow makes it not).

**Optional / escalate (separable follow-ups; do not bundle without operator
sign-off because each is a new durable/protocol contract):**

- Durable `AgentRuntimeResourceLease` + guarded-launch provider seam +
  PID-reuse-resistant locators (arch-events C4). Fixes a *pre-existing*
  detached-child crash-reaping leak; needs a `dreamux-types` protocol bump and a
  `BREAKING:` state note.
- `WorkflowRunnerResourceLease` + guarded runner arm (arch-events C8).
- `request_fingerprint` + canonicalization-version negotiation (arch-events C5).
- Full `platform/jsonl.ts` torn-tail/`fsync`/lock rewrite (arch-events C6) beyond
  what the strict settle path minimally entails.
- Create-context-vs-per-turn structured-output negotiation and full
  generation-scoped profile (arch-events C7) — only becomes mandatory when
  attach-existing ships (Non-goal here); implement the minimal fresh-generation
  profile now and document the seam.
- Neutral `writerActivity()` replacing raw `liveRuntimes()` for dissolve (B3).

**Scrutiny of the specific expansions the review asked me to weigh:**

- *Durable resource leases:* justified by a real latent leak, but out of the
  requirement's named root cause; escalate.
- *Host submission IDs:* the ID itself is mandatory (truthful correlation across
  the entity-submit/Workflow-record crash gap); the fingerprint is not.
- *JSONL repair:* entailed only to the extent the strict settle path needs it;
  the full repair engine is optional.
- *Generation profiles:* mandatory *shape* (bind profile to runtime generation),
  optional *depth* (create-context schema negotiation) until attach ships.
- *Shutdown budgets:* arch-membership's timed persistence-abandon budget is
  **not** recommended without the resource lease — abandoning the durable
  `closed` write while the process exits, with no lease to prove the child dead on
  reboot, weakens criterion 9. Prefer: bounded runtime kill (fast) + best-effort
  durable close + fail-loud recovery, rather than a persistence timeout.
- *New persisted semantics:* only `submission_id` (nullable, additive) is
  recommended for the MVP; everything else stays out until escalated. Any adopted
  additive field still requires the Rush change-file / maintenance-skill sync per
  root `CLAUDE.md`.

## G. Final recommendation

Adopt **my entity-owned architecture as corrected in §D**, taking arch-events'
stricter positions on the three items that change boundaries (claim-release at
Workflow terminal commit; shutdown/dissolve via one entity `close()` with no
runtime-only sweep; dissolve stops Workflows before the idle wait; generation-
guarded eviction), and arch-events' **strict non-swallowing settle path + host
`submission_id`** as the minimum for a truthful close/terminal.

**Do not** bundle arch-events' durable resource-lease / guarded-launch provider
contract, `request_fingerprint` canonicalization, full JSONL repair engine, or
create-context schema negotiation into this task. They are legitimate,
well-argued, and mostly address a *pre-existing* detached-child crash-reaping
leak — but they expand the blast radius to a `dreamux-types` protocol bump and
`BREAKING:` state changes that the requirement's "smallest coherent change" and
Non-goals do not authorize. **Escalate them as a scoped follow-up decision
record** so an architect explicitly rules on the added durable surface before
implementation. arch-membership is the right *altitude* but must fix its
claim-release timing (B1) and drop its runtime-only shutdown sweep (B2).

The one item I escalate rather than resolve: **whether daemon-crash detached-
child reaping is in scope**. If the operator considers a leaked detached runtime
after a daemon crash an acceptance blocker for *this* task, then arch-events' lease
becomes mandatory and the task grows a provider-protocol bump; if it is accepted
as pre-existing debt, the MVP ships with in-process bounded termination proof plus
fail-loud recovery. This single decision determines whether the implementation
boundary is "reverse the dependency" (my recommendation) or "reverse the
dependency **and** rebuild the runtime durability contract" (arch-events full).

## H. Consolidated deletion list (agreed across proposals)

Mandatory deletions for the recommended MVP boundary:

1. `teammate-collection/owned-teammates.ts` (whole file): `OwnedTeammateOps`,
   `OwnedTeammateOwner`, `createOwnedTeammateOwner`, `SpawnOwnedTeamMateOptions`,
   `OwnedTeamMateSpawnResult`.
2. `TeammateCollection.exclusivelyOwned` map, `releaseExclusive`,
   `releaseAllOwned`, `cleanupFailedOwnedSpawn`, and the `owned` branch of
   `spawnWithRoute`.
3. `TeammateCollection.close()`'s synchronous `evictEntity` call
   (`index.ts:326-332`) and any other close→evict coupling — eviction becomes the
   `closed`-fact subscriber reaction.
4. `WorkflowRun.teammateOwner` symbol and its two uses (`run.ts:69,329,581`); the
   `agentTasksDrained && !shutdownRequested` gate that skipped release
   (`run.ts:580`).
5. The detached `observe`/synchronous `initiateStop` early-return that reports
   `stopped` before teardown (`run-terminal.ts:76-82`); replaced by awaiting
   runner stop + member closes.
6. `TeammateService` imports of `../teammate-collection/agent-config.js` and
   `../teammate-collection/read-helpers.js` (`index.ts:18,23`) — relocated to a
   neutral module.
7. `DispatcherService.doStop`'s `_teammates.releaseAllOwned()` (`index.ts:279`)
   and the `DispatcherWorkflows.rollbackStart` / `TeamService.closeLogically`
   `releaseAllOwned` calls — replaced by handle closes through the one entity
   contract.
8. `trackSettleCapture` / `inFlightSettleCaptures` **iff** the strict entity-owned
   settle drain (F.8) is adopted (the entity then drains its own settles). All
   three proposals delete these; I concur, conditioned on F.8 landing.

Deletions I explicitly **do not** endorse for this task (they belong to the
escalated follow-up): public `TeammateService.stop()` / `getRuntime()` removal
across all callers, `applyWorktreeCleanup` forwarding replacement by a Team
worktree-fact projector, `completionKey`→`completionSubmissionKey` envelope-id
change, and the synchronous-store-event removal + async projection bridge. Each is
sound but widens the change beyond the requirement's root cause; sequence them
after the dependency reversal ships and is verified.
