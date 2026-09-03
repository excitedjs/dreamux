# Continued optimization

Simplification findings raised against the corrective implementation after it
landed on the draft pull request. They are recorded here so they survive the
review conversation; the operator rules on them one at a time.

Each entry carries its own status. All three below were approved by the operator
on 2026-09-02 and delivered by the Codex developer seat recorded in the task
README; the TeamLeader does not write product code for this task.

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

- **Status:** Delivered 2026-09-02. *(Superseded 2026-09-03 — the narrowing went with the rest of the providers' display state: a provider now keeps none. `stopUnsettled` reports no end at all; the `result` branch of `handleProtocolEvent` ends the native turn itself, before push-back touches it; `stop()` and the fatal generation fence each report one interrupted end when the native session is live; and a run that died reports `failed` unless a stop already reported it. None of them asks whether a turn was open — the Channel ignores an end that finds nothing open ([requirement.md](requirement.md) item 8). Read the two blocks below as the finding as it was raised and the shape as it was then delivered. See [split-streaming-display-from-pushback](/.agents/tasks/architecture/split-streaming-display-from-pushback/README.md).)*
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

- (Superseded 2026-09-03: the guard is deleted in both providers, and `AgentRuntimeActivitySink` now states that the sink never throws — Core owns that failure, catching and logging every projection failure inside `createConversationProjection`'s `guarded` wrapper, so a provider calls the sink bare and the out-of-tree-Core rationale below no longer holds. The tests that forged a throwing sink are deleted with it. See [split-streaming-display-from-pushback](/.agents/tasks/architecture/split-streaming-display-from-pushback/README.md).) `endNativeTurn` wraps the sink call in `try`/`catch`. Inside this repository
  the consumer already catches everything, so nothing can propagate; the guard
  only pays for itself because the sink is a public provider contract that an
  out-of-tree Core could break. Retained by the 2026-09-02 adjudication.
- `failUnattributedResult` defends against Claude violating its own command
  lifecycle. It is pure defense, but it fails loudly rather than silently, so
  it is retained by the 2026-09-02 adjudication.

## 2. Channel-body suppression state

- **Status:** Delivered 2026-09-02 — removed completely.
- **File:** [`/packages/channel/feishu-channel/src/feishu-cot-state.ts`](/packages/channel/feishu-channel/src/feishu-cot-state.ts)

`suppressedUserTurns` is a per-recipient set with a 64-entry cap and an
eviction rule, consumed one-shot, whose only job is to hide the copy of the
Feishu message that is already visible at the anchor. Core publishes that body
synchronously inside the admitting call, before the mark can be written, so the
mark is normally never consumed. The state, the cap, and the eviction policy
are therefore paid for continuously while the capability they support is
mostly inert.

## 3. Readable local-path projection

- **Status:** Delivered 2026-09-02 — the capability stays, the process-global
  cache is gone, and all three defects are repaired.
- **Files:** [`/packages/dreamux/src/platform/home-paths.ts`](/packages/dreamux/src/platform/home-paths.ts),
  [`/packages/dreamux/src/channel/conversation-projection.ts`](/packages/dreamux/src/channel/conversation-projection.ts)

`home-paths.ts` holds a module-level mutable cache resolved once from
`Server.start()`, plus a reset hook for tests. Callers that run before that
resolution silently fall back to the lexical home. Three implementation defects
in this area are adjudicated for repair — home resolution, punctuation-adjacent
prefixes, and `file://` prefix recognition. Two share one root cause:
`PATH_TOKEN_CHARACTER_RE` counts both `.` and `/` as characters that continue a
path token, so a prefix preceded by the `/` of a `file://` URL and a prefix
followed by a sentence-ending `.` both fail their boundary test. The third is
specified by the requirement rather than reproduced from the current source: a
host whose home cannot be resolved must not fall back to the process working
directory.

## Related

- Task README: [README.md](README.md)
- Locked requirement: [requirement.md](requirement.md)
- Verification and accepted best-effort losses: [verification.md](verification.md)

## Pre-review findings from the delivery itself

Recorded because the reasoning is easy to lose and easy to repeat.

1. **A wider token class is not a boundary fix.** The first repair made `.` and
   `/` stop counting as path characters outright. That fixed `file://` and
   sentence-final periods and simultaneously made `<prefix>.<suffix>` read as the
   prefix itself: `<home>.bak/notes.md` became `~.bak/notes.md`, and the far more
   common `<workspace>.git/config` became `..git/config`. The rule has to be
   positional, not lexical — a period ends a path only when what follows it is
   itself a boundary, and a leading slash only counts when it is exactly the
   `://` of a scheme.
2. **Ordering already provides longest-prefix ownership; a second mechanism only
   suppresses correct results.** The second repair added an explicit shadowing
   rule so a workspace-shaped position could not also be claimed by the home
   prefix. Because `redactText` runs the workspace pass first and rewrites every
   position it claims, the only positions still carrying the workspace string are
   the ones the workspace declined — exactly the ones the home must handle. The
   shadowing rule therefore suppressed those renames and published the
   operator's raw home path for `<workspace>.git/config`, a regression against
   the branch it started from. It was removed.

Both were caught by probing the compiled build rather than by reading the diff,
and both are now pinned by tests listed in [verification.md](verification.md).
