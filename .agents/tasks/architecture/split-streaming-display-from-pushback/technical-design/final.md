# Technical Design: Split Streaming Display From Push-Back

## Status and working authority

- **Status:** proposed. No implementation approval has been given.
- **Requirement:** [requirement.md](../requirement.md), including the operator
  rulings recorded there.
- **Analysis this rests on:** [analysis.md](../analysis.md) — what Core could
  delete without display (Q1), what COT cost the push-back mechanism (Q1b), and
  the design (Q2).
- **Review record:** [review-corrections.md](../review-corrections.md) — two
  independent reviews on 2026-09-02 and what they changed.
- **Product model that stays in force:**
  [feishu-cot-conversation-cards](../../../channel/feishu-cot-conversation-cards/README.md).

## The problem, in one sentence

Two flows share one identity that belongs to only one of them: **display is
keyed on `RuntimeSubmission`**, which is the push-back mechanism's key, so every
display need has been paid for with a mechanism that compensates for the
mismatch.

## The two flows today

### A. Push-back — where an answer goes

This is the mechanism that carries a completed turn back to whoever asked for
it. It is correctness, not presentation, and it is **not** what this task
changes.

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
runtime.submit({ text })                   (:259)     the seam: text and nothing else
  │
  ▼
provider admission ──▶ RuntimeSubmission
  │
  ▼
EntityTurnCoordinator.submitRuntimeTurn ──▶ EntityTurn
  │
  ▼
RuntimeSubmission.settled  ──▶  TurnOutcome           completed | failed | stopped
  │
  ▼
EntityTurn.ensureDelivery()                           (turn-recording.ts:165)
  │
  │  ── no initiator ──▶ nothing is delivered anywhere. END.
  ▼
CompletionDeliveryPolicy.deliverRuntime               (completion-router:97)
  │  folds by completion token, orders per recipient
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

**There are two `runtime.submit` call sites, not one.** The second is the
completion re-entry, and it matters for display: see below.

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
        DispatcherCoreEvents.publish ──▶ sealChannelCoreEvent   (7-kind allowlist)
                        │                 an unlisted kind is DROPPED here,
                        │                 silently — the set is ReadonlySet<string>
                        ▼                 and is not checked against the union
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
shows a TeamMate's answer arriving.

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

**Display is attributed to the Agent. Core publishes the input fact.**

```
BOTH submit sites publish the input fact — this is the part review corrected

TeammateService.submitAdmitted (:246)      TeammateService.submitPreparedCompletion (:434)
  │  AdmissionLedger.admit(key, sourceId)    │
  │                                          │
  │  inside the admission closure,           │  same, with
  │  immediately before the submit call:     │  source = COMPLETION_SOURCE
  │                                          │  sourceId = none
  ├──▶ projectInput(agent, {text, source, sourceId})   ◀── NEW, from the ORIGINAL body
  │                                          │
  ▼                                          ▼
runtime.submit({ text })                   runtime.submit({ text })
        ◀── seam unchanged: still { text } only, on both paths


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
ChannelCoreEvent  teammate.activity                 ◀── 1 kind, replacing 4
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

**Both submit sites, not one.** `attachSubmission` calls `projectSubmitted`
unconditionally today, so the completion re-entry is displayed: that is how a
TeamLeader's card shows a TeamMate's answer arriving. Publishing the input at
only `submitAdmitted` would have deleted that silently. Found on review; the
design now names both sites, and this is behaviour preservation, not a
requirement change.

**Why two sites and not one, and why `submitAdmitted` rather than
`submitInput`.** Three facts, all in `teammate-service/index.ts`:

- `submitInput` is *not* the only door to `submitAdmitted`. The locked Workflow
  path calls `submitAdmitted` directly (`:422`), because the ordinary-mutation
  fence `submitInput` applies would refuse it. Publishing at `submitInput` would
  silently drop Workflow submissions from display.
- `submitPreparedCompletion` bypasses both **on purpose**, and its docstring
  gives the reason: an ordinary input materializes or reopens its target, while
  a completion pushback is only meaningful to an already-live runtime — a
  stopped recipient reports `unsupported` rather than silently waking an agent
  nobody asked to wake. That is a real difference, so merging the two paths to
  get one publish site would be the wrong fix. (The source docstring adds "so
  the completion router can fall back"; that clause is false and is corrected
  below — the router drops. The conclusion it supports still holds.)
- **Two docstrings in this file contradict each other**, and that contradiction
  is what made the second site easy to miss. `submitInput` is titled "The one
  admitted-input operation" and lists "a completion pushback" among the
  submissions that "reserve the duplicate key"; `submitPreparedCompletion` says
  "Deliberately not routed through `submitInput`" and reserves no key. The
  completion path is correct and the `submitInput` docstring is wrong. **Fix the
  docstring in this change** — a comment that misstates the call graph is how the
  next person repeats this mistake.

**The fail-open guard moves with the call.** `projectDisplay` /
`projectActorDisplay` / `warnProjectionFailure` are what make display fail-open
today (`turn-coordinator.ts:239`). They are deleted from the coordinator, so the
same guard must exist at both new call sites. This is not optional politeness:
`projectInput` runs **inside the admission ledger closure**, so an uncaught
throw would reject the admission and run `releaseUncommitted` — display
affecting admission, which the requirement forbids outright.

**Placement is exact.** `projectInput` goes inside the `operation()` closure
`submitRuntimeTurn` invokes, not before it. `submitRuntimeTurn` can return
`stopped` before ever calling `operation()` (`turn-coordinator.ts:125`), and
publishing outside would announce an input that never reached a runtime.

**A non-`submitted` outcome must terminate the card at the same site.** A
`stopped`, `skipped` or pre-admission `failed` result creates no `EntityTurn`
and guarantees no runtime native end, so an input published before admission
would otherwise leave a card open until some unrelated later native turn closed
it. The operator's requirement is 「那几个情况应该直接把卡片置成失败」. The
outcome is known synchronously at the same call site, so the same site publishes
the terminal — one more fact on `teammate.input`, not a new mechanism. An
earlier revision claimed the card "already handles" this; review refuted that
and it was wrong.

**The write fence is upstream of the publish site, and needs nothing.**
`submitInput` calls `enterOrdinaryMutation('submission')` before
`submitAdmitted` (`teammate-service/index.ts:230`), and that fence throws when
the entity is closing/closed, holds a Workflow lock token, or is being stopped
by the host. The throw never reaches `submitRuntimeTurn`, so no
`teammate.input` is published and no card is opened — there is nothing to
terminate. The terminal above is required only for an outcome the runtime
returns *after* the input was published. Adding a card path for the fence would
be defense with no failure scenario.

The fence does expose an existing asymmetry this change does not touch: the
same "not writable" fact surfaces as a structured
`{ status: 'unsupported', reason: 'teammate is not writable' }` on the
completion paths (`prepareCompletion`, `submitPreparedCompletion`, which catch
it) and as a bare throw on `submitInput` and `activate`, which do not. Recorded
as an observation, not a change: no caller in this task's scope reads it.

Two published kinds, not one, and the boundary between them is the producer:

- **`teammate.input`** — published by **Core**, at admission. Carries `text`,
  `source` and `sourceId`.
- **`teammate.activity`** — published by a **runtime**, through the one sink.
  Carries `assistant.message`, `tool.call` or `turn.ended`, and never a source
  identity.

Folding them into one kind with a four-valued discriminant was the first
version of this design. It buys a smaller kind count and pays for it by hiding a
real layer boundary and by putting two fields in the union that are meaningless
for three of its four members. The whitepaper is explicit that collapsing N
things into one N-valued discriminant is not a boundary reduction, so there was
nothing to buy. The Channel also treats them differently in kind: it **filters**
on input and **renders** activity.

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
submission**: the runtime has not been asked to do anything, so nothing it emits
can precede the input. Verified — between the two points there is only a
synchronous active check, `capture`, and the call itself, with no `await`.

It does not order a *different* submission's facts, and one of those matters. A
native turn already running can end after the new input is published, and
`turn.ended` closes the current actor card. That hazard exists today for the
same reason — `teammate.native_turn.ended` is already actor-scoped and carries
no turn id — so this design neither introduces nor fixes it. It is named here so
the next person does not discover it and assume it is new.

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
| Input publish sites | 1 (implicit, via `attachSubmission`) | 2 (both submit sites, explicit) |
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
kind can be added to `ChannelCoreEvent` and silently dropped at the bus. This
change adds two kinds and removes four, so it walks straight through that hole.
The fix is a type, not a test:

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

**2. Three docstrings that are wrong rather than merely stale.**

- `teammate-service/index.ts:68-82` carries two stacked `/** */` blocks on
  `hostStop`. TypeScript associates only the last, so the first is dead text
  that still reads as authoritative. Delete it.
- `submitInput`'s docstring lists "a completion pushback" among the inputs that
  "reserve the duplicate key", while `submitPreparedCompletion`'s says it is
  "deliberately not routed through `submitInput`" and it reserves no key. They
  contradict each other, and that contradiction is what hid the second
  `runtime.submit` site from the first draft of this design. Fix both to say
  which path a completion actually takes.
- `submitPreparedCompletion`'s docstring says a stopped recipient reports
  `unsupported` "so the completion router can fall back". **There is no
  fallback.** `CompletionDeliveryPolicy` is handed exactly one recipient — the
  `initiator` its caller passed — and never chooses among targets; on
  `unsupported` it writes `dropping completion: delivery unsupported` and
  returns (`completion-router/index.ts:197-207`). The docstring's conclusion is
  right and its stated mechanism is invented. Rewrite it to say the completion
  is dropped, and that dropping is preferred to waking an agent nobody asked to
  wake.

### Investigated, does not reduce

**`phase` stays a three-valued enum.** It looks like the repo's own named
anti-pattern — `service/CLAUDE.md`: "The operation is the fence… Do not add a
boolean beside a task, or a phase enum beside either" — and `hostStop` sits
directly beside it in the correct nullable-promise form. Both obvious collapses
lose information:

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
  at `index.ts:470` (`phase === 'active' && identity.status === 'closed' &&
  hasNoRuntimeAuthority()`) exists to read.

So the enum is carrying three distinct facts and is paid for. Recorded here so
the next reader does not re-derive it.

### Ruled separately: `teammate.turn.settled` goes

Deleting the unread kind was gated on whether the flowx superset repo still
reads it. The operator closed that gate the same day —
「没人读的 teammate.turn.settled 直接删掉吧，flowx 到时候再想办法」 — accepting
the cross-repo cost rather than waiting on it. Confirmed before acting: no
production consumer exists in this repo. Producers are
`conversation-projection.ts:269`, the `seal.ts` allowlist, and the
`turn-coordinator.ts:218` settlement hook; every other reference is a test, a
type re-export, or a comment recording that the Feishu adapter deliberately does
not consume it.

### The change files this needs

Not previously stated anywhere in this design, and it is an upgrade blocker for
a consumer outside this repo, so it belongs here rather than in the
implementation PR's memory.

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

## Known gap this change does not close: a dropped completion is invisible

Not a defect introduced here, and not fixed here — recorded because it is the
sharpest case of the two lines this task separates diverging, and because the
design cites the push-back path's outcomes.

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
recipient to try. The gap is visibility, not policy. The recipient is a single
`initiator` object, so "unreachable" has no alternative; and the human watching
the COT card sees the TeamMate's turn end normally while the asking Agent never
learns the answer arrived. Nothing in the display line says a hand-off was lost.

This change makes that divergence *legible* rather than fixing it: after the
split, the display line carries the TeamMate's own facts and the push-back line
carries delivery, so the two can be reasoned about separately. Making a dropped
completion user-visible is a product decision and needs its own ruling.

**The router's deadline bounds the router, not the entity.** Worth stating
because it is easy to read the 30-second `settleWithinDeadline` as a general
safety net, and it is not. `prepareCompletion` holds
`enterOrdinaryMutation('completion preparation')` across
`await runtimeOwner.existingRuntimeAfterStart()`, which is
`await this.starting` (`runtime-owner.ts:90-93`). If a provider start never
settles, that await never returns, so the `finally { leave() }` never runs and
the fence stays held. `settleWithinDeadline` does not help: on timeout it
abandons its own await and returns, and its own comment says the operation "may
reject much later" — the underlying promise keeps running.

`close()` does not rescue it either. `transitionToClosed` calls
`runtimeOwner.stopRuntime()` first, and that joins the same promise
(`await this.starting?.catch(...)`, `runtime-owner.ts:149`) rather than
cancelling it, so it blocks on the identical await before ever reaching
`waitForOrdinaryMutations()`.

So a hung provider start is unbounded in this path, and the held fence is a
second way for it to surface rather than an independent defect. The root cause
is that nothing bounds a provider start here. Pre-existing, out of scope for
this change, and recorded so the deadline is not mistaken for coverage it does
not provide.

## Open, and it reshapes this design: should the completion path merge into `submitInput`?

Raised by the operator 2026-09-02 (「submitPreparedCompletion 这个玩意完全是我预期外的，
他为什么不去调用 submitInput 呢？」). Not ruled. Recorded here rather than in a
chat log because the answer changes this design's most awkward property.

`submitPreparedCompletion`'s docstring gives two reasons it is not routed
through `submitInput`. Checked against source, **one is false and the other is
narrower than stated.**

- *"reserves no duplicate key."* Free, not earned. `admission-ledger.ts:74`:
  `if (sourceId === undefined || sourceId === '') return operation();` — an
  omitted source id bypasses the ledger entirely, and a completion has no source
  id. Any call through `submitInput` without a `sourceId` already reserves
  nothing. This reason does not survive.
- *"only meaningful to a runtime that is already live."* The real difference,
  and the only one: `submitAdmitted` calls `runtimeOwner.ensureStarted()`, which
  boots a dormant recipient; `submitPreparedCompletion` calls
  `existingRuntimeAfterStart()`, which does not. But `prepareCompletion` **already
  asks that question** and answers it with
  `unsupportedPreparedCompletion('teammate runtime not running')`. So the second
  check's unique coverage is exactly one window: the recipient was live at
  prepare and lost its runtime before submit — a window that spans the router's
  retry loop and nothing else.

The third apparent difference, the `CompletionDeliveryResult` vocabulary, is a
translation that already exists (`turnAdmissionToCompletionDelivery`, called by
the coordinator's `submitCompletion`). On the happy path the two are identical:
`ensureStarted()` on a live runtime is `if (this.runtime !== null) return;`
after a scope assertion (`runtime-owner.ts:79-88`).

### Why it matters here

This design's most awkward claim is "there is no single point both paths pass
through, so two publish sites are the structural floor." **That claim depends on
this split.** If the paths merge, the floor is one publish site, fence sites go
from four to three, and the coordinator loses `submitCompletion`.

### The fork, unruled

- **Thread a flag** (`submitInput({ …, start: false })` or equivalent). Behavior
  is preserved exactly; `submitPreparedCompletion`, `submitCompletion`, and one
  publish site are deleted. The cost is stated plainly: `submitInput`'s docstring
  says "There is no per-source wrapper and no caller-selected mode, because there
  is no per-source behavior left to select." That claim is **already false** —
  the mode exists today as a parallel private method the type system does not
  relate to the first. A flag makes an existing mode visible rather than adding
  one.
- **Plain merge**, no flag. Liveness stays answered once, at prepare. Behavior
  changes only inside the prepare→submit window: a recipient that dies there
  would be restarted to receive the answer instead of the answer being dropped.
  That is a requirement decision about whether an arriving answer may wake an
  agent, and it is the operator's call, not a refactor.

Prepare/submit staying split (fence sites 3 and 4 in the earlier count) is
**not** in question either way: preparation renders and may spill the body to
disk and is deliberately done once, while submit is the retried unit.

## Unresolved: the activity-fact dedupe

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

## Implementation sequence

The first draft's numbered order was refuted by both reviews: steps called
projection entry points that a later step created, and one step could not
compile at all. Corrected order:

1. **`dreamux-types` + `seal.ts` together.** Add the `turn.ended` activity kind,
   `occurredAt` on `RuntimeActivity`, and the `teammate.input` /
   `teammate.activity` events; add both to `KINDS`; update the two tests that
   assert an exact kind list (`core-event-catalog.test.ts:176`,
   `input-source-lifecycle.test.ts:468`) to the transitional set. Old surfaces
   stay alive.
2. **`conversation-projection`: add `projectInput` and the new
   `projectActivity`** alongside the existing four. Additive only.
3. **Core: publish `teammate.input`** at both submit sites, inside the operation
   closure, with the fail-open guard and the non-`submitted` terminal.
4. **`runtime-owner`: stamp the actor, carry the guard, call the projection.**
5. **Both runtimes: emit native turn ends through the activity sink.** After
   step 2, because before it the old `projectActivity` routes any non-message
   kind into `toolEvent`, which throws on `turn.ended` and logs a warning per
   end.
6. **Feishu: three-case switch**, re-keyed anchor.
7. **Delete.** The second sink, `turnsBySubmission`, the early buffer, the old
   entry points, the five old kinds, the retained `EntityTurn` fields, codex's
   `pendingActivity`, and the transitional test assertions.
8. **Knowledge delta:** `provider-runtime.md`, `channel.md`.

Step 7 is not one atom. `teammate.turn.settled`, `{ priority: 'now' }` and
codex's `nativeTurnEnded` are independent of the rest and can land separately —
the first draft said the whole step must land whole, which overstated it. What
is genuinely atomic is the set of the second sink, `turnsBySubmission`, the
early buffer, the old entry points, the old kinds and the `EntityTurn` fields.

## Verification

- The locked COT product model is the acceptance test: one recipient, one
  anchor, at most one open card, closed by the runtime's own native end.
- **A TeamLeader delegating to a TeamMate must still show the answer arriving.**
  That is the behaviour the missing second publish site would have deleted, and
  it is the one regression a card-shaped test would not obviously catch.
- **A submission that is stopped, skipped, or fails before admission must leave
  no open card.** This is the gap the first draft claimed was already handled.
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
  The second version. Rejected by the operator on 2026-09-02 in favour of
  splitting by producer, which is the better boundary: Core publishes the input,
  a runtime publishes the rest.
- **Keeping the early buffer and re-keying it by actor.** That is the banned
  fake — a mechanism surviving under a new name while nothing is removed.

## Known risks

- **The dedupe is unresolved.** See above. It blocks one deletion, not the
  design.
- **A stale native turn can close a fresh card.** A native turn already running
  can end after a new input is published, and `turn.ended` closes the current
  actor card. This is not introduced here — `teammate.native_turn.ended` is
  already actor-scoped and carries no turn id — but the actor-keyed shape makes
  it easier to hit and it should be tested, not rediscovered.
- **`teammate.turn.settled` and `teammate.state` are published surfaces with no
  in-repo reader.** Removing the first is proposed; an out-of-tree Channel
  provider could consume either. flowx ports these PRs and is the other
  stakeholder.
- **The cold-read vocabulary is untouched.** `AgentActivityRecord` (`last`) and
  `RuntimeActivity` (push) remain two vocabularies for one subject. The
  operator's framing was "one `Activity` namespace"; this design answers the
  push half only. Convergence is a separate decision, not an oversight to fix
  quietly.
- **codex's `unboundObservedTurnIds` and `dropOrphanActivityIfIdle` are not
  purely display.** They also drive `collector.releaseTurn` memory release under
  `retainAfterTerminal: true`. The reduced form must keep observing unbound turn
  ids, holding them across in-flight admissions, removing on bind or terminal,
  and releasing when idle. Only `pendingActivity`'s storage and cleanup go.

## Completion condition

The design is complete when a maintainer can explain the display path without
mentioning a submission, and `turn-coordinator.ts` contains no display code.
