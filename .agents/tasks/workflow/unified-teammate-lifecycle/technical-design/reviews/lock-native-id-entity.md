# Focused Revision Review: entity-owned `lock()` + in-process `Turn` objects

- Reviewer seat: `lock-native-id-entity`
- Authoritative requirement: `requirement.md`, SHA-256
  `be2b1eaf2c9bb6f56033782d282c758b5626cceabcbab783fd19ef9c4dfb723c`
- Prior final (`technical-design/final.md`) is superseded evidence only.
- Source baseline inspected: `6b8ec14b080389bf6c6ae36fa336ec0451e401ec`
- Scope: exactly two simplifications — (1) `TeammateService.lock()` returning a
  restricted Workflow handle in place of external claims/adapter/port roles;
  (2) service-layer **in-process `Turn` objects and captured closures** for
  submission→settlement→delivery→Workflow correlation, deleting every
  service-level unique ID/Map. Runtime-native IDs stay provider-internal.

This review supersedes the earlier runtime-native-ID version of this file. The
requirement no longer asks the service layer to key on a native turn id; it asks
the service layer to hold **the turn object itself** and to remove service/
public/persisted turn IDs, CompletionRouter turn-key maps, Workflow `turn_id`,
the two-row history fold, and the Claude counter id (`requirement.md:312-341`,
non-goal `:415-417`, criterion 18 `:514-516`, decision `:557-560`).

## Verdict

**APPROVE WITH MANDATORY CONTRACT CHANGES.** Both simplifications are sound and
more owner-correct than any ID/Map design. The source audit confirms that every
service-level `turn_id` use is either pure in-process correlation (deletable) or
a boundary label that the design can make self-contained without a global
identifier. Four amendments are mandatory (two per simplification); each is a
precise contract addition, not a reason to reject.

---

## Simplification 1 — entity-owned `TeammateService.lock()`

### Finding 1.1 — APPROVED: collapsing claims/adapter/port onto the entity is owner-correct

`final.md`'s three roles — `TeammateMutationClaims` (registry), a
`PublicTeammateCommandAdapter`, and a named `WorkflowTeammatePort` — are three
views of one entity-scoped fact: "who may mutate this TeamMate now." The current
implementation already houses that fact in one place, just the wrong one: the
`exclusivelyOwned` map + `assertPubliclyAddressable`
(`teammate-collection/index.ts:601-605`) sit on the *collection*. Moving it onto
`TeammateService.lock()` (`requirement.md:152-156,189-193,436-439`) keeps
exclusivity, close, and unlock in one state machine on the entity that owns them,
and removes a cross-module coordination surface without weakening any fence. The
red line is honored: `lock()` is a command returning a handle; the collection
still learns of close only via the post-commit `teammate.closed` fact and evicts
as a subscriber (`requirement.md:170-177,481-484`).

Existing scope wrappers can remain. `admittedTeammateOps`
(`dispatcher-service/teammate-ops.ts:3-18`) and `TeamLeaderTeammateOps`
(`team-leader-handle.ts:13-21`) gate on dispatcher shutdown admission and
TeamLeader generation, never read `exclusivelyOwned`, and call the collection's
public methods; relocating the fence onto the entity does not disturb them
(`requirement.md:190-193`).

### Finding 1.2 — BLOCKER (contract): `lock()` must fence `channelInput`, `scheduledInput`, and `completionInput`, not only `send`/`close`

**Failure scenario.** A Workflow locks member `worker-3`. A dispatcher cron fire
or a channel binding reaches the same entity via `scheduledInput`
(`teammate-service/index.ts:227`) or `channelInput` (`:218`). Today the fence is
enforced only inside `TeammateCollection.send`/`close`
(`teammate-collection/index.ts:316,328`). `channelInput`, `scheduledInput`, and
`completionInput` (`:141`) are reached **directly** — channel via
`DispatcherService` fallback (`dispatcher-service/index.ts:208`) and
`TeamService.deliverToLeader` (`team-service/index.ts:505`); scheduler via
`submitScheduled` (`dispatcher-service/index.ts:130`, `team-service/index.ts:178`);
reverse completion via `CompletionRouter → initiator.completionInput`
(`completion-router/index.ts:129`) — all bypassing the collection fence.
`channelInput`/`scheduledInput` call `ensureStarted`, so a stray input folds into
the Workflow-owned active turn (`teammate-service/index.ts:333-344,373-384`),
corrupting the Workflow's deterministic call graph — the exact harm
`requirement.md:354-357` forbids. Today safety is topological (nothing resolves a
locked member as a channel/scheduler target), not enforced.

**Required contract.** The `lock()` contract must enumerate the fenced entry
points — `send`, `channelInput`, `scheduledInput`, `completionInput`,
`ensureStarted`/reopen, public `close`, `applyWorktreeCleanup` — enforced inside
`TeammateService` before any start/reopen/submit/steer, with an
architecture-gate test that fails if a new side-effecting entry point lacks a
lock check. `requirement.md:154-156` states the intent ("every ordinary
side-effecting entry point … rejects before it can start, reopen, submit to,
steer, close"); the enumerated list must be explicit (criterion 5, `:473-475`).

### Finding 1.3 — BLOCKER (contract): eviction must fire on unlock, not on `teammate.closed`, or the lock dies before Workflow terminal

**Failure scenario.** With `lock()` on the entity, the lock lives on the entity
instance. If the collection evicts the live reference on `teammate.closed`, the
in-memory lock is discarded with it. A public `send` arriving after close but
before the Workflow terminal record commits resolves the durable identity,
rebuilds a fresh `TeammateService` via `entityFor`
(`teammate-collection/index.ts:513-514`) with **no lock**, and reopens the closed
TeamMate through `ensureStarted({reopenClosed:true})` — reopening a member whose
owning Workflow has not durably terminalized (violates
`requirement.md:158-164,300-301`).

**Required contract.** Two ordered committed facts for a Workflow-locked
TeamMate: (1) `close` commits durable `closed` and the entity retains its live
reference *and lock* — no eviction yet; (2) `unlock` (after the Workflow terminal
journal and record agree) publishes the cache-retirement fact, and the collection
evicts as subscriber. This differs from ordinary `teammate_close`, where close
and eviction may coincide because no lock is outstanding. `requirement.md:158-164`
and criterion 6 (`:476-478`) mandate exactly this; the final solution must state
both orderings and that unlock-on-already-closed emits the retirement event.

### Finding 1.4 — APPROVED: locked handle before start; attach-existing unaffected

The fresh-creation path must acquire the lock and return the locked handle
*before* the first `ensureStarted`, so a racing Workflow stop can always close it
(`requirement.md:590-591`). This is a clean relocation of today's ordering, where
`exclusivelyOwned.set` precedes `ensureStarted`
(`teammate-collection/index.ts:285` before `:288`) and `stop` awaits the in-flight
`starting` promise (`teammate-service/index.ts:328`). Future attach-existing
invokes the same `lock()` (`requirement.md:263-266`), so no creation-provenance
kind is encoded (criterion 23).

---

## Simplification 2 — in-process `Turn` objects and closures, no service-level ID/Map

### What the requirement now demands

One accepted logical turn is one object (`requirement.md:314-318`). The
AgentRuntime submission returns a `RuntimeTurn` whose terminal outcome is an
idempotent promise/latch; a fold/steer into an active turn returns the **same
object** (`:316-318`). `TeammateService` owns a `Turn` object that directly
retains the runtime turn, prompt/origin/intent, timestamps, terminal state,
persistence task, and the **completion-delivery closure** captured from the
initiating caller (`:319-321`). `WorkflowRun.AgentCall` retains the concrete
`Turn` object, not an ID plus a matched-back callback (`:322-323`). Close
iterates active `Turn`s and reserves `stopped` on the object's one-shot latch,
racing runtime completion on that same latch (`:324-326`). Settlement invokes the
closure directly — no `producerName+turnId → initiator` registration (`:327-329`).
History persists one complete terminal record from the settled `Turn`, not two
rows joined by ID (`:330-332`). No service record, Workflow row, MCP receipt,
`last`/history result, or Channel event exposes a turn ID merely to preserve the
in-process relationship (`:333-335`). Provider-native IDs stay inside the
provider adapter (`:336-341`).

### Finding 2.1 — APPROVED: the object model is achievable; every in-process ID use is redundant

The source audit confirms each service-level `turn_id` consumer is replaceable by
a direct object/closure reference:

- **CompletionRouter key** (`completion-router/index.ts:197-199`,
  `completionKey(producerName, turnId)`): the maps `pending`/`inFlight`/`terminal`
  are in-memory only, never serialized, reconstructed each call
  (`:61-69`). This is the textbook removable case — the initiating `send` already
  has the initiator in scope; capturing it in the Turn's delivery closure
  eliminates the register/lookup entirely (`requirement.md:327-329`).
- **Workflow AgentCall match** (`workflow-service/run.ts:430-452`): the
  `routeSettledCompletion` closure passed at spawn (`run.ts:330-336`) already
  closes over the exact `call` object; the `call.record.turn_id !== turnId`
  comparison (`:439-441`) is a redundant guard, not a lookup. Retaining the
  `Turn` object on the `AgentCall` removes the guard and the stored id.
- **turn.jsonl submit↔settled join** (`read-helpers.ts:83-156` folds by
  `turn_id`, `:104-139`): the only reader of the persisted `turn_id` is this
  in-process fold, invoked on demand within one process; **no restart path reads
  it** (workflow recovery `recoverRunningRecords`, `workflow-service/index.ts:250-272`,
  never touches `turn_id`). If the settled `Turn` writes one complete terminal
  record (`requirement.md:330-332`), there is no second row to join and the id
  disappears.

So "no map, no service ID" is not merely smaller — it removes correlation state
that only ever existed to re-link two events the object already unifies.

### Finding 2.2 — BLOCKER (contract): the AgentRuntime seam must return a per-turn object/latch, or a `Map<nativeId, Turn>` reappears at the boundary

**Failure scenario.** The current seam settles through a single runtime-wide
callback: `onTurnSettled(settled: TurnSettledSignal)` carrying `turnId`
(`dreamux-types/src/turn.ts:58-66`; wired at `teammate-service/index.ts` settle
path). If the runtime keeps emitting one global settle signal keyed by a native
id, `TeammateService` is *forced* to hold `Map<nativeId, Turn>` to route the
signal back to the right `Turn` — reintroducing exactly the ID/Map the
requirement deletes, just keyed on the native id instead of a service id. The
requirement forecloses this by requiring the submission to **return a
`RuntimeTurn` object whose terminal outcome is an idempotent promise/latch**
(`requirement.md:316-318`) and folds/steers to **return the same object**.

**Required contract.** `AgentRuntime.submit`/`channelInput`/`completionInput`
must return a `RuntimeTurn` handle exposing a `settled` promise/latch owned by
that turn, so `TeammateService.Turn` retains the `RuntimeTurn` directly and awaits
its latch — no runtime-wide `onTurnSettled(turnId)` fan-out and no service-side id
map. Both built-in runtimes already have the internal structure to expose this:
Codex tracks a per-turn pending map keyed by native `turn.id`
(`codex/src/turn-manager.ts:353-357`) and can hand back a per-turn handle; Claude
resolves per-turn via captured closures (`claude-code/src/runtime.ts:357-361`,
`markTurnSucceeded/markTurnFailed`). The native id stays **inside** each adapter
for its own notification correlation (Codex `events.ts:158-176`) and is never
returned across the seam as a service key (`requirement.md:336-341,440-441`).
Without this seam change, the service-level map is unavoidable and the
simplification cannot hold — this is the linchpin contract.

The fold/steer-returns-same-object requirement is already satisfied structurally:
both runtimes fold into one active turn today (Claude returns the existing
`active.turnId`, `runtime.ts:337,377`; Codex resolves followers to the primary
slot, `turn-manager.ts:275-311`). Returning the same `RuntimeTurn` object is a
direct expression of that existing behavior.

### Finding 2.3 — BLOCKER (contract): resolve the boundary labels the object model cannot carry

The audit found `turn_id` genuinely crosses a process/persistence/public boundary
at five places. None is read back for reconciliation, but each is *emitted* to an
external or durable consumer, so the design must decide per boundary whether a
self-contained label is needed. `requirement.md:592-594` explicitly asks this.
The requirement's default is **remove the label** (`:333-335`); a label is kept
only where a verified external boundary truly requires it. Findings:

1. **MCP spawn/send receipt `turn.turn_id`** (`turn-recording.ts:55`; schema
   `tool-catalog.ts:122`; projection `teammate-mcp.ts:376`). **Failure scenario if
   naively kept:** it becomes a dangling identifier no tool consumes — no MCP tool
   takes `turn_id` as input (`last`/`status`/`history`/`send` accept only `name`).
   **Contract:** delete `turn_id` from `SUBMISSION_TURN_SCHEMA` and the receipt;
   the receipt keeps `{ status }` (and `teammate`). This is a public output-shape
   change (compatibility, §2.5).
2. **`teammate.last` turns `turn_id`** (`read-helpers.ts:129`; type
   `agent-entity/types.ts:237`; `OPEN_OBJECT` schema passes it through,
   `teammate-mcp.ts:155,404`). **Contract:** drop `turn_id` from
   `AgentEntityLastTurn`; the terminal record is self-describing
   (origin/prompt/assistant/timestamps). No consumer keys on it.
3. **`workflow_status`/`workflow_list` agent `turn_id`** (schema
   `teammate-mcp.ts:524`, **required**; projection `:557`; type
   `workflow-service/types.ts:18`). **Failure scenario:** it is a *required* field,
   so simply nulling it while leaving the schema required-but-meaningless misleads
   the client. **Contract:** remove `turn_id` from `workflowAgentSchema` and
   `WorkflowAgentRecord`; the agent row keys on `index` + `name` (its real
   identity).
4. **Channel `turn.submitted`/`turn.settled` events `turn_id`**
   (`turns-store.ts:146,158`; contract `dreamux-types/src/channel.ts:284,294`;
   seam `channel.ts:438`). **This is the one boundary that may warrant a label.**
   These events cross the neutral `ChannelProvider.coreEvents` seam to a pluggable
   external provider; a provider that renders per-turn UI (e.g. a "turn started …
   turn finished" pairing) needs to correlate the two events. The shipped Feishu
   provider ignores them today (no `turn_id`/`coreEvents` reference in
   `feishu-channel/src`), and the bus is explicitly in-process/no-guarantee
   (`dispatcher-core-events/index.ts:19-23`). **Contract options, in order of
   preference:** (a) if no in-tree provider consumes the pairing, remove `turn_id`
   from both event shapes — the events remain useful as fire-and-forget
   notifications; (b) if the pairing is judged a real external contract, keep an
   **opaque per-turn event-correlation label minted at the channel-event boundary
   only** (derived from the `Turn` object's identity, e.g. a monotonic
   channel-event sequence), explicitly *not* the service/persisted turn id and
   *not* accepted as input anywhere. The final solution must pick (a) or (b) with
   evidence; the requirement's non-goal (`:415-417`) forbids reintroducing a
   service-level id, so (b) must be scoped strictly to the channel-event envelope.
5. **Durable `turn.jsonl` and workflow record/journal `turn_id`**
   (`turns-store.ts:83,113`; `workflow-service/{types.ts:18,journal.ts:19,run.ts:346,356}`).
   **Failure scenario if kept:** a persisted id that no restart path reads is dead
   weight and re-tempts a future map. **Contract:** persist one complete terminal
   turn record (no submit/settled split, `requirement.md:330-332`), and drop
   `turn_id` from the workflow record/journal — recovery already ignores it
   (`workflow-service/index.ts:250-272`). Historical rows carrying the old field
   must remain **readable** (forward-tolerant decode) even though new writes omit
   it.

### Finding 2.4 — APPROVED: close-vs-settle race and no-replay scope are satisfied by the object latch

The one-shot latch on the `Turn` object (`requirement.md:324-326`) is the correct
home for the close-induced-stopped vs runtime-completion race: both compete on the
same object latch, so exactly one terminal outcome wins — strictly cleaner than
today's positional correlation, and it satisfies "late settlement cannot create a
second outcome" (`requirement.md:326`, criterion, `:305-306`). No-replay scope is
consistent: events are post-commit facts, not a replay log
(`requirement.md:449-451`); restart marks running workflows stopped without turn
correlation (`workflow-service/index.ts:250-272`), so deleting the ids does not
break any recovery path. The requirement does not add replay (non-goal `:406`).

---

## Exact contract changes (simplest form)

**lock():**
1. `TeammateService.lock()` → restricted handle `{ submit, close }`; the entity
   fences `send`/`channelInput`/`scheduledInput`/`completionInput`/reopen/public
   `close`/`applyWorktreeCleanup` while locked (Finding 1.2).
2. Cache-retirement fact publishes on `unlock` (after Workflow terminal
   journal+record agree), not on `close` (Finding 1.3).
3. Fresh creation acquires the lock and returns the locked handle before the
   first `ensureStarted` (Finding 1.4).

**Turn objects:**
4. `AgentRuntime` submission returns a `RuntimeTurn` object with an idempotent
   `settled` latch; folds/steers return the same object; remove the runtime-wide
   `onTurnSettled(turnId)` fan-out and any service-side `Map<id, Turn>`
   (Finding 2.2). Native ids stay provider-internal.
5. `TeammateService.Turn` retains `RuntimeTurn` + prompt/origin/intent/timestamps
   + persistence task + completion-delivery closure; settlement invokes the
   closure directly (Finding 2.1).
6. `WorkflowRun.AgentCall` retains the concrete `Turn`; delete the
   `producerName/turn_id` match guard (Finding 2.1).
7. Persist one complete terminal turn record; delete the submit/settled two-row
   fold (Finding 2.3.5).
8. Resolve the five boundary labels per Finding 2.3: remove from receipt, `last`,
   workflow rows, durable records; decide channel-event label (a)/(b) with
   evidence.

## Deletion list (from current source and from the superseded `final.md`)

- `CompletionRouter` turn-key maps and `completionKey(producerName, turnId)`
  (`completion-router/index.ts:61-69,197-199`) — replaced by the Turn's captured
  delivery closure + the existing bounded delivery policy.
- Service/public `turn_id`: `SUBMISSION_TURN_SCHEMA.turn_id`
  (`tool-catalog.ts:122`), `AgentEntityLastTurn.turn_id`
  (`agent-entity/types.ts:237`), `workflowAgentSchema.turn_id`
  (`teammate-mcp.ts:524`), `WorkflowAgentRecord.turn_id`
  (`workflow-service/types.ts:18`) and its journal/run writes
  (`journal.ts:19`, `run.ts:346,356`).
- The two-row submit/settled fold keyed by `turn_id` (`read-helpers.ts:83-156`);
  the persisted submit+settled split in `turns-store.ts:83,113` collapses to one
  terminal record.
- Claude synthetic `claude-turn-<runtime>-<counter>` and its counters
  (`claude-code/src/runtime.ts:655-656,174,204-205`).
- The runtime-wide `onTurnSettled(turnId)` service fan-out contract in favor of a
  per-turn `RuntimeTurn.settled` latch (`dreamux-types/src/turn.ts:58-66` service
  consumption; native id stays inside adapters).
- From `final.md`: `TeammateMutationClaims` as a separate component
  (`final.md:150,249-267`), `PublicTeammateCommandAdapter` role
  (`final.md:151,592-598`), named `WorkflowTeammatePort`
  (`final.md:304-333`), and the host `submission_id` + `TurnHandle.submissionId`
  everywhere (`final.md:335-365` and refs) — the object identity replaces both the
  claim registry and the submission id.
- Do **not** delete: provider-internal native ids (Codex `turn.id`
  correlation, `turn-manager.ts:353-357`; Claude internal closures); the durable
  identity `closed` fact and lifecycle event; historical readability of old
  `turn_id` fields (forward-tolerant decode).

## Tests (deterministic)

lock():
- lock held → each of `send`/`channelInput`/`scheduledInput`/`completionInput`/
  reopen/public `close`/`applyWorktreeCleanup` rejects before any runtime
  start/submit (one per entry point — the Finding 1.2 regression guard);
  architecture-gate test fails a new unfenced side-effecting entry point.
- close-holds-lock: after `close` commits, a public `send` is still rejected and
  does **not** reopen; only after `unlock` does a public `send` reopen the
  retained identity (Finding 1.3).
- unlock-triggered eviction: collection retains the live reference through close
  and evicts only after unlock emits the retirement fact; a stale close-time event
  cannot evict before unlock.
- create-vs-stop: stop between lock acquisition and first `ensureStarted` closes
  via the held handle with no runtime started (Finding 1.4).
- concurrent lock rejects (criterion 5).

Turn objects:
- one submission returns one `RuntimeTurn`; a fold/steer into the active turn
  returns the **same object** (identity assertion), for both runtimes.
- close-vs-settle: runtime completion and close-induced stop race the same object
  latch → exactly one terminal outcome; a late runtime callback after the latch is
  resolved is a no-op (Finding 2.4).
- ordinary send delivery: the initiator captured in the Turn closure receives the
  completion with no CompletionRouter registration; two concurrent sends to
  different initiators each deliver to their own captured closure (no cross-wire) —
  the property the old `producerName:turnId` key protected.
- Workflow AgentCall: the settle updates the exact retained `Turn`/`AgentCall`
  with no id comparison; a stray settle for a different call cannot match (object
  identity, not id).
- history: `last` returns one terminal record per turn built from the settled Turn
  object; no submit/settled join; a historical two-row file still reads.
- boundary labels: MCP spawn/send receipt, `last`, and `workflow_status` outputs
  contain no `turn_id`; a client that previously ignored `turn_id` is unaffected;
  channel `turn.*` events follow the chosen (a)/(b) contract and carry no
  service/persisted id.
- shutdown: server shutdown closes locked Workflow members through the same entity
  close; no Turn object leaks an unresolved latch (all reserved `stopped`).
- no-replay: after restart, running workflows are marked stopped without turn
  correlation; deleting the ids changes no recovery outcome.

## File self-check

This review discusses the **in-process `Turn` object + captured-closure** model
(object identity and one-shot latch owning submission→settlement→delivery→Workflow
correlation), not runtime-native-ID correlation. Runtime-native IDs are treated as
provider-internal only (Finding 2.2), and the mandated seam change is precisely to
avoid a `Map<nativeId, Turn>` reappearing at the boundary. The obsolete
runtime-native-ID review has been fully overwritten.

## Summary

Approve both simplifications. Mandatory: (1.2) `lock()` fences the three
non-`send`/`close` entry points; (1.3) eviction fires on unlock, not close; (2.2)
the AgentRuntime seam returns a per-turn `RuntimeTurn` latch so no service-side
`Map<id, Turn>` is needed; (2.3) each of the five boundary `turn_id` emissions is
removed, except the channel-event envelope which is resolved with evidence as
either "remove" or "opaque channel-event-only label." With these, delete the
CompletionRouter turn-key maps, the service/public/persisted `turn_id`s, the
two-row history fold, and the Claude counter id.
