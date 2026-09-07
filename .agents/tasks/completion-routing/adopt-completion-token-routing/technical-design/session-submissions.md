# Resident-session input and per-request settlement

Approved through [ruling R2](../rulings.md#r2-implement-the-replacement).
Baseline: `6acc6d28`, PR #384. This supersedes the request-window retention in
[the preceding solution](final.md); the Core completion-token design survives.

## Why replace the model

The old RPC modeled a group of inputs as one logical turn. PR #344 made each
native result independently observable and introduced a submission handle for
each input, but retained the enclosing command window and its final promise.
Current `ActiveTurn` and `PendingTurn` coordinate opening, steering, drainage,
failure and cleanup of that extra lifetime. Native activity has since moved
outside it, because Claude also works without any Dreamux submission.

Core consumes admission, submission settlement, resident state and native
activity. It has no requirement for that extra window or its completion.
The replacement deletes that lifetime instead of renaming or moving it.

## Facts and owners

- The resident session owns process/transport lifetime and a continuous native
  event stream. Receiving a result is not a reason to stop or replace it.
- Each accepted request owns its eventual settlement. Native UUID evidence and
  lifecycle consumption identify which requests a result answers. Maintain one
  authoritative request association, not coordinated copies in RPC and runtime.
- Each observed native result supplies one immutable completion shared by every
  request it answers. Core continues to choose recipients and deduplicate by
  completion object and recipient. An empty group settles no request.
- Activity and native end events follow the session stream, independently of
  whether there are requests. Display consumers keep their current behavior.

All inputs use one submission path. Writing another message while Claude is
working does not create a second provider-side execution path: the CLI decides
whether it folds the input into its current turn or queues it for later. The
provider observes that decision and settles the affected requests directly.
Native write admission and eventual result settlement remain distinct facts.

## Removal account

Remove the request-window entity, its aggregate completion promise and its
all-commands-terminal/all-results-seen drainage gate. Remove the initial-input
versus steer split and the window queues, readiness promises and aggregate
success/failure cleanup whose purpose is only to maintain that split.

Keep whatever native request evidence is actually required for correct fold,
queue, admission, cancellation and failure handling. A list/set of requests
consumed by the next native result is not another execution window: it cannot
gate the process lifetime or invent a group completion that the CLI did not
produce. Do not replace deleted state with a larger registry, wrapper family,
event bus, per-window manager, or background-origin policy.

## Required behavior and limits

- Requests are registered before writing can synchronously produce events.
  Early acknowledgements/results must not be lost. Admission must distinguish
  a proven rejection before write from an ambiguous write; no automatic retry
  of ambiguous admission is introduced.
- The ordinary input and subsequent inputs obey the same native-write path.
  Preserve prompt ordering and prompt admission while another turn is active.
- Started/consumed requests participate in the next applicable result even
  when its origin or UUID names an internal input. A queued request does not.
  Preserve exact submitted-UUID positive evidence and the supported legacy
  single-input behavior without sole-pending attribution on lifecycle sessions.
- A completed lifecycle event can precede a folded result or follow an ordinary
  result. It must not discard a waiting answer or fabricate a completion.
  Refusal, discard and cancellation affect their actual requests, without
  failing unrelated queued requests or reaping a healthy resident process.
- Canceled native text must not leak into a later empty answer. Handle native
  cancellation/result boundaries based on evidence; do not assume every
  cancelled UUID describes the currently generating turn.
- On actual child exit or explicit stop, settle outstanding requests and report
  the native end through the existing activity contract. Stop fences input and
  converges in-progress admission; late callbacks cannot restart activity.
- Preserve session continuity, state-write fencing, process-group termination
  proof, cold activity reads, structured output, MCP, skill adaptation, runtime
  configuration, Remote Control and existing neutral contracts.
- Preserve the configured idle-failure policy for genuinely stalled outstanding
  work. Do not turn pure background activity into an idle reaper trigger, or
  silently change the timeout default or its user-visible recovery policy.

Protocol complexity is not eliminated by deleting the window. CLI 2.1.263
marks command lifecycle as internal. Existing live captures demonstrate
background turns folding explicit requests while both result UUID echo fields
are absent; origin filtering and UUID-only routing cannot replace consumption
evidence. Missing-start compatibility fixtures are not observations of that
build. Cancellation/Remote Control and exceptional tool-result ordering still
have evidence gaps. Do not claim a universal ordering guarantee or add
speculative compatibility machinery to hide a missing producer contract.

## Implementation and extension boundary

The writer may reshape the affected Claude source and tests into the smallest
coherent implementation. Existing transport, process supervision and unrelated
capabilities need not be rewritten merely for uniformity. Core, the neutral ABI,
other providers and Channel behavior remain outside the code-change boundary.

The Claude-specific exported session seam currently exposes the window through
submitTurn/steerTurn. Replacing that seam is part of the approved removal and
must be accurately documented as a breaking change to custom session factories;
do not retain a compatibility wrapper solely to keep the removed window alive.
Use the existing package's breaking minor release note on the 0.x line.

## Verification and structural acceptance

Review the complete PR against its base, and the replacement against `6acc6d28`.
Report removed concepts and source files, added concepts with their requirement,
and the final source-file count and purpose. A wrapper around the old window is
not completion of this design.

Preserve observable contracts while replacing tests that directly encode the
removed session seam. Cover ordinary sends, fold and queue, pure background,
background plus folded/queued steer, identical text with distinct completions,
early callbacks, both native completed/result orders, cancellation and following
input, failures, stop/admission races, resident reuse and structured output.
Use meaningful deterministic regression tests, not assertions of code shape.

Run the four Rush gates and knowledge validation. The originally planned
independent workflow review was omitted by subsequent
[ruling R3](../rulings.md#r3-publish-the-pr-link-and-omit-the-workflow-review);
TeamLeader whole-diff pre-review remains the review evidence. Replay existing native evidence through the
new owner and validate the real provider/Core path for pure background, folded
steers and queued input. Existing live captures remain evidence of the producer,
not proof that the new implementation passes. Clearly separate replay, fake
transport tests and any new live CLI measurements.
