# Workspace Tasks

## Scope

- Workspace preparation, Git worktree lifecycle, and repository-level workspace setup capabilities.

## Code signals

| Area | Current code signal |
| --- | --- |
| Worktree management | `packages/dreamux/src/service/worktree` |
| Dispatcher workspace | `packages/dreamux/src/service/dispatcher-workspace.ts` |

## Child Scopes

## Tasks
- [Add repository worktree setup script execution](/.agents/tasks/workspace/add-worktree-setup-script/README.md) — Execute a repository-root JSON-configured setup script after Dreamux creates a managed Git worktree, supporting foreground (before launching TeamLeader) and background execution.
