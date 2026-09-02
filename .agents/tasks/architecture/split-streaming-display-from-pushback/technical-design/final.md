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
Feishu inbound / cron / task push / MCP `team.submit`
  │
  ▼
TeammateService.submitAdmitted                        (teammate-service/index.ts)
  │  renderSubmission(input) ──▶ text = XML envelope
  │  AdmissionLedger.admit(key, sourceId)             dedupe happens HERE, in Core
  ▼
runtime.submit({ text })                              the seam: text and nothing else
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
EntityTurn.ensureDelivery()
  │
  ▼
CompletionDeliveryPolicy.deliverRuntime               (completion-router)
  │  folds by completion token, orders per recipient
  ▼
initiator.prepareCompletion(fact).submit()
  │
  ▼
◀── the answer re-enters the ASKING Agent's runtime as a new turn
```

The loop closes at another Agent's runtime, not at Feishu. A TeamLeader that
asked a TeamMate for work receives the answer as an input into its own runtime.

### B. COT rendering — what a human watches

This is display. It hangs off flow A at three points and needs a fourth path
because one of its facts does not fit.

```
runtime stream (claude stream-json / codex thread items)
  │
  ├─────────────────────────────┐
  ▼                             ▼
RuntimeActivity            RuntimeNativeTurnEnd       TWO sinks, because a native
{assistant.message,        {completed|failed|          turn end belongs to no
 tool.call}                 interrupted}               single submission
  │                             │
  ▼                             ▼
runtime-owner.generationActivitySink   .generationNativeTurnSink
  │  generation fence            │  generation fence
  ▼                             ▼
EntityTurnCoordinator          EntityTurnCoordinator
 .activitySink                  .nativeTurnSink
  │                             │
  │ turnsBySubmission.get(event.submission)            ◀── the borrowed key
  │   ├─ found    ──▶ projectDisplay
  │   └─ missing  ──▶ earlyActivity buffer (cap 512)   ◀── because activity can
  │                    replayed when the turn appears      beat its own submission
  ▼                             ▼
ConversationProjection      ConversationProjection
 .projectActivity            .projectNativeTurnEnd     ◀── 4 entry points total
 .projectSubmitted                                         (+ projectSettled)
 .projectSettled
  │
  │  redactText() + size bounds + per-submission dedupe
  ▼
ChannelCoreEvent  ×5 kinds
  teammate.turn.submitted / .settled / .message / .tool_call
  teammate.native_turn.ended
  │
  ▼
sealChannelCoreEvent (7-kind allowlist)               (dispatcher-core-events)
  │
  ▼
feishu-cot-session.handle  ──▶ 5-case switch
  │
  ▼
feishu-cot-adapter ──▶ feishu-cot-state ──▶ outbox ──▶ Feishu card
```

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
Feishu inbound / cron / task push / MCP `team.submit`
  │
  ▼
TeammateService.submitAdmitted
  │  AdmissionLedger.admit(key, sourceId)
  │
  ├──▶ projectActivity(agent, {kind:'input', text, source, sourceId})   ◀── NEW
  │      published from the ORIGINAL body, before the runtime is called
  ▼
runtime.submit({ text })          ◀── seam unchanged: still { text } only
  │
  ▼
[ flow A continues exactly as before — settled, delivery, completion-router ]


runtime stream
  │
  ▼
RuntimeActivity {input? no — Core owns that | assistant.message | tool.call | turn.ended}
  │                                                    ONE sink
  ▼
runtime-owner.generationActivitySink
  │  generation fence + stamps the Agent            ◀── attribution lives here
  ▼
ConversationProjection.projectActivity(agent, activity)   ◀── ONE entry point
  │  redactText() + size bounds
  ▼
ChannelCoreEvent  teammate.activity                 ◀── 1 kind, not 5
  │
  ▼
sealChannelCoreEvent (3-kind allowlist)
  │
  ▼
feishu-cot-session.handle ──▶ 1 case ──▶ adapter ──▶ state ──▶ card
```

Publishing the input **before** `runtime.submit` is what removes the ordering
race by construction: the runtime has not been asked to do anything, so nothing
it emits can precede the input.

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
| Core event kinds | 7 | 3 |
| Projection entry points | 4 | 1 |
| Display key | `RuntimeSubmission` | the Agent |
| `AgentRuntimeSubmissionInput` | `{ text }` | `{ text }` — unchanged |

## Implementation sequence

1. `dreamux-types`: add the `turn.ended` activity kind and the
   `teammate.activity` core event; keep the old surfaces alive.
2. Both runtimes: emit native turn ends through the activity sink.
3. `runtime-owner`: stamp the Agent, call the projection directly.
4. Core: publish the `input` activity in `submitAdmitted`.
5. `conversation-projection`: collapse to one entry point.
6. Feishu: collapse the switch, re-key the anchor.
7. Delete: the second sink, `turnsBySubmission`, the early buffer, the dedupe,
   codex's `pendingActivity` and `nativeTurnEnded`, the five old core event
   kinds, the retained `EntityTurn` fields, and `{ priority: 'now' }`.
8. Knowledge delta: `provider-runtime.md`, `channel.md`.

Steps 1–6 keep the tree green at every step; step 7 is the one that must land
whole.

## Verification

- The locked COT product model is the acceptance test: one recipient, one
  anchor, at most one open card, closed by the runtime's own native end.
- A live probe on both runtimes, since the 2026-09-02 probe is what settled the
  current semantics and this changes where facts enter.
- `cot-projection-privacy.test.ts` must keep passing on redaction and bounds
  with the dedupe assertions removed — the dedupe goes, and rewriting that
  assertion to keep it alive under a new key is exactly what this design says
  not to do.

## Rejected alternatives

- **Verbatim provider pass-through.** Rejected before this design: it would put
  claude's stream-json and codex's thread-item shapes into Core and every
  Channel — the coupling #350 removed.
- **A caller-supplied id on `AgentRuntimeSubmissionInput`.** The first version of
  this design. Rejected on review: it shows the envelope and reverses a recorded
  ruling.
- **Keeping the early buffer and re-keying it by actor.** That is the banned
  fake — a mechanism surviving under a new name while nothing is removed.

## Known risks

- **`teammate.turn.settled` and `teammate.state` are published surfaces with no
  in-repo reader.** Removing the first is proposed; an out-of-tree Channel
  provider could consume either. flowx ports these PRs and is the other
  stakeholder.
- **The cold-read vocabulary is untouched.** `AgentActivityRecord` (`last`) and
  `RuntimeActivity` (push) remain two vocabularies for one subject. The
  operator's framing was "one `Activity` namespace"; this design answers the
  push half only. Convergence is a separate decision, not an oversight to fix
  quietly.

## Completion condition

The design is complete when a maintainer can explain the display path without
mentioning a submission, and `turn-coordinator.ts` contains no display code.
