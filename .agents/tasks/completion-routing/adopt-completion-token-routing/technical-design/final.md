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

## Background-turn repair (2026-09-07)

Keep RuntimeSubmission and Core completion-token routing unchanged. Claude
command lifecycle remains the owner of fold/queue attribution: the commands
that actually started before a result boundary form its submitted request group.
An exactly matching submitted result UUID is also positive evidence, including
existing no-start compatibility sequences. The group's membership may grow when
a steer joins a native background turn.
A result's origin or single user-message UUID cannot veto that group.

Allow a native result with no submitted group: publish its native activity/end,
settle no unrelated submission, and keep the process alive. Remove the fatal
no-pending and foreign-result-UUID assumptions. With lifecycle evidence, an
empty started group must not fall back to the sole pending request. Preserve
existing supported lifecycle-less single-input behavior with evidence, without
using it to override an explicit queued/started lifecycle or a foreign result
UUID.

Separate resident native activity/aggregation from the request group so that
streams and result boundaries are handled even when no request is outstanding.
Keep command drainage distinct from native result delivery: background results
must not drain queued requests. Preserve native interruption artifact handling,
transport failures, and the established admission/order rules. Discard unfinished
aggregate text at a cancelled native boundary, including when another request
remains queued. Fence late callbacks after stop and emit a failed native end for
a resident background exit without duplicating active-request failure handling.

Acceptance sequence: background native turn -> submit B -> B started -> result
settles B regardless of the turn's original trigger. If B is only queued at that
result, settle nothing yet; B started -> next result settles B. If B and C join
the same native turn, settle both with one immutable completion and let Core
deliver it once per registered recipient. No origin field is needed for this fix.

The Claude-specific session result callback carries the command UUID group
computed by RPC; runtime settlement consumes that group rather than maintaining
a second started ledger. This callback type is exported through the Claude
session extension seam, so custom session implementations need the new field.
Record that compatibility impact explicitly in a Rush breaking minor note;
RuntimeSubmission, AgentRuntime and Core routing contracts are unchanged.
