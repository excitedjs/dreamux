# Technical solution

## Scope and ownership

Apply the [requirement](/.agents/tasks/mcp/remove-creation-repo-slug/requirement.md)
at the two MCP entry points only. The operator approved the simplified workflow
on 2026-09-09: TeamLeader-authored solution and implementation, a separate
explicit development approval, then one independent read-only reviewer. No
solution-review Issue or multi-reviewer consultation is required for this task.

The existing common MCP repo schema owns this input restriction. Canonical
Commands and worktree recovery remain separate consumers with unchanged contracts.
This deliberately narrows the MCP projection introduced in `2ed5f5ea` without
changing the full domain request. No new parser, type, compatibility option, or
runtime branch is necessary.

## Implementation

1. In `/packages/dreamux/src/service/mcp/tool-metadata.ts`, remove the `slug`
   property from `repoInputSchema`. Keep `additionalProperties: false`; the
   existing SDK validation rejects a supplied slug before dispatch. Replace the
   now-inaccurate complete-canonical-union comment with a short statement of the
   MCP schema's scope. Describe the branch default using the concrete TeamMate
   name or `team-<team_name>`, rather than an exposed slug option.
2. Remove `slug?` from the repo examples in
   `/packages/dreamux/src/service/teammate-collection/mcp-tool-descriptors.ts` and
   `/packages/dreamux/src/service/team-collection/mcp-delegate.ts`.
3. Extend existing MCP catalog/description tests to cover the advertised shape
   of both actual dispatcher-facing tools and unchanged TeamLeader spawn scope.
   Add official-SDK wire calls using those actual input schemas to prove that a
   supplied slug fails before the handler runs, while supported repo inputs pass.
   Prefer `/packages/dreamux/tests/mcp-tool-descriptions.test.ts` and
   `/packages/dreamux/tests/mcp-protocol-conformance.test.ts`; do not replace
   existing assertions with weaker ones.
4. Use or extend `/packages/dreamux/tests/worktree-manager.test.ts` to cover the
   existing name-derived directory/default branch and explicit branch behavior.
   Keep all existing worktree cleanup and recovery coverage.
5. Update the product catalog and model-facing writing domain with the current
   MCP input boundary. Add a `minor` Rush change note for `@excitedjs/dreamux`
   stating the breaking MCP input removal and the caller action: omit
   `repo.slug`. No config, state, worktree, or branch rebuild is needed.

## Unchanged boundary

No edits to `TeamCreateRepoRequest`, `REPO_REQUEST_SCHEMA`, `repoRequest`,
`repoWorktree`, worktree request types, persisted state, naming algorithms,
recovery, cleanup, runtime providers, or channels. No installed service restart,
real Team/TeamMate creation, commit, push, release, or merge is authorized by
this implementation plan.

## Verification and acceptance

- Catalog assertions cover both tool schemas and descriptions, and confirm
  TeamLeader-scoped spawn still accepts no repo.
- SDK wire probes cover slug rejection without creation side effects and
  accepted managed, reuse-cwd, and omitted-repo calls.
- Worktree tests exercise automatic directory/default-branch naming and explicit
  branch selection on temporary Git fixtures.
- Run the repository Rush gates: `build`, `lint`, `test`, `typecheck:tests`.
  Install workspace dependencies with `rush update` if needed. Do not skip live
  runtime checks silently; report any environmental blocker.
- Run `.agents/scripts/check.sh` and task-record validation.
- Inspect the whole diff and have one independent read-only TeamMate review it
  against the requirement and this solution after local checks pass.

Residual compatibility consequence: old MCP callers carrying `repo.slug` fail
input validation. Existing canonical Command callers and persisted worktrees
retain their previous behavior. The change is limited to the model-facing input.
