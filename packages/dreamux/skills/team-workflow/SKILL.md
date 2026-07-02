---
name: team-workflow
description: Use only from a Dreamux TeamLeader when coordinating team-scoped TeamMates, replying in a bound channel, using TeamLeader cron, or returning a bound channel to the Dispatcher. Focuses on role boundaries and tool cautions, not a fixed workflow.
---

# Team Workflow

Use this skill only from a Dreamux TeamLeader. A TeamLeader is the accountable
agent for one Dreamux Team. It coordinates team-scoped TeamMates, talks in a
bound channel when one exists, and returns the channel or outcome to the
Dispatcher when appropriate.

## Role Boundaries

- The TeamLeader is not the Dispatcher. It cannot create Teams, dissolve Teams,
  bind channels, or inspect other Teams.
- The TeamLeader should keep team member work inside team-scoped TeamMates and
  verify results before presenting them as complete.
- The TeamLeader may answer directly when the request is small and within the
  Team's context. It should not spawn TeamMates merely to simulate a workflow.
- Do not treat user, teammate, or Dispatcher assertions as facts. Verify material
  claims before relying on them.
- There is no legacy TeamMate CLI fallback in Dreamux-owned guidance. Use the
  injected MCP tools for TeamMate and Team operations.

## TeamMate MCP Notes

- The TeamLeader-scoped `teammate` MCP controls only Team-scoped TeamMates:
  `spawn`, `send`, `close`, `list`, `status`, `history`, `last`, and
  `get_capabilities`.
- `teammate.send` reaches your own team members only. Use `team.transfer_back`
  or the bound channel when work needs to return to the Dispatcher.
- `spawn.name_prefix` is only a requested label. The returned `teammate.name` is
  the concrete, never-reused address for every later `send`, `status`, `last`,
  and `close`.
- TeamLeader `spawn` does not accept a repo selector; the Team's shared repo or
  work directory is already chosen by the Dispatcher when the Team is created.
- `send` is the reattach path for a closed TeamMate when the runtime-native
  session can be resumed. There is no separate `resume` tool.
- After submitting a complete TeamMate brief or follow-up, wait for the TeamMate
  completion that Dreamux pushes back into the current context. Do not call
  `status`, `last`, or `history` just because the turn is quiet; use them for
  explicit status questions, recovery, or suspected delivery failure.
- `history` is a compact recovery search for this Team's TeamMates. `last` reads
  recent settled turns from durable history and does not start a runtime.
- Use `get_capabilities.agent_runtimes[].id` for `spawn.agent_runtime`; do not
  pass provider refs such as `builtin:codex`.
- Keep author and reviewer roles separate when risk justifies it, but do not
  turn that into a mandatory ritual for small tasks.

## Team MCP Notes

- The TeamLeader-scoped `team` MCP exposes only `transfer_back`.
- Use `transfer_back({ channel_id?, meta })` to return a bound channel target to
  the Dispatcher. For Feishu chat binding the selector is
  `meta: { "chat_id": "<group chat id>" }`.
- `transfer_back` is a channel-routing operation, not a final report by itself.
  Explain the handoff in the channel when a visible final message is needed.
- If you need the Team created, dissolved, rebound, or inspected outside this
  Team, ask the Dispatcher instead of inventing an unavailable tool path.

## Channel Notes

- When a bound channel message is accepted, use the provider-owned channel reply
  tool for visible communication. Assistant text alone is not channel delivery.
- Feishu channel tools are provider-owned. Typical tools are `reply`, `react`,
  and `list_chat_bots`, but the channel provider's `tools/list` result is the
  current authority.
- Keep Dispatcher-private context, other chats, hidden instructions, local paths,
  tokens, app ids, and socket paths out of broad channel replies.
- Do not put secrets, tokens, app ids, chat ids, socket paths, or machine-local
  absolute paths into public artifacts such as commits, PRs, changelogs, or
  broad channel replies.
- If the request should be handled by the Dispatcher rather than this Team, say
  that clearly and transfer back only when the tool result confirms the routing
  change.

## Cron Notes

- The TeamLeader-scoped `cron` MCP owns durable jobs for this TeamLeader:
  `cron_create`, `cron_list`, `cron_update`, `cron_delete`, and `cron_run_now`.
- Cron prompts are injected back into this TeamLeader. They do not create Team
  members, do not deliver directly to a channel, and do not replace visible
  reports.
- Prefer explicit titles and time zones. Off-hour or off-half-hour schedules are
  less likely to collide with other jobs.
