# Reference: bundled Dreamux skills

`/packages/dreamux/skills/` contains Dreamux-owned skills shipped in the npm
package. Role-specific skill directories stay separate so runtimes that scan
parent directories do not expose another role's skills; a shared root is
deliberately composed into both Dispatcher and TeamLeader runtimes:

- `skills/dispatcher/dispatcher-workflow` is injected only into Dispatcher
  runtimes. It covers provider-visible replies and dispatcher-visible
  TeamMate/Team/cron MCP cautions.
- `skills/dispatcher/dreamux-maintenance` is injected only into Dispatcher
  runtimes. Its concise root owns authorization, common diagnosis, reporting,
  and a seven-row routing table. One-level references separately own service
  lifecycle, the host envelope, each built-in provider schema, current V3
  Feishu access, and the managed-daemon self-upgrade SOP. The root and every
  non-upgrade reference remain current-state-only. The self-upgrade reference
  is the narrow generic transition exception: it stages the target package and
  reads that target's changelog and routed owner references rather than carrying
  release-specific schemas or migration recipes.
- `skills/team-leader/team-workflow` is injected only into TeamLeader runtimes.
  It covers team-scoped TeamMate MCP cautions, shared Team workspace
  coordination, provider-visible bound-channel replies, TeamLeader cron
  cautions, and the scoped `transfer_back` tool.
- The shared `workflow` skill at `skills/shared/workflow` is injected into both
  Dispatcher and TeamLeader runtimes. It owns the Dynamic Workflow tool and
  deterministic runner contract.

Ordinary TeamMate and team-member runtimes receive no bundled Dreamux skill by
default.

The workflow skills intentionally avoid fixed recipes. Maintenance adds one
low-freedom exception for an explicitly requested, restart-safe managed-daemon
self-upgrade; ordinary diagnosis loads only the relevant routed reference.

When changing bundled skills, prompts, MCP descriptions, or tests that lock
model-visible wording, also follow
[Model-facing writing](model-facing-writing.md).

## Injection Strategy

Bundled skills are injected at runtime by role. Dispatcher and TeamLeader launch
sites pass their role-specific root plus the shared root through the Agent
Runtime create context as `skillSources`; the runtime package applies those
roots to its engine:

- Codex dedupes the supplied roots and calls `skills/extraRoots/set` after
  initialize and before thread start/resume. The package layout deliberately
  gives Dispatcher and TeamLeader skills different role roots while composing
  the shared root into both.
- Claude Code materializes runtime-owned `.claude/skills/<name>` add-dir roots
  and passes them through `--add-dir`.

Admin-supplied custom skill roots use the same neutral create-context shape, but
core first normalizes them into canonical absolute readable directories and
collapses duplicate roots while rejecting duplicate direct-child skill names.
For TeamLeader creation, required-source normalization includes both the
role-specific and shared roots. It therefore reserves the bundled
`team-workflow` and `workflow` names so custom roots cannot shadow either
required skill.

`dreamux onboard` and dispatcher startup do not install bundled skills into a
workspace. Bundled skills are package-shipped runtime injection sources.

## Dispatcher-Visible MCP

Dispatcher `teammate` MCP tools are `spawn`, `send`, `close`, `list`, `status`,
`history`, `last`, and `get_capabilities`. `spawn.name_prefix` is only a
requested label; the returned concrete `teammate.name` is the address for every
later call. `send` is also the reattach path for a closed TeamMate when the
runtime can resume it from the recorded session.

Dispatcher `team` MCP tools are `create`, `send`, `list`, `status`, `history`,
`dissolve`, `bind_channel`, and `transfer_back`. `create.name_prefix` is only a
requested label; use the returned concrete, never-reused `team.team_name` for
every later Team call. `bind_channel({ team_name, channel_id?, meta })` routes
an existing channel target to a Team, and
`transfer_back({ channel_id?, meta })` releases a bound target from Team
routing. `meta` is provider-owned; the active channel provider's tool schema
and results are the authority for the target selector.

Dispatcher `dissolve({ team_name, note })` keeps its existing name and schema.
Its 9-second pre-acceptance deadline starts at method entry, including the
authoritative worktree preflight, and runs within the normal 10-second admin
timeout. Successful Dispatcher and TeamLeader dissolve calls return the durable
`status: "closing"` accepted receipt immediately. Logical close and worktree
cleanup remain server-owned background work and are observed through Team read
surfaces rather than the dissolve response.

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

TeamLeader `team` MCP exposes exactly `dissolve({ note })`,
`bind_channel({ channel_id?, meta })`, and
`transfer_back({ channel_id?, meta })`. Self-dissolve always targets the
descriptor-bound Team and leader generation, accepts no Team selector, and
returns only the durable `status: "closing"` receipt so its own tool response can
settle before runtime shutdown. Bind can claim only an unowned target (or repeat
the exact explicit binding); another owner or an active collaboration-managed
route is refused. TeamLeaders cannot create, send to, list, inspect, or select
Teams through this projection. `transfer_back` remains a routing-only state
change with no channel-message side effect.

TeamLeader `cron` MCP tools are `cron_create`, `cron_list`, `cron_update`,
`cron_delete`, and `cron_run_now`. Cron prompts are injected back into that
TeamLeader.
