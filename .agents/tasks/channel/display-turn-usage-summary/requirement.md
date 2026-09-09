# Requirement

## User story

An operator watching an agent's live COT card wants a compact usage summary
immediately before the native turn ends, without reading a transcript or adding
an expensive context query.

## Current alignment

- Requirement revision: 2026-09-09. The operator selected a new task and the
  minimal-change workflow; development approval is recorded in the task README.
- Codex displays context utilization as a percentage. Claude Code displays the
  token count of its latest main-model input context, not a percentage.
- Both runtimes display native cumulative token counts with the same labels,
  ordering, and lowercase `k`, `m`, and `b` units. Counts below 1,000 remain numbers.
- The summary is an ordinary display-only `assistant.message` immediately before
  `turn.ended`, not model-generated text or part of a submission's result.

Requested presentation examples:

```text
Context usage 50% | Token usage: total=28.6k input=28.6k output=69
Context usage 14.5k | Token usage: total=28.6k input=28.5k output=69
```

## Baseline behavior and evidence

These observations describe the pre-implementation baseline; the final solution
records the later upstream activity-owner rename and interruption integration.

- Codex already observes native terminal notifications in
  [events.ts](/packages/agent-runtime/codex/src/events.ts) and publishes the native
  display end before settlement in
  [turn-manager.ts](/packages/agent-runtime/codex/src/turn-manager.ts). It currently
  discards `thread/tokenUsage/updated`.
- Claude Code already receives assistant usage and result envelopes, but
  [stream.ts](/packages/agent-runtime/claude-code/src/stream.ts) does not retain
  their metrics. The original `runtime-submissions.ts` (now
  [runtime-activity.ts](/packages/agent-runtime/claude-code/src/runtime-activity.ts))
  publishes a display end at each forwarded native result before settlement.
- Both runtimes already represent compaction as an ordinary assistant activity.
  [The product catalog](/.agents/product/README.md) keeps best-effort display and
  native terminal status independent from completion decoding and attribution.
- Codex's native usage notification provides cumulative `total`, latest-context
  `last`, and nullable `modelContextWindow`. Native Codex handles recovery itself;
  Dreamux does not need to read a rollout file.
- The [official Claude SDK cost documentation](https://code.claude.com/docs/en/agent-sdk/cost-tracking#track-costs-in-streaming-input-mode)
  distinguishes per-turn `result.usage` from cumulative `result.modelUsage`.
  The latter is cumulative within the resident query/process, not a guaranteed
  historical session total across process restarts. The
  [ModelUsage reference](https://code.claude.com/docs/en/agent-sdk/typescript#modelusage)
  defines ordinary, cache-read, cache-write, and output counts.

## Scope and product delta

Extend the product catalog's "Observing agents" behavior with the usage row.
Preserve live display, existing compaction rows, tool/message rendering, native
terminal status/reason, and submission completion semantics.

Product implementation stays in the two runtime packages and their tests.
Task records and the affected product/runtime knowledge owners must describe the
new behavior. No Core or Channel special cases, new neutral activity type,
configuration, persistence, dependency, or CLI surface are required.

Non-goals: rollout/transcript scanning, storing all earlier messages, reconstructing
historical totals, maintaining a cumulative ledger, querying context after a turn,
SDK migration, dollar-cost accounting, sub-agent-specific rows, and reproducing
each provider's terminal UI accounting convention exactly.

## Acceptance criteria

1. With native usage available, each native terminal produces one usage assistant
   activity immediately before its `turn.ended`. Existing failure reason rendering
   remains unchanged; the Channel can still show its reason after the usage row.
2. Native terminal display does not wait for settlement, decoding, attribution,
   disk IO, network queries, or an answer to an in-flight admission.
3. Codex uses the latest thread usage snapshot, not a sum of snapshots. Claude uses
   the latest result's model totals, summed across that result's model entries,
   not across past results. Native totals may already include sub-agent costs.
4. Claude context uses only the most recent main-model request's input usage in
   the current turn, including cache reads and writes. A sub-agent assistant
   envelope cannot replace that context, and input from previous steps is not
   accumulated. This number does not include the final response's output tokens.
5. The usage row never enters `RuntimeCompletion.resultText`, structured output,
   prompts, model context, or completion push-back.
6. Number formatting is consistent across the two providers. Existing behavior
   for native failures, compaction, multi-result execution, and teardown remains
   intact; teardown without a fresh native terminal must not add another row.

## Decisions and assumptions

Operator decisions, 2026-09-09 (English translations of the conversation; the
presentation examples above retain the original strings):

- Skip the feature if it requires high implementation cost, such as querying
  rollout files.
- Place an assistant message as the last display line before the COT turn ends.
- Stop displaying a percentage for Claude Code; display context token count
  instead. Keep the two AgentRuntime presentations as consistent as practical.
- Abbreviate counts with `k`, `m`, and `b`; show numbers below `1k` directly.
- Create a new task using the minimal-change workflow.

Proposed defaults included in the final development approval, not separate
operator rulings:

- Decimal units are base 1,000, with at most one decimal place and no trailing
  `.0`. Rounding promotes to the next unit at a boundary, up to `b`.
- Codex context percentage is the rounded ratio of `last.totalTokens` to the
  supplied `modelContextWindow`, not the TUI's baseline-adjusted percentage.
- Input includes all native input tokens, including cache reads/writes; output
  uses the native output count without adding reasoning output again. Displayed
  total is input plus output before rounding.
- If cumulative usage is absent, omit the summary rather than inventing totals.
  If cumulative usage exists but the context measurement/window is unavailable,
  show `Context usage n/a`. Neither condition changes the native turn outcome.
- Claude's native cumulative scope resets when its resident process/query does;
  Dreamux does not persist or backfill previous process totals.

Blocking unknowns: none for the bounded native-data-only approach. The operator
approved these defaults, the final solution, and verification scope at the
development gate recorded in the task README.
