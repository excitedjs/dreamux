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
  buffer with its cap and warning, and `projectDisplay` / `projectActorDisplay`.
- **In `conversation-projection`**: the per-submission activity-fact dedupe
  (`conversation-projection.ts:106` — an earlier revision of this document put
  it in `turn-coordinator`, which was wrong).
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
- **`team.state`.** A lifecycle fact the Feishu Channel reads for bindings,
  fences and Team close regardless of any card.
- **`teammate.state`** is *not* in the same position, and an earlier revision of
  this document was wrong to pair them. It is produced
  (`dispatcher-service/index.ts:574`, `team-service/roster-projection.ts:52`)
  and sealed, but **no Channel in this repository reads it**. That does not make
  it display cost and does not make it deletable — it is a published surface an
  out-of-tree Channel provider may consume — but it is not evidence for
  anything either, and it should not be cited as a non-display consumer.
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
- **Completion delivery.** Untouched.
- **Stop was touched**, and an earlier revision of this document wrongly said it
  was not. #357 added interrupted native-end reporting inside codex's `stop()`
  (`turn-manager.ts:97`) and changed Claude Code's stop/failure settlement helper
  to branch on the boolean `settle()` returns (`runtime.ts:381`). Neither changes
  *what* settles or *when* — the reporting is display — but both are edits to the
  stop path, and calling that untouched overstated the case.

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

Counted over non-test source only — `packages/dreamux/src`,
`packages/dreamux-types/src`, and both runtime `src` trees: #347 +1058/−134,
#357 +534/−48, #364 +25/−3. (An earlier revision quoted larger numbers taken
from a `git show --stat` total line, which includes the test files the
accompanying filter had removed from the listing but not from the sum.)

Most of #347's figure is `conversation-projection.ts` (+323), a new
display-only file, and much of #357's is that same file's rework. The Feishu
side is where the bulk sits and where simplification has already happened once:
#347 +2665/−300, then #357 +356/−672.

## 2. What display would be if designed from scratch

Designed against [runtime-input-semantics.md](runtime-input-semantics.md) and
the settled direction in [requirement.md](requirement.md#settled-design-direction),
not against the current implementation.

**Revised 2026-09-02 after independent review.** The first version had the
runtime carry and echo a caller-supplied `sourceId`. Two reviewers
independently refuted it, and both refutations were re-checked against the
source before this rewrite. The correction is recorded in
[review-corrections.md](review-corrections.md); the design below is the
corrected one.

### The unit of display is the Agent, not the submission

This is the whole answer; everything else follows. It survived review intact.

Today a display fact must belong to a Dreamux submission. That is why activity
is keyed by `RuntimeSubmission`, why a folded native turn has to pick a
representative, and why a fact owned by no submission has nowhere to go. None
of it is a display requirement — it is the push-back mechanism's identity
borrowed for a job it was not cut for.

What a display consumer actually matches on is already the Agent.
`cotRecipientOf` matches on role, team name and TeamMate name only; `turn_id`
is used on the Feishu side for the open-call key and for hiding the Channel's
own body, and both of those have replacements. So attributing every activity to
the Agent whose runtime produced it is not a new correlation; it is the one the
consumer was using all along, stated directly instead of routed through a
submission.

### Core emits the input fact, immediately before it submits

This is the part review changed, and it is now the better half of the design.

**The runtime cannot supply the text.** `TeammateService.submitAdmitted` hands
the runtime `renderSubmission(input)` — the assembled XML envelope — and keeps
the original body separately as `prompt`
(`teammate-service/index.ts:246`, `:259`). The source says why in place: "The
turn records the source's own body. The envelope is delivery formatting, and
repeating it in the conversation projection would show the model's provenance
markup back to a human reader." A runtime echoing its own `text` would put
`<cron …>` and `<reminder>` markup on the card for every producer except the
Feishu inbound that gets hidden.

**The runtime must not carry the identity either.** #350 records the operator
moving "stable source identity and duplicate admission from the Agent Runtime
seam to the Core admission owner", and `AgentRuntimeSubmissionInput`'s own
docstring states the seam "carries no discriminator, no source enum, **no
source identity**, and no rendering instruction … Stable source identity,
origin, intent, and display correlation stay on Core's own turn/admission
state". Putting `sourceId` back on that seam would reverse a recorded ruling,
and the direction this task recorded on 2026-09-02 does not carry operator
words authorising that — only the choice of `source_id` over text matching.

**Core has everything and needs nothing new.** Inside `submitAdmitted`, Core
holds the original `input.text`, the `sourceId`, the `source` (channel, cron,
task push, restart notice), and the Agent identity. It emits the `input`
activity there, *immediately before* calling `runtime.submit({ text })`.

Every deletion the first version claimed still happens: no `sourceId` retained
on `EntityTurn`, no return trip on a core event, no `turnsBySubmission`. The
provider seam is not touched at all.

Two further things fall out of emitting before the submit call rather than
after it:

- **Ordering becomes structural instead of buffered.** Review showed the first
  version's "naturally ordered" claim was false: codex subscribes to
  notifications before `turn/start` resolves and explicitly supports an item or
  terminal arriving first — that race is what `pendingActivity` currently
  buffers. Emitting the input before the runtime is called removes the race by
  construction, because the runtime has not been asked to do anything yet.
  Nothing has to be re-ordered and no buffer replaces the one being deleted.
- **The fact means what it says.** `input` states "Core admitted this and is
  submitting it", not "the model received it". A submission that then fails
  admission at the provider is a fact the card already handles by going to
  failed — the operator ruled on exactly that case on 2026-09-02.

### What a runtime still owes

Only what it observes: assistant messages, tool calls, and the end of a native
turn. No identity, no input echo, no ordering guarantee.

One correction to the record while here: Claude Code's per-command id is
generated in `ClaudeCodeRuntime.acceptInput` (`runtime.ts:247`) and passed down;
the `randomUUID()` in `writeSteer` is only a default parameter value. And the
claim that codex's stream "carries no user-message item" is narrower than it
was stated: `itemActivity` projects only assistant messages and recognised tool
items, and `ThreadItem.type` is an open string the collector does not filter
(`events.ts:159`, `types.ts:84`). What the source proves is that such an item
would not be projected today — not that the protocol never sends one. The
design does not depend on the stronger claim, because Core owns the input fact.

### The shape

One sink. Four neutral kinds. No submission on the event.

Two published kinds, split by **producer** — ruled by the operator on
2026-09-02, correcting an earlier version of this section that folded them into
one kind with a four-valued discriminant.

```
teammate.input        published by CORE, at admission
  { text; source; sourceId: string | null }

teammate.activity     published by a RUNTIME, through the one sink
  | { kind: 'assistant.message'; text }
  | { kind: 'tool.call';         callId; toolName; action; status; ... }
  | { kind: 'turn.ended';        status: 'completed' | 'failed' | 'interrupted' }
```

The split is not cosmetic. The producer differs — Core versus a runtime, which
is a real layer boundary a discriminant would hide. The shape differs — `source`
and `sourceId` exist on the input fact and on nothing else, so one union would
carry two fields meaningless to three of its four members. And the consumer
differs — a Channel **filters** on input and **renders** activity.

Nothing was bought by merging them, either: the whitepaper is explicit that
collapsing N things into one N-valued discriminant is not a boundary reduction,
which is the same reason this document withdrew its "seven kinds become three"
claim. The catalog goes from seven kinds to four.

Runtime activity is stamped with the Agent by `runtime-owner`, which already
holds the identity and already wraps the sink with a generation fence. Every
event carries `occurredAt`. None carries a submission or a turn id.

`source` rides on the input fact because a display consumer wants it and only
Core can supply it: a future web timeline needs to say whether an input was a
cron fire or a task push, and the runtime cannot know.

### What it deletes

| Deleted | Why it existed |
|---|---|
| `turnsBySubmission` (WeakMap) | a display fact had to find an `EntityTurn` |
| the early-activity buffer, its 512 cap and its warning | a fact could arrive before the submission was recorded |
| `AgentRuntimeNativeTurnSink`, `nativeTurnSink`, `generationNativeTurnSink`, the `nativeTurn` create-context slot | a fact could belong to no submission at all |
| `teammate.native_turn.ended` — the bespoke actor-scoped core event | the only way to publish an actor-scoped fact through a submission-scoped surface |
| codex's `NativeTurnRecord.nativeTurnEnded` flag | its docstring claims several terminal paths can reach one record. Both reviews traced every path and found they cannot: `finalize` writes `completion` before reporting and returns on it thereafter; `failProtocol` skips records with a `completion`; `failRecord` and `stop` report and then synchronously delete. Redundant against the current call graph |
| the per-submission activity-fact dedupe (`conversation-projection.ts:106`) | **delete, do not re-key.** Both runtimes generate an activity id at emit time and no producer repeats one; the test that asserts the dedupe names no repeater. Under the whitepaper's first rule a defence with no named scenario is deleted, and re-keying it by actor would silently keep the mechanism alive |
| `sourceId` retained on `EntityTurn`, and `source` and `prompt` with it | the return trip, now that Core publishes the fact where it already has all three |
| `teammate.turn.submitted`, `teammate.turn.settled` | `input` replaces the first. The second is an orphan of long standing — see below |
| `projectSubmitted`, `projectSettled`, `projectNativeTurnEnd`, `projectActorDisplay`, and the coordinator's `conversationProjection` / `identity` / `role` options | four entry points and their plumbing collapse to one `projectActivity(agent, activity)` |
| representative attribution in codex | nothing needs a member chosen to own a folded turn's facts |

**A candidate this design should claim and did not:** codex's `pendingActivity`
is the same early-arrival buffer, inside the provider, for the same reason. It
should go with the rest. But `unboundObservedTurnIds` and
`dropOrphanActivityIfIdle` are not purely display — they also drive
`collector.releaseTurn` memory release under `retainAfterTerminal: true`. That
half needs a home, not a deletion.

### `teammate.turn.settled` is an orphan, twice over

Worth stating separately, because it is the clearest single instance of the
pattern this task exists to end — and it has now happened to the same kind
twice.

It is **not** a pre-existing push-back fact that display borrowed. The push-back
mechanism's own settlement is `RuntimeSubmission.settled` → `EntityTurn.settled`
→ completion delivery, and that path is very much consumed — it is how a
completion reaches its caller. The *event* is a different object with a
different life:

- **#299 (`819c02c6`) invented it** as `turn.settled`, published from
  `agent-entity/turns-store.ts`.
- **#338** removed it.
- **#347 brought it back** and consumed it:
  `coreEvents.on('turn.settled', forward((a, e) => a.onTurnSettled(e)))`, with a
  `settled` flag in the COT state machine that terminated a card. (An earlier
  revision of this document said #347 invented it; it did not, it reintroduced
  it. The kind has now been introduced and abandoned twice, which strengthens
  the point rather than weakening it.)
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

- Two new core event kinds — `teammate.input`, published by Core, and
  `teammate.activity`, published by a runtime — replacing five. Plus one renamed
  activity kind (`turn.ended`, absorbing `teammate.native_turn.ended`).
- Nothing on the provider seam. `AgentRuntimeSubmissionInput` stays
  `{ text: string }`.
- The Channel's own-body suppression moves from matching a returned `source_id`
  to matching the `sourceId` on an `input` activity. The test is a **comparison
  against ids the Channel itself submitted**, not a presence check — a cron fire
  and a restart notice carry a `sourceId` too. Same comparison as today, one
  fewer hop.

Nothing here adds a mechanism that does not replace one.

### What the entropy reduction actually is

Not "seven core event kinds become three" — an earlier revision claimed that and
it overstates. A Channel still discriminates four sub-kinds inside
`teammate.activity`, and the whitepaper is explicit that collapsing N methods
into one method with an N-valued discriminant is not a boundary reduction.

What genuinely shrinks:

- **One scope shape.** Every activity names an Agent. No turn scope, no
  representative, no `turn_id`.
- **One sink**, instead of two. Two projection entry points instead of four,
  and the two that remain are split along a real producer boundary rather than
  along four fact types.
- **One publisher of the input fact**, which is the layer that already owns the
  body, the identity and the source.
- **No buffered ordering.** The race is removed by construction rather than
  compensated for.
- **Two kinds leave** — `submitted` folds into `input`, `settled` goes.

### What it does not change

- The neutral seam. Provider wire shapes still stop at the provider package,
  and this revision touches `AgentRuntimeSubmissionInput` not at all.
- The locked COT product model — one recipient, one anchor, at most one open
  card, closed by the runtime's own native end. `turn.ended` is the same fact
  under a different name.
- Redaction and bounding. They move with the projection, unchanged, and still
  apply to every kind including `input`.
- Fail-open. Display still never affects admission, settlement, delivery or
  shutdown; the generation fence stays, and stop/shutdown ordering is unchanged
  (`revokeRuntimeGeneration` runs after `runtime.stop()` returns, so an
  `interrupted` end still passes the fence).
- `AdmissionLedger`. A deduplicated repeat returns before the runtime is called
  and a pending duplicate shares one admission, so either way exactly one
  `input` is published.

### The concrete change list

File by file, what a reviewer would see in the diff. Verified against the
current source; where a reviewer's omission list was wrong, that is noted.

**1. `packages/dreamux-types/src/agent-runtime.ts`**
- `RuntimeActivity` gains `{ kind: 'turn.ended'; status }`, absorbing
  `RuntimeNativeTurnEnd`.
- `RuntimeActivityEvent` goes; it exists only to carry `submission`. The sink
  takes a `RuntimeActivity` directly.
- `AgentRuntimeNativeTurnSink`, `RuntimeNativeTurnEnd`, and the `nativeTurn`
  slot on `AgentRuntimeCreateContext` go.
- `AgentRuntimeSubmissionInput` is **not touched**.

**2. Both runtimes**
- The four Claude Code and four codex native-end report sites stay — they are
  where the fact is known — but they emit through the one activity sink instead
  of a second sink.
- codex: `NativeTurnRecord.nativeTurnEnded` goes (redundant, confirmed by both
  reviews). `pendingActivity` goes — it is the early-arrival buffer inside the
  provider. `representative` stops being used to attribute activity.
  `unboundObservedTurnIds` and `dropOrphanActivityIfIdle` **stay**, reduced to
  the `collector.releaseTurn` memory release they also serve.
- Claude Code: `{ priority: 'now' }` and its three explaining comments go, per
  the operator's ruling.

**3. `runtime-owner.ts`**
- `generationActivitySink` keeps the generation fence, and now also stamps the
  Agent and calls the projection directly. `generationNativeTurnSink` goes.
- This is where actor attribution belongs: the owner already maps a generation
  to an entity and already holds the identity.

**4. `turn-coordinator.ts` — every line COT added comes out**
- `turnsBySubmission`, `earlyActivity`, `EARLY_ACTIVITY_EVENTS_MAX`,
  `warnEarlyActivityFull`, `projectDisplay`, `projectActorDisplay`,
  `warnProjectionFailure`, `activitySink`, `nativeTurnSink`, and the
  `conversationProjection` / `role` options.
- The file returns to its pre-#347 shape: turn admission serialization only.

**5. `teammate-service/index.ts`**
- In `submitAdmitted`, one line before `runtime.submit({ text })`: publish the
  `input` activity from `input.text`, `input.source`, `input.sourceId` and the
  Agent identity.
- `submitRuntimeTurn` stops being handed `source`, `sourceId` and `prompt`.

**6. `turn-recording.ts`**
- `EntityTurn` loses `source`, `sourceId` and `prompt`.
- **`EntityTurn.id` stays.** A reviewer listed it as losing its last reader;
  that is wrong — `teamSubmitResult` returns it as `turn_id` on a submitted
  receipt (`team-service/types.ts:133`), which is caller-facing, not display.

**7. `conversation-projection.ts`**
- `projectSubmitted`, `projectSettled`, `projectNativeTurnEnd` and
  `projectActivity` collapse to two: `projectInput(agent, input)` published by
  Core, and `projectActivity(agent, activity)` published by a runtime.
- `ProjectableTurn` goes with them.
- The activity-fact dedupe and `CONVERSATION_ACTIVITY_FACTS_MAX` go.
- Redaction and every size bound stay exactly as they are.

**8. `dreamux-types/src/teammate.ts` and `dispatcher-core-events/seal.ts`**
- Five kinds out: `teammate.turn.submitted`, `.settled`, `.message`,
  `.tool_call`, `teammate.native_turn.ended`. Two in: `teammate.input` and
  `teammate.activity`.
- The sealed catalog goes from seven kinds to four.

**9. Feishu**
- `feishu-cot-session.ts`: the five-case switch becomes two — filter on
  `teammate.input`, render `teammate.activity`.
- `feishu-cot-adapter.ts`: the open-call key and own-body suppression stop
  keying on `turn_id` and key on the Agent plus the `sourceId` comparison the
  Channel already performs.
- `feishu-inbound-anchor.ts`: the comparison is unchanged; only where the id
  arrives from changes.

**10. Knowledge delta, same change**
- `.agents/domains/provider-runtime.md` and `.agents/domains/channel.md` both
  describe the current two-sink, seven-kind shape.

### Still open

- **Whether `teammate.turn.settled` may simply go.** See above. flowx is a
  semantic superset that ports these PRs, so removing a published kind is a
  question for that side too.
- **What `input` carries as an id.** The Feishu side mints an
  `opaqueDisplayId`; the shape above does not say where that comes from.
- **One encoding for absence.** Pick either optional or nullable for `sourceId`,
  not both.
- **The cold-read vocabulary.** `AgentActivityRecord` (the `last` window) and
  `RuntimeActivity` (the push path) remain two vocabularies for the same
  subject. The operator's framing was "one `Activity` namespace". This design
  answers the push half only; either the cold read is explicitly out of scope or
  the two should converge, and that is a decision, not an omission to fix
  quietly.
- **Knowledge delta.** `provider-runtime.md` and `channel.md` both describe the
  current two-sink, seven-kind shape and must move in the same change.
