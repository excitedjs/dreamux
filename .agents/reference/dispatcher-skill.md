# Reference: bundled Dreamux skills

`/packages/dreamux/skills/` contains Dreamux-owned skills shipped in the npm
package. The skill directories are grouped by role so runtimes that scan parent
directories do not expose another role's skills:

- `skills/dispatcher/dispatcher-workflow` is injected only into Dispatcher
  runtimes. It covers provider-visible replies and dispatcher-visible
  TeamMate/Team/cron MCP cautions.
- `skills/dispatcher/dreamux-maintenance` is injected only into Dispatcher
  runtimes. It covers Dreamux host/server operation, `dreamux doctor` /
  `status` / `changelog` cautions, service/config/state/run/log diagnosis,
  missing-reply and stuck-turn troubleshooting, and bundled-skill injection
  diagnosis.
- `skills/team-leader/team-workflow` is injected only into TeamLeader runtimes.
  It covers team-scoped TeamMate MCP cautions, shared Team workspace
  coordination, provider-visible bound-channel replies, TeamLeader cron
  cautions, and the scoped `transfer_back` tool.

Ordinary TeamMate and team-member runtimes receive no bundled Dreamux skill by
default.

The skills intentionally avoid fixed workflow recipes. They are guardrails for
which role can see which MCP surface and what mistakes to avoid.

When changing bundled skills, prompts, MCP descriptions, or tests that lock
model-visible wording, also follow
[Model-facing writing](model-facing-writing.md).

## Injection Strategy

Bundled skills are injected at runtime by role. Dispatcher and TeamLeader launch
sites pass role-specific skill roots through the Agent Runtime create context as
`skillSources`; the runtime package applies those roots to its engine:

- Codex dedupes the supplied role roots and calls `skills/extraRoots/set` after
  initialize and before thread start/resume. The package layout deliberately
  gives Dispatcher and TeamLeader skills different roots.
- Claude Code materializes runtime-owned `.claude/skills/<name>` add-dir roots
  and passes them through `--add-dir`.

Admin-supplied custom skill roots use the same neutral create-context shape, but
core first normalizes them into canonical absolute readable directories and
rejects duplicate roots or duplicate direct-child skill names. TeamLeader roots
also reserve the bundled `team-workflow` skill name, so custom roots cannot
shadow the required Team workflow skill.

`dreamux onboard` and dispatcher startup do not install bundled skills into a
workspace. Bundled skills are package-shipped runtime injection sources.

## Dispatcher-Visible MCP

Dispatcher `teammate` MCP tools are `spawn`, `send`, `close`, `list`, `status`,
`history`, `last`, and `get_capabilities`. `spawn.name_prefix` is only a
requested label; the returned concrete `teammate.name` is the address for every
later call. `send` is also the reattach path for a closed TeamMate when the
runtime can resume it from the recorded session.

Dispatcher `team` MCP tools are `create`, `send`, `list`, `status`, `history`,
`dissolve`, `bind_channel`, and `transfer_back`. Team lifecycle is addressed by
`team_name`. `bind_channel({ team_name, channel_id?, meta })` routes an existing
channel target to a Team, and `transfer_back({ channel_id?, meta })` releases a
bound target from Team routing. `meta` is provider-owned; the active channel
provider's tool schema and results are the authority for the target selector.

Dispatcher `cron` MCP tools are `cron_create`, `cron_list`, `cron_update`,
`cron_delete`, and `cron_run_now`. Cron prompts are injected back into the
Dispatcher; they are not a TeamMate spawn target or channel delivery mechanism by
themselves.

Dispatcher `collaboration_space` MCP tools are `bind`, `dissolve`, `status`,
and `list`. They register and inspect already-created neutral channel
containers, such as topic-group spaces, and route future targets in those spaces
to provisioned Teams. They do not create the external provider space, delete it,
or expose a `history` surface.

## TeamLeader-Visible MCP

TeamLeader `teammate` MCP tools are `spawn`, `send`, `close`, `list`, `status`,
`history`, `last`, and `get_capabilities`, scoped to the Team's members.
TeamLeader `spawn` does not accept a `repo` input because the Team workspace is
already selected when the Team is created. Team-scoped TeamMates share that
workspace, so concurrent editing needs an explicit non-conflict boundary.

TeamLeader `team` MCP exposes only `transfer_back({ channel_id?, meta })`.
TeamLeaders cannot create, send to, list, inspect, dissolve, or bind Teams
through their scoped Team MCP projection. `transfer_back` is a routing operation;
it is a routing-only state change with no channel-message side effect.

TeamLeader `cron` MCP tools are `cron_create`, `cron_list`, `cron_update`,
`cron_delete`, and `cron_run_now`. Cron prompts are injected back into that
TeamLeader.
