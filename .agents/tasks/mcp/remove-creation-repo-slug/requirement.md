# Requirement

## Initial request

The operator requested on 2026-09-09, verbatim:

> teammate 的spawn，和 team create两个工具，repo 参数的 slug 直接删掉。

The operator confirmed creating an independent task on the same date by selecting
"新建任务 (Recommended)". This is task-creation approval, not development approval.

## User story

An agent creating a Team or a dispatcher-scoped TeamMate supplies the repository
policy without choosing a separate worktree slug. Dreamux uses the existing
entity-based directory and default branch naming.

## Baseline behavior and evidence (before implementation)

- The two MCP tools share `repoInputSchema`, which advertises `repo.slug` and
  closes the repo object against undeclared properties:
  `/packages/dreamux/src/service/mcp/tool-metadata.ts:148`.
- Dispatcher-scoped `teammate.spawn` and `team.create` also list `slug?` in their
  descriptions. TeamLeader-scoped `teammate.spawn` has no repo parameter:
  `/packages/dreamux/src/service/teammate-collection/mcp-tool-descriptors.ts:275`
  and `/packages/dreamux/src/service/team-collection/mcp-delegate.ts:285`.
- MCP registration uses the advertised schema for SDK input validation:
  `/packages/dreamux/src/mcp/server.ts:243`.
- Without an explicit slug, the worktree owner already uses the concrete entity
  name for the directory and `dreamux/<name>` for the default branch. Team
  creation supplies `team-<concrete team name>` as that name:
  `/packages/dreamux/src/service/worktree/manager.ts:137` and
  `/packages/dreamux/src/service/team-collection/runtime-registry.ts:144`.
- Canonical Commands use a separate repo schema and a shared parser. Those are
  distinct from the two MCP tools:
  `/packages/dreamux/src/service/worktree/repo-request.ts:30`.
- Existing managed-worktree recovery reads the persisted slug:
  `/packages/dreamux/src/service/worktree/workspaces.ts:91`.

## Desired behavior and scope

Remove `repo.slug` from the two named MCP tools, including their advertised input
schemas and tool descriptions. Calls carrying `repo.slug` fail ordinary MCP input
validation; it is not a hidden accepted input or a silently ignored option.

Use the narrow scope of the operator's named entry points. Do not broaden this
request into removing `slug` from canonical Commands, shared public types,
internal worktree requests, persisted worktree facts, or recovery. The common MCP
schema is the owner of this input restriction; no new parser or policy mechanism
is required.

Preserve all other repo inputs (`mode`, `path`, `base_ref`, `branch`, `cleanup`),
the omitted-repo behavior, name allocation, worktree cleanup, and TeamLeader
shared-workspace behavior. Existing worktrees and branches are not renamed,
recreated, or deleted.

This is an intentional contraction of the MCP input contract, not a
behavior-preserving refactor. An old MCP caller that sends `repo.slug` must stop
sending it. Config and persisted state do not change.

## Product catalog delta

The product catalog has no entry describing customizable creation-tool slugs.
Add the narrowed creation-input behavior under Team lifecycle. Preserve its
existing lazy TeamLeader startup, identity scope, and dissolve/cleanup promises.

## Acceptance criteria

1. Both dispatcher-facing creation tools advertise no `repo.slug` property and
   do not suggest it in their descriptions.
2. A managed-repo MCP call with `slug` is rejected before creation has side
   effects; the same supported request without `slug` passes input validation.
3. A managed worktree created through either tool without `slug` keeps the
   existing entity-based directory/default-branch behavior; explicit `branch`
   continues to work.
4. Repo omission, `reuse-cwd`, other managed options, and the TeamLeader-scoped
   spawn contract remain unchanged.
5. Existing records and canonical Command inputs retain their current meaning.

## Decisions and unknowns

- Confirmed: Remove the repo slug input from the two tools named in the initial
  request; create an independent task.
- Scope confirmed through the workflow question on 2026-09-09: The two MCP
  inputs and descriptions change; canonical Commands and existing workspaces do
  not. A supplied slug is an input error.
- Workflow ruling on 2026-09-09, verbatim selection: "简化流程 (Recommended)".
  The selected option authorizes a brief TeamLeader-authored solution and
  implementation after development approval, followed by one independent
  reviewer and the full test gates; it skips multi-party solution consultation
  and the solution-review Issue for this task only.
- Blocking requirement unknowns: None.
- Development approval: Granted on 2026-09-09 by the operator's selection
  "批准开发 (Recommended)" against this requirement and the linked final solution.
