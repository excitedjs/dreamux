# Final solution: a neutral token.usage activity

- Status: Implemented in [PR #442](https://github.com/excitedjs/dreamux/pull/442).
- Supersedes, for the carrier only, the shape chosen in
  [display-turn-usage-summary](/.agents/tasks/channel/display-turn-usage-summary/README.md):
  the rendered line survives unchanged; the synthetic assistant message that
  carried it does not.

## 1. The contract

`RuntimeActivity` gains one member in
`packages/dreamux-types/src/agent-runtime.ts`; `TeammateActivity` gains the
snake_case counterpart in `packages/dreamux-types/src/teammate.ts`:

```ts
{ kind: 'token.usage';
  id: string;                 // TeammateActivity: event_id
  occurredAt: number;
  inputTokens: number;        // event: input_tokens
  outputTokens: number;       // event: output_tokens
  context: {
    usedTokens: number;       // event: used_tokens
    windowTokens: number | null;  // event: window_tokens
  } | null; }
```

The type doc is the contract and states all of it:

1. **Cumulative.** `inputTokens`/`outputTokens` are the native runtime's
   session totals as it owns them, never per-turn deltas. A consumer derives a
   turn's consumption by differencing the previous snapshot for that agent.
2. **Zero adapter state.** The runtime keeps no usage history and performs no
   subtraction. Codex retains exactly the field it had before: one latest
   snapshot, replaced on every matching-thread notification and cleared on a
   collector thread change. Claude computes nothing beyond the existing
   result-envelope parse.
3. **Live-only.** The cold activity reader never produces the activity, and a
   dropped snapshot widens the next consumer-side delta rather than being
   reconstructed.
4. **One per native turn**, emitted on the native terminal, after an
   interruption marker when one exists and before `turn.ended`.

## 2. Change inventory

| Package | Change |
| --- | --- |
| `@excitedjs/dreamux-types` | Add the two union members with the cumulative/live-only contract doc. |
| `@excitedjs/agent-runtime-codex` (`turn-manager.ts`) | Replace the terminal synthetic message with `tokenUsageActivity(turnId, snapshot)`; delete `usageSummary()` and the package's `formatTokenCount()`. Context is emitted only with a positive window; the latest snapshot is consumed at the terminal (and still replaced per notification and cleared on a collector thread change). |
| `@excitedjs/agent-runtime-claude-code` (`runtime-activity.ts`) | The `result`/`interrupted` branch emits `token.usage` from `outcome.tokenUsage`, with `context = contextTokens == null ? null : {usedTokens: contextTokens, windowTokens: null}`; delete the package's `formatTokenCount()`. `stream.ts` parsing is untouched. |
| `@excitedjs/dreamux` (`conversation-projection.ts`) | New `case 'token.usage'` projects camelCase to snake_case, verbatim numbers, `redacted: false`. A compile-time `never` check plus a run-time `default` drops an unknown newer kind with a warning instead of publishing `activity: undefined`. |
| `@excitedjs/feishu-channel` | `feishu-cot-adapter.ts` routes the kind to a new `acceptTokenUsage()` under a `never`-exhaustive switch; `feishu-cot-activity.ts` exports `tokenUsageSummary()` and owns `formatTokenCount()`, moved down from the runtimes; `feishu-cot-token-usage.test.ts` owns the rendering table, and `feishu-cot-delivery.test.ts` owns the activity-to-card path. |
| Tests | Both runtime test suites' usage sections rewritten from text assertions to exact structured-object assertions; projection, card-delivery, null-window/zero-window, and stale-snapshot cases added. |
| Rush changes | Minor change files for all five packages: the activity union is additive. |
| Knowledge | Provider-runtime domain, channel domain, and the product catalog now describe the neutral kind; this task's records. |

Nothing changed in: the app-server subscription, claude stream parsing,
activity ids (`${turnId}:usage`, `stream-${seq}:usage`), terminal ordering,
the cold reader, persisted state, sealing's exhaustive catalog mechanics (the
new member is one more total-record row), or any other activity kind.

## 3. Rendering

The display layer owns presentation now. `tokenUsageSummary(event)` produces
the historical line from the structured fields:

- context with a positive window: `round(used / window * 100)%` — the same
  deliberately non-TUI calculation codex used;
- context without a window (claude): the compact used count;
- `context: null` — a runtime that had no usable context signal: `n/a`. This
  is the only codex no-window case: codex omits the field unless the
  app-server gives both a used footprint and a positive window, which keeps
  its historical `n/a` line distinct from claude's structurally windowless
  compact count;
- total is input plus output; counts compact to decimal lowercase `k`/`m`/`b`,
  one decimal max, plain below 1,000.

`acceptTokenUsage` applies the same presentable-anchor guard every other
activity gets and admits the line as an assistant-typed display row with the
activity's own id, so card dedupe works exactly as it did for the message.

## 4. Why the union, not an envelope field

Usage is a runtime fact on the same footing as an assistant message or a tool
call: actor-scoped, turn-bound in ordering but submission-free, and failable
independently of the turn's terminal. Adding a field to `turn.ended` was
rejected:

- a failed/interrupted turn still reports usage today, and making counters an
  optional field of the terminal entangles display-close with telemetry;
- the seal and projection already total-map a tagged union, so a new member is
  the path that changes no catalog machinery;
- consumers that ignore unknown kinds ignore this one for free, which is the
  compatibility story an additive field on an existing event would not give
  once populated by new edges.

## 5. Compatibility

The union member is additive end to end: type union, projection, and channel
routing. No old member, field, id convention, or emission changed; the only
deletion is the provider-internal prose assembly, whose output the channel
now reproduces from the new fact.

The "unknown kind is ignored" guarantee holds at two boundaries and is
narrower at a third:

- an older **channel listener** behind an upgraded Core never sees the kind
  it does not subscribe to, and the Feishu adapter's exhaustive switch makes a
  missing dispatch arm a compile error;
- an older **Core** behind an independently upgraded provider no longer
  publishes it as `activity: undefined`: the projection's run-time default
  drops the fact with a warning. The fact is silently absent for that Core,
  never malformed;
- this repository ships Core and providers in one monorepo release, so the
  independently-upgraded-provider case is defensive rather than a supported
  deployment matrix.

## 6. As built

- **The runtimes never held baselines.** The pre-change code formatted the
  native cumulative values straight into the message text; there was no
  differencing layer in this repository to delete. The "zero adapter state"
  rule is therefore expressed as a type-documented invariant plus the
  latest-snapshot-only field codex already had, not as a removal. An
  integrator carrying its own baseline layer retires it against this
  contract separately.
- **`tokenUsageSummary` is exported from the channel package.** Production
  code reaches it through `acceptTokenUsage`; the export exists so the
  rendering table tests the formatter without forging the adapter's sink.
- **claude's `windowTokens` is always `null`.** The CLI envelope gives no
  window size; used-context compact display was the pre-existing behaviour and
  is preserved.
- **Review corrections (PR review CHANGES REQUESTED, 2026-09-17).**
  1. Codex's first cut emitted `{usedTokens, windowTokens: null}` without a
     window, indistinguishable on the wire from claude's compact-count case,
     which changed codex's historical `n/a` line into a used count. Codex now
     omits `context` unless a positive window exists. The distinction between
     "runtime structurally lacks a window" (claude → count) and "runtime
     failed to supply one this turn" (codex → n/a) is carried by presence, not
     a new field.
  2. Codex consumed a turn's snapshot without clearing it, so a same-thread
     turn with no usage update re-emitted the previous totals under a new id.
     The snapshot is now cleared with the terminal; notifications always
     precede their own terminal, so no live update is lost.
  3. The projection and the adapter both gained compile-time exhaustiveness;
     the projection additionally drops a run-time unknown kind.
  4. Card-level delivery tests pin that the dispatch arm actually exists.
