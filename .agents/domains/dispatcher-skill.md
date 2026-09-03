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
  is the narrow generic transition exception: install the target, read its
  changelog and apply config migrations through routed owners, repair until
  doctor passes, then perform notification restart. It carries no
  release-specific schema or migration body.
- `skills/team-leader/team-workflow` is injected only into TeamLeader runtimes.
  It covers team-scoped TeamMate MCP cautions, shared Team workspace
  coordination, provider-visible channel replies, TeamLeader cron cautions, and
  the Channel-owned routing tools a TeamLeader may reach for its own Team.
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

Bundled skills are injected at runtime by role; the full mechanism (Codex
`skills/extraRoots/set`, Claude Code materialized `--add-dir` roots, custom
root normalization) is owned by
[Provider runtime](provider-runtime.md#bundled-skills). Two facts locked here:
Dispatcher and TeamLeader launch sites pass their role-specific root plus the
shared root, so both roles receive the shared `workflow` skill. For TeamLeader
creation, required-source normalization includes both the role-specific and
shared roots; it therefore reserves the bundled `team-workflow` and `workflow`
names so custom roots cannot shadow either required skill.

## Dispatcher-Visible MCP

Dispatcher `teammate` MCP tools are `spawn`, `send`, `close`, `list`, `status`,
`history`, `last`, and `get_capabilities`. `spawn.name_prefix` is only a
requested label; the returned concrete `teammate.name` is the address for every
later call. `send` is also the reattach path for a closed TeamMate when the
runtime can resume it from the recorded session.

Dispatcher `team` MCP tools are `create`, `send`, `list`, `status`, `history`,
and `dissolve`. `create.name_prefix` is only a requested label; use the returned
concrete, never-reused `team.team_name` for every later Team call. Routing a
conversation to a Team is not here: it is a channel operation, and the connected
channel's own MCP server owns those tools and their schemas.

`dissolve({ team_name, note, force? })` is submitted, not awaited. It answers
`{ accepted, team_name, status: "submitted" }` as soon as the Team owns the
background work and never reports how the dissolve went; read the Team's status
afterwards. Uncommitted, untracked, or unmerged work in a managed worktree
leaves the Team open and running instead of closing it, and `force: true`
discards exactly that local work — never the branch, its commits, a reused
directory, or the source repository.

Dispatcher `cron` MCP tools are `cron_create`, `cron_list`, `cron_update`, and
`cron_delete`. Cron prompts are injected back into the
Dispatcher; they are not a TeamMate spawn target or channel delivery mechanism by
themselves.

Collaboration Space policy is a channel surface, not a Dreamux one. For the
built-in Feishu channel the Dispatcher additionally sees `bind_channel`,
`unbind_channel`, and `list_bindings` for one conversation, plus
`bind_collaboration_space`, `unbind_collaboration_space`,
`get_collaboration_space`, and `list_collaboration_spaces` for provisioning
policy. A rebind reports the previous Team; there is no separate transfer tool.
Those names and schemas belong to the channel package — read the active tool
schema rather than assuming a shape.

## TeamLeader-Visible MCP

TeamLeader `teammate` MCP tools are `spawn`, `send`, `close`, `list`, `status`,
`history`, `last`, and `get_capabilities`, scoped to the Team's members.
TeamLeader `spawn` does not accept a `repo` input because the Team workspace is
already selected when the Team is created. Team-scoped TeamMates share that
workspace, so concurrent editing needs an explicit non-conflict boundary.

TeamLeader `team` MCP exposes exactly one tool, `dissolve({ note, force? })`.
It always targets the descriptor-bound Team, accepts no Team selector, and
returns the same submitted receipt — its own runtime is one of the things being
stopped, so it should expect to lose that response. TeamLeaders cannot create,
send to, list, inspect, or select Teams through this projection.

The bundled `team-workflow` skill tells a TeamLeader to check uncommitted,
untracked, and unmerged work before dissolving, and to ask the user through the
visible reply path when the workspace is not clean. That prompt check is
guidance, not authority: the non-destructive assessment inside the worktree
manager is what actually refuses an unsafe close. Keep the two layers distinct
when editing either.

A TeamLeader's channel routing tools come from the channel, and its copies carry
no team field at all: the built-in Feishu channel lets it claim a free
conversation for its own Team with `bind_channel` and release one with
`unbind_channel`, and a conversation another Team answers in cannot be taken
over — that is a Dispatcher move.

TeamLeader `cron` MCP tools are `cron_create`, `cron_list`, `cron_update`, and
`cron_delete`. Cron prompts are injected back into that
TeamLeader.

History: [/.agents/tasks/architecture/README.md](/.agents/tasks/architecture/README.md).
