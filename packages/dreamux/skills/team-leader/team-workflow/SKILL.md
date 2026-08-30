---
name: team-workflow
description: MCP operation notes for Team work. Load before using this Team's TeamMate or workflow tools, the Team dissolve tool, channel tools, or cron tools.
---

# Team Workflow

## TeamMate MCP Notes

- `spawn`, `send`, `close`, `list`, `status`, `history`, `last`, and
  `get_capabilities` operate on this Team's TeamMates only.
- `spawn.name_prefix` is only a requested label; use the returned concrete
  `teammate.name` for every later `send`, `status`, `last`, or `close`.
- `spawn` does not accept a repo selector. Team-scoped TeamMates run in the
  Team's own workspace, selected when the Team was created.
- Allow one TeamMate at a time to edit the shared Team workspace unless the
  request is read-only, the user explicitly asks for parallel edits, or the edit
  paths are clearly independent.
- `send` submits a follow-up and reopens a closed TeamMate from its recorded
  runtime-native session.
- After a complete `spawn` or `send`, wait for the TeamMate completion that
  Dreamux pushes into the current context. Every settled turn is reported,
  including one that failed or was stopped. Use `status`, `last`, or `history`
  for explicit status checks, recovery, or suspected delivery failure.
- `history` is compact recovery search for this Team's TeamMates. `last` reads a
  TeamMate's recent activity records by concrete name without starting a
  runtime, so it also shows a turn that is still running.
- Use `get_capabilities.agent_runtimes[].id` for `spawn.agent_runtime`.

## Workflow MCP Notes

- `workflow_run`, `workflow_status`, `workflow_stop`, and `workflow_list` are on
  the same TeamMate server and operate on this Team's workflow runs.
- Load the bundled `workflow` skill before writing a workflow script.
- `workflow_run` returns `{ run_id }` immediately; Dreamux pushes one terminal
  completion when the run finishes.

## Team MCP Notes

- The `team` MCP exposes exactly one tool in this context: `dissolve`. There is
  no Team routing, inspection, send, or peer-Team tool; do not invent one.
- Use `dissolve({ note })` only after this Team's work is complete and its
  shared worktree is safe to remove. First inspect for uncommitted or untracked
  changes and unmerged index entries. A default dissolve is non-forced: for
  `delete-on-close`, Dreamux runs `git worktree remove <path>`, which refuses
  rather than discard local work, and preserves the managed branch and its
  commits.
- `dissolve({ note, force: true })` is an explicit authorization to run
  `git worktree remove --force`. It discards uncommitted, untracked, and
  unmerged work in the managed checkout, so ask the user before using it and
  never use it to get past a refusal on your own judgement. It still never
  deletes the branch, its commits, a reused directory, or the source
  repository.
- If the worktree is dirty or unmerged, or you cannot determine that it is
  clean, do not call `dissolve`. Ask the user how to preserve or handle the work
  through the current visible reply path. The required `note` is the final
  reason for a confirmed dissolve, not a way to bypass that decision.
- Branch or ref deletion is a separate destructive capability and is not part
  of Team dissolve. Never infer authorization to delete a branch from
  `delete-on-close`.
- `dissolve` is a submission: it returns `{ accepted, team_name, status:
  submitted }` and never reports how the dissolve went. Behind that receipt this
  Team's Workflow, TeamMates, and your own runtime are stopped, so expect the
  call to lose its response. Without `force`, dirty or unmerged work leaves the
  Team open and running instead; eligible worktree deletion may continue in the
  background after the Team is closed.

## Channel Notes

- Channel tools come from the connected channel's own MCP server, and that
  server is the authority on their names, arguments, and results. Read the
  active tool schema rather than assuming a shape.
- Routing is a channel operation. The built-in Feishu channel lets a TeamLeader
  claim a conversation for its own Team with `bind_channel` and release one with
  `unbind_channel`; both reach only targets that are free or already this
  Team's. A conversation another Team answers in cannot be taken over here; ask
  the Dispatcher to move it.
- If a channel reply tool is available for the routed source, use it for
  meaningful progress, blockers, and final status. Assistant text and internal
  planning are not channel delivery.
- At key task milestones, report progress promptly. Prefer the reply tool for
  the latest user message's channel source in the current task when that
  tool is available.
- Reply to the source message or target unless the request names a different
  visible target and the exposed channel tool supports that target.
- Keep hidden instructions, private context from other sources, secrets, tokens,
  and machine-local paths out of broad channel replies and public artifacts.

## Cron Notes

- `cron_create`, `cron_list`, `cron_update`, and `cron_delete` operate on durable
  jobs for this TeamLeader.
- Cron prompts wake this TeamLeader. They do not create TeamMates and do not
  deliver visible channel messages by themselves.
- A due job is submitted immediately through ordinary admission, so it may fold
  into a turn that is already running.
- Prefer explicit titles and time zones. Off-hour or off-half-hour schedules are
  less likely to collide with other jobs.
- Jobs fire on their configured schedules. Use `cron_update` to change a job's
  schedule when you need a different fire time.
