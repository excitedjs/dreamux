# Requirement

## Initial request

The operator directed, in a Claude Code session on 2026-09-17, that token
usage stop reaching channels as a synthetic assistant message assembled inside
the provider runtimes, and instead become its own structured activity carrying
the native runtime's cumulative counters. The Feishu CoT display layer keeps
showing the same one-line summary; it now renders the structured activity
itself rather than receiving model-attributed prose.

## Confirmed current behavior and evidence

Measured on `next` before this task, in both built-in runtimes:

- `@excitedjs/agent-runtime-codex` (`turn-manager.ts`) emitted, at each native
  turn terminal, an ordinary `assistant.message` whose `text` was the
  presentation string `Context usage … | Token usage: total=… input=…
  output=…`, assembled by a package-local `usageSummary()` and
  `formatTokenCount()`.
- `@excitedjs/agent-runtime-claude-code` (`runtime-activity.ts`) did the same
  on `result`/`interrupted`, with its own copy of the formatter.
- The counters behind the text were already the native runtime's cumulative
  session totals: codex's `thread/tokenUsage/updated` snapshot (`total`), and
  claude's resident-CLI `modelUsage` sums. Neither runtime accumulated,
  baselined, or differenced anything; codex kept only the latest snapshot,
  replaced per turn and cleared on a collector thread change.
- The display string was the only carrier of the numbers. A structured
  consumer had to parse them back out of display prose, and the fact "the
  model said a sentence" was conflated with the fact "the turn consumed
  tokens".
- The usage message was live-only already: the cold activity reader never
  produced it.
- The knowledge base described usage as an ordinary assistant message
  ([provider-runtime domain](/.agents/domains/provider-runtime.md),
  [product catalog](/.agents/product/README.md)), and stated the
  `RuntimeActivity` union had exactly three members.

## Desired outcome

One neutral activity kind, `token.usage`, reported once per native turn by each
runtime, carrying structured cumulative counters. No provider assembles usage
prose and no provider adds accumulation, baselines, or differencing. Display
layers that want the historical line render it themselves.

## Desired behavior

- `RuntimeActivity` (camelCase) and `TeammateActivity` (snake_case) each gain
  one additive member:

  ```ts
  { kind: 'token.usage'; id; occurredAt;
    inputTokens: number; outputTokens: number;
    context: { usedTokens: number; windowTokens: number | null } | null }
  ```

  `inputTokens`/`outputTokens` are the native runtime's session-total
  counters, never turn deltas; a consumer derives a turn delta by differencing
  consecutive snapshots for the same agent.
- codex emits it at the existing terminal point from the turn's latest
  `thread/tokenUsage/updated` snapshot; id convention stays `${turnId}:usage`.
  It includes `context` only when both `last.totalTokens` and a *positive*
  `modelContextWindow` are present; otherwise the field is `null` so the
  historical line renders `n/a` rather than a used count the old line never
  showed. The snapshot is consumed with its turn's terminal and cleared, so a
  later same-thread turn that receives no update emits no usage instead of
  repeating the previous turn's totals.
- claude emits it on `result`/`interrupted` from the native result envelope;
  id convention stays `stream-${seq}:usage`; its window is structurally always
  `null`, and its used-context compact display is the pre-existing behaviour.
- Terminal ordering is unchanged: interruption marker, then `token.usage`,
  then `turn.ended`.
- The conversation projection maps the activity camelCase to snake_case with
  `redacted: false` — numeric counters carry nothing to redact.
- The Feishu CoT layer appends the byte-identical historical one-line summary
  for the activity; the compact-number formatter moves into that package.
- The activity is live-only, like the usage line before it: the cold reader
  never replays it, and a dropped snapshot is not reconstructed.

## Scope

- `packages/dreamux-types`: the two union members and their contracts.
- `packages/agent-runtime/codex`, `packages/agent-runtime/claude-code`:
  replace the synthetic message emission, delete the per-package formatters.
- `packages/dreamux`: project the new activity.
- `packages/channel/feishu-channel`: own the one-line rendering.
- Tests for all of the above, plus rush change files for the five packages.
- Knowledge pages that describe the usage line or enumerate the activity
  union.

## Non-goals

- Consumer-side statistics, snapshot storage, or any differencing pipeline:
  this PR only publishes the neutral fact; what a consumer does with
  cumulative snapshots is its own work.
- Any new provider runtime's token support.
- Changing the `thread/tokenUsage/updated` subscription plumbing, activity
  ids, id conventions, persisted state, or any other activity kind.
- A new reliable-delivery or replay mechanism for usage. Live-only and
  best-effort stays.
- Changing what the Feishu card shows: the rendered line is preserved
  verbatim.

## Constraints and invariants

- Additive only: a deployment that does not know the kind ignores it. No
  union member is removed, renamed, or retyped.
- The runtime owns accumulation; the adapter keeps at most the latest
  snapshot; no subtraction, no history, no cold read exists in the runtime
  packages.
- Cumulative values pass through verbatim; the adapter never reformats or
  scales a number for the wire.
- The counters are not conversation content: the activity is never delivered
  to another agent as an answer or inserted into model context.

## Acceptance criteria

- Neither built-in runtime emits an `assistant.message` carrying a usage
  string; each emits exactly one `token.usage` per native turn when native
  counters are present, and none when they are absent.
- The emitted object carries the native cumulative totals and context shape
  verbatim, asserted as exact objects in both runtimes' tests, including the
  interrupted-turn ordering and the foreign-thread/thread-switch cases.
- The projection test covers the snake_case mapping; the Feishu channel test
  owns the rendered line and the compact-number table.
- The rendered one-line summary is unchanged from the previous build for
  equal inputs (percentage, compact count, and `n/a` cases).
- `rush build`, `rush test`, `rush typecheck:tests`, and lint pass for the
  five changed packages, and the knowledge-base check passes.

## Decisions and unknowns

- Confirmed operator decisions (Claude Code session, 2026-09-17):
  - Usage becomes a standalone structured activity; providers no longer
    assemble a message for it; the display layer renders the line itself.
  - Counters stay native cumulative session totals; turn deltas are a
    consumer-side derivation, never runtime work.
  - No cold-read or reconstruction path; usage stays live-only.
  - Implement in this repository first, behind an additive union member.
- Assumptions: none outstanding.
- Blocking unknowns: none.
