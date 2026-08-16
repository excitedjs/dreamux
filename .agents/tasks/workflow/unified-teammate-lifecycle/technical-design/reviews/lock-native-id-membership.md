# Review: entity-owned `lock()` + in-process Turn objects

**Requirement SHA-256:** `4367fcdee10bbe23c5af6a2a3806772fcda3eb57887432552d3b0488e45c264a`
**Prior final (superseded):** `f687ee0be22090afdbe648a9bbb9d7cedbd22ed63bbccd715a66e8b55c653ca6`
**Source baseline:** `6b8ec14b080389bf6c6ae36fa336ec0451e401ec`
**Review seat:** `lock-native-id-membership`
**Scope:** (1) entity-owned `TeammateService.lock()` and restricted handle lifetime; (2) object-based in-process Turn lifecycle replacing service-layer turn IDs; (3) confirmed removal of unused Channel `turn.submitted`/`turn.settled` events and every remaining `turn_id` exposure.

## Verdict

**APPROVE with mandatory contract refinements.**

No membership or lifecycle race was found that truly requires a service-level external turn identifier. Every current use of `turnId:string` outside the provider adapter is replaceable by in-process object identity, direct closure capture, or a single-row terminal turn record. The provider-native id stays inside the provider. The Channel `turn.submitted`/`turn.settled` event pair is removed entirely (no production subscriber per the final requirement clarification, so no reason to preserve it as a speculative observation channel). One durable shape change (turns JSONL from two-row submit+settled to one terminal row) is required. Public-contract changes (MCP/Workflow/history/Channel-delivery `turn_id` fields removed; Channel turn event pair deleted) are called out explicitly below with migration and compatibility consequences.

## 1. `TeammateService.lock()` membership review

### 1.1 Required contracts (exact)

```ts
// packages/dreamux/src/service/teammate-service/lock.ts
export class TeammateService {
  // Existing admission states expanded with lock ownership:
  //   'open' | 'closing' | 'closed'  (unchanged)
  //   + private lockOwner: LockToken | null

  /**
   * Acquire one exclusive process-local write lease. Returns a restricted
   * handle that authorizes submission and close for that owner. Rejects if
   * the entity already has a non-null lockOwner, or if admission is
   * 'closed'. While held, every ordinary public side effect rejects.
   */
  lock(input: { owner: LockOwnerKind; note?: string }): LockedTeammateHandle;
}

export type LockOwnerKind = 'workflow'; // 'public-send' one-op permit uses the same
                                       // mechanism but is taken and released
                                       // within one command and does NOT outlive
                                       // the call. (See §1.4.)

export interface LockedTeammateHandle {
  readonly name: string;
  readonly lifecycleGeneration: number;

  /** Submit as the lock holder. The returned Turn is bound to this lock. */
  submit(input: TeammateSubmitInput): Promise<Turn>;

  /**
   * Transition the entity to closed. Runtime kill, drain, durable closure,
   * worktree cleanup. Resolves once the entity is durably 'closed'. Does
   * NOT release the lock; caller must still call unlock() after its own
   * terminal persistence.
   */
  close(input?: { note?: string; persistenceBudgetMs?: number }): Promise<TeammateCloseResult>;

  /**
   * Release the lock. If the entity is already durably closed (either by
   * this handle's close() or by crash-recovery), emits the 'closed'
   * lifecycle event so the Collection can evict. If the entity is still
   * open (future attachExisting release-without-close), restores ordinary
   * public mutation access. Idempotent per handle.
   */
  unlock(): void;
}
```

`LockToken` is a branded opaque object allocated inside `lock()`; the entity uses reference equality (`===`), not a string or symbol lookup. No external lock/claim registry.

### 1.2 Lock lifetime through Workflow terminal

Required order, as read against the operator red line and the revised requirement §Required ownership model §TeammateService:

1. **Fresh create**: Collection constructs entity → Collection subscribes to entity lifecycle events BEFORE adding to its cache → entity enters 'open' state with `lockOwner === null` → Workflow calls `entity.lock({owner:'workflow'})` BEFORE runtime start (so a concurrent stop can close it even if runtime is not yet started; handles create-vs-stop linearization per acceptance criterion 9 "close-vs-start" interleaving). The handle is what the Workflow retains in `WorkflowRun.AgentCall`.
2. **Runtime start + initial submit** occur through the handle; handle.submit() returns a `Turn` object.
3. **Active membership**: every ordinary public side-effecting entry (send, close, steer, scheduledInput, reopen, channelInput) rejects before any mutation because `lockOwner !== null` and the permit held by the caller is `null` or does not match. `list/status/history/last` remain available (read-only).
4. **Workflow stop or natural finalize**: calls `handle.close()` which:
   - sets admission `closing`,
   - joins close single-flight,
   - iterates active `Turn` objects and races runtime-stop vs settle on each Turn's one-shot terminal latch (see §2),
   - terminates runtime via the bounded SIGTERM→1s→SIGKILL→post-KILL liveness proof,
   - drains persistence tail,
   - performs entity-owned worktree cleanup (existing semantics),
   - persists identity `status:'closed'`,
   - resolves close result.
   - **Does NOT emit 'closed' event and does NOT release the lock yet.** The entity remains cached and locked.
5. **Workflow persists its own terminal journal and record.** The handles remain valid; the lock is still held; late runtime/settle callbacks match on the Turn object (not on string IDs) and observe the already-reserved latch.
6. **After the Workflow terminal journal + record agree** ("both facts agree", per requirement §Workflow terminal consistency), Workflow calls `handle.unlock()` on each member handle.
7. **`unlock()`**: sets `lockOwner = null`; if the entity is durably `closed`, schedules the asynchronous `'closed'` event (microtask-deferred, per-listener try/catch, not on the transition stack); if the entity is still open (future `attachExisting` early-release case), simply restores public admission.
8. **Collection subscriber** sees `'closed'` and performs CAS-guarded eviction from the live `entities` cache (generation compare). Durable identity remains on disk; history remains readable.
9. **Ordinary reopen**: a subsequent `teammate/send` resolves the durable identity via the Collection (cache miss → storage load → new TeammateService instance → `ensureStarted({reopenClosed:true})`) on a fresh entity with `lockOwner === null`. This does not touch the terminal Workflow record.

This satisfies acceptance criteria 5, 6, 8, 9, 11, 12, 13, 15, 16, 17, and 23.

### 1.3 Lock and the operator red line

No command path flows through Collection to close an entity. The Collection:
- constructs entities (factory ownership, legitimate inward arrow),
- subscribes before cache publication,
- evicts on `'closed'` event as a subscriber-owned reaction,
- exposes a public `close(name, input)` adapter that does `entity = this.mustEntity(name); entity.assertPubliclyMutable(); await entity.close(input); return result` — NO post-close bookkeeping, NO eviction, NO exclusive-owner map.
Lock ownership is entity-internal. There is no Collection-owned `exclusivelyOwned` map; there is no second lifecycle owner.

### 1.4 One-op public permit (not a separate claim registry)

The requirement states: "Active Workflow write exclusion is entity-owned through `TeammateService.lock()`. Do not split this fact into a separate claim registry, public command adapter, or Workflow port."

Public side effects are not locked out when `lockOwner === null`. A public `send`/`close` needs its own short-lived mutual exclusion with any concurrent `lock()` or `close()`. This is achieved by the entity's existing admission state machine plus a short-lived "one-op" lock acquisition inside each public command:
- public `send()` does `withOneOpPermit(() => submit(...))`, which acquires a one-op marker (same `lockOwner` field with a distinct `{kind:'public'}` token), performs the submit, and releases on settle/return.
- A concurrent `lock()` CAS fails the `lockOwner: null → workflow` transition if a one-op permit is held (so a public send in flight prevents a Workflow from locking the entity mid-submit; the Workflow factory must retry or queue).
- A concurrent public `send` while the Workflow lock is held fails at the admission check.

This is still entity-owned; no external lock table is introduced.

### 1.5 Future `attachExisting`

Per requirement §Shared entity distinct responsibilities: "a TeamMate first created through ordinary TeamMate tools may later participate in a Workflow". When attach-existing ships, it resolves the entity through the Collection and calls `entity.lock({owner:'workflow'})` on it, exactly as fresh-create does after construction. If the entity currently has a one-op permit in flight, lock CAS fails and the attach retries/rejects per policy. No new entity is created; no "createdByWorkflow" bit is stored. Fresh and attach use the same LockedTeammateHandle.

### 1.6 Failure scenarios that the lock contract must prevent

These are the concrete failures the lock design must be tested against; each motivates a deterministic race test:

1. **Close-before-runtime-start (acceptance 9 close-vs-start).** Failure scenario: Workflow calls `entity.lock()`, collection publishes into cache, a concurrent `workflow_stop` arrives before runtime start and calls `handle.close()`; without the lock returning before runtime start, stop would be unable to see the entity and the runtime would be orphaned. Required: `lock()` returns the handle BEFORE `ensureStarted()` runs; handle.close() operates on the entity even in pre-start state (a pre-start close sets admission 'closing' and the pending start joins single-flight and short-circuits).
2. **Public send during locked window (acceptance 15).** Failure scenario: operator calls `teammate/send` on a Workflow-locked member and the message reaches the runtime; the Workflow's deterministic call graph and turn/result correlation are corrupted, and the Workflow result is no longer auditable. Required: public side-effecting entry checks `lockOwner !== null` and rejects before any runtime action.
3. **Unlock before Workflow terminal persist (acceptance 6).** Failure scenario: handle.close() releases the lock when the entity becomes durably closed, then a public `send` reopens the TeamMate and starts a new turn before Workflow terminal persist commits; the Workflow later reads its own terminal record and sees itself terminal while the TeamMate is already live in a new unrelated turn, and (worse) the new public turn's settlement could deliver into the still-live WorkflowRun agent callback. Required: close() does not release the lock; unlock() is an explicit separate call that Workflow invokes after its own terminal journal+record agree.
4. **Late settle after close but before unlock.** Failure scenario: runtime emits `onTurnSettled` for a turn after entity.stop() returned but before unlock; if that path is routed through the old string-id CompletionRouter table using a turn_id captured at submit, the entry may have been cleared by close and the completion dropped, or double-delivered. Required: Turn object owns the completion closure; settlement calls turn.resolve(outcome) directly and close reserves 'stopped' on the same latch; there is no map entry to clear.
5. **Unlock of an open entity (future attachExisting early release).** Failure scenario: attach-existing code unlocks without close (future Workflow simply detaches and leaves the TeamMate running); unlock() fires a 'closed' event erroneously and the Collection evicts a live entity. Required: unlock() only fires 'closed' when entity.state.admission === 'closed'; otherwise it just clears lockOwner and restores public admission.
6. **Process death mid-Workflow.** On restart no lock state is recovered (lock is process-local). Current recovery policy for running Workflow records is no-resume (requirement §Restart: "durable running Workflow recovery retains the current no-resume product policy"). Entity restart for non-closed identities follows existing `recoverLiveRuntimesForOwnerClose` semantics. The fact that a teammate was locked is not needed across restart because all Workflows that held locks are also recovered to stopped/failed without resuming.

### 1.7 Lock-fate finding: BREAKING persistence shape is NOT needed for lock

The lock is explicitly process-local. No change is required to the durable identity JSON or to WorkflowRunRecord to persist lock state. Lock is not a membership fact durable enough to write; it is a process-local write fence.

## 2. Object-based in-process Turn lifecycle review

### 2.1 Current-surface audit of `turnId:string` use (source-grounded)

Every use of a host-visible `turnId` string in current service-layer code was audited. Classification:

| Location | Current use | Replaceable by Turn object? |
|---|---|---|
| `completion-router/index.ts` `pending/inFlight/terminal` Maps keyed by `completionKey = producerName:turnId` (lines 61-69, 197-199) | In-memory, process-local delivery routing | **Yes.** `WeakMap<Turn, CompletionInitiator>` (or a `Set<Turn>` on the Turn itself) is a drop-in replacement; the producer-name qualifier is no longer needed because a Turn is bound to one entity at construction. |
| `teammate-service/submission-readiness.ts` `bufferedSettles: Map<string, TurnSettledSignal[]>` (line 16) | Buffer for settles that arrive synchronously before submit returns an id | **Yes.** Eliminated entirely: `submit()` returns the Turn synchronously BEFORE it yields to the runtime, so there is never a window where a settle cannot be delivered to its Turn. The buffer's only purpose was the id-less window; with an object returned up front it disappears. |
| `teammate-service/index.ts` `CompletionEnvelope.id = name:turnId` (line 486), `sourceId: completion:id` (line 163) | Informational envelope id; used only as sourceId for deduplicating the follow-up completion turn, not as a router key | **Yes.** The sourceId string for deduplication can be a per-Turn nonce (a local `Symbol()` or a monotonically increasing per-process counter) allocated by the Turn at construction, but this is internal to the completion-delivery turn's dedup and is not a service-level turn ID. It is never written to durable storage or exposed on MCP/channel surfaces. |
| `agent-entity/turns-store.ts` `appendSubmit`/`appendSettled` writing separate rows with `turn_id` (lines 83, 113); `foldLastTurns` joins them on `turn_id` (`read-helpers.ts:104-139`) | Durable join key for history/`last` | **Replaced by schema change:** single-row terminal record (§2.3). |
| `workflow-service/types.ts` `WorkflowAgentRecord.turn_id`, run.ts:346 persist, run.ts:438-452 defensive check, journal.ts:21 submit event | Durable correlation guard and journal field | **Yes.** Defensive check is replaced by the in-process Turn reference held in `AgentCall.turn`. Workflow agent record and journal no longer carry `turn_id`; the terminal Agent outcome is written as a terminal fact from the settled Turn. No per-submit journal event is needed (§2.4). |
| `mcp/tool-catalog.ts` `SUBMISSION_TURN_SCHEMA.turn_id`, `teammate-mcp.ts`/`team-mcp.ts` receipt projection, workflow agent schema turn_id field | Public MCP response | **Removed** per requirement "Dreamux service records, Workflow records/journal rows, TeamMate MCP receipts, `last`/history results, and Channel turn events do not expose a turn ID merely to preserve this in-process relationship." |
| `dreamux-types/src/channel.ts` `ChannelTurnSubmittedEvent.turn_id`, `ChannelTurnSettledEvent.turn_id`, `ChannelExactDeliveryResult.turn_id` | Cross-package channel SPI | **Removed** per requirement; channel providers do not need a Dreamux turn id (Feishu provider does not currently consume it — see evidence). |
| `dreamux-types/src/turn.ts` `InboundDeliveryResult.turnId`, `AgentRuntimeTurnResult.turnId` | Provider-facing and service-facing return shape | **Replaced:** `AgentRuntimeTurnResult` carries a `RuntimeTurn` object (or null for duplicate/stopped/failed); `InboundDeliveryResult.turnId` is removed from the service-facing DTO (provider-internal ids stay inside the provider adapter). |
| Codex turn-manager `pendingTurns`, `activeTurnId` (internal) | Provider-internal correlation against app-server `turn.id` | **Stays.** Provider-native. Never leaves the codex package. |
| Claude runtime `nextTurnId('turn')` synthetic counter | Provider-internal correlation | **Removed.** Replaced by per-ActiveTurn object identity within the claude runtime; native SDK user-message UUID (when added per requirement "Claude Code uses the UUID of the initial native SDK user message as the logical turn identifier") becomes the provider-internal correlation key. The synthetic id ceases to cross into Dreamux service layer. |
| `dispatcher-service/agent.ts:120`, `team-service/index.ts:648,656`, `workflow-service/index.ts:163` call sites for `router.register/settle/discard` | Callers of the completion router | **All adjusted** to pass the Turn object; no `completionKey(name,turnId)` composition remains. |
| `liveRuntimes()`, `waitIdle()`, scheduler idle paths | Do not reference turnId | No change. |

No use requires a service-level turn identifier once the Turn-object and single-row-history changes are applied.

### 2.2 Required RuntimeTurn and Turn contracts (exact)

```ts
// Provider-level (inside agent-runtime packages; neutral type in dreamux-types):
export interface RuntimeTurn {
  /** Resolves when the runtime's logical turn reaches a terminal outcome. */
  readonly settled: Promise<RuntimeTurnOutcome>;
  /**
   * Steer additional input into this logical turn. Resolves once accepted.
   * Throws if the turn is already terminal or the runtime does not support
   * folding. Returns the same RuntimeTurn (not a new one).
   */
  steer(input: { text: string; priority?: 'now' | 'next' }): Promise<RuntimeTurn>;
}

export type RuntimeTurnOutcome =
  | { status: 'completed'; resultText: string }
  | { status: 'failed'; error: Error }
  | { status: 'stopped' };
```

A provider submission (`completionInput`/`channelInput`) returns `Promise<{status:'submitted'; turn: RuntimeTurn} | {status:'duplicate'} | {status:'stopped'} | {status:'failed'; error}>`. When a new submission is folded into an already-active logical turn, it returns the SAME `RuntimeTurn` object (Codex already does this via `claimActiveTurnSlot` returning the existing slot; Claude already does this via `activeTurn` and returns `active.turnId` — the return value becomes the existing `RuntimeTurn` object).

```ts
// Service-level (packages/dreamux/src/service/teammate-service/turn.ts):
export interface Turn {
  readonly name: string;
  readonly origin: TeammateTurnOrigin;  // 'public-send' | 'workflow-agent' | 'channel' | 'scheduled' | 'completion-delivery'
  readonly promptPreview: string | null;
  readonly intent: string | null;
  readonly startedAt: number;
  readonly settled: Promise<TurnOutcome>;
  /** Resolve this turn's terminal latch. Called by runtime-settle path AND
   *  by close-induced stop. First call wins; later calls are no-ops. */
  resolve(outcome: TurnOutcome): void;
}
```

- `Turn.resolve` uses a one-shot value-or-error latch (`new Promise<TurnOutcome>` with deferred resolve/reject, plus a `settled` flag) — same terminal-latch pattern that the superseded `final.md` named "entity-owned terminal latch". Runtime completion and close-induced stop both call `turn.resolve({status:'stopped',...})` or `turn.resolve({status:'completed',...})`; first wins.
- The completion-delivery closure is captured on the Turn at construction, not registered in a map. When `turn.settled` resolves, the Turn runs its own post-processing: append terminal history row, then invoke the captured delivery closure (if origin === 'public-send').
- `WorkflowRun.AgentCall` retains `turn: Turn` directly (requirement: "WorkflowRun.AgentCall retains the concrete Turn object. It does not write an ID and later accept a callback that must be matched back to the call."). It awaits `call.turn.settled` to observe the agent's outcome before finalize. No `call.record.turn_id` field; no defensive string compare.
- A second public send to the same TeamMate while the first is in flight is allowed only if the runtime folds it (both providers already do). In that case the provider returns the same `RuntimeTurn`, and the service layer must create ONE service `Turn` per `RuntimeTurn`. The service layer must NOT create a second service Turn wrapping the same RuntimeTurn.

### 2.3 Durable turns archive: single-row terminal record

Requirement: "Turn history persists one complete terminal record from the settled Turn object. It does not append separate submit/settled rows and later join them by ID."

Replace the current dual-row schema in `AgentTurnsStore` with a single append per terminal Turn:

```ts
interface AgentEntityTurnRecord {
  version: 2;
  type: 'turn';  // single row type, replaces 'submit' | 'settled'
  timestamp: number;           // settledAt
  started_at: number;          // from Turn.startedAt
  turn_origin: AgentEntityTurnOrigin;
  intent: string | null;
  prompt_preview: string | null;
  settle_status: 'completed' | 'failed' | 'stopped';
  assistant: string | null;
  assistant_preview: string | null;
  assistant_truncated: boolean;
  // NO turn_id field.
}
```

`foldLastTurns` in `read-helpers.ts` no longer joins; it streams and filters rows by `type === 'turn'` and applies the existing preview/truncation logic. The folding code shrinks dramatically.

**BREAKING consequence for historical turns:** existing v1 `turn.jsonl` files contain rows with `type:'submit'` / `type:'settled'` joined by `turn_id`. These archives must remain readable. Required loader behavior:
- The stream yields both v1 and v2 rows.
- `foldLastTurns` folds v1 rows via the existing join-on-`turn_id` logic and treats v2 rows as already-complete turns.
- Over time, v1 rows naturally age out of `last` history windows; no forced migration rewrite is required.
- Rush change note: `BREAKING: TeamMate turn archive schema versioned to v2 single-row terminal records; existing v1 rows remain readable by all read surfaces. Review: no operator action required; history/log readers remain backward-compatible.`
- No `Rebuild:` instruction (data is not corrupted; no rescan is needed).

**Mid-turn crash visibility:** If the process crashes after submit but before settle, no terminal row is written, so the partial turn is absent from `history`/`last`. Current behavior already risks this: the existing `appendSubmit` and `appendSettled` are best-effort (turns-store.ts lines 207-217: append failures are logged and swallowed), and a process crash between the two appends leaves an orphan submit row that `foldLastTurns` drops because it skips rows without `turn_id` or without a matching settled (read-helpers.ts:104-115). The new behavior is therefore a strict simplification, not a regression.

### 2.4 Workflow records and journal

- `WorkflowAgentRecord` drops `turn_id`. Terminal agent outcome (status, resultText, error) is written to the agent record once `call.turn.settled` resolves during finalize. There is no in-flight `'submit'` journal event (requirement: no submit/settled rows joined by ID). The Workflow journal retains `kind:'agent_start'` and `kind:'end'` only.
- Because a Workflow turn cannot settle after terminal persist (finalize awaits all `call.turn.settled` before journaling end), there is no late callback that needs to match a stale id.

### 2.5 Public MCP surface

- `SUBMISSION_TURN_SCHEMA` in `tool-catalog.ts` drops `turn_id`. Response shape for `teammate/send`, `teammate/spawn`, `team/send`, `team/create` becomes `{ status: 'submitted' | 'duplicate' | 'stopped' | 'failed', error?: string }`.
- `workflow.status`/`workflow.list` agent schema drops `turn_id`.
- Rush change note: `BREAKING: MCP TeamMate/Team send/spawn and Workflow agent responses no longer include a turn_id field; the service no longer mints a service-level turn identifier. Review: operators and the bundled workflow skill must not depend on a turn_id receipt; use the TeamMate/Workflow status and history surfaces to correlate results. No rebuild required.`

### 2.6 Channel SPI and unused turn events

- The `ChannelTurnSubmittedEvent` and `ChannelTurnSettledEvent` types are **deleted** from `dreamux-types/src/channel.ts` (final requirement clarification: these events have no production subscriber — Feishu channel does not subscribe, evidenced at `feishu-channel.ts:401-411` — and retaining them "as a speculative reason to serialize a Turn identity" is explicitly disallowed). A future external turn-feed feature must define a self-contained contract when it is actually needed.
- `DispatcherCoreEventPublisher` wiring in `AgentTurnsStore.publishTurn()` (`turns-store.ts:127-163`) is deleted; `AgentTurnsStore` no longer takes a `coreEvents` dependency.
- `ChannelExactDeliveryResult` returns `{ status: 'submitted' }` without `turn_id`; channel providers that need correlation use their own native message id (which they already do for inbound dedup via `sourceId`).
- `InboundDeliveryResult` in `dreamux-types/src/turn.ts` is a service-internal DTO and drops `turnId`.

### 2.7 Completion router rewrite

`CompletionRouter` retains its purpose (at-most-once bounded delivery of settled completions back to initiating dispatchers/leaders) but its keys become the Turn object:

```ts
class CompletionRouter {
  private readonly pending = new WeakMap<Turn, CompletionInitiator>();
  private readonly inFlight = new WeakMap<Turn, Promise<void>>();
  private readonly terminal = new WeakSet<Turn>(); // LRU semantics are unnecessary with WeakSet: GC of the Turn object naturally evicts.

  register(turn: Turn, initiator: CompletionInitiator): void;
  discard(turn: Turn): void;
  settle(turn: Turn, completion: CompletionEnvelope): Promise<void>;
}
```

The LRU `terminalOrder` eviction (current line 69, 189-193) is removed: `WeakSet` ties entry lifetime to the Turn object; once the Turn is GC'd there are no more possible settles for it, so no leak. `completionKey(name, turnId)` is deleted.

This eliminates the reverse-lookup class of defect entirely: a settle can never route to the wrong initiator because it is delivered to the Turn it is bound to, not to a string that could collide.

### 2.8 `submission-readiness.ts` buffer

The `bufferedSettles: Map<string, TurnSettledSignal[]>` (line 16) exists solely because a runtime may synchronously invoke `onTurnSettled` before `completionInput` returns the `turnId` (the comment at lines 7-11 says exactly this). Once `submit()` synchronously returns the `Turn` object before yielding to the runtime — which it does: `submit()` creates the Turn, invokes `runtime.completionInput()`, and if the runtime synchronously settles from inside that call, it resolves the Turn via `turn.resolve()` before `submit()` returns — the buffer becomes unnecessary and is deleted. The Turn's own latch is the synchronization point.

### 2.9 Provider adapters

**Codex (`packages/agent-runtime/codex/`):**
- Continue to use native app-server `turn.id` inside the runtime for `pendingTurns` map and collector correlation.
- Replace `ActiveTurnSlot.turnIdPromise: Promise<string>` with `ActiveTurnSlot.turn: RuntimeTurn` (constructed at slot creation). The `RuntimeTurn.settled` promise resolves when `onTurnSettled` fires for the native turn id OR when `stop()` reserves stopped — both race on the RuntimeTurn latch.
- `claimActiveTurnSlot` returns the existing slot's RuntimeTurn for folded followers; no new turn object is minted.
- `turn.id` is never passed out of the codex package except into debug logs.

**Claude Code (`packages/agent-runtime/claude-code/`):**
- Delete the synthetic `nextTurnId('turn')` counter (runtime.ts:655-657, 174, 204-205) and the returned `turnId: string` field on `AgentRuntimeTurnResult`. Replace with per-ActiveTurn `RuntimeTurn` object identity.
- Folded steer returns the active `RuntimeTurn`; this matches current behavior at runtime.ts:337, 377 where it returns `active.turnId` — now returns `active.turn` (same object).
- The requirement "Claude Code uses the UUID of the initial native SDK user message as the logical turn identifier." Current `buildUserMessage` in stream.ts:219-230 does not emit a `uuid` field on the outbound envelope. Adding the SDK-native `uuid` to the envelope is a provider-internal concern; the UUID does not cross the provider/Dreamux service boundary. It is used inside the Claude adapter to correlate assistant-stream fragments to the active RuntimeTurn (replacing the synthetic counter for provider-internal correlation). Dreamux core never requests or interprets it.

### 2.10 Concrete failure scenarios the Turn-object design must prevent

1. **Double delivery of a late settle.** Failure scenario: runtime emits `onTurnSettled` twice (bug in the provider or a late CODEX RPC duplicate), and both invocations deliver a completion to the initiator; the operator sees the assistant reply twice. Required: `Turn.resolve` uses a one-shot latch; the second call is a no-op and does not invoke delivery.
2. **Folded steer creates a second Turn/service outcome.** Failure scenario: a second `send` while a turn is in flight returns a separate Turn whose settlement overwrites the first Turn's outcome in history or in the Workflow agent record. Required: when the provider folds into an active turn (returns the same RuntimeTurn), the service layer uses the existing Turn (already bound to the first initiator); the second initiator receives the same `Turn.settled` promise (which resolves to the same outcome). For Workflow-owned turns, no public send is allowed at all while the lock is held; for public-send turns, the second public caller's completion closure replaces OR is chained per existing shared-turn semantics (matching current behavior where the second steer returns the same turnId but does not register a second completion initiator — today registerCompletion is skipped for folded sends because no new turn is registered).
3. **Close-induced 'stopped' races a runtime 'completed' settle.** Failure scenario: runtime produces a final response at the same moment close() issues SIGTERM; one path records `stopped` and the other records `completed`, causing divergent history vs Workflow result. Required: both paths compete on `Turn.resolve`; first writer wins; the loser observes the existing result and performs no further persistence or delivery.
4. **Synchronous settle during submit.** Failure scenario: runtime synchronously completes inside the `completionInput()` call (mocked or failing fast runtime); the service code that registers post-submit hooks has not run yet, and the settle is dropped on the floor, leaving the Turn pending forever. Required: Turn is created and its resolve function is wired into the runtime's `onTurnSettled` callback BEFORE `completionInput()` is invoked; synchronous settle inside `completionInput` resolves the Turn via the callback before submit returns.
5. **Post-unlock stale Turn reference.** Failure scenario: after handle.unlock() restores public admission, a turn resolve arrives from an earlier Turn held by a finished Workflow (the closure still holds the Workflow's completion callback), and the delivery fires into a new Workflow that happens to be running on the same TeamMate. Required: handle.close() resolves every active Turn with 'stopped' before returning (drain step); a turn that has already settled cannot resolve again; and once the Workflow drops its AgentCall references the Turn object becomes unreachable (WeakMap in CompletionRouter means no pinning), so no callback retention exists across the unlock boundary.
6. **History fold with v1 and v2 rows mixed.** Failure scenario: old v1 turns (with turn_id) stop appearing in `last` after the upgrade, or double-count as two turns. Required: foldLastTurns reads v1 rows with the existing join logic and v2 rows as complete turns; both contribute to the last-N window. Verified by a compatibility test with a seeded v1 archive.

### 2.11 No external identifier is required for any audited race

Exhaustive check across the scenarios raised in §1.6 and §2.10:

- **Fresh create/stop:** entity reference + lock handle covers it.
- **Close/reopen (ordinary post-Workflow):** Collection cache miss loads new entity; Generation counter on the entity ensures stale events don't evict the new instance; the Turn is owned by the new entity.
- **Multiple sequential turns:** each turn produces one Turn object; sequential ordering is provided by the runtime's own active-turn serialization; history appends are serialized through the entity's persistenceTail.
- **Public send completion push:** initiator closure on the Turn replaces the string-keyed router registration.
- **Fold/steer:** same-RuntimeTurn, same-Turn identity.
- **History/API compatibility:** v1 reader preserves old rows; MCP contract change is BREAKING but documented.
- **Cross-process (channel):** channel's own native message id (`sourceId`) is used for inbound dedup; no Dreamux turn id is needed.
- **Scheduled turns:** schedule identity is the cron key + fire time, not turn id; the resulting Turn is delivered through the scheduler's existing response path without needing an external id.
- **Dissolve idle barrier:** `liveRuntimes()` / `waitIdle` do not iterate turns.
- **Shutdown:** close() iterates active Turn objects directly.

No race was identified that requires a service-level external turn identifier.

## 3. Mandatory deletion list

In addition to the deletions identified in the superseded final.md (OwnedTeammateOwner, OwnedTeammateOps, exclusivelyOwned map, releaseExclusive, releaseAllOwned, spawnOwned, owned-teammates.ts, trackSettleCapture, inFlightSettleCaptures, finalize shutdown-skip branch, TeammateService.release() alias, releaseAllOwned in dispatcher/team/finalize paths, TeammateService imports from teammate-collection, Collection post-close synchronous eviction, detached early-return workflow_stop per adjudication):

- `packages/dreamux/src/service/teammate-service/submission-readiness.ts` `bufferedSettles: Map<string, TurnSettledSignal[]>` and the map lookup code in `capture()`/`flushBuffered()`.
- `packages/dreamux/src/service/completion-router/index.ts` `completionKey()` function; replace Map<string,> keys with WeakMap<Turn,>.
- `packages/dreamux-types/src/turn.ts` `InboundDeliveryResult.turnId`, `AgentRuntimeTurnResult.turnId`; replace with `turn: RuntimeTurn | null` on submitted.
- `packages/dreamux-types/src/channel.ts` `ChannelTurnSubmittedEvent`, `ChannelTurnSettledEvent`, and `ChannelExactDeliveryResult.turn_id`. The turn-submitted/turn-settled event pair is removed entirely (no production subscriber); `ChannelExactDeliveryResult.turn_id` is dropped.
- `packages/dreamux/src/service/agent-entity/types.ts` `AgentEntityTurnRecord.turn_id`; the dual `type:'submit'|'settled'` union collapses to single `type:'turn'` at `version: 2`.
- `packages/dreamux/src/service/agent-entity/turns-store.ts` `appendSubmit`/`appendSettled` split; replace with single `appendTurnResult(turn: Turn, outcome: TurnOutcome)` called when `turn.settled` resolves. Remove `coreEvents` constructor dependency and `publishTurn()` entirely (Channel turn events deleted).
- `packages/dreamux/src/service/teammate-collection/read-helpers.ts` join-on-turn_id code in `foldLastTurns`; add dual v1/v2 reader.
- `packages/dreamux/src/service/workflow-service/types.ts` `WorkflowAgentRecord.turn_id`; `journal.ts` `kind:'submit'` event shape.
- `packages/dreamux/src/mcp/tool-catalog.ts` `turn_id` in `SUBMISSION_TURN_SCHEMA`; `teammate-mcp.ts`/`team-mcp.ts` projection of `turn_id`; workflow agent schema `turn_id`.
- `packages/agent-runtime/claude-code/src/runtime.ts` `nextTurnId()` counter, `runtimeInstanceId` counter used for turn ids, synthetic `claude-turn-<kind>-<instance>-<n>` string.
- `AgentRuntimeCreateContext.onTurnSettled?: (settled: TurnSettledSignal) => void` signature that carries `turnId: string`; replaced by a `RuntimeTurn` construction callback.
- `ChannelTurnSubmittedEvent`, `ChannelTurnSettledEvent` types from `dreamux-types/src/channel.ts`; the entire unused event pair is removed, not renamed or stripped.
- Construction dependency on `DispatcherCoreEventPublisher` in `AgentTurnsStore` and all `publishTurn` callsites.

## 4. Migration and compatibility summary

| Surface | Change | Compatibility |
|---|---|---|
| `turn.jsonl` | `version:2`, single `type:'turn'` rows, no `turn_id` | v1 reader retained; old rows remain readable; no forced migration; BREAKING with `Review:` note. |
| MCP `teammate/send`, `teammate/spawn`, `team/send`, `team/create` response | drop `turn_id` | BREAKING; callers that read `turn_id` must use status/history. Documented with Rush change. |
| MCP `workflow/status`, `workflow/list` agent entries | drop `turn_id` | BREAKING; same note. |
| `ChannelCoreEvent` `turn.submitted` / `turn.settled` | **entire event pair deleted** (no production subscriber) | SPI cleanup; built-in Feishu channel never subscribed; external providers have no documented dependency. |
| `ChannelExactDeliveryResult` | drop `turn_id` | Channel SPI; built-in Feishu channel does not read the field. |
| `InboundDeliveryResult` / `AgentRuntimeTurnResult` | replace `turnId:string` with `turn:RuntimeTurn | null` on submitted | Internal service/provider seam; versioned via package dependency. |
| Workflow run record JSON / journal | drop `turn_id` from agent entries and `submit` journal event | BREAKING on shape; parser accepts old records with `turn_id` present (ignored) for one release window; Rush change with `Review:` note. |
| Lock/claim | process-local, no durable shape | No migration. |
| `releaseAllOwned` / `spawnOwned` / `releaseExclusive` removed | Deleted | Internal refactor; no public API. |

## 5. Deterministic tests required

Existing load-bearing tests (non-blocking inbound, worktree safety, dissolve, shutdown) must continue to pass without weakening. New tests:

### 5.1 Lock / membership

- **lock.test.ts**:
  1. `lock()` returns a handle before runtime start; `handle.close()` invoked in pre-start state sets admission 'closing', causes subsequent ensureStarted to short-circuit, does not start a runtime.
  2. While `lockOwner` is a workflow token, every public side-effecting method (`send`, `close`, `scheduledInput`, `channelInput`, `reopen`) throws the lock-rejection error before any runtime call. Read-only methods (`status`, `list`, `history`, `last`) resolve.
  3. `handle.close()` stops the runtime, drains, persists closed identity — but `lockOwner` is still set; a subsequent `entity.lock()` CAS-fails until `unlock()`.
  4. `handle.unlock()` on a durably closed entity emits exactly one `'closed'` event on the next microtask; `handle.unlock()` on an open entity (simulated future attach-existing release) emits no event and restores public admission.
  5. Double `handle.close()` (idempotent) returns same result; double `handle.unlock()` is safe.
  6. Two concurrent `lock()` calls: second CAS-fails.
  7. `lock()` racing a public one-op send: one wins, the other rejects (both orderings).
  8. `lock()` on a closed entity rejects.

### 5.2 Lifecycle / Turn

- **close-vs-start (acceptance 9)**: close called between lock return and runtime start cancels start, no runtime process leaks.
- **close-vs-send (public send racing close)**: public send that acquires a one-op permit just before close is either allowed to settle (if it wins the race to attach to the RuntimeTurn) or turned to 'stopped' by close; in no case does it deliver after close resolves.
- **close-vs-settle**: runtime completion and close both call turn.resolve(); exactly one terminal outcome; exactly one history append; exactly one CompletionRouter.settle.
- **Concurrent closes**: three callers invoke handle.close() concurrently; single runtime.stop() and single durable closed persist (single-flight).
- **Post-KILL proof**: provider runtime that ignores SIGTERM is killed; the post-KILL bounded liveness poll throws if PID still exists; retry of close after failed kill resumes without starting a new runtime.
- **Persistence failure after runtime termination**: close rejects with `{runtime_terminated:true, phase:'identity-close'}`; no 'closed' event; entity remains cached and admission-closed; retry closes without restarting the runtime.
- **Listener failure isolation**: a throwing/await-forever subscriber on 'closed' does not delay or fail unlock/close; subscriber error is logged.
- **Stale 'closed' event cannot evict reopened entity**: old-generation event (lower generation than current cache entry) is ignored by eviction CAS.
- **Close success produces exactly one 'closed' event and exactly one 'turn' history row per settled turn.**

### 5.3 Turn object identity / no-id invariants

- **turn-object.test.ts**:
  1. submit() returns a Turn; turn.settled resolves with the runtime outcome; the captured initiator's completionInput is called exactly once.
  2. Runtime synchronously settling inside completionInput() resolves the Turn before submit returns; no buffered-settle path is exercised.
  3. A folded second send returns the same Turn object (===) and does not register a second initiator; turn.settled resolves exactly once.
  4. Close on a Turn that has not settled resolves it with {status:'stopped'}; a subsequent runtime settle is a no-op on the latch.
  5. CompletionRouter with Turn key: double settle (same Turn) delivers once; terminal set prevents retry.
  6. A Turn held by no other reachable object is GC'd and causes no retention leak in CompletionRouter (weak-ref style test with `FinalizationRegistry` or `--expose-gc`).
  7. Codex and Claude runtimes return the same RuntimeTurn object for folded steers; no provider-native id is observed by service-layer code (asserted by type-level and a test that spies on onTurnSettled callback signature).
  8. Claude runtime does not generate the synthetic `claude-turn-` id (asserted by spy / absence of that format in RuntimeTurn internals).
  9. History read returns a correct last-N list for (a) v2-only archive, (b) mixed v1+v2 archive, (c) v1-only archive.
  10. Workflow agent record has no `turn_id` field after an agent run; the `AgentCall.turn` field references the Turn; post-finalize the Turn has no pending delivery callbacks.

### 5.4 Workflow terminal ordering

- **workflow-stop.test.ts**:
  1. `workflow_stop` awaits runner stop → member handle.close() for every member → terminal journal → terminal record → handle.unlock() → returns. A `workflow/status` immediately after stop returns a terminal status (workflow is not left in `running` while teammates are still live), per final.md adjudication (blocking `workflow_stop` rather than immediate-return, because acceptance criterion 11 says "A successful `workflow_stop` must not claim a terminal Workflow while its borrowed TeamMates continue running" and Criterion 12 is rephrased in the revised requirement to allow blocking until convergence).
  2. A never-settling turn (e.g., provider hangs) yields to close's SIGKILL + bounded post-KILL proof; close resolves with 'stopped' within the bounded kill window.
  3. Concurrent stops join the same terminal task (single-flight).
  4. Natural completion invokes the same handle.close pipeline (no separate keep-runnning path).
  5. Close failure leaves Workflow non-terminal and retryable; retry does not issue a second kill.
  6. Terminal-journal success plus record failure retains handles/locks; retry detects existing journal and writes record without emitting a second outcome; claims are released only after both agree.
  7. Late provider callback (e.g., after process event-loop lag) after terminal record cannot mutate the Workflow's agent outcome.

### 5.5 Team dissolve and shutdown

- Team dissolve stops Workflows (which close members via handles) BEFORE waiting for remaining ordinary writers; no Workflow member can keep dissolve at `waiting_for_team_idle`.
- Shutdown closes all Workflows and all non-Workflow entities via handle.close / entity.close, not via runtime-only sweep. After all handles resolve, defensive liveRuntimes() query sweeps orphaned runtimes (no handles exist but runtime survived — cannot happen in correct design but retained as defense-in-depth; this sweep uses low-level runtime.stop() and does not mutate entity/lock state).
- Accepted public stop racing shutdown joins the same terminal task (deadlock prevention, per final.md).

### 5.6 Attach-existing future-proof

- A simulated future attachExisting (resolved entity + lock()) on a non-locked open entity returns a handle through which submit/close operate; no second entity is created; unlock without close restores ordinary public admission.
- A simulated attachExisting on a currently-locked entity rejects at lock() CAS.

## 6. Risks and mitigations

1. **Breaking MCP change for `turn_id` consumers.** Risk: external scripts or the bundled workflow skill may depend on turn_id for correlation. Mitigation: Rush change file and maintenance-reference update explicitly describe the removal; the bundled workflow skill is updated in the same PR to use the status/history surfaces; reviewers must grep for `turn_id` reads across the repo (including skill markdown) and migrate them.
2. **WeakMap-based CompletionRouter GC semantics.** Risk: Turn object is GC'd before settle completes, dropping the completion. Mitigation: TeammateService holds active Turns in a per-entity `activeTurns: Set<Turn>` strong set; the Set deletes the Turn only after turn.settled resolves and persistence completes. WeakMap in the router does not determine Turn lifetime; it only avoids pinning after the entity has released its reference.
3. **Synchronous RuntimeTurn construction required before `completionInput()`.** Risk: a provider cannot return a RuntimeTurn until after the native turn-start RPC responds (Codex is this shape: turn.id arrives asynchronously in TurnStartResponse). Mitigation: RuntimeTurn is constructed synchronously at slot creation; its `settled` promise is unresolved; when the native turn.id arrives, the Codex turn-manager binds it internally to the slot, but the host does not need to see the id. This matches the existing `turnIdPromise: Promise<string>` pattern (turn-manager.ts:241) but replaces the promise-of-string with a RuntimeTurn that already exists.
4. **v1 history join during transition.** Risk: v1 rows with null turn_id are dropped (same behavior today); v1 rows with orphan submit rows (no matching settled) continue to be dropped as they are today. No regression.
5. **Provider-internal UUID adoption for Claude.** Risk: adding a UUID to the Claude `buildUserMessage` envelope might change Claude CLI behavior or require negotiating a capability. Mitigation: this is a provider-internal change; if the SDK does not accept a client-supplied UUID in a given Claude Code version, the Claude runtime falls back to a per-ActiveTurn object identity using a local Symbol without minting a synthetic counter that escapes the provider. The requirement's "Claude Code uses the UUID of the initial native SDK user message" is the forward target; shipping the Turn-object refactor does not gate on that adoption provided the Claude runtime does not expose any turn id to Dreamux core.

## 7. Rejected alternatives

1. **Retain a host-opaque `turn_id` (random UUID minted by service) for durable history correlation.** Rejected: requirement (non-goal: "A Dreamux-owned `submission_id`, service-level turn ID, request fingerprint, or provider replay protocol") explicitly excludes it; the single-row terminal record makes the join key unnecessary; and a host UUID would reintroduce an external identifier for no race that requires it.
2. **Keep the dual-row turns archive but drop turn_id, joining on (timestamp, origin).** Rejected: timestamps collide at millisecond granularity under concurrent turns; the dual-row scheme exists purely because of the service-level id and should be removed with the id, per requirement "It does not append separate submit/settled rows and later join them by ID."
3. **Leave the CompletionRouter keyed by string (e.g., `${name}:${turnNonce}`) where turnNonce is a monotonic per-process counter local to the Turn.** Rejected: this is just a service-level turn id renamed; it still exposes the reverse-lookup defect class the requirement eliminates. Closure capture and Turn object identity are the owner-correct shape.
4. **Make the lock a separate `TeammateMutationClaims` neutral component (as the superseded final.md proposed).** Rejected: revised requirement §Constraints is explicit: "Do not split this fact into a separate claim registry, public command adapter, or Workflow port without new evidence." The lock lives on TeammateService.
5. **Fire 'closed' event from inside close() instead of from unlock().** Rejected: violates acceptance criterion 6 ("A locked TeamMate remains locked through durable Workflow terminal commit; unlock restores ordinary mutation access and triggers cache-retirement notification when the entity is already closed."). The Collection must not evict before unlock because eviction allows a cache miss to materialize a fresh entity for the same name while the Workflow still holds the lock and has not yet committed terminal — that scenario is failure 1.6.3 in §1.6. The event fires from unlock(); close() only transitions the entity's admission/durable state.
6. **Eager unlock from handle.close() and prevent public reopen via a separate post-close "tombstone" flag on the entity.** Rejected: introduces a second flag (closed + tombstone + lock), splitting the write-fence fact. The lock itself IS the tombstone.
7. **Delete `stop()` primitive from TeammateService and use only handle.close().** Rejected: defensive orphan-runtime sweep at shutdown needs a low-level runtime-kill that does not run durable close (it is for leaked runtimes whose entity state is unreachable). `stop()` remains as a restricted primitive not exposed on the public handle; it is not used by any normal lifecycle path.

## 8. Summary

The entity-owned `lock()` design and the object-based Turn design are mutually reinforcing: the lock removes Collection ownership of close and gives us a single handle owner for the whole membership lifetime; the Turn object removes every remaining service-level use of string turnIds and collapses the completion router, submission-readiness buffer, and dual-row history join into simpler direct closure/latch patterns. Provider-native ids (Codex `turn.id`, Claude internal message UUID) remain internal to the provider package. The required BREAKING changes (turn archive v2, MCP turn_id removal, channel SPI turn_id removal) are scoped and documented; no race in fresh-create/stop, close/reopen, multiple turns, public-send completion delivery, fold/steer, or history compatibility requires a service-level external identifier.
