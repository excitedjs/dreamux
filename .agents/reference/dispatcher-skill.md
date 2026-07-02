# Reference: bundled Dreamux skills

`/packages/dreamux/skills/` contains Dreamux-owned skills shipped in the npm
package. They are model-facing notes for the agent roles that can operate
Dreamux MCP tools:

- `dispatcher-workflow` is injected only into Dispatcher runtimes. It covers
  dispatcher role boundaries, channel-visible replies, dispatcher-visible
  TeamMate/Team/cron MCP cautions, and public-artifact safety.
- `dreamux-maintenance` is injected only into Dispatcher runtimes. It covers
  Dreamux host/server operation, `dreamux doctor` / `status` / `changelog`
  cautions, service/config/state/run/log diagnosis, missing-reply and stuck-turn
  troubleshooting, and bundled-skill injection cleanup boundaries.
- `team-workflow` is injected only into TeamLeader runtimes. It covers
  TeamLeader role boundaries, team-scoped TeamMate MCP cautions, bound-channel
  replies, TeamLeader cron cautions, and the scoped `transfer_back` tool.

Ordinary TeamMate and team-member runtimes receive no bundled Dreamux skill by
default.

The skills intentionally avoid fixed workflow recipes. They are guardrails for
which role can see which MCP surface and what mistakes to avoid.

## Injection Strategy

Bundled skills are injected at runtime by role. Core selects skill sources with
`bundledSkillSourcesForRole(role)` and passes them through the Agent Runtime
create context as `skillSources`; the runtime package applies them to its engine:

- Codex dedupes parent directories and calls `skills/extraRoots/set` after
  initialize and before thread start/resume.
- Claude Code materializes runtime-owned `.claude/skills/<name>` add-dir roots
  and passes them through `--add-dir`.

`dreamux onboard` and dispatcher startup no longer symlink skills into
`<dispatcher cwd>/.codex/skills`. An old symlink dir from a prior version is left
untouched and is safe for the operator to delete.

## Dispatcher-Visible MCP

Dispatcher `teammate` MCP tools are `spawn`, `send`, `close`, `list`, `status`,
`history`, `last`, and `get_capabilities`. `spawn.name_prefix` is only a
requested label; the returned concrete `teammate.name` is the address for every
later call. `send` is also the reattach path for a closed TeamMate when the
runtime can resume it; there is no separate `resume` tool.

Dispatcher `team` MCP tools are `create`, `send`, `list`, `status`, `history`,
`dissolve`, `bind_channel`, and `transfer_back`. Team lifecycle is addressed by
`team_name`. `bind_channel({ team_name, channel_id?, meta })` hands an existing
channel target to a Team, and `transfer_back({ channel_id?, meta })` returns a
bound target to the Dispatcher. `meta` is provider-owned; for Feishu group chats
it is `{ "chat_id": "..." }`.

Dispatcher `cron` MCP tools are `cron_create`, `cron_list`, `cron_update`,
`cron_delete`, and `cron_run_now`. Cron prompts are injected back into the
Dispatcher; they are not a TeamMate spawn target or channel delivery mechanism by
themselves.

## TeamLeader-Visible MCP

TeamLeader `teammate` MCP tools are `spawn`, `send`, `close`, `list`, `status`,
`history`, `last`, and `get_capabilities`, scoped to the Team's members.
TeamLeader `spawn` does not accept a `repo` input because the Dispatcher already
selected the Team workspace when the Team was created.

TeamLeader `team` MCP exposes only `transfer_back({ channel_id?, meta })`.
TeamLeaders cannot create, send to, list, inspect, dissolve, or bind Teams
through their scoped Team MCP projection.

TeamLeader `cron` MCP tools are `cron_create`, `cron_list`, `cron_update`,
`cron_delete`, and `cron_run_now`. Cron prompts are injected back into that
TeamLeader.

## Removed tm Surface

`@excitedjs/dreamux` no longer ships a `tm` bin wrapper and no longer depends on
`@excitedjs/tm`. Dreamux-owned prompts and bundled skills must not instruct
models to invoke bare `tm`, install `@excitedjs/tm`, or rely on package-bin PATH
injection. Server-owned TeamMate and Team state is reached through the injected
MCP tools only.
