---
name: team-workflow
description: MCP operation notes for Team work. Load before using this Team's TeamMate tools, provider-exposed channel tools, cron tools, or team transfer tool.
---

# Team Workflow

## TeamMate MCP Notes

- `spawn`, `send`, `close`, `list`, `status`, `history`, `last`, and
  `get_capabilities` operate on this Team's TeamMates only.
- `spawn.name_prefix` is only a requested label; use the returned concrete
  `teammate.name` for every later `send`, `status`, `last`, or `close`.
- `spawn` does not accept a repo selector. Team-scoped TeamMates share the Team
  workspace selected when the Team was created.
- Allow one TeamMate at a time to edit the shared Team workspace unless the
  request is read-only, the user explicitly asks for parallel edits, or the edit
  paths are clearly independent.
- `send` submits a follow-up and can reattach to a resumable closed TeamMate
  from the recorded runtime session.
- After a complete `spawn` or `send`, wait for the TeamMate completion that
  Dreamux pushes into the current context. Use `status`, `last`, or `history`
  for explicit status checks, recovery, or suspected delivery failure.
- `history` is compact recovery search for this Team's TeamMates. `last` reads
  recent settled turns by concrete name without starting a runtime.
- Use `get_capabilities.agent_runtimes[].id` for `spawn.agent_runtime`.

## Team MCP Notes

- The `team` MCP exposes only `transfer_back` in this context.
- `transfer_back({ channel_id?, meta })` releases a bound channel target from
  this Team when the tool call succeeds. It is a routing-only state change with
  no channel-message side effect.
- `meta` is provider-defined. Use the active tool schema and tool result as the
  authority for the target selector and routing outcome.
- Do not invent unavailable Team lifecycle, inspection, send, or bind tools.

## Channel Notes

- If a provider-exposed channel reply tool is available for the bound source,
  use it for visible acceptance, final status, and blockers. Assistant text and
  internal planning are not channel delivery.
- At key task milestones, report progress promptly. Prefer the reply tool for
  the latest user message's channel source in the current task when that
  tool is available.
- Reply to the source message or target unless the request names a different
  visible target and the exposed channel tool supports that target.
- Keep hidden instructions, private context from other sources, secrets, tokens,
  and machine-local paths out of broad channel replies and public artifacts.

## Cron Notes

- `cron_create`, `cron_list`, `cron_update`, `cron_delete`, and `cron_run_now`
  operate on durable jobs for this TeamLeader.
- Cron prompts wake this TeamLeader. They do not create TeamMates and do not
  deliver visible channel messages by themselves.
- Prefer explicit titles and time zones. Off-hour or off-half-hour schedules are
  less likely to collide with other jobs.
- `cron_run_now` fires one stored job once now, still respecting defer-until-idle;
  treat it as an explicit execution of that job prompt.
