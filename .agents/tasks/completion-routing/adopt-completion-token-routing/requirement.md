# Requirement

Current implementation requirement: [Resident-session replacement](#resident-session-replacement-2026-09-07).
Earlier deliveries below remain history except for the product behavior retained
explicitly by that section.

## Resident-session replacement (2026-09-07)

The operator approved [the replacement proposal](technical-design/session-submissions.md)
after evaluating the provider as a fresh implementation; see [rulings](rulings.md).
This supersedes the implementation choice to preserve request-window drainage
in the earlier repair, while retaining its background and completion-routing
product requirements.

- Native background work continues independently of Dreamux requests. Its
  activity and native end remain visible, and an unrelated result neither
  answers a queued request nor tears the process down.
- Every accepted request receives its actual answer or an explicit failure or
  stopped settlement. Folded requests share one completion; queued requests
  wait for distinct results. Core keeps its existing recipient and dedup rules.
- Remove the artificial request window, its aggregate drainage and the separate
  initial/steer execution paths. Work is organized around the resident session,
  pending requests and observed native results. No renamed replacement window.
- Preserve cancellation, native write admission, prompt ordering, configured
  idle failure, stop/admission convergence, process supervision, continuity,
  state fencing, structured output, MCP, skills, Remote Control and cold reads.
- Change only Claude input/settlement implementation and associated tests and
  documentation. The exported Claude session seam may change to remove the
  window; record that breaking extension change. Core and the neutral runtime
  ABI do not change.
- Judge the result by deleted concepts and preserved capabilities, then
  deterministic and real-provider verification, the four Rush gates and
  knowledge closeout. The operator subsequently omitted the workflow review
  in [ruling R3](rulings.md#r3-publish-the-pr-link-and-omit-the-workflow-review);
  TeamLeader whole-diff pre-review remains recorded. The existing PR remains the
  delivery surface. Do not poll TeamMate results.

## Initial request

Rework turn settlement and completion delivery on top of `next` (head
`f71cfc3c`, PR #342) so that push-back semantics follow the results providers
actually produce, and deliver the rework as one PR.

## Confirmed current behavior

- PR #342 gates claude-code settlement on command-lifecycle terminality and
  parses top-level `command_lifecycle` envelopes. It is an interim model: turn
  settlement is still expressed per-submission against a single active slot, and
  completion delivery still equates one accepted send with one push-back.
- Two failure classes remain (reproduced on real runtimes, not fakes):
  1. Steer/fold: multiple sends folded by the CLI into one native result must
     produce exactly one push-back; per-send settlement double-delivers or hangs.
  2. Queue: a send that the CLI queues behind a running turn produces a second
     native result; slot-based settlement can drop it (observed: a long
     generation plus an immediate short send delivered only the short result).
- `last` availability for native transcript reads is gated too early on
  transcript locator presence, so a valid native id cold read can be refused.

## Desired outcome

Push-back count equals the number of logical completions the provider actually
produced, never the number of `send` calls:

- Folded sends share one immutable completion token and produce one push-back
  per recipient; queued sends produce distinct tokens pushed in provider order.
- Identical completion text is never deduplicated; duplicate terminal
  notifications for one completion never deliver twice.
- Close before an observed final result settles submissions as `stopped` with
  zero completions and zero push-backs.
- Transcript/JSONL is cold history only; its absence or corruption never changes
  completion count, order, or delivery.
- The claude-code `Last` completion boundary correctly identifies terminal
  results.

## Scope

- `@excitedjs/dreamux-types`: runtime contract — `RuntimeSubmission` handle,
  provider-owned `RuntimeCompletion` token, live activity sink.
- `@excitedjs/dreamux` core: new `completion-router` service (at-most-once,
  ordered, keyed by producer + completion token + recipient) and
  teammate-service wiring.
- `@excitedjs/agent-runtime-claude-code`: rpc/runtime/stream settlement rewrite
  onto the token model; `transcript/completion.ts` Last-boundary fix.
- `@excitedjs/agent-runtime-codex`: turn-manager adoption of the same contract.

## Non-goals

- No channel-facing turn telemetry events (`turn.message` / `turn.tool_call`
  channel surface) in this task; the runtime-side activity sink lands with the
  contract, its channel projection is a separate task.
- No provider beyond claude-code and codex.
- No web or platform surfaces.

## Constraints and invariants

- The approved architecture in the final solution is settled; implement it as
  recorded rather than redesigning during development.
- Provider ABI change is breaking for provider authors; the Rush change files
  must carry the breaking note.
- Public-repository safeguards apply to every committed artifact: no internal
  identifiers, hostnames, or channel ids.

## Acceptance criteria

- Fold: two sends, one provider result, exactly one push-back containing the
  folded outcome.
- Queue: two sends, two provider results, two push-backs in provider order —
  including when both results have identical text.
- Duplicate settle of one completion delivers once.
- A completion that resolves before its admission continuation is neither lost
  nor duplicated.
- Close/dissolve with turns still running: zero push-backs for unfinished
  submissions; each reaches a unique internal terminal state.
- Transcript missing/corrupt/unreadable does not affect delivery.
- Last-boundary: terminal-result recognition covers folded and queued endings.
- Build, lint, and the retained deterministic suite pass; deleted-coverage areas
  are re-covered by the batch test stage before PR.

## Operator decisions

- 2026-08-25: The recorded architecture is final; implement it directly with no
  further solution consultation (simplest path).
- 2026-08-25: Prescribed process — (1) create task record; (2) delete the unit
  tests invalidated by the settlement-model rework; (3) one codex developer
  writes code only, no unit tests; (4) two independent reviewers (one fable,
  one codex) check the implementation against the approved architecture; (5)
  batch re-cover unit tests with a multi-agent workflow, all nodes on sonnet;
  (6) open the PR.

## Background-turn repair (2026-09-07)

This approved repair supersedes the assumption that every native result must
belong to an explicit submission. Earlier task scope and delivery describe the
original implementation; current activity and stopped-outcome behavior follow
the current public contract, not the historical clauses above.

### Required behavior

- Claude may keep background tasks alive after a requested turn ends. Their
  completion may start native follow-up turns without a Dreamux submission.
- A native result with no related submission must not trigger process teardown
  or an automatic completion delivery to a parent agent. Its activity and native
  turn end remain observable through the existing activity sink.
- A request steered into such a turn must receive its result when it actually
  joins that turn. A background origin must never veto this settlement.
- A merely queued request waits for its own native result. It must not be
  settled by an earlier background result merely because it is the only pending
  request. Folded requests share a completion token; queued results remain
  distinct and ordered, including identical text.
- Preserve interruption, genuine transport failure, admission, existing supported
  single-input behavior, and continued use of the resident session.

### Approved scope and acceptance

Repair the Claude provider without adding an origin-based delivery policy, a
background-task registry, a neutral runtime ABI change, or Core routing changes. Keep
activity independent of request tracking. Validate background-only, background
plus started steer, background plus queued steer, multiple folded steers,
interruption and subsequent input. Use native protocol evidence and meaningful
regression tests; pass Rush build, lint, test, and typecheck:tests. Report exact
source-file count and each file's purpose after opening the PR.

### Confirmed evidence and limits

The installed adapter's isolated protocol replay reproduced both an erroneous
reap request for a started steer whose result names an internal UUID, and early
settlement of a merely queued sole request. No real child was killed in that
replay. Native ordering and repaired-provider/Core delivery were subsequently
validated on Claude Code 2.1.263 for pure background, folded steers and queued
steers; see [verification](verification.md#repaired-provider-pre-review).
Initial inputs in those raw traces emitted started before init. Compatibility
coverage without started must not be described as that probe's native behavior.

### Operator wording retained for scope

The original Chinese wording is quoted to avoid widening the ruling:

> teammate 允许有自己的后台任务，并在任务结束后拉起新 turn，新 turn 的 result 也不允许推送给 teamleader 或者 dispatcher

The operator then added the required mixed-input case:

> 当前 turn 是 后台任务拉起的，但是我在 turn 中间去 steer 他，最终还是要正确回推的。

Together these require no automatic parent delivery for unbound native work and
normal completion delivery for explicit requests that join it. They do not make
background origin a permanent exclusion from settlement.

### Authorized style and redundancy cleanup

After the complexity review, the operator requested immediate cleanup of code
style and redundancy in this repair. Remove dead internal bookkeeping and
redundant argument passing, and make ordinary test fixtures reflect observed
producer behavior while retaining clearly identified compatibility coverage.
Apply the same criterion throughout the affected path, rather than stopping at
the review's named examples. Preserve the repair's user-visible behavior and
public protocol observation capabilities; removing a supported callback is a
compatibility decision rather than a style-only edit.
