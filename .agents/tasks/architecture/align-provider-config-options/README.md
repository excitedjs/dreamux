# Align agent-runtime provider config options

## Current state

- Goal: Align and simplify agents[].config options across codex, claude-code, and antigravity, including model and effort support, and fix the PR #498 Codex sandbox regression by passing `-c sandbox_mode=danger-full-access` alongside `-c approval_policy=never`
- State: `review`
- Requirement: [Final requirement](/.agents/tasks/architecture/align-provider-config-options/requirement.md)
- Final solution: [Final technical solution](/.agents/tasks/architecture/align-provider-config-options/technical-design/final.md)
- Verification: [Verification record](/.agents/tasks/architecture/align-provider-config-options/verification.md)
- Solution review Issue: Not created.
- Blockers: None.
- Next action: Complete independent review of the Draft PR via `@Devbox`, adjudicate any findings, finalize knowledge closeout (`State: done`), and mark the PR ready for CI and operator merge authorization.
- Related tasks: related to [Promote model and effort to first-class runtime parameters](/.agents/tasks/architecture/promote-runtime-model-and-effort/README.md) (operator chose on 2026-11-27 to start an independent task focusing on aligning and simplifying provider config options).

## Development approval

- Follow-up slice (Codex `sandbox_mode=danger-full-access` regression fix):
  - Task lineage: Confirmed on 2026-11-29 via interactive card ("复用原任务 (Recommended)") to reuse this task for the PR #498 Codex sandbox regression fix.
  - Status: Granted on 2026-11-29 via interactive approval card playing back the final requirement, technical solution, implementation boundary, verification plan, and known limitations; operator answered "批准方案并授权开发 (Recommended)".
  - Approved implementation boundary: `packages/agent-runtime/codex/src/args.ts`, `packages/agent-runtime/codex/tests/config-and-args.test.ts`, `packages/dreamux/tests/helpers/live-codex-provider.ts`, `packages/dreamux/tests/codex-inbound-live.test.ts`, `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/builtin-codex.md`, `packages/dreamux/README.md`, `docs/configuration.md`, `.agents/tasks/architecture/align-provider-config-options/`, and Rush change files under `common/changes/`. Core runtime source (`packages/dreamux/src/**`), `dreamux-types`, `dreamux-utils`, `claude-code`, `antigravity`, channels, and plugins are out of scope.
- Prior merged slice (PR #498):
  - Development approval granted on 2026-11-27 via interactive card ("批准方案并授权开发 (Recommended)").
  - Review adjudication completed on 2026-11-28 via interactive card ("仅修 1&2，3 留待后续 (Recommended)") against [Devbox's review](https://github.com/excitedjs/dreamux/pull/498#pullrequestreview-6088215089).

## Delivery

- Prior pull request: https://github.com/excitedjs/dreamux/pull/498
- Follow-up pull request: Not opened yet.
- Knowledge closeout: Pending for the reopened follow-up slice (PR #498 closeout recorded in [verification.md](/.agents/tasks/architecture/align-provider-config-options/verification.md)).
