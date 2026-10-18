# Trae Seed — independent technical solution proposal

- Input: [Requirement revision 1](../../requirement.md) (finalized after Q1, Q1a,
  Q2, Q3 on 2026-10-13).
- Status: independent proposal for cross-review. Not an accepted solution and
  not development approval.
- Method: ownership and feasibility claims below were checked against current
  `next`-aligned source in this worktree; pointers are given for every
  load-bearing claim.

## 1. Scope and solution shape

Two capabilities, with two different owners:

1. **Member messaging (stories 1–2):** ordinary Team members get a new,
   deliberately small MCP server with two verbs — one explicit `send_message`
   to `"leader"` or a same-Team peer, and one roster read. Every message rides
   the existing ordinary-submission path end to end (admission ledger,
   rendering, wake/reopen, runtime busy behavior, Team fence). No new
   transport, queue, or persisted fact.
2. **Native-result reporting (accepted Q1/Q1a):** one new runtime-neutral,
   generation-leased sink through which each provider reports the
   `RuntimeCompletion` of **every normally completed or provider-observed
   failed native turn**, including turns no Dreamux submission bound to. The
   reported object is the *same frozen object* the folded submissions settle
   with, so the existing completion-token fold is the entire dedup mechanism.
   Core delivers it through the existing completion router with the existing
   Team recipient and the existing fences.

Explicit messages and automatic reports stay separate mechanisms with
separate semantics, exactly as the confirmed baseline requires: a peer
message is never auto-copied to the TeamLeader; a turn's automatic result
goes to the TeamLeader regardless of initiator; replies are explicit sends.

Nothing in this proposal changes interruption, shutdown, stop suppression,
completion wake semantics, Workflow terminal reporting, or any persisted
state/config shape.

## 2. End-to-end behavior

### 2.1 Member to TeamLeader (story 1)

Member `alice`, possibly inside an unbound background turn, calls
`send_message {to:"leader", message:"blocked on flaky test X"}`. The host
binds `from=alice` (the model cannot set it); the message is admitted through
the Team fence and submitted to the TeamLeader as an ordinary input
(`wake:true`, so an idle/stopped leader runtime is started). The tool returns
an admission receipt immediately. The leader reads
`<team-message from="alice">…</team-message>` and can answer through its
existing teammate `send` verb. No completion recipient is attached to the
leader's input, so no automatic reply ever returns to alice.

### 2.2 Peer exchange across turns (story 2 + Q2)

`alice` calls `send_message {to:"bob", …}`. Core routes to the Team-scoped
`TeammateCollection.send` — the same verb the TeamLeader uses — which resolves
`bob`, reopens his durable record under the existing recovery rules when he is
closed (accepted Q2; this is the *caller set* being extended, not a new
reopen mechanism), wakes an idle runtime, and submits. The turn's automatic
completion is routed to the TeamLeader because the collection already selects
its owner's completion recipient at submit time
(`packages/dreamux/src/service/agent/index.ts:318`). `alice` receives nothing
automatically; `bob` answers her by calling `send_message {to:"alice"}`,
which works even though alice's original turn has ended: the message is an
ordinary fresh input to alice, not a turn correlation.

### 2.3 Background build, folded and unbound (Q1/Q1a, story 3)

- The leader spawns `carol`; her first turn answers "build running" — one
  report to the leader, as today.
- The build finishes in a later native turn with no Dreamux submission: the
  provider emits that turn's `RuntimeCompletion` through the new sink; Core
  reports "build passed" to the leader once.
- A further unbound turn fails: the failed completion is reported once (Q1a).
- A later steer submitted while either background turn is live folds into it;
  submissions and sink share one frozen completion object, so the leader
  still receives exactly one report for that native turn (existing fold in
  `CompletionDeliveryPolicy`, `completion-router/index.ts:121-146`).
- Interrupted/teardown terminals are not results: neither provider emits, and
  a turn the owner's own stop ended is additionally suppressed by the existing
  `owesCompletion()` rule. Owner-stop behavior is unchanged.
- A long-running dev server that keeps producing normal terminal turns
  produces one report per terminal turn. Cross-turn quiet-point aggregation is
  explicitly out of scope: no authoritative quiet fact exists, and the
  requirement records that waiting for drain can delay a "ready" report
  indefinitely.

## 3. Ownership and boundaries

| Concern | Owner | Why |
| --- | --- | --- |
| Sender binding, target scope (leader vs same-Team peer), catalog | Core, new member MCP delegate in the agent module | Host-owned identity and roster; the model supplies text only |
| Admission, reopen, wake, busy merge, dedupe ledger, rendering, display input event | `AgentService.submitInput` / `TeammateCollection.send` unchanged | One admitted-input operation already exists; the new caller must not create a second path |
| Team teardown fence for both targets | `TeamService` (`admitTeam`, existing `submitInput` on the leader, `fence.admit` on the collection) | Same fence that protects leader tools today |
| Native-turn observation | Each runtime adapter, behind a new neutral sink | Only the provider sees native terminals; the contract carries results, not scheduling |
| Whether an observed result is reported | `AgentService` (role/owner binding, lock, `owesCompletion`) | It is the one object that knows phase, host stop, and the Workflow lock |
| Recipient, per-recipient ordering, fold, retry/drop policy | `CompletionDeliveryPolicy` + `TeamService.completionRecipient()` unchanged | The result router already owns exactly this |
| Delivery into the leader runtime | `prepareCompletion` / `submitCompletionInput` unchanged (`wake:false`) | Automatic-completion wake semantics are frozen by the requirement |

The neutral seam stays neutral: providers learn neither "Team" nor "leader"
nor "Workflow" — they emit a turn result on a leased sink. All policy
(recipient, suppression, scope) stays in Core.

## 4. Part A — runtime-neutral native-result capability

### 4.1 Neutral contract (`packages/dreamux-types`)

Add one optional leased sink to `AgentRuntimeCreateContext`
(`packages/dreamux-types/src/agent-runtime.ts:263-305`), next to `activity`:

```ts
/**
 * Leased, synchronous, non-throwing, non-backpressuring sink for the
 * provider-observed RESULT of every normal native turn this runtime runs,
 * including a turn no Dreamux submission bound to.
 *
 * Contract:
 * - emitted exactly once per native terminal that is a normal completion or a
 *   provider-proven failure; never for an interrupted/teardown terminal and
 *   never for a turn whose ending the provider did not observe;
 * - when the turn answered one or more Dreamux submissions, the emitted value
 *   is the exact frozen RuntimeCompletion object their `settled` promises
 *   resolve with — object identity is the fold key;
 * - emitted from the same terminal observation that settles submissions; the
 *   sink must not outlive its runtime generation, and Core drops writes from
 *   a revoked generation;
 * - optional: a provider that never emits keeps today's submission-bound
 *   behavior; only the two in-tree providers are required by this task.
 */
readonly nativeResult?: AgentRuntimeNativeResultSink;

export interface AgentRuntimeNativeResultSink {
  (completion: RuntimeCompletion): void;
}
```

Why a sink rather than a widened activity kind: `turn.ended` is explicitly a
display-only fact carrying no result payload
(`packages/dreamux-types/src/activity.ts:126-149`; the activity sink is
documented as "transient input to the conversation projection, not a progress
view", `agent-runtime.ts:192-205`). Folding needs the same object identity
settlement uses; a parallel descriptive event would invite reparsing and a
second identity. The new sink is the settlement's own publication, carrying
the existing `RuntimeCompletion` type — no new result vocabulary, status
enum, or payload schema.

### 4.2 Claude Code adapter

Observation point: the `result` frame handler in
`packages/agent-runtime/claude-code/src/rpc.ts:276-330`. Today the completion
is built only when `answered.length > 0` and discarded (`null`) for an
unanswered frame.

- Build `completionFromTurnOutcome(...)` for every non-interrupted result
  frame (the constructor already produces frozen completed/failed objects,
  `rpc.ts:363-392`).
- Invoke the new sink once with that object on every non-interrupted result
  frame, *in addition to* settling the answered requests with the same
  object. `interrupted` frames (the two `terminal_reason` values) emit
  nothing and continue to settle answered requests as `stopped`.
- Thread the sink exactly as `activitySink` is threaded today:
  `provider.ts:79` maps `context.nativeResult` into runtime deps;
  `runtime.ts` passes it through `createDefaultClaudeCodeSession`
  (`runtime.ts:352-369`) into `ClaudeCodeStreamRpc` options, beside
  `onProtocolEvent`.
- A discarded/refused command (`command_lifecycle`, `rpc.ts:258-269`) is a
  request-scoped pre-admission failure, not a native turn: no sink emission.
  Session `close`/`stop` and unexpected child exit
  (`runtime.ts:405-424`) produce no observed result and fabricate none.

### 4.3 Codex adapter

Observation point: `TurnManager`
(`packages/agent-runtime/codex/src/turn-manager.ts`). Bound and unbound
native turns already converge there; an unbound terminal is currently
released with "nothing to settle and no completion to describe"
(`turn-manager.ts:285-293, 306-309`).

- Add `nativeResultSink` to `TurnManagerOptions`, wired in
  `runtime.ts:274-283` from the create-context field via `provider.ts:130`.
- Extract the completion construction currently inlined in `finalize`
  (`turn-manager.ts:310-333`) into one `completionFromTerminal(terminal)`
  helper covering the codec-restore failure arm, `Error` terminal → failed,
  and normal text extraction. `finalize` and the unbound queue-head branch
  both call it: one mechanism, one wording for "what the terminal was".
- In `drainTerminalOrder`'s `representative === null` branch: emit the
  completion through the sink when the terminal is a normal completion or
  failure; skip emission when the terminal status is `interrupted`
  (`observeTerminal` already classifies it, `turn-manager.ts:241-243`), then
  release exactly as today.
- `failProtocol` / `failRecord` (`turn-manager.ts:342-369`): unbound records
  dying from the collector's `onUnscopedFailure` emit one failed completion
  through the sink — parity with bound submissions, whose members settle
  `failed` and are reported today. The manager's own teardown `stop()`
  (`turn-manager.ts:104-119`) emits nothing: that is interruption/host stop,
  and the owner-stop rule suppresses it Core-side in any case.

### 4.4 Core observation and delivery

- `RuntimeGeneration` gains a second generation-leased closure,
  `generationNativeResultSink(lease)`, structurally identical to
  `generationActivitySink` (`runtime-generation.ts:295-325`): lease check,
  then hand the value to an observer the owning `AgentService` supplies. The
  observer is passed into the `RuntimeGeneration` constructor (new final
  argument), so lease/state ownership stays where it is and the policy stays
  out of the generation class. The sink is registered in `resolveLaunch`
  context next to `activity`.
- `TeammateServiceOptions` gains
  `nativeResultOwner?: CompletionOwner` (reusing the existing
  `completionRecipient()` interface, `completion-router/index.ts:47-50`).
  - `TeammateCollection.teammateOptions` sets it to the collection's existing
    `opts.completionOwner` **only when the collection is Team-scoped**
    (`teamScope !== null`); the dispatcher-root collection omits it.
  - `teamLeaderOptions` and the dispatcher agent options omit it. Presence of
    the owner is therefore the complete "ordinary Team member" test; no role
    re-check is needed at observation time.
  - The collection forwards the already-available MCP infrastructure into
    member options (see Part B); `completionOwner` is already a collection
    dependency (`agent/index.ts:96-97`), so this adds no construction
    parameter to `TeamService`.
- `AgentService.observeNativeResult(completion)` applies, in order:
  1. no `nativeResultOwner` option → return (dispatcher-scoped member,
     TeamLeader, dispatcher agent — unchanged behavior);
  2. `this.lockToken !== null` → return (accepted Q3: a turn observed while a
     Workflow controls this entity belongs to the script; see §7.2);
  3. `!this.owesCompletion()` → return (the existing owner-stop/teardown
     rule, `service.ts:391-394`, read at the same delivery boundary
     `EntityTurn` uses);
  4. build the existing `TeammateCompletionFact`
     (`{kind:'teammate', source: current().name, role:'teammate',
     status, result}`, `completion-router/index.ts:15-20`) and invoke
     `deps.completionDelivery.deliverRuntime(owner.completionRecipient(),
     completion, fact)`; the promise is observed for delivery like
     `EntityTurn`'s — the policy already logs/drops its own failures.
- `EntityTurn` is untouched. It remains the reporter of bound settlements,
  including transport failures and `stopped` outcomes that have no native
  completion object. For a native-completion turn both it and the sink call
  `deliverRuntime` with the same frozen token and (for Team members) the same
  Team initiator and an equivalent fact; the policy's token WeakMap makes the
  second call a fold, and its per-initiator tail keeps order. No cross-observer
  coordination state is introduced.

### 4.5 Q1a and interruption boundary

- Provider-observed failed unbound turns are reported via exactly the path
  above (`status:'failed'`), once.
- Interrupted unbound turns are not results: no emission in either adapter.
  This keeps the interruption boundary at its existing place, as required.
- Nothing fabricates a result for background work whose terminal the provider
  did not observe (child exit, connection loss without the collector's
  unscoped-failure signal).

## 5. Part B — ordinary-member messaging surface

### 5.1 Server, scope, and wiring

New delegate factory `createTeamMemberMcpDelegate(scope)` in a new
`packages/dreamux/src/service/agent/member-mcp.ts` (kept out of the existing
627-line `mcp.ts`, which already serves the dispatcher/leader scopes and
stays unchanged apart from shared codec imports). Server name constant
`TEAM_MEMBER_MCP_SERVER_NAME = 'team-member'`.

```ts
interface TeamMemberMcpScope {
  /** Concrete member name, bound by the host when options are built. */
  readonly caller: string;
  /** Fenced ordinary-input path into this Team's TeamLeader. */
  readonly leader: {
    submitInput(input: TeammateSubmitInput): Promise<TurnAdmission>;
  };
  /** This Team's own member collection, narrowed to messaging verbs. */
  readonly peers: {
    send(input: MemberMessageInput): Promise<AgentEntitySendResult>;
    list(): Promise<AgentEntityRuntimeStatus[]>;
  };
}
```

- `caller` is read from `identity.name` inside
  `TeammateCollection.teammateOptions` and closed over when the delegate is
  built. No tool argument names the sender; a payload cannot spoof it.
- `leader` is a new narrow collection-construction input (`leaderInbox`)
  supplied by `TeamService` as `{ submitInput: (input) =>
  this.submitInput(input) }` — the existing method already wraps
  `admitTeam` and routes to `mustLeader()` (`team/service.ts:834-847`).
- `peers` is the collection itself. A new collection method
  `sendMemberMessage({from, name, text})` (name chosen in final design)
  performs the existing resolve → reopen-if-closed → send flow, but submits
  with the member-message provenance instead of the hardcoded
  `AGENT_TASK_SOURCE` used by `sendResolved` (`agent/index.ts:310-325`). It
  shares the reopen machinery (`sendReopened`/`reopenFrom`); the only
  difference is the assembled `TeammateSubmitInput`. The completion recipient
  stays the collection owner's — the Team — so peer-triggered results reach
  the TeamLeader with no routing change.
- The dispatcher-root collection never builds this delegate: cross-Team and
  dispatcher-scoped messaging are unrequested, and the structural surface
  makes them unrepresentable.

### 5.2 Catalog (exactly two tools)

1. `send_message`
   - input: `to` (string, 1–64 chars): either the literal `"leader"` or a
     concrete member name validated by the existing
     `validateAgentEntityName`; `message` (string, 1–20000).
   - `to === caller` is a caller mistake (`RuleViolation`: a member cannot
     address itself; no requirement reaches self-messaging and it would fold
     into the caller's own busy turn).
   - unknown peer surfaces the existing `teamMateNotFound` failure through
     the delegate boundary, exactly as leader `send` does today; closed peer
     reopens under Q2.
   - busy target: no Core special case — the ordinary submission reaches the
     runtime, whose existing reception/merge behavior applies; the tool
     description states this in one sentence for both providers, matching
     the acceptance requirement to document rather than hide the difference.
   - receipt: admission only, never a response. Result shape is the existing
     `toSubmissionResult` mapping (`submitted | duplicate | stopped | failed
     | ambiguous`, `admission.ts:133-149`) plus `to`. A new short reminder
     constant states the recipient's result goes to the TeamLeader and a
     reply arrives only via an explicit `send_message`.
2. `list_members`
   - output: the existing compact `list()` rows (name, lifecycle/runtime
     status, intent essentials) so the model can address and can see a closed
     peer is reopenable. The TeamLeader is not a row; the description says to
     address it as `"leader"`.

No spawn, close, history, status, workflow, cron, channel, or team-lifecycle
verbs are advertised. Provenance uses one new open-vocabulary source
constant in `submission-sources.ts`: `MEMBER_MESSAGE_SOURCE =
'team-message'` (satisfies the renderer's safe-tag rule). The recipient's
model reads `<team-message from="alice">body</team-message>`; attribute
escaping is the renderer's existing job (`submission.ts:95-110, 126-132`).
No `notice` kind is added: the envelope is already person-authored content,
and the display `teammate.input` event carries source/content for the
projection without a new union member (`dreamux-types/src/teammate.ts:84-110`).

### 5.3 Workflow exclusion (accepted Q3)

Two complementary rules, each with a named trigger:

- **Tools:** catalogs are frozen per runtime generation at launch
  (`runtime-generation.ts:393-420`), so the lock cannot toggle them at
  runtime. Every Workflow-controlled member is created through
  `WorkflowRun.executeAgent` → `createLocked` with its own
  `CreateLockedTeammateOptions` (`workflow-service/run.ts:480-489`;
  `agent/index.ts:210-236`). Add one option there (e.g.
  `memberMessaging: false`) that the Workflow caller sets and
  `teammateOptions` reads to omit the delegate for that build. Nothing is
  persisted: the member's durable record gains no category, and a later
  reopen/materialization builds ordinary options and gets the tools —
  consistent with "historical creation by a Workflow is not a permanent
  member category".
- **Ordinary input:** unchanged — a peer `send_message` to a locked member
  takes the ordinary mutation gate and is refused while the lock is held
  (`service.ts:176-185`, `enterOrdinaryMutation`); the refusal already
  states the lock. The tool surface renders that refusal to the caller.
- **Automatic reports:** the lock check in `observeNativeResult` (§4.4)
  prevents Q1/Q1a reports for turns observed under active Workflow control;
  script-consumed results keep flowing through `admission.turn.settled`
  (`run.ts:583-586`) with no attached recipient, exactly as today.

### 5.4 Receipt, wake, and failure semantics

- Member sends are ordinary inputs (`wake:true`): idle recipients start;
  closed peers reopen first (Q2); a closing/dissolving Team refuses through
  the same fence leader tools cross (`TeamService.admitTeam`, collection
  `fence.admit`).
- Automatic completion delivery stays push-back (`wake:false`, live runtime
  only, `unsupported` when stopped — `service.ts:487-492, 711-731`). Q1
  explicitly preserves automatic-completion wake semantics; an unbound result
  while the leader runtime is down is dropped/logged by the router as any
  other completion today.
- Sending to the TeamLeader attaches no completion recipient; the leader's
  turn therefore cannot synthesize a reply to the member. Existing
  TeamLeader-to-Dispatcher obligations are untouched (no new recipient is
  attached anywhere on leader or member inputs).

## 6. Wording alignment (required by the finalized requirement)

The two over-promising texts are corrected to state observed facts; neither
edit widens or narrows coverage by itself:

- `completion-renderer.ts:52-53` — completed: replace "has finished its
  task." with turn-result wording (candidate: "produced a completed turn
  result."; final copy in the approved solution). Failed/stopped lines become
  "turn failed." / "turn was stopped." The same factual correction is
  reviewed for the dispatcher/leader role subjects in the same switch;
  Workflow wording ("has completed") is left alone unless the final solution
  chooses otherwise.
- `system-prompt.ts:29-34` — the Team-member sentence no longer promises that
  every turn-end output reaches the TeamLeader by magic while omitting the
  background case. Replacement states: the `team-member` server and its two
  verbs; the TeamLeader automatically receives each normally completed or
  failed turn result, including turns no message triggered; that this reports
  the turn's result, not goal completion; explicit messages admit without a
  reply and answers come back only as explicit sends. The dispatcher-member
  case (`team_id === null`) keeps no membership sentence.

## 7. Lifecycle, concurrency, and shared-result identity

### 7.1 Folding and ordering across the two observers

- Identity is the frozen `RuntimeCompletion` object, which both adapters
  already construct once per native terminal and share with settled requests
  (`rpc.ts:307-329, 363-392`; `turn-manager.ts:329-337`). The policy WeakMap
  is dispatcher-lifetime and already defines "one delivery per token per
  recipient" (`completion-router/index.ts:63-67, 121-146`). Bound turn:
  `EntityTurn` and sink race for the first delivery; the second folds.
  Unbound turn: only the sink delivers. No new identity field, turn id, or
  ledger.
- Failed unbound results are objects too and fold identically when the same
  failure is both a bound settlement and a sink observation.
- Ordering across distinct turns stays the policy's existing per-recipient
  tail; cross-turn aggregation is deliberately absent.

### 7.2 Lock timing edge (Q3) — named, not defended around

The Workflow lock is held from `createLocked` until the run reads
`turn.settled` and unlocks. The provider emits the terminal result while the
workflow's await is still pending (settlement resolves after terminal
observation), so a turn answering the locked submission is observed while
the lock is held and is suppressed in Core. Consequences, stated plainly:

- a native turn that ends *after* unlock with no new Dreamux submission is an
  ordinary unbound turn again and is reported under Q1. This proposal reads
  Q3's "while they are controlled by a running Workflow" literally and
  treats post-unlock continuation as ordinary member behavior. If the
  operator instead wants suppression keyed to "this turn's lineage started
  under a Workflow", no current fact identifies that lineage without new
  state — that would be a material product addition and should return for
  confirmation.
- the generation launched for the locked build omits messaging tools and
  does not gain them merely by unlocking (MCP catalogs are launch-frozen). A
  later reopen/rematerialization serves them. The alternative — always mint
  the server and refuse invocations against a live lock probe — gives exact
  post-unlock availability without restart but advertises tools to the
  scripted model, against the literal Q3 wording. I recommend the
  construction-time omission above; cross-review should confirm.

### 7.3 Fences, generation, rematerialization

- Sink writes from a revoked runtime generation are dropped by the lease
  check, exactly like stale activity (`runtime-generation.ts:299-319`), so a
  replaced provider cannot report into its successor's Team.
- Team dissolve: MCP leases drop before native teardown (member tool calls
  stop admitting); in-flight observed results cross the Team fence inside
  `TeamService.prepareCompletion` and come back `unsupported`, which the
  router logs and drops (`team/service.ts:1060-1096`). No new fence.
- Owner stop/close: `owesCompletion()` negative at observation suppresses;
  delivery already started is never retracted — same rule as `EntityTurn`
  (`turn.ts:121-138`).
- Entity rematerialization (reopen) needs no persisted report state: unbound
  reporting derives from the live owner binding, and tokens live only for a
  delivery decision; a process restart mid-turn simply observes what the
  restored provider reports next, which is the existing recovery posture.

## 8. Capability accounting (entropy)

Reused unchanged:

- the one admitted-input operation, reopen flow, admission ledger, renderer,
  display projection, wake flag, busy behavior;
- `CompletionDeliveryPolicy`, `CompletionOwner`, `CompletionInitiator`,
  `RuntimeCompletion`, `PreparedCompletionFact`, token WeakMap, recipient
  tail, retry/drop rules;
- Team fence, `owesCompletion`, completion push-back path;
- Workflow locked-submit path and script result consumption;
- MCP mint/lease/frozen-catalog machinery and per-generation delegate
  lifecycle.

New (each with a stated requirement):

1. `nativeResult` sink in the neutral contract — the Q1/Q1 requirement cannot
   be observed without it; one method, one existing type.
2. One provider emission point per adapter — same point that already builds
   the completion for bound submissions (Claude result frame; Codex terminal
   queue), with one extracted completion helper in Codex.
3. One Core observer method + one per-entity owner option — the policy
   decision the provider cannot make.
4. One MCP server with two verbs, one structural scope, one provenance
   source constant, one collection messaging method, one collection
   construction input (leader inbox) — the member-messaging stories.
5. One build option for Workflow omission — Q3's literal "receive no tools".
6. Corrected prompt/notification copy.

Removed: none. No user-visible capability is deleted; dispatcher-scoped and
leader behaviors are unchanged; Workflow behavior is unchanged within its
control span. No persisted state, config, schema version, migration,
idempotency ledger, generation counter, or quiet detector is introduced.

## 9. Public contract and provider compatibility

- `AgentRuntimeCreateContext.nativeResult?` is additive and optional: existing
  third-party/test providers compile unchanged and keep submission-bound
  reporting. The two in-tree providers implement it; task acceptance requires
  both.
- MCP surface change is additive for member runtimes only (a new server
  appears in their launch config); dispatcher, leader, and locked-Workflow
  launches keep their current server sets.
- No change to `AgentRuntime.submit`, admission vocabulary, result text
  extraction, session/thread protocols, output schema handling, or activity
  records.
- Rush change files: ordinary notes for `@excitedjs/dreamux-types`,
  `@excitedjs/dreamux`, and both in-tree runtime packages. Nothing here makes
  a persisted config/state file unreadable — no `BREAKING:`/`Rebuild:`, no
  maintenance-skill state contract changes; the dispatcher maintenance skill
  needs no schema updates (its routing text may mention the new member
  surface only if the final solution changes documented tool inventory).
- Package READMEs document the optional sink (following the Claude
  required-command-group precedent from the completion-token work) and the
  per-provider busy-input difference.

## 10. Change manifest (file-level)

- `packages/dreamux-types/src/agent-runtime.ts` — sink type + optional
  context field; doc comments.
- `packages/agent-runtime/claude-code/src/{rpc.ts,runtime.ts,provider.ts}`
  and session factory wiring (`supervisor.ts`/`runtime-deps.ts` as the wiring
  dictates) — emit per result frame; thread the sink.
- `packages/agent-runtime/codex/src/{turn-manager.ts,runtime.ts,provider.ts}`
  — shared terminal→completion helper, unbound emission, unscoped-failure
  emission, sink threading.
- `packages/dreamux/src/service/agent/runtime-generation.ts`,
  `service.ts`, `service-types.ts`, `index.ts`, `submission-sources.ts`,
  `system-prompt.ts`, `completion-renderer.ts` — leased sink, observer, owner
  option, member options/delegate wiring, leader inbox, copy.
- `packages/dreamux/src/service/agent/member-mcp.ts` (new) — delegate,
  schemas, codecs, receipt/reminder.
- `packages/dreamux/src/service/team/{service.ts,types.ts}` — pass leader
  inbox and MCP infra into the Team's member collection.
- `packages/dreamux/src/service/workflow-service/run.ts` — set the
  omit-tools option at locked creation.
- Tests: fake runtime/fixtures gain an unbound-result scenario toggle;
  external provider fixture confirms the optional field; unit suites for the
  router decision matrix, both adapters' emission rules, and the delegate;
  live gates for both providers (with `DREAMUX_SKIP_LIVE_CODEX=1` discipline).
- Docs: `.agents/product/README.md` (member messaging entry; rewrite of the
  background-work bullet that currently says unbound turns do not push; Q2
  reopen caller extension; Q3 exclusion), `.agents/domains/provider-runtime.md`
  (sink contract per provider), current-architecture/completion ownership
  notes, role/skill text and tool descriptions. Knowledge check
  `.agents/scripts/check.mjs` in the implementing PR.

## 11. Acceptance criteria mapping

| Requirement criterion | How this design meets it |
| --- | --- |
| Member reports progress/blocker to leader during a turn with real identity | `send_message to=leader`; `from` host-bound; envelope + input event; works from any live turn because the server is generation-minted |
| Two peers send/reply directly across completed turns, no relay | peer routing through team collection; replies are ordinary addressed sends, correlation-free |
| Idle starts processing; busy uses runtime behavior | ordinary `submitInput` (`wake:true`); no Core branch; provider differences documented in tool/provider text |
| Every distinct applicable completion to leader; folds do not duplicate; peer gets only explicit replies | existing Team recipient + token WeakMap across settlement and sink; peer input never carries the peer as completion recipient |
| Unbound normal completions auto-report, no double delivery vs settlement | shared frozen completion object through new sink; fold proves identity |
| Unbound failed turns auto-report once; owner-stopped work stays silent | sink failed arm + `owesCompletion()`; interrupted/teardown never emitted |
| No auto reply loop to sender; leader→dispatcher obligations intact | member→leader input attaches no completion recipient |
| Target scope and sender host-bound | structural scope, team-scoped construction only, `caller` from identity, self-address refused |
| Peer send reopens closed same-Team member; fences intact | existing collection send/reopen + Team fence; caller extension only |
| Workflow-controlled members: no new tools, locked input refused, no duplicate ordinary report | launch-time omission, existing mutation gate, lock check in observer; script settlement untouched |
| Both in-tree runtimes validated; busy differences documented | both adapters implement the sink; unit + fake + live gates; README/tool text |
| Instructions/descriptions/product/architecture updated | §6 and §10 doc manifest |

## 12. Verification plan

1. Four gates green: `rush update`, `build`, `lint`, `test`,
   `typecheck:tests` — the last is load-bearing for fixture/external-provider
   changes to the create-context shape.
2. Core decision-matrix tests: bound turn delivered once despite two
   observers; unbound completed and failed delivered; interrupted dropped;
   locked suppressed; `owesCompletion` negative suppressed; dispatcher/leader
   owner absent → no delivery; ordering across two unbound turns; revoked
   generation sink write dropped; dissolve → `unsupported` drop.
3. Adapter tests: Claude — zero-answered normal result emits the same object
   answered requests would settle with; interrupted emits nothing;
   discarded/refused command emits nothing. Codex — unbound normal/failed
   terminal extraction (incl. codec failure), interrupted skip, unscoped
   failure emission, `stop()` silence, mixed folded turn single object.
4. Delegate tests: catalog exactly two verbs; `from` cannot be supplied;
   self/unknown/closed/locked/dissolving target outcomes; receipt fields;
   leader path carries no completion recipient; locked build serves no
   `team-member` server.
5. Live gates on both runtimes: unbound background completion/failure
   observed end to end into the leader; member→leader and member→peer
   exchange including a closed-peer reopen; busy-target admission on each
   provider documented from observed behavior rather than asserted equal.
6. Docs and knowledge check; change files present; no state/config
   maintenance divergence.

## 13. Risks, unresolved facts, and the strongest counterexample

- **Notification volume is structural, accepted but real.** Every normal
  native terminal of an ordinary Team member is reported, including
  null-result and internal bookkeeping turns Claude may surface as result
  frames, for the whole life of a resident session. There is no
  content filter (none was authorized) and no quiet aggregation (no producer
  for the quiet fact). The operator explicitly chose this knowing the
  long-background-work repeat counterexample; the mitigation is wording that
  promises a turn result, not task completion, plus the member's explicit
  messages for meaning.
- **Post-unlock reporting/tool boundary (§7.2)** is the one place this design
  interprets Q3 rather than merely executing it. If the final review reads Q3
  as lineage-based suppression, a new provider/Core attribution fact would be
  required and should go back to the operator rather than being silently
  added.
- **Coverage while the leader runtime is down** is unchanged for automatic
  reports: push-back is live-only and can be dropped as `unsupported`. Q1
  preserves wake semantics; passive coverage therefore still has the
  pre-existing stopped-leader gap. Explicit member→leader messages, being
  ordinary inputs, do wake the leader — an asymmetry worth stating in the
  product entry, not fixing here.
- **External providers** that do not implement the sink silently keep
  submission-bound coverage; no capability negotiation is added (no named
  consumer needs to select behavior). If a future packaged provider claims
  Team support without the sink, that is a packaging/validation question for
  its own requirement.
- **Object-identity reliance** is the mechanism's keystone; it is already the
  mechanism the shipped fold depends on, and the change makes both adapters
  emit the same frozen object they settle with — a test in each adapter
  asserts reference identity, because a structural clone would silently
  double-deliver.
- **Codex unbound turns are rare in practice** (turns originate from
  `turn/start`); the Codex implementation is still required for contract
  uniformity, but most real Q1 traffic will be Claude-observed.

---

# Round 2 — cross-review and revised position

- Inputs reviewed in full: `deepseek.md` and `mimo.md` round-1 proposals;
  requirement revision 1; current owning source. Adjudication is against
  source and the recorded requirement, not vote count.
- Round 1 above is preserved unchanged as this seat's independent history.
  This section records accepted and rejected arguments with evidence, then
  states the revised complete position.

## R2.1 Material agreements (all three seats, source-verified)

1. **Two capabilities, no third service entity.** Member messaging rides the
   existing ordinary-submission path; native-result reporting rides a new
   leased sink into the existing completion router. No mailbox, queue,
   persisted fact, aggregation, or work-drain state. Requirement Q1 records
   that no drain/quiet producer exists.
2. **One flat, host-bound addressing scope.** Sender identity is bound at
   delegate construction from `identity.name`; the model supplies no sender
   field; the structural scope reaches exactly one Team's leader and one
   Team's member collection, so cross-Team addressing is unrepresentable
   without an allowlist.
3. **Peer-triggered turns keep the Team as completion recipient; member →
   leader submissions carry no recipient.** Both facts already follow from
   the collection's recipient stamping (`agent/index.ts:194-198, 318`) and
   the requirement's confirmed baseline.
4. **Q2 reopens, Q3 disarms at construction, owner-stop suppression and
   `wake:false` push-back semantics stay as they are.**
5. **The activity seam is not the result seam.** `turn.ended` is
   display-only and carries no result (`dreamux-types/src/activity.ts:126-149`);
   reusing it would build a second lossy result pipeline.
6. **Two wording corrections are in scope and do not themselves widen
   coverage** (`completion-renderer.ts:52-57`, `system-prompt.ts:29-34`).

## R2.2 Adjudicated disputes

### A. Sink traffic: every result (MiMo/trae-r1) vs unbound-only (DeepSeek) — accepted: unbound-only

My round-1 design (and MiMo's) has the provider emit **every** non-interrupted
completion and rely on the token WeakMap to fold bound turns. DeepSeek's
sink carries **only results no Dreamux submission answered**. Source
adjudication favors DeepSeek:

- Both providers already compute exactly this classification at the point
  where the result is currently dropped — it is not new policy logic pushed
  into providers: Claude branches on `answered.length === 0`
  (`claude-code/src/rpc.ts:279-314`); Codex's unbound terminal is a distinct
  existing queue-head branch whose comment is "nothing to settle and no
  completion to describe" (`codex/src/turn-manager.ts:285-293`), and that
  branch even waits for pending admissions (`pendingAdmissions.size > 0`,
  line 286), so a racing `turn/start` binding is resolved before release.
- The emit-all design makes two independent observers race into one
  delivery. It holds only if (i) they use the identical initiator — true,
  the Team returns itself (`team/service.ts:1056-1058`) — and (ii) they
  build byte-identical facts. Today they would not: `EntityTurn` reports a
  failed completion with `result: null` (`turn.ts:141-147`); a sink observer
  built from the `RuntimeCompletion`'s `Error` would carry error text, and
  because the folded second call is swallowed wholesale
  (`completion-router/index.ts:140-145`), the delivered body would depend on
  microtask order. MiMo spotted this (its §7.4 payload decision) and proposed
  extracting a shared fact mapping to repair it. Unbound-only makes the whole
  issue unreachable: one observer per result, one gate read, `EntityTurn`
  untouched, no shared-mapping refactor, no dual `owesCompletion()` read.
- The fold WeakMap is unchanged and still earns its keep for N-submissions-
  one-completion; the requirement's "not delivered twice … when settlement
  and native observation describe the same result" is satisfied by disjoint
  emission plus the same-object guard in the contract for future providers.

**Revised:** sink contract = "the provider-observed result of a normal
completed or failed native turn that settled no Dreamux submission".
`EntityTurn` remains the sole reporter of bound settlements, including
transport deaths that produce no `RuntimeCompletion` at all.

### B. Context field required vs optional — accepted: required, calls optional

House pattern settles this: `state` and `activity` are required fields on
`AgentRuntimeCreateContext` (`agent-runtime.ts:300-303`), while the documented
emission discipline is "absence changes only presentation"
(`agent-runtime.ts:16-18`). My round-1 optional field is revised away:
`results` is a required context member Core always supplies; a provider that
never calls it degrades to today's silence. This also forces fixture/fake
deliberation, which `typecheck:tests` then verifies.

### C. Codex coverage is evidenced in code — DeepSeek's stated blocker rejected as framed

DeepSeek §9.2/§10 makes the contract's shape contingent on proving Codex can
produce an unbound turn. Source disproves "not evidenced in this tree":
`TurnManager` maintains `unboundObservedTurnIds`, releases unbound terminal
records in `drainTerminalOrder` (`turn-manager.ts:285-293`), and forgets
orphan turns on idle (`turn-manager.ts:389-397, 408-421`). The emission point
exists and is symmetric to Claude's. What remains unproven is **real-traffic
frequency** (a `turn/start` response binds every submission,
`turn-manager.ts:161-169`), which MiMo risk 3 states correctly. Consequence:
implement both adapters symmetrically now; document coverage as
"provider-observed" without frequency claims; live verification records what
Codex traffic actually shows. Not a design blocker.

### D. Member surface placement and tool vocabulary — revised toward MiMo/DeepSeek, with a file split

Round 1 of mine created a second server name (`team-member`) with
`send_message`/`list_members` and a reserved `"leader"` token. Revised:

- **Same server name `teammate`, third scope kind.** Both existing scopes
  already return one server whose catalog differs by caller
  (`mcp.ts:68, 93-123`); the member surface is that pattern's third arm, not a
  new server concept.
- **New owning module is still justified, but by the line gate, not
  preference.** `mcp.ts` is 627 lines against a 700 **code**-line cap
  (`eslint-config/index.js:320`); a third scope and two tool records would
  press the gate. Per the whitepaper the legitimate response is a real named
  owner: member-messaging delegate/records in a new agent-module file that
  exports the same `teammate`-named delegate for its scope, reusing the
  shared tool/codec helpers. This is not exiling two helpers to duck under
  the gate; it is the third distinct scope the file's header already says it
  dispatches.
- **`send {name, prompt}` + `list`, concrete leader name, no pseudo-token.**
  The name registry is dispatcher-global across the dispatcher collection
  and every Team (`agent/store.ts:425-440`), so a leader name cannot collide
  with a member name and needs no reserved word; `list` returns one leader
  row plus self-excluded member rows. Reusing the established `name`/`prompt`
  field vocabulary matches the leader-facing `send` and the candidate
  catalog; a member `send` carries no `intent` (all three seats agree: peers
  must not rewrite the recovery subject).
- **Receipt copy is new**, deliberately: `TEAMMATE_DISPATCH_SUCCESS_REMINDER`
  promises a later pushed completion that a member sender never receives
  (`mcp.ts:238-240, 565-572`); the member receipt states admission-only,
  explicit-reply, and result-goes-to-TeamLeader.

### E. Provenance source name — keep a new source, marked non-blocking; reject envelope drift elsewhere

MiMo reuses `task` + a `from` attribute; DeepSeek and my round 1 introduce a
member-message source. Verified: no Channel or CoT code branches on the
source **name** (`feishu-channel/src/cot/adapter.ts` consumes
`teammate.input` content generically), so neither choice needs channel
changes. I retain a recommendation for a new open-vocabulary producer name
(`teammate-message`) because the social semantics differ from a task handoff
— conversational question, no pushed completion, reply by explicit send only
— and sources are explicitly where new Core producers name themselves
(`submission-sources.ts:1-15`). The `from` attribute is host-stamped in both
designs. This is a final-solution copy decision, not a correctness fork.

Rejected regardless of that fork: MiMo §5.4 stamping `from` on the **existing
leader/dispatcher** send handler. Existing `<task>` handoffs are settled
behavior; widening their envelope is outside the requirement and would
change every current leader-to-member turn. Stamp only the new member path.

### F. Failed-result report body — reject MiMo's error-text change

A bound failed completion currently reaches the leader as a header-only
notice: the fact carries `result: null` (`turn.ts:141-147`) and
`resolveCompletionBody` inlines the empty string
(`dreamux-utils/src/completion-body.ts:65-73`). MiMo §7.4 proposes putting
`error.message` in the body for both paths. Under the accepted unbound-only
contract there is no fold race forcing that change, and adding failure text
to all completion notices is a user-visible content change the requirement
does not make (Q1a asks for failure to be reported once, with owner-stop
suppression). The error is already visible on the member's CoT, `last`, and
recorded status. Revised: unbound failures use the identical fact shape
(status `failed`, `result: null`); richer failure bodies are a separate
operator-visible decision if wanted.

### G. Role-prompt sentence — reject MiMo's "now true, keep it"

MiMo §5.5 would keep "Your TeamLeader receives what you output when your turn
ends." It is still false after Q1: interrupted terminals deliver nothing;
push-back is `wake:false` and is dropped (`unsupported`) when the leader
runtime is not live (`service.ts:487-492, 711-731`); folding means "what you
output" in one turn can merge with others. The replacement must state the
observed-fact contract (completed/failed turn results are delivered
automatically; interrupted and stopped-leader cases are not; replies require
an explicit send), plus the two-tool catalog. MiMo's requirement to name the
leader concretely and identify the member's own name is accepted — `list`
and the prompt together provide addressing.

### H. Q3 gate: construction-time disarm is sufficient; my round-1 lock check is deleted

Round 1 suppressed observed results at delivery time using
`this.lockToken !== null` as well as omitting tools. Source shows that branch
can never fire on an armed entity: the lock is taken only inside
`createFreshEntity` during `createLocked` (`agent/index.ts:210-236, 227-231`);
an already-built ordinary entity has no path to acquire a lock later. A
second gate defending an impossible state is exactly the defensive machinery
the whitepaper bans. Revised: one gate — the ordinary-vs-locked construction
flag threaded from the two entry points (spawn/materialize/reopen arm;
`createLocked` disarms), as DeepSeek and MiMo both propose.

My round-1 post-unlock edge is also dissolved by source: a Workflow
**durably closes every locked member at run finalize** before unlocking
(`workflow-service/run.ts:701-707, 755-759`). There is no live unlocked
generation that could emit post-workflow unbound turns; anything observed
during teardown is stopped by close (`owesCompletion()` negative), and a
later peer send reopens the record through the ordinary armed path, which Q3
expressly allows. No lineage attribution state is needed.

### I. One Codex terminal nuance all three must honor

Codex observes an accepted interrupt as a normal `turn/completed` carrying
`status: "interrupted"` and `finalize` still builds a **completed**
`RuntimeCompletion` with partial text for bound submissions
(`turn-manager.ts:236-243, 300-333`). Q1 excludes *unbound interrupted* turns.
The unbound emission branch must therefore test the terminal status the way
`observeTerminal` already computes it (line 241-243): emit the completed
object only for a non-interrupted terminal; emit an `Error`-terminal failure;
skip interrupted. This matches the requirement's interruption boundary and
avoids claiming more than "provider-observed normal result".

## R2.3 Revised complete position (supersedes round 1 where they differ)

1. **Contract (`dreamux-types`).** Required
   `results: AgentRuntimeResultSink` on `AgentRuntimeCreateContext`, beside
   `activity`: synchronous, non-throwing, generation-leased. Semantics:
   emit once per provider-observed normal completed or failed **unbound**
   native terminal (one no `RuntimeSubmission` settled with); never on
   interrupted/teardown/unobserved endings; if a provider ever emits a result
   that also settles a submission it MUST be the same frozen
   `RuntimeCompletion` object (fold guard).
2. **Claude adapter.** In the `result` frame handler, build
   `completionFromTurnOutcome` for every non-interrupted frame (today it is
   built only for answered frames); settle answered requests exactly as now;
   when `answered.length === 0`, push that object to the sink. Interrupted
   frames settle `stopped` and emit nothing; discarded/refused commands and
   session close/exit emit nothing (no fabricated terminal).
3. **Codex adapter.** Extract one terminal→completion helper shared by
   `finalize` and the unbound queue-head branch; the unbound branch emits
   completed (non-interrupted) or failed (terminal `Error` / unscoped
   failure) through the sink before releasing the collector turn; skip
   interrupted; manager `stop()` and transport-death paths emit nothing.
4. **Core.** `RuntimeGeneration` gains the second leased closure
   (`generationResultSink`) and receives an observer callback in its
   constructor; create context carries `results`. `AgentService` gains
   `reportNativeResult(completion)`: armed owner present → check
   `owesCompletion()` → build the existing `TeammateCompletionFact`
   (same status/result discipline as bound facts, `result: null` on failure)
   → `deliverRuntime(team.completionRecipient(), completion, fact)` with a
   caught promise. Arming comes from one per-entity construction option
   supplied only by a Team collection for ordinary (non-locked) builds.
   `EntityTurn` is untouched; no new fact field, no shared-mapping extraction.
5. **Member surface.** `teammate` server, third scope `team_member`, built
   in a new agent-module file against the 700-line gate. Two tools:
   `send {name, prompt}` (concrete leader name from `list`, or a peer) and
   `list {}` (one leader row + self-excluded member rows). Envelope:
   host-stamped `from`, recommended new provenance source (final-solution
   choice), leader path = TeamService `submitInput` with no recipient, peer
   path = collection send with Team recipient, no `intent`, new
   admission-only receipt copy. Existing leader/dispatcher envelopes are not
   modified.
6. **Construction wiring.** `TeammateCollectionOptions` gains the MCP
   primitives it currently lacks (the Team collection is built without them
   today, `team/service.ts:208-221`) plus one leader-inbox port
   (`leaderName`, `submitToLeader`); dispatcher-root collection gets neither.
   `createLocked`'s `CreateLockedTeammateOptions` carries the explicit
   disarm flag; ordinary spawn/materialize/reopen arm. No persisted category.
7. **Wording.** Turn-fact status lines for all three role subjects; member
   prompt states the actual delivery contract and the two tools; Workflow
   line untouched; product catalog background-work bullet reversed for
   ordinary Team members; provider-runtime and architecture docs updated;
   `.agents/scripts/check.mjs` with the PR.
8. **Change/verification.** Ordinary `minor` notes on four packages; no
   `BREAKING:`, no state/config/maintenance change. Gates: build, lint,
   test, `typecheck:tests` (fixtures must adopt the required context field).
   Tests: decision matrix (unbound completed/failed once; interrupted,
   disarmed, dispatcher-scoped, leader, `owesCompletion`-negative, revoked
   generation, dissolving Team all silent; bound path unchanged); adapter
   reference-identity/guard tests; delegate scope/schema/envelope tests;
   both live gates with busy-behavior differences documented as observed,
   not asserted equal.

## R2.4 Remaining material trade-offs and unresolved facts

1. **Notification volume** remains the accepted product cost of Q1; no
   filter or aggregation is authorized or designed.
2. **Stopped-leader gap** is preserved, not fixed: automatic results remain
   live-runtime-only push-back; explicit member messages do wake the leader.
   The product entry must state the asymmetry.
3. **Provenance source name** (new `teammate-message` vs reused `task+from`)
   is the one genuine schema fork left for the final solution; behavior is
   identical either way.
4. **Real Codex unbound frequency** is a live-verification documentation
   item, not a contract contingency; the unscoped-failure emission
   (`onUnscopedFailure`) should be confirmed against a real protocol event
   during implementation rather than assumed.
5. **External/custom provider factories** (notably custom Claude session
   factories) need the sink discipline in package READMEs; noncompliance
   degrades to today's silence, never to duplicates under the unbound-only
   contract.

## R2.5 Blocker assessment

**No genuine blocker.** The requirement is implementable with the revised
shape above; every dispute resolved to an existing source fact. The
highest-risk element is cross-package discipline (provider emits exactly the
unbound result, never interrupted, with object identity when overlapping),
which is testable at the adapter boundary with reference-identity tests and
fake-runtime Core tests — a verification burden, not an open design
question.

---

# Requirement revision 2 — independent revised proposal

- Input: requirement revision 2 (Q4 generalizes the feature to
  Dispatcher-root ordinary members; acknowledged MCP/owner placement; new
  mixed bound/unbound ordering criterion). Revision 1 text and the round-2
  review above are superseded evidence and remain as history.
- Written without reading another seat's revision 2 proposal. Source
  rechecked in the current tree during this round; pointers are given.
- The engineering-whitepaper Section 0 test is applied to every addition:
  each new concept below has a producer, a consumer, and a named removal or
  stated requirement it is paid for by.

## V2.1 What revision 2 changes (relative to revision 1)

1. **Two owners, one capability.** The feature now serves ordinary members
   of both collections: a Team's members (owner: the TeamLeader through
   `TeamService`) and Dispatcher-root members (owner: the Dispatcher agent
   through `DispatcherService`). Cross-collection messaging is not granted.
2. **MCP home is settled:** the existing `teammate` server in
   `service/agent/mcp.ts` gains a third member scope (`send`/`list`); the
   real owner supplies a narrow structural messaging capability; the
   collection installs the delegate at entity construction. No second
   server.
3. **Mixed bound/unbound result order is an explicit acceptance criterion.**
   This is new evidence versus revision 1 and changes one of my round-2
   conclusions (see V2.6): the result sink must publish **every normal
   native result** (bound and unbound), synchronously in native terminal
   order, with bound `EntityTurn` delivery folding into it — not the
   unbound-only emission I converged on in revision 1.
4. **Arming is construction-time and owner-neutral:** both real owners
   supply the same bundle; the locked-Workflow build is the only disarmed
   construction (Workflow exists for both collections: Teams and the
   dispatcher-level `WorkflowService`, `dispatcher-service/index.ts:281-289`).

## V2.2 The shared capability, end to end

One owner-neutral member capability, composed at the two existing
composition roots:

```
MemberMessagingContext (built by the real owner, handed to its collection)
├── mcp: { leases, adminSocketPath }        # shim primitives members' launch needs
└── owner: MemberMessagingOwner             # the only owner-specific surface
      ├── ownerName: string                 # concrete addressing name
      ├── ownerKind: 'team_leader' | 'dispatcher'   # copy only (see V2.8)
      ├── submitToOwner(input): TurnAdmission      # fenced inbox, no recipient
      └── ownerStatus(): <compact status row>      # for list
```

- **Team composition:** `TeamService` already constructs the member
  collection (`team/service.ts:208-221`) and holds `deps.mcp`
  (`team/types.ts:54-56`). It additionally passes the MCP primitives and an
  owner adapter: `ownerName` = its record's `leader_name`,
  `submitToOwner` = its existing `submitInput` (which already runs
  `admitTeam` → `mustLeader().submitInput`, `team/service.ts:834-847`),
  `ownerStatus` = `admitTeam(() => mustLeader().status())`.
- **Dispatcher composition:** `DispatcherService` already constructs the
  root collection with `completionOwner: this.dispatcherAgent`
  (`dispatcher-service/index.ts:235-250`) and holds `opts.mcpLeases` +
  `adminSocket` (`index.ts:221`). It passes the same bundle shape with
  `ownerName = DISPATCHER_AGENT_NAME` (`agent/identity.ts:17`),
  `submitToOwner = this.submitToAgent` — already a fenced owner-inbox entry
  whose input type structurally omits `completionRecipient`
  (`index.ts:352-359`) — and an `ownerStatus` over
  `dispatcherAgent.mustAgent().status()` inside `this.fence.admit`.

The owner adapter is four narrow members. That is the *entire*
owner-specific surface: no Team/Dispatcher branch exists in the MCP module,
the collection peer path, the result observer, the renderer, the router, or
either provider. The branches that remain (owner naming/copy and the inbox
fence each owner already owns) follow from genuinely different
responsibilities named in Q4, not from copied policies.

### End-to-end flows (identical mechanics, both scopes)

1. **Member → owner, mid-turn.** Member M calls `send {name:<ownerName>,
   prompt}`. The member delegate (host-bound `self=M`) matches the owner
   name against `owner.ownerName` and calls `owner.submitToOwner({source:
   MEMBER_MESSAGE_SOURCE, attrs:{from:M}, text:prompt})`. The owner runtime
   starts if idle (`submitInput`, `wake:true`); busy input uses the
   runtime's own reception behavior. No `completionRecipient` is attached,
   so the owner's processing turn can never synthesize a reply to M. The
   tool returns the mapped admission receipt immediately.
2. **Peer exchange, across turns and across closure.** M calls
   `send {name:N, prompt}`; the delegate rejects `N === M` and unknown
   names, then calls the collection's peer send, which is the existing
   resolve → (`sendReopened`/`reopenFrom` for a closed N, Q2) →
   `sendResolved` path, with the member-message envelope. The recipient
   stays the collection owner (the collection already stamps
   `opts.completionOwner.completionRecipient()`, `agent/index.ts:318`), so
   N's turn result automatically reports to the owner, never to M. N
   answers with its own `send {name:M}`, an ordinary fresh input that
   works after M's turn ended.
3. **Background results.** Every normal native result N's provider observes
   is published on the generation-leased result sink in native terminal
   order; an armed N's observer delivers it once to the owner through the
   existing completion router. M's explicit messages never appear in those
   reports; only turn results do.
4. **Workflow-controlled members.** `createLocked` builds with the bundle
   omitted: no member server is minted for that generation and the result
   observer is not armed. Script results keep flowing through
   `admission.turn.settled` (`workflow-service/run.ts:583-586`); ordinary
   peer input keeps hitting the existing `enterOrdinaryMutation` refusal;
   the run still closes its members before unlock (`run.ts:701-707,
   755-759`), so a later peer send reaches an armed ordinary reopen — no
   lineage state needed.

## V2.3 Public/MCP contract (in `service/agent/mcp.ts`)

- `TeamMateMcpScope` gains a third arm, structurally:

  ```ts
  | { readonly kind: 'member'; readonly member: TeamMateMcpMemberScope }

  interface TeamMateMcpMemberScope {
    readonly self: string;                 // entity name, bound at construction
    readonly owner: MemberMessagingOwner;  // V2.2
    peers(input: { name: string; prompt: string }): Promise<AgentEntitySendResult>;
  }
  ```

  The collection-tier file imports no Team or Dispatcher service; the owner
  is structural, exactly as the dispatcher/team_leader scopes already are
  (`mcp.ts:79-101`).
- **Catalog: exactly two tools on the existing `teammate` server.**
  - `send {name: string 1..64, prompt: string 1..20000}` — no `intent` (a
    peer must not rewrite the target's recovery subject; all three
    revision-1 seats agreed). Owner name routes to `submitToOwner`; any
    other name goes to `peers`. Self-address is a caller mistake
    (`RuleViolation`).
  - `list {}` — `{owner:{name,status}, teammates:[…self-excluded compact
    rows]}`; rows reuse the existing `TeammateOps.list()` projection. This
    is the entire addressing story; the dispatcher-global name registry
    already makes owner and member names unique in one namespace
    (`agent/store.ts:425-440`), so there is no reserved pseudo-name.
- The member catalog advertises no spawn/close/history/status/last/
  capabilities/workflow verbs; authorization stays "frozen catalog per
  generation lease" (existing MCP discipline).
- **Receipt:** the admission projection (`toSubmissionResult`) plus the
  target name. New receipt copy, deliberately: `TEAMMATE_DISPATCH_SUCCESS_REMINDER`
  promises a pushed completion the member sender never receives
  (`mcp.ts:238-240, 565-572`); member copy states admission-only, that a
  reply arrives only by explicit `send`, and that the recipient's turn
  results report to the owner.
- The scope arm and its tool records live in a named sibling module
  (e.g. `service/agent/member-messaging.ts`) imported and assembled by
  `createTeamMateMcpDelegate` in `mcp.ts`. Reason: `mcp.ts` is at 627 lines
  against the 700 code-line gate; the whitepaper permits a new file when it
  is a real named owner (the third scope), while server assembly and the
  `teammate` name stay home in `mcp.ts`, honoring the acknowledged
  placement.

## V2.4 Reused, new, removed

**Reused unchanged (no second mechanism):** the one admitted-input
operation (`submitInput`/`submitAdmitted`, ledger, renderer, display event,
`wake` flag), the reopen flow and its in-flight join, `CompletionOwner`/
`CompletionInitiator`, `CompletionDeliveryPolicy` (token WeakMap, per-owner
FIFO tail, retry/drop, dispatcher fence), `owesCompletion()`, Team and
Dispatcher work fences, the Workflow lock and locked-submit path, MCP
mint/lease/frozen-catalog machinery, and the existing completion push-back
path (`prepareCompletion`/`submitCompletionInput`, `wake:false`).

**New — each with producer and consumer:**

1. `AgentRuntimeCreateContext.results: AgentRuntimeResultSink` (required
   field, like `state`/`activity`; emission discipline in V2.5). Producer:
   each in-tree adapter; consumer: the one Core result observer.
2. One leased closure in `RuntimeGeneration` (`generationResultSink`,
   beside `generationActivitySink`, `runtime-generation.ts:295-325`) and
   one observer collaborator passed into its constructor; the create
   context carries `results`.
3. One `AgentService.observeNativeResult(completion)` — the armed
   owner-neutral decision point (V2.7).
4. One per-entity construction bundle on `TeammateCollectionOptions`
   (MCP primitives + owner adapter), consumed by `teammateOptions` for
   ordinary builds in both collections and omitted for `createLocked`.
   Arming travels through the existing
   `CreateLockedTeammateOptions`/`teammateOptions` path the Workflow caller
   already uses (`agent/index.ts:227-231, 730-733`): the locked caller
   leaves messaging unset, so no new disarm flag is needed.
5. One collection peer entry carrying the member envelope through the
   existing resolve/reopen/send internals (a small envelope extension on
   the collection-internal send input rather than a copied send path).
6. One provenance source constant `MEMBER_MESSAGE_SOURCE =
   'member-message'` in `submission-sources.ts`, with host-stamped
   `attrs.from`.
7. The third MCP scope, two tools, one receipt text, owner-neutral member
   prompt copy, and turn-fact notification copy.

**Removed:** nothing user-visible. One invariant comment is revised
knowingly: `service-types.ts:104-107` ("an ordinary TeamMate has no
Agent-facing tool surface of its own") becomes "ordinary members of an
owning collection have exactly one narrow surface: owner/peer messaging;
locked Workflow builds have none". The revision-1 idea of a separate
`team-member` server is removed (the acknowledged placement supersedes it).

## V2.5 Provider result contract and terminal paths

Neutral contract in `dreamux-types/src/agent-runtime.ts`:

```ts
/** Synchronous, non-throwing, non-backpressuring, generation-leased. */
export interface AgentRuntimeResultSink { (completion: RuntimeCompletion): void }
// AgentRuntimeCreateContext: readonly results: AgentRuntimeResultSink;
```

Emission rule, identical for both adapters:

- **emit once, synchronously, at every normal native terminal** — completed
  or provider-proven failed — whether or not Dreamux submissions settled
  with it;
- the emitted object **is** the frozen `RuntimeCompletion` handed to settled
  submissions for that same terminal (reference identity is the fold key);
- **never** emit for an interrupted terminal, teardown, transport loss
  without an observed terminal, or a request-scoped pre-admission refusal;
- emit in native terminal order, synchronously inside the terminal
  observation (ordering rationale in V2.6).

**Claude Code** (`claude-code/src/rpc.ts` result frame, lines 276-330):
build `completionFromTurnOutcome` for every non-interrupted frame (today it
is built only for answered frames, `rpc.ts:307-314`); invoke
`options.results(completion)` before the answered-request settle loop; keep
settling answered requests with the same object; interrupted frames settle
`stopped` and emit nothing; `discarded/refused` command lifecycle events
emit nothing; session `stop`/`close` and unexpected child exit fabricate
nothing. Threading follows `activitySink` exactly
(`provider.ts:79` → runtime deps → `createDefaultClaudeCodeSession`
options, `runtime.ts:352-369`).

**Codex** (`codex/src/turn-manager.ts`): extract the terminal→completion
construction currently inlined in `finalize` (`turn-manager.ts:310-333`,
including the codec-restore failure arm) into one helper used by both
terminal branches. In `drainTerminalOrder` (lines 280-298): for the unbound
queue head, emit non-interrupted completions (a terminal `Error` → failed;
unscoped collector failure via `failProtocol`/`failRecord`,
lines 342-369, emits the failed completion for the records it iterates,
including representative-null ones); for the bound head, emit the same
frozen `record.completion` through the sink **before** `finalize` settles
members. An accepted interrupt (`turn/completed` with
`status:"interrupted"`, classified at lines 241-243) emits nothing even
though bound submissions still settle their existing partial-text
completion — that existing settlement behavior is out of scope and
unchanged. Manager `stop()` (lines 104-119) emits nothing. Threading:
`provider.ts:130` → `CodexRuntime` deps → `TurnManagerOptions`
(`runtime.ts:274-283`).

## V2.6 Mixed bound/unbound ordering and delivery convergence

This is the requirement's new hard criterion, and it is what revises my
revision-1 unbound-only conclusion. The facts:

- Claude's parser processes every buffered line synchronously in one
  `onStdoutChunk → onLine` loop (`rpc.ts:135-141`); bound delivery does not
  run there — `request.settle` only resolves a promise, and
  `EntityTurn.startDeliveryIfReady` runs on a later microtask
  (`turn.ts:71-92, 127-152`). An unbound result observed on a later line can
  therefore reach the router *before* an earlier line's bound result unless
  the sink itself publishes in terminal order.
- `deliverRuntime` → `enqueue` is itself synchronous through the
  per-recipient tail insertion (`completion-router/index.ts:137-158`); the
  router's FIFO orders arrivals, but arrivals are exactly the problem the
  requirement names — citing FIFO after arrival is explicitly insufficient.

Design consequence: **the sink is the single ordered publication of native
results**, emitted synchronously per terminal in both adapters (Claude:
frame loop; Codex: the existing `terminalOrder` queue,
`turn-manager.ts:280-298`). Bound `EntityTurn` deliveries are not removed —
non-armed roles (TeamLeader, Dispatcher agent, locked builds) and external
providers that ignore the new sink keep today's behavior exactly — but for
an armed member they always lose the WeakMap fold to the sink's
already-enqueued delivery (`completion-router/index.ts:140-145`), so they
can neither duplicate nor reorder. To make folding payload-independent, the
`RuntimeCompletion → TeammateCompletionFact` mapping currently inline in
`EntityTurn` (`turn.ts:141-147`) is extracted into one pure helper used by
both paths; the failed fact stays header-only (`result: null`) as today —
the revision-1 idea of adding error text to bodies is not taken (no
requirement changes failure content).

Resulting delivery order, per owner recipient:

1. normal completed/failed native results: strictly native terminal order
   for results observed within one synchronous drain, across bound and
   unbound; the sink enqueues before any settlement microtask can;
2. N submissions folded into one native result: one delivery (sink token);
3. non-native outcomes (bound `stopped`, transport `failed` settlements that
   carry no `RuntimeCompletion`): remain `EntityTurn`-only and arrive via
   continuation; they cannot precede a *later* native result in the same
   live session because the transport death that produces them ends the
   session (Claude `close`, `rpc.ts:153-185`; Codex `failProtocol`), and an
   interruption has no subsequent synchronous result frame behind it;
4. generation replacement: late sink writes are dropped by the lease;
5. owner/teardown fences behave exactly as today (dispatcher fence in the
   router; Team `prepareCompletion` → `unsupported` on dissolve;
   `owesCompletion()` read in the observer).

Convergence waits are unchanged: entity close still converges retained
`EntityTurn` deliveries (`service.ts:368-380`); sink deliveries ride the
router's own tail with the existing best-effort/drop contract — Q1 added no
durable-delivery promise. There is deliberately **no** new close wait for
unbound reports: a member's own close makes `owesCompletion()` negative and
suppresses them; owner teardown refuses preparation; shutdown drops at the
dispatcher fence.

## V2.7 Core observer, arming, and owner-stop

`AgentService` gains one service option carrying the armed owner:
`nativeResultOwner?: CompletionOwner`, supplied in the same construction
bundle that installs the messaging delegate (one capability, one arming
decision — two flags would be a parameter with one value). The
`TeammateCollection` already holds a `CompletionOwner` for both scopes
(`agent/index.ts:96-97`), so the collection passes its existing owner when
the bundle is present and the build is ordinary.

`observeNativeResult(completion)`:

1. option absent (TeamLeader, Dispatcher agent, locked Workflow build) →
   return immediately;
2. `!this.owesCompletion()` → return (owner close/host stop/service stop;
   the same read `EntityTurn` uses, `service.ts:391-394`);
3. fact from the shared mapper (entity name, role `teammate`, completion
   status, result);
4. `void this.deps.completionDelivery
   .deliverRuntime(this.nativeResultOwner.completionRecipient(), completion,
   fact).catch(() => undefined)`.

`RuntimeGeneration` registers the leased closure exactly like the activity
sink: generation check, then observer call; a revoked generation's result is
dropped and logged, never thrown back into the provider. No new persisted
state, phase, idempotency ledger, generation counter, or mailbox.

## V2.8 Owner-specific differences (exhaustive)

| Difference | Team owner | Dispatcher-root owner | Why it is real |
| --- | --- | --- | --- |
| Inbox entry | `TeamService.submitInput` (Team fence → leader) | `DispatcherService.submitToAgent` (dispatcher fence → dispatcher agent) | each owner already owns its admission fence and conversational agent |
| Roster owner row | record `leader_name` + leader status | `dispatcher` + dispatcher agent status | different actor; names already share the global registry |
| Prompt copy | Team id, "TeamLeader `<name>`" | dispatcher id, "Dispatcher agent `<name>`" | membership sentence today already keys on `team_id` (`system-prompt.ts:26-34`); dispatcher members currently get no sentence and gain one |
| Completion recipient | `TeamService` itself | `DispatcherAgent` | existing `CompletionOwner` wiring, unchanged |

Everything else — envelope, tools, schemas, receipt, sink, observer,
fold/order, reopen, lock, fences, renderer — is one implementation. The
dispatcher keeps its Team management surface (`team` server, collection
construction) untouched; no service merger, inheritance, or new routing
entity is introduced (Q4 prescribes neither).

## V2.9 Wording

- `completion-renderer.ts:52-57`: completed → turn-result fact (e.g.
  "TeamMate X produced a turn result."), failed/stopped → "turn failed." /
  "turn was stopped.", across all three role subjects (the same renderer
  serves dispatcher/leader/member completions). Workflow line untouched.
- `system-prompt.ts`: armed ordinary members get one owner-neutral contract
  sentence parameterized by V2.8's owner facts: which collection they
  belong to, the concrete owner name, that every normally completed/failed
  turn result is delivered automatically (interrupted turns and an
  unavailable owner are not), that explicit messages admit without a reply,
  and that replies arrive only by explicit `send`. The operation-append gate
  (sentence omitted when a Workflow append is present) is preserved; locked
  builds are disarmed structurally anyway.

## V2.10 Contracts, compatibility, change accounting

- `results` is a **required** create-context field but non-emitting use is
  legal (documented like activity's optional-emission discipline,
  `agent-runtime.ts:16-18`): older external providers ignore the extra
  context member and keep today's bound-only behavior — armed members then
  get bound reports via `EntityTurn` and silent unbound turns, never
  duplicates. Fake/fixture runtimes in-tree adopt the field (covered by
  `typecheck:tests`). No persisted state, config, or path change; no
  `BREAKING:`/`Rebuild:`; ordinary `minor` notes for `dreamux-types`,
  `dreamux`, and both runtime packages. Channel packages need no change:
  the CoT projection does not branch on provenance names
  (`feishu-channel/src/cot/adapter.ts` consumes `teammate.input` content
  generically).
- The member MCP server is additive for armed ordinary members; other
  launches' server sets are unchanged.

## V2.11 Verification mapping

- **Ordering (new load-bearing suite).** Fake/recording initiator; one
  Claude stream chunk containing multiple `result` lines in each order
  (bound-then-unbound, unbound-then-bound, plus a third bound) → observed
  delivery order equals frame order, exactly one delivery per native result,
  and the bound `EntityTurn` delivery folds (no second prepare/submit).
  Codex: drive `terminalOrder` with mixed representative/null heads and
  assert sink calls precede member settlement in queue order. Assert
  interrupted heads emit nothing; assert a revoked-generation sink write is
  dropped.
- **Both scopes symmetrically.** Dispatcher-root members: owner routing to
  the dispatcher agent (no recipient attached), peer exchange and
  close-reopen inside the root collection, unbound result delivery to the
  dispatcher agent, dispatcher fence drop on shutdown, root-level
  Workflow-locked build disarmed. Team suite covers the same against the
  Team fence and leader.
- Cross-collection addressing is structurally unrepresentable: delegate
  tests for self/unknown/owner-name resolution and schema refusal; no
  surface takes a collection/team argument.
- Existing load-bearing suites extended, not weakened: completion folding,
  owner-stop suppression, Workflow lock, reopen in-flight join, busy-input
  behavior per runtime (documented from observed Codex-steer/Claude-queue
  behavior, never asserted equal). Live gates for both runtimes, with
  `DREAMUX_SKIP_LIVE_CODEX=1` discipline; Codex unbound frequency and
  unscoped-failure emission recorded from observation, not assumed.
- Four gates: build, lint, test, `typecheck:tests`.

## V2.12 Risks and genuinely unresolved decisions

1. **Emit-all revises my own revision-1 adjudication, knowingly.** The
   revision-1 objection (two observers, payload drift) is answered by the
   shared fact mapper plus reference-identity fold; revision 2's explicit
   ordering criterion is the changed evidence that makes ordered sink
   publication necessary. Residual cost is one extracted mapper and an
   EntityTurn touch that must preserve the locked owner-stop tests verbatim;
   there is no extra owner wake, because the folded second call joins before
   preparation.
2. **Notification volume** stays the accepted Q1 cost; no filter,
   quiet-point, or aggregation is designed (no producer exists).
3. **Owner-unavailable asymmetry** is preserved and must be documented:
   automatic results remain live-runtime-only push-back (`wake:false`,
   `unsupported` drop); explicit member messages wake the owner.
4. **Provenance name** (`member-message` vs reusing `task`+`from`) is the
   one public-contract choice left for final reconciliation; behavior is
   identical and current channels do not branch on it. I recommend the new
   open-vocabulary producer because these are conversational messages, not
   task handoffs (`submission-sources.ts:30-38`).
5. **External/custom Claude session factories** must call the sink for full
   coverage; package README states the identity/order discipline.
   Non-compliance degrades to today's silence for unbound results — never a
   duplicate.
6. **Codex unbound frequency** and the real protocol shape reaching
   `onUnscopedFailure` remain live-verification documentation items, not
   contract contingencies.
7. **No genuine blocker:** every requirement behavior maps to an existing
   owner or one named addition; the riskiest element remains cross-package
   sink discipline (one object, terminal order, never interrupted), which
   the ordering suite makes falsifiable.

---

# Requirement revision 2 — cross-review and revised position

- Round: the single authorized cross-review of the three revision-2
  proposals (`deepseek.md` R2.1–R2.14, `mimo.md` §2.1–2.15, my V2.1–V2.12).
  Adjudication is against current owning source and requirement revision 2;
  no historical TeamLeader adjudication is treated as authority.
- Class labels: **[code fact]** verified in source this round;
  **[operator decision]** recorded in requirement revision 2;
  **[design inference]** a proposal-level choice.

## CR2.1 Agreements (all three seats, independently converged)

1. **Sink emits every completion-bearing native terminal, synchronously in
   terminal order; bound `EntityTurn` delivery folds into it.** All three
   revision-2 proposals withdrew revision 1's unbound-only emission. The
   shared evidence: Claude parses a chunk's `result` lines synchronously
   (`claude-code/src/rpc.ts:135-141, 276-330`) while bound delivery runs on
   the `settled` promise continuation (`agent/turn.ts:71-92, 127-152`);
   `CompletionDeliveryPolicy.enqueue` tail insertion is synchronous
   (`completion-router/index.ts:137-158`). One synchronous publication per
   terminal is therefore the only ordering authority; the token WeakMap
   (`completion-router/index.ts:140-145`) plus one extracted
   completion→fact mapper makes the later continuation a fold. **[code
   fact + operator decision: revision-2 ordering criterion]**
2. **Required `results` field on `AgentRuntimeCreateContext`**, non-emitting
   use legal (house pattern of `state`/`activity`,
   `dreamux-types/src/agent-runtime.ts:16-18, 300-303`).
3. **Third scope on the existing `teammate` server, two tools, host-bound
   sender, owner inbox without `completionRecipient`, peer path through the
   existing collection send/reopen; structural owner port; no concrete
   service import in the agent tier** [operator decision: acknowledged
   placement; code fact: both inboxes already exist
   (`team/service.ts:834-847`, `dispatcher-service/index.ts:352-359`)].
4. **One construction-time Q3 gate**; shared mapper keeps failed notices
   header-only (`result: null`); ordinary `minor` notes, no state/config
   change; no service merger (Q4 prescribes none).

## CR2.2 Adjudicated disagreements

### A. Owner name must be lazily read — accept DeepSeek; MiMo's static field is a defect [code fact]

A Team's `TeammateCollection` is constructed in the `TeamService`
constructor (`team/service.ts:208-221`) before `createNew` allocates
`leader_name` and writes the record (`team/service.ts:271-296`). A bundle
capturing a static `ownerName` string at collection construction
(mimo.md §2.4 `readonly ownerName: string`) would capture nothing. The port
must expose `ownerName()`/a getter (deepseek.md R2.4.1); the delegate is
built later in `teammateOptions`, where reading it is valid. My V2.2
plain-value member has the same defect and is revised to an accessor.

### B. Port is required on the collection; disarm needs an explicit construction-kind signal — accept MiMo + DeepSeek; my V2.4.4 is wrong [code fact]

Exactly two production constructors of `TeammateCollection` exist
(`team/service.ts:208`, `dispatcher-service/index.ts:235`), and Q4 requires
both to arm [operator decision]; a nullable bundle therefore adds a third
state with no producer. **Revised:** the owner port (and MCP primitives)
are required collection options. But per-build arming cannot be inferred
from `CreateLockedTeammateOptions` shape: `spawnAdmitted` calls
`createFreshEntity(input)` with default `{}`, the reopen/materialize paths
also build ordinary entities, and only `createLocked` passes real options
(`agent/index.ts:189-236, 647-752, 796-808`; `workflow-service/run.ts:472-489`).
DeepSeek's explicit construction-kind parameter threaded from the two
entry-point families is therefore necessary; my V2.4 claim ("leave
messaging unset, no new field") would disarm ordinary spawns too. Revised:
one explicit ordinary-vs-locked signal at `createFreshEntity`; locked builds
omit both the delegate and the entity's `nativeResultOwner` option.

### C. Codex unscoped connection failure must NOT be sink-emitted — reject DeepSeek R2.6.2 and correct my V2.5 [code fact + operator decision]

`onUnscopedFailure` is documented and fired only for a fatal `error`
notification **without a `turnId`** — "a connection-level protocol failure
rather than one turn's failure" — and it closes the collector
(`codex/src/events.ts:54-60, 129-143`). It is not a provider-observed native
turn terminal. Q1a expressly forbids fabricating "a terminal result for
background work the runtime did not observe ending." Therefore:

- sink emission for unbound turns lives only in
  `drainTerminalOrder`'s release head, carrying the observed terminal
  (`turn-manager.ts:280-298`), and for bound heads in `finalize`
  (`turn-manager.ts:300-340`);
- `failProtocol`/`failRecord` (`turn-manager.ts:342-369`) emit nothing to
  the sink. Bound asks there keep their existing `failed` settlement →
  `EntityTurn` reports the failure of the asked work (correct today);
  representative-null records caught by the connection death had no
  observed ending and stay silent.

DeepSeek's "plus `failRecord` for unscoped failures" (R2.6.2) is rejected;
my V2.5 sentence saying the same for "representative-null ones" is
withdrawn. MiMo §2.7 has this right. The live-verification note about
`onUnscopedFailure`'s real protocol shape remains, but the *design* answer
is no emission regardless.

### D. Ordering: accept MiMo's named residual; my V2.6 claim 3 was too strong [code fact]

The synchronous-order guarantee covers **completion-bearing** terminals
only. Settlements without a `RuntimeCompletion` — interrupted frames
settling `stopped` (Claude `rpc.ts:297-329`), transport-death `failed`
settlements (`rpc.ts:153-185`) — still travel promise continuations. In
one parse batch, an interrupted frame followed by a completed unbound frame
can therefore deliver the unbound completion report before the earlier
turn's stopped notice. My V2.6 item 3 asserted that "cannot precede"; that
holds for session-ending transport death (the `close` case), not for
interruption-then-completion. Revised position: the residual is pre-existing
reporting behavior outside Q1/Q1a's result contract (interruption coverage
is explicitly unchanged), its within-class order is preserved, and closing
it would need either microtask-hop coupling or a seam sequence number —
neither has a named requirement. It is documented, not solved; widening it
is a new requirement question. MiMo §2.8 states this correctly.

### E. Provenance: accept `task` + host-stamped `from`; withdraw my new source constant [design inference, settled against source]

My V2 recommendation of a new `member-message` source is withdrawn on the
source's own definition: `AGENT_TASK_SOURCE` is documented as "Work an Agent
handed to another Agent: an MCP spawn or submit …" — member-to-owner and
member-to-member messages are exactly that category
(`submission-sources.ts:30-34`). The sender fact already rides
`attrs.from`, the renderer validates but never branches
(`agent/submission.ts:95-110`), and no channel/CoT code branches on source
names (`feishu-channel/src/cot/adapter.ts` consumes `teammate.input`
generically). A new root tag would add one concept whose entire
information is the `from` attribute — DeepSeek R2.13's "one bit" objection
holds. **Revised:** member sends submit `{source: AGENT_TASK_SOURCE,
attrs:{from:self}}`; `SendTeamMateInput` gains optional `source/attrs`
(defaulted in the collection, so the one verb serves both owner tools and
the member delegate, no wrapper). The three envelope forms a member can
receive are then fully distinguishable and documented in its prompt:
`task-notification` = automated completion, `<task from="X">` = peer
message, plain `<task>` = owner dispatch.

### F. DeepSeek's claimed blocker — stamping `from` on existing owner→member sends — is rejected [operator decision + code fact]

DeepSeek R2.12.1/R2.14 calls this the one genuine product blocker. I
disagree, on the recorded scope: Q4 says the owner's "existing role, tools,
and submission obligations remain" and requires preserving existing
user-visible channel contracts; the confirmed sender-binding rule binds
"the actual calling member" of the **new** member send. Changing every
shipped leader/dispatcher `<task>` envelope is an unrequested
behavior change to existing sends (`spawn`'s prompt and `send` today carry
no `from`). The feature is not materially weaker without it: the envelope
trio in CR2.2-E already lets a member tell owner mail from peer mail, and
the owner's concrete name is in its roster/prompt. **Revised position:**
owner dispatch envelopes stay byte-for-byte as shipped; uniform `from`
stamping is, at most, an explicitly named optional product question for
the operator — not a design dependency and not a blocker. It must not
silently ride the implementation.

### G. Tool vocabulary: `send {name, prompt}` + `list`, not `{to, message}` [design inference]

DeepSeek alone uses `to`/`message`; MiMo and I use `name`/`prompt`, which
are the existing `teammate.send` field names (`agent/mcp.ts:258-281`).
Reusing them adds no vocabulary for models migrating between the member
and leader catalogs and matches the acknowledged "member `send`/`list`
surface." Roster output shape (`{owner, peers}` vs flat `{kind}` rows) and
the scope-kind literal (`member` vs `team_member`) are immaterial final
details; either satisfies the contract. The member catalog is assembled in
a named sibling module because `mcp.ts` sits at 627 lines against the
700-code-line gate (`eslint-config/index.js:320`); the `teammate` server
assembly stays in `mcp.ts`.

### H. One shared behavioral nuance all three must record: suppression read moves to terminal observation [design inference from code]

Because the sink enqueues synchronously at the native terminal while
`EntityTurn` reads `owesCompletion()` later on its continuation, an owner
stop landing *after* the terminal but *before* settlement microtask no
longer suppresses that bound report (today it would; `turn.ts:127-138`).
This is not a violation: the turn had already ended normally before the
stop, "a delivery that already started is never retracted" is existing
policy, and a stop before terminal observation is still caught
synchronously by the observer's gate, with the dispatcher fence and the
owner's `prepareCompletion → unsupported` behind it. The suppression
boundary is phrased "work that ended because the owner ended it," decided
at terminal observation. Final solution should pin this with a test (stop
between terminal and settlement → report delivered; stop before terminal
→ silent) and say so in the product entry rather than discovering it in
review.

## CR2.3 Revised complete position

1. **Owner port (required collection option):**
   `MemberMessagingOwner { ownerName(): string; ownerLabel(): string;
   ownerStatus(): Promise<compact row>; submitToOwner(input:
   Omit<TeammateSubmitInput,'completionRecipient'>): Promise<TurnAdmission> }`,
   produced by `TeamService` (lazy `mustRecord().leader_name`,
   `this.submitInput`, Team fence) and `DispatcherService`
   (`DISPATCHER_AGENT_NAME`, `this.submitToAgent`, dispatcher fence).
   MCP primitives (`leases`, `adminSocketPath`) likewise become required
   inputs of both collections' construction.
2. **MCP surface:** third scope on the `teammate` server,
   `send {name, prompt}` (no `intent`, self/unknown refused, owner name
   routes to the port, everything else to the collection) and `list`
   (owner row + self-excluded member rows); new admission-only receipt
   copy; sibling module for the scope's records under the 700-line gate;
   owner dispatch envelopes unchanged (CR2.2-F).
3. **Arming:** explicit ordinary-vs-locked construction signal through
   `createFreshEntity`/`teammateOptions`; ordinary builds in both
   collections get the delegate and `nativeResultOwner` (= the
   collection's existing `completionOwner`); `createLocked` builds get
   neither. No persisted category; post-Workflow reopen is ordinary and
   armed (run closes its members before unlock, `workflow-service/run.ts:701-707,
   755-759`).
4. **Runtime contract:** required `results: AgentRuntimeResultSink`;
   synchronous, non-throwing, generation-leased; one frozen
   `RuntimeCompletion` per normal completed/failed terminal, identical to
   the settlement object; never on interrupted terminals, discarded
   commands, manager `stop()`, unscoped connection failure, or unobserved
   endings. Claude emits in the `result` frame before settling requests;
   Codex emits at the two terminal heads (`finalize`, unbound release)
   via one extracted `completionFromTerminal` helper.
5. **Core:** leased closure in `RuntimeGeneration`;
   `AgentService.observeNativeResult` gates (armed → `owesCompletion()` at
   terminal time → shared fact mapper → `deliverRuntime` on the existing
   owner recipient); extracted completion→fact mapper shared with
   `EntityTurn` (failed stays `result: null`); `EntityTurn` remains the
   sole reporter of completion-less stopped/transport-failed settlements;
   no new persistence, no close wait for sink deliveries, no sequence
   field.
6. **Owner differences are exactly:** inbox entry, lazy owner name/status,
   one prompt role word. Zero `if (ownerKind)` in shared paths; no service
   merger.
7. **Wording/docs:** turn-fact status lines across all role subjects;
   owner-neutral member prompt describing the two tools, the automatic
   turn-result contract (including interrupted/owner-unavailable
   exceptions), and the three envelope forms; product catalog reverses the
   background-silence bullet for ordinary members of **both** owners and
   states the stopped-owner push-back asymmetry; provider-runtime and
   service docs; `.agents/scripts/check.mjs`; ordinary `minor` notes on
   four packages; no `BREAKING:`.

## CR2.4 Material disagreements remaining after adjudication

| Point | DeepSeek | MiMo | Trae Seed (revised) | Status for final reconciliation |
| --- | --- | --- | --- | --- |
| Provenance root | `task` | `task` | **`task`** (withdrew new source) | resolved |
| Owner→member `from` stamp | proposes, flags as operator blocker | unchanged owner envelopes | unchanged; optional product question at most | genuine product question, not a technical blocker — surface to operator only if the final solution wants uniformity |
| Owner name shape | lazy function | static string (defect vs construction order) | lazy accessor | resolved by source (A) |
| Unscoped codex failure | sink-emits (rejected) | emits nothing | emits nothing | resolved by source (C) |
| Stopped-settlement ordering residual | not analyzed | named, out of contract | named, out of contract | resolved; documented residual |
| Roster output / scope literal | nested / `member` | flat / `team_member` | nested / `member` | immaterial |
| Failure body text | keep null | keep null | keep null | resolved |

## CR2.5 Verification burden (incremental consensus)

- Parser-level ordering tests feeding multiple Claude `result` lines in one
  synchronous batch (both orders, plus folded submissions): delivery order
  equals frame order, one prepare/submit per token; reference-identity
  assertion between sink and settled completion in each adapter; codex
  mixed-bound/unbound `terminalOrder` test asserting sink precedes
  settlement; interrupted/unscoped/`stop()` silence tests; the CR2.2-H
  stop-vs-terminal race pair.
- Both scopes symmetrically: owner routing without recipient, peer
  exchange and Q2 reopen, unbound completed/failed delivery to owner,
  teardown-fence drop, root-level and Team-level locked builds disarmed;
  cross-collection names structurally unresolvable.
- Existing load-bearing suites (fold, owner-stop, Workflow lock, reopen
  in-flight join) extended, never rewritten; both live gates with busy
  differences documented as observed; four Rush gates including
  `typecheck:tests` (fixtures adopt the required context field and the
  required collection port).

## CR2.6 Blocker assessment

**No genuine blocker.** The feature is fully specified from existing
owners plus three named additions (one context sink, one leased closure/
observer, one MCP scope + owner port). The only item any seat called a
blocker (uniform owner-envelope `from` stamping) is an unrequested change
to a shipped envelope, is technically unnecessary given the envelope trio,
and belongs to the operator only if uniform stamping is wanted as
product behavior. The load-bearing risk is cross-package sink discipline
(one object, terminal order, observed terminals only, never interrupted);
it is falsifiable by the ordering/identity suites rather than by
inspection.

---

# Neutral runtime interface reassessment — independent proposal

- Authority: [interface-reassessment.md](../interface-reassessment.md)
  (operator hold after delivery; quoted care requirement: *"任何中立
  interface 的变更都要慎重"* — every neutral-interface change needs
  caution; the phrase is retained verbatim and is not stretched into a
  ruling against any specific shape). Product behavior stays requirement
  revision 2: passive normal/failed native-result coverage is not removed.
- Evidence basis: baseline read with `git show HEAD:<path>` (pre-feature
  `next` at `the #473 baseline`) and the delivered worktree implementation read
  separately. Neither is treated as the answer; the delivered sink is the
  candidate under challenge.
- Independent round: other seats' reassessment sections were not read.

## N.1 What the delivered candidate changes on the neutral seam

**Baseline contract facts [code fact, HEAD].**

- A provider receives one inbound surface (`submit`, text-only) and emits
  runtime facts through exactly two leased push channels on
  `AgentRuntimeCreateContext`: required `state` (lifecycle/session) and
  required `activity` (display vocabulary). The handle contract states
  "Nothing is pulled from it: every runtime fact flows out through the
  leased state and activity sinks"
  (`dreamux-types/src/agent-runtime.ts` HEAD, `AgentRuntime` comment).
- Answers to host work exist only as `RuntimeSubmission.settled`
  (`completion | failed | stopped`), where a `completion` carries one
  frozen `RuntimeCompletion` (`completed{resultText} | failed{error}`).
  Submissions are created exclusively by Core at `runtime.submit`
  admission; the provider has no channel to invent one.
- `activity` is explicitly presentation: `turn.ended` carries
  status/reason and **no result** (`activity.ts`), the sink is
  "transient input to the Core conversation projection, not a progress
  view" with no replay, and facts flow onto the Channel event bus through
  `projectActivity` (`conversation-projection.ts:114-130`). Cold-read
  activity records deliberately exclude "admission, and settlement"
  (`activity.ts` AgentActivityRecord comment).
- The display/push-back split is an operator-ruled boundary, not
  coincidence: the `split-streaming-display-from-pushback` task created
  the activity namespace as its own channel so display facts would not
  hang off submissions.

**Delivered candidate [code fact, worktree].**

- One new type and one required create-context field:
  `AgentRuntimeResultSink = (completion: RuntimeCompletion) => void` and
  `results`, documented as per-terminal synchronous ordered publication,
  same object as every settlement for that result, interrupted/transport
  endings excluded (`dreamux-types/src/agent-runtime.ts` diff).
- Claude: the result-frame branch builds `completionFromTurnOutcome` for
  every non-interrupted frame (was answered-only) and calls
  `options.results(completion)` immediately before the answered-request
  settle loop (`claude-code/src/rpc.ts` diff).
- Codex: the unbound queue head now routes through the same `finalize`
  path bound turns use; one extracted `completionFromTerminal` helper;
  the sink is called inside `finalize` before members settle; interrupted
  terminals skip emission; the old `unboundObservedTurnIds` /
  `releaseOrphanTurnsIfIdle` orphan bookkeeping is **deleted**
  (`codex/src/turn-manager.ts` diff).
- Core: `RuntimeGeneration` builds a third leased closure;
  `AgentService.observeRuntimeResult` gates on an entity-level
  `nativeResultRecipient` option and `owesCompletion()` and calls the
  existing `CompletionDeliveryPolicy.deliverRuntime`; delivery promises
  are tracked in a new `InFlightWork` drained by both host-stop and
  durable-close convergence; `EntityTurn` remains and reports
  tokenless outcomes; a shared `turnCompletionFact` mapper now serves
  both paths.

The candidate is therefore not a wholesale replacement of the completion
mechanism: `RuntimeCompletion` identity, the router fold, the recipient
model, and the submission settlement chain survive intact. What it
actually changes is (i) one new provider→Core fact channel, (ii) the
**publication point for completion-bearing bound results moves from the
settlement continuation to synchronous terminal observation**, and
(iii) result eligibility for owner-stop is read at that earlier point.
Those two semantic moves, not the field count, are what deserve the
operator's caution.

## N.2 The unavoidable capability versus the chosen transport

**Unavoidable capability [derivation from requirement + baseline].**
Requirement Q1/Q1a asks that a provider-observed normal/failed native
terminal that answered **no Dreamux submission** be passively reported to
the member's owner once, in mixed bound/unbound terminal order, with no
model action. At baseline the only provider→Core channels are `state`
(lifecycle), `activity` (presentation, result-free), and the
submit-return/settlement direction (answers to Core-created requests).
None carries a delivery-contract result for a turn Core never asked for.
Therefore **some provider→Core fact for an unsolicited terminal result is
unavoidable**; it cannot be derived by polling, inferred from lifecycle
status, or reconstructed from display activity without a lossy second
result pipeline. What is not unavoidable is the field's name, requiredness,
payload, placement, and whether bound turns also publish — those are
transport/shape choices, examined below.

## N.3 Complete alternatives

### Option 0 — No neutral-interface change: model-directed reporting only

- **Provider author:** nothing new. The member messaging tools (already
  delivered for stories 1–2) let the model `send` a background outcome to
  its owner explicitly.
- **Contract:** zero change to `dreamux-types`; Core keeps submission-bound
  reporting.
- **Ownership/consumers:** the model owns whether a background result is
  reported at all; owner gets explicit messages, not automatic ones.
- **Identity/order/failure:** folding and bound order unchanged; unbound
  turns simply never auto-report.
- **Compatibility:** total.
- **Counterexample (decisive):** the operator-selected Q1 scenario —
  "build running" answered in turn 1, "build passed" in an unbound turn 2
  — is passively invisible if the model does not send; Q1a's failed
  background turn can occur with no usable model turn to report from.
  This is precisely candidate B the operator reviewed and did not select.
- **Status:** viable only if the operator reopens Q1/Q1a. It is the true
  zero-contract-cost baseline and should be named as such in the decision,
  not conflated with interface aesthetics. The reassessment input forbids
  removing coverage, so I do not recommend it.

### Option A — Delivered: required third leased sink, every non-interrupted terminal

Full semantics as N.1. Provider author must know: one new context sink;
emit synchronously, once, in terminal order, for every normal completed
or provider-proven failed terminal including unbound ones; pass the exact
frozen object settlements receive; emit nothing for interrupted frames,
discarded/refused commands, transport death, teardown; never throw.
Consumers: only the armed `AgentService` observer; the router, owner
inbox, and Channels are unchanged consumers. Removals: Codex orphan-turn
machinery, Claude's answered-only completion conditional, the duplicated
fact mapping; `EntityTurn` delivery shrinks to tokenless outcomes and
non-armed/non-emitting roles. Counterexamples/verification: see N.5.

### Option A′ — Same sink, optional context member

- **Difference is normative, not mechanical.** Providers *consume* the
  context; they never construct it, so an additive inbound field breaks
  neither TypeScript source nor compiled binaries whether required or
  optional. In-tree fixtures that *build* fake contexts are forced to
  update either way (that is what `typecheck:tests` catches).
- Optional makes non-emission conformant for external providers; required
  declares it a contract violation while still being unenforceable at
  runtime against an old binary. The house precedent is explicit: `state`
  and `activity` are required, and "recovery … is mandatory provider
  behavior rather than negotiated capability bits" (baseline preamble);
  the codebase rejects scope/capability negotiation
  (`AgentRuntimeResultSink` has no feature-bit consumer).
- **Assessment:** I recommend **required**, because the product guarantee
  is stated as coverage, and an optional field is a silent capability
  negotiation with no consumer that selects behavior; the real
  version-skew problem (old binary) is unsolved by optionality and is
  better handled by documented provider-version requirements, as the
  Claude required-command-group extension did in the completion-routing
  task. Optional is, however, a legitimate contract-policy choice for the
  operator, not an implementation detail.

### Option B — Reuse/widen the activity channel (no new context field)

- **Shape:** carry the result on the activity sink — a new
  `RuntimeActivity` member (e.g. `turn.result` with text/error) or fields
  on `turn.ended`; Core taps the leased activity closure before
  projection.
- **Provider author:** superficially less ("one sink already exists"),
  but it must still classify terminals, extract/validate results, keep
  object identity, and order publication — the entire emission discipline
  moves onto the display channel.
- **Why I reject it [code fact + prior ruling]:**
  1. It re-merges display and push-back across the boundary the operator
     had ruled apart (`split-streaming-display-from-pushback`); the
     activity channel's documented contract is presentation.
  2. Activity facts are published onto the Channel event bus through a
     sanitized projection (`conversation-projection.ts`), whose record
     vocabulary is JSON display data. A failed `RuntimeCompletion`
     carries a live **`Error`**; today failure text is deliberately kept
     out of the notice body (`result: null`) and host paths are kept out
     of groups. Routing the Error through that bus either leaks into
     Channel serialization or forces the projection to learn delivery
     semantics — a Core special case inside the display pipeline.
  3. Cold-read `AgentActivityRecord`s exclude settlement by design; live
     activity would then be richer than cold activity on the same
     channel, requiring a "delivery-only, never replayed" carve-out —
     two contracts inside one channel, which is nominal unification
     without removing a distinction (whitepaper §3: merged discriminant
     that removes no concept).
  4. Fold identity would have to ride a display event, and any future
     display consumer could accidentally treat delivery facts as
     presentation.
- **Counterexample to my rejection:** a very narrow, documented
  result-bearing activity kind with a Core-side pre-projection tap and a
  rule that projection strips it is mechanically possible — but compared
  with Option A it has the same provider burden, no context-field
  savings worth the contract blur, and a wider blast radius (every
  activity consumer). It optimizes the one metric (field count) the
  whitepaper says is not entropy.

### Option C — Provider-originated submission (invert the admission direction)

Let the provider hand Core a `RuntimeSubmission`-like object for an
autonomous turn. This requires a new provider→Core admission event, Core
ledger/dedup treatment for submissions it never issued, source identity
invention, and recipient attribution per provider-observed turn — a
parallel admission system whose only consumer is the owner-report path.
Strictly larger than Option A in concepts, and it contaminates the
text-only submit seam's directionality. Rejected; named because "settle
unbound turns onto a synthetic submission" is the obvious alternative and
must be shown rather than dismissed.

### Option D — Pull via `readRecentActivity` / lifecycle observation

Cold reads are display records without results, have no push timing, and
cannot identify one native completion's fold identity; polling needs a
timer the codebase has no producer for (the rejected quiet-point
candidate), and the handle contract forbids new pull methods. Rejected.

### Option E — New event envelope with sequence numbers, unbound-only emission

Revision 1's unbound-only sink plus a monotonic sequence carried by both
settlement and observation, with router-side reordering. This needs an
ordinal on the neutral contract, provider discipline across every
terminal and submission, and router ordering/buffer state — three
mechanisms to recover the ordering that synchronous all-terminal
publication gives for free, with one consumer. Rejected; the delivered
synchronous-all shape is the smaller mechanism for the same guarantee.

## N.4 Comparison against the required axes

| Axis | A/A′ delivered sink | B activity widening | C provider submission | 0 model-directed |
| --- | --- | --- | --- | --- |
| Neutral contract change | +1 required (+1 optional in A′) field/type on inbound context | no field; semantic overload of shipped display channel + activity kinds | new provider→Core admission event on the seam | none |
| Provider author's new knowledge | terminal classification it already computes; emit once/ordered/same-object/no-throw; interruption exclusions | same, plus "display event is also delivery" split-brain rule | admission ledger rules, ids, recipient semantics | none |
| Unsolicited-result owner | provider observes; Core owns eligibility/recipient/delivery | same | provider proposes; Core adjudicates invented inputs | model only |
| Once-only identity | frozen RuntimeCompletion shared with settlements; existing WeakMap | identity smuggled on display event; Error-on-bus hazard | new identity scheme | existing bound fold only |
| Mixed bound/unbound order | synchronous terminal publication in line loop / Codex terminal queue; settlement folds | achievable if emission is equally synchronous, but via display bus | new ordering needed | unbound absent |
| Interruption/failure boundary | interrupted/refused/transport-death never emit; tokenless outcomes stay with EntityTurn; unscoped codex failure emits nothing | would tempt widening activity's `turn.ended interrupted` coverage | provider could invent terminals | unchanged |
| Owner-stop timing | eligibility moves to terminal observation; terminal-before-stop suppressed; queued work joined and never retracted (real semantic move, N.5) | equivalent if implemented equivalently | Core-side adjudication could keep old timing, at much larger cost | unchanged |
| Generation replacement | leased sink; stale writes dropped, same rule as activity | same lease | needs new edge | n/a |
| Shutdown convergence | `InFlightWork` joins started deliveries at close/host stop | equivalent | unbuilt | unchanged |
| TS source compatibility for external providers | unaffected (inbound context; they do not construct it) | unaffected | breaks | unaffected |
| Old-provider binary on new Core | loads; bound reports work; **unbound coverage silently absent**; required field does not fix this | same binary gap | unsupported | n/a |
| New-provider binary on old Core | unconditional `results(...)` call would throw on a Core that supplied no sink; needs README version discipline; an optional *call site* (`context.results?.(...)`) is the compatible variant but weakens the in-tree required contract | safe | unsupported | n/a |
| Concepts removed | codex orphan bookkeeping, answered-only conditional, duplicate fact mapper | none; adds carve-outs | none | none |
| Coexistence with EntityTurn | retained for tokenless outcomes, non-armed roles, non-emitting providers | muddier (two consumers of one channel) | duplicated | unchanged |

## N.5 Delivered candidate's two real semantic moves and their counterexamples

These, not the added field, are what I would put before the operator:

1. **Bound-result publication moves to terminal time.** For an armed
   ordinary member, the owner report for a *submission-answering* turn is
   now enqueued synchronously at the native terminal; the settlement
   continuation's delivery folds into it. Consequence the final solution
   already names: a stop landing after the terminal but before the
   settlement microtask no longer suppresses that report (baseline
   `EntityTurn` read `owesCompletion()` on the continuation). This is a
   defensible reading — the work ended before the stop, and "a delivery
   already started is never retracted" is existing policy — but it is a
   behavior change to the owner-stop boundary for bound turns, verified by
   a terminal-then-stop race test. Counterexample: an owner that issues
   stop precisely to suppress a just-finished answer loses that
   suppression window. If the operator wants byte-identical stop timing,
   the only cheaper alternative is unbound-only emission plus Option E
   ordering — rejected above on mechanism cost.
2. **Dual publication rests on cross-package object identity.** Every
   completion-bearing terminal is emitted on the sink *and* settles
   requests; a provider author who naturally constructs a "result event"
   object distinct from the settlement object (a very natural mistake for
   a future external provider or custom Claude session factory) produces
   silent duplicate owner reports, with no type error and no Core-side
   way to detect it. Mitigations available without widening the contract:
   reference-identity tests in each adapter (delivered), README
   requirement text (delivered), and keeping the mapping one helper per
   adapter (delivered). A structural/id-based fold would need new identity
   fields on the neutral contract; I would not add them speculatively.

Other counterexamples, checked and discharged: notification volume (Q1's
accepted cost, no filter authorized); stopped-owner push-back drop
(pre-existing `wake:false` asymmetry, documented); interrupted-frame then
unbound-frame same-batch ordering residual (pre-existing tokenless path,
documented, out of Q1/Q1a); long-lived dev-server turn cadence (same
accepted volume semantics); Codex unbound frequency (path exists in
source, real frequency is a live-verification fact).

## N.6 Recommendation

**Keep a dedicated third leased sink carrying the existing
`RuntimeCompletion` — i.e. retain the delivered transport shape (Option A,
required field) — while recording the two semantic moves in N.5 as the
actual scope of this neutral-interface change.** Evidence:

- The capability (provider-originated unsolicited terminal result) is
  unavoidable under the selected product behavior; every zero- or
  smaller-surface alternative either drops the accepted coverage
  (Option 0), overloads the ruled display/push-back split and leaks an
  Error-typed delivery fact onto the Channel event bus (Option B), or
  invents larger admission/ordering machinery (C, E).
- The seam already defines its own extension pattern: leased,
  synchronous, non-throwing, generation-scoped push channels with Core
  policy downstream. A third such channel is the house shape; a pull
  method or a registration handle would contradict the handle's
  "nothing is pulled" contract.
- Reusing `RuntimeCompletion` adds no result vocabulary, no sequence
  number, no Core turn registry; the router/fold/recipient machinery is
  unchanged and the change *deletes* real provider bookkeeping (Codex
  orphan turns).
- Compatibility reality is honestly stated: additive inbound field is
  source/binary tolerant; the in-tree guarantee comes from both shipped
  providers implementing the contract, not from the type; skew is
  governed by provider-version documentation, and the symmetric skew
  (new provider on old Core) requires the documented minimum-Core
  version — the README contract pattern already established by the
  Claude required-command-group extension.

I would reject any drift beyond this: do not make the sink async or
backpressured (ordering is the feature), do not widen its payload to
interrupted terminals (Q1/Q1a boundary), do not remove `EntityTurn`
(tokenless outcomes and non-armed roles still need it), and do not add
capability-bit negotiation.

## N.7 Genuine decisions for the operator (not mine to settle)

1. **Accept any new provider-authoring channel at all**, versus reopening
   Q1/Q1a toward model-directed reporting (Option 0). Interface caution
   meets product guarantee only here; the rest is implementation.
2. **Required vs optional normative strength** for `results` (A vs A′):
   zero mechanical compatibility difference; required states the
   guarantee honestly and matches `state`/`activity` precedent.
3. **Accept the bound-turn stop-timing move** (eligibility at terminal
   observation, N.5.1) as a deliberate, tested consequence rather than a
   refactor side effect.
4. Minimum-Core/provider version wording and whether external runtime
   packages must declare conformance — documentation policy.

## N.8 Load-bearing unknowns for the review/implementation phase

- Inventory and release cadence of external
  `AgentRuntimeProvider` packages loaded through `external-provider.ts`
  (the monorepo ships two; the contract is npm-public): how many
  implementations will silently keep bound-only behavior.
- Real Codex unbound-terminal frequency and the live protocol shape of
  fatal `error` notifications, to be recorded from live gates rather
  than assumed (source proves the path, not the traffic).
- Whether the unconditional `results` call in providers needs an
  in-tree `context.results` presence guard for old-Core downgrade
  scenarios in practice (downgrades are not supported today; this is a
  policy confirmation, not a code requirement).
- Verification must observe **delivered** report order end to end (not
  sink call order) for the multi-line Claude batch and mixed Codex queue
  heads, plus reference identity between sink and settled completion and
  the terminal/stop race pair.

---

# Neutral runtime interface reassessment — cross-review and revised position

- Inputs: DeepSeek RZ.1–RZ.7, MiMo §4.1–4.8, and my N.1–N.8 above;
  baseline read via `git show HEAD:`, delivered worktree separately;
  requirement revision 2 and the reassessment boundary. Labels:
  **[code]** verified in current source this round, **[decision]**
  recorded in requirement/final solution, **[inference]** design
  judgment.
- This is the single authorized cross-review under the implementation
  hold. The delivered shape is evidence, not authority; neither is a
  prior consensus.

## X.1 Consensus across the three independent reassessments

1. **The capability is unavoidable; one of the proposed shape choices is
   not.** An unsolicited, provider-observed normal/failed terminal result
   must reach Core owner reporting once, in terminal order relative to
   bound results. Baseline's three outbound contracts cannot carry it:
   `settled` exists only for Core-admitted submissions; the activity seam
   is presentation and result-free; the state sink is durable lifecycle
   publication. All three seats independently reached this from HEAD
   source **[code + decision: Q1/Q1a, rev-2 ordering criterion]**.
2. **Recommend the delivered transport: one required, synchronous,
   non-throwing, generation-leased function-typed `results` field on
   `AgentRuntimeCreateContext`, payload the pre-existing
   `RuntimeCompletion`, with both adapters publishing every
   non-interrupted terminal and bound settlement deliveries folding into
   that publication via the existing WeakMap.** All three seats rejected
   optional fields, activity reuse, state-sink widening, pull APIs,
   synthetic submissions, and unbound-only-plus-sequence-key designs.
3. **Core reporting policy is independent of transport** (see X.3).
4. **Connection-level Codex failure emits nothing; failed notices stay
   body-less; owner envelopes stay unchanged** — settled points the
   reassessment does not reopen (X.6).

## X.2 Version-skew adjudication (mandated question 1)

The two directions are different claims, and one proposal framing was
incomplete.

- **New host + old provider [code].** The context is constructed by Core
  in exactly one place (`RuntimeGeneration.resolveLaunch`); providers are
  pure consumers. An old provider binary ignores the extra property,
  loads, and keeps bound-only behavior: its submissions settle and
  `EntityTurn` still reports them; unbound results stay silent.
  TypeScript source compatibility for provider authors is likewise
  intact: they do not construct the context. Only in-tree fake/fixture
  *constructors* must add the field, which is exactly what
  `typecheck:tests` pins. Loading is therefore binary-tolerant, but it is
  **not** semantic conformance — the unbound-result guarantee is absent
  and there is intentionally no capability negotiation that could detect
  it. All three seats state this; it is correct.
- **Old host + new provider [code; finding sharpened this round].** This
  direction was left implicit in two proposals. Both delivered adapters
  call the sink **unguarded**: Claude `this.options.results(completion)`
  inside the synchronous `result`-frame handler
  (`claude-code/src/rpc.ts`), reached from a bare
  `rpc.onStdoutChunk(chunk)` in the stdout `'data'` listener with no
  catch (`supervisor.ts:121-123`); Codex `this.opts.resultSink(completion)`
  in `finalize` (`turn-manager.ts:300`). Against an old host that builds
  no `results`, the first non-interrupted terminal throws
  `TypeError: not a function`: in Claude the remaining lines of that
  batch and the answered-request settle loop after the call never run
  (`rpc.ts` result handler), so request promises can hang until the
  idle-reaper/transport loss — a failure of bound delivery itself, not a
  quiet coverage gap. The required-field type cannot prevent this at
  runtime; it is a deployment-version hazard, and it is **asymmetric**
  with the other direction (which degrades).
- **Resolution, consistent with house precedent [inference].** Do not add
  `?.` guards or capability probing: `state`/`activity` are likewise
  called bare, and a guard for an unsupported deployment direction is
  defensive code with no supported scenario in the pinned monorepo
  release model. The provider package README must state the minimum host
  version, mirroring the Claude required-command-group extension's
  documented minimum, and the types README's "Hosts and fixtures must
  provide the required sink" should add the symmetric sentence that a
  provider implementing the result contract requires a host supplying it.
  Minimum-version text is documentation policy, not a mechanism; it is
  the one compatibility item I would add before lifting the hold.

## X.3 Core report ownership is separable from transport (question 2)

Independently of how a native result arrives (sink, widened activity,
pull), the delivered Core layer already isolates every policy decision:
arming is per ordinary construction only (`agent/index.ts:855-863`
installs `nativeResultRecipient` and the member delegate together;
leader, dispatcher agent, and locked builds never set it); the recipient
is the collection's existing `completionOwner`; `AgentService` owns the
`owesCompletion()` read and fact mapping; `CompletionDeliveryPolicy` owns
fold/order/retry/fence; `RuntimeGeneration` owns the lease. **[code]**
Consequences for the decision:

- Challenging or replacing the neutral transport does not reopen
  recipient, arming, stop, or Workflow policy, and vice versa.
- Conversely the sink alone proves nothing about who gets a report; a
  non-armed entity's sink writes are ignored by construction
  (`service.ts observeRuntimeResult`). The neutral contract is therefore
  correctly scoped to "a terminal result occurred", with no Team/owner
  vocabulary leaking provider-ward.

## X.4 Which identity/order requirements are fundamental (question 3)

The three proposals share one mechanism but my earlier text conflated its
requirements; the split is:

**Fundamental (requirement text, independent of shape):**

- unsolicited normal/failed terminal result reaches the owner once
  [Q1/Q1a];
- N submissions folded into one native completion produce one report,
  distinct completions report separately [Q1 bullet 2];
- delivered order of completion-bearing reports equals native terminal
  order across mixed bound/unbound batches [rev-2 acceptance criterion];
- no fabricated result for interruption, refusal, connection loss,
  teardown; owner-stop suppression; revoked-generation drop.

**Derived from the chosen dual-report path (not fundamental):**

- *same-object identity between sink and settlement* is required only
  because one native result is published twice into the same fold; under
  unbound-only emission there is no second observer and the baseline
  per-completion object convention suffices within folded submissions;
- the *shared fact mapper* exists only because either path may first
  insert the token, so the payload cannot depend on arrival;
- the *terminal-time `owesCompletion()` read* (see X.5) follows from
  publishing bound results synchronously at the terminal instead of on
  the settlement continuation.

**Fundamental under any push shape, not just dual-report:**

- Core-owned delivery tracking and close/host-stop convergence
  (`InFlightWork nativeReports`): even an unbound-only sink creates
  delivery promises attached to no `EntityTurn`, so something must join
  them at shutdown.
- synchronous publication at terminal observation: the ordering
  criterion cannot be met by a post-`await` emission regardless of
  scope.

The one alternative that preserves baseline bound stop-timing (unbound
sink + ordering key on `RuntimeCompletion` plus router holds, MiMo S5)
changes a **baseline shared type**, adds hold/release state, and silently
loses the guarantee for non-stamping providers. It is larger and weaker;
all three seats reject it. The dual-report path is therefore the
smallest shape that buys the ordering guarantee, and its derived
requirements are its stated price, not incidental complexity.

## X.5 Activity reuse requires a contract replacement — explicitly evaluated (question 4)

The premise that the activity payload could stay unchanged while results
ride it is false on source; both the shallow and the deliberate redesign
were evaluated:

- **Shaping a result onto the baseline activity vocabulary** cannot fold
  (no `RuntimeCompletion` identity; `turn.ended` has no result,
  `activity.ts:126-149`), cannot carry a failed result (the fact's error
  is a live `Error`, and the failure notice is deliberately header-only;
  the activity stream crosses the sanitized Channel projection in
  `conversation-projection.ts:114-130`), and violates the seam's stated
  optionality ("its absence changes only presentation").
- **A deliberate dual-purpose redesign** (new result-bearing
  `RuntimeActivity` member consumed by Core before projection) still
  forces the provider to do the same terminal classification, same-object
  construction, and synchronous ordered publication, and additionally:
  inverts the documented meaning of a shipped display contract; makes
  presence of a delivery-critical fact mandatory on an explicitly
  optional channel; requires every activity consumer to distinguish
  delivery facts from display — including the Feishu adapter's
  compile-time exhaustive switch (`feishu-channel/src/cot/adapter.ts:417-423`,
  where a new kind is a channel-package change with its own display
  decision, not an ignored event); and reintroduces best-effort display
  drop semantics into owner news. Net: one context field saved, a
  channel-facing ABI replaced and its blast radius widened. Both other
  seats reach the same rejection (DeepSeek O3, MiMo S3) **[code +
  inference]**. The baseline `activity` seam is left untouched by the
  delivered shape; that is the correct division.

## X.6 Settled points not reopened (question 5)

Under the hold, the following were already recorded as decisions in the
reconciled final solution and/or requirement and are consistent with
delivered source; a proposal re-raising them "for confirmation" is
rejected as a reopened point absent new source evidence:

- Codex `onUnscopedFailure`/`failProtocol`/`failRecord` publishes no
  per-record result (`events.ts:54-60` defines it as connection-level;
  Q1a forbids fabricated terminals). Delivered code emits only in
  `finalize` (`turn-manager.ts:300`); DeepSeek RZ.6's request to
  "confirm the intended boundary" is answered by the recorded
  adjudication in `final.md` §3/§5 and is closed.
- Failure notices keep `result: null`; no error text is added to bodies.
- Existing owner `send`/`spawn` envelopes are unchanged (no uniform
  `from` stamp); member sends use `task` + host-bound `from`.
- Required (not optional) sink strength, `send`/`list` vocabulary,
  roster shape, and lazy owner descriptor are final-solution choices.
- The interrupted-frame → later-completed-frame same-batch ordering
  residual for **completion-less** settlements is documented and out of
  contract; no sequence field is added.

One point is settled-as-designed but still deserves explicit operator
acknowledgment rather than being treated as invisible: the
**owner-stop timing micro-move** (MiMo §4.5/§4.7, my N.5.1, DeepSeek's
table). Baseline reads `owesCompletion()` on the settlement
continuation; the delivered shape reads it at synchronous terminal
publication, so a stop landing in the one-microtask window after a normal
terminal but before the continuation no longer suppresses that bound
report. This is a named change to a preserve-clause behavior
("preserve … shutdown … unless a separate explicit decision changes a
named behavior"), the reconciled final solution recorded it and requires
the terminal-then-stop test, and it is the direct, unavoidable price of
the ordering guarantee in X.4. Classification: **not an oversight and not
an open technical fork — an explicit-confirmation item**: the operator
either accepts publication-time suppression semantics (recommended;
coherent with "queued delivery is never retracted") or chooses the
strictly larger S5 shape. It must not silently ride into release.

## X.7 Revised complete position

1. Retain the delivered neutral change exactly in kind: required
   `AgentRuntimeResultSink` field; `RuntimeCompletion` payload;
   synchronous once-per-terminal ordered publication of every normal
   completed/failed terminal, bound or unbound; same frozen object as
   every settlement for that result; nothing emitted for interruption,
   refusal, connection-level failure, or teardown; leased generation drop;
   non-throwing.
2. Retain the Core division unchanged: entity-level arming for ordinary
   builds only, existing `completionOwner` recipient, `owesCompletion()`
   gate, shared fact mapper, existing router fold/FIFO/fences,
   `EntityTurn` retained for tokenless outcomes and non-armed roles,
   `InFlightWork` convergence at close/host stop. No Core native-turn
   registry, sequence number, capability bit, or display-seam reuse.
3. Compatibility posture: keep the field required (matches
   `state`/`activity`; providers are consumers); document the two skew
   directions truthfully — old providers load with bound-only coverage,
   new providers require a new host (minimum-host-version sentence in
   both runtime READMEs and the types README); no runtime guards.
4. Before the hold can lift, the operator has two acknowledgments and no
   technical alternatives left: (a) the neutral seam gains a third push
   channel, justified as the minimal carrier of an unavoidable
   capability; (b) owner-stop eligibility for completion-bearing results
   is read at terminal publication, with the race test required.
   Everything else in the delivered neutral design is settled evidence.
5. Verification that actually defends this shape: per-adapter
   reference-identity assertions; multi-line Claude batches in both
   orders asserting *delivered* (not emitted) order and one prepare/submit
   per token; mixed Codex queue heads; interrupted/unscoped/`stop()`
   silence; revoked-generation drop; stop-before-terminal suppress vs
   terminal-then-stop delivers; close/host-stop joins an in-flight report;
   both scopes × both runtimes; old-context fixture adoption under
   `typecheck:tests`.

## X.8 Remaining disagreements and blockers

- No material disagreement survives among the three reassessments on
  shape, ownership, identity/order decomposition, activity rejection,
  skew classification, or compatibility strength. Differences were
  emphasis only (DeepSeek tabulated options most fully; MiMo alone named
  the stop-window as a product micro-decision; I add the concrete
  old-host throw path and the minimum-host documentation requirement).
- **No architectural blocker.** The genuine residual items are
  operator-level acknowledgments, not design unknowns: the third push
  channel itself (the caution this round was asked to test — answered:
  unavoidable capability, minimal carrier, display seam preserved) and
  the stop-timing micro-move.
- Verification-bound unknowns remain exactly as recorded: real Codex
  unbound-terminal frequency, and end-to-end delivered-order behavior
  under live providers; neither changes the contract.

---

# Greenfield design from requirement revision 3 — independent proposal

- Authority: [requirement revision 3](../../requirement.md) (consolidated
  after Q5: managed Teams are not activity streams) and
  [greenfield-input.md](../greenfield-input.md) ("if we wrote the
  mechanism completely from scratch, what would be best"). Derived from
  the product stories first; current class names and the delivered
  implementation are compared only afterward. Earlier sections of this
  file and the delivered worktree are evidence, not constraints.
- Independent first round: other seats' greenfield sections were not
  read.
- Labels: **[product]** requirement-revision-3 behavior, **[code]**
  current/HEAD source fact, **[design]** this proposal.

## G.1 Derivation: the facts, producers, and consumers

Start from what the product needs, ignoring current classes.

### Facts

1. **A native turn ends with an outcome.** The provider is the only
   observer. Outcomes relevant to delivery are `completed(resultText)`,
   `failed(error)`, and `interrupted`; a connection-level death is the
   absence of an observed turn outcome **[product: Q1/Q1a, interruption
   boundary]**.
2. **A host submission is accepted into a native turn.** N submissions
   can fold into one turn; a turn can contain zero submissions
   (background continuation). This attribution exists only at the
   provider boundary (Claude answered command UUIDs; Codex binds turn
   ids to submissions) **[code: `rpc.ts` result handler; `turn-manager.ts`
   nativeTurns]**.
3. **Two genuinely different entitlements to a turn's outcome**
   **[product: rev-3 actors table + Q5]**:
   - **Subscription.** An ordinary member's *conversational owner* is
     owed every normal/failed turn outcome, including turns with no
     submission. One subscriber per ordinary member (Team leader or
     Dispatcher agent). TeamLeaders, the Dispatcher agent itself, and
     Workflow-locked builds have no subscriber.
   - **One-shot answer.** A specific requester is owed the outcome of
     the *specific turn answering its explicit request* and nothing
     after it: a Dispatcher→managed-Team request (`team.create` with
     prompt, `team.send`) and a Workflow step (consumed in-process via
     the settled handle, not delivered as a notification). A
     Channel-originated Team request creates no such entitlement.
4. **An explicit member message** is a new ordinary input with a
   host-bound sender, addressed to the owner or a same-collection peer
   **[product: explicit-communication section]**.

### Consumers of each fact

| Fact | Producer | Consumers |
| --- | --- | --- |
| Native turn outcome | provider terminal observation | (a) the subscriber, when armed; (b) one-shot answer claimants of submissions the turn answered; (c) the Workflow script awaiting its handle |
| Submission admission/settlement | provider → `RuntimeSubmission` | submitter's admission receipt; turn convergence on stop; the Workflow script; the one-shot answer mechanism |
| Native activity (tools/messages/usage/end) | provider display stream | Channel/live displays only — never delivery |
| Explicit message | member model via MCP | the addressed entity's runtime as ordinary input; its turn is later covered by fact 1 like any other |

The greenfield insight: **"who gets an owner report" is a per-entity
subscription chosen at construction, not a per-submission field.** The
delivered implementation and the pre-feature baseline both attach the
owner to every *submission*; the product actually subscribes the owner
to the *member*. That misattribution is the source of the whole
dual-publication/fold-identity apparatus.

## G.2 The ideal design

### G.2.1 Neutral runtime contract

```ts
// packages/dreamux-types/src/agent-runtime.ts

/**
 * The provider's ordered publication of native turn OUTCOMES THAT EXIST:
 * once per observed normal completion or provider-proven failure,
 * synchronously in native terminal order, including turns that answered
 * no host submission. The value is the same frozen RuntimeCompletion
 * every submission answered by that turn settles with.
 *
 * Never called for an interrupted terminal, a discarded/refused input,
 * connection/transport death, or teardown — those have no observed
 * completion. Synchronous, non-throwing, non-backpressuring; Core
 * generation-leases the closure and drops stale writes. A provider that
 * never calls it produces no subscription reports (documented
 * nonconformance), but submissions still settle.
 */
export type AgentRuntimeTurnResultSink = (result: RuntimeCompletion) => void;

interface AgentRuntimeCreateContext<C> {
  // state and activity unchanged
  /** Leased, ordered native turn results. Core always supplies it. */
  readonly turnResults: AgentRuntimeTurnResultSink;
}
```

Provider author's contract, in full:

- at every completion-bearing native terminal, call `turnResults(value)`
  exactly once, synchronously, before any other side effect of that
  terminal (before settling answered submissions is fine and makes
  ordering intrinsic);
- the frozen object is the one handed to every settlement of that turn;
- interrupted terminals, request pre-admission refusals, connection
  failure with no terminal, and manager teardown call nothing;
- never throw into it; never call after the generation lease is revoked.

That is the entirety of the new neutral surface. No sequence number,
event envelope, turn id, attribution set, or capability bit: turn order
is call order; the host already knows which submissions it made and
their settlement handles the answer path.

The `RuntimeHandle` keeps `start/submit/interrupt/stop` and
`RuntimeSubmission.settled` unchanged in meaning **[code: baseline]**.

### G.2.2 Core ownership

**Arming (construction-time, one fact per entity).**

```ts
interface TeammateServiceOptions {
  /**
   * Present exactly for ordinary (non-locked) members built by a
   * TeammateCollection. The conversational owner this entity reports
   * every turn outcome to. Absent for the Dispatcher agent, TeamLeaders,
   * and Workflow-locked builds.
   */
  turnResultSubscriber?: CompletionInitiator;
}
```

`TeammateCollection` already receives a `CompletionOwner` for both
scopes (Team service / Dispatcher agent). Its ordinary build paths
(spawn, reopen, materialize) set `turnResultSubscriber =
completionOwner.completionRecipient()`; the `createLocked` path omits
it. There is no boolean, no persisted category, and no live probe:
construction kind is the arming decision (the fact the reconciled
revision-2 solution already established).

**Result observer (one report path per turn outcome).**

`RuntimeGeneration` leases the sink exactly like the activity sink
(lease check → entity observer, never throwing back). On a result:

1. no subscriber → return (leader, dispatcher agent, locked build,
   external nonconformance is irrelevant);
2. `!owesCompletion()` → return (owner close/host stop/service stop);
3. enqueue one `TeammateCompletionFact` through the *existing*
   `CompletionDeliveryPolicy` to the subscriber, tracked by the existing
   in-flight work that close/host stop already joins.

Because this is the **only** path that notifies a subscriber of a
completion, once-only is intrinsic: one terminal → one call → one
enqueue. The router's token WeakMap is no longer load-bearing for
ordinary-member reports (N submissions folding into one turn never
produce N publications because submissions don't publish to the
subscriber at all); it stays as generic completion-router machinery for
one-shot claimants and Workflow terminals.

**Settlement keeps a narrowed job.** `EntityTurn`/`RuntimeSubmission.settled`
remain, for:

- the submitter's `Turn.settled` (Workflow scripts read the outcome
  directly — unchanged);
- admission convergence on stop;
- **one-shot answer delivery**: a submission may carry
  `answerRecipient` (today's `completionRecipient`, renamed for its
  narrowed meaning) — set *only* by the Dispatcher's managed-Team
  request paths (prompt-bearing `team.create` and `team.send`;
  `team/mcp.ts` already passes `deliverCompletionToDispatcher: true`,
  Channel/admin Commands pass `false` — **[code]**). `EntityTurn`
  delivers that claimant the outcome of the turn answering *that*
  submission: completion via the settlement, stopped/transport-failed
  via the tokenless path.
- **tokenless bound outcomes for armed members**: an interrupted turn
  that answered submissions settles `stopped` with no completion;
  transport death settles open submissions `failed`/`stopped`. These
  have no turn-result event, and rev-3 keeps "existing
  submission-associated failure/interruption outcomes … in scope", so
  `EntityTurn` still notifies the *subscriber* for the tokenless
  settlement of an admitted submission — exactly today's behavior for
  that narrow class.

Ordinary collection submission paths stop attaching any recipient:
`spawn`/`send`/peer messages submit with no `answerRecipient`. The
subscriber was attached to the entity at build time; a peer-addressed
turn is therefore reported to the owner by the result sink, and the peer
gets only an explicit reply — with no recipient bookkeeping on the
message.

**Explicit messaging.** Unchanged from the reconciled revision-2 shape:
third scope on the existing `teammate` server, `send {name, prompt}` and
`list`, host-bound `from`, lazy owner descriptor, owner inbox via the
existing fenced entries, peer path through the existing collection
send/reopen, `task` provenance with `from`, no `intent`, admission-only
receipt, ordinary wake. It is independent of the reporting redesign:
messages are inputs; turn outcomes are facts.

### G.2.3 Managed-Team isolation (Q5) — falls out of arming

- Team **members**: subscriber = TeamService → TeamLeader. Reports stop
  at the leader; the Team is never itself a member of the root
  collection, so nothing recursively forwards upward.
- **TeamLeader**: no subscriber (it is not built as an ordinary member
  of the root collection). Its autonomous turns notify nobody.
- A Dispatcher explicit request attaches a one-shot
  `answerRecipient` on that submission; the answering turn's settlement
  delivers once and folds two requests to one delivery (same
  Dispatcher-agent claimant, router identity). A prompt-less create and
  Channel/admin requests attach nothing. Later leader continuations
  carry no claimant and reach no Dispatcher input.
- Dispatcher-root ordinary members: subscriber = Dispatcher agent; they
  are not members of any Team, so Q5's "Team activity must not stream"
  is structurally independent of their coverage.

There is no owner-kind branch in reporting: both collections arm
ordinary builds with their existing `CompletionOwner`; the Team leader's
construction is the only place that never arms. The Dispatcher keeps
every management read, inventory projection, and Channel presentation;
subscription is input delivery, not visibility.

## G.3 Ordering, identity, and the fold — re-derived

- **Fundamental product guarantees [product]:** once per observed
  normal/failed turn; distinct turns in native terminal order; folded
  submissions = one report; observed failure once; no unbound
  interruption; no fabricated connection-failure terminal; owner-stop
  suppression; live-runtime-only push-back; explicit-send wake.
- **Design-derived (not fundamental):**
  - *same-object identity between sink and settlement* is still a
    provider rule (one frozen completion per terminal, today's adapter
    convention and what makes one-shot answers and script reads
    coherent), but it is **no longer load-bearing for owner-report
    deduplication**: a cloned sink value cannot double-report because
    the sink is the sole completion-report path to the subscriber.
    The delivered shape's strongest counterexample (silent duplicate on
    clone) is defused.
  - *the shared fact mapper* stays one function for wording, but
    arrival order can no longer choose the payload: subscriber
    completions always originate at the sink; tokenless and one-shot
    paths never carry a completion to the same claimant.
  - *the stop-timing micro-move is intrinsic*, not an artifact: once
    reporting is keyed to the observed terminal rather than to
    settlement, `owesCompletion()` is necessarily read at terminal
    publication. A stop after the terminal cannot retract an enqueued
    report ("delivery already began is never retracted"); a stop before
    the terminal suppresses. This is the coherent reading and should be
    tested at both sides of the race — but no design can restore
    settlement-time suppression without un-inventing terminal-ordered
    reporting.
- **Ordering proof without a queue [design]:** the sink enqueues
  synchronously inside the provider's terminal handling (Claude's
  synchronous line loop; Codex's `terminalOrder` drain). Router tail
  insertion is synchronous. Therefore subscriber delivery order for
  completion-bearing turns equals terminal order by construction;
  settlement continuations never enqueue subscriber completions. The
  one residual — tokenless bound settlements (interrupted frame, later
  unbound completion in one batch) interleave via continuations — is
  pre-existing, outside the Q1/Q1a contract, and documented rather than
  sequenced.
- **Generation replacement:** leased closure; stale results drop.
  Provider restart must publish only terminals observed in the new
  generation (same rule activity already has); a provider cannot replay
  history through the sink.
- **Convergence:** started subscriber deliveries are tracked by the
  existing in-flight work and joined by entity close and host stop;
  explicit-send admissions keep their existing convergence; the sink
  itself adds no buffer, retry loop, or ledger. No offline mailbox.

## G.4 What disappears, what stays, what is added (greenfield accounting)

**Removed relative to the delivered worktree:**

- completion-recipient stamping on ordinary collection submissions
  (`spawnAdmitted`/`sendResolved` recipient threading) — the per-request
  owner subscription;
- the dual publication of completion-bearing bound turns (sink **and**
  `EntityTurn` delivering the same token to the same claimant) and
  therefore the cross-seam same-object requirement as a *delivery
  correctness* invariant;
- the "two arrivals must build byte-identical facts" hazard (the shared
  mapper remains as ordinary wording reuse, not a fold dependency).

**Removed relative to conceptual alternatives (never shipped):**
quiet-point aggregation, sequence/order keys, router hold queues,
provider-side submission minting, activity-seam delivery, pull/drain.

**Retained (they are the right owners at baseline):**
`RuntimeCompletion`/`RuntimeSubmission`/settlement; `CompletionDeliveryPolicy`
(fold for one-shot claimants, per-claimant FIFO, retries, dispatcher
fence); `CompletionOwner`/`CompletionInitiator`; `EntityTurn` narrowed
to one-shot answers, tokenless bound outcomes, script settlement, and
stop convergence; generation lease; activity and state seams untouched;
the messaging delegate and collection reopen/lock/fence machinery;
Workflow locked submit and run terminal reporting.

**Added (each with producer/consumer named in G.1):**
one neutral sink type + one create-context field; one leased closure and
one entity observer; one per-entity `turnResultSubscriber` construction
fact; the member MCP scope (already delivered); the explicit
one-shot-answer naming for the managed-Team path; turn-fact wording
corrections.

No persisted state, config, mailbox, registry, turn ledger, quiet timer,
or hierarchy-forwarding rule exists in the ideal design.

## G.5 Strongest counterexamples (and answers)

1. **A nonconforming provider settles submissions but never calls the
   sink.** Subscriber gets no owner reports at all for that runtime,
   including bound turns — whereas the delivered dual-path shape keeps
   bound coverage via settlement. This is the real price of the single
   path. Answer: Q1's guarantee is the sink contract; partial coverage
   is a documented version-conformance matter, and the alternative's
   "graceful degradation" is precisely what reintroduces the dual-path
   ordering and clone-duplication hazards. Do not add a silent fallback
   (it would need "sink may still arrive later" hold state); state the
   minimum provider version instead.
2. **Interrupted bound turn.** Sink silent by rule, but the owner still
   receives the existing "was stopped" notice through the tokenless
   settlement path; an *unbound* interruption stays silent. Matches
   rev-3 exactly; the two paths are payload-disjoint, so no duplicate is
   possible.
3. **Two explicit Dispatcher requests fold into one leader turn.**
   Neither is a subscription; both one-shot claimants are the same
   Dispatcher agent; one settlement delivery, folded by router
   identity. A third autonomous leader turn after it delivers nothing.
4. **Result published, then stop before the owner runtime accepts the
   push-back.** Started delivery follows existing fences
   (`unsupported`/drop, `wake:false` preserved) — same availability
   limit as every completion today; no mailbox is added.
5. **Provider emits after an await / out of order.** Same convention
   risk as the delivered shape; falsified by delivered-order tests. The
   single-path design at least makes misorder visible (no fold hides it).
6. **A Workflow-locked member's unbound continuation after unlock:** the
   run closes held members before unlocking, so a later peer send
   reopens through an armed ordinary build; no lineage state needed.

## G.6 Verification that would falsify this design

- Per adapter: exactly one sink call per completion-bearing terminal in
  terminal order (multi-line batches both directions, folded
  submissions, third bound frame); zero calls for interruption, refused
  commands, unscoped connection failure, and manager stop; settled value
  is the emitted value (reference equality).
- Core: armed entity — bound and unbound completions each produce one
  subscriber delivery; N folded submissions one; sink is the first and
  only completion delivery; tokenless bound interrupted/transport
  outcomes still notify once; disarmed entities (leader, dispatcher
  agent, locked build) never deliver from the sink; subscriber delivery
  order equals terminal order; revoked generation drops; stop before
  terminal suppresses; terminal-then-stop before continuation delivers;
  close/host stop joins an in-flight report.
- Q5 matrix: leader autonomous turns reach no Dispatcher; explicit
  prompt-create/send answer once; prompt-less create and Channel requests
  answer nothing; member reports never recurse past the leader; many
  Teams produce zero unsolicited Dispatcher inputs; root members still
  report to the Dispatcher agent.
- Messaging/Q2/Q3 and both-runtime live gates as in prior sections;
  `typecheck:tests` adopts the required context field. Four Rush gates.

## G.7 Ideal vs. HEAD vs. delivered: adaptation or replacement

| Module | From HEAD | From delivered worktree | Class |
| --- | --- | --- | --- |
| `dreamux-types` neutral contract | add required `turnResults` (rename of delivered `results`, semantics narrowed in docs to "outcomes that exist") | field rename + tightened doc | **Adaptation** (the unavoidable capability; prior rounds established no zero-contract shape exists) |
| Both adapters | new emission discipline | already emit every completion-bearing terminal; unchanged | delivered already matches ideal |
| `AgentService`/`RuntimeGeneration` | subscriber observer + leased closure | delivered observer exists; delivery rule narrows (completions only via sink) | **Adaptation by deletion** |
| `EntityTurn`/submission recipient | was the sole owner-report mechanism | becomes one-shot-answer + tokenless + convergence; ordinary submissions stop carrying the owner | **Replacement of the reporting model** (small diff, conceptual boundary move) |
| `TeammateCollection` | stamped owner per submission | arming moves to construction; spawn/send recipient threading deleted | adaptation |
| Managed-Team request path | one-shot flag already exists | renamed/narrowed semantics, behavior identical | adaptation |
| Member messaging MCP scope | absent | delivered; retained as designed | additive, already present |
| `CompletionDeliveryPolicy`, activity/state seams, Workflow, reopen, locks, fences, completion types | unchanged | unchanged | retained |

A maintainer under the ideal must understand one sentence: *ordinary
members have a subscriber for every observed turn outcome; explicit
requesters have a one-shot answer; the provider publishes outcomes in
order; everything else is unchanged plumbing.* Under the delivered shape
the sentence is longer: outcomes arrive twice for bound turns, and a
WeakMap identity convention across a package boundary makes them one.
The next provider author under the ideal implements one ordered
publication and can construct completion objects naturally; under the
delivered shape they must additionally know that cloning the object is a
silent duplicate bug.

The ideal is therefore **not a repository rewrite**: relative to the
delivered worktree it is mostly a Core-side *deletion of dual delivery*
plus renaming; relative to HEAD it remains the additive neutral sink the
prior rounds proved unavoidable. It deliberately does not merge services,
replace state/config/lifecycle contracts, or add transition machinery.

## G.8 Genuine blockers and open product choices

- **No technical blocker.** The product is fully expressible with one
  sink, one subscription fact, and the pre-existing one-shot path.
- **One real trade-off for explicit decision (product-compatible
  either way):** single-path purity versus the delivered shape's
  bound-coverage fallback for a sink-nonconforming provider. I recommend
  the single path; retaining the fallback means keeping dual publication,
  cross-seam object identity, and the payload-arrival coupling the
  greenfield pass otherwise deletes. This is an architecture choice the
  TeamLeader/operator should see, not a detail to preserve by default.
- **Transition support:** no version negotiation or fallback entity;
  minimum-host/minimum-provider version statements in the three READMEs
  (old provider: bound-only via settlement *only if the fallback is
  retained*, otherwise documented nonconformance; new provider on old
  host: bare sink call would throw — same skew as delivered).
- Unverified facts unchanged from prior rounds: real Codex unbound
  frequency; live delivered-order confirmation. Neither alters the
  design.

---

# Greenfield cross-review — adjudication and revised recommendation

- Inputs: [greenfield-cross-review.md](../greenfield-cross-review.md),
  [greenfield-root-notes.md](../greenfield-root-notes.md) (hypotheses to
  falsify, not an answer), and the current greenfield sections of
  DeepSeek (G1–G8) and MiMo (§G.1–G.9), plus my G-section above.
  Adjudication is against current worktree/HEAD source; labels
  **[code]**, **[product: rev-3/Q5]**, **[design]**.
- Verdict up front: **both payload-partition proposals (DeepSeek's and
  mine) are falsified by the Codex interruption case; MiMo's single
  correlated-event model survives the five required adjudications and is
  the ideal seam, with two explicit provider-authoring clauses and a
  staged adoption decision driven by the external-provider inventory.**
  Core reporting ownership should converge on one `AgentService` report
  owner regardless of which seam is shipped first.

## CX.1 Required adjudication 1 — the payload partition is false [code]

DeepSeek G2.2 and my G.2.2 partition outcomes by *kind*:
completed/failed results travel only the native channel;
stopped/transport-failed ("tokenless") outcomes travel only settlement.
Current Codex source contradicts the exhaustiveness of that partition:

- On an accepted native interrupt, `finalize` builds a normal
  `RuntimeCompletion` (`completionFromTerminal` →
  `{status:'completed', resultText: partial}`), **skips the result sink**
  (`terminal.status === 'interrupted'`, `turn-manager.ts:296-301`), and
  settles its bound members with `{kind:'completion', completion}`
  (`turn-manager.ts:302-303`). The delivered adapter test pins this.
- That settlement is therefore neither "a completion via the native
  channel" (sink skipped) nor "tokenless" (it carries a completed
  `RuntimeCompletion` with partial text). Under either partition,
  suppressing completion-bearing settlement deliveries for armed
  members loses an existing, in-scope bound-interruption result
  (rev-3: "Existing submission-associated failure/interruption outcomes
  remain in scope"). Manufactured alternatives are forbidden: changing
  its status/text to stopped or emitting an unbound interruption report
  both violate rev-3.
- DeepSeek's "when the requester is the owner the tokenless outcome
  still reaches the owner" (G2.2) does not rescue it: the Codex case is
  not tokenless, and in the greenfield arming model member submissions
  carry no per-request owner recipient at all — the owner is an entity
  subscription, so the distinction has to be made at the event.

Consequence: the boundary cannot be "completion vs tokenless". It must
be **"turn event (three terminal states, with its answered inputs) vs
input-scoped outcome with no turn"**. The interrupted terminal has to be
published on the native channel so one policy can route it. This is
exactly MiMo's `TurnResult{completed|failed|interrupted}` event and its
rule "interrupted → answered-request recipients only; armed owner gets
it only when the turn answered inputs; unbound interrupted → none".

Exact recipient/outcome/wording under the revised model:
Codex interrupted-with-partial-text bound turn → the event carries
`interrupted` + the answered submissions; the armed owner receives one
notice preserving today's delivered content (a completion-shaped result
with the partial text, as the shipped behavior and test state); Claude's
interrupted frame (settles `stopped`, no text) → one stopped notice to
the same recipients; unbound interruptions produce nothing. The
Codex/Claude content difference is preserved as a [product] copy fact,
not silently unified (per adjudication 1's instruction to name the
cost: the public event represents interruption uniformly while the
notice body may derive per-runtime answer value; uniform wording is a
separate product-text decision).

## CX.2 Required adjudication 2 — completing the correlated-event model [design, costs named]

MiMo's event `turnResults({result, answered: RuntimeRequest[]})` is
viable only if the binding questions are closed:

1. **Handle creation and provider reference.** Reuse the existing
   `RuntimeSubmission` handle rather than inventing `RuntimeRequest`: the
   provider already creates it synchronously inside `submit`
   (Claude registers `PendingRequest` before the stdin write,
   `rpc.ts:99-117`; Codex creates the deferred before `turn/start`,
   `turn-manager.ts:137-139`), and Core already receives it through the
   admitted `RuntimeAdmission`. The event's `answered` is
   `readonly RuntimeSubmission[]` — references within one process, no
   serialization, no Core type leaks provider-ward beyond the handle it
   already owns.
2. **When Core binds the reply recipient.** At `submitInput` admission,
   synchronously with the admitted handle: the ordinary member path
   binds none (entity subscription is the arming fact); the
   managed-Team explicit-request path binds the Dispatcher agent
   (today's `deliverCompletionToDispatcher`/`completionRecipient`);
   Workflow binds no notice recipient (script reads the answer value).
   This replaces the recipient field riding the submission input with
   an AgentService-owned admitted-input record keyed by the handle.
3. **Terminal-before-admission race.** An event naming a handle whose
   admission Core has not seen yet must not wait on an unknown promise
   or reorder. Two source facts close it: Claude registers before write
   and result frames follow the write/lifecycle ordering; Codex already
   gates terminal drain on in-flight admissions
   (`releaseAfterAdmissions`, `drainTerminalOrder`,
   `turn-manager.ts:273-282`). It becomes one explicit provider-authoring
   clause: **a terminal event naming answered submissions MUST be
   emitted only after those `submit` calls have resolved their
   admission** (input-scoped outcomes have no such gate). The policy
   then resolves recipients by synchronous handle lookup; an unknown
   handle is a provider contract violation (fail-loud in conformance
   tests), not a hold/queue. This is a *request-correlation identity*
   (object handle), distinct from the deleted *completion-value
   identity* fold — it does not make the WeakMap fold necessary.
4. **Rejected/skipped/ambiguous admissions** never produce a turn
   event: they resolve as input-scoped answers from `submit` itself
   (existing vocabulary), feeding the same report owner's no-turn path.
   **Close racing admission** is already guaranteed by the
   `AgentRuntime.stop` contract ("MUST NOT resolve while an
   already-started admission can still resolve to a newly accepted
   submission") and by Codex's admission gate; the event model changes
   none of it, and convergence waits on the same admitted work.
5. **Folded inputs:** the event lists every answered handle; the policy
   builds a recipient *set*, so N Dispatcher requests folded into one
   leader turn produce one notice without any completion WeakMap.

Rejected alternative within this adjudication: Core-issued correlation
ids on `submit`. It would change the deliberately text-only submit seam
and move provider attribution into Core; the existing handle lifecycle
already supplies identity, so it adds a mechanism without a consumer.

## CX.3 Required adjudication 3 — residual consumers after single-sourcing [code]

- **Q5 folded replies survive without the completion fold.** Several
  explicit Dispatcher requests can be answered by one leader turn; the
  event's answered set plus recipient-set dedupe is the replacement
  representation — the fold *concept* (N requests → one delivered fact)
  remains; only its *mechanism* (cross-package same-object WeakMap
  token) is deleted.
- **Workflow scripts** keep consuming `admission.turn.settled`
  (`workflow-service/run.ts:583-586`): the handle's answer promise stays
  (value channel), with `TurnResult`-shaped outcomes; no delivery side
  effect.
- **Public `turn_id`** is a real consumer: `teamSubmitResult` returns
  `admission.turn.id` (`team/requests.ts:122`) and the tool receipt
  schema declares it (`turn_id: STRING`). The admitted-input handle
  retains its id; greenfield request handles must keep one.
- **`CompletionDeliveryPolicy` itself is not deleted:** per-recipient
  FIFO tails, bounded attempts, the dispatcher fence, and
  prepare/submit transport remain; the `completions` WeakMap identity
  fold goes (one event = one enqueue makes it unreachable), and
  `deliver()` for Workflow run terminals stays.
- Non-member completion consumers today: the Dispatcher agent and
  TeamLeader never receive their own sink results (not armed); their
  explicit upstream answers are answered-handle routes. No hidden
  subscriber was found in source; final reconciliation should grep
  `completionRecipient` producers once more, but the residual set is
  {Q5 explicit requests, Workflow script values, Workflow-run terminal
  facts}.

## CX.4 Required adjudication 4 — the owner port must keep the fence in the real owner [code]

DeepSeek's "delete the `DispatcherService.submitInput` hop; DispatcherAgent
is the owner" is not byte-equivalent: the service entry wraps the
aggregate `fence.admit` (`dispatcher-service/index.ts:355-360`);
`DispatcherAgent.submitInput` calls `mustAgent().submitInput` with no
such gate, and during shutdown the aggregate fence can be closed while
the contained agent still runs. Revised position: **one structural
collection-owner view** (name/role/status descriptor, recipient-free
fenced inbox, completion initiator) is right and removes the delivered
`completionOwner` + `messagingOwner` pair, but for the Dispatcher the
view is assembled at the composition root as a small owner adapter whose
`submitInput` is `fence.admit(() => agent.submitInput(...))` and whose
completion methods delegate to the contained agent (it already
implements `CompletionInitiator`, `agent.ts:185-191`). The policy lives
with the real owner of the aggregate fence; the adapter is composition
(three facts, no new service), not a forwarding wrapper that hides a
gate, and it preserves queued-delivery semantics and the
`mustAgent()`/prepared-runtime lookup points (`prepareCompletion`'s
unsupported-when-stopped behavior is untouched). Team's view is
`TeamService` itself, as today. Scope ownership (which collection an
entity belongs to) stays the collection's `teamScope`/store fact; the
owner view is only the conversational target — distinct facts, one
object.

## CX.5 Required adjudication 5 — compatibility, by the actual selected route [code/policy]

| Direction | Delivered overlap seam | Event model (ideal seam) |
| --- | --- | --- |
| Old provider binary on new host | loads; bound reports survive via settlement delivery; unbound silent — documented nonconformance | loads only if host keeps accepting handle-only admissions; **all** owner reports (bound included) depend on events — silently absent for a non-emitting provider; script value channel must remain handle-based to survive |
| New provider on old host | bare `results(...)` throws on first terminal (documented minimum-host) | unsupported: old host never emits events the new provider expects to drive delivery, and submit's answer semantics differ |
| TS source | additive inbound context; fixtures construct, `typecheck:tests` pins | **replacement**: event shape, `TurnResult`/answer vocabulary, interrupted emission; provider + fixtures + Core change together |
| Persisted state/config | none | none; ordinary change-note policy applies; no migration authorized |

README minimum versions are documentation, not enforcement (the input
forbids claiming otherwise). The external
`AgentRuntimeProvider` inventory is unknown and is the one fact that
selects adoption path; it is an adoption-risk fact, not an ideal-design
veto, and a hypothetical future recipient is not a blocker.

## CX.6 Revised complete recommendation

**Ideal (greenfield) shape:**

1. *Neutral seam.* `submit` keeps returning an admitted handle with an
   id and an answer promise (value, no delivery). Create context gains
   one leased, synchronous, non-throwing `turnResults(event)` where
   `event = { result: TurnResult(completed|failed|interrupted,
   resultText, error|null), answered: readonly RuntimeSubmission[] }`,
   emitted once per observed terminal in terminal order, including
   interruptions; connection-level failure, refused/discarded inputs,
   and teardown emit nothing and settle/fail answers as input-scoped
   outcomes. Two authoring clauses: same-process handle references in
   `answered`; admission-before-terminal for answered events.
2. *One Core report owner.* `AgentService` (replacing EntityTurn's
   delivery role — knowingly superseding the R71 placement while
   preserving R71's removals: no recipient suppliers, no private-owner
   closures; the owner queries the real owner port at the ownership
   boundary) applies one rule at event time: recipients = armed
   conversational owner (when status ∈ completed/failed, or interrupted
   with nonempty answered) ∪ each answered handle's bound reply
   recipient (Q5 requests; interrupted regardless of status per the
   answered answer), deduplicated as a set; `owesCompletion()` gate read
   once at publication; enqueue via the existing policy transport;
   track started deliveries in the existing in-flight work joined at
   close/host stop (fail-loud unsettled-answer proof retained). Inputs
   that end without a turn (pre-admission/transport outcomes) route only
   to their bound reply recipients. The entity's admitted-input record
   is lightweight: handle id, answer recipient, settled outcome; it no
   longer owns policy invocation, report promises, or shutdown
   delivery.
3. *Arming.* Construction-time subscriber for ordinary builds of both
   collections through the one owner view; TeamLeaders, the Dispatcher
   agent, and locked Workflow builds are not armed; reopen re-arms; no
   persisted category.
4. *Q5* is structural: leaders answer only explicit requests (handles
   bound to the Dispatcher agent by `team.create`-prompt/`team.send`;
   prompt-less create and Channel/admin requests bind none); later
   autonomous turns have no answered requester and no subscription.
5. *Messaging* stays the delivered member scope (`send`/`list`,
   host-bound `from`, owner inbox, collection peer send/reopen/locks),
   unchanged by this seam work.

**Ordering:** completed/failed notices equal terminal order by
construction (synchronous single publication); the interrupted/stopped
continuation interleaving residual disappears for turn-bound outcomes
(they are in the event) and remains only for genuinely input-scoped
outcomes — documented, unsequenced.

**Actual removals vs delivered:** EntityTurn-as-deliverer (recipient,
delivery task, policy call, owner query; value/settlement/convergence
record retained); the `completions` WeakMap fold and same-object
cross-package clause plus its reference-identity test family;
`completionOwner`+`messagingOwner` option pair (one owner view with the
fence kept at the Dispatcher composition root); dual fact derivation;
Codex orphan bookkeeping (already removed). **Retained:** handles,
answer settlement, admission ledger, policy FIFO/fence/attempts and
Workflow terminal delivery, leases, all messaging/reopen/lock/state
contracts. **Added:** `TurnResult` + answered event, the one rule,
admitted-input reply binding, interrupted emission in both adapters.

**Adoption classification:** relative to HEAD the event seam is the
unavoidable provider-observed capability (adaptation of shape,
replacement of settlement-as-delivery); relative to the delivered
worktree it is a **replacement of the public neutral contract**, not an
adaptation — larger provider diff, but the Core single-owner
consolidation is independently justified and can land first on top of
the delivered additive sink (internal replacement, no seam change).
Recommended sequence is therefore conditional: if the external-provider
inventory is effectively the two in-tree adapters, adopt the event seam
directly; if external providers rely on settlement-triggered delivery,
the delivered overlap shape is the legitimate transition vehicle —
move Core to one report owner now, replace the seam and delete the fold
in a later declared contract bump. No negotiation bits, fallback
entities, or queues are introduced in either path.

## CX.7 Accepted and rejected arguments, summarized

- Accepted: MiMo's three-state result + answered event as the only
  partition surviving the Codex interrupt case; DeepSeek's single owner
  view and its fold-deletion question (answered by the recipient set);
  the root notes' single-reporting-owner direction; required sink/event
  strength; `turn_id`/Workflow/Q5 consumer preservation; lazy owner
  descriptor; failure bodies unchanged.
- Rejected: DeepSeek's and my own completion/tokenless partition
  (CX.1); DeepSeek's fence-less Dispatcher owner (CX.4); wholesale
  deletion of the completion fold without naming the Q5/Workflow
  residual (now replaced, not merely deleted); MiMo's implication that
  `answered` removes identity needs (handle correlation remains,
  CX.2.3); any activity-seam, pull, quiet aggregation, or synthetic
  submission shape (earlier rounds, reaffirmed).

## CX.8 Strongest surviving counterexample and blockers

- **Strongest:** a conforming-seeming provider that resolves answer
  handles but omits/reorders the terminal event, or emits it before
  admission settles. Under the event model that silently drops the Q5
  reply itself (worse than a duplicate) or breaks recipient lookup;
  under the delivered overlap shape the failure mode is duplicate
  reports from a cloned object. Conformance is enforceable only by
  provider contract tests run against each provider (one event per
  terminal with answered set; admission-before-terminal; interrupted
  content parity; end-to-end `team.send` reply), not structurally by
  Core. This is the intrinsic price of single-sourcing and the reason
  the staged path exists.
- **Genuine blockers:** none technical. The decisions actually pending
  are (a) external-provider inventory → direct replacement vs staged
  transition (an adoption fact to gather, not a vote); (b) product
  acknowledgement that interrupted-bound notices keep per-runtime
  content (Codex partial text vs Claude stopped), with unification
  deferred as copy; (c) the already-recorded terminal-time stop
  eligibility, intrinsic to event-time reporting.

---

# Operator-delegated optimal architecture selection — independent proposal (2026-10-14)

Sole product input: requirement revision 3. Derived independently from current
source; earlier sections and the TeamLeader recommendation are evidence, not
the answer.

## Minimum model

Three facts, one policy. (1) **A native turn outcome** — provider-observed
terminal; `completed(resultText) | failed(error) | interrupted(partial?)`; 0..n
accepted inputs answered; only the provider observes it. (2) **An admitted
host input** — Core-created at `submit` admission, needs a receipt id, an
answer value for its actual requester (Workflow script; explicit
Dispatcher→Team request; ordinary owner-submitted work), and convergence at
stop. (3) **An addressed member message** — ordinary input, sender host-bound,
no special result machinery. Policy: an ordinary member has one conversational
owner subscribed to *every observed normal/failed outcome*; a managed
TeamLeader has only one-shot request answers; Workflow consumes values in
process. No quiet fact, hierarchy subscription, per-sender channel, or
turn registry exists in the product.

## Candidate 1 — completion-valued submissions + narrow result observation

Keep `RuntimeSubmission.settled` carrying `RuntimeCompletion`; add one
required leased sink `results(completion)` publishing every normal/failed
terminal synchronously in terminal order, same frozen object the settled
inputs receive. One `AgentService` reporting owner applies: armed subscriber
+ per-input reply claimants; fold is the existing per-recipient token
WeakMap; interrupted terminals publish nothing and settle answers as today
(Codex: completion with partial text, `codex/src/turn-manager.ts:294-303`;
Claude: tokenless stopped, `claude-code/src/rpc.ts:309-330`).

*Costs:* the one report's identity lives in a cross-package object-identity
convention (a clone silently double-delivers); delivery of a bound result
has two observation sites whose payloads must be worded identically;
eligibility is read at terminal publication for the subscriber and at
settlement for one-shot claimants — two instants that are both required
(they answer different preserves-clauses). *Deletions:* the delivered
dual delivery machinery inside Core collapses to one report owner
(`EntityTurn` loses recipient/delivery state, keeps selected outcome and
settled promise); Codex orphan bookkeeping already removed.

## Candidate 2 — single authoritative outcome stream; Core-owned input promises

Provider publishes one ordered event per terminal:
`turnOutcome({ id, status, resultText, error, answeredInputIds })`. `submit`
returns an admission whose `answer` Promise is resolved by **Core**, which
correlates terminal events to inputs it issued; result subscriptions and
request replies are both decided at the one Core event handler.

*Genuinely disappears:* cross-package same-object discipline; dual
observation; the token WeakMap; per-input completion attachments in the
provider. *Genuinely new:* **provider→Core input identity**. Today the seam
is deliberately text-only; Codex binds a `turn/start` response to its native
turn and a terminal can be observed before the admission continuation runs
(`turn-manager.ts:161-173`; Claude registers requests before the write,
`rpc.ts:99-117`). The provider must therefore name Core inputs at the wire
boundary and hold answered-id bookkeeping across terminal-before-admission,
rejected/skipped/ambiguous admissions (which produce answers with no
terminal), and stop-racing-admission — plus idempotent redelivery rules.
Core gains an input registry, an event→promise resolver, ordering across
terminal events and terminal-less input answers, and a new public ABI every
provider rewrites. The fold becomes set-dedup of ids; equal-text distinct
turns stay distinct by terminal id. Falsification coverage is larger
(missing event drops even a `team.send` reply — worse than a duplicate),
and the ABI is replacement-class for external providers.

## Selection: Candidate 1

Criterion: concepts a future maintainer/provider must hold against behavior
the product actually requires. The two facts' lifetimes differ (a terminal
exists with zero inputs; an admission answer exists with no terminal), so a
single stream needs a controller that re-imports the correlation the provider
already computes natively — moving real machinery across the seam to delete
a WeakMap, while adding an identity the neutral seam was designed not to
carry. Candidate 1 keeps each fact's owner (provider: terminal/attribution;
Core: entitlement), adds one house-shaped leased push channel, and removes
Core's internal duplicate delivery lifetime. The remaining convention risk
is pinable by reference-identity tests; Candidate 2's event-loss risk is
only catchable per provider.

## Interface sketch (adaptation of delivered seam)

```ts
readonly results: (completion: RuntimeCompletion) => void; // required, sync, non-throwing, leased
// every normal/failed terminal, once, in terminal order, same object as settled answers;
// interrupted/transport endings: no call. submit()/settled/receipt id unchanged.
```

Arming is a construction fact (ordinary builds of both collections; never
leaders, Dispatcher agent, locked Workflow builds). One-shot claimants ride
the existing `completionRecipient`/`deliverCompletionToDispatcher` binding.
Started deliveries share one `AgentService` in-flight set drained after
runtime stop and accepted-input settlement at both close and host stop;
publication is fenced before teardown; eligibility: terminal time for
subscriptions, settlement time for one-shot answers; started work is never
retracted. Result order guarantee covers normal/failed outcomes only; the
stopped/transport continuation residual stays documented, not sequenced.

**Classification:** additive neutral adaptation (field exists in the
delivered tree) + Core-internal ownership replacement. **Version pairing:**
new host/old provider = loads, bound answers survive via settlement, unbound
silent (documented nonconformance); new provider/old host needs the
documented minimum host (bare call). **Acceptance:** mandatory cases in the
input map to: multi-input one-report fold; distinct queued turns distinct
objects; terminal-before-continuation order; leader N-requests-one-reply and
autonomous silence; script `settled` values + public `turn_id`; Codex partial
interruption vs Claude stopped; input-only failures; stop/close fail-loud
convergence; scoped fences; both collections.

**Strongest counterexample:** a conforming provider that settles inputs with
a structurally cloned completion — undetectable by types, duplicates owner
reports. Mitigation is contract + reference-identity/order test per adapter,
not mechanism; Candidate 2 converts that failure into silent dropped replies,
which is why the tradeoff favors Candidate 1.

---

# Optimal-architecture cross-review — final adjudication (2026-10-14)

Inputs: DeepSeek (selects 1), MiMo (selects 2), my 10-14 section (selects 1),
plus the added owning-source precision. Not a vote; adjudicated against source.

**Challenge 1 (registry accounting).** Fair correction accepted: in candidate
2 a Core-minted `inputId` can replace today's receipt id and its map replaces
the retained-input record — not a third id system. But provider-side native
attribution survives either way: Codex keeps `nativeTurns` (representative,
members, `releaseAfterAdmissions`, `terminalOrder`, `turn-manager.ts:120-173,276-303`);
Claude keeps `PendingRequest`/consumed sets and the control channel
(`rpc.ts:83-118,278-289`). The provider still groups native turns; candidate 2
moves the *label* to Core, it does not delete grouping.

**Challenge 2 (text-only ABI is not an argument).** Accepted as method; the
real extra duties candidate 2 imposes are: echo Core ids across the native
wire, publish terminal-before-admission ordering against provisional Core
state, and state the *selected per-input outcome* (challenge 4). Those, not
the current seam's preference, are its cost.

**Challenge 3.** Both failure classes stand: candidate 1's dual observation +
reference equality, candidate 2's wrong/missing `answered` association. A
single stream does not make once-per-terminal structural — double publication
is still a provider duty under either. Recipient-set folding needs no turn
ledger: agreed, set dedupe suffices.

**Challenge 4 + added precision — decisive.** `completionFromTerminal`
applies codec restoration to an *interrupted* `CollectedTurn` and can return
`{status:'failed'}` on codec error (`turn-manager.ts:419-433`); the sink skips
all interrupted terminals; bound members nonetheless settle with that
selected completion. Native cause therefore does not determine the per-input
outcome, and inferring completed/stopped from partial text or cause is
unsound. MiMo's event must therefore carry the explicit selected outcome per
answered input (completion-shaped, including codec failure), i.e. it
re-imports settlement payloads into the "single" event alongside the
terminal cause. Candidate 1 already transports exactly this via
`settled`; candidate 2 pays for a new ABI and still carries it.

**Challenge 5.** MiMo's record "created synchronously at the call site" is
wrong as a retained record: admission is async, and ambiguous/skipped writes
never become turns — Claude `failWrite` deletes the unconfirmed request and
returns ambiguous (`rpc.ts:153-185,249-275`); Codex failed `turn/start`
returns ambiguous without a handle (`turn-manager.ts:150-160`). Candidate 2
needs *provisional* records promoted only on `submitted` (the only point that
attaches an answer right today, `service.ts:313-357`), retired locally
otherwise — never held "until an event", never delivered upstream, invisible
to stop convergence. That is new lifecycle state candidate 1 already handles
by having no pre-admission record.

**Challenge 6.** Candidate 1 keeps two eligibility instants because they
encode different preserves: subscription at terminal publication, Q5
one-shot claimant at settlement (current stop suppression,
`turn.ts:127-152`). Candidate 2 unifies at publication — an admitted
microtask-window movement of managed-leader reply suppression; real, must be
recorded as product behavior if 2 were chosen.

**Decision: candidate 1** — settled per-input completion values + required
leased `results(C)` + one `AgentService` reporting owner (EntityTurn retains
only outcome/settled value; per-turn delivery state, one tracker, and the
`{owesCompletion}` indirection deleted). It needs no provisional registry,
no id echo across native protocols, no cause→outcome inference, and no
eligibility movement for Q5; candidate 2's only structural win (no
same-object duty) is offset by re-importing per-input outcomes into its event
plus ABI replacement for both adapters and external providers. Optional
`results?` is a documentation-policy variant, not architecture.

Net additions: one sink type/field, one leased closure, one agent-owned
delivery set, per-adapter emission. Net deletions: EntityTurn recipient/
deliveryTask/ensureDelivery, dual tracker, dual fact wording, Codex orphan
bookkeeping. Strongest surviving counterexample: a provider cloning C
double-delivers while healthy — contained only by reference-identity and
delivered-order tests per adapter.
