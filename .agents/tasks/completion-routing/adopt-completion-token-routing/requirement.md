# Requirement

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
