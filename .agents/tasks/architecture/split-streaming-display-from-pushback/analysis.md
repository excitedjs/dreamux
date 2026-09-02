# Analysis

Answers to the questions in [requirement.md](requirement.md). Question 1 is
answered; question 2 is in progress.

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

## 2. What display would be if designed from scratch

In progress. The settled direction is recorded in
[requirement.md](requirement.md#settled-design-direction); this section will
state the design against it, with what each part deletes.
