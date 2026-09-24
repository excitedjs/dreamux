# Code organization refactor

## Current state

- Goal: Remove every file split only to get under the 700-line cap, put each
  responsibility in the module that owns it, and give `packages/dreamux/src`
  and the provider and Feishu packages one declared layering and one per-domain
  shape, with harness rules that keep it that way
- State: `intake`
- Requirement: [Current requirement](/.agents/tasks/architecture/code-organization-refactor/requirement.md)
- Rulings: [Operator rulings ledger](/.agents/tasks/architecture/code-organization-refactor/rulings.md) (verbatim)
- Survey: [Code organization audit](/.agents/tasks/architecture/code-organization-refactor/artifacts/audit.md) — read-only, 14 slices with adversarial verification; most of its §9 questions are answered in the rulings, and the rest are open items in the requirement
- Final solution: Not written.
- Solution review Issue: Not opened.
- Blockers: None recorded; development is not authorized.
- Next action: Write the final technical solution from the requirement, the rulings, and the audit through the development workflow, then open its solution-review Issue.
- Related tasks: absorbs the solution of [Add runtime config Commands](/.agents/tasks/architecture/add-runtime-config-commands/README.md) (issue #448) by operator ruling; builds on the cap ruling recorded in [suppress-owner-close-stop-pushback](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/requirement.md) and the cap decision in [Repository Guardrail Records](/.agents/tasks/architecture/repository-guardrails/README.md); the survey ran on the branch of [PR #453](https://github.com/excitedjs/dreamux/pull/453) (plugin system).

## Development approval

- Status: Not granted.
- Approved implementation boundary: None.

## Delivery

- Pull request: None for the refactor. This record travels in [PR #453](https://github.com/excitedjs/dreamux/pull/453) by operator ruling ("提交进 PR #453 的分支").
- Knowledge closeout: Pending.
