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
- Blockers: None recorded.
- Next action: Deliver the stacked pull requests in order: PR-0 (open PR #453 defects plus R35, R36, and the R21 plugin-config rule), then requirement stages 1 to 9, then the plugin lifecycle hooks from the PR #453 design handoff, then the test completion on PR #453.
- Related tasks: absorbs the solution of [Add runtime config Commands](/.agents/tasks/architecture/add-runtime-config-commands/README.md) (issue #448) by operator ruling; builds on the cap ruling recorded in [suppress-owner-close-stop-pushback](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/requirement.md) and the cap decision in [Repository Guardrail Records](/.agents/tasks/architecture/repository-guardrails/README.md); the survey ran on the branch of [PR #453](https://github.com/excitedjs/dreamux/pull/453) (plugin system).

## Development approval

- Status: Granted 2026-09-24. The operator's words: "你先看一下这个重构，然后往 453上开pr，最后跟随453一起合入next 。没问题的话就开始ultracode ，节点都选sonnet 。然后每个pr让devbox 去 review ，逐个合入。"
- Approved implementation boundary: the [requirement](/.agents/tasks/architecture/code-organization-refactor/requirement.md) as amended by the [rulings](/.agents/tasks/architecture/code-organization-refactor/rulings.md), delivered as a stack of pull requests into the PR #453 branch, one at a time. Each is reviewed and merged before the next one starts. Open items in the requirement are put to the operator when the pull request that reaches them starts.
- Tests: see R43 in the rulings. These pull requests write no new unit tests. The unit tests are completed on PR #453 before it merges to `next`. Every test case a stage deletes is logged in the [deleted tests ledger](/.agents/tasks/architecture/code-organization-refactor/artifacts/deleted-tests.md), which the final test completion reads to restore coverage.

## Delivery

- Pull request: None for the refactor. This record travels in [PR #453](https://github.com/excitedjs/dreamux/pull/453) by operator ruling ("提交进 PR #453 的分支").
- Knowledge closeout: Pending.
