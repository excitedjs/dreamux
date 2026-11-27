# Add repository worktree setup script execution

## Current state

- Goal: Execute a repository-root JSON-configured setup script after Dreamux creates a managed Git worktree, supporting foreground (before launching TeamLeader) and background execution.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/workspace/add-worktree-setup-script/requirement.md)
- Final solution: [Technical solution](/.agents/tasks/workspace/add-worktree-setup-script/technical-design/final.md)
- Solution review Issue: Not created.
- Verification: [Local verification](/.agents/tasks/workspace/add-worktree-setup-script/verification.md)
- Review adjudication: [Review adjudication](/.agents/tasks/workspace/add-worktree-setup-script/review-adjudication.md)
- Blockers: None.
- Next action: Submitted via PR targeting `next`; awaiting CI and operator merge authorization.
- Related tasks: None.

## Stage decisions

- 2026-11-27 (`intake` -> `clarification`): Operator confirmed creating a new task under the new `workspace` capability domain (`workspace/add-worktree-setup-script`) via interactive cards.
- 2026-11-27 (`clarification` -> `solution`): Operator confirmed the finalized requirement and approved transitioning to `solution` via interactive card.
- 2026-11-27 (`solution` -> `awaiting-development-approval`): Operator confirmed the final technical solution and approved transitioning to `awaiting-development-approval` via interactive card.
- 2026-11-27 (`awaiting-development-approval` -> `implementation`): Operator explicitly approved development via interactive card.
- 2026-11-27 (`implementation` -> `review`): Operator confirmed entering `review` using an internal TeamMate reviewer via interactive card.
- 2026-11-27 (`review` -> `knowledge-closeout`): Operator ruled on findings R1–R5 and confirmed entering `knowledge-closeout` via interactive card.
- 2026-11-27 (`knowledge-closeout` -> `done`): Operator confirmed knowledge closeout and transitioning to `done` for PR submission via interactive card.

## Development approval

- Status: Approved (2026-11-27 16:07 +08:00).
- Card and response: Interactive development-authorization card tied to `requirement.md` and `technical-design/final.md`; operator selected "批准开始开发 (Recommended)".
- Approved implementation boundary: New `packages/dreamux/src/service/worktree/setup.ts`; updates to `packages/dreamux/src/service/worktree/manager.ts`, `packages/dreamux/src/service/dispatcher-service/index.ts`, `packages/dreamux/src/admin/client.ts`, and `packages/dreamux/src/mcp/shim.ts`; unit/integration tests under `packages/dreamux/tests/`; `.agents/` KB updates and Rush change file.

## Delivery

- Pull request: Not opened.
- Knowledge closeout:
  - Task record (`.agents/tasks/workspace/add-worktree-setup-script/`): Updated (`requirement.md`, `technical-design/final.md`, `review-adjudication.md`, `verification.md`, `README.md`).
  - Product behavior catalog (`.agents/product/README.md`): Updated with managed worktree setup script execution and MCP toolcall timeout/abort behavior.
  - Domain KB (`.agents/domains/dispatcher-orchestration.md`, `.agents/domains/state-config-and-files.md`): Updated Workspaces contract and `worktree/setup.ts` source pointers.
  - Local invariants (`packages/dreamux/src/service/CLAUDE.md`): Updated `worktree/` bullet to include `setup.ts`.
  - Maintenance skill (`packages/dreamux/skills/dispatcher/dreamux-maintenance/`): N/A (`.dreamux-worktree.json` is repository-owned user content, not a Dreamux server config or `~/.dreamux/` persisted state file).
  - Glossary (`.agents/glossary.md`) and KB routing (`.agents/root.md`): N/A (no new overloaded glossary term or top-level KB route; `.agents/tasks/README.md` indexes `workspace`).
  - Rush change file (`common/changes/@excitedjs/dreamux/`): Added `minor` change note.
