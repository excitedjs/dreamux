# Technical solution proposal: proactive Team member messaging (MiMo)

- Status: independent proposal for solution selection. Not a final solution and
  not implementation approval.
- Requirement authority: [requirement revision 1](../../requirement.md),
  finalized 2026-10-13 after accepted decisions Q1, Q1a, Q2, and Q3.
- Scope of this file: the complete technical approach — owning components,
  end-to-end behavior, contracts, provider compatibility, lifecycle and result
  identity, acceptance mapping, and named risks. Design choices are mine;
  anything user-visible that the requirement did not already settle is flagged
  where it appears.

## 1. Design summary

Two capabilities land together, sharing one construction-time arm and one
result-identity discipline:

1. **Member messaging** — an ordinary Team member's runtime gets a member-scoped
   `teammate` MCP delegate exposing exactly `send` and `list`. `send` addresses
   the TeamLeader or a same-Team peer by concrete name; the delegate stamps the
   sender identity from the host-owned scope, never from the model. Peer sends
   ride the collection's existing `send` verb (which already reopens closed
   members and already stamps the Team as completion owner), and leader sends
   ride `TeamService.submitInput` with **no** completion recipient.
2. **Native-result reporting** — a new neutral `AgentRuntimeResultSink` on the
   runtime create context carries every provider-created `RuntimeCompletion`
   from a normally completed or failed native terminal, whether or not a
   Dreamux submission settled with it. Core delivers it to the Team through the
   existing `CompletionDeliveryPolicy`, folded against submission settlement by
   the shared completion identity, so one native result produces one report.

The two capabilities are armed by the same construction gate: ordinary members
built by a Team's `TeammateCollection` (spawn, materialize, reopen) get both;
Workflow `createLocked` members get neither; Dispatcher-scoped members, the
TeamLeader, and the Dispatcher agent get neither.

Wording alignment is part of this solution: the completion notice states the
observed fact (a turn ended and produced this output) instead of "has finished
its task", and the member's role prompt names its TeamLeader and the messaging
channel.

## 2. What the requirement fixes (recap of the binding constraints)

- **Q1**: every provider-observed normally completed native turn of an ordinary
  Team member reports its result to that Team's TeamLeader, bound or unbound;
  one native completion reports once even when submissions fold into it;
  separate completions report separately (aggregation is explicitly rejected);
  the report states the native-turn result and does not claim goal achievement.
  Coverage does not extend to unbound interrupted turns, Workflow members,
  Dispatcher-scoped members, or the TeamLeader's own turns.
- **Q1a**: provider-observed failed native turns report failure once even
  unbound; the same failure reported through settlement and observation
  delivers once; owner-stop suppression stands; no fabricated terminals.
- **Q2**: an explicit peer send to a durably closed same-Team member reopens
  that same member under existing recovery rules, then submits; existing Team
  and entity fences still govern; no lifecycle tools are granted.
- **Q3**: members controlled by a running Workflow get no new tools, keep
  refusing ordinary input through the held lock, and keep returning results to
  the script without ordinary-member automatic reports.

## 3. End-to-end behavior

### 3.1 Peer exchange across turns

Member A calls `send` `{ name: "B", prompt: "what is the status of X?" }`. The
delegate refuses `name === A`, resolves "B" through the Team's member
collection, stamps `attrs: { from: "A" }` on the submission, and returns an
admission receipt immediately. B's runtime receives `<task from="A">…</task>`
(Codex steers an in-flight turn; Claude queues behind it — documented, not
special-cased). B's turn settles: its result reports automatically to the
TeamLeader (the collection stamps the Team as completion owner — unchanged).
B answers A only by an explicit `send` `{ name: "A", … }`, which A receives
with `from: "B"` after A's own earlier turn has ended. No relay, no copy of
either message to the TeamLeader.

### 3.2 Mid-turn report to the TeamLeader

Member M calls `send` `{ name: "<leader name>", prompt: "blocked on credentials" }`.
The delegate routes by name to `TeamService.submitInput` with the same `from`
stamping and **no** `completionRecipient`, so the leader's turn that processes
the message creates no automatic reply to M and creates no new Dispatcher
obligation (the Channel-originated rule, applied to member-originated turns).
The leader replies with its own existing `send` tool, which reaches M as
`<task from="<leader>">…</task>`.

### 3.3 Background chain (the Q1/Q1a case)

Leader spawns M: "run the tests and fix failures". Turn 1 (submitted) ends
"Tests running in background." — settlement reports once. A background
completion later drives native turn 2 with no Dreamux submission: the provider
creates a `RuntimeCompletion` for that result and reports it through the result
sink; `AgentService` delivers one report to the TeamLeader ("TeamMate M has
finished a turn. Output below: …"). A later failed background turn reports
"TeamMate M's turn failed." with the error text once. A native turn interrupted
without a completion reports nothing (Q1/Q1a boundary); a submission settled
`stopped` by that interruption keeps its existing single "was stopped" report.

### 3.4 Closed and Workflow-controlled recipients (Q2/Q3)

`send` to a durably closed peer enters the existing `sendReopened` → `reopenFrom`
path: the same member record reopens under runtime-session recovery, then the
message submits; results still report to the TeamLeader; a dissolving Team is
refused by the Team fence before any reopen. A member inside a running
Workflow's lock refuses the peer send through `AgentService.enterOrdinaryMutation`
(unchanged), and because `createLocked` members were never armed, they cannot
message anyone and their unbound results are not reported.

## 4. Owning components and boundaries

| Component | Owns | Change |
| --- | --- | --- |
| `@excitedjs/dreamux-types` `agent-runtime.ts` | Neutral runtime ABI | Add `AgentRuntimeResultSink` and the `results` member on `AgentRuntimeCreateContext` |
| `packages/dreamux/src/service/agent/mcp.ts` | The `teammate` MCP delegate, scopes, catalogs, tool copy | Add the `team_member` scope arm, `teamMemberToolRecords` (`send`/`list`), host-bound `from` stamping on `send`, member-send receipt copy |
| `packages/dreamux/src/service/agent/index.ts` | `TeammateCollection`: construction, reopen, per-entity options | Add `memberSurface` option; arm `mcp` + `nativeResultReporting` for ordinary Team-member construction; thread `attrs` through `sendResolved`; pass `self`/leader facts into the delegate and prompt |
| `packages/dreamux/src/service/agent/types.ts` | `SendTeamMateInput` | Add optional `attrs` (host-stamped provenance) |
| `packages/dreamux/src/service/agent/submission-sources.ts` | Core provenance names | Unchanged (`task` + `from` attribute; no new source name) |
| `packages/dreamux/src/service/agent/service.ts` | `AgentService`: submissions, turns, delivery convergence | Add `reportNativeResult` (armed-scope + `owesCompletion` + shared fact + `deliverRuntime`); pass the sink into `RuntimeGeneration` |
| `packages/dreamux/src/service/agent/runtime-generation.ts` | Per-generation launch context | Build `results: generationResultSink(lease)` beside `activity`, same lease gate |
| `packages/dreamux/src/service/agent/turn.ts` | `EntityTurn`, outcome→fact mapping | Extract the shared `RuntimeCompletion` → `PreparedCompletionFact` mapping both delivery paths must use |
| `packages/dreamux/src/service/agent/completion-renderer.ts` | Push notice wording | Turn-granularity status lines (§8) |
| `packages/dreamux/src/service/agent/system-prompt.ts` | Member role prompt | Leader name + messaging sentence for armed members |
| `packages/dreamux/src/service/team/service.ts` | `TeamService` as members' owner | Supply `memberSurface` (`leaderName`, `submitToLeader`) to its `TeammateCollection` |
| `packages/agent-runtime/claude-code` | Claude settlement | Report every non-interrupted result completion to the sink (bound and unbound) |
| `packages/agent-runtime/codex` | Codex turn manager | Report non-interrupted turn-record completions to the sink, including unbound observed turns |
| `packages/dreamux/src/service/completion-router/index.ts` | Folding and delivery policy | **Unchanged** |

Boundaries that hold: Core keeps zero provider vocabulary; the sink is the
third neutral fact channel beside submission settlement and the display
activity sink, and the display seam is not repurposed. Channel code is
untouched. No new service class, no mailbox, no persisted state.

## 5. Member MCP surface (public model-facing contract)

### 5.1 Scope arm

```ts
// packages/dreamux/src/service/agent/mcp.ts
export interface TeamMateMcpTeamMemberScope {
  /** Host-bound sender identity; the model never supplies it. */
  readonly self: string;
  readonly leaderName: string;
  /** This Team's member collection (structurally `TeammateOps`). */
  readonly teammates: TeammateOps;
  /** `TeamService.submitInput`, bound by the Team that owns the members. */
  submitToLeader(input: TeammateSubmitInput): Promise<TurnAdmission>;
}
```

`TeamMateMcpScope` gains `{ kind: 'team_member', member: … }`. The delegate
builds `teamMemberToolRecords(scope)` for that arm only — the leader/dispatcher
catalog (spawn/close/history/status/last/get_capabilities and the Workflow
tools) is not advertised and not reachable. Authorization stays structural:
role = frozen catalog (existing MCP-lease discipline).

### 5.2 `send`

- Input: `{ name: string (1..64), prompt: string (1..20000) }`. No `intent` —
  a peer must not rewrite another member's recorded recovery subject.
- Routing: `name === leaderName` → `submitToLeader` with
  `{ source: AGENT_TASK_SOURCE, attrs: { from: self }, text: prompt }` and no
  `completionRecipient`; otherwise `teammates.send({ name, prompt, attrs: { from: self } })`.
- Refusals (business results, not exceptions): `name === self` (a self-send
  would steer/queue the sender's own in-flight turn); unknown or wrong-Team
  names resolve as "does not exist" through the existing scope check; a locked
  (Workflow) recipient refuses through the existing ordinary-mutation fence; a
  closing Team refuses through the Team fence.
- Output: `AgentEntitySubmissionResult` — `{ status: submitted | duplicate | stopped | failed | ambiguous, error? }` via the existing `toSubmissionResult` projection of the `TurnAdmission`. Deliberately narrower than `teammateReceiptSchema`: the member's question is "was it admitted", not a roster read. Receipt copy is new (the existing `TEAMMATE_DISPATCH_SUCCESS_REMINDER` promises a later pushed completion, which a member sender never receives): it must state that admission proves neither model receipt nor execution, that a reply arrives only if the recipient explicitly sends one, and that the recipient's completed turns report to its TeamLeader rather than to the sender.

### 5.3 `list`

- Input: none.
- Output: `{ leader: { name, status }, teammates: [...] }` — the TeamLeader's
  concrete name and identity status (from the surface's owner), plus the
  existing compact member rows from `TeammateOps.list()` with `self` filtered
  out. This is the whole addressing story: one flat namespace in which the
  leader's dispatcher-global, never-reused name cannot collide with a member's,
  so no reserved pseudo-name exists.

### 5.4 Sender identity and provenance

`SendTeamMateInput` gains `attrs?: Readonly<Record<string, string>>`, threaded
through `sendResolved` into `TeammateSubmitInput`. The member and leader
delegate scopes each carry the host-bound caller name (structurally, at
delegate construction); the shared `send` handler stamps
`attrs: { from: <scope caller> }` on every send, so a recipient can always
distinguish and address its sender, and the model can never spoof it. Source
name stays `AGENT_TASK_SOURCE` (`task`) — the messaging fact is the `from`
attribute, and a new source name would add a concept whose only job is to
encode one bit. `spawn` and the Dispatcher Command paths are unchanged.

### 5.5 Role prompt

For armed members the membership sentence becomes (exact copy is
implementation, content requirements are):

- identifies the Team, the member's own name, and the **TeamLeader's concrete
  name**;
- keeps the now-true delivery promise — "Your TeamLeader receives what you
  output when your turn ends" (Q1/Q1a removed the background exception);
- states that `send` messages the TeamLeader or a same-Team peer, `list` shows
  whom, a message reaches the recipient's next chance to act, and a reply comes
  back only when the recipient explicitly sends one.

The existing gate (sentence omitted when an operation append is present) is
kept as-is; the tools arm uses the explicit construction flag in §6, never the
prompt shape.

## 6. Construction-time arm (Q3 gate)

`TeammateCollectionOptions` gains one optional field:

```ts
/** Supplied by TeamService; null for the dispatcher's own collection. */
memberSurface: {
  leaderName: string;
  submitToLeader(input: TeammateSubmitInput): Promise<TurnAdmission>;
} | null;
```

`TeamService` passes itself structurally (its `submitInput` already exists as
the Team's single leader-submission entry); the dispatcher collection passes
`null`. Per-entity options then arm exactly when **both** hold:

1. `memberSurface !== null` (a Team's members, not Dispatcher-scoped members),
   and
2. the construction path is ordinary — spawn, materialize, or reopen —
   determined by an explicit flag threaded from the entry points, never
   inferred from `CreateLockedTeammateOptions` shape. `createLocked` (the
   Workflow path) passes the flag as disarmed.

Armed entities get `mcp` (`TeammateAgentMcp` with the member delegate) and
`nativeResultReporting` (§7.3). The arm never changes mid-life: a
Workflow-locked member is disarmed for its run-scoped lifetime (the Workflow
closes its members at terminal), and a closed record's historical creation by a
Workflow is irrelevant — a reopened record takes the ordinary path and becomes
an ordinary member, exactly as Q3 states.

## 7. Native-result capability (provider-neutral)

### 7.1 Contract

```ts
// packages/dreamux-types/src/agent-runtime.ts
/**
 * Optional in practice, required on the context: Core always supplies it.
 *
 * Reports each provider-created `RuntimeCompletion` at a normally completed or
 * failed native terminal, whether or not any `RuntimeSubmission` settled with
 * it. The value MUST be the same immutable completion object handed to settled
 * submissions for that native result — one native result, one identity.
 * Terminals the provider reports as interruptions produce no observation (a
 * provider that settles bound requests with pre-interrupt output keeps that
 * settlement path exactly as today). Synchronous and non-throwing like
 * `AgentRuntimeActivitySink`, and generation-scoped: a revoked generation's
 * late reports are dropped. A provider that never calls it leaves unbound
 * results unreported, which is today's behavior.
 */
export interface AgentRuntimeResultSink {
  (completion: RuntimeCompletion): void;
}
```

`AgentRuntimeCreateContext` gains `readonly results: AgentRuntimeResultSink`.
Additive for providers; no persisted state; no Core vocabulary of providers.

### 7.2 Producers

- **Claude Code** (`rpc.ts` result handler): for every non-interrupted result,
  build the completion via the existing `completionFromTurnOutcome` (the same
  session-pin / structured-output mapping), settle the answered requests with
  it, and call the sink once — replacing today's `answered.length === 0 ? null`
  drop of the whole completion. Interrupted results keep settling `stopped`
  with no completion and no observation. "Background origin is not completion
  ownership" holds unchanged: origin never routes; the sink carries the
  completion regardless of which internal input the result answered.
- **Codex** (`turn-manager.ts`): at each native terminal where the turn record
  gains a completion and the terminal was not an interruption, call the sink
  with that record's completion — including turns no Dreamux submission bound
  (the `unboundObservedTurnIds` category, today released display-only). How
  often real Codex traffic produces unbound completions is unproven (risk §10);
  the contract does not assert frequency and does not special-case the provider.
- **External `npm:` providers**: the field arrives in their context; honoring
  it is their coverage decision. Not honoring it degrades their unbound results
  to today's silence — never to double delivery.

Rejected alternative, recorded on purpose: deriving unbound reports from the
activity stream (`turn.ended` + assistant text). The activity contract is
display-only, its text is already redacted by Core before any Channel sees it,
and `turn.ended` carries no result — reconstructing results from it would build
a second, lossy result pipeline beside the one that already exists at the
settlement boundary.

### 7.3 Core consumer

`AgentService.reportNativeResult(completion)`:

1. Not armed (leader, dispatcher agent, Dispatcher-scoped member, Workflow
   member) → return.
2. `!this.owesCompletion()` → return (owner close / host stop / Team teardown
   suppress, matching Q1a's "no new report … for work the owner itself ended").
3. Fact from the shared mapping (§7.4).
4. `this.deps.completionDelivery.deliverRuntime(recipient, completion, fact)`
   where `recipient` is `opts.completionOwner.completionRecipient()` queried at
   this moment — the same `CompletionInitiator` object the submission path
   stamps, preserving the router's single-recipient-per-completion invariant.

`RuntimeGeneration` builds `results: generationResultSink(lease)` beside
`activity`, with the identical revoked-generation gate; the sink reaches
`reportNativeResult` through a constructor collaborator its owning
`AgentService` supplies (composition of an owner's helper, not a new
service-to-service dependency).

### 7.4 Shared result identity and one fact mapping

`turn.ts` currently builds `PreparedCompletionFact` inline from an outcome. The
mapping from a `RuntimeCompletion` to a fact (source name, role, status,
result body) is extracted once and used by **both** `EntityTurn` (for
completion settlements) and `reportNativeResult`. This is fold-correctness, not
style: whichever path reaches `deliverRuntime` first inserts the delivery into
the router's completion-identity fold and the other joins the same promise, so
the delivered payload must be identical either way. With this identity
discipline:

- N submissions folded into one native completion → one report (existing
  invariant, unchanged);
- one bound native result → exactly one report, never a settlement report plus
  an observation report (acceptance: "not delivered twice");
- one unbound native result → one report;
- a failed result carries one failed completion object → one failure report
  even when settlement and observation both describe it (Q1a).

Payload decision flagged for review: the shared mapping carries the failure's
`error.message` as the report body for **both** paths (today's failed fact
carries `result: null`). Q1's "the report states the native-turn result" makes
the error the observed result of a failed turn, and a single mapping is
required so the fold cannot deliver two different bodies for one identity. If
the operator wants the failed body byte-identical to today, keep `result: null`
in the shared mapping; the design does not depend on the choice.

## 8. Wording alignment

`completion-renderer.ts` status lines move from task claims to observed facts,
uniformly across its three role subjects (the same renderer serves member,
leader, and dispatcher-agent completions):

- completed: `TeamMate X has finished a turn.` (role subjects unchanged)
- failed: `TeamMate X's turn failed.`
- stopped: `TeamMate X's turn was stopped.`

The Workflow line ("Workflow R has completed.") is untouched — a Workflow
terminal really is the run's completion. The requirement itself records that
"has finished its task" overclaims a submission/native-turn settlement; Q1 adds
that the report must not declare goal achievement. The exact copy is
operator-visible and should be read once at review.

## 9. Lifecycle, concurrency, and failure behavior

| Situation | Behavior |
| --- | --- |
| Idle recipient, explicit send | Existing `wake: true` path: the runtime starts/turns and processes (confirmed semantics) |
| Busy recipient | Runtime-native admission — Codex steers into the in-flight turn, Claude queues behind it. Documented in the tool description; no Core branch (acceptance criterion) |
| Self-send | Refused before dispatch |
| Wrong-Team / unknown name | "Does not exist" via existing physical-scope resolution |
| Closed peer (Q2) | Existing `sendReopened`/`reopenFrom`; concurrent sends join one reopen (`reopening` map); the reopened entity publishes only after the send succeeds |
| Workflow-locked peer (Q3) | Existing `enterOrdinaryMutation` refusal; no tools on that entity; no unbound reports from it |
| Team dissolving / host stopping | Existing Team fence and `selfCloseIfClosing` construction checks refuse the send or the reopen |
| Send admitted, recipient runtime dies | Existing admission outcomes (`stopped`/`failed`/`ambiguous`) in the receipt; the receipt copy already claims no delivery guarantee |
| Result observation racing a stop | The sink is generation-scoped (stale writes dropped); `owesCompletion` is read at delivery start; a delivery already queued is never retracted (existing policy) |
| Bound result observed before settlements resolve | Synchronous sink call precedes the settlements' promise chains; the shared completion identity folds both into one delivery |
| Leader receipt of a member message | No completion recipient on that submission: no auto reply to the sender, no new Dispatcher push (confirmed baseline) |

No new state is persisted; every mechanism above either reuses an existing
owner (fence, ledger, reopen map, delivery router, generation lease) or is one
named addition (the result sink, the member delegate, the `attrs` thread).

## 10. Reused / new / removed

- **Reused**: `TeammateCollection.send` (peer delivery, Q2 reopen, Team
  completion recipient), `TeamService.submitInput` (leader entry, no
  recipient), `CompletionDeliveryPolicy` identity folding and FIFO tails,
  `owesCompletion` owner-stop suppression, `enterOrdinaryMutation` Workflow
  lock, Team/entity admission fences, the provenance envelope
  (`TeammateSubmitInput.source`/`attrs`), the submission-receipt projection,
  MCP lease/frozen-catalog authorization, the generation lease pattern.
- **New**: `AgentRuntimeResultSink` + `results` context member;
  `AgentService.reportNativeResult`; the `team_member` scope arm with
  `send`/`list`; `TeammateCollectionOptions.memberSurface` and the
  construction-time arm; `SendTeamMateInput.attrs`; the shared
  completion→fact mapping; member-send receipt copy; prompt and status-line
  wording.
- **Removed**: nothing. No capability, tool, or report is deleted; the
  unbound silence of today is filled, and the "has finished its task" claim is
  corrected, not removed.

## 11. Provider compatibility, change files, knowledge delta

- `@excitedjs/dreamux-types`: additive contract field and interface; plain
  `minor` note (0.x line, not upgrade-blocking). External providers compiled
  against older types need no change to run.
- `@excitedjs/agent-runtime-claude-code`: result-sink wiring through the
  session/rpc options; its extension seam (`ClaudeCodeSession` factories own
  settlement) must call the sink for full coverage — documented in the package
  README with a plain `minor` note. A custom factory that ignores the sink
  degrades to today's unbound silence; folding stays correct because settlement
  is unchanged.
- `@excitedjs/agent-runtime-codex`: turn-manager sink wiring; plain `minor`
  note.
- `@excitedjs/dreamux`: MCP surface addition (member scope `send`/`list`),
  wording and prompt changes; plain `minor` note.
- No config, no persisted state, no path contracts → no
  `dreamux-maintenance` change, no `BREAKING:`/`Rebuild:`.
- Knowledge delta (same change as implementation): product catalog rows for
  member messaging and the revised background-work/completion entry (its "does
  not automatically push" sentence is reversed for ordinary Team members under
  Q1); `provider-runtime.md` (result-sink contract; the "creates no request
  completion" sentence gains the observation path); `current-architecture.md`
  and `service/CLAUDE.md`/`service-types.ts` comments asserting "an ordinary
  TeamMate has no Agent-facing tool surface"; model-facing-writing notes for
  the new receipt copy.

## 12. Acceptance and verification mapping

| Acceptance criterion | Design element | Verification |
| --- | --- | --- |
| Mid-turn report to TeamLeader with real sender identity | `send` leader branch + `from` stamping | MCP delegate unit test: leader-name routing, `from` attribute, no completion recipient |
| Two members send and reply across turns without relay | `send` peer branch + `list` | Behavior test: peer envelope carries `from`; reply reaches the original sender; no TeamLeader copy |
| Idle send starts processing; busy follows runtime | existing `wake: true` submissions | Both runtimes: idle starts a turn; busy steer (Codex) / queue (Claude) documented in the tool description and provider docs, asserted per-runtime where observable |
| Every applicable completion to the TeamLeader; folded inputs once; peer gets only explicit replies | Q1 sink + shared identity fold; peer send stamps Team recipient | Fold tests: N submissions + one result → one report; bound result via settlement+observation → one; peer-triggered turn reports to leader only |
| Unbound normal native turns follow the same reporting contract; never delivered twice | `reportNativeResult` + shared fact mapping | Unbound completed result → one report with the turn output; bound result delivered once regardless of path order |
| Unbound failed background turns report failure once; owner-ended work silent | Q1a mapping + `owesCompletion` gate | Failed unbound result → one failure report; after `stopForHost`/close → none |
| No automatic reply loop to the member | leader submissions carry no completion recipient | Unit test: leader turn from member message settles with no delivery |
| Host-owned scope and sender binding | structural scope + host-stamped `from` | Model-supplied spoofing impossible by schema; wrong-Team name → not found |
| Peer send reopens a closed member; teardown fences hold | existing reopen path through the member delegate | Reopen test via peer send; refusal during Team teardown |
| Workflow members: no tools, locked input refused, script results, no duplicate report | construction-time arm + existing lock | `createLocked` entity has no member catalog and no result reporting; peer send to locked member refused |
| Validate through both in-tree runtimes; busy differences documented | provider wiring + docs | Live tests fail loudly when Codex is absent (repo rule); fixtures cover the sink contract in both providers |
| Update role instructions, tool descriptions, product behavior, owning docs | §11 knowledge delta | `.agents/scripts/check.mjs` green with the implementation PR |

Gates: `rush build`, `rush lint`, `rush test`, `rush typecheck:tests` all
green. Load-bearing tests (completion folding, owner-stop suppression, the
Workflow lock) are extended, never weakened.

## 13. Named risks and unresolved facts

1. **Provider contract discipline (strongest trade-off).** Once-only delivery
   for bound results rests on providers handing the *same* `RuntimeCompletion`
   object to settlement and to the sink. In-tree providers do this by
   construction (one completion per native result); custom
   `ClaudeCodeSession` factories that mint completions themselves must call the
   sink or their unbound results stay silent. A factory that minted *two*
   completions for one native result could break the fold — the README
   extension note must state the identity requirement explicitly.
2. **Notification volume is the accepted product cost.** Q1 chose per-native-
   turn reporting and explicitly rejected quiet-point aggregation; a member in
   a long background chain will wake the TeamLeader per turn. This proposal
   adds no batching (none is authorized). If the operator later finds the
   volume costly, that is a new requirement decision, not a defect here.
3. **Codex unbound-result frequency is unproven.** Dreamux's Codex adapter
   names unbound observed turns, but no source evidence shows how often real
   Codex traffic produces a completion for one; source reading of Codex itself
   suggests self-initiated turns do not exist there. The contract is
   implemented symmetrically and must not claim more coverage than
   "provider-observed"; live verification may demonstrate only the Claude
   side.
4. **Failed-report body change** (§7.4) alters today's submission-associated
   failure payload (adds the error text) for fold consistency. Flagged; the
   alternative is keeping `result: null` everywhere.
5. **Status-line and receipt copy are operator-visible.** The wording moves in
   §5.2/§8 should be read at review as product copy, not implementation
   detail.
6. **A revoked generation's late result is dropped**, matching the activity
   sink. A result racing a runtime replacement can therefore be lost while its
   submissions settle `stopped` through the normal path — a display-equivalent
   best-effort boundary the requirement's "no durable or unconditional
   delivery" clause permits.

## 14. Out of scope

Cross-Team and Dispatcher-scoped member messaging; lifecycle tools for
members; interrupted-turn expansion (Q1/Q1a exclude it; bound interrupted
behavior is the existing baseline); the TeamLeader's own unbound turns;
aggregation/quiet-point batching; any change to automatic-completion wake
semantics, owner-stop suppression, or dispatch receipts.

---

# Round 2 — cross-review and revised position

Sections 1–14 above are the preserved independent first-round proposal. This
section is written after reading `deepseek.md` (proposal + its appended
cross-review) and `trae-seed.md` (proposal + its appended cross-review) and
re-verifying every load-bearing claim against current owning source and
requirement revision 1. Adjudication is by evidence, not by which seat held
which position; where the evidence overturns my round 1, the reversal is
stated plainly. Where they conflict, sections above are superseded by R2.3.

## R2.1 Source-verified facts settled this round

1. **The Codex unbound category exists and its classification is
   authoritative.** `packages/agent-runtime/codex/src/turn-manager.ts`:
   `drainTerminalOrder`'s `representative === null` queue head releases with
   the comment "Nothing to settle and no completion to describe" (verified),
   and that branch **waits out `pendingAdmissions` before classifying**
   (line 286: `if (this.pendingAdmissions.size > 0) return;`), so a racing
   `turn/start` binding resolves before the turn is called unbound;
   `finalize` early-returns for `representative === null` (verified). So: an
   unbound terminal is observed today and is deliberately released without a
   completion; the emission point for the new sink is an existing,
   race-safe drop point. My round-1 phrasing ("terminals where the turn
   record gains a completion, including unbound") was imprecise — unbound
   records never gain a completion today; the implementation constructs one
   there via the shared terminal→completion helper. DeepSeek round-1
   ("not evidenced in this tree") is wrong about existence; what remains
   unproven is real-traffic **frequency** only (round-1 risk 3 stands).
2. **Claude's `answered.length === 0` is an exact "unbound" predicate.**
   `claude-code/src/rpc.ts:279-314`: `answered` = the consumed started-group
   plus the result's `userMessageUuid`, filtered to `this.requests`, which
   holds only Dreamux submissions. At the result frame that set is final
   (queued requests are deliberately never settled by an earlier background
   result — the recorded regression trap). Both providers therefore compute
   the bound/unbound classification at exactly the point where the result is
   dropped today; the new contract adds no policy logic to providers.
3. **`leader` is a legal member name.** `agent/identity.ts:29-37`:
   `RESERVED_AGENT_NAME_SEGMENTS` = `dispatcher, identities, records, turns,
   history, sessions, ledger` — no `leader` — and the name pattern admits it.
   A reserved pseudo-address (`to: "leader"`) therefore has a concrete
   collision scenario: a member named `leader` is ambiguous or unreachable.
   Concrete-name addressing has none: `TeamRecord.leader_name` comes from the
   same dispatcher-global never-reused registry as member names.
4. **The Workflow lock is held for a member's entire live span.**
   `workflow-service/run.ts`: `handle.unlock()` is called only in `finalize`
   (lines 755-759), **after** the close pass (lines 700-707) has closed every
   locked handle; there is no inter-step unlock call site. A locked member is
   locked from `createLocked` until it is closed; there is no post-unlock live
   window and no "unlocked inter-step window" (DeepSeek CR2.6's residual edge
   is illusory; Trae Seed R2.2.H's post-unlock edge is dissolved the same
   way). A later reopen takes the ordinary armed path (Q3's own words).
5. **Failed completion facts carry `result: null` today** (`turn.ts:141-147`;
   `resolveCompletionBody` inlines the empty string). Any design putting
   `error.message` in the report body changes shipped user-visible notices.

## R2.2 Adjudicated disputes — accepted and rejected

### A. Emission scope — REVERSED: emit unbound results only

Round 1 of mine (and Trae Seed's) had the provider emit **every**
non-interrupted completion and let the completion-identity fold dedupe bound
turns. DeepSeek kept **unbound-only** emission. I accept unbound-only
(`deepseek.md` CR2.2, `trae-seed.md` R2.2.A) and withdraw my round-1 §7.2
emit-all. The arguments that decide it:

- **Byte-identity of the shipped bound path.** The requirement scope
  explicitly says "Preserve existing interruption, failure, shutdown,
  completion folding, and automatic-completion wake semantics". Under
  emit-all, a bound result's delivery races two fact builders
  (`EntityTurn`'s and the observation's); the folded second call is swallowed
  wholesale (`completion-router/index.ts:140-145`), so the delivered body is
  a function of microtask order unless the two mappings stay byte-identical
  forever. Unbound-only leaves the bound path one-writer and byte-identical
  by construction.
- **The router's own invariant.** `completion-router/index.ts:104-115`
  documents the fold as sufficient because "no code path produces two
  different recipients for the same `RuntimeCompletion` object" — it was
  designed for N-submissions-one-completion. Unbound-only keeps it a guard;
  emit-all makes it the load-bearing dedup of every bound turn.
- **The classification is exact and already computed** at both drop points
  (R2.1.1–R2.1.2), including Codex's pending-admission wait, so "which
  channel reports this result" is a provider fact, not new policy.
- The requirement's overlap sentences ("A native result reported through
  submission settlement and native observation is not delivered twice";
  Q1a's "including when submission settlement and native observation
  describe the same result") are satisfied as a **contract guard** under
  unbound-only: the contract still requires that if a provider ever emits a
  settled result it be the identical frozen object, and the fold then proves
  once-only. Exclusive routing is stricter than once-only.

Consequence recorded honestly: if a provider mis-classifies a bound result
as unbound, the leader sees an unbound report while the submission hangs
until its own timeout path reports — under emit-all the same pathology
produces an equally bad pair. The contract does not worsen it; the
reference-identity guard tests (R2.3) cover the overlap case.

### B. Failed-report body — REVERSED: keep `result: null`

I withdraw my round-1 §7.4 proposal to carry `error.message` in the report
body (`deepseek.md` CR2.4, `trae-seed.md` R2.2.F accepted). Under unbound-only
there is no fold race forcing a unified richer body; Q1a's recorded words
(「失败也自动报」) authorize reporting the failure, not adding cause text to
shipped notices; and adding it to both paths is a user-visible content change
no recorded decision authorizes. The error remains visible on the member's
own card, `last`, and recorded status. Unbound failures use the identical
fact shape (`status: 'failed'`, `result: null`). Enriching failure bodies is
an operator-copy question for the final solution if wanted — the design
works either way, and keeping today's shape is the no-decision default.

### C. Role prompt — REVERSED: replace the sentence, do not keep it

`trae-seed.md` R2.2.G is accepted over my round-1 §5.5 ("keep the sentence;
Q1 made it true"). It is not true: unbound interrupted turns report nothing;
push-back is `wake:false` and is dropped (`unsupported`) when the leader
runtime is not live (`service.ts:487-492, 711-731`); folding merges one
turn's output with others. The replacement states the observed-fact
contract — the TeamLeader automatically receives the result of each normally
completed or failed turn, including turns no message triggered; that is the
turn's output, not a claim the assigned work succeeded; interrupted turns
are not reported; replies come back only via an explicit send — plus the two
tools and the leader's concrete name (my round-1 naming requirement, which
both seats accepted). Exact copy is operator-visible at final review.

### D. Sender stamping scope — REVERSED: member sends only

My round-1 §5.4 stamped `from` on every scope's `send` (including existing
leader/dispatcher sends). Rejected (`trae-seed.md` R2.2.E,
`deepseek.md` CR2.1 envelopes are member-path only): existing `<task>`
owner handoffs are settled behavior; widening their envelope is unrequested.
With member messages carrying `from`, the recipient already distinguishes
senders (owner dispatch arrives as plain `task`). Stamp `from` on the new
member path only.

### E. Provenance source name — HELD: reuse `AGENT_TASK_SOURCE`, no new constant

My round-1 choice stands (now also `deepseek.md` CR2.1's revised position;
`trae-seed.md` R2.2.E keeps a new-name preference but demotes it to a
non-blocking copy fork). Evidence: `submission-sources.ts:30-34` documents
`task` as "Work an Agent handed to another Agent: an MCP spawn or submit, …"
— a member message is an MCP submit between Agents and is already in scope;
no Channel or CoT consumer branches on the source name (Trae Seed verified);
the `from` attribute carries the identity bit a new name would redundantly
encode — the whitepaper's "a new mechanism that removes nothing". Named
consequence: no source-based message-vs-dispatch filter for a hypothetical
future display; nothing today needs it. If the final solution prefers a
`teammate-message` name for social legibility, behavior is identical and it
is a one-constant copy decision — my adjudicated position is no new name.

### F. Contract field — converged: required `results`

All three seats now hold `readonly results: AgentRuntimeResultSink` as a
required member of `AgentRuntimeCreateContext` beside `state`/`activity`
(Trae Seed R2.2.B revised away from optional). "Required" means Core always
supplies it; a provider's emission is inherently its own choice, and one
that never calls it keeps today's silence. Naming `results` /
`AgentRuntimeResultSink` is now unanimous.

### G. Tool vocabulary and addressing — converged

`send { name, prompt }` + `list`, concrete host names, no `intent`, one flat
namespace (Trae Seed R2.2.D revised; DeepSeek CR2.5 agrees with the
round-1 shape). Rejected permanently: `send_message` / `list_members` and
the reserved `"leader"` pseudo-address (collision evidence R2.1.3; Trae
Seed self-revised). One round-1 detail of mine is revised: `list` returns
**uniform rows** — the TeamLeader's row plus self-excluded member rows in
one set (DeepSeek shape), rather than my two-field `leader` + `teammates`
split. Receipt: the minimal admission projection `{ status, error? }` via
`toSubmissionResult` (round 1 + Trae Seed), with **new** admission-only
reminder copy — `TEAMMATE_DISPATCH_SUCCESS_REMINDER` promises a pushed
completion a member sender never receives (DeepSeek's round-1 reuse of
`submissionReceipt` cannot fill its `teammate` row on the leader path).

### H. Q3 gate — converged: one construction-time arm, no live lock check

All three now hold the single explicit ordinary-vs-locked construction flag
(Trae Seed R2.2.H deleted its own `lockToken` delivery check as defensive
machinery against an impossible state — correct: `lock()` is reachable only
from `createLocked`). Evidence R2.1.4 removes the post-unlock edge entirely.
The one gate arms **both** the member tools and native-result reporting.

### I. Shared fact mapping — DEMOTED to wording hygiene

Under unbound-only the mapping is no longer load-bearing for dedup (the two
paths never report one result). I keep the small extraction of one
completion→fact mapping used by `EntityTurn`'s completion arm and
`reportNativeResult` — not for folding, but because the requirement's
wording discipline ("Host-generated notification wording must state the
observed fact") applies to both paths and two inline builders of one notice
family drift. DeepSeek CR2.2 calls this "worth extracting"; Trae Seed R2.3.4
prefers inline with "the same discipline". Extraction of one pure function
is the smaller long-run cost; this is not a dispute that should delay the
final solution.

### J. Delegate home — held: `teammate` server, third scope arm in `mcp.ts`

Trae Seed's separate `team-member` server name is rejected (it self-revised
to the `teammate` server and a third scope). Its separate `member-mcp.ts`
file is conditionally fine but not pre-decided: `mcp.ts` is 627 **total**
lines against a gate of 700 **code** lines (`eslint-config/index.js:20,320`),
so a third scope is unlikely to trip it; if the gate does trip at
implementation, the whitepaper's sanctioned response is a real named module
for the member surface (Trae's split), not comment-trimming. Speculative
pre-splitting is rejected.

## R2.3 Revised complete position (supersedes sections 5–8 where they differ)

**1. Neutral contract (`@excitedjs/dreamux-types`).** Required
`results: AgentRuntimeResultSink` on `AgentRuntimeCreateContext`, beside
`activity`: synchronous, non-throwing, generation-leased. Semantics: report
the provider-observed result of a normal completed or **failed native
terminal that settled no Dreamux submission**; never for interrupted,
teardown, or unobserved endings; if a provider ever emits a value for a
terminal that also settled submissions, it MUST be the identical frozen
`RuntimeCompletion` object those settlements resolve with (fold guard). A
provider that never calls it leaves unbound results unreported.

**2. Claude adapter.** At the `result` frame: build `completionFromTurnOutcome`
for every non-interrupted frame; settle answered requests exactly as today;
emit to the sink **only when `answered.length === 0`**. Interrupted frames
settle `stopped` and emit nothing. Discarded/refused commands, unconsumed
cancellations, session close, and child exit emit nothing (no fabricated
terminal).

**3. Codex adapter.** Extract one terminal→completion helper from `finalize`
(Error terminal → failed; codec-restore failure → failed; else completed
with `extractAssistantText`), shared by `finalize` and `drainTerminalOrder`'s
unbound queue-head branch (after its `pendingAdmissions` wait). The unbound
branch emits non-interrupted completed results and failed results (Error
terminal; unscoped-failure emission confirmed at implementation), **skips
interrupted** using `observeTerminal`'s own classification, then releases as
today. Manager `stop()` and transport-death paths emit nothing.

**4. Core.** `RuntimeGeneration` gains the generation-leased `generationResultSink`
(same lease gate as `generationActivitySink`) forwarding to an observer its
owning `AgentService` supplies. `AgentService.reportNativeResult(completion)`:
armed owner present → `owesCompletion()` → shared completion→fact mapping
(`result: null` on failure) → `deliverRuntime(owner.completionRecipient(),
completion, fact)` with a caught promise. Arming: one per-entity construction
option set only by a Team's collection for ordinary (non-locked) builds —
the same flag that arms the member tools. `EntityTurn` remains the sole
reporter of bound settlements, including `failed`/`stopped` settlements with
no completion object. Generation revocation drops stale writes; a delivery
already started is never retracted; per-recipient FIFO is inherited.

**5. Member surface.** `teammate` server, `team_member` scope arm, catalog
exactly `send` + `list` (no Workflow tools, no other verbs). `send`
`{ name, prompt }`: `name === leaderName` → `TeamService.submitInput` with
`{ source: AGENT_TASK_SOURCE, attrs: { from: self }, text }` and **no**
`completionRecipient`; otherwise `TeammateCollection.send` with
`source: AGENT_TASK_SOURCE`, `attrs: { from: self }` (via the `source?`/`attrs?`
extension of `SendTeamMateInput`, defaulted in `sendResolved` — one verb, no
per-source wrapper; host-owned entries stamp provenance, tool schemas never
expose it). Self-send refused; unknown/wrong-scope names resolve "does not
exist"; closed peer reopens through the existing path (Q2); locked peer is
refused by the existing ordinary-mutation gate (Q3). `list` returns the
TeamLeader's row plus self-excluded member rows. Receipt:
`{ status, error? }` via `toSubmissionResult`, with new admission-only
reminder copy (no completion promise; a reply comes only via an explicit
send; the recipient's results report to its TeamLeader). No `intent`.

**6. Construction.** `TeammateCollectionOptions` gains the Team-supplied
member surface (`leaderName`, `submitToLeader`) and the MCP primitives the
collection lacks; the dispatcher-root collection gets neither. One explicit
ordinary-vs-locked construction flag arms tools + reporting together;
`createLocked` disarms. No persisted category; a reopened former-Workflow
member is an ordinary armed member (Q3).

**7. Wording (operator-visible copy at final review).** Turn-granularity
status lines for all three role subjects ("has finished a turn." / "turn
failed." / "turn was stopped."); the Workflow line is untouched. The member
role prompt is replaced per R2.2.C. Product catalog: new member-messaging
entry; the background-work bullet's "does not automatically push" sentence is
reversed for ordinary Team members; the **stopped-leader asymmetry** is
stated (automatic results remain live-runtime-only push-back and can be
dropped when the leader runtime is not live, while explicit member messages
wake the leader — preserved, not fixed).

**8. Compatibility and change files.** Additive required context field;
external providers ignore it and keep submission-bound coverage; custom
Claude session factories that mint completions must honor the unbound-only +
same-object discipline in the package README (noncompliance degrades to
today's silence, never to duplicates under this contract). Plain `minor`
notes on `@excitedjs/dreamux-types`, `@excitedjs/dreamux`, and both runtime
packages; no `BREAKING:`/`Rebuild:`; no state/config/`dreamux-maintenance`
change.

**9. Verification.** Four gates including `typecheck:tests` (fixtures adopt
the required field). Core decision matrix: unbound completed and unbound
failed delivered once; bound path byte-unchanged (one report, existing fact
shape); interrupted, disarmed (Workflow), dispatcher-scoped, leader/dispatcher
entities, `owesCompletion`-negative, revoked-generation writes, and
dissolving-Team delivery all silent or existing-behavior; ordering across
distinct turns preserved. Adapter tests: unbound classification per provider
(zero-answered frame; unbound queue head after the admission wait);
interrupted emits nothing; reference-identity guard where a provider could
overlap; no fabricated terminals on close/exit. Delegate tests: catalog is
exactly two verbs; `from` cannot be model-supplied; self/unknown/closed/
locked/dissolving-target outcomes; leader path carries no completion
recipient; locked build advertises no member server. Live gates on both
runtimes with busy-input differences documented as observed, never asserted
equal.

## R2.4 Material trade-offs and verification-bound facts

1. **Notification volume** is the accepted product cost of Q1; no filter or
   aggregation is authorized or designed (all three seats).
2. **Stopped-leader gap preserved.** Automatic reports stay `wake:false`
   push-back and drop when the leader runtime is not live; explicit member
   messages wake it. Documented asymmetry, not a defect to fix here.
3. **Codex unbound traffic frequency** (R2.1.1) and the **unscoped-failure
   emission** point (`failProtocol`/`failRecord` → observed failure) are
   implementation-time verification items; the contract is written
   traffic-independently ("provider-observed") and must not claim coverage
   the live gates do not show.
4. **Provider identity discipline** (same frozen object on any overlap) is a
   cross-package invariant carried as a guard; reference-identity tests are
   its proof. Custom `ClaudeCodeSession` factories are the realistic
   violator.
5. **Copy decisions left to the final solution / operator review** (not
   scope questions): exact status-line, prompt, and receipt text; whether
   failure notices should ever carry cause text (default: unchanged,
   R2.2.B).

## R2.5 Recorded operator scope vs facts needing verification

- **Recorded and binding (not reopened):** Q1 「每个完成回合自动报」 and its
  bounded explanation (ordinary Team members, bound-or-unbound normal
  completions, one report per native completion, no quiet aggregation, no
  goal claim); Q1a 「失败也自动报」 (unbound failures report once; owner-stop
  suppression; no interrupted expansion; no fabricated terminals); Q2
  「允许 send 重新打开」 (same-member reopen under existing rules; no
  lifecycle authority; Team fences hold); Q3 「只覆盖普通成员」 (no tools
  under Workflow control; locked input refused; script-consumed results; no
  ordinary-member reports on Workflow calls; historical Workflow creation is
  not a category). Plus the #471 confirmed baseline, the exclusions
  (Dispatcher-scoped members, the TeamLeader's own turns), and the preserve
  clause for folding/wake/shutdown semantics.
- **Settled by source, not decisions:** the four facts of R2.1 (Codex
  unbound branch and its admission wait; Claude's exact unbound predicate;
  `leader` name legality; lock-held-for-life; failed facts carry no body).
- **Needs verification during implementation:** Codex unbound traffic
  frequency; unscoped-failure emission behavior against a real protocol
  event; whether `mcp.ts` actually trips the line gate with the third scope.
- **Needs operator copy review, not scope decisions:** the three wording
  texts; the optional failure-body enrichment (default keeps today's shape).

## R2.6 Agreements, disagreements, blocker assessment

- **Material agreements (all three, source-verified):** two capabilities and
  no new state/mailbox/aggregation; one leased neutral sink with a required
  context field; unbound-only emission (this round's convergence);
  interrupted/teardown never emit; Q2 via the existing reopen path; one
  construction-time Q3 gate with no live lock check; concrete-name
  addressing with `send`/`list` and no `intent`; host-bound `from` on member
  sends only; leader path carries no completion recipient; peer results stay
  Team-owned; `EntityTurn` stays the sole bound-settlement reporter;
  generation lease + `owesCompletion` + never-retract + FIFO unchanged;
  wording corrections in scope; plain minor notes, no upgrade blocker;
  reference-identity and decision-matrix verification.
- **Material disagreements remaining:** (a) the provenance source name —
  I hold reuse of `task`+`from` (R2.2.E); Trae Seed keeps a non-blocking
  preference for `teammate-message`; behavior identical either way. (b) the
  shared fact mapping extraction (R2.2.I) — a hygiene preference, not a
  correctness fork. (c) delegate file placement (R2.2.J) — resolved
  conditionally by the line gate.
- **Genuine blocker: none.** DeepSeek CR6's candidate blockers resolve:
  keeping today's failed-body shape needs no operator decision (only
  *changing* it would), and Dispatcher-scoped exclusion is recorded scope
  ("not requested"; DeepSeek CR5.2 agrees it stays excluded absent a new
  ruling). The requirement is implementable with R2.3 as written; the
  remaining risk is verification burden (provider emission discipline and
  live coverage evidence), not open design.

---

# Requirement revision 2 — independent revised proposal

Everything above is revision-1 history (the independent proposal and the
cross-review), preserved as evidence. The requirement has been re-issued as
**revision 2** with accepted decision Q4: the enhanced capability covers
**both** ordinary-member categories — a Team's members and a Dispatcher's
root members — served by **one concise, abstract, reusable mechanism** with
no excessive owner-kind branching or copied Team/Dispatcher implementations.
Revision-1 technical choices are not accepted by default; each is re-derived
below against current source. Where this section differs from the history
above, **this section supersedes it**.

## 2.1 Summary

One shared ordinary-member capability, mounted by the existing member
collection for either owner:

1. **Member messaging** — the acknowledged surface in
   `service/agent/mcp.ts`: the `teammate` server's `team_member` scope arm
   with `send`/`list`, host-bound sender identity, owner or same-collection
   peer addressing. The delegate is one implementation; the owner supplies
   a narrow structural port (`ownerName`, owner roster row, fenced owner
   inbox) — three facts that genuinely differ — and the collection supplies
   peer resolution/send/reopen. Owner-specific code is those three facts
   and nothing else.
2. **Native-result reporting** — a required neutral `results` sink on the
   runtime create context. Every provider-observed completion-bearing
   native terminal (bound or unbound) reports once to the collection's
   existing `completionOwner` — the Team or the Dispatcher agent — folded
   by completion-object identity. This is where Q4 costs *nothing*: both
   collections already pass `completionOwner`, so the reporting path has
   zero owner branches. Emission is synchronous at the terminal observation
   (§2.8), which is also what makes mixed bound/unbound report order equal
   native terminal order.

Arming is one construction flag (ordinary vs Workflow-locked build); Q3 is
unchanged. The owner port is **required** on `TeammateCollectionOptions` —
both owners supply it — which removes revision 1's nullable bundle.

## 2.2 Deltas from revision 1 (what changed and why)

| Revision-1 position | Revision-2 position | Why |
| --- | --- | --- |
| Member surface Team-only; dispatcher collection passes `null` (r1 §6) | Both collections arm their ordinary members; the owner port is required | Q4 replaces the Dispatcher exclusion; the nullable bundle becomes a needless second state |
| Owner port named `leaderName`/`submitToLeader` (r1 §5.1) | Owner-neutral port: `ownerName`, `ownerRow`, `submitToOwner`, `ownerLabel` | One mechanism for both owners; the leader is just the Team owner's actor |
| Unbound-only sink emission (cross-review R2.2.A) | **Emit every completion-bearing terminal; settlements fold into the same delivery** | The revision-2 acceptance criterion on mixed bound/unbound ordering is unsatisfiable-by-construction under unbound-only (§2.8); the byte-identity concern is answered by making the shared fact mapping mandatory |
| Shared fact mapping "hygiene" (R2.2.I) | Mandatory, load-bearing: one completion→fact mapping for both reporters | Under emit-all the fold's first writer must not decide the payload; the sink's enqueue is deterministic-first, so the mapping is the delivered fact |
| Prompt: member/TeamLeader wording | Owner-neutral: owner label + owner name supplied per owner | Q4 story 4: no mirrored Team/Dispatcher copy |

Carried forward unchanged and re-justified below: provenance `task` + host
`from` on member sends only; `SendTeamMateInput.source/attrs`; `send`/`list`
with `{name, prompt}` and no `intent`; concrete-name addressing (no reserved
pseudo-name); minimal admission receipt + new reminder copy; turn-granularity
status lines; failed body stays `result: null`; Q2 via the existing reopen
path; the single construction-time Q3 gate; required `results` context field;
plain minor change notes.

**Rejected alternative, named:** unifying `DispatcherService` and
`TeamService` per the operator's analogy ("Dispatcher is a TeamService with
a TeamCollection"). The requirement explicitly records that no service
merger or inheritance model is prescribed and that lifecycle/state/config/
channel contracts are not authorized for replacement. The analogy is
satisfied by sharing the *capability* (port + delegate + reporting), not by
merging the owners.

## 2.3 Authoritative ownership

| Concern | Owner | Source evidence |
| --- | --- | --- |
| Owner addressing, owner roster row, owner inbox, access boundary | The actual owner: `TeamService` (leader, Team fence, `submitInput`) or `DispatcherService` (dispatcher agent, dispatcher fence, `submitToAgent`) | `team/service.ts:834-845` (leader-submission entry); `dispatcher-service/index.ts:353-359` — `submitToAgent(input: Omit<TeammateSubmitInput, 'completionRecipient'>)` is already a fenced owner inbox that structurally forbids a caller completion recipient |
| Peer resolution, ordinary send, same-record reopen | `TeammateCollection` | `agent/index.ts:238-325` (`send`/`sendReopened`/`reopenFrom`); both owners construct exactly one such collection (`team/service.ts:208-221`, `dispatcher-service/index.ts:235-246`) |
| Submission and native-result facts; delivery convergence | `AgentService`, `EntityTurn`, `CompletionDeliveryPolicy` | `agent/service.ts`, `agent/turn.ts`, `completion-router/index.ts` |
| Member tool adapter, schemas, receipt copy, caller binding | `service/agent/mcp.ts` (`teammate` server, `team_member` scope arm) | acknowledged MCP home (requirement revision 2, scope section; operator 「可以」) |
| Generation lease and delegate mounting | `TeammateCollection.teammateOptions` + `RuntimeGeneration` | existing MCP infrastructure; `runtime-generation.ts:373-380` |
| Completion recipient for every member result | The collection's existing `completionOwner` | `team/service.ts:217` (`completionOwner: this`); `dispatcher-service/index.ts:246` (`completionOwner: this.dispatcherAgent`); `DispatcherAgent.completionRecipient()` (`agent.ts:185`) |

## 2.4 The shared member capability — the owner port

One structural interface (name: `MemberMessagingOwner`), supplied by each
real owner at member-collection construction, consumed by the member
delegate and the member prompt/options assembly:

```ts
/** Structural view of the actual owner — what the member surface needs and nothing more. */
export interface MemberMessagingOwner {
  /** The owner actor's concrete, never-reused name: the owner address in the flat namespace. */
  readonly ownerName: string;
  /** Short role label for model-facing copy ("TeamLeader" / "Dispatcher agent"). */
  readonly ownerLabel: string;
  /** The owner's own roster row (its name and status projection). */
  ownerRow(): Promise<MemberRosterRow>;
  /** Fenced owner-inbox submission. Never carries a completion recipient. */
  submitToOwner(input: TeammateSubmitInput): Promise<TurnAdmission>;
}
```

**Producers:** `TeamService` (a one-liner over `submitInput`, the leader's
identity status, and `TeamRecord.leader_name`) and `DispatcherService`
(a one-liner over `submitToAgent`, `DispatcherAgent.status()`, and the
dispatcher agent's identity name). **Consumer:** the `team_member` delegate
(mcp.ts) and `teammateOptions`. **Removals:** without this port there are
exactly two dishonest alternatives — a second delegate/routing policy per
owner (the copied implementations Q4 bans) or concrete Team/Dispatcher
imports in the agent tier (the layering rule the file's own header states).
The port also removes revision 1's nullable `memberSurface` bundle: both
owners supply it, so the option is required and the only remaining gate is
the Workflow-locked construction flag.

**Where routing lives.** The requirement assigns "routing to leader versus
peer" to the owner and forbids copied routing implementations. Both hold
under this reading: the owner owns the **address space and both entries**
(it supplies `ownerName`/`submitToOwner` and its collection is the peer
scope); the single `name === owner.ownerName` dispatch is shared machinery
in one handler, not per-owner policy. The alternative — a `message()` verb
per owner that internally branches — would copy the dispatch into two
owners and is rejected. (If cross-review prefers full `roster()`
composition on the port, that is a placement detail: the owner already
supplies the roster *content*; only the row-shaping/self-filter moves.)

## 2.5 End-to-end behavior

**Story 1 (member → owner), both scopes.** A member calls
`send { name: "<owner name>", prompt: "blocked on X" }`. The delegate
refuses `name === self`, matches `ownerName`, stamps
`attrs: { from: <self> }`, and calls `owner.submitToOwner` —
`TeamService.submitInput` or `DispatcherService.submitToAgent`, both
already fenced and completion-recipient-free. The owner's turn carries no
automatic reply to the sender; the owner answers with its existing `send`
tool. The receipt returns at admission.

**Story 2 (peer exchange).** `send { name: "B", ... }` routes to
`TeammateCollection.send` — reopen-on-closed (Q2), Team/dispatcher fence,
completion recipient = the collection's `completionOwner` (the owner).
B replies by explicit `send` to A across completed turns. No relay; no
copy to the owner.

**Story 3 (background chain).** A submitted turn reports as today. A later
unbound native turn's result is emitted through the `results` sink and
reports once to the owner ("has finished a turn." + output). An unbound
failure reports once ("turn failed.", body `result: null`). A bound result
reports once — the sink's synchronous delivery and the settlement's
`EntityTurn` fold into one (§2.8). The peer sender receives only explicit
replies.

**Workflow member (Q3, either collection).** A `createLocked` build is
disarmed: no member catalog, no reporting arm. Peer input observes the
existing lock. Script results stay script-consumed.

**Cross-collection.** A name outside the caller's own collection resolves
"does not exist" (physical directory scoping + roster predicate). The owner
actor is not a collection member; it is a roster row and an address only.

## 2.6 Public contracts

### MCP surface (acknowledged `send`/`list` on the `teammate` server)

- Scope arm: `{ kind: 'team_member', member: { self, owner: MemberMessagingOwner, peers: TeammateOps } }`;
  `self` bound from `identity.name` at delegate construction; catalog is
  exactly `send` + `list` (no Workflow tools, no lifecycle verbs).
- `send { name: string(1..64), prompt: string(1..20000) }` — no `sender`,
  no `intent`. Host stamps `from`. Self refused; unknown/wrong-collection
  refused ("does not exist"); locked recipient refused by the existing
  gate; closing owner/collection refused by the existing fences.
- `list {}` → rows `{ name, kind: 'owner' | 'member', status, intent? }`:
  the owner row plus this collection's member rows, self excluded. One row
  shape; the concrete owner name is the owner address.
- Receipt: `{ status: submitted | duplicate | stopped | failed | ambiguous, error? }`
  via the existing `toSubmissionResult` projection, plus **new**
  admission-only reminder copy (the existing dispatch reminder promises a
  pushed completion a sender never receives; the new copy states admission
  proves neither execution nor receipt, a reply comes only via an explicit
  send, and the recipient's results report to its owner).
- Provenance: `AGENT_TASK_SOURCE` + `attrs.from` on member sends only;
  `SendTeamMateInput` gains `source?`/`attrs?` defaulted in `sendResolved`
  (one verb, no per-source wrapper; owner dispatch envelopes unchanged).
  Owner-scoped entries stamp provenance; tool schemas never expose it.

### Role prompt (owner-neutral, replacing the Team-only sentence)

Supplied per owner via `ownerLabel`/`ownerName` and the member's identity:
the member's own name and collection; the owner's concrete name and label;
the observed-fact delivery contract (each normally completed or failed turn
result — including turns no message triggered — reports to the owner; that
is the turn's output, not a claim the assigned work succeeded; interrupted
turns are not reported); the two tools and reply discipline. Root members
receive this too (revision 1's "told none of it" case is gone with Q4).

### Runtime-neutral result contract

```ts
// packages/dreamux-types/src/agent-runtime.ts
/** Required on AgentRuntimeCreateContext, beside `activity`. */
readonly results: AgentRuntimeResultSink;

/**
 * Synchronous, non-throwing, generation-leased. The provider calls it once
 * per provider-observed completed or failed native terminal, carrying the
 * identical frozen RuntimeCompletion its settled submissions (if any)
 * resolve with. Never for interrupted, teardown, or unobserved endings. A
 * provider that never calls it keeps submission-bound reporting only.
 */
export interface AgentRuntimeResultSink {
  (completion: RuntimeCompletion): void;
}
```

## 2.7 Native-result reporting (Core and providers)

**Core.** `RuntimeGeneration.generationResultSink(lease)` — same revoked-
generation drop as `generationActivitySink` — forwards to
`AgentService.reportNativeResult(completion)`: armed (ordinary construction)
→ `owesCompletion()` → the **shared completion→fact mapping** (status and
`result: null` on failure; wording identical to `EntityTurn`'s) →
`deliverRuntime(this.deps…completionOwner.completionRecipient(), completion,
fact)`. The recipient is the collection's existing `completionOwner` —
the Team for Team members, the Dispatcher agent for root members — so the
reporting path contains **zero owner branches**. `EntityTurn` remains the
reporter of settlements with no completion object (`stopped`, transport
`failed`), unchanged.

**Claude (`rpc.ts`).** At each `result` frame: build
`completionFromTurnOutcome` (session-pin/structured-output mapping, the
same one settlements use); settle answered requests as today with that
object; call `results` with the same object — synchronously, in frame
order. Interrupted frames settle `stopped`, call nothing. Discarded/
refused commands and close/exit emit nothing (no fabricated terminals).

**Codex (`turn-manager.ts`).** Extract the terminal→completion construction
from `finalize` (Error terminal → failed; codec-restore failure → failed;
else completed with `extractAssistantText`) into one helper; call `results`
with that object wherever a terminal is processed — the bound path in
`finalize` and the unbound queue-head release in `drainTerminalOrder`
(after its `pendingAdmissions` wait) — skipping interrupted terminals per
`observeTerminal`'s own classification. Manager `stop()` and transport
death emit nothing.

**Same-object discipline.** Both in-tree providers already create one
`RuntimeCompletion` per native result and share it with every settled
request (`rpc.ts:363-392` "One immutable completion per native result";
`turn-manager.ts` `record.completion`); the sink receives that same value.
A reference-identity assertion in each adapter pins the contract; a
structural clone would be a defect (it would break both folding and
ordering).

## 2.8 Ordering and delivery convergence (revision-2 acceptance criterion)

**The named hazard** (stated by the requirement): Claude's RPC parser
handles multiple `result` lines synchronously in one parse batch, while
bound Core reporting runs through Promise continuations — `EntityTurn`
binds `runtime.settled.then(...)` and `request.settle()` queues that
continuation as a microtask. A report delivered *synchronously* for an
unbound frame would reach the router **before** an earlier frame's bound
continuation in the same batch: the owner would read turn N+1's result
before turn N's. Revision 1's cross-review choice (unbound-only emission,
bound path async) leaves exactly this hazard and can only defend order by
microtask-depth equality across two files — fragile and effectively
unverifiable.

**Revision-2 mechanism: every completion-bearing terminal enqueues its
report synchronously at its terminal observation; settlements fold into the
same delivery.**

- The sink call is synchronous inside the provider's terminal handling, so
  enqueues happen in native terminal order — including multiple `result`
  lines in one parse batch.
- The `EntityTurn` continuations later call `deliverRuntime` with the
  **same frozen object**; the router's token fold returns the already
  queued delivery. The settlement chain's async depth is therefore
  irrelevant to ordering: for completion-bearing results it never enqueues
  at all.
- The fold's first writer is deterministically the sink (a synchronous call
  beats every microtask); the delivered fact is the shared mapping's
  output, so the payload cannot depend on arrival order.
- Convergence: `owesCompletion()` is read at delivery start; a queued
  delivery is never retracted; the dispatcher fence, per-recipient FIFO
  tails, and the stop/drain paths (`convergeRetainedTurns`) are unchanged.

**Residual, named and out of contract.** Settlements with **no** completion
object — `stopped` from interrupted frames, `kind: 'failed'` transport
deaths — still deliver through their settlement continuations and can
interleave behind a later same-batch result's synchronous report (e.g. one
parse batch holding an interrupted frame then a completed unbound frame).
These outcomes are pre-existing reporting outside Q1/Q1a's result contract
(completed/failed native results), and their order among themselves is
preserved (settle order = terminal order, FIFO continuations). Closing the
residual would need microtask-hop discipline (fragile) or a sequence field
on the seam (new contract surface) — both rejected with their named
scenarios; raising it would be a separate requirement question.

**Verification.** Adapter-level tests feed two `result` lines in one
synchronous batch — bound-then-unbound, unbound-then-bound, bound-with-
folded-submissions — and assert the owner's received report order equals
native terminal order and that each terminal yields exactly one report;
plus the reference-identity assertion (§2.7) and the residual's documented
case.

## 2.9 Lifecycle, concurrency, identity

| Situation | Behavior |
| --- | --- |
| Idle recipient, explicit send | Existing `wake: true` path (both owners' inboxes) |
| Busy recipient | Runtime-native admission (Codex steer / Claude queue); documented, not special-cased |
| Self-send / unknown / cross-collection name | Refused before dispatch / "does not exist" |
| Closed peer (Q2, both collections) | Existing `sendReopened`/`reopenFrom`; concurrent sends join one reopen |
| Workflow-locked peer (Q3) | Existing `enterOrdinaryMutation` refusal; `createLocked` builds are disarmed (tools + reporting) |
| Owner/collection teardown | Existing fences (`admitTeam`, dispatcher `fence.admit`, `selfCloseIfClosing`) |
| Result racing owner stop / host stop / dissolve | `owesCompletion()` at delivery start; queued deliveries never retract; `prepareCompletion` fences return `unsupported` and the router drops |
| Generation replacement | Revoked-generation sink writes dropped (activity-sink discipline) |
| Folded submissions | One native completion → one report (existing token fold) |
| Owner receipt of a member message | No completion recipient on either owner inbox: no auto reply, no new owner obligation |

One construction flag (ordinary vs `createLocked`) arms both capabilities
for every member in either collection; no persisted category; a reopened
former-Workflow member is an ordinary armed member (Q3).

## 2.10 Owner-specific differences (exhaustive)

| Fact | Team owner | Dispatcher owner | Why it differs |
| --- | --- | --- | --- |
| `ownerName` | `TeamRecord.leader_name` | Dispatcher agent's identity name | The owner actor differs |
| `ownerLabel` | "TeamLeader" | "Dispatcher agent" | The actor's role word |
| `submitToOwner` | `TeamService.submitInput` (Team fence → leader) | `DispatcherService.submitToAgent` (dispatcher fence → agent; type forbids a completion recipient) | The admission fence and target entity differ; both are existing entries |
| `ownerRow` | Leader identity status | `DispatcherAgent.status()` | Each owner's existing status surface |
| Completion recipient | (none — shared path reads `completionOwner`) | (same) | **No branch exists** |

Everything else — catalog, schemas, routing dispatch, envelope, provenance,
receipt, prompt structure, reporting, folding, ordering, fences' behavior —
is shared code with zero `if (ownerKind)` branches.

## 2.11 Reused / removed / new

- **Reused:** both owner inboxes; `TeammateCollection.send` (peer send,
  Q2 reopen, completion-recipient stamping); `CompletionOwner`/
  `CompletionInitiator` on both owners; `CompletionDeliveryPolicy` token
  fold and FIFO; `owesCompletion`; the generation lease pattern; MCP
  mint/lease/frozen catalogs; the provenance envelope; `toSubmissionResult`;
  `completionFromTurnOutcome` and Codex's terminal construction (extracted,
  not rewritten).
- **Removed:** revision 1's nullable member-surface bundle (now required);
  revision 1's Team-only arming condition; the dispatcher-member "told none
  of it" prompt gap (Q4 replaces it); the cross-review's unbound-only
  emission rule and its ordering hazard; per-owner wording (owner label is
  data, not copy forks).
- **New:** `MemberMessagingOwner` port (3 facts + 1 inbox); the
  `team_member` scope arm with `send`/`list`; `SendTeamMateInput.source/`
  `attrs`; the required `results` sink and `reportNativeResult`; the
  mandatory shared completion→fact mapping; new reminder copy; owner-neutral
  prompt assembly. No new state, mailbox, aggregation, sequence numbers, or
  service entity.

## 2.12 Compatibility

Additive required `results` context member (providers ignore it at no
cost; in-tree providers must implement — `typecheck:tests` pins fixtures);
MCP catalog additive for member runtimes only; no persisted state/config
shape change → no `BREAKING:`/`Rebuild:`, no `dreamux-maintenance` change.
Plain `minor` notes on `@excitedjs/dreamux-types`, `@excitedjs/dreamux`,
`@excitedjs/agent-runtime-claude-code`, `@excitedjs/agent-runtime-codex`.
Custom `ClaudeCodeSession` factories that mint completions must honor the
same-object + never-interrupted discipline (README); noncompliance degrades
their unbound coverage, never the fold. Docs in the same change: product
catalog (member messaging; the background-work bullet reversed for ordinary
members of both owners; the stopped-owner asymmetry stated), provider-runtime
(sink contract, ordering rule), current-architecture and service notes, role
and tool copy; `.agents/scripts/check.mjs` with the implementation.

## 2.13 Acceptance and verification mapping

| Acceptance criterion | Mechanism | Verification |
| --- | --- | --- |
| Member reports progress/blocker to its actual owner, sender visible | `send` to `ownerName` via `submitToOwner`; host `from` | Delegate test both scopes: envelope, no completion recipient |
| Same-collection peers send/reply across turns, no relay | `peers.send`; Team recipient | Behavior test both scopes |
| Idle wake / busy runtime-native | existing `wake: true` | Per-runtime tests; busy differences documented as observed |
| Applicable completions reach the owner once; peers get explicit replies; folds single | token fold + shared mapping | Fold tests; peer-recipient tests |
| Unbound normal/failed native turns report once, never twice with settlement | `results` sink + fold + same-object | Adapter + core tests both scopes; ordering tests (§2.8) |
| Owner receipt creates no reply loop | no recipient on owner inboxes | Test: owner turn from member message delivers nothing to the sender |
| Host-owned scope and sender | structural scope; `from` not in schemas | Cross-collection name → not found; spoofing impossible by schema |
| Peer send reopens closed member; teardown fences hold | existing reopen path | Reopen tests both scopes; fence refusal tests |
| Workflow members: no tools, locked input refused, no duplicate report | construction flag; existing lock | `createLocked` tests both scopes |
| One reusable capability; branches explained by real differences | §2.10 table | No `ownerKind` branch in shared paths (lint/review); two-owner construction test |
| Mixed bound/unbound ordering and convergence | §2.8 | Two-frames-in-one-batch tests; residual documented |
| Both scopes × both runtimes | provider wiring + fakes + live gates | Live tests fail loudly when Codex absent (repo rule) |
| Role/tool/product/architecture docs updated | §2.12 | Knowledge delta in the implementation PR |

Gates: `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`.
Load-bearing tests (folding, owner-stop suppression, Workflow lock) are
extended, never weakened.

## 2.14 Named risks and genuine unresolved decisions

1. **Same-object discipline is the keystone** (folding *and* ordering rest
   on it). Pinned by reference-identity tests; custom session factories are
   the realistic violator (README discipline).
2. **Notification volume** is Q1's accepted cost for both scopes — root
   members now add Dispatcher-side volume; no aggregation is authorized.
3. **Stopped-owner asymmetry preserved** (automatic reports are live-runtime
   push-back and can drop; explicit member messages wake the owner) — state
   it in the product entry; fixing it would be a wake-semantics change.
4. **Verification-bound facts, not design forks:** real Codex unbound
   traffic frequency; Codex unscoped-failure emission against a real
   protocol event; whether `mcp.ts` trips the 700-code-line gate (if so,
   a named module for the member surface — the sanctioned response).
5. **Genuine unresolved decisions for the operator/final solution (not
   settled here):** (a) the exact status-line, prompt, and receipt copy —
   all operator-visible; (b) whether failure notices should carry cause
   text (default: unchanged `result: null`; changing it is a product-text
   change); (c) whether full roster composition should sit on the owner
   port instead of shared shaping (placement detail, behavior identical);
   (d) the residual ordering case of §2.8 — named and out of contract;
   widening it needs a requirement question. None of these blocks the
   mechanism.

## 2.15 Out of scope

Cross-collection/cross-Team/cross-Dispatcher messaging; the owner actor as a
collection member; lifecycle tools for members; interrupted-turn reporting
expansion; quiet-point aggregation; any change to automatic-completion wake
semantics, owner-stop suppression, dispatch receipts, or Dispatcher Team
management; service mergers or inheritance models beyond the shared port.

---

# Requirement revision 2 — cross-review and revised position

Everything above is preserved history. This section is the single
revision-2 cross-review round, written after reading both other seats's
"Requirement revision 2 — independent revised proposal" sections
(`deepseek.md` R2.x, `trae-seed.md` V2.x). Adjudication is against current
source and requirement revision 2; no historical TeamLeader adjudication or
other proposal is treated as authority. Statements below are labeled as
**code fact** (verified in this tree), **operator decision** (recorded
verbatim in the requirement), or **design inference** (mine, reviewable).

## R3.1 Material agreements (all three revision-2 proposals)

1. **One owner-neutral capability for both member categories** — a narrow
   structural owner port supplied by `TeamService` and `DispatcherService`,
   consumed by one `team_member` scope arm in `service/agent/mcp.ts` on the
   existing `teammate` server; zero owner-kind branches in shared code; no
   service merge (all three explicitly reject merging `DispatcherService`
   and `TeamService` — the operator's analogy prescribes no inheritance
   model).
2. **Emit-all native-result publication.** All three reversed their own
   revision-1 unbound-only positions: the sink reports **every**
   provider-observed completed/failed native terminal (bound or unbound),
   synchronously at the terminal observation, carrying the **same frozen
   `RuntimeCompletion`** its settlements resolve with; `EntityTurn`'s later
   delivery folds into the sink's already-queued delivery. The shared
   completion→fact mapping is now mandatory in all three (byte-identical
   payload whichever path reaches the router first; failed body stays
   `result: null`).
3. **The ordering criterion is the decisive new evidence** (requirement:
   "mixed bound/unbound result ordering and delivery convergence … explain
   report order and verify it"): with one synchronous publication point per
   terminal, per-recipient FIFO after arrival *is* terminal order; citing
   FIFO without fixing arrival order is exactly what the requirement bans.
4. Required `results` field beside `state`/`activity`; never emit for
   interrupted/teardown/unobserved endings; reference-identity discipline
   pinned by per-adapter tests; Q2 via the existing reopen path; Q3 via
   construction-time disarm only (no live lock check); concrete-name
   addressing with `send`/`list`; no `intent`; admission-only receipt with
   new copy; turn-granularity status lines; owner-neutral prompt with the
   observed-fact delivery contract; plain `minor` notes, no
   `BREAKING:`/`Rebuild:`; the `service-types.ts` "no Agent-facing tool
   surface" invariant revised knowingly; the stopped-owner asymmetry
   documented, not fixed.

## R3.2 Source facts rechecked this round

1. **`ownerName` must be lazy.** *Code fact:* `TeamService`'s constructor
   builds its `TeammateCollection` (`team/service.ts:208-221`) before
   `deps.record.create` publishes the record holding `leader_name`
   (`service.ts:276+`). A port property captured at collection construction
   cannot hold the owner name for a fresh Team. DeepSeek's `ownerName(): string`
   (read at delegate-build/send time) is the correct shape; my §2.4's
   `readonly ownerName: string` is a construction-order bug and is fixed in
   R3.4.
2. **The Dispatcher root owner address cannot collide.** *Code fact:*
   `DISPATCHER_AGENT_NAME = 'dispatcher'` (`agent/identity.ts:15`), and
   `dispatcher` is in `RESERVED_AGENT_NAME_SEGMENTS` (`identity.ts:29-37`) —
   no member can take the name. Combined with the dispatcher-global
   never-reused registry, owner addressing is collision-free in both scopes
   without a reserved pseudo-name.
3. **The ordering hazard is exactly as the requirement states.**
   *Code fact:* `onStdoutChunk` parses every buffered line synchronously
   (`claude-code/src/rpc.ts:135-141`); `request.settle` only resolves a
   promise, and `EntityTurn`'s delivery runs on a later microtask
   (`turn.ts:71-92, 127-152`); `deliverRuntime`→`enqueue` is synchronous
   (`completion-router/index.ts:137-158`). A synchronous unbound report for
   a later line would therefore overtake an earlier line's bound report.
4. **Q3 applies at the Dispatcher root too.** *Code fact:* the dispatcher
   has its own `WorkflowService` (`dispatcher-service/index.ts:281-289`), so
   root members can be `createLocked` builds; the disarm must work in both
   collections.
5. **The `submitToAgent` inbox already forbids a completion recipient by
   type.** *Code fact:* `submitToAgent(input: Omit<TeammateSubmitInput,
   'completionRecipient'>)` (`dispatcher-service/index.ts:352-359`).

## R3.3 Adjudicated disputes (accepted / rejected)

### A. Sink emission — accepted unanimously: emit-all (R3.1.2)

No remaining dispute. Recorded for the history: my cross-review-round
unbound-only conclusion is reversed knowingly, because revision 2's ordering
criterion is new evidence and because the byte-identity objection is
answered by the mandatory shared mapping (first writer is deterministically
the synchronous sink; the payload cannot depend on microtask order).

### B. Owner-port shape — mixed; revised position combines the strongest parts

- **Accepted from DeepSeek:** lazy `ownerName(): string` (R3.2.1) and the
  typed inbox `submitToOwner(input: Omit<TeammateSubmitInput,
  'completionRecipient'>)` — the type itself states the no-reply-loop rule,
  matching both real inboxes. DeepSeek's port as written has **no status
  source** though its `list` shows `owner: {name, status}` — rejected as
  underspecified; `ownerRow()` (or Trae's `ownerStatus()`) is required.
- **Accepted from Trae:** `ownerRow()`/`ownerStatus()` membership in the
  port (its `MemberMessagingOwner` is otherwise a union of the three).
- **Held against Trae's `ownerKind: 'team_leader' | 'dispatcher'`:** a
  copy-only enum puts an N-valued discriminant across the seam so the
  prompt builder can switch on it; `ownerLabel: string` ("TeamLeader" /
  "Dispatcher agent") supplies the words without the branch. If the callee
  treats the branches identically, the taxonomy must not cross the seam.
- **Held against Trae's scope shape `peers(input: {name, prompt})`:** as
  written its scope carries no roster source for `list`'s peer rows;
  `peers: Pick<TeammateOps, 'send' | 'list'>` covers both verbs the
  delegate actually calls.

### C. `from` on owner→member sends — accepted from DeepSeek, flagged for operator confirmation

DeepSeek R2.4.3/R2.12.1 reverses to a uniform rule and I adopt it over my
§2.6's "owner dispatch envelopes unchanged": once peer messages carry
`from`, an unstamped owner reply is recognized only by an absence
convention. The uniform rule ("every delegate `send` stamps its host-bound
caller") makes sender identity explicit in every envelope and lets any
recipient address its sender without a second vocabulary. This **is a
product-visible change to shipped leader→member envelopes** (`<task>` →
`<task from="<owner>">`), so per the requirement's own rule it is named and
returned for operator confirmation — not decided silently. `spawn`'s first
prompt stays unchanged (named, out of scope). If the operator declines,
the member copy must state the absence convention ("a message without a
from attribute is your owner's").

### D. `list` shape — revised: grouped owner + peers

My §2.6's uniform rows are revised to the shape both other seats hold:
`{ owner: { name, status }, teammates: [self-excluded compact rows] }`.
It reuses the existing `TeammateOps.list()` projection verbatim for peers
(no row mapping) and makes the requirement's "the owner actor is not added
as an ordinary member" visible in the contract. My `kind: 'owner' | 'member'`
row discriminator was a second shape for the same information — rejected.

### E. Provenance source name — held: reuse `AGENT_TASK_SOURCE` + `attrs.from`

Trae V2.4.6 retains `MEMBER_MESSAGE_SOURCE = 'member-message'`; DeepSeek
R2.4.3 agrees with holding `task`+`from`. I hold `task`+`from`:
`submission-sources.ts:30-34` already documents `task` as "Work an Agent
handed to another Agent: an MCP spawn or submit, …" — a member message is
an MCP submit between Agents; no Channel or CoT consumer branches on the
source name; `from` carries the identity bit a new name would redundantly
encode. Trae itself records the behavior is identical — a copy fork for
final reconciliation, not a correctness question. (Named consequence,
accepted: no source-based message-vs-dispatch filter for a future display;
nothing today needs it.)

### F. Tool field names — held: `{ name, prompt }`

DeepSeek R2.4.2 keeps `{ to, message }`; Trae V2.3 agrees with
`{ name, prompt }`. Held against DeepSeek: the member `send` is the same
verb family as the leader-facing `send`, and `SendTeamMateInput` already
speaks `name`/`prompt`; one vocabulary across the two `send` surfaces is
worth more than the message-flavored synonyms. Low-stakes copy fork;
recorded, not blocking.

### G. Q3 discriminator — settled: construction kind from the entry points

All three agree the arm must not be inferred from options shape
(`createLocked` and `spawn` both pass `{}` into the shared build path).
DeepSeek R2.6.3 states it as an explicit construction kind; Trae V2.4.4's
"the locked caller leaves messaging unset, so no new disarm flag is needed"
is compatible only when read as "no new options **field**" — the two entry
points (`createLocked` vs spawn/materialize/reopen) already differ and each
threads its own arm value into `teammateOptions`. Adopted in that reading;
a shape-inference gate would be wrong (both paths pass `{}`).

### H. Ordering residual — accepted Trae's bounded claim, kept named

My §2.8 named a residual: no-completion settlements (`stopped` from
interrupted frames, transport `failed`) deliver via settlement continuations
and could, in principle, interleave behind a later same-batch result.
Trae V2.6.3 argues this is unreachable in practice: an interrupted frame
has no later result frame in the same synchronous parse batch (a later
result belongs to a full intervening turn), and a transport death ends the
session. Accepted with the reasoning added: the residual is ordering-only
(no loss, no duplicate), confined to cases that cannot share one parse
batch, and outside Q1/Q1a's completed/failed result contract. No hop-
discipline or sequence field is added for it.

### I. Prompt content — held: precise observed-fact contract

DeepSeek R2.4.4's "the now-true delivery promise" is rejected as still
false (interrupted turns report nothing; a non-live owner drops the
push-back as `unsupported`). Trae V2.9 and my §2.6 state the precise
contract (completed/failed turn results — including unbound — report
automatically; that is the turn's output, not goal success; interrupted and
owner-unavailable cases are not; replies only via explicit `send`). Exact
copy is operator-visible at final review.

### J. Unscoped-failure emission — accepted from both seats

Emit the failed completion for Codex unscoped collector failures
(`failProtocol`/`failRecord`, including representative-null records) — a
provider-observed failed terminal under Q1a — while `stop()`/transport
death without an observed terminal emit nothing. Keep the live-verification
note (confirm the real protocol shape during implementation).

### K. Module placement — held: conditional split at the line gate

Trae V2.3 pre-splits a `member-messaging.ts` sibling; DeepSeek R2.4.2
keeps the third arm in `mcp.ts`. Held: `mcp.ts` is 627 total lines against
a 700 **code**-line gate; the addition may not trip it. If it trips, the
sanctioned response is the named sibling module Trae describes (server
assembly and the `teammate` name stay in `mcp.ts`). Speculative pre-split
is not needed to satisfy the acknowledged placement.

## R3.4 Revised complete position (supersedes §2 where it differs)

1. **Owner port (final shape)** — supplied by each owner at member-collection
   construction; consumed by the `team_member` delegate and prompt assembly:

   ```ts
   export interface MemberMessagingOwner {
     /** Lazy: read at delegate build/send time (record exists by then). */
     ownerName(): string;
     /** Copy-only role word ("TeamLeader" / "Dispatcher agent"). */
     readonly ownerLabel: string;
     /** The owner's roster row for `list`. */
     ownerRow(): Promise<{ name: string; status: string }>;
     /** Fenced owner inbox; the type forbids a completion recipient. */
     submitToOwner(
       input: Omit<TeammateSubmitInput, 'completionRecipient'>,
     ): Promise<TurnAdmission>;
   }
   ```

   Producers: `TeamService` (`leader_name` read lazily from the record,
   `submitInput`, leader identity status) and `DispatcherService`
   (`DISPATCHER_AGENT_NAME`, `submitToAgent`, `dispatcherAgent` status).
   `TeammateCollectionOptions` also receives the MCP primitives
   (`Pick<TeammateAgentMcp, 'leases' | 'adminSocketPath'>`); both owners
   supply everything, so the bundle is required (no nullable).
2. **MCP surface** — `teammate` server, third scope arm
   `{ kind: 'team_member', member: { self, owner, peers: Pick<TeammateOps, 'send' | 'list'> } }`.
   `send { name, prompt }` (no `intent`, no sender); `list {}` returns
   `{ owner: { name, status }, teammates: [...] }` (self excluded). Receipt:
   `toSubmissionResult` projection + new admission-only reminder copy.
   Routing: `name === owner.ownerName()` → `submitToOwner` with
   `{ source: AGENT_TASK_SOURCE, attrs: { from: self }, text }`; else
   `peers.send` with `attrs: { from: self }`; self/unknown/cross-collection
   refused as in §2.5. **Recommended, flagged for operator confirmation:**
   the owner scopes' existing `send` handlers stamp
   `attrs: { from: <host-bound caller> }` too (uniform sender rule; shipped
   envelope change); `spawn` unchanged; on decline, the absence convention
   is stated in the member copy.
3. **Native-result contract and emission** — as §2.6–§2.7 (required
   `results`; emit every completed/failed native terminal synchronously at
   observation; same frozen object; never interrupted/teardown/unobserved;
   shared completion→fact mapping; `result: null` on failure; unscoped Codex
   failures emit per R3.3.J; Codex emits bound records' completion through
   the sink before member settlement in the `drainTerminalOrder` loop).
4. **Ordering and convergence** — as §2.8 with R3.3.H's bounded residual;
   verification: multi-`result`-line chunk tests in both orders plus a third
   bound frame; exactly one delivery per native result; fold join produces
   no second prepare/submit; Codex `terminalOrder` mixed heads preserve
   order; interrupted heads emit nothing; revoked-generation writes drop.
5. **Arming** — one construction kind threaded from the entry points
   (`createLocked` disarms; spawn/materialize/reopen arm), arming the tools
   and the reporting owner (`nativeResultOwner = this.opts.completionOwner`)
   together; Q3 as §2.9.
6. **Wording** — as §2.6/§2.12 with R3.3.C's uniform-`from` copy question
   and R3.3.I's precise prompt contract; exact texts are operator-visible.
7. **Compatibility / accounting / verification** — as §2.12–§2.13 plus the
   expanded ordering suite and the both-scopes × both-runtimes matrix
   (root-member messaging, unbound delivery to the Dispatcher agent,
   dispatcher-fence drops, root-level Workflow disarm).

## R3.5 Distinction of authority

- **Operator decisions (binding, not reopened):** Q1 「每个完成回合自动报」,
  Q1a 「失败也自动报」, Q2 「允许 send 重新打开」, Q3 「只覆盖普通成员」,
  Q4 「我期望是两类都覆盖 …简洁，足够抽象和可复用」; the #471 baseline
  and the preserve clauses; the acknowledged MCP home and placement
  (「可以」); the rule that a proposal changing additional product behavior
  must name it and return for confirmation.
- **Code facts (verified, not decisions):** R3.2's five items; the inbox
  types; the router's fold/FIFO/never-retract; `owesCompletion`; the
  Workflow close-then-unlock sequence; the unbound Codex branch.
- **Design inferences (mine, reviewable):** emit-all ordering mechanism and
  its bounded residual; the port shape (lazy name, label string, row
  method, `Omit` inbox); `task`+`from` reuse; the uniform-`from`
  recommendation; grouped `list`; `{name, prompt}` fields; conditional
  module split; unscoped-failure emission.

## R3.6 Material disagreements and blocker

- **Remaining disagreements:** provenance constant (Trae: `member-message`;
  held: `task`+`from` — behavior identical, copy fork); tool field names
  (DeepSeek: `to`/`message`; held: `name`/`prompt`); module placement (Trae:
  pre-split; held: gate-conditional); `ownerKind` enum (Trae) vs label
  string (held). All four are low-stakes surface choices, documented.
- **Genuine blocker: none.** The one product confirmation named to the
  operator is the uniform `from` stamping on owner sends (R3.3.C) — the
  mechanism works either way, but the envelope change must not be decided
  silently. Failure-body enrichment and exact copy texts remain
  default-unchanged review items. Everything else is implementable as
  R3.4 stands; residual risk is verification burden (reference-identity
  discipline, ordering suite, Codex unbound frequency), not open design.

---

# Neutral runtime interface reassessment — independent proposal

All earlier sections are preserved history. This is the independent
reassessment authorized by
[interface-reassessment.md](../interface-reassessment.md) after the
operator's hold:

> 进一步讨论一下，agent runtime 的接口扩展需要格外谨慎。我理解这是对compilation的整个颠覆，但是任何中立 interface 的变更都要慎重

The quoted term is retained verbatim and is not reinterpreted here. Requirement
revision 2 still supplies product behavior; nothing below removes Q1/Q1a
coverage or changes Workflow/interruption scope. Evidence discipline: the
**baseline** is `git show HEAD:<path>` (pre-feature `next`); the **candidate**
is the delivered worktree implementation; [final.md](../final.md) is
comparison evidence under hold, not authority. The member MCP surface is
Core-internal (not neutral ABI) and is outside the challenged seam; this
report addresses the runtime interface shape.

## 4.1 Classification: unavoidable capability versus chosen shape

**Unavoidable capability requirement** (implied by requirement revision 2,
independent of any interface choice): a provider-observed native terminal
that settled no Dreamux submission, carrying a normal or observed-failed
result, must reach the owner-reporting path **exactly once, in native
terminal order relative to bound-result reports**, with stable result
identity, interruption/teardown exclusions, owner-stop suppression,
generation-replacement safety, and convergence of started delivery work.
The three baseline contracts cannot express it:

- `RuntimeSubmission.settled` (baseline `agent-runtime.ts`) is one handle
  per **accepted submission** ("Its identity never implies folding" — the
  fold is Core's WeakMap policy over the provider's per-result object).
  Unbound work has no handle to settle.
- The activity seam is documented presentation: "transient input to the Core
  conversation projection, not a progress view … its absence changes only
  presentation" (`activity.ts` / `agent-runtime.ts` at HEAD); `turn.ended`
  carries no result payload; `RuntimeActivity` "cannot honestly name the
  submission"; Channel-bound text is redacted; the projection is
  best-effort with no replay. Turning it into a delivery source is a
  contract **replacement**, not a reuse (analyzed as S3).
- `AgentRuntimeStateSink` is durable status publication;
  `readRecentActivity` is a bounded cold read whose neutral records
  deliberately exclude results and settlements.

**Chosen transport/interface shapes** (the real design space): where the
ordered result channel lives, whether it is required or optional, what its
payload type is, and how once-only/order are achieved. Also chosen, and
separable: the emit-all synchronous publication mechanism (versus
alternatives in 4.3).

## 4.2 Baseline contracts established from HEAD (ownership / identity / stop)

| Contract (HEAD) | Ownership | Identity | Stop/convergence |
| --- | --- | --- | --- |
| `RuntimeSubmission.settled` → `RuntimeSubmissionSettlement` | The answer to one host-admitted input; delivered to the recipient captured at submit | One immutable `RuntimeCompletion` per native result is provider convention; `kind:'failed'/'stopped'` settlements carry no token | `EntityTurn` reads `owesCompletion()` at settlement continuation ("owner teardown permanently suppresses an unstarted delivery"); `convergeRetainedTurns` joins started delivery at close/host stop; "a delivery that already started is never retracted" |
| `RuntimeCompletion` | "A provider-observed native result" — already the neutral result vocabulary | The fold key (Core `WeakMap`) | n/a |
| `AgentRuntimeActivitySink` | Presentation only | Activity ids are native-object ids, explicitly not submission identity | Revoked-generation writes drop; absence changes only presentation |
| `AgentRuntime` | "Nothing is pulled from it: every runtime fact flows out through the leased state and activity sinks" | — | Stop settles outstanding submissions; no pull drain exists |

The candidate changes **none** of these types or policies
(`git diff HEAD` shows `completion-router/index.ts` and the settlement
types untouched; `turn.ts` only extracts the shared fact mapping). Its
neutral delta is exactly one function type plus one required context member
(13 lines in `dreamux-types/src/agent-runtime.ts`).

## 4.3 Alternatives, compared end to end

### S1 — Required `results` push sink on `AgentRuntimeCreateContext` (the delivered candidate)

Provider publishes every non-interrupted terminal's `RuntimeCompletion`
synchronously at terminal finalization, bound or unbound, the **same
object** settlements resolve with; Core folds observation and settlement
into one owner delivery; interrupted/teardown publish nothing.

- **Provider-author burden:** one publication call at the point the
  completion is already constructed (Claude: `completionFromTurnOutcome`
  for every non-interrupted `result`, `rpc.ts`; Codex: extracted
  `completionFromTerminal` at the terminal-queue head, `turn-manager.ts`).
  The rules to know: publish once per result, same object, synchronous,
  never for interruptions/connection failure.
- **Neutral contract change:** additive required context member + one
  function type, payload = the **existing** `RuntimeCompletion` (no new
  result vocabulary, no change to submission/settlement/activity/state).
  Why existing contracts cannot express the behavior: 4.1.
- **Ownership/consumers:** submission answers stay `settled`→`EntityTurn`;
  unsolicited native results go `results`→`AgentService.observeRuntimeResult`
  → the collection's existing `completionOwner` (Team / Dispatcher agent);
  model-directed reporting is the member `send` tool (separate mechanism,
  unchanged). One shared `turnCompletionFact` words both report kinds.
- **Identity/order/stop/generation/shutdown:** once-only by shared-object
  fold (the pre-existing WeakMap, now exercised on every bound result);
  order because the sink enqueues at the terminal stack, before any
  settlement microtask (Claude's synchronous `onStdoutChunk`→`onLine` loop,
  `rpc.ts:135-141`, is the named hazard); generation lease drops stale
  writes; started deliveries tracked in `InFlightWork` and joined at
  close/host stop (named scenario: a result accepted just before close
  while a recipient submission is pending). **Stop-timing delta (named):**
  for completion-bearing results `owesCompletion()` is now read at
  terminal publication, one microtask earlier than baseline's settlement
  continuation — "terminal, then stop before the microtask" delivers where
  baseline suppressed. Never-retract then applies from publication.
- **Compatibility:** binary — older provider binaries ignore the extra
  property and still load; source — providers consuming the context compile
  unchanged, Core/in-tree fixtures that *construct* contexts must supply
  the field (`typecheck:tests` is the gate), and — unlike an
  interface-method addition — implementors of `AgentRuntime` are not
  broken; semantic — loading is not coverage: a provider that ignores the
  sink keeps bound-only reporting and must not be described as Q1/Q1a
  covered. Three separate claims; the README must state the third.
- **Removals/coexistence:** removes the unbound-result discard at both
  providers' drop points, the Codex orphan-turn bookkeeping
  (`unboundObservedTurnIds`/`releaseOrphanTurnsIfIdle` are deleted in the
  candidate — a real code removal), the "finished its task" overclaim, and
  the no-member-tools invariant (messaging half). Coexists with settlement
  reporting (folded), activity display, state sink.
- **Strongest counterexample:** the discipline is convention + tests only —
  a custom `ClaudeCodeSession` factory (or any future provider) that
  constructs a second `RuntimeCompletion` for one result, or publishes after
  an `await`, silently double-delivers or reorders; nothing structural
  stops it. **Verification:** per-adapter reference-identity assertions;
  multi-`result`-line batch tests in both bound/unbound orders asserting
  *delivered report* order and exactly one delivery per result; the
  stop-timing window test; close/host-stop join tests.

### S2 — Optional `results?` (and S7 — optional plus a provider capability flag)

Identical behavior when implemented; the field is not required at compile
time.

- **Burden/contract:** same implementation; softer type. Core constructs
  every context, so optionality exists only to excuse fixture/third-party
  constructors — while forfeiting the "forced deliberation" property (the
  reason `state`/`activity` are required at baseline: Core always supplies
  them).
- **Compatibility:** source-friendlier for out-of-tree context
  constructors; binary/semantic identical to S1 (the semantic gap is not
  closed by any of these shapes).
- **S7 adds** a `nativeResults` capability flag: a negotiation mechanism
  whose only consumer would be documentation — no caller changes behavior
  on it. The whitepaper's ban on access-policy machinery without a named
  consumer applies; document coverage in the provider README instead.
- **Counterexample:** a fixture constructing a context without `results`
  silently verifies a world the contract does not describe; a provider that
  "sometimes" emits breaks mixed ordering. **Verdict:** rejected —
  optionality buys compile convenience and costs the only compile-time
  enforcement point that exists.

### S3 — Replace the presentation contract: a result-bearing `RuntimeActivity` member on the existing sink

One sink instead of two; the activity union grows a member carrying the
`RuntimeCompletion`; Core's delivery consumer reads it.

- **Burden/contract:** the provider author's work is identical to S1, but
  the contract it implements is **replaced**: "its absence changes only
  presentation" becomes false, and every display consumer (CoT projection,
  channel adapters) now shares a stream with a delivery consumer that needs
  different gating (`owesCompletion`, fold) than display (redaction,
  truncation, best-effort drop). The union grows exactly the N-valued
  discriminant the whitepaper warns against when both sides treat members
  differently.
- **Ownership/consumers:** conflates "what a human sees" with "what the
  owner is owed"; display bounds (10-line truncation, per-surface byte
  limits, Channel-side redaction) either leak into delivery or must be
  bypassed by rule.
- **Identity/order/stop:** feasible (the completion object rides the
  member; emission order is the same synchronous order) but every gate
  above must be reimplemented on the shared stream.
- **Compatibility:** source impact reaches **channel packages** (unknown
  activity kinds on old display consumers) — a strictly larger blast radius
  than S1, which touches no channel code. Binary: old consumers see an
  unknown `kind`.
- **Removals:** one context field. **Adds:** a repurposed documented
  contract, a filter rule in every display consumer, and a two-consumer
  stream. Net entropy increase.
- **Counterexample:** the display projection's own best-effort drop path
  (revoked lease, projection failure caught and logged) is documented as
  acceptable *for presentation*; the same drop on a delivery fact is lost
  owner news. **Verdict:** rejected — this is the "presentation seam as
  delivery contract" glue the requirement's own source-evidence section
  warns against; possible as a deliberate replacement, but bigger than S1
  in every dimension that matters.

### S4 — Pull/drain on `AgentRuntime` (e.g. `results(): …`)

- **Contract:** adds a method to the interface every provider implements —
  an implementor-breaking source change (worse than a context field), and
  a direct reversal of the baseline principle "Nothing is pulled from it."
- **Mechanism:** the provider must buffer unbound results until drained —
  a per-entity grow-only structure whose total bound must be stated
  (whitepaper §1), lost on crash/stop before drain; mixed bound/unbound
  order cannot be preserved by pull unless Core drains synchronously at
  each terminal — i.e. push in disguise plus a buffer.
- **Counterexample:** host stop before drain silently loses the very
  background results Q1 protects; a long Core stall fills the buffer.
  **Verdict:** rejected.

### S5 — Unbound-only emission plus an order key (sequence field on `RuntimeCompletion` or the settlement union)

The only shape that keeps baseline bound stop-timing *and* mixed order —
by changing a **baseline type** (`RuntimeCompletion` is pre-feature shared
contract) and adding an ordering queue to the router (deliveries held for
a missing earlier key).

- **Mechanism:** new field ripples through every provider constructor and
  the output-schema contract; the router's "order = arrival" FIFO becomes
  "order = key, with holds" — a policy change in untouched code today;
  non-stamping external providers fall back to arrival order (the hazard
  returns precisely for them) and a missing key raises a hold-with-bound
  question. Removes nothing; adds two mechanisms.
- **Counterexample:** two results with absent/equal keys reorder silently;
  a held delivery at close needs its own convergence story.
  **Verdict:** rejected as a larger change than S1 for one microtask window
  of stop-timing fidelity.

### S6 — No neutral change (submission-bound reporting plus model-directed background reporting)

Classified only: product-incompatible with recorded Q1/Q1a
("No new decision removes its normal/failed native-result coverage"). It is
a product revision, not a transport option, and is not offered here.

## 4.4 Compatibility claims, separated (the three senses)

| Shape | Binary tolerance (extra property/method) | TS source compatibility | Fulfils the semantic guarantee |
| --- | --- | --- | --- |
| S1 | Older provider binaries load and run | Context consumers unaffected; in-tree context **constructors** (Core, fixtures) must add the field — `typecheck:tests` pins; `AgentRuntime` implementors unaffected | Only with provider emission + same-object discipline; documented, never negotiated |
| S2 | same | Weaker: constructors may omit silently | same |
| S3 | Unknown activity kinds hit old display consumers | Channel/display packages must update | same, plus display-drop risk |
| S4 | n/a (method) | **Breaks implementors** | only with drain discipline |
| S5 | n/a (field on baseline type) | Breaks every completion constructor | only with key discipline |

Loading ≠ coverage in every row; only the semantic column is the product
guarantee.

## 4.5 Independent re-adjudication of two candidate points

1. **Connection-level failure is not a turn result — I agree with the
   delivered exclusion** (and correct my own earlier cross-review position
   that accepted per-record unscoped emission). Evidence: `events.ts`
   routes `onUnscopedFailure` as a connection-level event explicitly
   distinguished from a turn terminal ("nothing scopes a recovery to a
   single turn"), and Q1a itself forbids fabricating "a terminal result for
   background work the runtime did not observe ending." Emitting
   per-record completions there would invent results; bound transport
   failures keep their existing tokenless `kind:'failed'` settlement
   reporting.
2. **The stop-timing delta is real and is the candidate's only behavioral
   change touching a preserve clause.** Baseline reads `owesCompletion()`
   at the settlement continuation; S1 reads it at terminal publication
   (final.md names and tests this). The window is one microtask; the
   alternative shapes that eliminate it (unbound-only) surrender the
   ordering criterion. This is the one genuine product micro-decision
   (4.7).

## 4.6 Recommendation and evidence

**Recommendation: S1 stands as the least-change shape that delivers the
unavoidable capability**, revised only by 4.5.1's confirmation (already
implemented that way). Evidence, not votes:

- It is the only shape with **zero change** to the baseline settlement,
  completion-identity, and delivery-policy contracts (diff-verified:
  `completion-router/index.ts` and the settlement types are untouched; the
  fold reuses the pre-existing WeakMap identity).
- It adds 13 neutral lines reusing the existing result vocabulary, versus
  S3 (contract replacement + channel blast radius), S4 (implementor break
  + buffer + principle reversal), S5 (baseline-type change + router queue).
- It matches the seam's stated philosophy (push-only leased sinks) instead
  of fighting it.
- Its payload carries no new noun the operator has never seen
  (`RuntimeCompletion` is pre-feature contract).

This is not a claim of globally optimal architecture — a hypothetical
world where Core never needs unsolicited facts would need none of this, but
requirement revision 2 records the opposite. The operator's caution is
answered by the classification in 4.1: the *capability* is forced; the
*shape* was chosen to change the least.

**Strongest counterexample to S1 (stated plainly):** the once-only and
ordering guarantees rest on a cross-package convention (same frozen object,
synchronous publication, interruption exclusion) enforced by tests and
README text only. A provider that clones the completion or publishes after
an await silently double-delivers or reorders — and the binary-tolerance
claim means such a provider still loads and appears healthy. Mitigation is
verification (identity + delivered-order tests per adapter) and honest
documentation of the semantic column in 4.4; there is no structural
enforcement without reintroducing S5's machinery.

## 4.7 Genuine decision needed (product, not preference)

**Owner-stop timing in the terminal→settlement window.** Under S1, a
completion-bearing result observed just before an owner stop is delivered
(baseline would have suppressed it at the settlement continuation one
microtask later). Options: (a) accept the publication-time reading —
coherent with "started work is never retracted," named and testable;
(b) demand byte-identical baseline timing — price: either unbound-only
emission (surrenders the mixed-order criterion) or hop-depth coupling /
S5's sequence machinery (both larger and fragile). I recommend (a) and
flag it for explicit confirmation, since requirement revision 2 preserves
owner-stop behavior "unless a separate explicit decision changes a named
behavior." No other product fork remains: failure-body and copy texts stay
default-unchanged; S2/S3/S4/S5 are implementation-shape rejections, not
product choices.

## 4.8 Verification burden of the recommendation

Per-adapter reference-identity assertions (settlements and sink share one
object); delivered-order tests on multi-`result`-line batches in both
bound/unbound orders with folded submissions and a third bound frame; the
stop-window test (terminal, stop before continuation); close/host-stop
join of `nativeReports`; revoked-generation drop; interrupted and
connection-failure non-emission with existing bound settlement assertions
untouched; both scopes × both runtimes; `rush build/lint/test/typecheck:tests`
with fixture contexts updated. The same suite is the only structural
defense of the 4.6 counterexample.

---

# Neutral runtime interface reassessment — cross-review and revised position

All earlier sections are preserved history. This is the single cross-review
of the three independent reassessments (`deepseek.md` RZ.x, my §4.x,
`trae-seed.md` N.x), under the implementation hold and
[interface-reassessment.md](../interface-reassessment.md). Requirement
revision 2 remains the product authority. Adjudication is against HEAD
baseline source, the delivered worktree candidate, and the recorded
approval — not vote counts. The five report dimensions the review must
cover are answered in R5.2–R5.6; settled points are not reopened (R5.5).

## R5.1 Material agreements (all three reassessments)

1. **The capability is unavoidable and the classification stands.** No
   baseline contract carries an unsolicited native result: `settled` answers
   Core-issued submissions only; `activity` is documented presentation
   ("its absence changes only presentation"; `turn.ended` carries no
   result); `state` is durable status; `readRecentActivity` excludes
   settlement. Requirement revision 2 (Q1/Q1a + the ordering criterion)
   forces a provider→Core result channel. The interface caution is answered
   by minimality analysis, not by avoiding the change.
2. **The delivered shape is the recommendation in all three papers** — one
   required leased `results` sink beside `state`/`activity`, synchronous
   emit-all publication of the same frozen `RuntimeCompletion` settlements
   use, fold via the pre-existing router WeakMap, `EntityTurn` retained for
   tokenless outcomes and non-armed roles, `InFlightWork` convergence. The
   candidate is not a rebuild of completion: diff-verified untouched —
   `RuntimeSubmission`/`RuntimeCompletion`/`RuntimeSubmissionSettlement`,
   `completion-router/index.ts`, and the recipient model.
3. **Every no-new-field alternative fails a concrete counterexample:**
   synthesis from display activity (no shared identity; wrong `resultText` —
   DeepSeek RZ.3-O3), result-bearing activity widening (contract
   replacement; Error payload onto the Channel display bus — Trae N.3-B),
   state-sink overload (durable/rejecting contract for a non-durable event —
   DeepSeek RZ.3-O4), provider-minted submissions (invents submission
   identity the seam forbids — DeepSeek O5 / Trae C), pull/drain (violates
   "Nothing is pulled from it"; needs buffering — my S4 / Trae D),
   sequence-keyed ordering (changes a baseline type + router queue — my S5 /
   Trae E).
4. **The candidate's real semantic scope** (all three name it): (i) the
   publication point of completion-bearing bound results moves to terminal
   observation, taking owner-stop eligibility with it; (ii) dual
   publication (observation + settlement) rests on cross-package
   same-object identity. Field count is not the story.
5. **Removals are real:** Codex `unboundObservedTurnIds`/
   `releaseOrphanTurnsIfIdle` deleted; Claude's answered-only completion
   conditional removed; the duplicated `EntityTurn` fact mapping replaced by
   `turnCompletionFact`.

## R5.2 Compatibility: the full matrix (report dimension 1)

The constructor/consumer split (DeepSeek RZ.3-O1, accepted and sharpened):
providers **consume** `AgentRuntimeCreateContext`; the only constructors are
Core (`RuntimeGeneration.resolveLaunch`) and test fixtures. Therefore a
required consumed field is **not** a TypeScript source break for provider
authors — they gain an unguarded call target — while context **constructors**
(Core fixtures, an external author's own fixtures compiled against the new
types) must supply the field, pinned by `typecheck:tests`.

| Pairing | Required `results`, unguarded call (delivered) | Optional `results?`, guarded call |
| --- | --- | --- |
| New host + old provider binary | Loads; extra property ignored; bound reporting unchanged; **unbound coverage absent** (semantics, not crash — document) | identical |
| New host + new provider | Full contract | Full contract |
| Old host + new provider binary | **Runtime crash risk** (below) | Graceful: no sink, bound reporting intact, unbound silently absent |
| Old host + old provider | Unchanged | Unchanged |

**The old-host/new-provider cell is the one analysis my §4.4 and DeepSeek's
RZ.3 missed and Trae's N.4 table caught** ("unconditional `results(...)`
call would throw on a Core that supplied no sink"). Sharpened with the
concrete failure chain from the delivered Claude path: the emission call
sits **before** the answered-request settle loop (`rpc.ts` result branch),
so a `TypeError` from calling a missing property strands those
settlements — outstanding requests never settle, the max-idle deadline
reaps the resident session, and the turn is lost with a crash on the parse
path. Precedent check (code fact): the seam has grown required sinks before
(`state`, `activity`), and `dreamux-types` is declaration-only — there is no
runtime version handshake anywhere in the loader, so skew protection can
only be documentation or call-style. In-tree providers ship with the host
(no skew); the exposed surface is external `npm:` providers and custom
session factories.

**Resolution (revised position):** keep **required** (house idiom;
normative strength — non-emission is then a documented contract violation,
as Trae N.3-A′ argues), and make the skew contract explicit in the
implementing change: provider READMEs state a minimum host/types version
(the exact pattern the Claude required-command-group extension already
used), with the unguarded-call failure above named as the reason. An author
who must run on both host generations writes the call guardedly
(`context.results?.(...)`) and documents that unbound coverage is
host-gated. If the operator prefers skew tolerance over normative strength,
`results?:` + guarded calls is the honest fallback — a contract-policy
choice, not an implementation preference (Trae N.7.2, sharpened: the two
are **not** mechanically identical — they differ exactly in the
old-host/new-provider cell and in what non-emission means).

## R5.3 Report ownership independent of transport (report dimension 2)

All three papers agree, and the review records it as a transport-invariant:
submission answers are owned by `RuntimeSubmission.settled` → `EntityTurn`
→ the recipient captured at submit; unsolicited native results are owned by
the terminal observation → the armed member's existing `completionOwner`
(Team / Dispatcher agent); model-directed reporting (member `send`) is an
ordinary submission with no automatic reply obligation. **No shape in
R5.1.3 moves any of these owners** — activity widening would merely carry
the same fact through a display-labeled pipe; provider-minted submissions
would invert who proposes work; pull would delay it. The arming policy
(`nativeResultRecipient` only for ordinary collection members of either
owner) is Core policy, orthogonal to the seam. The review therefore
confirms: ownership questions cannot be used to prefer or reject a
transport shape, and the operator's interface caution is not an ownership
question.

## R5.4 Fundamental versus shape-following requirements (report dimension 3)

- **Fundamental (any shape that satisfies requirement revision 2):**
  exactly-once per native result per recipient; report order equals native
  terminal order (the acceptance criterion names the parser fact);
  interruption/teardown/transport-death exclusion (Q1a: no fabricated
  terminals); owner-stop suppression with started-delivery never-retracted;
  generation-replacement safety; shutdown convergence of started delivery.
- **Follows from the selected dual-report path (settlement reporting
  retained + observation added):** the **same-object identity** rule — it
  exists because two reporters describe one result; an exclusive-routing
  shape (unbound-only) would need only a classification guard, and a
  single-channel shape would need neither — but both alternatives were
  rejected on ordering (unbound-only) or contract-replacement grounds
  (single-channel). The shared `turnCompletionFact` mapping is the same
  class: payload equality across the two reporters.
- **Follows from synchronous publication:** the stop-timing move (R5.5.3)
  and the rejection of microtask-depth coupling; sequence-keyed ordering is
  the alternative mechanism and is strictly larger (baseline-type change +
  router queue).

So the identity discipline is fundamental *to this shape*, not to the
product requirement; the review keeps it because every shape that avoids it
surrenders a different, more fundamental requirement.

## R5.5 Approval, hold, and closed points (report dimension 5)

The recorded sequence: the reconciled solution received development
approval and was implemented; the operator then held advancement and opened
this interface discussion ("任何中立 interface 的变更都要慎重" — quoted,
not stretched). The hold challenges the **interface shape**; it does not
revisit settled product or adjudicated design points. The following are
closed and are **not** reopened because a proposal lists them as unknowns:

1. **Q1/Q1a coverage** (operator cards, verbatim) — and the
   interface-reassessment itself states "No new decision removes its
   normal/failed native-result coverage." Trae N.3-Option 0 and N.7.1
   ("accept any new channel at all versus reopening Q1/Q1a") are therefore
   not live decisions in this round: model-directed-only reporting is a
   product revision outside this consultation's authority. Recorded for the
   operator's awareness only as the zero-contract-cost boundary case.
2. **Connection-level failure is not a turn result** — final.md §5
   adjudicated non-emission of per-record `failProtocol`/`failRecord`
   completions, the implementation matches, Q1a's "no fabricated terminal
   result" and `events.ts`'s scoped/unscoped distinction support it, and my
   §4.5.1 independently agreed. DeepSeek RZ.6's "confirm this is the
   intended boundary" is a reopened settled point; the boundary stands.
3. **The owner-stop timing move is named, deliberate, and test-required in
   the approved solution** (final.md §4: "do not call this byte-identical
   stop timing", with its terminal-then-stop race test). My §4.7 and Trae
   N.7.3 presented it as an open product decision; per the approval record
   it travels with the confirmed shape as an already-returned named change.
   It re-enters operator attention **only** if a different shape were
   selected (none recommended here is). Trae's counterexample (an owner
   stopping precisely to suppress a just-finished answer) is the named
   scenario the approved test pins; it is a limitation, not an open fork.

## R5.6 Activity-contract redesign, evaluated explicitly (report dimension 4)

The activity family has two redesign variants, and the review states them
without assuming the baseline payload survives:

- **Synthesis from the unchanged payload** (DeepSeek RZ.3-O3): derive
  results from `turn.ended` + `assistant.message`. Fails on identity (no
  completion object to fold — every bound turn double-reports) and fidelity
  (`turn.ended` has no text; `assistant.message` is agent-keyed and cannot
  be attributed to a terminal; the real `resultText` comes from
  `completionFromTurnOutcome`/`extractAssistantText` with session-pin and
  structured-output mapping). Decisive.
- **Payload redesign** (Trae N.3-B, accepted and made explicit): a
  result-bearing activity kind or result fields on `turn.ended` — i.e. the
  baseline payload *does* change — and the activity contract is replaced
  ("absence changes only presentation" becomes false). The sharp costs:
  a failed `RuntimeCompletion` carries a live **`Error`** object, which the
  Channel-bound display bus (`conversation-projection.ts`) must either
  serialize (host-path leak) or special-case (delivery semantics inside the
  display pipeline); live activity would exceed cold
  `AgentActivityRecord`s (which exclude settlement by design), forcing a
  delivery-only carve-out inside one channel; and it re-merges the
  display/push-back boundary the `split-streaming-display-from-pushback`
  ruling deliberately separated. Trae's concession (a narrow result kind
  with a pre-projection tap that projection strips) is mechanically
  possible and still loses: same provider burden, no contract savings, a
  wider consumer blast radius — it optimizes field count, which is not
  entropy.

Both variants are rejected on evidence, so the "no new field" instinct has
no viable activity form.

## R5.7 Revised complete recommendation

**The delivered transport shape stands, with the compatibility contract
completed (R5.2) and the closed points recorded (R5.5):** required leased
`results` sink; synchronous emit-all publication of the same frozen
`RuntimeCompletion` settlements receive; fold via the existing router;
shared fact mapping; `EntityTurn` retained for tokenless outcomes and
non-armed roles; `InFlightWork` convergence; interruption/teardown
exclusions as implemented. Provider-authoring rules are the ones in
final.md §3 (publish once per non-interrupted terminal, same object,
never for interruptions/connection loss, never throw). The documentation
delta this review adds to the implementing change: the **skew matrix and
version-floor requirement** of R5.2 (minimum host/types version for
external providers and custom session factories; the unguarded-call
failure named), and the distinction that loading ≠ coverage in both skew
directions.

Alternatives ledger (revised): every rejection in R5.1.3 stands with the
two sharpened counterexamples adopted (DeepSeek's resultText fidelity;
Trae's Error-on-display-bus) and the state-sink overload retained from
DeepSeek. Required-vs-optional is the one contract-policy question the
operator may still select (recommendation: required + version floor;
fallback: optional + guarded calls).

## R5.8 Genuine unresolved items (post-R5.5)

1. **Contract-policy choice:** required (normative; skew via documented
   version floor) versus optional (skew-tolerant; weaker guarantee
   statement). Not a product-behavior change either way.
2. **Documentation policy:** whether external `AgentRuntimeProvider`
   packages and custom session factories must declare conformance/minimum
   versions as part of their release notes (verification/KB work in the
   implementing PR).
3. **Verification-bound facts** (not forks): external-provider inventory
   and release cadence (how many implementations silently keep bound-only
   coverage); real Codex unbound-terminal frequency and the live shape of
   fatal `error` notifications.

**No architectural blocker.** The operator's caution is met by: the
capability is forced by accepted product behavior; the chosen shape is the
minimal change that satisfies it without redefining an existing contract;
the alternatives each fail a named counterexample; the two real semantic
moves and the skew matrix are named rather than implied; and settled points
stay settled. Strongest counterexample to the recommendation remains R5.2's
old-host/new-provider crash under unguarded emission — mitigated by
documentation and the optional-call variant, not structurally preventable
without the larger mechanisms already rejected.

---

# Greenfield design from requirement revision 3 — independent proposal

All earlier sections are preserved history and are **not** settled
constraints on this round. Per [greenfield-input.md](../greenfield-input.md)
the operator asked: if the mechanism were written completely from scratch,
what is the best design? Requirement revision 3 is the sole product input;
current code, `HEAD`, and the delivered worktree are comparison evidence.
This section first derives the design from the product stories (G.1–G.5),
then compares shapes and classifies adoption (G.6–G.10). Concise contract
sketches only — no runnable code.

## G.1 The product model the stories imply (organizing principle)

Requirement revision 3 has one new organizing fact — **Q5**: a managed Team
must not stream activity into the Dispatcher; only an explicit
`team.create`-prompt / `team.send` request gets an answer. Combined with the
member rules, the product model is **conversational ownership, not
management recursion**:

- Every actor has at most one *conversational owner*: an ordinary member has
  one always-on (its TeamLeader or its Dispatcher agent); a TeamLeader's
  relationship to the Dispatcher is **request-scoped** (answers to explicit
  requests only); the Dispatcher agent has none.
- Automatic result reporting is a property of **ordinary membership**, never
  of the management tree. A member report stops at its owner; the notice
  rule below cannot compose owner-of-owner, so recursion is impossible by
  construction rather than forbidden by review.
- Management visibility (reads, lifecycle projections, Channel
  presentation) is a different axis from model input and stays untouched.

Everything else in revision 3 — messaging, coverage, folding, availability,
reopen, Workflow, interruption boundaries — is a consequence of three facts
and one policy.

## G.2 Minimum facts, producers, consumers

| Fact | Authoritative producer | Consumer | Why it must exist |
| --- | --- | --- | --- |
| **Turn result** — one per observed native terminal: completed(resultText) / failed(error) / interrupted | The runtime (the only observer of native terminals) | Core's notice rule → the owner-report transport | Q1/Q1a: unbound results must reach the owner; the terminal order criterion needs one ordered publication point |
| **Request + answer** — Core-issued work owed an answer to a captured requester (spawn/send prompts, peer/owner messages with no requester, Workflow steps, `team.send`) | Core issues; the provider resolves attribution (which terminal answered which request; request-scoped failures) | The requester (Workflow scripts read the value; convergence reads completion); Core's notice rule (for reply recipients) | Request replies (Q5), Workflow results, folded-input semantics are existing obligations |
| **Addressed message** — host-bound sender, chosen target | The host, on behalf of the calling member/owner (MCP delegate) | The addressed agent's conversation | #471 messaging; sender binding is host-owned |

No fourth fact is needed: no quiet/aggregation fact (rejected by product),
no mailbox, no per-sender subscription, no task/epoch entity, no turn
registry in Core (the provider already holds the grouping knowledge).

## G.3 The ideal design

### G.3.1 Public runtime contract (new-provider ideal)

```ts
// dreamux-types — ideal shape (sketch)

/** One observed native turn terminal's outcome. */
export interface TurnResult {
  readonly status: 'completed' | 'failed' | 'interrupted';
  /** completed: provider-validated result text; interrupted: optional partial output. */
  readonly resultText: string | null;
  /** failed: the observed error. Core policy keeps it out of public notice bodies. */
  readonly error: Error | null;
}

/** A Core-issued request. Attribution is provider-owned; the value channel has no delivery side effects. */
export interface RuntimeRequest {
  readonly answered: Promise<RequestAnswer>;
}
export type RequestAnswer =
  | { readonly kind: 'result'; readonly result: TurnResult }
  | { readonly kind: 'stopped' }                 // interruption with no answer value
  | { readonly kind: 'failed'; readonly error }; // request-scoped: pre-admission refusal, transport loss

// AgentRuntimeCreateContext — one leased, synchronous, non-throwing member:
readonly turnResults: (event: {
  readonly result: TurnResult;
  /** Requests this terminal answered. Empty = autonomous (unbound) turn. */
  readonly answered: readonly RuntimeRequest[];
}) => void;
```

**What the next provider author implements:** at each observed terminal,
build one `TurnResult`, call `turnResults({ result, answered })` **once,
synchronously, in terminal order**, and resolve each answered request's
`answered` promise to the corresponding `RequestAnswer`. Request-scoped
failures with no terminal resolve `kind:'failed'` directly. Transport death
fails outstanding requests and publishes **no** turn result. Interruption
publishes `status:'interrupted'` (with partial output if the runtime has
one) and answers its requests (`stopped` or `result` per the runtime's real
behavior). That is the whole contract: **no dual calls, no shared-object
discipline, no identity semantics** — the answer references the result only
as a value.

### G.3.2 The notice rule (one Core policy function)

All delivery of ordinary-member reports is one pure decision at one place,
applied when a turn-result event arrives (eligibility read at publication;
the delivery transport — fences, FIFO tails, `prepareCompletion` push-back —
is unchanged):

```
notice(result, answered, entity):
  recipients := dedupe(answered → their captured reply recipients, non-null)
  if entity is an ordinary member of a collection
     and result.status in {completed, failed}:
       recipients += entity's conversational owner   // the collection's owner port
  if result.status == 'interrupted':
       recipients := answered-reply-recipients only  // Q1: no unbound interruption reports
  if !entity.owesCompletion(): suppress               // owner stop/close/dissolve/shutdown
  for each recipient: one notice (turn-result wording, failed body result:null)
```

Request-scoped answers with no turn result (`kind:'failed'`, pre-admission
refusals) deliver their existing failure notices from the answer resolution
itself — a disjoint fact kind, so once-only needs no identity machinery.
Codex's interrupted-with-partial-output versus Claude's stopped-with-nothing
divergence ("nobody has asked for those to agree") is preserved by deriving
the interrupted notice's wording from each request's answer kind.

Derived product properties, each falling out of the rule rather than
special-cased: multiple submissions answered by one result → one owner
report (set dedupe); observation and settlement of one result can never
duplicate (settlement carries **no** delivery); distinct results report
separately in terminal order (single synchronous publication); Q5 (leaders
have no conversational-owner arm — their turns answer only their answered
requests); no recursion; no peer-transcript copying (messages are facts of
kind 3, never notices); folded Workflow calls stay script-consumed (locked
members are not ordinary members).

### G.3.3 Messaging (minimum facts, unchanged shape)

Same design the stories force in any era: the `teammate` server's member
catalog (`send`/`list`), host-bound `from`, concrete-name addressing in one
flat namespace, the lazy owner port (name/label/status row/fenced
recipient-free inbox) supplied by `TeamService` and `DispatcherService`,
peer send through the owning collection (reopen, fences, locks as
recorded). Nothing about the greenfield result model changes messaging;
its gaps versus the delivered code are pure **adaptation**.

### G.3.4 Both collections, managed-Team isolation

One notice rule + two owner-port instances is the entire two-collection
reuse. Managed-Team isolation is the absence of an arm (G.3.2): a
TeamLeader's results only answer requests, so member reports, leader
autonomous turns, and Team activity can never reach the Dispatcher's
conversation except as answers to `team.create`-prompt/`team.send` — whose
reply obligations are the request channel's captured recipients, preserved
exactly, with later continuations extending nothing.

## G.4 Intrinsic product requirements vs transport-following

| Intrinsic (any shape must provide) | Follows from this transport only |
| --- | --- |
| Once per (result, recipient); folded inputs one report | Single publication + set dedupe (deletes the object-identity fold) |
| Report order = terminal order | Synchronous publication (a keyed-queue transport could substitute) |
| Ordinary-member coverage incl. unbound; Q5 request-scoped upward replies | The notice rule's actor-class gate |
| Interruption/transport exclusions; no fabricated terminals | Publishing interrupted results but filtering by policy (a provider-side filter is an alternative) |
| Owner-stop suppression; started delivery never retracted; generation replacement safety; convergence of started deliveries | Publication-time eligibility + leased sink + `InFlightWork` (any transport needs equivalents) |
| Sender binding; wake/reopen/lock; availability limits; no offline mailbox | Messaging facts (transport-independent) |

## G.5 Axis checklist (required by the greenfield input)

| Axis | Behavior in this design |
| --- | --- |
| One-result delivery | Structural: one event per terminal; the answer channel never delivers results |
| Folded inputs | Set-dedupe of reply recipients at the event |
| Mixed bound/unbound ordering | All result notices derive from synchronous terminal events — terminal order by construction, including multi-frame batches; the interrupted/transport residual of the delivered shape disappears (interrupted notices now derive from the event too) |
| Request answers for Workflow | `answered` promises carry the value (`RequestAnswer`); scripts read them exactly as they read `turn.settled` today; locked members get no tools and no owner notices (Q3) |
| Native vs transport failure | Native failure = `TurnResult failed` (reported under Q1a policy); transport loss = request-scoped `failed` answers, no fabricated terminal (Q1a) |
| Interruption | Event with `interrupted`; reply-recipient notices only; no unbound reports (Q1 boundary) |
| Sender binding | Host stamps; schema cannot express a sender (messaging fact) |
| Wake/reopen/lock | Explicit messages: existing wake/reopen/lock paths; automatic reports: live-runtime push-back (`wake:false`), unavailable owner may drop (revision 3) |
| Stop eligibility | Read at publication, uniformly for all results (the delivered shape's stop-timing move becomes the one rule, not a delta between paths) |
| Generation replacement | Leased `turnResults`; stale writes drop |
| Convergence | Started deliveries tracked and joined at close/host stop (`InFlightWork`); request promises converge as today |

## G.6 Settlement versus observation: the explicit decision

They need **distinct representations and distinct side-effect owners**, and
today's architecture conflates both:

- **Representation.** The request answer is a *value* for a named requester
  (and today, wrongly, a delivery trigger). The turn result is the *event*
  that reports work to a conversational owner. One terminal produces one
  result and 0..n answers referencing it. Answer kinds `failed`/`stopped`
  exist without any terminal (pre-admission refusal, transport loss) —
  proof the two are not the same fact.
- **Side effects.** Delivery belongs **only** to the result event (plus
  request-scoped failure answers). This is the change that makes once-only
  structural: the delivered design's dual-report path — and with it the
  router's `WeakMap` completion-identity fold, the cross-package
  same-object discipline, the shared fact mapping *as an equality device*,
  and the reference-identity test burden — is **deleted**, not reused.
- **Identity.** Result identity no longer carries delivery semantics; it is
  a value the answer may reference. The "single recipient per completion"
  router invariant becomes a derived property of member requests, not a
  load-bearing constraint.
- **Bookkeeping.** `EntityTurn`'s delivery machinery (delivery task,
  delivery-at-settlement, fact building) disappears; the request handle
  survives as a value promise (`WorkflowRun` reads it; convergence awaits
  it). Codex's orphan bookkeeping disappears as in the delivered candidate.
  Superseded boundary, named: `turn.ts`'s "settlement is the push-back
  line" — replaced because Q1/Q1a make results exist without submissions,
  which the old boundary cannot express without the identity fold.

## G.7 Ideal compared with `HEAD` and the delivered worktree

| Module | `HEAD` baseline | Delivered worktree | This design | Class |
| --- | --- | --- | --- | --- |
| Result fact channel | none | `results(completion)` sink, dual-report | `turnResults(result, answered)` event, single-report | **replacement** (evolves the delivered sink; supersedes settlement-as-delivery) |
| `RuntimeSubmission.settled` | value **and** delivery trigger | same + fold with sink | value only (`RequestAnswer`), no delivery | **replacement** of its delivery role; adaptation of its value role |
| `EntityTurn` | per-submission delivery | + shared mapping | deleted (delivery); request handle remains | **replacement** / partial deletion |
| `CompletionDeliveryPolicy` token fold | folds multi-submit | load-bearing for dual-path | **deleted** (recipient set dedupe at the rule); FIFO tails/fences/transport retained | **removal** |
| Same-object discipline + identity tests | incidental | contract | **deleted** | **removal** |
| Notice wording/eligibility | inline in `EntityTurn` | two derivations + `turnCompletionFact` | one rule function | consolidation (small addition) |
| Codex orphan sets | present | deleted | deleted | **removal** |
| Member MCP + owner ports | none | delivered | same | **adaptation** (retain) |
| Messaging provenance/receipts | n/a | delivered | same | **adaptation** |
| Managed-Team boundary | implicit recipient stamping | implicit | explicit actor-class gate | **adaptation** (made structural) |

Exact removals, stated as removals: the token-identity fold; the same-object
cross-package discipline and its test family; `EntityTurn`'s delivery path;
the dual-derivation fact-equality requirement; the interrupted-order
residual; Codex orphan bookkeeping (also removed by the candidate). Retained:
admission ledger, rendering, wake/reopen/locks, generation leases, delivery
transport and fences, `InFlightWork`, FIFO order, all messaging pieces.
Genuine additions: `TurnResult` + the event's `answered` set, and the notice
rule. Net concepts for a maintainer: **two facts and one policy** (result,
request-answer, notice rule) replacing **settlement-delivery + identity fold
+ dual-path agreement**. The next provider author learns one rule
("publish the terminal's result with the requests it answered") instead of
two coupled ones.

## G.8 Ideal new-provider contract versus transition support

- **Ideal contract** (G.3.1) is what new in-tree and external providers
  implement; it is a **breaking extension-seam change** (the settlement
  value shape and the new event) recorded as the established
  breaking-minor README pattern — larger than the delivered additive sink.
- **Old provider on a new host:** its settlements resolve the old union
  shape and it publishes no events → automatic reports (bound and unbound)
  are lost silently; script value reads may also break depending on shape
  mapping. Named cost.
- **New provider on an old host:** unsupported outright (the host calls a
  `submit` shape the provider no longer returns) — a harder break than the
  delivered shape's crash-risk cell.
- **Transition mechanisms and their prices** (named, per the input's rule):
  (a) keeping settlement-delivery as a fallback for non-publishing providers
  restores the fold/identity machinery the design exists to delete — a
  fallback entity for interface preservation, rejected; (b) version
  negotiation/capability bits — no behavioral consumer, rejected; (c) the
  honest transition: ship both adapters with the contract change and treat
  external adoption as the extension-seam discipline already used for the
  Claude session factory. The delivered dual-path shape is a legitimate
  **transition vehicle** toward this ideal (its sink is this design's event
  minus attribution; its fold is the first thing to delete) — the adoption
  path can stage that way if the external-provider inventory (G.10) turns
  out to matter.

## G.9 Strongest counterexample, falsifying verification, and adoption cost

**Strongest counterexample to this recommendation:** the single-publication
shape makes request replies **depend on provider conformance more strictly
than the delivered dual-path**. A provider that resolves `kind:'result'`
answers but forgets the `turnResults` event silently drops the *reply* to a
pending `team.send` (a Q5-protected obligation), whereas the delivered
design still delivers it from settlement. Missing replies are worse than
duplicates. In-tree adapters are test-covered; a nonconforming external
provider cannot be caught by in-tree tests. Falsifying verification: adapter
contract tests asserting every terminal publishes one event with its answered
set; an end-to-end `team.send` → reply delivery test that would fail on any
under-publishing provider; the same suite must run against any external
provider seeking conformance.

**Adoption class:** this is a **replacement** of the settlement-delivery
boundary (the largest single gap), **adaptation** of messaging/owner
placement, and **removal** of fold/identity machinery — a larger adoption
diff than the delivered candidate by design ("a design can be better while
having a larger adoption diff"). Whether to adopt the replacement now or
stage it (delivered dual-path as transition vehicle) depends on G.10's
first unknown.

**Genuine blockers / unresolved:**
1. **Unverified: external `AgentRuntimeProvider` inventory and reliance on
   settlement-triggered delivery.** If external providers exist at scale,
   the transition vehicle (stage the replacement) is likely right; if the
   two in-tree adapters are the population, the replacement can land
   directly. This is the one fact that selects the adoption path.
2. **Product-copy question (small, not architectural):** the interrupted-
   with-bound-requests notice currently differs per provider (Codex
   partial-output "turn result" wording vs Claude "was stopped"); this
   design preserves the divergence via answer-kind wording. Uniform wording
   would be a product-text change to confirm, not a design fork.
3. **Unverified facts, marked:** real Codex unbound frequency; live busy-input
   behavior; whether any consumer besides `WorkflowRun` reads
   `turn.settled` values (affects how purely the handle can shrink).
4. **Product choices are settled by revision 3 and not reopened here**
   (coverage, Q5, folding, availability, interruption boundaries); this
   design implements them without new product decisions.

No architectural blocker within the design itself: the notice rule realizes
every revision-3 behavior with two facts and one policy, and every rejected
alternative (identity fold, activity derivation, pull, provider-minted
submissions, aggregation) is excluded by the same counterexamples recorded
in §4/R5. The operator's code-level question is answered by the comparison:
the ideal deletes machinery the current shape must keep; its price is a
breaking provider-contract transition whose size is exactly the reason the
staged adoption path exists.

---

# Greenfield design from requirement revision 3 — cross-review and revised position

All earlier sections are preserved history. This is the single cross-review
of the three greenfield proposals (`deepseek.md`, my §G, `trae-seed.md`'s
greenfield section), conducted per
[greenfield-cross-review.md](../greenfield-cross-review.md). The TeamLeader's
working notes are treated as hypotheses and falsification cases, not as an
answer. Earlier rounds stay history.

## GX.1 The comparison the input demands: two claims, not conflated

- **R — single Core reporting owner over two legitimate inputs.** One
  reporting side-effect owner per producing entity consumes provider result
  facts *and* submitted-input outcomes, applies eligibility/destination once,
  and converges the deliveries it starts; request records shrink to
  answer-and-proof (`Turn.settled`) without delivery state. Public contract
  unchanged; the identity fold **remains** as the dedup between the two
  inputs. (The working notes' "promising minimum"; also the natural reading
  of the delivered Core's two half-owners.)
- **II — single authoritative notification event (my §G).** The provider
  publishes one result event per terminal carrying its answered requests;
  delivery derives from the event alone; the answer promise is a value
  channel. Public contract **replaced**; the completion-identity fold is
  deleted; correspondence identity (event → request handles) takes its
  place.

Both claims are legitimate and compose: R is about *who owns delivery side
effects*; II is about *what the public contract reports*. The ideal end
state is **R ∪ II**; the real question is the input model and its adoption
price. The delivered worktree is neither: it has two delivery initiators
(`EntityTurn` + `observeRuntimeResult`) joined by the router's identity
fold.

## GX.2 Source-backed adjudications (the five required items)

### 2.1 The Codex interrupted partition, spelled out exactly

Source fact (working notes; consistent with `turn-manager.ts:finalize` and
the delivered `codex-runtime.test.ts` partial-output case): an interrupted
Codex terminal **skips the result sink but settles bound requests with
`kind:'completion'`, status `completed`, and the partial text** — a
completion-bearing, non-tokenless answer that baseline and the delivered
adapter both preserve. My §G rule handles it, now stated exactly (no new
distinction required):

| Case | Event | Answer | Recipients | Wording | Matches today? |
| --- | --- | --- | --- | --- | --- |
| Codex interrupted, bound member request R (reply recipient = owner) | `{ result: { status:'interrupted', resultText: partial, error: null }, answered: [R] }` | `kind:'result'` (completed, partial) | {owner} (reply recipient only — the owner arm does not fire for `interrupted`) | turn-result wording + partial text ("completed a turn." + output) | Yes — the delivered test's `kind:'completion'`/completed/partial notice |
| Claude interrupted, bound R | `{ result: { status:'interrupted', resultText: null }, answered: [R] }` | `kind:'stopped'` | {owner} | "turn was stopped." | Yes |
| Interrupted, unbound | `answered: []` | — | ∅ | none | Yes (Q1 boundary) |

The public contract element that carries this is already in my sketch:
`TurnResult.resultText` is nullable and, for `interrupted`, holds the
provider's partial output when the runtime has one. Authoring cost: none
beyond the event shape. The wording rule (interrupted notices derive from
the **answer kind**, not the event status) is what preserves the
provider-divergent content the baseline deliberately never unified ("nobody
has asked for those to agree"). The design does not change the result text,
does not expand unbound interruption reporting, and does not fabricate
terminals. Source correction to my §G.3.2: the rule text there said
"interrupted → reply-recipient notices" without binding the wording to the
answer kind in the table — now bound explicitly.

### 2.2 The correspondence model, completed (my §G sketch was incomplete)

The input's race is real: `submit` resolves asynchronously and a terminal
can precede the admission response (Codex already handles this with
`pendingAdmissions`/`releaseAfterAdmissions`; Claude registers requests
before writing "so early native evidence cannot outrun registration").
Completed model:

- **Who creates the handle:** the provider, at request registration — the
  same moment today's `RuntimeSubmission` is created (which is *before*
  admission resolves). `RuntimeRequest` is the seam type; the provider
  references these objects in `event.answered`.
- **When Core binds the reply recipient:** at the submit **call site**, in a
  named Core record — `OutstandingRequest { handle, replyRecipient, ledger
  key, settled-proven }` — the direct replacement for `EntityTurn`'s
  bookkeeping (the working notes' "submitted-input record answers its caller
  and proves settlement"). The binding exists before admission resolves, so
  event-time policy never awaits an unknown promise.
- **How event-time policy finds the binding:** a `Map<RuntimeRequest,
  OutstandingRequest>` lookup on the referenced handle. This is
  **correspondence identity** (which requests a result answers) and must be
  named as such — my §G.6's "identity no longer carries delivery semantics"
  was over-broad: what disappears is **completion-identity dedup across two
  delivery channels**; what remains is request-handle identity plus the
  public `Turn.id` (GX.2.3).
- **Order:** publication stays synchronous and serialized (Codex defers the
  queue head until in-flight admissions settle — the existing mechanism, not
  a new queue); the notice enqueue order is terminal order.
- **Coherence cases:** rejected/skipped admission → no handle registered,
  Core discards its record, nothing can reference it (the caller still gets
  its admission result); ambiguous → the record is held until an answer or
  transport failure, with the existing fail-loud unsettled-request proof at
  close; folded requests → one event, N handles, recipient-set dedupe;
  close racing admission → the existing self-close/`InFlightWork`
  discipline; request-scoped failures (`kind:'failed'`, pre-admission
  refusals, transport death) answer without any event and deliver their
  tokenless notices from the answer path — a disjoint fact kind, so
  once-only needs no identity between the two paths.

### 2.3 Residual consumers enumerated before any deletion claim

- `teamSubmitResult` **publicly returns `turn_id`** from
  `admission.turn.id` (`team/requests.ts:102-122`; both `team.submit` and
  `dispatcher.submit` declare it in their output schema). The request
  record keeps a stable id — `Turn.id` survives as public contract.
- `WorkflowRun` reads `admission.turn.settled` as the script result
  (`workflow-service/run.ts:582-586`). The answer promise survives as the
  value channel, shape-compatible (`RequestAnswer` maps onto today's
  settlement union with a thin adapter at the script boundary if needed).
- **Q5 folding beyond members:** several accepted Dispatcher submissions
  can fold into one native result and their requested replies must be one
  delivered fact. Under II this is the event's **recipient-set dedupe** —
  the surviving fold semantics. Under R (and the delivered shape) it is the
  router's completion-identity fold. Either way folding does not disappear
  from the product; only its mechanism changes.
- Corrected removal claim (final): under II, deleted = the **delivery-side
  WeakMap completion-identity fold, the cross-channel same-object
  discipline and its identity-test family**, `EntityTurn`'s delivery state
  (delivery task, per-turn report promise, `ensureDelivery`), and Codex
  orphan bookkeeping. Retained = request identity (`Turn.id`, answer
  promises), per-result recipient dedupe (folding), the delivery transport
  (fences, FIFO, push-back), convergence (one `InFlightWork` at the single
  reporting owner). Under R, additionally retained = the identity fold and
  the same-object discipline.

### 2.4 The fenced inbox is not a forwarding hop

Source fact: `DispatcherService.submitToAgent` runs inside
`fence.admit(() => this.dispatcherAgent.mustAgent().submitInput(input))`
(aggregate admission; drains queued work on shutdown while the contained
agent may still run), whereas `DispatcherAgent.submitInput` is the ungated
internal call. Revised ownership statement: the owner port binds the
**owner service's existing fenced entry** (`TeamService.submitInput` with
`admitTeam`; `DispatcherService.submitToAgent` with `fence.admit`) —
verbatim, no wrapper, no new method; vocabulary rename
(`submitToAgent`→`submitInput`) remains optional cosmetic harmony, not a
mechanism. The gate therefore stays exactly where it is; queued-delivery
and drain semantics are untouched; prepared-agent lookup points
(`mustAgent()` inside the gate) are preserved. Counted additions: zero
wrappers; the port is a structural view of two existing methods plus the
owner name/label/status facts. "Scope ownership and contained recipient are
distinct facts" is honored: `DispatcherService` owns the root scope and its
fence; the contained `DispatcherAgent` is the report recipient — two roles,
two existing objects, no merge.

### 2.5 Ideal adoption separated from compatibility facts

Corrected matrix for II (my §G.8 understated the first cell):

| Pairing | Delivered overlapping shape | II (single event) |
| --- | --- | --- |
| New host + old provider | Loads; bound member reports survive via settlement; unbound absent | Loads; **bound and unbound member reports both lost** (no event ⇒ no notices; value channel alone delivers nothing) |
| New host + new provider | Full | Full |
| Old host + new provider | Sink-call crash risk (R5.2) | Unsupported outright (submit/answer shape mismatch) |
| Old host + old provider | Unchanged | Unchanged |

A README minimum version is **documentation, not runtime enforcement** —
stated as such; no version negotiation or fallback delivery path is built
(the greenfield input forbids fallback entities merely to preserve the
interface). The external-provider inventory is an **adoption-risk
parameter**, not a product or design blocker (reclassifying my §G.10
blocker 1); the ideal is derivable without it. Change-note policy follows
the repository's ordinary API contract notes (plain `minor` notes on the
0.x line; no `BREAKING:`/`Rebuild:`, no persisted migration — none was
authorized or needed).

## GX.3 The complete comparison (concepts, state, hops, removals)

| Axis | Delivered | R (one owner, two inputs) | II ∪ R (recommended) |
| --- | --- | --- | --- |
| Delivery initiators | 2 (`EntityTurn`, `observeRuntimeResult`) | 1 reporting owner | 1 reporting owner |
| Public contract | additive sink + settlement-as-delivery | unchanged | one result event + answer value channel |
| Dedup mechanism | router WeakMap (cross-channel identity) | same WeakMap, inside the owner | recipient-set dedupe per event; correspondence map |
| Cross-package discipline | same-object + ordered dual publish | same | one publish per terminal (single obligation, paired with answer resolution at the same code point) |
| Maintained state | `EntityTurn` delivery state + `nativeReports` | `OutstandingRequest` records + one `InFlightWork` | same as R |
| Concepts to hold | settlement-delivery + fold + dual agreement | + one owner | result event + correspondence + one policy |
| Compat | best | best | worst (paired adoption) |
| Removals | orphan bookkeeping | + EntityTurn delivery state | + fold, same-object discipline, identity-test family |

## GX.4 Revised complete position

1. **Ownership (common to both shapes, adopted outright):** one reporting
   side-effect owner per producing entity — eligibility, destination, notice
   building, and delivery convergence in one place; request records answer
   their caller and prove settlement without owning delivery state. This
   supersedes `turn.ts`'s EntityTurn-as-delivery boundary by name (the R71
   removals the working notes cite — no private-owner delivery closures, no
   recipient suppliers — are preserved: the owner is the entity itself, and
   recipient lookup stays at the operation's call site).
2. **Input model (the ideal):** II — one authoritative result event per
   observed terminal carrying `TurnResult` + `answered` handles; the answer
   promise is a value channel with request-scoped `failed`/`stopped` news;
   notices derive from the event per the GX.2.1 table; recipient-set dedupe
   is the surviving fold. Correspondence identity is named (GX.2.2), public
   `turn_id` and `Turn.settled` survive (GX.2.3), fences stay at the owner
   entries (GX.2.4).
3. **Adoption:** the delivered shape (or R applied to it) is the legitimate
   transition vehicle; II is the recorded target contract. The choice
   "replace now versus stage" is the one genuine decision — a design/
   authorization question for reconciliation, driven by external-seam
   exposure (GX.2.5), not a product question.
4. **Messaging, Q5 isolation, availability, reopen/locks:** unchanged from
   §G.3.3/revision 3; nothing in this round touches them.

**Accepted from the other seats/notes:** the reporting-owner consolidation
(working notes; DeepSeek and Trae's greenfield sections converge on a single
Core decision point — accepted as the ownership half); the five required
adjudications as stated above. **Rejected/corrected:** my §G.6 identity
overclaim (refined per GX.2.2–2.3); my §G.8 first-cell compat wording
(corrected per GX.2.5); any framing that treats the external inventory or a
hypothetical future consumer as a product blocker (none remains).

**Strongest surviving counterexample to the recommendation (II ∪ R):** the
transition asymmetry is real and sharp — under II an old provider on a new
host loses **bound** member reports too (the delivered shape would have kept
them), and a provider that answers requests without publishing events
silently drops Q5-protected request replies (missing replies being worse
than the duplicates the fold guarded). Only paired adoption of both in-tree
adapters, an honest extension-seam note for external providers, and
conformance tests (every terminal publishes one event with its answered
set; `team.send`→reply end-to-end) defend against it; no runtime enforcement
exists. **Genuine blockers: none** — the remaining decision is the adoption
path (GX.4.3), the remaining unknowns are adoption-risk facts (external
inventory; Codex unbound frequency; any consumer of `Turn.settled` beyond
`WorkflowRun` and tests), and the interrupted-wording preservation is a
design detail now pinned by the GX.2.1 table rather than a product fork.

---

# Operator-delegated optimal architecture selection — independent proposal (2026-10-14)

**Chosen: candidate 2 — one authoritative runtime outcome stream with
Core-owned per-input result Promises (complete replacement).** Selection
criterion: once-only and ordering become structural, cross-package duties
shrink to typed correspondence, and the deletion set is real — not diff
size, and candidate 1 is compared, not inherited.

**Minimum model.** Three product facts: an addressed message (host-bound
sender); a per-input answer (Workflow script values, Q5 request replies,
public `turn_id`); a per-turn observed result (ordinary-member subscription,
unbound included, ordered). Two owners: Core — input records, reply
recipients, notification policy, delivery convergence; provider — native
terminal observation and input grouping it already computes.

**Interface sketch (neutral ABI replacement):**

```ts
submit(input: { text: string; inputId: InputId }): Promise<Admission>;
// InputId: opaque, Core-minted at the call site; receipt identity = InputId.
turnOutcomes(e: { status: 'completed'|'failed'|'interrupted';
                  resultText: string|null; error: Error|null;
                  answered: InputId[] }): void;  // once per observed terminal
inputFailed(id: InputId, error: Error): void;    // pre-admission refusal, transport loss
// Core owns each input's result Promise and resolves it from these facts.
```

Core holds one `OutstandingInput { inputId, replyRecipient, resolve }` per
call — created synchronously at the call site (the recipient query point
survives), so it exists before any terminal can arrive. One reporting owner
derives every notice from the stream: ordinary-member arm → conversational
owner; `answered` ids → their captured reply recipients (dedup = the
surviving fold, Q5 without a token fold); `interrupted` → reply recipients
only.

**Why not candidate 1 (completion-valued submissions + observation +
identity fold).** Deletions here, in Core *and* adapters: the `WeakMap`
completion fold, the cross-package same-object discipline and its identity
tests, `EntityTurn` delivery state (`selectedCompletion`, `deliveryTask`,
`ensureDelivery`), dual eligibility timing, and adapters' per-request
settlement-Promise plumbing (Claude `PendingRequest.settle`, Codex
member-settle loops) plus the split duty "settle interrupted with a value
but don't publish it". Additions: the input handle, a two-fact stream, the
id→record map. Candidate 1's provider duty is two coupled calls with
invisible identity equality; this design's is one publication echoing
grouping providers already perform — testable, and stranding is caught by
the existing fail-loud unsettled-input proof.

**Mandatory cases.** N inputs fold into one result → one event, N
resolutions, one reply. Equal-text queued turns → separate events, separate
values. Unbound normal/failed → `answered: []`, ordered with bound events by
construction. **Result before admission continuation:** the
`OutstandingInput` already exists (call-site minted, owned by the entity's
reporting owner); rejection retires it with the admission result; ambiguous
holds it until an outcome or `inputFailed`; close drains and fails loud —
no Promise-hop dependence. Leaders: no subscription; N Dispatcher requests
→ one reply; autonomous leader outcomes upstream-silent. Scripts resolve
per-input values (`turn_id` = `inputId`); Workflow-locked members stay
disarmed. **Codex bound interruption:** event `interrupted` +
`resultText: partial` → input resolves with the existing completed-shaped
partial value while the member arm reports nothing; Claude's no-partial
interrupted resolves `stopped` — observable outcomes preserved, unbound
interruptions not expanded. Transport/input failure → `inputFailed`, never
a fabricated terminal. Stop/close: fence, settle accepted inputs, fail loud
on non-convergence, await started deliveries (one agent-owned set);
eligibility uniformly at event publication — named movement: leader request
replies in the one-microtask stop window now deliver where settlement-time
eligibility suppressed them. Team/Dispatcher input fences and owner-port
inboxes survive unchanged; recursion stays impossible (reply recipients are
captured per input, never derived by walking management).

**Adoption:** replacement of the request-answer ABI — paired host/provider
releases, extension-seam breaking-minor note, no negotiation, no fallback
queue; messaging, owner ports, and Q3 arming are adaptations. Old providers
are unsupported rather than silently degraded. **Strongest counterexample:**
a provider that publishes a terminal but mistypes `answered` misresolves or
strands Q5/script replies, where candidate 1's settle-with-C delivers them
locally. Mitigation: fail-loud unsettled-input proof, per-adapter contract
tests (each answered id resolves exactly once; every terminal enumerates
its inputs), not elimination. **Acceptance:** the mandatory-case list is the
suite, plus both collections × both runtimes, delivered-order tests, and
untouched load-bearing assertions.

---

# Cross-review — operator-delegated architecture selection (2026-10-14)

Read all three new sections and the source anchors; the
`completionFromTerminal` precision (`codex/src/turn-manager.ts:419-433`) is
adjudicated under challenge 4.

**Accepted.** Ch1: `InputId`/`OutstandingInput` replace `retainedTurns` and
`Turn.id` (`turn.ts:70-107`, `requests.ts:119-122`) — not double-counted —
but adapter attribution **remains** under candidate 2 (Claude must still map
`InputId`↔`commandUuid`; Codex keeps member grouping), and the event must
carry the pre-selected frozen `RuntimeCompletion` anyway, so the completion
value machinery does not disappear. Ch2: receiving provider grouping is not
Core reconstruction; the genuinely new knowledge is the provider naming
Core inputs at its wire boundary. Ch3: once-per-terminal production is a
provider obligation in both designs; recipient-set folding within one event
needs no turn-ID ledger.

**Rejected — my candidate-2 sketch, three defects.** Ch4:
`turnOutcomes{status:'interrupted', resultText}` inferred per-input values
from cause or text — unsound. `completionFromTerminal` applies schema
restoration to an interrupted `CollectedTurn` and selects **failed** on
codec error; empty/null partial text is legal. A correct event must carry
`cause` **and** the explicit selected outcome — i.e. candidate 1's frozen
completion object plus an id system. Ch5: "ambiguous holds the record until
an outcome or `inputFailed`" was unsound — Claude `failWrite`/`close`
return `ambiguous` while their result Promise is private and never admitted
(`rpc.ts:127-135,169-173`); rejected/skipped create no answer rights.
Correct retirement: records exist only after positive acceptance; ambiguous
retires at the admission result with no reply; later event claims on
non-accepted ids are ignored — no manufactured `inputFailed`, no stranding.
Ch6: input-only stopped/failed notices have no event instant; no total
order is claimed for them. Trae's two named instants stand (terminal for
subscriptions, settlement for one-shot answers); leader-reply eligibility
movement is a one-microtask window, not a selection criterion.

**Net accounting (corrected).** Candidate 2 deletes the same-object
discipline, the token WeakMap (replaced by id-set dedup), and adapter
settlement-Promise plumbing; it adds `InputId` on the ABI, a cause/outcome
split, the id→record map, retirement rules, and adapter id maps. Candidate 1
plus the single `AgentService` reporting owner deletes `EntityTurn`'s
delivery state and one of two in-flight trackers (`service.ts:103`,
`turn.ts:75-165`), adds no Core noun, and keeps one convention.

**Definite recommendation: candidate 1 with the single Core reporting
owner** — `results` optional, mandatory when supplied; `settled`/`turn_id`
unchanged; two named eligibility instants. Decisive tradeoff: one
testable reference-equality convention instead of a typed id system whose
failure mode — a wrong id echo — delivers a **wrong value to a wrong
requester** (corrupting Q5/script replies), where the convention's failure
(cloned completion) merely duplicates a notice. **Strongest surviving
counterexample:** that clone double-delivery, undetectable by types;
mitigated, not eliminated, by per-adapter reference-identity and
delivered-order tests.
