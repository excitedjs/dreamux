# Requirement

## Initial request

The operator, in the Feishu work group on 2026-09-18, after #442 moved token
usage out of the message event: 「上一个pr已经给usage 从 message 事件里拆出来了，
我感觉compact 也可以拆出来。」 Then, on the interrupt marker: 「interrupted 也一并
拆了」.

## Confirmed current behavior and evidence

Measured on `next` after #442 merged.

- Compaction. Both built-in runtimes publish a context compaction as an
  ordinary `assistant.message` whose `text` is the provider-owned label
  `COMPACTED SESSION`:
  - `@excitedjs/agent-runtime-claude-code` (`src/runtime-activity.ts`,
    `compactedActivity`) on the `system`/`compact_boundary` stream-json
    envelope, id `stream-${seq}:compacted`;
  - `@excitedjs/agent-runtime-codex` (`src/turn-manager.ts`, `itemActivity`)
    on the completion of a `contextCompaction` item, id
    `${turnId}:${itemId}:completed`.
  The summary the runtime wrote is never shown. Being an `assistant.message`,
  the line opens a Feishu CoT card when none is open.
- Interrupt. Both runtimes publish `[Request interrupted by user]` the same way,
  as a provider-assembled `assistant.message` pushed only on a *native*
  interrupted terminal (claude's `interrupted` protocol event; codex's
  `turn/completed` with `status: "interrupted"`). The emission order on that
  terminal is marker, then `token.usage`, then `turn.ended` with status
  `interrupted`. Teardown ends (`claude-code/src/runtime.ts` stop paths, codex
  `TurnManager.stop`) report `turn.ended` `interrupted` with no marker. The
  code comments justify the marker by the compaction shape: "the same shape
  used for `COMPACTED SESSION`: no new activity kind".
- Both facts are live-only today: the Claude Code cold reader never projects
  `compact_boundary`, and `readRecentActivity` returns its own record
  vocabulary, not `RuntimeActivity`.
- The only consumer of the projected activity is the Feishu CoT adapter; the
  `teammate.activity` Core event kind is already sealed, so a new member inside
  the activity union needs no seal change.
- The knowledge base records the superseded ruling (provider-runtime domain,
  compaction paragraph), 2026-09-04: 「我觉得没必要给他单独加一个新的 activity
  类型，你直接在 provider 里，多推一个 assistant message，内容就这一行。」

## Current alignment

- Status: Converged.
- Desired outcome: no provider assembles display text for compaction or
  interruption. Runtimes report the facts; the Feishu CoT layer owns both
  labels, as it owns the token usage line since #442.
- Desired behavior (compaction): a new neutral activity kind carrying no text,
  emitted at the same two native points with the same ids; Core projects it;
  the Feishu CoT layer renders the unchanged `COMPACTED SESSION` line, and it
  still opens a card when none is open.
- Desired behavior (interrupt): a second new neutral activity kind carrying no
  text, emitted exactly where the marker is pushed today — only on a native
  interrupted terminal, ahead of `token.usage` and `turn.ended` — with the
  same ids; Core projects it; the Feishu CoT layer renders the unchanged
  `[Request interrupted by user]` line in the same position. Teardown ends
  still carry no such line.
- Scope: `dreamux-types` activity unions, both built-in runtimes, the Core
  conversation projection, the Feishu CoT rendering, their tests, rush change
  files, and the knowledge pages that describe either line or enumerate the
  activity union.
- Non-goals: the runtime's compaction summary or metadata (Claude's
  `compact_metadata` trigger/token counts) — no consumer asks for it; the cold
  read path; activity ids; any change to the rendered label text; any change
  to `turn.ended` statuses or card terminals — a teardown end keeps reading
  `interrupted` (任务中断), and the Feishu channel's own lifecycle closures are
  untouched.
- Constraints and invariants: the rendered compaction line is unchanged for
  the operator; live-only; additive union members.

## Acceptance criteria

- Neither built-in runtime emits an `assistant.message` whose text it
  assembled for compaction; each emits the new kind at the same point with the
  same id.
- The Feishu CoT card shows `COMPACTED SESSION` exactly as before, including
  opening a card when none is open.
- Neither built-in runtime emits an `assistant.message` whose text it
  assembled for an interrupt; each emits the new interrupt kind at the same
  point, in the same order, with the same id, and never on a teardown end.
- The Feishu CoT card shows `[Request interrupted by user]` exactly where it
  appears today.
- `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`, and
  `.agents/scripts/check.sh` pass.

## Decisions and unknowns

- Confirmed operator decisions (Feishu work group, 2026-09-18):
  - Compaction becomes its own activity, superseding the 2026-09-04 ruling
    quoted above (card answer: 「确认替代，拆出来」).
  - A new task record, building on
    [standalone-token-usage-activity](/.agents/tasks/architecture/standalone-token-usage-activity/README.md)
    (card answer: 「新建任务」).
  - The interrupt marker is split out too: 「interrupted 也一并拆了」.
  - Its carrier is its own activity kind, keeping today's trigger set and
    position, accepting that an interrupt is then stated both by that kind and
    by `turn.ended` status `interrupted` (card answer: 「B 独立 activity 类型」).
  - Card end states stay as they are. The operator's follow-up
    (「interrupt 应该是任务中断，那种原生的失败就变成了任务失败。。任务失败就可以
    定义为一个异常情况」) already matches the code for native interrupts and
    native failures; the one divergent case, a teardown end, keeps
    `interrupted` after comparing code volume (card answer: 「保持任务中断」).
- Assumptions: none outstanding.
- Blocking unknowns: none.
