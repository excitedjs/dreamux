# Final solution: neutral compaction and interrupt activities

- Requirement: [requirement.md](/.agents/tasks/architecture/standalone-compaction-activity/requirement.md).
- Builds on [standalone-token-usage-activity](/.agents/tasks/architecture/standalone-token-usage-activity/technical-design/final.md):
  the same move — a runtime reports a fact, the display layer owns its line —
  applied to the two remaining provider-assembled display strings.
- Supersedes, for the carrier only, the 2026-09-04 ruling that compaction ride
  an `assistant.message`, and the interrupt marker's shape that cited it. The
  rendered lines and their positions do not change.

## 1. The contract

`RuntimeActivity` (`packages/dreamux-types/src/agent-runtime.ts`) gains two
members; `TeammateActivity` (`packages/dreamux-types/src/teammate.ts`) gains
their snake_case counterparts:

```ts
// RuntimeActivity
| { kind: 'context.compacted'; occurredAt: number; id: string }
| { kind: 'turn.interrupted';  occurredAt: number; id: string }

// TeammateActivity
| { kind: 'context.compacted'; event_id: string; redacted: boolean }
| { kind: 'turn.interrupted';  event_id: string; redacted: boolean }
```

Neither carries text. The type docs state the contract:

- `context.compacted` — the runtime compacted its context. The summary it
  wrote for itself is not carried; no other compaction metadata is either.
  Live-only: the cold activity reader never produces it.
- `turn.interrupted` — a display marker, not a terminal: a native turn stopped
  at an interrupt request. It is reported from the runtime's own interrupted
  terminal, ahead of that terminal's `token.usage` and of `turn.ended` with
  status `interrupted`, and every one is paired with that end. A teardown end
  (the runtime stopped while a turn may be running) reports `turn.ended`
  `interrupted` and never this. Live-only: the cold reader never produces it.
- `redacted` is always `false`: there is nothing to redact. It is kept so every
  `TeammateActivity` member states the same fact, as `token.usage` does.

## 2. Change inventory

| Package | Change |
| --- | --- |
| `@excitedjs/dreamux-types` | Add the four union members with the contract docs above; the `turn.ended` doc gains one sentence pointing at `turn.interrupted` for the native case. |
| `@excitedjs/agent-runtime-claude-code` (`src/runtime-activity.ts`) | `compactedActivity` returns `{ kind: 'context.compacted', occurredAt, id: 'stream-<seq>:compacted' }`; `interruptedActivity` returns `{ kind: 'turn.interrupted', occurredAt, id: 'stream-<seq>:interrupted' }`. Delete `COMPACTED_SESSION_MESSAGE` and `INTERRUPTED_MESSAGE`; rewrite the comments that justified the marker by the compaction shape. Emission points and order unchanged. |
| `@excitedjs/agent-runtime-codex` (`src/turn-manager.ts`) | The `contextCompaction` arm of `itemActivity` returns `{ kind: 'context.compacted', occurredAt, id: '<turnId>:<itemId>:completed' }` on completion only; `interruptedActivity` returns `{ kind: 'turn.interrupted', occurredAt, id: '<turnId>:interrupted' }`. Delete both constants and rewrite the comment block. Emission points and order unchanged. |
| `@excitedjs/dreamux` (`src/channel/conversation-projection.ts`) | Project both kinds to `{ kind, event_id: activity.id, redacted: false }`. The switch keeps its compile-time `never` check. |
| `@excitedjs/feishu-channel` | `feishu-cot-activity.ts` owns the two labels, copied character for character from the runtime constants they replace: `COMPACTED SESSION` and `[Request interrupted by user]`. One helper admits a fixed label as an assistant-role display row keyed by the activity's `event_id` through the same `acceptDisplayText` path `acceptAssistantMessage` uses. `feishu-cot-adapter.ts` routes both kinds under its `never`-exhaustive switch. |
| Tests | Both runtimes' compaction and interrupt tests move from text assertions to exact structured objects (kind, id, order); projection exact-object tests for both kinds; a Feishu delivery test locking each kind's card events deep-equal to the `assistant.message` path's (§5). |
| Rush changes | `minor` change files for the five packages; the union change is additive, no persisted file changes. |
| Knowledge | provider-runtime domain: the union enumeration (four members to six), the compaction paragraph rewritten to the current carrier with the 2026-09-04 ruling kept verbatim and marked superseded by the 2026-09-18 words, the two interrupt paragraphs, and the Claude envelope section. Channel domain: the activity vocabulary list and the paragraph listing what enters a card. Product catalog: only the mechanism wording of the compaction and interrupt entries; the card text and the 任务中断 status stay. |

Unchanged: stream parsing (`compact_boundary` stays a `ClaudeActivityLine`),
the app-server item handling, activity ids, emission order, every `turn.ended`
status including teardown's `interrupted`, the Feishu terminal mapping, the
cold reader, the seal (`teammate.activity` is already sealed; the new members
sit inside it), persisted state, and every other activity kind.

## 3. Rendering

The card sees the same bytes it saw before. Both lines were `assistant.message`
activities rendered by `acceptAssistantMessage` as
`acceptDisplayText(…, 'assistant', event_id, text)`; the new path calls the
same function with the same `event_id` and the channel-owned label, so the
display message id, role, content, and the opening behaviour (a line arriving
with no card open opens one) are identical. Order is the runtimes' emission
order, which does not change: an interrupted turn still shows the marker, then
the usage line, then the 任务中断 terminal.

## 4. Rejected alternatives

- **Derive the interrupt line from `turn.ended` status `interrupted`.** No new
  kind, but the line would follow the usage line and appear on teardown ends.
  The operator chose the separate kind.
- **One generic kind for both** (for example a notice with an enum). It saves a
  union member by adding a catch-all whose members have unrelated semantics —
  a mid-turn context event and a turn-end marker — and every consumer would
  switch twice.
- **Carry Claude's `compact_metadata`.** Codex's item has only an id, and no
  consumer asks for trigger or token counts.
- **Drop the ids.** The id is the card's display message identity; passing it
  through is what keeps the card byte-identical.

## 5. Verification plan

- Runtime tests: Claude compaction (live and background) and interrupted
  ordering, Codex compaction (completion only) and interrupt ordering, all as
  exact objects; no `assistant.message` carries either label.
- Projection tests: exact objects for both kinds.
- Feishu tests: a delivery test asserts that each kind produces a
  `TEXT_MESSAGE_*` event sequence deep-equal to the one an `assistant.message`
  with the same `event_id` and the label text produces — display message id
  included — both onto an open card and when it opens one.
- Gates: `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`,
  `.agents/scripts/check.sh`.
- Coverage limit: no live Feishu probe; the card bytes are asserted through the
  shared `acceptDisplayText` path rather than observed in a client.

## 6. Review adjudication

Solution review: the Devbox reviewer on Issue #445, in place of three
solution-review TeamMates, as the work group allows. Verdict: no blocking
issue.

- Accepted: the `turn.interrupted` type doc states the four facts in §1
  (marker not terminal; before usage and the end, paired; never on teardown;
  live-only), not only the Issue.
- Accepted: the labels move verbatim, ids and the sequence increment stay in
  place, and the byte-identity claim is locked by the deep-equal delivery test
  in §5 rather than by two separate "reached the card" assertions.
- Rejected: a code comment declaring the labels byte-equal to the former
  runtime constants. The deep-equal test is the lock; a comment naming code
  that no longer exists describes history.
- Accepted: the channel domain's second paragraph (what enters a card) is
  updated, not only the vocabulary list.
- Adjusted: the reviewer asked for a dated `Since this was recorded` section
  under the 2026-09-04 ruling. That rule governs historical text; the
  provider-runtime page states current behavior, so its paragraph is rewritten
  to the new carrier and keeps the 2026-09-04 quote verbatim, marked as
  superseded by the 2026-09-18 words.
- Not an issue: the reviewer found no task record on `next`. The record exists
  on this task's branch, indexed in the architecture README, and lands with
  the pull request.
- Accepted (non-blocking): one fixed-label helper shared by the two new
  acceptors.
