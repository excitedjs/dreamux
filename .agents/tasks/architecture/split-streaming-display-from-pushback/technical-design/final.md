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
| A stopped / skipped / failed submission sets the card to failed | The terminal fact at the publish site |
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
        ◀── seam unchanged: still { text } only


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
- **Inside the `operation()` closure** `submitRuntimeTurn` invokes, not before
  it: `submitRuntimeTurn` can return `stopped` without ever calling
  `operation()` (`turn-coordinator.ts:125`), and publishing outside would
  announce an input that never reached a runtime.
- **Before `runtime.submit`**, not after. An earlier draft claimed the ordering
  was natural; it is not — codex subscribes before `turn/start` resolves.
  Publishing first removes the race by construction. Verified: between the two
  points there is only a synchronous active check, `capture`, and the call
  itself, with no `await`.
- **With a fail-open guard.** `projectDisplay` / `projectActorDisplay` /
  `warnProjectionFailure` are what make display fail-open today
  (`turn-coordinator.ts:239`) and they are deleted from the coordinator. This is
  not optional politeness: `projectInput` runs inside the admission closure, so
  an uncaught throw would reject the admission and run `releaseUncommitted` —
  display affecting admission, which the requirement forbids outright.

### A non-`submitted` outcome terminates the card at the same site

A `stopped`, `skipped`, **`ambiguous`** or pre-admission `failed` result creates
no `EntityTurn` and guarantees no runtime native end, so an input published
before admission would otherwise leave a card open until some unrelated later
native turn closed it. The operator's requirement is
「那几个情况应该直接把卡片置成失败」. `ambiguous` was missing from earlier
revisions: `submitObserved` returns it when `operation()` throws
(`turn-coordinator.ts:175-183`), with the same absence of a turn and a native
end.

**This part is not yet specified, and it is the design's largest remaining
hole.** An earlier revision said "the outcome is known synchronously at the same
call site". It is not: `runtime.submit` returns a Promise and the coordinator
resolves the admission in an async continuation
(`turn-coordinator.ts:168-190`). Since the input is published *before*
`runtime.submit` and the outcome arrives after, the terminal is necessarily a
**second event about the same input** — one kind with two shapes, which the
Feishu switch in the diagram above does not yet reflect. Three things need
deciding before implementation, and they are an operator/design decision rather
than a detail:

- which field on `teammate.input` carries the outcome, and how a consumer tells
  an opening fact from a terminal one;
- whether the terminal repeats the `sourceId` so a Channel can correlate it with
  the input it already filtered;
- whether a terminal still fails the card for an input the Channel filtered out
  as its own.

**The write fence needs nothing.** `enterOrdinaryMutation` runs *before*
`submitAdmitted` (`teammate-service/index.ts:230`) and throws when the entity is
closing, closed, lock-held, or host-stopping. The throw never reaches the
publish site, so no `teammate.input` is published and no card is opened — there
is nothing to terminate. The terminal above is required only for an outcome the
runtime returns *after* the input was published. Adding a card path for the
fence would be defence with no failure scenario.

### Two published kinds, and the boundary is the producer

- **`teammate.input`** — published by **Core**, at admission. Carries `text`,
  `source` and `sourceId`.
- **`teammate.activity`** — published by a **runtime**, through the one sink.
  Carries `assistant.message`, `tool.call` or `turn.ended`, and never a source
  identity.

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
| `enterOrdinaryMutation` call sites | 4 | 3 |
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
gets a terminal fact at the publish site, so the card fails. A drop that happens
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

### 2. Embedded versus reshaped activity payload

`teammate.activity` should embed the neutral `RuntimeActivity` shape after
sanitisation. Today `TeammateTurnToolCallEvent` reshapes into an
`arguments_json` string. If the reshaped form is kept, the "Core invents no
vocabulary" argument falls back to counting kinds.

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
   closure, with the fail-open guard. The terminal fact lands here too, once its
   shape is ruled on.
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
  no open card.** This is the gap an earlier draft claimed was already handled.
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
- **A stale native turn can close a fresh card.** Not introduced here —
  `teammate.native_turn.ended` is already actor-scoped and carries no turn id —
  but the actor-keyed shape makes it easier to hit and it should be tested.
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
