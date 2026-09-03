# Technical Design: Split Streaming Display From Push-Back

## Status and working authority

- **Status:** proposed. No implementation approval has been given.
- **Requirement:** [requirement.md](../requirement.md), including the operator
  rulings recorded there.
- **Analysis this rests on:** [analysis.md](../analysis.md) — what Core could
  delete without display (Q1), what COT cost the push-back mechanism (Q1b), and
  the design (Q2).
- **Review record:** [review-corrections.md](../review-corrections.md) — the
  independent reviews and what they changed.
- **Product model that stays in force:**
  [feishu-cot-conversation-cards](../../../channel/feishu-cot-conversation-cards/README.md).

### Operator rulings this design is built on

All recorded verbatim in `requirement.md`.

| Ruled | Effect here |
|---|---|
| `priority` is deleted | The claude steer envelope loses the field |
| `teammate.turn.settled` is deleted outright, flowx handles its own side | One of the four removed kinds needs no further gate |
| Cleanup found in this change's blast radius rides along | The "Folded-in cleanups" section exists |
| The input fact fires at the submit site, so a failed submission is visible with its input | §"Placement inside `submitAdmitted` is exact" |
| A stopped / skipped / failed submission sets the card to failed, and the error text is printed on the card | Carried by `turn.ended`, not by a second input shape |
| Log wording is not a reason to keep code | The completion path needs no translating adapter |
| Not ruled: the completion-path merge | §"One publish site" — the design's chosen shape, awaiting sign-off |

## The problem, in one sentence

Two flows share one identity that belongs to only one of them: **display is
keyed on `RuntimeSubmission`**, which is the push-back mechanism's key, so every
display need has been paid for with a mechanism that compensates for the
mismatch.

## The two flows today

### A. Push-back — where an answer goes

This is the mechanism that carries a completed turn back to whoever asked for
it. It is correctness, not presentation.

```
                       ┌─────────────────────────────────────────────┐
 EXTERNAL SUBMISSION   │   AGENT-TO-AGENT SUBMISSION                 │
 Feishu inbound, cron, │   MCP `team.send` (Team MCP delegate)       │
 external `team.submit`│   sets a Core-side initiator                │
        │              └──────────────────┬──────────────────────────┘
        │  no initiator                   │  initiator set
        └──────────────┬──────────────────┘
                       ▼
TeammateService.submitAdmitted                        (teammate-service/index.ts:246)
  │  renderSubmission(input) ──▶ text = XML envelope
  │  AdmissionLedger.admit(key, sourceId)             dedupe happens HERE, in Core
  ▼
EntityTurnCoordinator.submitRuntimeTurn(() => runtime.submit({ text }))   (:259)
  │  the coordinator invokes the closure — the call order is this way round,
  │  which two earlier revisions of this diagram had reversed
  ▼
runtime.submit({ text })                              the seam: text and nothing else
  │
  ▼
provider admission ──▶ RuntimeSubmission ──▶ EntityTurn
  │
  ▼
RuntimeSubmission.settled  ──▶  TurnOutcome           completed | failed | stopped
  │
  ▼
EntityTurn.ensureDelivery()                           (turn-recording.ts:143)
  │  awaits the delivery closure startDeliveryIfReady built
  │  ── no initiator ──▶ nothing is delivered anywhere. END.
  ▼
CompletionDeliveryPolicy.deliverRuntime ──▶ enqueue ──▶ deliverPrepared
  │  folds on the provider token, one FIFO tail per recipient  (:97, :124, :136)
  │  prepareCompletion once, then submit up to 3 times
  │
  │  ── inside a Team, TeamLeaderCompletionTargets calls TeamService.admit
  │     first, which refuses once a dissolve is in flight and reports
  │     `unsupported` — so a dissolving Team never wakes its leader
  ▼
initiator.prepareCompletion(fact).submit()            (teammate-service/index.ts:273)
  │
  ▼
TeammateService.submitPreparedCompletion              (:434)
  │  renderSubmission({ source: COMPLETION_SOURCE, text: body })
  ▼
runtime.submit({ text })                   (:451)     ◀── THE SECOND SUBMIT SITE
  │
  ▼
◀── the answer re-enters the ASKING Agent's runtime as a new turn
```

The loop closes at another Agent's runtime, not at Feishu — and **only when
there is a Core-side initiator**. `team.send` on the Team MCP delegate sets one;
an external `team.submit` Command explicitly passes none
(`dispatcher-service/index.ts:475`), so a Feishu message or a cron fire does not
close this loop at all. The TeamLeader's answer to a human goes out through the
Channel, not through here.

**There are two `runtime.submit` call sites today, not one.** Collapsing them to
one is what gives this design a single publish site; see §"One publish site".

### B. COT rendering — what a human watches

This is display. It hangs off flow A at three points and needs a fourth path
because one of its facts does not fit.

```
BOTH submit sites                     runtime stream
  submitAdmitted (:259)               (claude stream-json / codex thread items)
  submitPreparedCompletion (:451)       │
        │                               ├──────────────────┐
        ▼                               ▼                  ▼
EntityTurnCoordinator            RuntimeActivity      RuntimeNativeTurnEnd
 .attachSubmission                {assistant.message,  {completed|failed|
        │                          tool.call}           interrupted}
        │                               │                  │     TWO sinks, because
        │                               │                  │     a native turn end
        │                               ▼                  ▼     belongs to no one
        │                    runtime-owner            runtime-owner              submission
        │                     .generationActivitySink  .generationNativeTurnSink
        │                       │ generation fence      │ generation fence
        │                       ▼                       ▼
        │                    EntityTurnCoordinator    EntityTurnCoordinator
        │                     .activitySink            .nativeTurnSink
        │                       │                       │
        │            turnsBySubmission.get(event.submission)   ◀── the borrowed key
        │              ├─ found   ──▶ projectDisplay           │
        │              └─ missing ──▶ earlyActivity (cap 512)  │  because activity can
        │                              replayed on attach      │  beat its own submission
        ▼                       ▼                       ▼
 projectSubmitted        projectActivity         projectNativeTurnEnd
 projectSettled                                              ◀── 4 entry points
        │                       │                       │
        └───────────────┬───────┴───────────────────────┘
                        │  redactText() + size bounds + per-submission dedupe
                        ▼
        ChannelCoreEvent  ×5 kinds produced
          teammate.turn.submitted / .settled / .message / .tool_call
          teammate.native_turn.ended
                        │
                        ▼
        DispatcherCoreEventBus.publish ──▶ sealChannelCoreEvent  (7-kind allowlist)
                        │                 an unlisted kind is DROPPED here and
                        │                 logged at error — but the set is
                        ▼                 ReadonlySet<string>, so nothing fails
                        │                 at compile time and no test crosses it
        bus emit ──▶ scoped source ──▶ FeishuChannel.onCoreEvent
                        │
                        ▼
        feishu-cot-session.handle ──▶ switch, 5 cases:
          teammate.turn.submitted / .message / .tool_call
          teammate.native_turn.ended
          team.state                    ◀── NOT `.settled`; that one is produced
                        │                    and deliberately ignored
                        ▼
        feishu-cot-adapter ──▶ feishu-cot-state ──▶ outbox ──▶ Feishu card
```

Note what the two diagrams share: `submitPreparedCompletion` is a submit site in
flow A **and** a display producer in flow B, because `attachSubmission` calls
`projectSubmitted` unconditionally. That is how a TeamLeader's card currently
shows a TeamMate's answer arriving, and it is the behaviour any change to the
publish site must preserve.

### Where they tangle

Three mechanisms in flow B exist **only** because it borrowed flow A's key:

1. `turnsBySubmission` — a display fact must first find an `EntityTurn`.
2. the early-activity buffer — a fact can arrive before its submission is
   recorded.
3. the second sink and `teammate.native_turn.ended` — a fact can belong to
   **no** submission, so it cannot use path 1 at all.

And one fact travels a full round trip for no reason: `sourceId` goes *down* as
an admission key, is retained on `EntityTurn`, and comes back *out* on
`teammate.turn.submitted` so the Channel can recognise its own message.

## The change

**Display is attributed to the Agent. Core publishes the input fact, once.**

```
THREE callers, ONE publish site

submitInput(input)                     submitLocked(input, token)    [Workflow]
  │ enterOrdinaryMutation('submission')  │ assertLockToken — the fence would
  │                                      │ refuse a lock holder, so it is skipped
  └──────────────┬───────────────────────┘
                 │        prepareCompletion(fact).submit()           [push-back]
                 │          └─▶ submitInput({ source: COMPLETION_SOURCE,
                 │                            text: body, start: false })
                 ▼
TeammateService.submitAdmitted                      (teammate-service/index.ts:246)
  │  renderSubmission(input) ──▶ text = XML envelope
  │  AdmissionLedger.admit(key, sourceId)
  │    └─ no sourceId ⇒ ledger bypassed entirely (admission-ledger.ts:74)
  │
  │  inside the admission closure, inside operation(),
  │  immediately before the submit call:
  ├──▶ projectInput(agent, {text, source, sourceId})   ◀── THE ONE PUBLISH SITE
  │       fail-open guard here                             from the ORIGINAL body
  ▼
runtime.submit({ text })
  │     ◀── seam unchanged: still { text } only
  │  the admission settles in an async continuation (turn-coordinator.ts:168-190)
  └─ outcome ≠ submitted ─▶ projectActivity(agent, {turn.ended, outcome, reason})
       stopped | skipped |        ◀── the ONE activity fact Core itself produces:
       ambiguous | failed              it ends a card no runtime will ever end


runtime stream
  │
  ▼
RuntimeActivity {assistant.message | tool.call | turn.ended}   + occurredAt
  │                                                    ONE sink
  ▼
runtime-owner.generationActivitySink
  │  generation fence + stamps the Agent            ◀── attribution lives here
  │  + the fail-open try/catch, moved from the coordinator
  ▼
ConversationProjection.projectActivity(agent, activity)
  │  redactText() + size bounds
  ▼
ChannelCoreEvent  teammate.activity                 ◀── assistant half only
  │
  ▼
publish ──▶ seal (4-kind allowlist) ──▶ bus ──▶ scoped source
  │                                              ──▶ FeishuChannel.onCoreEvent
  ▼
feishu-cot-session.handle ──▶ switch, 3 cases:
  teammate.input      ── filter: is this id one I submitted?
  teammate.activity   ── render
  team.state          ── unchanged; it drives the leader close fence and the
  │                      current-card interrupt, and does not go anywhere
  ▼
adapter ──▶ state ──▶ card
```

### One publish site, and what it took to get there

The first two drafts of this design had **two** publish sites, and argued that
two was the structural floor because no single point saw every path. That
argument was true of the code as written and false of the code as it should be.

`submitPreparedCompletion` bypasses `submitAdmitted` on purpose. Its docstring
gives two reasons. Checked against source, **one is false and the other is real
but does not need a separate method**:

- *"reserves no duplicate key."* Free, not earned. `admission-ledger.ts:74` is
  `if (sourceId === undefined || sourceId === '') return operation();` — an
  omitted source id bypasses the ledger entirely, and a completion has none. Any
  call through `submitInput` without a `sourceId` already reserves nothing.
- *"only meaningful to a runtime that is already live."* Real, and load-bearing.
  `submitAdmitted` calls `runtimeOwner.ensureStarted()`, which boots a dormant
  recipient; `submitPreparedCompletion` calls `existingRuntimeAfterStart()`,
  which does not. The named failure scenario is below and it is not a race.

The third apparent difference — the `CompletionDeliveryResult` vocabulary — is a
translation that already exists (`turnAdmissionToCompletionDelivery`). On the
happy path the two paths are identical: `ensureStarted()` against a live runtime
is `if (this.runtime !== null) return;` after a scope assertion
(`runtime-owner.ts:79-88`).

So the difference is one boolean's worth of semantics, expressed today as a
parallel private method, a parallel coordinator entry (`submitCompletion`), a
parallel result vocabulary, and a fourth fence site. **Thread it as a
parameter** — `submitInput({ …, start: false })` — and all three callers
converge on `submitAdmitted`.

What the flag costs, stated plainly: `submitInput`'s docstring says "There is no
per-source wrapper and no caller-selected mode, because there is no per-source
behavior left to select." That claim is **already false today** — the mode
exists as a parallel private method the type system does not relate to the
first. A flag makes an existing mode visible rather than adding a new one, and
the docstring is corrected with it.

**The result mapping moves, it does not disappear.** An earlier revision claimed
no adapter was written; both reviewers refuted it. `submitInput` returns
`Promise<TurnAdmission>` and `PreparedCompletionDelivery.submit` must return
`Promise<CompletionDeliveryResult>` (`completion-router/index.ts:25-33`), so
deleting `turnAdmissionToCompletionDelivery` does not compile. It is
coordinator-private today and its only caller is the `submitCompletion` this
change deletes, so it **moves to the prepared handle**. What is genuinely not
written is a second try/catch preserving the old `unsupported` reason string:
the fence's throw propagates and the router's own `settleWithinDeadline`
catches it, giving the same dropped-without-retry outcome under a different log
line. The operator ruled that difference away: 「日志这种东西根本不重要」.

**A no-wake miss needs new code, not just a mapping.** `mustRuntime()` throws
when the runtime is null (`runtime-owner.ts:99-103`), so "no runtime under
no-wake returns `stopped`" is a branch this design adds rather than one it
reuses. It returns before the publish site, so such a call emits neither an
input nor a terminal — consistent, and previously unstated.

**The result vocabulary survives the merge unchanged.** Verified:
`turnAdmissionToCompletionDelivery` (`turn-coordinator.ts:340-356`) maps
`stopped` to `{ status: 'unsupported', reason: 'runtime stopped' }`. So
`start: false` against a recipient with no runtime returns `stopped`, which the
existing translation turns into exactly the `unsupported` the router reads
today. Only the `reason` string differs from
`'teammate runtime not running'` — log wording, which the operator ruled out as
a reason to keep code.

`prepareCompletion`'s own liveness check becomes redundant with the submit-time
one but **stays**: it is what stops Core rendering a completion body — and
possibly spilling a large one to disk — for a recipient that is already gone.
That is a real cost avoided, not defensive code.

### The named scenario the no-wake mode must preserve

Corrected on the third review. An earlier revision claimed a TeamMate
completing during a Team dissolve would resurrect the TeamLeader on the
ordinary path. **It would not**, and a test written from that claim passes
vacuously.

Why the ordinary path is closed: `stopRuntimesForDissolve` stops members first
and the leader last (`closing.ts:216-227`, via
`stopChildRuntimes` → `members.stopAllForDissolve`). `stopForHost()` awaits
`settleAndDeliverRetained()`, which awaits `turn.ensureDelivery()` for every
retained turn, which awaits the router's own `deliveryTask`
(`turn-coordinator.ts:156-166`, `turn-recording.ts:143-147`). So stopping a
member **waits for that member's completion to be delivered**, and the leader is
still live while that happens. The leader's own completion recipient, when one
is set, is the Dispatcher agent (`dispatcher-service/index.ts:493`), which a
dissolve never stops.

**A second fence closes the Team-scoped path entirely.** Found while answering
an operator question about dissolve cost. `TeamService.admit` throws
`TeamClosedError` as soon as `dissolveTask` is set — which `dissolve()` does
before running any of the work behind its receipt
(`team-service/index.ts:451-459`, `:475-477`). Every completion produced inside
a Team goes through `TeamLeaderCompletionTargets`, which calls that `admit` in
both `prepareCompletion` and `submit` and translates the refusal into
`unsupported` (`completion-targets.ts:36-60`). So during a Team dissolve a
member's completion is refused at the Team boundary and never reaches the
leader's runtime check at all. This is also why a dissolve does not wake the
leader N times to read N "was stopped" notices — a token cost the operator asked
about, and which does not occur.

So the **Team-scoped** justification for the no-wake mode is gone. What remains
is host shutdown: `stopForHost` leaves `phase === 'active'` with no runtime by
its own contract, and there is no Team fence in front of a dispatcher-scoped
TeamMate reporting to the dispatcher agent. That is the scenario the mode is
actually paid for, plus the two exceptional paths below:

- `settleWithinDeadline` abandons a `submit()` that is still pending at 30s, and
  that call resolves afterwards.
- A member's stop fails under `collectShutdownFailure`, so its delivery is
  deferred past the leader's stop.

Two further precisions, both narrowing the stakes:

- `prepareCompletion`'s retained liveness check answers first, so the no-wake
  mode is only *reached* when the runtime disappears between prepare and a later
  retry — not merely when the recipient is already down.
- Even a wake that did happen is swept: `transitionToClosed` calls
  `stopRuntime()` first. The cost is a wasted provider start inside a worktree
  being assessed for reclamation, not a resurrected TeamLeader.

**The test must therefore be entity-level, not dissolve-level.** A handle
prepared before `stopForHost()`, whose `submit()` runs after it, must return
`unsupported` and must cause no provider start. A test phrased as "a TeamMate
completes during a dissolve" finds the leader alive and never executes the mode
at all.

### Why `submitAdmitted` and not `submitInput`

`submitInput` is not the only door. The locked Workflow path calls
`submitAdmitted` directly (`:422`), because the ordinary-mutation fence
`submitInput` applies would refuse a caller that already holds the lock —
authorised by its token instead. Publishing at `submitInput` would silently drop
every Workflow submission from display.

### Placement inside `submitAdmitted` is exact

Four constraints pin it, and each rules out a nearby alternative:

- **Inside the admission-ledger closure**, so a repeat the ledger deduplicates
  does not publish a second input.
- ~~**Inside the `operation()` closure** `submitRuntimeTurn` invokes, not before
  it.~~ **Refuted by rulings 4 and 9, and not built this way.** Announcing an
  input that never reached a runtime is exactly what those rulings ask for: the
  input is published, and the non-`submitted` outcome ends it with its reason.
  Keeping the publish inside `operation()` would have preserved the very hole
  ruling 8 names — a submission that fails before the runtime accepts it shows
  nothing at all. As built, the publish sits at the top of the admission-ledger
  closure, above `ensureStarted()`, so a provider start failure (missing binary,
  vanished worktree) is announced and then failed too. See
  [As built](#as-built-departures-from-this-document).
- **Before `runtime.submit`**, not after — ruled by the operator, and the
  ordering argument is not why. Publishing first does remove the activity race
  by construction, and verification confirms the span is safe: between the two
  points there is only a synchronous active check, `capture`, and the call
  itself, with no `await`. But publishing *after* would have been ordered too,
  because codex buffers activity for an unbound turn into `pendingActivity`
  while an admission is in flight (`turn-manager.ts:320-333`) and releases it
  only once `await submitTurnStart(...)` has returned (`:146-149`, `:191`). The
  deciding reason is diagnosis: 「提交的当下就触发 submitted 事件。这样更有利于我去
  排查一些错误」 — a submission that fails must appear on the card **with the
  text that failed**, which publishing after admission would delete.
- **With a fail-open guard.** `projectDisplay` / `projectActorDisplay` /
  `warnProjectionFailure` are what make display fail-open today
  (`turn-coordinator.ts:239`) and they are deleted from the coordinator. This is
  not optional politeness: `projectInput` runs inside the admission closure, so
  an uncaught throw would reject the admission and run `releaseUncommitted` —
  display affecting admission, which the requirement forbids outright. As built
  the guard lives **inside `createConversationProjection`** rather than at each
  call site, so there is one of it rather than one per caller, and the
  projection's two methods are non-throwing by contract.

### A non-`submitted` outcome ends the card through `turn.ended`

A `stopped`, `skipped`, **`ambiguous`** or pre-admission `failed` result creates
no `EntityTurn` and guarantees no runtime native end, so an input published at
the submit site would otherwise leave a card open until some unrelated later
native turn closed it. `ambiguous` was missing from earlier revisions:
`submitObserved` returns it when `operation()` throws
(`turn-coordinator.ts:175-183`), with the same absence of a turn and a native
end.

**Ruled 2026-09-02: the card is ended by the same `ended` fact a real turn ends
with, and that fact carries the error text.** The operator's words are
「那些错误场景已经被 ended 的事件给包住了，错误信息给我打印在卡片上」. This closes
what earlier revisions called the design's largest hole — they proposed a second
*shape* on `teammate.input` and left three questions open about discriminants
and `sourceId` correlation. There is no second shape and no second kind. An
input opens the card, `turn.ended` closes it, and the only variable is what the
end says.

Concretely:

- `turn.ended` carries its outcome plus an optional reason string. A runtime end
  supplies `completed | failed | interrupted` and no reason; the end Core emits
  supplies the admission outcome and the failure text.
- **Core produces exactly one kind of `turn.ended`:** the one that ends an input
  it published which never reached a runtime. Every other `teammate.activity`
  fact is the runtime's own.
- The reason string is sanitised on the same path as every other display text —
  `redactText()` plus the size bounds — because a runtime error can carry a
  local path.
- It is emitted where the outcome is known, which is **not** the publish site.
  `runtime.submit` returns a Promise and the coordinator resolves the admission
  in an async continuation (`turn-coordinator.ts:168-190`). The input is
  published synchronously at the submit site; the end follows from that
  continuation. Two events about one input is the shape the ruled ordering
  requires, and reusing `ended` is what keeps it from also being a second kind.

**The write fence needs nothing.** `enterOrdinaryMutation` runs *before*
`submitAdmitted` (`teammate-service/index.ts:230`) and throws when the entity is
closing, closed, lock-held, or host-stopping. The throw never reaches the
publish site, so no `teammate.input` is published and no card is opened — there
is nothing to end. The Core-emitted `ended` above is required only for an
outcome that arrives *after* the input was published. Adding a card path for the
fence would be defence with no failure scenario.

### Two published kinds, and the boundary is the producer

- **`teammate.input`** — published by **Core**, at admission. Carries `text`,
  `source` and `sourceId`.
- **`teammate.activity`** — the runtime's vocabulary, carried through the one
  sink: `assistant.message`, `tool.call` or `turn.ended`, and never a source
  identity. Normally the runtime produces it. Core produces it in exactly one
  case, the `turn.ended` that ends an input which never reached a runtime — so
  that "an input is always followed by an end" holds for every input Core
  published, and the Channel keeps one close path instead of two.

Folding them into one kind with a four-valued discriminant was an earlier
version. It buys a smaller kind count and pays for it by hiding a real layer
boundary and by putting two fields in the union that are meaningless for three
of its four members. The whitepaper is explicit that collapsing N things into
one N-valued discriminant is not a boundary reduction, so there was nothing to
buy. The Channel also treats them differently in kind: it **filters** on input
and **renders** activity.

The sealed catalog therefore goes from seven kinds to four: `team.state`,
`teammate.state`, `teammate.input`, `teammate.activity`.

The stronger argument for the split is not the kind count — it is that
`teammate.activity` becomes the seam's own `RuntimeActivity` plus an actor
stamp, so **Core invents no vocabulary of its own for runtime facts**. That only
holds if the payload embeds the neutral shape after sanitisation rather than
reshaping it. Today `TeammateTurnToolCallEvent` reshapes into an
`arguments_json` string; this design requires the embedded form, and if that is
rejected the argument falls back to counting kinds.

### Ordering, and the one case it does not fix

Publishing the input before `runtime.submit` removes the race **for that
submission**. It does not order a *different* submission's facts, and one of
those matters: a native turn already running can end after the new input is
published, and `turn.ended` closes the current actor card. That hazard exists
today for the same reason — `teammate.native_turn.ended` is already actor-scoped
and carries no turn id — so this design neither introduces nor fixes it. Named
here so the next person does not discover it and assume it is new.

## Why the input fact belongs to Core, not a runtime

Two independent findings, both re-verified against source:

- **The runtime never sees the original body.** `submitAdmitted` hands it
  `renderSubmission(input)` — the assembled XML envelope — and keeps the body
  separately as `prompt` (`teammate-service/index.ts:246`, `:259`). The source
  says why in place: repeating the envelope "would show the model's provenance
  markup back to a human reader."
- **The seam must not carry source identity.** #350 records the operator moving
  "stable source identity and duplicate admission from the Agent Runtime seam to
  the Core admission owner", and `AgentRuntimeSubmissionInput`'s docstring states
  the seam carries "no source identity". The 2026-09-02 direction authorises
  `source_id` over text matching; it does not authorise reversing that.

Core already holds the body, the `sourceId`, the `source` (channel / cron /
task push / restart notice) and the Agent identity at the exact point of
admission. Nothing new is introduced to give it to them.

## Change inventory

See [analysis.md § The concrete change list](../analysis.md) for the file-by-file
diff description. Summary of the shape:

| | Before | After |
|---|---|---|
| Provider sinks | 2 (`activity`, `nativeTurn`) | 1 (`activity`) |
| `RuntimeActivity` kinds | 2 | 3 (adds `turn.ended`) |
| Core event kinds | 7 | 4 |
| Projection entry points | 4 | 2 (`projectInput`, `projectActivity`) |
| `runtime.submit` call sites | 2 | 1 |
| Input publish sites | 1 (implicit, via `attachSubmission`) | 1 (explicit, in `submitAdmitted`) |
| `enterOrdinaryMutation` call sites | 4 | 4 — `completion input` survives (see § As built 12) |
| Coordinator submit entries | 2 (`submitRuntimeTurn`, `submitCompletion`) | 1 |
| Feishu COT switch | 5 cases | 3 cases |
| Display key | `RuntimeSubmission` | the Agent |
| `AgentRuntimeSubmissionInput` | `{ text }` | `{ text }` — unchanged |

Three things review added to the file list that the first draft missed:

- **`occurredAt` has to move onto `RuntimeActivity`.** It lives on the
  `RuntimeActivityEvent` wrapper today (`agent-runtime.ts:215`), and the wrapper
  is being deleted because its only other field is `submission`. Deleting it
  without moving the timestamp loses event time.
- **`dreamux-types/src/channel.ts` and `src/index.ts`** both re-export every
  event and runtime type being removed. They must change in the same commit or
  the build breaks.
- **`seal.ts`'s `KINDS`** is a `ReadonlySet<string>` and is not type-checked
  against the union, so a new kind missing from it is dropped silently and no
  channel test crosses that path. It belongs in the first step, not the last.

## Folded-in cleanups

Authorized by the 2026-09-02 ruling recorded in `requirement.md`
(「能合并的都合并到一起吧，省得以后忘掉」). Scoped to what this change already
writes to. Each item is either merged here or recorded below with the reason it
does not reduce — the ruling's stated motive is that a deferred finding is
forgotten, and a durable negative result serves that motive too.

### Merged

**1. `seal.ts` gets an exhaustive kind catalog.** The allowlist is the reason a
kind can be added to `ChannelCoreEvent` and dropped at the bus. The drop is not
silent — `DispatcherCoreEventBus` writes `dispatcher core event is not a
publishable catalog event` at `error`
(`dispatcher-core-events/index.ts:98-107`), a correction from an earlier
revision — but a runtime error log is not a gate: nothing fails at compile time
and no test crosses the path. This change adds two kinds and removes four, so it
walks straight through that hole. The fix is a type, not a test:

```ts
// Exhaustive by construction: adding a kind to ChannelCoreEvent fails to
// compile here until it is listed, so a kind can no longer be published and
// silently dropped.
const KIND_CATALOG: Record<ChannelCoreEvent['kind'], true> = {
  'team.state': true,
  'teammate.state': true,
  'teammate.input': true,
  'teammate.activity': true,
};
const KINDS: ReadonlySet<string> = new Set(Object.keys(KIND_CATALOG));
```

The annotated-literal form is required and is not interchangeable with the
obvious alternative. Verified with the repo's own tsc 5.9.3 under `--strict`: a
missing key in `Record<Kind, true>` is `error TS2741`, while
`const KINDS: ReadonlySet<Kind> = new Set([...])` with a key missing reports
nothing. `satisfies Record<Kind, true>` also errors and is acceptable; a bare
`ReadonlySet<Kind>` is not.

**2. Four docstrings that are wrong rather than merely stale.**

- `teammate-service/index.ts:68-82` carries two stacked `/** */` blocks on
  `hostStop`. TypeScript associates only the last, so the first is dead text
  that still reads as authoritative. Delete it.
- `submitInput`'s docstring lists "a completion pushback" among the inputs that
  "reserve the duplicate key", while `submitPreparedCompletion`'s says it is
  "deliberately not routed through `submitInput`" and it reserves no key. They
  contradict each other, and that contradiction is what hid the second
  `runtime.submit` site from the first draft of this design. Under the merge
  both statements are superseded; the surviving docstring states the one path.
- `submitInput`'s "no caller-selected mode, because there is no per-source
  behavior left to select" is false today and stays false under the merge. It
  is rewritten to name the one mode that exists and why.
- `submitPreparedCompletion`'s docstring says a stopped recipient reports
  `unsupported` "so the completion router can fall back". **There is no
  fallback.** `CompletionDeliveryPolicy` is handed exactly one recipient — the
  `initiator` its caller passed — and never chooses among targets; on
  `unsupported` it writes `dropping completion: delivery unsupported` and
  returns (`completion-router/index.ts:197-207`). The conclusion is right and
  the stated mechanism is invented. The method is deleted by the merge, so what
  survives is the corrected statement on `submitInput`.
- `team-service/completion-targets.ts:20-26` repeats the same invented
  mechanism — "reports the delivery as unsupported, so the completion router
  falls back instead of reviving a Team being torn down". The behaviour it
  describes is real and important (this is the fence that keeps a dissolving
  Team from waking its leader), but the router does not fall back; it drops.
  Found on the third review.

## Recorded, not changed

Findings from reading this change's blast radius that do **not** become code
here. The operator's 「重构不动」 applies: they are written down so the next
reader does not re-derive them, and no more.

### `phase` stays a three-valued enum

It looks like the repo's own named anti-pattern — `service/CLAUDE.md`: "The
operation is the fence… Do not add a boolean beside a task, or a phase enum
beside either" — and `hostStop` sits directly beside it in the correct
nullable-promise form. Both obvious collapses lose information:

- *Make `closing` a `Promise | null` like `hostStop`.* Fails on three counts.
  `closeAuthorized` sets it as a task fence, but `runtime-owner.ts:277` also
  sets it with no task behind it — start threw and `runtime.stop()` threw too,
  so termination is unproven and the entity is quarantined. And when
  `transitionToClosed` rejects, `@deduplicate({ type: 'once' })` releases the
  promise so the close stays retryable, while the entity must stay fenced. A
  nullable promise carries none of those three; a promise that resets on
  rejection would reopen a failed close.
- *Derive `'closed'` from the durable `identity.status`.* Fails because they are
  different facts. A reopen constructs a **new** `TeammateService`
  (`teammate-collection/index.ts:216`), so a fresh instance is `phase: 'active'`
  over a record still saying `status: 'closed'` until the runtime publishes its
  own status. That mismatch is not duplication — it is exactly what the branch
  at `index.ts:470` exists to read.

**Why the rule does not bite here.** The rule targets a state that *mirrors* a
running operation — a promise already answers "is it running", so the mirror is
redundant and can drift. `phase` is not that: `closing` **outlives** its task,
and one of its producers has **no task at all**. Not redundant, so not the
banned shape.

Three consumers ask three different questions of it and each needs a different
answer: "may this entity accept work" (`enterOrdinaryMutation`, `lock`,
`stopForHost`, `submitLocked`, both `isActive` callbacks), "is this instance
finished so the collection may drop it" (`isRetired`, and the two
`closeAuthorized` branches), and "is a close underway" (`unlock`'s refusal, and
`effectiveIdentityStatus:378`, which projects a runtime-less closing entity as
`stopped` in the read model — user-visible).

### `markClosing` is the only parent-mutating write-back in `service/`

The one reduction that *is* available, and it is a layering fix rather than a
state fix. `markClosing` (`index.ts:120-121`) is the entity handing
`TeammateRuntimeOwner` a writer to its own lifecycle enum, so the runtime owner
can express a *runtime* fact — "start threw, `stop()` threw too, termination is
unproven" — by moving the *entity's* lifecycle.

`TeammateRuntimeOwner` is the only class named `*Owner` in `service/`. The
claim that it is the *only* extracted half mutating its parent was **refuted on
review** and is withdrawn: `TeamClosing`'s `closeLeaderForDissolve` callback
sets `this.leader_ = null` and its `commit` sets `this.record = updated`
(`team-service/index.ts:189-204`, `:664-675`), and `WorkflowRunTerminal.finalize`
reaches `Object.assign(this.record, ...)` (`workflow-service/run.ts:123-130`,
`:620-621`). Upward mutation is an established pattern here. What distinguishes
`markClosing` is not that it writes but *how*:

| Extracted half | Upward channel | Shape |
|---|---|---|
| `DispatcherInputSourceLifecycle` (#317) | `isUnavailable()`, `restartIntent()`, `agentMcp()` | reads and one supplier |
| `EntityTurnCoordinator` (#338) | `identity()`, `intent()`, `isActive()` | reads |
| `TeamClosing` (#350) | `record()`, `leader()`, `commit(patch)`, `closeLeaderForDissolve()` | one named durable write, documented: "Closing never writes the record itself: one owner, one path, so what this half decides and what the entity answers from can never drift apart" |
| `TeammateRuntimeOwner` (#338) | `isActive()`, two sinks, **`markClosing()`** | a bare setter for one enum value, undocumented |

This change edits that last row itself: `runtime-owner` gains the projection
call and the actor stamp, so its upward channel grows. The row is updated in the
same change rather than left describing the pre-change shape.

Every other upward write is a **named domain operation** whose rationale is
stated at the seam — "Closing never writes the record itself: one owner, one
path, so what this half decides and what the entity answers from can never
drift apart". `markClosing` is a bare setter for one value of a lifecycle enum,
with no stated reason, used to express a fact that is not about the lifecycle at
all. Moving that fact to its owner would take one meaning off the enum and
delete one cross-layer write, against one predicate added on the layer that
owns it. Not done here.

### The 700-line cap is shaping this module

`packages/eslint-config/index.js:207` sets `max-lines` to a hard error at 700,
with the stated rationale that "large files hide architectural boundaries". Two
files sit at **exactly** 700 today (`teammate-collection/index.ts`,
`team-service/index.ts`), and `teammate-service/index.ts` was 607 before #338,
659 immediately after the extraction that created `runtime-owner.ts` and
`turn-coordinator.ts`, and is 621 now.

That is the signature of a size-driven split rather than a boundary-driven one,
and it is the most likely reason `TeammateRuntimeOwner` exists in its current
shape. Recorded as context for whoever next touches this module; not acted on.

### A dropped completion is invisible

`CompletionDeliveryPolicy.deliverPrepared` has one success path and seven
non-success paths, and **all seven end in a dropped completion with only a
`log.warn`**:

| Outcome | Behavior |
|---|---|
| `accepted` | delivered |
| preparation timed out (30s default) | warn, drop |
| preparation threw | warn, drop |
| submit timed out | warn, drop |
| submit threw | warn, drop |
| `unsupported` | warn, drop |
| `ambiguous` | warn, drop — deliberately not retried |
| `failed` | retried up to `MAX_DELIVERY_ATTEMPTS` (3), then warn, drop |

Only `failed` is retried. Dropping the rest is defensible on its own terms: a
retried `ambiguous` admission could double-submit, and there is no second
recipient to try. **The gap is visibility, not policy.** The human watching the
COT card sees the TeamMate's turn end normally while the asking Agent never
learns the answer arrived; nothing in the display line says a hand-off was lost.

This change makes **part** of that divergence legible rather than fixing it,
and the boundary matters. A drop that happens *after* the input was published
gets an `ended` fact carrying the reason, so the card fails and says why. A drop that happens
*before* publication — `prepareCompletion` answering `unsupported`, the
ordinary-mutation fence throwing, either deadline firing — publishes nothing and
stays invisible exactly as it is today. Making that half user-visible is a
product decision and needs its own ruling.

### The router's deadline bounds the router, not the entity

Easy to read the 30-second `settleWithinDeadline` as a general safety net; it is
not. `prepareCompletion` holds `enterOrdinaryMutation('completion preparation')`
across `await runtimeOwner.existingRuntimeAfterStart()`, which is
`await this.starting` (`runtime-owner.ts:90-93`). If a provider start never
settles, that await never returns, the `finally { leave() }` never runs, and the
fence stays held. `settleWithinDeadline` does not help: on timeout it abandons
its own await and returns, and its own comment says the operation "may reject
much later".

`close()` does not rescue it either. `transitionToClosed` calls
`runtimeOwner.stopRuntime()` first, and that joins the same promise
(`await this.starting?.catch(...)`, `runtime-owner.ts:149`) rather than
cancelling it, so it blocks on the identical await before ever reaching
`waitForOrdinaryMutations()`.

A hung provider start is unbounded on this path. The held fence is a second way
for it to surface, not an independent defect; the root cause is that nothing
bounds a provider start here. Pre-existing and out of scope.

## The change files this needs

Removing four published `ChannelCoreEvent` kinds breaks any Channel provider
subscribing to them. `@excitedjs/feishu-channel` already carries the precedent
wording for exactly this class of change in its own changelog ("stop subscribing
to the removed turn.submitted and turn.settled events … No rebuild is
required"), because no persisted format moves — only a contract a subscriber
reads at runtime.

- `@excitedjs/dreamux-types` (0.8.0) and `@excitedjs/dreamux` (0.22.0) are on
  the 0.x line, so their change files are type `minor` with the note leading
  `BREAKING:` — never `major`, which CI rejects on 0.x.
- `@excitedjs/feishu-channel` (5.0.0) is past 1.0.0 and takes a real semver
  `major`.
- No state, config, cache or path format changes, so the notes carry `Review:`
  and say explicitly that no rebuild is needed. They must not carry `Rebuild:`.

## Unresolved

### 1. The activity-fact dedupe

The two reviews disagree, and the disagreement is not settled.

One found no named repeater — both runtimes generate an activity id at emit
time — and concluded the dedupe is defence without a scenario, which the
whitepaper says to delete. The other returned **UNDETERMINED** with a mechanism:
codex performs no item-level deduplication of repeated `item/started` /
`item/completed` notifications, and its activity ids are deterministic, so a
repeated notification would produce a colliding id (`events.ts:159`,
`turn-manager.ts:387`).

A named mechanism outranks an absence of one. **The dedupe stays until a probe
settles whether codex can repeat a notification.** If it cannot, it is deleted;
if it can, it is load-bearing and must be re-keyed by actor with that scenario
written down. Deleting it on the strength of "nobody named a repeater" would be
exactly the kind of unknowing change this repository forbids.

**Resolved at implementation: deleted, because "keeping it" was not an
available option.** Its key is `RuntimeSubmission`, the key this change removes.
The instruction to re-key it by actor does not survive contact: an actor-keyed
set over a long-lived agent is either unbounded, or — at the existing 512 cap —
fills within one busy conversation and then silently drops *every* subsequent
fact, which is worse than the duplicate row it was guarding against. The dedupe
was therefore removed rather than carried forward under a new name.

If a probe later shows codex can repeat a notification, the honest home for the
fix is the **codex provider's own turn manager**, keyed by native turn id and
released with the turn (`releaseRecordIfReady`) — bounded by construction,
scoped to the layer that would know, and out of Core's neutral projection
entirely. The Feishu layer already tolerates a repeated tool-call *result* (its
`openCalls` entry is deleted on first use); a repeated assistant message would
print twice. The probe itself: drive a live codex turn and count
`item/completed` notifications per item id in `subscribeTurnCollection`.

### 2. Embedded versus reshaped activity payload

`teammate.activity` should embed the neutral `RuntimeActivity` shape after
sanitisation. Today `TeammateTurnToolCallEvent` reshapes into an
`arguments_json` string. If the reshaped form is kept, the "Core invents no
vocabulary" argument falls back to counting kinds.

**Resolved at implementation: reshaped, with the runtime's own member names
kept.** Embedding is not available — sanitisation is lossy and type-changing
(`JsonValue` becomes a bounded string plus truncation and redaction flags), so
an "embedded" payload would be a differently-typed lookalike of
`RuntimeActivity`, which is worse than an honest second shape. The vocabulary
argument is preserved a different way: `TeammateActivity`'s members are named
`assistant.message`, `tool.call`, and `turn.ended` — exactly `RuntimeActivity`'s
— so a maintainer holds one vocabulary, not two, and a new runtime fact adds a
member on both sides without touching the event catalog or the seal.

## Implementation sequence

The first draft's numbered order was refuted by review: steps called projection
entry points that a later step created, and one step could not compile. Corrected
order:

Reviewed a third time and corrected again: the previous order broke the build at
three separate points. Each step below must leave `rush build` green on its own.

1. **`dreamux-types` + `seal.ts` together.** Add the `teammate.input` /
   `teammate.activity` events and convert `KINDS` to the exhaustive catalog.
   **Add `turn.ended` and `occurredAt` to `RuntimeActivity` as optional**, not
   required: both runtimes construct `RuntimeActivity` without them
   (`claude-code/src/runtime-submissions.ts:229-277`,
   `codex/src/turn-manager.ts:387-409`) and their changes land later, so a
   required field breaks compilation here. Update the two tests asserting an
   exact kind list (`core-event-catalog.test.ts:176`,
   `input-source-lifecycle.test.ts:468`) to the transitional set.
2. **`conversation-projection`: add `projectInput`, and a *distinctly named*
   activity entry** — `projectActivity` already exists
   (`conversation-projection.ts:79-99`) and routes any non-message kind into
   `toolEvent`. The new one lands beside it under its own name; the old name is
   freed in the deletion step. Not additive under the same name.
3. **Both runtimes: populate `occurredAt` and emit native turn ends through the
   activity sink.** After step 2, because the old `projectActivity` throws on
   `turn.ended`. This is what makes the fields from step 1 always present.
4. **Merge the completion path.** Add the no-wake mode; move
   `turnAdmissionToCompletionDelivery` to the prepared handle **in the same
   commit** that deletes `submitCompletion`, or the return types break; add the
   null-runtime-under-no-wake branch; delete `submitPreparedCompletion`. **The
   entity-level no-wake test lands with this step, not after it.**
5. **Core: publish `teammate.input`** in `submitAdmitted`, inside the operation
   closure, before `runtime.submit`, with the fail-open guard. The Core-emitted
   `turn.ended` lands in the same step, from the admission continuation, for a
   `stopped` / `skipped` / `ambiguous` / `failed` outcome.
6. **`runtime-owner`: stamp the actor, carry the guard, call the projection.**
7. **Feishu: three-case switch**, re-keyed anchor.
8. **Delete.** The second sink, `turnsBySubmission`, the early buffer, the old
   entry points and the freed name, the four old kinds, the retained `EntityTurn`
   fields, codex's `pendingActivity`, and the transitional test assertions.
   Tighten the step-1 optional fields to required.
9. **Knowledge delta:** `provider-runtime.md`, `channel.md`, and the
   `dreamux-maintenance` reference if any published contract it names moves.

Step 8 is not one atom. `teammate.turn.settled`, `{ priority: 'now' }` and
codex's `nativeTurnEnded` are independent of the rest and can land separately.
What is genuinely atomic is the set of the second sink, `turnsBySubmission`, the
early buffer, the old entry points, the old kinds and the `EntityTurn` fields.

## Verification

- The locked COT product model is the acceptance test: one recipient, one
  anchor, at most one open card, closed by the runtime's own native end.
- **A TeamMate completing during a Team dissolve must not start a TeamLeader
  runtime.** This is the scenario the `start: false` flag exists for, and the
  merge makes it a flag rather than a separate method — which is exactly what
  makes it easy to regress. It must be a test, not an assumption.
- **A TeamLeader delegating to a TeamMate must still show the answer arriving.**
  That is the behaviour an incorrectly-placed publish site would delete, and the
  one regression a card-shaped test would not obviously catch.
- **A submission that is stopped, skipped, or fails before admission must leave
  no open card, and the card must show why.** This is the gap an earlier draft
  claimed was already handled. Both halves are asserted: the card ends, and the
  reason text reaches it through the same redaction path as any other display
  text.
- **A Workflow submission must still appear on the card.** It reaches
  `submitAdmitted` without passing `submitInput`.
- A live probe on both runtimes, since the 2026-09-02 probe is what settled the
  current semantics and this changes where facts enter.
- `cot-projection-privacy.test.ts` must keep passing on redaction and bounds. Its
  dedupe assertions stay until the dedupe question above is settled.

## Rejected alternatives

- **Verbatim provider pass-through.** Rejected before this design: it would put
  claude's stream-json and codex's thread-item shapes into Core and every
  Channel — the coupling #350 removed.
- **A caller-supplied id on `AgentRuntimeSubmissionInput`.** The first version of
  this design. Rejected on review: it shows the envelope and reverses a recorded
  ruling.
- **One `teammate.activity` kind carrying `input` as a fourth discriminant.**
  Rejected by the operator on 2026-09-02 in favour of splitting by producer.
- **Keeping the early buffer and re-keying it by actor.** That is the banned
  fake — a mechanism surviving under a new name while nothing is removed.
- **Two publish sites as the structural floor.** The position of the first two
  drafts. Refuted by the merge: the floor was a property of the code, not of the
  problem.
- **Merging the completion path with no flag at all.** Refuted by the
  Team-dissolve window: it would resurrect a TeamLeader the dissolve had just
  stopped.

## Known risks

- **The dedupe is unresolved.** It blocks one deletion, not the design.
- **The merge concentrates two behaviours in one method.** `submitAdmitted` now
  serves ordinary input, Workflow input and push-back. The `start` flag is the
  only thing separating "may wake a dormant agent" from "must not", and it is
  one boolean where there used to be a whole method. Mitigated by the
  dissolve-window test being mandatory in the same step.
- **A stale native turn can close a fresh card.** One instance of this is now
  deliberate: an unbound codex end closes whatever card is open (departure 7),
  which is what rule 8 says a native end does. Not introduced here —
  `teammate.native_turn.ended` is already actor-scoped and carries no turn id —
  but the actor-keyed shape makes it easier to hit and it should be tested. The
  Core-emitted `turn.ended` inherits the same property — a failed submission
  ends *the actor's* card — and the operator ruled that this is the intent, not
  a hazard:
  「不,那几个情况就把卡置成失败。说的就是唯一开着的卡,不是当前输入开的那张新卡。所有的卡都是当前teammate 自己的,没有别人的。」
  What follows from it is display, not damage: a turn that is still running
  keeps producing after that failed end, and rule 8 opens a new card at the same
  anchor for the rest of it. The paths that reach it, and the `unsettled_turn`
  field that says which shape to expect, are in the task record's **Open
  questions**.
- **`teammate.state` is a published surface with no in-repo reader.** An
  out-of-tree Channel provider could consume it. flowx ports these PRs and is
  the other stakeholder.
- **The cold-read vocabulary is untouched.** `AgentActivityRecord` (`last`) and
  `RuntimeActivity` (push) remain two vocabularies for one subject. The
  operator's framing was "one `Activity` namespace"; this design answers the
  push half only. Convergence is a separate decision.
- **codex's `unboundObservedTurnIds` and `dropOrphanActivityIfIdle` are not
  purely display.** They also drive `collector.releaseTurn` memory release under
  `retainAfterTerminal: true`. The reduced form must keep observing unbound turn
  ids, holding them across in-flight admissions, removing on bind or terminal,
  and releasing when idle. Only `pendingActivity`'s storage and cleanup go.

## Completion condition

The design is complete when a maintainer can explain the display path without
mentioning a submission, `turn-coordinator.ts` contains no display code, and
there is exactly one place in Core where an input fact is published.

## As built: departures from this document

Recorded here rather than left stale, per the working-authority note at the top.
Everything not listed was built as designed.

### 1. The input publishes above `ensureStarted()`, not inside `operation()`

Stated in [Placement inside `submitAdmitted` is exact](#placement-inside-submitadmitted-is-exact).
The design's placement predates rulings 4 and 9 and preserved the hole ruling 8
names. As built, `submitAdmitted` publishes at the top of the admission-ledger
closure and then obliges everything below it to end what it opened:

- a non-`submitted` admission ends the card as `failed` with the reason
  (`failedAdmissionReason`, beside the two sibling admission mappers in
  `turn-recording.ts`);
- a **throw** — `ensureStarted()` on a dormant agent whose binary is gone,
  `updateIntent` failing — ends the card with the error message and rethrows.

One `try`/`catch` covers the whole span, with the start failure as its named
scenario. Two acceptance tests pin both halves
(`tests/admission-ledger.test.ts`).

### 2. A completion push-back to a stopped recipient is now visible

**This is a user-visible behavior change and the operator may want to veto it.**
[A dropped completion is invisible](#a-dropped-completion-is-invisible) says the
pre-publication half of that divergence "stays invisible exactly as it is today"
and that changing it "needs its own ruling". Applying rulings 4 and 8 uniformly
moved the publish above the liveness check, so it no longer does: a push-back
whose recipient's runtime is gone now shows the delivered body on the
recipient's card followed by `turn.ended(failed, "the agent runtime is not
running")`. The window is the one `prepareCompletion` does not already refuse:
a recipient already known to be stopped is answered `unsupported` at
`index.ts:345-349` without publishing anything.

Kept, because the alternative is a special case — "every admitted input is
announced, *except* a push-back to a dead recipient" — and because a lost
hand-off is precisely the thing the operator's diagnosis motive wants to see.
The window is narrow: `prepareCompletion`'s own liveness check refuses first in
the common case, so this fires only when the runtime disappears between prepare
and submit. Pinned by a test so a decision to revert it is a one-line change.

### 3. Ruling 4's 「置成失败」 is `failed` in the neutral fact and `RUN_ERROR` on the wire

`failedAdmissionReason` gives all four non-`submitted` admissions the same
verdict — `status: 'failed'` on the published `turn.ended` — because that is
what the ruling says, and a ruling is quoted, never stretched. Only the reason
differs between the four, so only the reason is returned; the status is a
constant of the rule, not data.

This item first shipped claiming the Feishu wire could not say it, on the
reasoning that `FeishuCotRunStatus` was `'done' | 'interrupted'` and that
guessing a third `RUN_FINISHED` status risked the platform rejecting the whole
append batch. **Both halves of that were wrong**, and the operator's ruling
「先探平台再定」 is what found it out. The reference exists, but not where it was
looked for: `message_cot` is absent from every `open.feishu.cn` doc — the
`llms.txt` index, the messaging, AI, aily, card, bot and MCP module docs, and
web search — and lives on the enterprise docs host `open.larkoffice.com` as
**COT Message Brief**
(`/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message_cot/cot-message-brief`),
which the operator pointed at once the probe had run. Probe and reference agree,
and the reference carries the field-level detail a probe cannot show.

Four cards were created, finished with a different terminal each, and read in
the client:

| terminal sent | renders as |
|---|---|
| `RUN_FINISHED` with `status: 'failed'` | 已完成 |
| `RUN_FINISHED` with `status: 'interrupted'` | 已中断 |
| `RUN_FINISHED` with a deliberately nonsense status | 已完成 |
| `RUN_ERROR` | **任务失败** |

- **`code: 0` is not evidence.** The platform accepted every one of them,
  including the nonsense status, so it does not validate this enum at the API
  level and the rejection risk this item named does not exist. Only the rendered
  card answers, which is why the API-level part of the probe settled nothing.
- **The failure terminal exists and is a different event, not a status value.**
  AG-UI puts it in `RUN_ERROR`. This layer had been looking for it among the
  values of `RUN_FINISHED.status`, where it is not.

The reference then explains the rendering and fixes the shape:

- `RUN_FINISHED.status` is documented as exactly three values — `done`,
  `paused`, `interrupted`. `failed` is not one of them, which is why it rendered
  已完成: the client ignores a status it does not know rather than rejecting it,
  exactly as it did for the nonsense status.
- `RUN_ERROR` is event 3, "Run failed", and its documented content is
  `{ message, code }` and nothing else — no `threadId`, no `runId`. The probe
  sent the run ids anyway and the platform tolerated them; the code sends
  neither. It sends `code` alone, for the reason the last two probes below give.
- The event vocabulary is a numbered enum (`1 RUN_STARTED`, `2 RUN_FINISHED`,
  `3 RUN_ERROR`, `10-13 TEXT_MESSAGE_*`, `20-24 TOOL_CALL_*`, …) and both the
  name and the number are accepted in `event_type`. This layer sends names.
- Field names are camelCase (`messageId`, `toolCallId`, `threadId`), which is
  what this layer already sends. The `complete` endpoint's
  `reason` is `done | error | timeout`, which `FeishuCotCompleteReason` already
  spells exactly, so that type needed no change.
- `paused` is a documented status this Channel never produces: a card here is
  open or ended, never held. The omission is deliberate and is noted beside the
  type so the next reader knows the enum is three-valued.

As built, the wire terminal is three-valued across two event types.
`FeishuCotRunStatus` is gone; the presentation's terminal intent is
`FeishuCotTerminal`, which is the neutral `turn.ended` status itself
(`Extract<TeammateActivity, { kind: 'turn.ended' }>['status']`). One vocabulary
now runs from the runtime to the card: `finishCard` passes `end.status` through
with no mapping, and the lifecycle paths that end a card with no runtime saying
so — a retired anchor, a session close — keep passing `'interrupted'`, because a
retired anchor is not a failure.

`runFinishedEvent` is replaced by one `runTerminalEvent(presentationId,
terminal)` with an exhaustive switch: `completed` → `RUN_FINISHED done`,
`interrupted` → `RUN_FINISHED interrupted`, `failed` → `RUN_ERROR`. Exporting a
`runErrorEvent` beside the old function was the alternative and was rejected: it
would put "a failure is a different event type" — AG-UI spelling, which is this
module's whole job — into the adapter's flush loop. A fourth `turn.ended` status
would now fail to compile at that switch rather than silently render as
interrupted.

`RUN_ERROR` sends `{ code: 'RUN_FAILED' }` and nothing else. The reference
documents a `message` beside it, and the first implementation put the failing
turn's own reason there; two further probes then settled that the field is
inert. A card finished with `message: "the agent runtime is not running"`,
expanded in the client, shows a 任务失败 title, the text message appended before
the terminal, and then the client's own fixed 任务失败 line — **the supplied
message appears nowhere**. A second card finished with content that was only
`{ code: 'RUN_FAILED' }`, no `message` at all, renders identically, so the field
is neither rendered nor required. The operator ruled:
「这里我感觉不传都行，反正也不展示」.

Two things follow, and both are as built:

- **The text message printed before the terminal is load-bearing.** It is the
  only thing that puts ruling 9's error text on a card, so `finishCard` keeps
  printing it from `end.reason`. It is not a second copy of anything.
- **Everything that existed only to carry the reason to the wire is deleted.**
  The terminal intent goes back to a bare `FeishuCotTerminal` and `detach` back
  to three arguments; `RUN_ERROR_MESSAGE_MAX_BYTES`, the 512-byte truncation at
  the terminal builder, the 任务失败 fallback for a reasonless end, and the
  100_000-character test that pinned the bound are all gone. That test's named
  scenario — a long reason overflowing one event's 4 KiB content — existed only
  because the reason was sent there; with the field gone the scenario is gone,
  and a test with no scenario is not coverage. `truncateUtf8` had no caller left
  outside `feishu-cot-presentation.ts` and is private there again.

Only one reader of the intent's `reason` ever existed — the terminal builder —
which is why removing the field costs nothing: `finishCard` prints from
`end.reason` directly, before it calls `detach`.

### 4. `TeammateRuntimeOwner`'s upward channel shrinks instead of growing

The design expected the owner to gain a projection dependency. It already held
`deps.conversationProjection` and `options.role`, so it builds the
`ProjectedAgent` itself and its callbacks shrink from four to two
(`{ isActive, markClosing }`). One generation-fenced sink replaces two.

### 5. `reason` on the *runtime's* `turn.ended` is a design choice, not ruling 9

Ruling 9's 「那些错误场景」 refers to ruling 4's non-submitted admissions. Carrying
a reason on the provider's own ends too — claude's failed `result`, codex's
finalize failure and protocol teardown — is this implementation's addition under
the same diagnosis motive. Cheap, and it makes a card that stopped say why.

### 6. Previously-dropped activity now displays

Both providers dropped live activity they could not attribute to a submission:
claude returned early when no started command and no sole submission could own
it (`emitStreamActivity`), and codex buffered into `pendingActivity` and dropped
the buffer if no submission ever bound. Keyed on the agent, there is nothing to
attribute, so both facts now display. The claude test that asserted the drop was
inverted to assert the emission, with the reason in its name.

### 7. The display end is the provider's own terminal, on both runtimes

At merge-base `ca30883d` both providers computed a native turn's end from what
the push-back line had made of it. codex called `endNativeTurn` from `finalize`
with the status of the `RuntimeCompletion` it had just built — including the
failed one it built when the output-schema codec could not restore the turn's
text — and skipped the call entirely for a turn no submission bound
(`record.representative === null`). Claude Code had the same shape in
`completeStartedGroup` (`completion.status === 'completed' ? …`), plus two
synthesized ends that fired only when the call had settled at least one
submission (`if (settled)`, `if (stopped)`).

Departure 6 removed the attribution gate on *activity*. This departure first
kept it on the end, then moved the unbound codex end into `drainTerminalOrder`,
behind the terminal queue and the admissions gate. The operator ruled that whole
shape wrong:

> 你这有点扯淡了，你不还是把回推的事件和CoT耦合在一起了吗？这个事件是专门给回推用的，然后它还应该有一个ended事件，不是无脑推吗？

> 无人认领的流，它应该有一个对应的始终推送的关闭事件啊

> 你把这个 ended 的事件加在了一堆门控逻辑后面。这不就变成了给自己找麻烦吗？这一堆门控后面，还能真实反映出 provider 正在发生的事情吗？

and stated the motive the acceptance criterion follows from:

> 我这次的目标是把回推和CoT的机制拆开，本质上就是因为：
> 1. 回推那边有大量的门控
> 2. CoT需要真实反映agent provider现在正在发生的事情

**As built now.** The display line reports the provider's own terminal, where
the provider reports it, and reads nothing the push-back line produces.

- codex ends in `observeTerminal`, as its first statement: `completed` for a
  `CollectedTurn`, `failed` carrying the `Error`'s message. Nothing under it —
  the record's `terminal !== null || completion !== null` bookkeeping, the
  `terminalOrder` queue, `drainTerminalOrder`'s head checks, the
  `pendingAdmissions` gate, `finalize` — is on the path any more.
- Claude Code ends in `handleProtocolEvent`'s `result` branch, before
  `completeStartedGroup` runs: `completed`, or `failed` with claude's own
  `errors`/`subtype` text. The attribution, the completion and the settlements
  are push-back's work on the same fact and cannot change, delay or withhold it.
- The synthesized ends — codex `stop()`/`failProtocol`, claude
  `stopUnsettled`/`markTurnFailed` — no longer ask whether a submission was
  settled. They end every native turn that is still open, which is what reaches
  a turn the provider only ever streamed items for.

**At-most-once moved off the push-back record.** *(Superseded 2026-09-03 —
the operator ruled the tables below out: 「这个表直接删了不就可以了？cot 相关的部分，
在 provider 应该是完全无状态的」. Both were deleted; a teardown reports one end
without asking whether a turn was open, and the Channel ignores an end with
nothing open. See `requirement.md` § Ruling on display state.)* codex keeps
`displayTurns: Map<string, 'open' | 'ended'>`, noted from `submit` (the turn id
codex answered with), `observeItem` and `observeTerminal`, and cleared by
`stop()` — one entry per native turn, the same shape and lifetime as the
collector's own `terminalFingerprints`. It survives `nativeTurns.delete`, which
is exactly what `record.nativeTurnEnded` could not do. Claude Code names no
native turn, so its equivalent is one `NativeTurnDisplay.open` flag on the
runtime (not on `ActiveTurn`, which is dropped when the window closes): a
`result` reports its end unconditionally, and the synthesized ends report only
when a turn is open. Only `command_lifecycle` `started` and stream lines open
it. The CLI's legal order is `started` → `result` → `completed`, so a `completed`
arrives *after* the end it belongs to; treating it as news from claude re-opens a
finished turn and hands `stopUnsettled` one to interrupt, which paints a spurious
`interrupted` end on every ordinary turn. Regression test: `runtime.test.ts` →
"reports one end for the real lifecycle order, where `completed` follows the
result".

**What that deleted.** codex: `endNativeTurn` and all five of its call sites,
`NativeTurnRecord.nativeTurnEnded` and both initializers, and the display half
of `drainTerminalOrder`'s unbound branch together with its warn. Claude Code:
the module-level `endNativeTurn`, the runtime's private wrapper, the `settled`
and `stopped` locals that gated the two synthesized ends, and
`failUnattributedResult`'s own end. The unbound branch in `drainTerminalOrder`
itself stays — with the end gone it is purely the queue-head release
(`terminalOrder.shift`, `nativeTurns.delete`, `unboundObservedTurnIds.delete`,
`collector.releaseTurn`, which `retainAfterTerminal: true` depends on), and
without it the queue stalls behind a head nothing else drains. `finalize`'s
`representative === null` return stays for the same reason it always had: it is
push-back work — it settles `record.members`, calls `opts.onTurnCompleted` and
builds a `RuntimeCompletion` — and a turn no submission claimed has nothing to
settle and no completion to describe.

**Does the display end still need `NativeTurnRecord`?** No. Neither provider's
end reads a push-back record any more: codex's reads the terminal it was handed
and its own map, claude's reads the `result` outcome and its own flag. The
record is now push-back state only.

**The gates that were counted, and where they are.** Seven stood between "codex
says the turn ended" and "`turn.ended` is emitted"; two remain, and both are the
display line's own:

| # | gate | now |
| --- | --- | --- |
| 1 | collector line admission: session/thread checks, `rememberTerminal`'s duplicate/conflict verdict (`events.ts`) | **kept** — the display line wants it: codex contradicting itself must not paint two ends |
| 2 | `observeTerminal`'s `record.terminal !== null \|\| record.completion !== null` | off the path: the end is emitted above it |
| 3 | the `terminalOrder` FIFO | off the path: the end never enters the queue |
| 4 | `drainTerminalOrder`'s head check | off the path |
| 5 | `drainTerminalOrder`'s `pendingAdmissions.size > 0` | off the path; kept for `finalize`, which must not settle a submission that has not bound yet |
| 6 | `finalize` — `completion !== null`, codec restore, status from `RuntimeCompletion` | off the path entirely |
| 7 | the at-most-once flag | **deleted 2026-09-03** (as first built: kept, moved to `displayTurns` keyed by native turn id) — the provider holds no display state; a teardown end with nothing open is ignored by the Channel |

Claude Code's four go the same way: result attribution, the `completion`
construction (`resultTextFromTurnOutcome` throwing), the status read off
`completion.status`, and the `if (settled)` / `if (stopped)` guards are all
below or beside the end, none in front of it.

**Behaviour this changed, deliberately.** A codex turn whose encoded result
cannot be restored, and a claude `result` no started command can be attributed
to, used to paint the card as a failed turn; they now show the turn the provider
reported, while the submissions still settle as failed. That is the second
motive applied literally: the card says what the provider did, not what
push-back could make of it.

Tests: `codex-runtime.test.ts` → "reports the end while an admission is still in
flight", "ends a turn codex only ever sent items for, when stop() tears it
down" / "…when the protocol fails", "shows the turn codex reported even when the
encoded text cannot be restored"; `runtime.test.ts` → "reports the end of a
native turn that has no submission left to settle", "reports failed for a native
turn the run died on with nothing left to settle"; `runtime-submissions.test.ts`
→ "shows claude's own result even when push-back cannot attribute it";
`codex-live.test.ts` → "ends a native turn no Dreamux submission ever bound,
through real codex".

### 8. `teammate.turn.settled`'s assistant text has no successor

Ruling 3 deletes the event. Its `assistant` field (bounded by
`ASSISTANT_TEXT_MAX`, now deleted with it) was the turn's final result text. No
Channel consumed it — the Feishu switch deliberately omitted the kind — and the
same text also arrives as an `assistant.message` activity from the runtime, so
no display loses anything. `ASSISTANT_TEXT_MAX` and its truncation tests were
removed with the field.

### 9. `isSynthetic` is producer-less but stays

`TurnSubmitOptions.isSynthetic` has no caller in `src/` today, exactly like
`priority` did. Ruling 1 names `priority` and nothing else, and an operator
ruling is quoted, never stretched — so `isSynthetic` was left alone. Recorded
here so it is not forgotten: it is a candidate for the same treatment if the
operator wants it, and its stream-json envelope behavior is still tested.

### 10. The workflow lock path publishes no input when the *start* fails

`submitLocked` calls `ensureStarted()` itself before delegating to
`submitAdmitted`, so on that one path a provider start failure throws before the
input is announced — the hole item 1 closed for every other path. The redundant
start is not removable: it exists so the lock token and the `active` phase are
re-asserted *after* the await, which is the point of a locked submission.
Closing the hole means announcing the input before that re-check, which would
publish an input a revoked lock then refuses. Recorded, not fixed.

### 11. Tests are typechecked by `rush typecheck:tests`, which is not part of `rush build`

`tsconfig.json` excludes `tests/`, and vitest runs through esbuild, which erases
types. Two test files therefore stayed green while compiling against types this
change deleted: `dreamux-types/tests/team-teammate-contract.test.ts` asserted the
shapes of five removed events, and `dreamux/tests/helpers/workflow-harness.ts`
built a `Turn` with the five fields the push-back split removed from it. Both are
rewritten. `rush typecheck:tests` exists precisely for this and belongs in the
green bar for any change that moves a type.

### 12. `enterOrdinaryMutation` stays at four call sites

The inventory table predicted 4 → 3 on the assumption that the completion path
would fold into the ordinary one. It did fold — `submitPreparedCompletion`
became `submitCompletionInput`, which goes through `submitAdmitted` like any
other input — but it keeps its own `enterOrdinaryMutation('completion input')`
because it must *translate* the refusal — a closing entity answers a push-back
with `unsupported`, where an ordinary submission throws. Sharing `submitInput`'s
fence would throw at the completion router. The table row is corrected in place.

### 13. The 700-line cap split `feishu-cot-events.ts`, as recorded

The three-valued terminal left that file at 696 of its 700-line lint cap, and
this follow-up needed ~20 more. The recorded seam is the one that was taken:
`feishu-cot-presentation.ts` now owns what a card *shows* for a tool call — the
tool-name catalog, the owned/built-in/teammate presentations, detail
normalization — plus the byte bounding those strings share (`truncateUtf8`,
`truncateEscaped`, `escapedBytes`, `TRUNCATION_MARKER`). `feishu-cot-events.ts`
keeps event construction and wire budgets and imports from it, one direction
only. 427 and 317 lines, no behaviour change, no other file touched: the split
is by concern, not by line count, which is why the cap could force it without
distorting it.
