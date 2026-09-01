# Continued optimization

Simplification findings raised against the corrective implementation after it
landed on the draft pull request. They are recorded here so they survive the
review conversation; the operator rules on them one at a time.

Nothing on this page is approved for implementation. Each entry carries its own
status, and an entry only becomes work when the operator says so and the single
implementation developer picks it up — the TeamLeader does not write product
code for this task.

## Where the complexity actually moved

Source-line change of the corrective implementation, tests excluded:

| Package | Net |
|---|---|
| `packages/channel/feishu-channel/src` | -251 |
| `packages/dreamux/src` | +251 |
| `packages/agent-runtime/claude-code/src` | +91 |
| `packages/agent-runtime/codex/src` | +48 |
| `packages/dreamux-types/src` | +61 |

The Channel genuinely lost a dimension: state keyed per Feishu target and per
logical turn is gone, and with it two whole modules. The cost was paid one layer
down, in the runtime providers, the core projection, and a new cross-package
event contract — which is harder to change later than Channel code is.

Roughly 190 of the 251 core lines belong to readable local-path projection,
which shares this pull request but is a separate subject from card lifecycle.

## 1. Claude native-turn end: narrow the synthesis rather than deduplicate it

- **Status:** Recorded 2026-09-02. The operator accepts the synthesis; the
  deduplication is the part under review. Not implemented.
- **Files:** [`/packages/agent-runtime/claude-code/src/runtime.ts`](/packages/agent-runtime/claude-code/src/runtime.ts),
  [`/packages/agent-runtime/claude-code/src/runtime-submissions.ts`](/packages/agent-runtime/claude-code/src/runtime-submissions.ts)

### What ships today

Four sites report a native turn end. Two pass through Claude's own terminal
`result` — `completeStartedGroup` and `failUnattributedResult`. Two synthesize
an end for the cases where the protocol emits nothing at all: `markTurnFailed`
(the turn promise rejected, or a stop was requested) and `stopUnsettled` (stop,
the fatal generation fence, or a window that resolved without a terminal
result). Synthesis is what keeps a card from staying open forever when a
runtime is stopped, dies, or loses its protocol connection, since a card closes
only on a native end.

`stopUnsettled` also runs on every ordinary success, because
`markTurnSucceeded` calls it unconditionally. The ordinary path therefore
reports `completed` from the `result` and immediately reports `interrupted`
from `stopUnsettled`. The `currentNativeTurnEnded` flag exists to swallow that
second report. It is load-bearing on the happy path, not a guard against a
rare crash: removing it makes every card close as interrupted.

### Why the flag is the wrong place to solve it

Both synthesis sites fire whether or not the call ended anything. The
information needed to not fire is already available and discarded:
`SubmissionDeferred.settle()` returns `true` only for the caller that actually
settled the submission, and both sites ignore that return value.

### The shape recorded for review

Report a synthesized end only when this call really settled something:

```ts
private stopUnsettled(turn: ActiveTurn): void {
  let stopped = false;
  for (const deferred of turn.submissions.values()) {
    if (deferred.settle({ kind: 'stopped' })) stopped = true;
  }
  if (stopped) this.endNativeTurn(turn, 'interrupted');
}
```

with the same treatment in `markTurnFailed`. Consequences:

- The ordinary path settles nothing new, so no second end is reported and no
  deduplication is needed.
- `currentNativeTurnEnded` and the "clear the flag when a command starts" reset
  rule both become unnecessary.
- Each `result` reports exactly one end by construction, so the per-`result`
  granularity the 2026-09-02 adjudication requires holds without any
  window-versus-turn scope rule to get wrong.
- The two providers converge: Codex already skips records that carry a
  completion, which is the same "only an unfinished turn can be interrupted"
  rule.

Estimated net reduction on the Claude side: 30 to 40 lines.

### Lower-value defensive code found in the same pass

- `endNativeTurn` wraps the sink call in `try`/`catch`. Inside this repository
  the consumer already catches everything, so nothing can propagate; the guard
  only pays for itself because the sink is a public provider contract that an
  out-of-tree Core could break. Keep or drop on preference.
- `failUnattributedResult` defends against Claude violating its own command
  lifecycle. It is pure defense, but it fails loudly rather than silently, so
  it is worth keeping.

## 2. Channel-body suppression state

- **Status:** Under review 2026-09-02. Not yet ruled on.
- **File:** [`/packages/channel/feishu-channel/src/feishu-cot-state.ts`](/packages/channel/feishu-channel/src/feishu-cot-state.ts)

`suppressedUserTurns` is a per-recipient set with a 64-entry cap and an
eviction rule, consumed one-shot, whose only job is to hide the copy of the
Feishu message that is already visible at the anchor. Core publishes that body
synchronously inside the admitting call, before the mark can be written, so the
mark is normally never consumed. The state, the cap, and the eviction policy
are therefore paid for continuously while the capability they support is
mostly inert.

## 3. Readable local-path projection

- **Status:** Under review 2026-09-02. Capability itself already adjudicated as
  original scope and staying; the review point is its implementation cost and
  its process-level state.
- **Files:** [`/packages/dreamux/src/platform/home-paths.ts`](/packages/dreamux/src/platform/home-paths.ts),
  [`/packages/dreamux/src/channel/conversation-projection.ts`](/packages/dreamux/src/channel/conversation-projection.ts)

`home-paths.ts` holds a module-level mutable cache resolved once from
`Server.start()`, plus a reset hook for tests. Callers that run before that
resolution silently fall back to the lexical home. Three implementation defects
in this area are already adjudicated for repair — home resolution,
punctuation-adjacent prefixes, and `file://` prefix recognition — and remain
open as of the head of the draft pull request.

## Related

- Task README: [README.md](README.md)
- Locked requirement: [requirement.md](requirement.md)
- Verification and accepted best-effort losses: [verification.md](verification.md)
