# Analysis

Answers to the questions in [requirement.md](requirement.md). Question 1 is
answered, with a follow-up measurement of what COT changed in the push-back
mechanism itself; question 2 is in progress.

## 1. What Core could delete if display did not exist

Traced from the source rather than assumed. The discriminating test for each
item is whether a non-display consumer depends on it.

### The seam that makes this measurable

`EntityTurnCoordinator.activitySink` opens with
`if (this.opts.conversationProjection === undefined) return;`. The push activity
path exists for the conversation projection and for nothing else — that single
line is why the cost of display can be stated exactly.

### Display-only — would go

- **`/packages/dreamux/src/channel/conversation-projection.ts`**, whole file:
  the projection itself, the redaction of secrets and operator paths, and the
  size bounds on projected text. Nothing else publishes conversation text, so
  nothing else needs it sanitized.
- **`/packages/dreamux/src/platform/home-paths.ts`** and the resolved prefixes
  threaded from `Server.start()` through `Dispatchers` into `DispatcherService`.
  Their only consumer is the redaction above.
- **In `turn-coordinator`**: `activitySink`, `nativeTurnSink`, the early-activity
  buffer with its cap and warning, `projectDisplay` / `projectActorDisplay`, and
  the per-submission activity-fact dedupe.
- **In `runtime-owner`**: `generationActivitySink` and `generationNativeTurnSink`,
  the generation fences that keep a revoked runtime from writing display.
- **In the provider contract**: `AgentRuntimeActivitySink`,
  `AgentRuntimeNativeTurnSink`, `RuntimeActivity`, `RuntimeActivityEvent`,
  `RuntimeNativeTurnEnd`, and their `AgentRuntimeCreateContext` slots.
- **In both runtimes**: activity emission (Claude Code's `emitStreamActivity`,
  Codex's activity side of `observeItem`) and the native-turn-end reporting —
  the settle-guarded synthesis in Claude Code, the four report sites in Codex.
- **In the Channel event surface**: `teammate.turn.submitted`,
  `teammate.turn.settled`, `teammate.turn.message`, `teammate.turn.tool_call`,
  `teammate.native_turn.ended`, their entries in the sealed catalog, and the
  Feishu COT modules that consume them.
- **`source_id` echoed on the submitted fact**, and `sourceId` retained on
  `EntityTurn` to make that echo possible.

### Not display cost — stays

- **`readRecentActivity` and `/packages/dreamux/src/service/agent-entity/activity-reader.ts`.**
  The model-facing `last` window is a bounded *cold read* from the runtime's own
  store, on a different path from the push sink. Display could disappear entirely
  and `last` would still work — so the runtime must keep *recording* activity;
  only pushing it stops.
- **`team.state` and `teammate.state`.** Lifecycle facts. The Channel needs them
  for bindings, fences and Team close regardless of any card.
- **`RuntimeSubmission.settled`, completion routing, and delivery.** Correctness,
  not presentation. A turn must settle and its completion must be delivered
  whether or not anyone is watching.
- **`source_id` as the admission-ledger key.** Deduplication of a redelivered
  inbound is an admission concern. Only the *echo back out* is display.

### What the measurement says

Display is not a thin layer over the push-back mechanism; it is the **only**
consumer of an entire capability — the push activity path, its two provider
sinks, five of the seven core event kinds, and the sanitisation that guards
them. That is a large surface for one requirement, and it is exactly why every
new display need has had to be paid for with a new mechanism: there is no
display *layer* to extend, so each need lands as another special case in the
push-back machinery.

It also means the split is not merely tidier. Everything listed as display-only
is separable in principle, because nothing outside display reads it.

## 1b. What COT changed in the push-back mechanism itself

Measured per commit, not per range. The COT commits that touch Core or a runtime
are #347 (`57a2cf8a`), #357 (`2cf21cc6`) and #364 (`56a7e5a5`); #363 and #365
touch neither. An earlier measurement of this took the whole range from before
#347 to HEAD and therefore attributed `admission-ledger.ts` (+129),
`submission.ts` (+123) and the `completion-router` change (+29) to COT. All
three belong to #350, the minimal-agent-runtime-provider refactor. They are not
display cost.

### Behaviour: unchanged

- **Admission.** No COT commit changes an admission decision, the ledger, or its
  key. The one COT-era addition to admission — `channel-origin.ts` (+58 in #347)
  — was deleted again by #350 and no longer exists.
- **Settlement.** Every `settle()` call site in both runtimes is where it was
  before #347. #357 starts *reading* the boolean `settle()` already returned, to
  decide whether to report a synthesized end; it does not change when, or
  whether, anything settles.
- **Completion delivery and stop.** Untouched.

### Shape: four additive changes, all inside push-back files

1. **The activity sink was already a seam.** Pre-COT
   `EntityTurnCoordinator.activitySink` existed as `RuntimeActivitySink = () => {}`.
   COT filled it. Everything #347 and #357 add to `turn-coordinator.ts` lives
   inside that fill: `turnsBySubmission`, the early-activity buffer with its cap
   and warning, `projectDisplay` / `projectActorDisplay`, and two warn helpers.
2. **A second sink alongside it.** `nativeTurnSink` on the provider contract,
   its generation fence in `runtime-owner.ts` (+26), and six report sites across
   the two runtimes. Codex's `nativeTurnEnded` flag guards a double *report*,
   never a double settle.
3. **Retained display state on `EntityTurn`.** `id` (#347) and `sourceId`
   (#364). COT also gave `origin`, `prompt` and `intent` their first reader:
   those three fields existed before #347 and **nothing in the source read
   them** — vestigial from the unified-teammate-lifecycle design.
4. **`AgentEntityTurnOrigin` reshaped** from `'channel' | 'dispatcher' |
   'team_leader' | { scheduled }` into a tagged union carrying `channel_origin`.
   It had zero pre-COT readers, so this changed no behaviour — but it is a
   push-back type redefined to serve display.

### What the shape cost actually is

Not a corrupted mechanism — a misplaced key. Display is attributed by
`RuntimeSubmission`, which is the push-back mechanism's identity, not display's.
Three of the mechanisms this task exists to remove are the same consequence of
that one choice:

- `turnsBySubmission` exists because a display fact must find an `EntityTurn`.
- The early-activity buffer exists because a fact can arrive before the
  submission is recorded.
- `nativeTurnSink` exists because a fact can belong to **no** submission, and
  therefore has no way through the first path at all.

Attribution by actor, the settled direction, removes the reason for all three.

### Volume, for scale

Core and runtimes, non-test: #347 +1269/−134, #357 +1031/−32, #364 +25/−3 —
but most of #347's Core figure is `conversation-projection.ts` (+323), a new
display-only file, and most of #357's is the same file's rework (+203). The
Feishu side is where the bulk is and where simplification has already happened:
#347 +2665/−300, #357 +356/−672, #364 +216/−152.

## 2. What display would be if designed from scratch

Designed against [runtime-input-semantics.md](runtime-input-semantics.md) and
the settled direction in [requirement.md](requirement.md#settled-design-direction),
not against the current implementation.

### The unit of display is the Agent, not the submission

This is the whole answer; everything else follows.

Today a display fact must belong to a Dreamux submission. That is why activity
is keyed by `RuntimeSubmission`, why a folded native turn has to pick a
representative member, and why a fact owned by no submission has nowhere to go.
None of it is a display requirement — it is the push-back mechanism's identity
borrowed for a job it was not cut for.

What a display consumer actually matches on is already the Agent. The Feishu COT
recipient identity is `{ kind: 'leader', teamName } | { kind: 'dispatcher' }` —
no turn, no submission. So attributing every activity to the Agent whose runtime
produced it is not a new correlation; it is the one the consumer was using all
along, stated directly instead of routed through a submission.

### The input fact is emitted at admission, in both runtimes

The discriminating question is when a runtime can state "this input entered me".
Checked in the source, not assumed:

- **Codex has no other option.** Every submission — first turn or steer — goes
  through `turn/start` (`TurnManager.submit`), and the collector's item stream
  carries no user-message item: `observeItem` handles `commandExecution`,
  `fileChange`, `mcpToolCall`, `dynamicToolCall` and assistant text, and nothing
  else. There is no input to observe coming back. The only moment codex knows
  the text was accepted is when `turn/start` responds.
- **Claude could observe it, and should not.** Its stream-json does echo `user`
  frames, but tool results arrive as `user` frames too — that is where
  `activityForBlock` reads them from. Separating a real input echo from a tool
  result would be new provider-shape reasoning inside the provider for no gain.
  `writeSteer` already knows the text and the command id at write time.

So: **each runtime emits one `input` activity at the point it admits the text.**
Uniform across providers, no protocol-specific observation, and naturally
ordered ahead of everything that input causes.

### The shape

One sink. Four neutral kinds. No submission on the event.

```
RuntimeActivity =
  | { kind: 'input';            text; sourceId: string | null }
  | { kind: 'assistant.message'; text }
  | { kind: 'tool.call';         callId; toolName; action; status; ... }
  | { kind: 'turn.ended';        status: 'completed' | 'failed' | 'interrupted' }
```

Every event carries `occurredAt`. None carries a submission, a turn id, or an
Agent name — the runtime does not know its Dreamux identity. `runtime-owner`
already wraps the sink with a generation fence and already holds the identity,
so it stamps the actor there, where the knowledge is.

`AgentRuntimeSubmissionInput` becomes `{ text: string; sourceId?: string | null }`.
The runtime echoes it on the `input` fact and does nothing else with it. No id
is invented: `sourceId` already exists at the Core command layer as the
admission-ledger key, and this hands the same value down instead of retaining
it on the turn to echo it back out.

The Channel's test is a **comparison, not a presence check**. Presence does not
mean "from a Channel" — `TeammateService.controlInput` forwards a `sourceId`
too. What the Channel does is match the echoed id against ids *it itself
submitted*, which is exactly what `beginInboundSubmission` records against its
anchor today. This is the mechanism the operator chose over text matching, and
it keeps working unchanged; only the return path shortens.

### What it deletes

| Deleted | Why it existed |
|---|---|
| `turnsBySubmission` (WeakMap) | a display fact had to find an `EntityTurn` |
| the early-activity buffer, its 512 cap and its warning | a fact could arrive before the submission was recorded |
| `AgentRuntimeNativeTurnSink`, `nativeTurnSink`, `generationNativeTurnSink`, the `nativeTurn` create-context slot | a fact could belong to no submission at all |
| `teammate.native_turn.ended` — the bespoke actor-scoped core event | the only way to publish an actor-scoped fact through a submission-scoped surface |
| codex's `NativeTurnRecord.nativeTurnEnded` flag | its docstring claims several terminal paths can reach one record. Read against the source they cannot: `finalize` returns on `record.completion !== null` and sets `completion` before reporting; `failProtocol` skips records with a `completion` and `failRecord` deletes the record from `nativeTurns`; `stop` skips records with a `completion` and deletes the rest. Every reporting path either blocks the others or removes the record. The flag guards a double report the existing guards already prevent — confirm this reading when implementing, do not take the row on trust |
| `sourceId` retained on `EntityTurn` | the return trip that a caller-supplied id removes |
| `teammate.turn.submitted`, `teammate.turn.settled` | `input` replaces the first. The second is an orphan of COT's own making — see below |
| `projectSubmitted`, `projectSettled`, `projectNativeTurnEnd`, `projectActorDisplay` | four entry points collapse to one `projectActivity(agent, activity)` |
| representative attribution in codex | nothing needs a member chosen to own a folded turn's facts |

Seven core event kinds become three: `team.state`, `teammate.state`, and one
`teammate.activity`.

### `teammate.turn.settled` is an orphan COT created and then abandoned

Worth stating separately, because it is the clearest single instance of the
pattern this task exists to end.

It is **not** a pre-existing push-back fact that display borrowed. The push-back
mechanism's own settlement is `RuntimeSubmission.settled` → `EntityTurn.settled`
→ completion delivery, and that path is very much consumed — it is how a
completion reaches its caller. The *event* is a different object with a
different life:

- **#347 invented it** as `turn.settled`, and consumed it:
  `coreEvents.on('turn.settled', forward((a, e) => a.onTurnSettled(e)))`, with a
  `settled` flag in the COT state machine that terminated a card.
- **#350** renamed it to `teammate.turn.settled`. Still consumed.
- **#357 removed the consumption.** A provider folds any number of submissions
  into one native turn, so a per-submission settlement says nothing about
  whether the card the operator is watching has finished.
  `teammate.native_turn.ended` became the card's one terminal, and
  `feishu-cot-session.ts` records the absence deliberately.

So the kind is still produced by `conversation-projection.ts`, still in the
sealed catalog, still has its redaction asserted in tests — and no Channel
reads it. It exists because display had no home of its own: the fact was
published as a core event, the assumption behind it turned out to be wrong, and
the publication outlived the assumption because nothing ties the two together.

### What it costs

- One new neutral kind (`input`) and one renamed one (`turn.ended`, absorbing
  `teammate.native_turn.ended`).
- One optional field on `AgentRuntimeSubmissionInput`, and each runtime echoing
  it — claude passes it where it currently generates `commandUuid`; codex
  carries it alongside the `turn/start` call.
- The Channel's own-body suppression moves from matching a returned `source_id`
  to matching the `sourceId` on an `input` activity. Same comparison, one fewer
  hop.

Nothing here adds a mechanism that does not replace one.

### What it does not change

- The neutral seam. Provider wire shapes still stop at the provider package;
  the four kinds are Dreamux's vocabulary, not claude's or codex's.
- The locked COT product model — one recipient, one anchor, at most one open
  card, closed by the runtime's own native end. `turn.ended` is the same fact
  under a different name, so the card closes on the same event it does today.
- Redaction and bounding. They move with the projection, unchanged, and still
  apply to every kind including `input`.
- Fail-open. Display still never affects admission, settlement, delivery or
  shutdown; the generation fence stays.

### Open, for the operator

- ~~`priority` on the claude steer envelope.~~ **Ruled: delete it.** See
  [requirement.md](requirement.md#decisions-and-unknowns). No probe is needed —
  the ruling covers the case where the field works as well as the case where it
  is inert.
- **Whether `teammate.turn.settled` may simply go.** COT created it in #347 and
  orphaned it in #357; this repository still produces it and no Channel reads
  it. Deleting an unused published surface is still a surface change — and
  flowx is a semantic superset that ports these PRs, so the question belongs to
  that side too.
