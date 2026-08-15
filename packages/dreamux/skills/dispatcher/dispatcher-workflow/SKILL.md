---
name: dispatcher-workflow
description: MCP operation notes for Dispatcher orchestration. Load before using TeamMate, Team, channel, or cron tools, including spawning or messaging TeamMates, creating or routing Teams, replying through provider-exposed channel tools, and managing cron jobs.
---

# Dispatcher Workflow

Use `dreamux-maintenance` instead for Dreamux server operation, host diagnosis,
daemon/service/config/log work, or missing-reply investigations.

## TeamMate MCP Notes

- `spawn`, `send`, `close`, `list`, `status`, `history`, `last`, and
  `get_capabilities` operate on this Dispatcher's TeamMates.
- `spawn.name_prefix` is only a requested label; use the returned concrete
  `teammate.name` for every later `send`, `status`, `last`, or `close`.
- `send` submits a follow-up and can reattach to a resumable closed TeamMate
  from the recorded runtime session.
- After a complete `spawn` or `send`, wait for the TeamMate completion that
  Dreamux pushes into the current context. Use `status`, `last`, or `history`
  for explicit status checks, recovery, or suspected delivery failure.
- `history` is compact recovery search. `last` reads recent settled turns by
  concrete name without starting a runtime.
- Use `get_capabilities.agent_runtimes[].id` for `spawn.agent_runtime`.
- `spawn.repo` is optional. Omitted creates a plain per-TeamMate work directory
  following the dispatcher's global workspace policy; `mode: managed` creates a
  git worktree; `mode: reuse-cwd` runs in an existing path.

## Team MCP Notes

- `create`, `send`, `list`, `status`, `history`, `dissolve`, `bind_channel`, and
  `transfer_back` operate on dispatcher-owned Teams.
- `create.name_prefix` is only a requested label. Use the returned concrete,
  never-reused `team.team_name` for every later Team operation.
- `create` starts a TeamLeader. `send` submits a turn to that TeamLeader only;
  it does not message Team members directly and does not post to a channel.
- `create.prompt` is optional. Without it, the TeamLeader starts idle until a
  bound-channel inbound or later `team.send`.
- `bind_channel` and `transfer_back` are Team MCP tools. They take
  `channel_id?` plus provider-defined `meta`; rely on the active tool schema and
  tool result for the exact target selector and routing outcome.
- Do not claim a channel target is bound to a Team unless `bind_channel` returns
  success. Do not claim a channel target is released from Team routing unless
  `transfer_back` returns success.
- `dissolve` closes a recoverable Team and its agents. Include a clear `note`.

## Collaboration Space MCP Notes

- `bind`, `dissolve`, `status`, and `list` operate on dispatcher-owned
  collaboration spaces.
- Use `bind` only for an external collaboration space that already exists. If
  the space is unknown to Dreamux, pass the provider-owned opaque `container`
  selector; Dreamux core does not create the external space through a channel
  provider.
- `bind.repo` is optional. Omitted uses the same default workspace policy as
  Team creation without an explicit repo; supplied repo creates managed
  worktrees for future target Teams.
- `bind.identity`, when supplied, becomes the default TeamLeader identity for
  future Teams automatically created under that bound collaboration space.
- Some channels may enable core-owned default collaboration-space binding; then
  a neutral provider `container` can be auto-bound on first target inbound
  without an explicit `collaboration_space.bind` call.
- `dissolve` releases Dreamux routing/provisioning for the collaboration space.
  It does not delete the external space and does not dissolve already-created
  Teams; those Teams remain visible and can be closed with Team MCP.
- Use `status` or `list` for inspection. There is no `history` tool for
  collaboration spaces.

## Channel Notes

- If a provider-exposed channel reply tool is available for the source message,
  use it for visible acceptance, final status, and blockers. Assistant text,
  terminal output, and internal planning are not channel delivery.
- At key task milestones, report progress promptly. Prefer the reply tool for
  the latest user message's channel source in the current task when that
  tool is available.
- Reply to the source message or target unless the request names a different
  visible target and the exposed channel tool supports that target.
- Treat channel attributes and `meta` selectors as provider-owned. Do not infer
  provider-specific fields from Dreamux core guidance; use the exposed tool
  schema and results.

## Cron Notes

- `cron_create`, `cron_list`, `cron_update`, and `cron_delete` operate on durable
  jobs for this Dispatcher.
- Cron prompts wake this Dispatcher. They do not spawn TeamMates or Teams and do
  not deliver visible channel messages by themselves.
- Prefer explicit titles and time zones. Off-hour or off-half-hour schedules are
  less likely to collide with other jobs.
- Jobs fire on their configured schedules. Use `cron_update` to change a job's
  schedule when you need a different fire time.
