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
- Final review brief: [Anti-pattern review brief](/.agents/tasks/architecture/code-organization-refactor/artifacts/final-review-brief.md) — the seven architecture anti-patterns the PR #455 follow-up rounds removed, as given to the final three-reviewer pass (R68)
- Architecture continuation: [PR #453 ownership follow-up](/.agents/tasks/architecture/code-organization-refactor/artifacts/ownership-follow-up.md).
- Data-flow continuation: [Complete ownership requirement](/.agents/tasks/architecture/code-organization-refactor/artifacts/data-flow-follow-up.md), authorized by R71 after PR #457. Claude, MiMo, and DeepSeek completed independent proposals and one append-only cross-review round. The TeamLeader selected the [final data-flow solution](/.agents/tasks/architecture/code-organization-refactor/technical-design/data-flow/final.md); implementation uses one writer.
- Solution evidence: [Source audit for proposal adjudication](/.agents/tasks/architecture/code-organization-refactor/technical-design/data-flow/source-audit.md), with superseded proposal claims corrected in the final solution.
- Verification: [Architecture continuation evidence](/.agents/tasks/architecture/code-organization-refactor/verification.md).
- Solution review Issue: [Data-flow ownership #458](https://github.com/excitedjs/dreamux/issues/458).
- Data-flow result: the single writer completed the R71 ownership changes and
  accepted review corrections after [PR #457](https://github.com/excitedjs/dreamux/pull/457).
  Claude, MiMo, and DeepSeek reviewed the complete implementation; missing
  structured outputs were independently recovered. MiMo's final bounded
  verification confirmed the unified leader-tool access correction, hook-first
  assembly, and source documentation with no remaining behavior finding.
  The final four Rush gates passed with 64 files and 710 unchanged tests.
- Remaining stage: `intake` applies to the deferred parent product decisions
  and final coverage restoration, which this architecture child does not start.
  The R71 implementation, review, and knowledge closeout are complete; no
  accepted architecture finding remains unresolved in this delivery.
- Progress: PR-0, requirement stages 1 through 9, and the R52 plugin lifecycle
  hooks (`dispatcher.hooks.launch`/`.teammateLaunch`/`.createTeam`/`.team`,
  `team.hooks.leaderLaunch`, in `packages/dreamux/src/plugin/hooks.ts`) are
  written (each stage travels as commits on PR #453's branch, per the
  delivery ruling below).
  Stage 9 locks the harness: `packages/dreamux/.dependency-cruiser.cjs` runs
  at `error` severity for every rule with an empty exception list (0
  warnings/errors against the full `src/` tree), `@excitedjs/eslint-config`'s
  dumping-ground-filename rule is `error`, and the remaining source-text/
  file-path tests this stage's own scope named are retired — every deletion
  is logged in the [deleted tests ledger](/.agents/tasks/architecture/code-organization-refactor/artifacts/deleted-tests.md)
  for the final test completion to restore.
- Architecture continuation: implementation and independent Codex/Claude, MiMo,
  and DeepSeek reviews are complete; accepted documentation corrections are
  applied in [PR #457](https://github.com/excitedjs/dreamux/pull/457). The R71
  continuation completes the broader inter-component data-flow pass. Deferred
  product decisions and final coverage remain open.
- Next stage: discuss the deferred product behavior, then complete the parent
  coverage obligations before #453 targets `next`. The
  [review adjudication](/.agents/tasks/architecture/code-organization-refactor/artifacts/data-flow-review.md)
  records accepted/rejected findings, recovered coverage, and the preserved
  entry semantics. Delivery follows the existing child-PR ruling.
- Related tasks: absorbs the solution of [Add runtime config Commands](/.agents/tasks/architecture/add-runtime-config-commands/README.md) (issue #448) by operator ruling; builds on the cap ruling recorded in [suppress-owner-close-stop-pushback](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/requirement.md) and the cap decision in [Repository Guardrail Records](/.agents/tasks/architecture/repository-guardrails/README.md); the survey ran on the branch of [PR #453](https://github.com/excitedjs/dreamux/pull/453) (plugin system).

## Development approval

- Data-flow continuation, 2026-09-29: "要做就要做到彻底，然后整个数据流这块用闭包是一个非常愚蠢的方案。明明我们有无数种其他的方式。" This continues the existing architecture implementation authorization; the final technical design must stay within the behavior boundaries in the linked continuation requirement.
- Final solution selected on 2026-09-29: store-owned identity events, direct
  owner queries and tools, explicit work fences, and Feishu operation owners.
  The existing authorization covers implementation; no deferred product
  decision is silently selected. Unused public construction overrides are an
  explicit compatibility contraction in the solution; the CLI's real logger
  and sweep extension points remain. The single developer does not write
  `.agents`, commit, push, or change GitHub.

- Continuation approved 2026-09-29: "ok ，开始搞吧，主要还是以架构为主。然后我们再讨论最终的产品行为问题". This authorizes the architecture follow-up below; unresolved product behavior remains a later discussion.

- Status: Granted 2026-09-24. The operator's words: "你先看一下这个重构，然后往 453上开pr，最后跟随453一起合入next 。没问题的话就开始ultracode ，节点都选sonnet 。然后每个pr让devbox 去 review ，逐个合入。"
- Approved implementation boundary: the [requirement](/.agents/tasks/architecture/code-organization-refactor/requirement.md) as amended by the [rulings](/.agents/tasks/architecture/code-organization-refactor/rulings.md), delivered as a stack of pull requests into the PR #453 branch, one at a time. Each is reviewed and merged before the next one starts. Open items in the requirement are put to the operator when the pull request that reaches them starts.
- Tests: see R43 in the rulings. These pull requests write no new unit tests. The unit tests are completed on PR #453 before it merges to `next`. Every test case a stage deletes is logged in the [deleted tests ledger](/.agents/tasks/architecture/code-organization-refactor/artifacts/deleted-tests.md), which the final test completion reads to restore coverage.

## Delivery

- Pull request: This record travels in [PR #453](https://github.com/excitedjs/dreamux/pull/453)
  by operator ruling ("提交进 PR #453 的分支"); the ownership continuation is
  [PR #457](https://github.com/excitedjs/dreamux/pull/457), targeting that branch.
- Knowledge closeout: Complete for the ownership and R71 data-flow continuations. Updated
  [service topology](/.agents/domains/service-topology.md),
  [dispatcher orchestration](/.agents/domains/dispatcher-orchestration.md),
  [channel](/.agents/domains/channel.md),
  [Feishu access](/.agents/domains/feishu-pairing-access.md),
  [plugins](/.agents/domains/plugins.md),
  [provider runtime](/.agents/domains/provider-runtime.md),
  [scheduled work](/.agents/domains/scheduled-work.md), the
  [product catalog](/.agents/product/README.md), colocated package guidance,
  and the owning maintenance references. No glossary or root routing change
  is needed: this continuation adds no domain or overloaded term. Final
  product and coverage closeout of the parent task remains open.
