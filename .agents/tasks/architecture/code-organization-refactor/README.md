# Code organization refactor

## Current state

- Goal: Remove every file split only to get under the 700-line cap, put each
  responsibility in the module that owns it, and give `packages/dreamux/src`
  and the provider and Feishu packages one declared layering and one per-domain
  shape, with harness rules that keep it that way
- State: `done`
- State scope: the approved R73 continuation is complete. The parent PR #453
  coverage restoration and other deferred product work remain in intake;
  this state does not mark those obligations complete.
- Requirement: [Current requirement](/.agents/tasks/architecture/code-organization-refactor/requirement.md)
- Rulings: [Operator rulings ledger](/.agents/tasks/architecture/code-organization-refactor/rulings.md) (verbatim)
- Product decisions, 2026-10-02: [Existing-behavior follow-up](/.agents/tasks/architecture/code-organization-refactor/artifacts/product-decisions-20261002.md). R72 accepts onboard discarding unknown wrapper fields; R73's refusal of new Workflow TeamMate construction after owner close is implemented, independently reviewed, and locally validated.
- Completed continuation: R73 Workflow construction admission follows the
  2026-10-02 decision artifact, revision 1, against the recorded baseline
  [PR #460](https://github.com/excitedjs/dreamux/pull/460). This continuation changes
  a lifecycle admission boundary, so it used three independent proposals and
  one cross-review round with heterogeneous solution authors. The separate
  development card approved the final solution before implementation.
- R73 consultation evidence: independent [Codex proposal](/.agents/tasks/architecture/code-organization-refactor/technical-design/workflow-close-admission/proposals/codex.md), [MiMo proposal](/.agents/tasks/architecture/code-organization-refactor/technical-design/workflow-close-admission/proposals/mimo.md), and [DeepSeek proposal](/.agents/tasks/architecture/code-organization-refactor/technical-design/workflow-close-admission/proposals/deepseek.md), with [source audit](/.agents/tasks/architecture/code-organization-refactor/technical-design/workflow-close-admission/source-audit.md) and [TeamLeader adjudication](/.agents/tasks/architecture/code-organization-refactor/technical-design/workflow-close-admission/adjudication.md). The one cross-review round and source adjudication are complete; the [final R73 solution](/.agents/tasks/architecture/code-organization-refactor/technical-design/workflow-close-admission/final.md) selects collection-owned admission, deletes the Dispatcher wrapper, and preserves the public async boundary and existing cleanup.
- R73 solution-review surface: [Issue #461](https://github.com/excitedjs/dreamux/issues/461), mirroring the final solution. The single-writer implementation, TeamLeader pre-review, and independent xhigh review are complete; all four Rush gates passed with the unchanged 64-file, 710-test suite. The review found documentation closeout defects, all corrected; no runtime defect survived verification. [R73 verification](/.agents/tasks/architecture/code-organization-refactor/technical-design/workflow-close-admission/verification.md) and [review adjudication](/.agents/tasks/architecture/code-organization-refactor/technical-design/workflow-close-admission/implementation-review.md) record the evidence and coverage limits.
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
- Remaining stage: R73 has no unresolved accepted review finding. The other
  deferred parent product decisions and final coverage restoration remain in
  intake and are not started by this continuation.
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
- Next stage: separately resolve remaining deferred product behavior and
  complete the parent
  coverage obligations before #453 targets `next`. The
  [review adjudication](/.agents/tasks/architecture/code-organization-refactor/artifacts/data-flow-review.md)
  records accepted/rejected findings, recovered coverage, and the preserved
  entry semantics. Delivery follows the existing child-PR ruling.
- Related tasks: absorbs the solution of [Add runtime config Commands](/.agents/tasks/architecture/add-runtime-config-commands/README.md) (issue #448) by operator ruling; builds on the cap ruling recorded in [suppress-owner-close-stop-pushback](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/requirement.md) and the cap decision in [Repository Guardrail Records](/.agents/tasks/architecture/repository-guardrails/README.md); the survey ran on the branch of [PR #453](https://github.com/excitedjs/dreamux/pull/453) (plugin system).

## Development approval

- Active R73 continuation, 2026-10-02: **granted** against the final requirement
  and [final solution](/.agents/tasks/architecture/code-organization-refactor/technical-design/workflow-close-admission/final.md), mirrored in [Issue #461](https://github.com/excitedjs/dreamux/issues/461).
  The development-authorization card was sent at 14:57 PRC with the question
  "是否批准按 Issue #461 的最终方案开始本轮 Workflow 修复？". The explicit
  response received before implementation selected "开始开发 (Recommended)".
  This authorizes the single-writer R73 implementation, independent review,
  four Rush gates, and reviewed child-PR delivery into the PR #453 branch.
  R72 accepts the existing onboard rewrite and requires no code change;
  unrelated product work and the merge of #453 into `next` are outside this
  approval. Private transport identifiers are omitted from this public record.

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
