---
name: dispatcher-workflow
description: MCP operation notes for Dispatcher orchestration. Load before using TeamMate, Team, workflow, channel, or cron tools, including spawning or messaging TeamMates, creating or dissolving Teams, running workflows, replying or routing through channel tools, and managing cron jobs.
---

# Dispatcher Workflow

Use `dreamux-maintenance` instead for Dreamux server operation, host diagnosis,
daemon/service/config/log work, or missing-reply investigations.

## TeamMate MCP Notes

- `spawn`, `send`, `close`, `list`, `status`, `history`, `last`, and
  `get_capabilities` operate on this Dispatcher's TeamMates.
- `spawn.name_prefix` is only a requested label; use the returned concrete
  `teammate.name` for every later `send`, `status`, `last`, or `close`.
- `send` submits a follow-up and reopens a closed TeamMate from its recorded
  runtime-native session.
- After a complete `spawn` or `send`, wait for the TeamMate completion that
  Dreamux pushes into the current context. Every settled turn is reported,
  including one that failed or was stopped. Use `status`, `last`, or `history`
  for explicit status checks, recovery, or suspected delivery failure.
- `history` is compact recovery search. `last` reads the TeamMate's recent
  activity records by concrete name without starting a runtime, so it also
  shows a turn that is still running.
- Use `get_capabilities.agent_runtimes[].id` for `spawn.agent_runtime`.
- `spawn.repo` is optional. Omitted creates a plain per-TeamMate work directory
  following the dispatcher's global workspace policy; `mode: managed` creates a
  git worktree; `mode: reuse-cwd` runs in an existing path.

## Workflow MCP Notes

- `workflow_run`, `workflow_status`, `workflow_stop`, and `workflow_list` are on
  the same TeamMate server and operate on this Dispatcher's workflow runs.
- Load the bundled `workflow` skill before writing a workflow script.
- `workflow_run` returns `{ run_id }` immediately; Dreamux pushes one terminal
  completion when the run finishes.

## Team MCP Notes

- `create`, `send`, `list`, `status`, `history`, and `dissolve` operate on
  dispatcher-owned Teams. There is no Team routing tool: where a Team is
  reachable from the outside is a channel fact, not a Team one.
- `create.name_prefix` is only a requested label. Use the returned concrete,
  never-reused `team_name` for every later Team operation.
- `create` starts a TeamLeader. `send` submits a turn to that TeamLeader only;
  it does not message Team members directly and does not post to a channel.
- `create.prompt` is optional. Without it, the TeamLeader starts idle until a
  routed channel inbound or a later Team `send`.
- `dissolve` is a submission. It returns `{ accepted, team_name, status:
  submitted }` as soon as the request is accepted, and never reports how the
  dissolve went. Include a clear `note`: it records why a recoverable Team was
  stopped.
- Uncommitted, untracked, or unmerged work in a Team's managed worktree leaves
  that Team open and running instead of closing it. Read the Team's `status`
  afterwards to see what actually happened; do not report a Team as dissolved
  because the receipt came back.
- `dissolve.force: true` discards that local work so the managed checkout can be
  removed. It never deletes the managed branch, its commits, a reused directory,
  or the source repository.

## Channel Notes

- Channel tools come from the connected channel's own MCP server, and that
  server is the authority on their names, arguments, and results. Read the
  active tool schema rather than assuming a shape.
- Routing a conversation to a Team is a channel operation, not a Team one. The
  built-in Feishu channel exposes `bind_channel`, `unbind_channel`, and
  `list_bindings` for it, plus its own collaboration-space policy tools. A
  rebind reports the previous Team; there is no separate transfer tool.
- A bind names an existing, open Team. Binding to a missing or closed Team is
  refused and changes no routing.
- If a channel reply tool is available for the source message, use it for
  meaningful progress, blockers, and final status. Assistant text, terminal
  output, and internal planning are not channel delivery.
- At key task milestones, report progress promptly. Prefer the reply tool for
  the latest user message's channel source in the current task when that
  tool is available.
- Reply to the source message or target unless the request names a different
  visible target and the exposed channel tool supports that target.
- Treat channel target selectors as channel-owned. Do not infer them from this
  guidance; use the exposed tool schema and results.

## Cron Notes

- `cron_create`, `cron_list`, `cron_update`, and `cron_delete` operate on durable
  jobs for this Dispatcher.
- Cron prompts wake this Dispatcher. They do not spawn TeamMates or Teams and do
  not deliver visible channel messages by themselves.
- A due job is submitted immediately through ordinary admission, so it may fold
  into a turn that is already running.
- Prefer explicit titles and time zones. Off-hour or off-half-hour schedules are
  less likely to collide with other jobs.
- Jobs fire on their configured schedules. Use `cron_update` to change a job's
  schedule when you need a different fire time.
