# Final technical solution

## Authority and path

Input: [requirement revision 2026-09-09](/.agents/tasks/channel/display-turn-usage-summary/requirement.md).
The operator selected the minimal-change fast path. The TeamLeader implements,
then one independent read-only reviewer examines the whole diff. No separate
solution-review Issue or proposal agents are needed.

This is display formatting over native facts in the existing runtime owners.
It adds no Core/Channel behavior, neutral runtime contract, persistent state,
dependency, query protocol, or lifecycle mechanism. Usage never becomes completion
text. Extend only the provider-local protocol data needed to carry optional native
measurements; do not require new fields from factory or session consumers.

## Codex

1. Add the consumed `thread/tokenUsage/updated` wire fields in
   [types.ts](/packages/agent-runtime/codex/src/types.ts), and forward matching-thread
   notifications through the existing collector in
   [events.ts](/packages/agent-runtime/codex/src/events.ts).
2. [TurnManager](/packages/agent-runtime/codex/src/turn-manager.ts) retains one latest
   usage snapshot for the collector's thread, replacing it on each update and
   clearing it when the thread/collector changes. Do not keep a history or sum
   notifications. The snapshot is native cumulative usage, not attribution state.
3. On the existing native terminal callback, synchronously emit the formatted
   assistant activity before `endNativeTurn`, regardless of whether a submission
   has bound or can decode its completion. Reuse existing terminal deduplication.
   Do not add the row to generic stop/connection-failure teardown paths.
4. Context is `round(last.totalTokens / modelContextWindow * 100)` when the native
   window is positive. This deliberately uses the supplied effective window
   without importing the TUI's fixed baseline adjustment. Input is
   `total.inputTokens`; output is `total.outputTokens`; total is their sum. Cached
   input and reasoning output are already included, so do not add them again.

## Claude Code

1. In [stream.ts](/packages/agent-runtime/claude-code/src/stream.ts), reduce the
   latest result's `modelUsage` into input/output totals. Input is the sum of
   `inputTokens + cacheReadInputTokens + cacheCreationInputTokens` across that
   object's model entries; output is the sum of `outputTokens`. Never add values
   from previous results or substitute per-turn `result.usage` for the cumulative
   measure.
2. While reading assistant envelopes, retain only the latest main-model input
   count: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
   from `message.usage`. Ignore sub-agent envelopes with a non-null
   `parent_tool_use_id`. Overwrite this count; do not retain the message history or
   sum model steps. Reset the per-turn measurement at `takeOutcome`.
3. Carry these optional provider-local measurements with the existing result path
   in [types.ts](/packages/agent-runtime/claude-code/src/types.ts). Keep the RPC and
   its control protocol unchanged. Preserve factory/session callers that do not
   provide usage; usage is absent rather than an error in that case.
4. In [runtime-activity.ts](/packages/agent-runtime/claude-code/src/runtime-activity.ts),
   emit one formatted assistant activity immediately before the native result's
   `endNativeTurn`. Reuse the activity sequence for its display ID. Carry the same
   optional outcome through the provider-local interrupted-result event; preserve
   custom sessions that emit only the existing interruption marker, the marker
   before the usage row when metrics exist, and the stopped settlement. Do not
   alter completion text, error interpretation, attribution, or generic teardown.

The PR base advanced to `2b3d697` during verification. Upstream #384 moved the
activity owner from `runtime-submissions.ts` to `runtime-activity.ts`; #379 added
native interruption display. The integration follows those existing owners,
resets context in `discard()` (used by both result consumption and cancellation),
and ports the tests to the resident RPC/activity harnesses. The approved product
behavior, runtime-only boundary, accounting, and no-extra-IO constraint are unchanged.

## Formatting and unavailable data

Each provider formats the same literal labels with its own context representation:

```text
Context usage <percentage-or-count> | Token usage: total=<count> input=<count> output=<count>
```

Keep the small formatting function local to each provider; do not introduce a
shared presentation service, runtime dependency, or exported abstraction solely
to share a few arithmetic operations. Use identical behavior tests for both.

Counts below 1,000 are unabridged integers. Use decimal `k`, `m`, and `b` with at
most one decimal place, omit trailing `.0`, and promote rounded boundary values
(e.g. `999,999` becomes `1m`). Add input and output before formatting total.
Validate only the consumed external numeric fields; absent/unusable cumulative
usage omits the row. Missing context alone renders `Context usage n/a`. These are
ordinary no-model-response and nullable-native-window cases, not turn failures.

Claude's context is the latest main request's input, not a precise post-response
context count. Its totals have the native resident-query lifetime. No restart
backfill, transcript scan, query, timer, or additional IO is introduced.

## Verification and closeout

- Extend existing Codex collector/runtime tests to cover notification filtering,
  snapshot replacement across turns, cleared state for a different thread,
  terminal-before-admission ordering, failure/teardown behavior, missing window,
  and unchanged completion text.
- Extend existing Claude stream/submission tests to cover cached input, multiple
  models and results without double counting, last-main-request context instead
  of summed steps, sub-agent exclusion, per-result reset, unavailable metrics,
  and usage immediately before native end even when settlement fails.
- Exercise both providers' formatting at 0, 69, 999, 1,000, 28,637, rounding unit
  boundaries, millions, and billions. Existing compaction and native terminal
  tests remain load-bearing.
- Run the repository Rush build, lint, test, and `typecheck:tests` gates. Do not
  claim a green change unless all four pass; report any unavailable live-runtime
  validation explicitly rather than silently skipping it.
- Confirm presentation through the existing Feishu card tests/harness where
  available, without production configuration changes. If no browser/live Feishu
  observation is possible, report that limitation; stream tests are not evidence
  of an observed live card.
- One independent read-only implementation review follows the TeamLeader's
  pre-review. Update the product catalog and provider-runtime knowledge for the
  new row and native accounting scope, then run `.agents/scripts/check.sh`.
- No commit, push, PR, merge, runtime installation/restart, or Team dissolution is
  authorized by this solution alone.
