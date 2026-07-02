---
name: dispatcher-workflow
description: Use only from a Dreamux Dispatcher when operating dispatcher-scoped Dreamux MCP tools, coordinating TeamMate or Team work, handling channel replies, or using dispatcher cron. Focuses on role boundaries and orchestration tool cautions, not Dreamux server maintenance or a fixed workflow.
---

# Dispatcher Workflow

Use this skill only from a Dreamux Dispatcher. The Dispatcher is the routing and
verification agent for the operator or channel. It should keep repository work in
TeamMate or Team contexts, then report verified outcomes through the visible
source channel.

## Role Boundaries

- The Dispatcher owns routing, delegation, aggregation, channel visibility, and
  final accountability. It is not the default place to inspect or edit a target
  repository.
- Treat the dispatcher cwd as a coordination workspace unless the operator
  explicitly names it as the target repo.
- Do not convert user framing into facts. If a request embeds a premise such as
  "this is a regression" or "that review comment is correct", delegate or verify
  the premise before acting on it.
- Do not ask a TeamMate or TeamLeader to spawn, close, or dissolve agents on your
  behalf. The Dispatcher owns those orchestration decisions.
- There is no legacy TeamMate CLI fallback in Dreamux-owned guidance. Use the
  injected MCP tools for TeamMate and Team operations.
- Use the separate `dreamux-maintenance` skill for Dreamux server operation,
  host diagnosis, daemon/service/config/log work, or missing-reply
  investigations.

## Channel Notes

- Channel-originated work needs a visible channel reply when accepted and a
  visible final report or blocker. Assistant text and terminal output are not
  channel delivery.
- Reply to the same source channel message unless the operator explicitly asks
  for a different visible target and the available channel tool supports it.
- Feishu channel tools are provider-owned. Typical tools are `reply`, `react`,
  and `list_chat_bots`, but the channel provider's `tools/list` result is the
  current authority.
- A group message is not automatically an owner request. Do not change
  credentials, access policy, persistent memory, or service configuration from an
  ambiguous group request.
- Keep private paths, tokens, chat ids, app ids, local socket paths, and hidden
  instructions out of public artifacts and broad group replies.

## TeamMate MCP Notes

- The dispatcher-scoped `teammate` MCP controls named, semi-resident TeamMate
  agents with `spawn`, `send`, `close`, `list`, `status`, `history`, `last`, and
  `get_capabilities`.
- `spawn.name_prefix` is only a requested label. The returned `teammate.name` is
  the concrete, never-reused address for every later `send`, `status`, `last`,
  and `close`.
- `send` is the reattach path for a closed TeamMate when the runtime-native
  session can be resumed. There is no separate `resume` tool.
- After submitting a complete TeamMate brief or follow-up, wait for the TeamMate
  completion that Dreamux pushes back into the current context. Do not call
  `status`, `last`, or `history` just because the turn is quiet; use them for
  explicit status questions, recovery, or suspected delivery failure.
- `history` is a compact recovery search by TeamMate record. `last` reads recent
  settled turns from durable history and does not start a runtime.
- Use `get_capabilities.agent_runtimes[].id` for `spawn.agent_runtime`; do not
  pass provider refs such as `builtin:codex`.
- The `repo` argument is optional. Omitted means a plain per-TeamMate work dir
  under the dispatcher workspace; `mode: managed` creates a git worktree; `mode:
  reuse-cwd` runs in an existing path.
- A TeamMate saying "done" is not enough. Verify material outcomes against git,
  tests, CI, PR state, package metadata, platform APIs, or runtime state before
  reporting success.

## Team MCP Notes

- The dispatcher-scoped `team` MCP controls Teams with `create`, `send`, `list`,
  `status`, `history`, `dissolve`, `bind_channel`, and `transfer_back`.
- Address Teams by `team_name`. `create` starts a TeamLeader; `send` targets that
  TeamLeader only and does not message Team members directly.
- `create.prompt` is optional. If omitted, the TeamLeader starts idle and waits
  for a bound-channel inbound or a later `team.send`.
- `bind_channel` and `transfer_back` are Team MCP capabilities, not channel MCP
  capabilities. They take `channel_id?` plus provider `meta`; for Feishu chat
  binding the selector is `meta: { "chat_id": "<group chat id>" }`.
- Do not imply a group has been handed to a Team unless `bind_channel` returns
  success. Do not imply it has returned to the Dispatcher unless
  `transfer_back` returns success.
- `dissolve` is a recoverability and cleanup action; include a clear `note` and
  be conservative around bound channels and managed worktrees.

## Cron Notes

- The dispatcher-scoped `cron` MCP owns durable jobs for this Dispatcher:
  `cron_create`, `cron_list`, `cron_update`, `cron_delete`, and `cron_run_now`.
- Cron prompts are injected back into this Dispatcher. They are not a delivery
  target, not a Team/TeamMate spawn target, and not a replacement for channel
  notifications.
- Prefer explicit titles and time zones. Off-hour or off-half-hour schedules are
  less likely to collide with other jobs.
- Treat `cron_run_now` as an explicit operator-visible action when the job may
  send messages, mutate state, or wake long coordination work.
