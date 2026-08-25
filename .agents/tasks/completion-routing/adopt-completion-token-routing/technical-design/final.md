# Final solution: provider completion token + core dedup routing

## Model

Separate three concepts the interim model conflated:

- **send/submission** — one call and its admission result. Answers "was it
  accepted"; never decides push-back cardinality.
- **logical completion** — one result the provider actually produced. The unit
  of push-back dedup.
- **native/display turn id** — diagnostic only; never a completion identity
  unless proven equivalent.

Every accepted send returns a `RuntimeSubmission` handle. The provider creates
an immutable `RuntimeCompletion` token at each real native result boundary and
settles the related submissions with it:

```text
steer/fold: send A + send B -> one RuntimeCompletion C1 -> push once/recipient
queue:      send A + send B -> RuntimeCompletion C1, C2  -> push twice in order
```

The token is a provider-owned opaque object. Core never parses native ids,
never compares completion text, never treats an outer Promise reference as
identity, and never infers fold from the active slot. Identity is created only
at result time, which naturally supports late fold: folded sends resolve to the
same token, queued sends to distinct tokens, with no provisional keys, fold
notices, or key migration.

## Ownership

- **Provider** (claude-code, codex): interprets the native protocol, decides
  steer/fold vs queue from real native result boundaries, produces completion
  tokens in native order, reports assistant/tool activity from the live native
  event stream through the submission handle's synchronous activity sink. A stop
  without an observed final result settles internally as `stopped` and never
  fabricates a completion.
- **Core `completion-router`**: records completion-to-recipient relations and
  delivers at-most-once per `(producer, completion token, recipient)`,
  preserving provider order across distinct completions. Admission, activity,
  completion delivery, and close reconciliation are separate concerns; no
  display or cold-read failure may change completion correctness.
- **Transcript/JSONL**: explicit cold history and offline recovery only. Never a
  settlement source; never used to reconstruct live activity after settlement.
  For `last`, the persisted native session/thread id is the minimal locating
  fact; a missing transcript locator must not pre-emptively refuse a native-id
  cold read (the locator constrains the path only when present).

## Forbidden derivations

- "Every accepted send pushes once" (double-delivers folded results).
- "All sends during one activity share one push" (swallows queued results).
- Dedup by result text (two distinct results may match exactly).
- Core-side fold guessing (core cannot see native result boundaries).
- Outer Promise reference as public identity (wrapping changes references; fold
  may only be confirmable at result time).
- Transcript-driven settlement or post-settlement transcript back-fill of live
  activity.

## Implementation surface

| Path | Content |
| --- | --- |
| `packages/dreamux-types/src/agent-runtime.ts`, `turn.ts` | `RuntimeSubmission` / `RuntimeCompletion` contract, activity sink |
| `packages/dreamux/src/service/completion-router/` | at-most-once ordered delivery keyed by producer + token + recipient |
| `packages/dreamux/src/service/teammate-service/` | turn recording and coordination on the token model |
| `packages/agent-runtime/claude-code/src/{rpc,runtime,stream,types,provider}.ts` | settlement rewrite onto tokens; top-level `command_lifecycle` handling retained |
| `packages/agent-runtime/claude-code/src/transcript/completion.ts` | Last completion boundary fix |
| `packages/agent-runtime/codex/src/turn-manager.ts` (and adjacent) | token adoption for codex |

Out of scope: any provider other than claude-code/codex, web/platform surfaces,
and channel-facing turn telemetry projection (separate task). The core-side
activity sink is a type-safe no-op receiver until that task lands.

## Verification plan

Unit tests invalidated by the settlement-model rework are deleted first; the
developer writes code only. After independent review by two seats checking the
implementation against this architecture, a batch multi-agent stage re-covers
the deleted areas guided by the acceptance matrix in the requirement. Gates
before PR: rush build, lint, typecheck, deterministic test suite, `rush change`
with a breaking note for the provider ABI, and `.agents/scripts/check.sh`.
