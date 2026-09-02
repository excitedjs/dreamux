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
  stopped recipient must report `unsupported` so the router can fall back rather
  than silently waking an agent nobody asked to wake. That is a real difference,
  so merging the two paths to get one publish site would be the wrong fix.
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
