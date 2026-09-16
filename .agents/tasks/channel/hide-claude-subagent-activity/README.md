# Hide Claude Code subagent activity

## Current state

- Goal: Report only the main agent's activity from the Claude Code runtime; a subagent's envelopes produce no runtime activity
- State: `review`
- Requirement: [Current requirement](/.agents/tasks/channel/hide-claude-subagent-activity/requirement.md), revision 2026-09-17.
- Final solution: [Envelope-level subagent filter](/.agents/tasks/channel/hide-claude-subagent-activity/technical-design/final.md).
- Solution workflow: Operator selected the minimal-change fast path on 2026-09-17.
- Solution review Issue: Omitted under the selected fast path.
- Blockers: None.
- Next action: Independent review of the pushed branch.
- Verification: [Wire evidence, checks, and coverage limits](/.agents/tasks/channel/hide-claude-subagent-activity/verification.md).
- Related tasks: Settles deferred row 4 of [claude-code-stream-json-protocol](/.agents/research/claude-code-stream-json-protocol.md); builds on [Feishu COT cards](/.agents/tasks/channel/feishu-cot-conversation-cards/README.md).

## Development approval

- Status: Granted 2026-09-17.
- Card: a development-authorization question card sent 2026-09-17 in the task's
  Feishu topic, playing back the requirement (report only the main agent's
  activity; drop every envelope with a non-null `parent_tool_use_id`; keep the
  main agent's own `Agent` call row), the envelope-level filter in
  `emitStreamActivity`, the non-goals, and the verification plan, and asking
  whether the operator approves it and wants the team to enter development.
- Approving response, 2026-09-17, the same day: "批准，进入开发 (Recommended)".
- Approved requirement: [requirement.md](/.agents/tasks/channel/hide-claude-subagent-activity/requirement.md)
- Approved solution: [final.md](/.agents/tasks/channel/hide-claude-subagent-activity/technical-design/final.md)
- Approved implementation boundary: `packages/agent-runtime/claude-code/` source
  and tests, the display-line section of `.agents/domains/provider-runtime.md`,
  the "Observing agents" entry of `.agents/product/README.md`, row 4 of
  `.agents/research/claude-code-stream-json-protocol.md`, this task record, and a
  Rush change file.

## Delivery

- Pull request: Not opened.
- Knowledge closeout: Pending.
