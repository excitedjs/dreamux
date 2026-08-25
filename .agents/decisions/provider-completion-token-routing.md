# Provider completion tokens and core dedup routing

- **Status:** Accepted and implemented
- **Date:** 2026-08-25
- **Affects:** `@excitedjs/dreamux-types`,
  `@excitedjs/agent-runtime-claude-code`, `@excitedjs/agent-runtime-codex`,
  `/packages/dreamux/src/service/completion-router/`,
  `/packages/dreamux/src/service/teammate-service/`, completion delivery
- **Task:** [adopt-completion-token-routing](../tasks/completion-routing/adopt-completion-token-routing/README.md)

## Context

After the interim settlement gate (PR #342), turn settlement was still
expressed per-submission against a single active slot, and completion delivery
still equated one accepted send with one push-back. Two failure classes
remained on real runtimes: folded live-steer sends double-delivered or hung,
and a queued send's second native result could be dropped. `last` also refused
valid native-id cold reads when the optional transcript locator was absent.

## Decision

Push-back count equals the number of logical completions the provider actually
produced, never the number of `send` calls.

- Every accepted send returns a `RuntimeSubmission` handle. The provider
  creates an immutable `RuntimeCompletion` token at each real native result
  boundary and settles the related submissions with it: folded sends share one
  token, queued sends settle as distinct tokens in provider order.
- The token is provider-owned and opaque. Core never parses native ids, never
  compares completion text, never treats an outer Promise reference as
  identity, and never infers fold from the active slot.
- The core `completion-router` delivers at-most-once per
  `(producer, completion token, recipient)` and preserves provider order
  across distinct completions.
- Stop without an observed final result settles submissions as `stopped` with
  zero completions and zero push-backs; stop-triggered acknowledgements are not
  final results.
- Providers report live assistant/tool activity through the submission's
  synchronous activity sink. Transcript/JSONL stays cold history and offline
  recovery only; it is never a settlement source and never back-fills live
  activity after settlement. For `last`, the persisted native session id is the
  minimal locating fact; a missing transcript locator only constrains the path
  when present.
- Turn objects carry no public identifier; the stop-drain error reports only
  the unsettled count and entity name.

## Supersession

This record supersedes the object-turn settlement clause of
[entity-owned-teammate-lifecycle-and-object-turns](entity-owned-teammate-lifecycle-and-object-turns.md):
`RuntimeTurn` is replaced by `RuntimeSubmission` settled with
`RuntimeCompletion` tokens, and the initiating-action delivery closure now
routes through the core `completion-router`. Entity lifecycle ownership,
close single-flight, and the no-Turn-archive rules from that record remain in
force.
