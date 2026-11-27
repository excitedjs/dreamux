# Align agent-runtime provider config options

## Current state

- Goal: Align and simplify agents[].config options across codex, claude-code, and antigravity, including model and effort support
- State: `review`
- Requirement: [Final requirement](/.agents/tasks/architecture/align-provider-config-options/requirement.md)
- Final solution: [Final technical solution](/.agents/tasks/architecture/align-provider-config-options/technical-design/final.md)
- Verification: [Verification record](/.agents/tasks/architecture/align-provider-config-options/verification.md)
- Solution review Issue: Not created.
- Blockers: Awaiting independent review of the complete change.
- Next action: Obtain independent review from Devbox, adjudicate any findings, then complete knowledge closeout and PR delivery to `next`.
- Related tasks: related to [Promote model and effort to first-class runtime parameters](/.agents/tasks/architecture/promote-runtime-model-and-effort/README.md) (operator chose on 2026-11-27 to start an independent task focusing on aligning and simplifying provider config options).

## Development approval

- Status: Granted on 2026-11-27 via interactive approval card playing back the final requirement, technical solution, converged approval/sandbox model, verification plan, and implementation boundary; operator answered "批准方案并授权开发 (Recommended)".
- Approved implementation boundary: `packages/agent-runtime/codex`, `packages/agent-runtime/claude-code`, `packages/agent-runtime/antigravity`, `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/{builtin-codex.md,builtin-claude-code.md}`, `packages/dreamux/README.md`, `docs/{configuration.md,getting-started.md}`, affected host/provider tests, `.agents/` records and affected domain docs, and Rush change files under `common/changes/`. Core runtime source (`packages/dreamux/src/**`), `dreamux-types`, `dreamux-utils`, channels, and plugins are out of scope.

## Delivery

- Pull request: Not opened.
- Knowledge closeout: Pending.
