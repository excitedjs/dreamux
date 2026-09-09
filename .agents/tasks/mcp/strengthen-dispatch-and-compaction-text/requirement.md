# Requirement

## Initial request and decisions

The operator requested two wording changes on 2026-09-09, starting from `next`:

1. Strengthen the successful `team.create`, `teammate.spawn`, `teammate.send`,
   and `workflow_run` text because Codex has resumed polling after dispatch.
   The operative words are "禁止轮询。等待系统回推。" (no polling; wait for
   the system push). Wording may change, but it must be an explicit instruction.
2. Change the COT label `Compacted session`: "改成全大写" (all uppercase).

The operator answered "可以。" to creating one combined, minimal-change task
linked to the earlier model-facing refinement, with the shared `team.send`
reminder included and both runtime labels changed. This confirms task creation
and the fast path, not development approval.

On reviewing the proposed imperatives, the operator said "有点硬了啊，你翻一翻
前面是怎么写的" (too forceful; check the earlier wording), then clarified
"就是改成这一版之前的那一版" (the version immediately before this one).
The relevant historical text is the parent of `dc2b7eb` (#380), verified with
`git show dc2b7eb^:packages/dreamux/src/service/mcp/dispatch-reminders.ts`.
Use that exact three-string version as the revised solution, not newly authored
all-caps commands or a hybrid of the old and current reminders. The operator
approved this revised solution on 2026-09-09: "可以，开始开发" (approved;
start development).

## Approved additional request

The operator added on 2026-09-09: "就是绑定和解绑两个工具，也额外返回一句text。
内容是绑定成功。系统会自动推送通知卡片。不需要额外通知用户" (binding and
unbinding should also return text saying the operation succeeded, the system
will send a notification card, and no additional user notification is needed).

Source facts when the additional scope was confirmed:

- Feishu `bind_channel` and `unbind_channel` each have Dispatcher and TeamLeader
  definitions in `/packages/channel/feishu-channel/src/tools/routing-tools.ts`.
  Their common handlers currently return structured data only.
- `/packages/channel/feishu-channel/src/feishu-session-bindings.ts` already
  schedules the notification on every successful bind and actual unbind. An
  unbind returning `team_name: null` changes nothing and schedules no card.
- `ChannelMcpToolOutcome` in `/packages/dreamux-types/src/channel.ts` currently
  carries only the result object or refusal. Core's
  `/packages/dreamux/src/service/channel-service/mcp-delegate.ts` projects that
  object as `structured` and has no success-text carrier at this boundary.

Approved boundary: only successful `bind_channel` and actual `unbind_channel`
results gain a separate MCP text reminder; output data, permissions, notification
cards, and their best-effort delivery remain unchanged. Say binding or unbinding
as appropriate, never claim success or card delivery for a no-op or refusal.
Collaboration-space tools are not included. A provider-neutral optional success
text must cross the existing Channel result boundary; Core must not recognize
Feishu tool names or author the reminder.

The operator approved the expanded solution and combined implementation on
2026-09-09: "可以，合并做了就行" (approved; implement together). This includes
the Channel success-text capability and continued direct TeamLeader implementation
with one independent read-only review.

## User stories and current facts

- A coordinating agent submits work, reads the acceptance receipt, and must
  wait for the completion push instead of querying progress to await a result.
  Independent work and answering the user remain possible.
- An operator observing a context compaction in a COT card sees exactly
  `COMPACTED SESSION`, without the runtime's summary.
- At base `dd2fc68`, the three strings in
  `/packages/dreamux/src/service/mcp/dispatch-reminders.ts` promise notification
  and prohibit predicting results, but contain no explicit no-polling instruction.
  The reported Codex behavior is operator-observed, not independently reproduced.
- `/packages/dreamux/src/service/team-collection/mcp-delegate.ts` attaches the
  Team reminder only to a prompt-bearing `create` with status `created`, and to
  `send` with status `submitted`. TeamMate submitted receipts and workflow runs
  use `/packages/dreamux/src/service/teammate-collection/mcp-delegate.ts`.
- The literal label belongs to each runtime: Codex
  `/packages/agent-runtime/codex/src/turn-manager.ts`, Claude Code
  `/packages/agent-runtime/claude-code/src/runtime-activity.ts`. Both publish an
  ordinary `assistant.message`; no channel-side case conversion is needed.

## Scope and invariants

- Restore the three receipt strings from immediately before `dc2b7eb`, including
  their existing shared `team.send` consumer. They prohibit polling for completion,
  explain automatic push delivery, and allow natural turn ending when no other
  work remains. Restore them exactly rather than retaining the current strings'
  result-unknown and shared-file cautions or adding new forceful language.
- Replace the two emitted labels with `COMPACTED SESSION` and align their tests.
- Preserve receipt attachment conditions, structured results, schemas, tool
  descriptions, role prompts, skills, dispatch behavior, completion delivery,
  activity types, compaction timing, and summary suppression.
- Do not disable observation tools or remove the operator's explicit progress
  inspection capability. The prohibition concerns autonomous checking to await
  the dispatched result, not an unrelated operator-requested inspection.
- The additional binding text extends only the existing internal Channel success
  result and Feishu tool definition. No new runtime-specific Core rule, polling
  blocker, retry, timeout, MCP tool, dependency, state/config change, service
  restart, or deployment is introduced.
- Product catalog impact: change the spelling in "A compaction is one line";
  strengthen the receipt guidance associated with "Tools return receipts, work
  runs behind them" without changing delivery or "last is the mid-turn progress
  window" capabilities.

## Acceptance criteria

1. Applicable successful receipts match the three pre-`dc2b7eb` strings quoted
   in the final solution: normal-case no-polling guidance, automatic completion
   push, and natural turn ending. Do not introduce the rejected all-caps commands.
2. Idle creation, creation replay, failed admission, and ordinary read results
   gain no new reminder. Structured results and tool exposure stay unchanged.
3. Both providers emit exactly `COMPACTED SESSION` for the existing compaction
   event, with no summary, additional event, or timing change.
4. Successful `bind_channel` and actual `unbind_channel` calls in both caller
   scopes return the approved notification reminder beside unchanged structured
   data. No-op unbinds, refusals, and unrelated tools get no success reminder.
   Core forwards provider-owned text without recognizing Feishu tools.
5. Existing attachment, protocol, and runtime behavior checks remain intact;
   build, lint, tests, test typechecking, and knowledge validation pass or any
   environmental limitation is reported explicitly.

## Constraints and unknowns

- Wording is not a runtime enforcement mechanism. Automated receipt assertions
  cannot establish that every future Codex turn will obey the instruction.
  Live model behavior remains an acceptance observation, not a deterministic
  guarantee of this text-only task.
- All three items are approved for combined implementation and one independent
  read-only review. The task README records development and PR authorization.
