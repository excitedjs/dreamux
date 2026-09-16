# Requirement

## User story

An operator watching a Claude Code TeamLeader's or Dispatcher's live COT card
while it delegates to a native subagent expects the card to show what the main
agent said and did — including its own `Agent` tool call — and nothing the
subagent said or did inside that call.

## Initial request

Operator, 2026-09-16, in the Team's bound channel:

> 现在 claude code 的 subagent 的 Activity 也会通过飞书渲染出来，这个不符合预期啊，预期只需要渲染 main agent 的Activity。在 Provider 这层，Subagent 的 Activity 完全不需要上报。

## Current alignment

- Requirement revision: 2026-09-17. Clarification converged on one question
  card; development approval is recorded in the task README.
- The Claude Code runtime reports runtime activity for the main agent only. An
  `assistant` or `user` stdout envelope that belongs to a subagent produces no
  runtime activity at all: not its text, not its tool calls, not its tool
  results.
- The main agent's own `Agent` tool call stays on the card: its `started` row
  and its result row, whatever the result carries (a foreground subagent's
  final report, or a background launch acknowledgement).

## Baseline behavior and evidence

- [rpc.ts](/packages/agent-runtime/claude-code/src/rpc.ts) `onLine` forwards
  every `assistant` and `user` line as a `stream` protocol event;
  [runtime-activity.ts](/packages/agent-runtime/claude-code/src/runtime-activity.ts)
  `emitStreamActivity` projects each one into the activity sink. Neither reads
  `parent_tool_use_id`.
- The [TypeScript Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)
  defines `parent_tool_use_id` on `SDKAssistantMessage` and `SDKUserMessage`:
  for subagent messages it is the `tool_use_id` of the spawning `Agent` call,
  `null` for main-session messages.
- Live probe, Claude Code 2.1.272, `--print --input-format stream-json
  --output-format stream-json --verbose`, one foreground and one background
  subagent:
  - Every subagent `assistant` and `user` envelope carried the spawning `Agent`
    call's id in `parent_tool_use_id`; every main-agent envelope carried an
    explicit `null`.
  - Foreground: the subagent's prompt (a `user` text block), its `Bash`
    `tool_use`, and that tool's `tool_result` arrived; its text did not.
  - Background: the subagent's `thinking`, `Bash` `tool_use`, `tool_result`,
    **and its text** arrived — after the main turn's `result`. The documentation
    says a subagent's text needs `--forward-subagent-text`, which Dreamux does
    not pass; for a background subagent that does not hold.
  - Subagent lifecycle arrives as `system` subtypes (`task_started`,
    `task_progress`, `task_updated`, `task_notification`,
    `background_tasks_changed`), which never reach the display line today.
- The deferred divergence this settles is row 4 of
  [claude-code-stream-json-protocol](/.agents/research/claude-code-stream-json-protocol.md).
- The recent-activity reader (`last`) is out of the picture: on 2.1.272 the
  subagent's records live in a separate `subagents/` transcript file, and the
  probed main session file held no record with `isSidechain` or a
  `parent_tool_use_id`.

## Scope and product delta

Touches the product catalog's "Observing agents" behavior: a subagent's
activity is not the agent speaking. Product implementation stays in the Claude
Code runtime package and its tests; knowledge owners describing the display
line are updated.

Non-goals:

- Codex runtimes (the request names Claude Code).
- The recent-activity reader.
- Passing `--forward-subagent-text`, or any subagent-specific row or summary.
- `TurnAggregator`'s fallback `lastAssistantText`, which also reads a background
  subagent's text; it is recorded in the research document, not changed.
- Core, Channel, neutral contracts, configuration, and persisted state.

## Acceptance criteria

1. A `stream` event whose `assistant` or `user` envelope carries a non-null
   `parent_tool_use_id` emits no runtime activity, whatever its blocks are.
2. Main-agent envelopes (`parent_tool_use_id` null or absent) project exactly as
   before, including the main agent's `Agent` call and its result correlated to
   the call's name and arguments.
3. Compaction, interruption, the usage line, and `turn.ended` are unchanged.
4. Build, lint, test, and `typecheck:tests` pass.

## Decisions and unknowns

- Confirmed operator decisions (question card, 2026-09-17):
  - Task: 「新建任务」 under `channel`.
  - The main agent's own `Agent` call row: 「保留」.
  - Solution path: 「最小改动快速通道」.
- Assumptions: None.
- Blocking unknowns: None.
