# Code organization refactor

## Current state

- Goal: Remove every file split only to get under the 700-line cap, put each
  responsibility in the module that owns it, and give `packages/dreamux/src`
  and the provider and Feishu packages one declared layering and one per-domain
  shape, with harness rules that keep it that way
- State: `done`
- Active continuation, 2026-10-03: [Review fixes and final coverage](/.agents/tasks/architecture/code-organization-refactor/artifacts/review-fixes-20261003.md), revision 2 with R76. R74 retains active record authority and reads retired history from disk. R75 selects next-compatible existence preview and recursive root removal; R76 rejects physical provider-home alias protection. Both complete-review residuals are corrected: the current MCP knowledge page describes valid-record Team name occupation, and the common pre-commit dissolve log now covers preparing or committing the closed record. The TeamLeader checked the exact two-string source/test diff, preserved runtime/cron/retry assertions, all 199 tested hashes and actual eight-package outputs. After the test-only macOS fixture correction, default tests pass 2,649 with six model exclusions. The preceding enabled run passed 2,654 with zero skips and all six actual Codex contracts; those cases and all production bytes remain unchanged, and model calls were not repeated for this fixture edit. All 1,965 historical identities and contract/target mappings remain. [Verification](/.agents/tasks/architecture/code-organization-refactor/technical-design/review-453-fixes/verification.md) and [pre-review](/.agents/tasks/architecture/code-organization-refactor/technical-design/review-453-fixes/implementation-review.md) record evidence and limits. The operator stopped the last corrected-tree review at its scope stage under R77; it produced no findings and is not a review pass. Accepted findings from completed preceding reviews are corrected. Knowledge closeout reconciles the actual tested implementation, product catalog, owning domain pages and maintenance references using recorded TeamLeader source/assertion checks and current local gates. Cron jobs stay cancelled. Feature-base child delivery and subsequent alpha handoff retain their existing authority; parent #453 merging into next is not authorized.
- Repair solution surface: [Issue #463](https://github.com/excitedjs/dreamux/issues/463) mirrors revision 2 of the selected solution and its final-parent coverage obligation, including R75's root-removal contract. The operator's direct repair instruction and R74/R75 answers supply authority; this is not a claim that an additional issue-approval card was sent. The same implementation developer owns source and tests; the TeamLeader owns task and knowledge closeout.
- State scope: the active review-fix continuation includes final-parent coverage
  restoration. The completed R73 continuation below is historical delivery
  evidence, not the current stage or an assertion that parent coverage is done.
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
- Delivery boundary: R77 stops the final review without a pass or restart. Knowledge is reconciled with the tested tree and the delivered index must carry those exact bytes. R78 authorizes direct push and Actions alpha from the tested repair branch; the feature-base child PR follows normal CI and its existing merge authority separately. R76 rejects correction of provider-home aliases; current normalized-path behavior remains. The [source adjudication](/.agents/tasks/architecture/code-organization-refactor/technical-design/review-453-fixes/implementation-review.md) records each disposition and the documented startup scan limit. R71
  and R73 have no unresolved accepted findings within their historical delivery
  scopes; the current resulting-tree review identifies the new continuation.
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
- Historical ownership-continuation result: implementation and independent Codex/Claude, MiMo,
  and DeepSeek reviews are complete; accepted documentation corrections are
  applied in [PR #457](https://github.com/excitedjs/dreamux/pull/457). The R71
  continuation completes the broader inter-component data-flow pass. That
  delivery did not complete deferred product decisions or final coverage;
  the active repair continuation above owns the subsequent coverage work.
- Historical data-flow follow-up: remaining deferred product behavior and
  parent coverage were separate from that continuation. The
  [review adjudication](/.agents/tasks/architecture/code-organization-refactor/artifacts/data-flow-review.md)
  records accepted/rejected findings, recovered review coverage, and the
  preserved entry semantics. The active repair requirement and verification
  above now own the remaining implementation/review work. Delivery follows
  the existing child-PR ruling.
- Related tasks: absorbs the solution of [Add runtime config Commands](/.agents/tasks/architecture/add-runtime-config-commands/README.md) (issue #448) by operator ruling; builds on the cap ruling recorded in [suppress-owner-close-stop-pushback](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/requirement.md) and the cap decision in [Repository Guardrail Records](/.agents/tasks/architecture/repository-guardrails/README.md); the survey ran on the branch of [PR #453](https://github.com/excitedjs/dreamux/pull/453) (plugin system).

## Development approval

- R78 direct delivery, 2026-10-08: “看起来都是小问题了，直接 push ，发 alpha 包”.
  Dispatch the existing alpha pipeline on the tested repair branch after its
  mandatory-hook commit and push, without restarting review or waiting for child
  integration. This supersedes the earlier alpha sequencing below, not the
  release-channel or parent-merge boundaries.


- Active review-fix continuation, 2026-10-03: the operator directly instructed
  “把这些问题修了” and then selected “退休后读盘 (Recommended)” for the sole
  unsettled product boundary. The [active requirement](/.agents/tasks/architecture/code-organization-refactor/artifacts/review-fixes-20261003.md)
  records scope and authority. No additional approval card is claimed for this
  batch; the R73 card below authorized that separate completed continuation.

- Alpha delivery, 2026-10-08: the operator asked to publish an alpha package
  and give it to the designated tester after completion. This authorizes the
  existing feature-branch Actions prerelease pipeline and tester notification
  after knowledge closeout and child delivery, with R77 recording the operator-stopped final review without a pass. It does not authorize
  parent #453-next merge, stable/beta promotion, local version writes or raw
  npm publication. Private recipient identifiers remain outside this record.

- R77 final-review stop, 2026-10-08: “停掉最后这次复审”. The final workflow was stopped at scope confirmation before findings were produced. It is not a review pass and will not restart. This stops that review only; existing implementation, child-delivery and alpha authority remain as recorded, without expanding merge or release scope.

- R76 review boundary, 2026-10-08: “这个问题不修复，之前我记得决策过。”
  This rejects the provider-home alias correction after its same consequence
  on next was explained. No correction was dispatched. Keep the existing
  normalized-path checks and continue the four independent accepted cleanup
  and fixture corrections; the current source adjudication records the scope.

- R75 continuation, 2026-10-08: after the TeamLeader explained both next's
  existence-only preview and its recursive root removal, the operator said
  “先和 next 保持一致吧”. This authorizes replacing only the discussed
  uninstall predictor and foreign-content retention contract within the same
  repair batch. The other eight outcomes, R74, and feature-base child delivery
  remain. All scheduled recovery jobs were cancelled at the operator's request.

- Completed R73 continuation, 2026-10-02: **granted** against the final requirement
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
- Tests: R43 deferred unit-test restoration during the refactor child stages
  until the final PR #453 coverage pass before merging to `next`. The active
  review-fix continuation includes that final-parent restoration obligation.
  Every deleted case is recorded in the [deleted tests ledger](/.agents/tasks/architecture/code-organization-refactor/artifacts/deleted-tests.md);
  each surviving obligation needs named restored/current behavioral evidence
  or an actual superseding ruling.

## Delivery

- Review-repair child: [PR #464](https://github.com/excitedjs/dreamux/pull/464),
  based on the PR #453 feature branch. R78 separately authorizes direct alpha
  publication from the tested repair branch; normal CI and child integration
  remain GitHub delivery facts, not a final-review pass or parent-next authority.


- Review-repair knowledge closeout, 2026-10-08: complete for revision 2,
  R74/R75/R76 and the R77 review-stop boundary. The
  [final local evidence](/.agents/tasks/architecture/code-organization-refactor/technical-design/review-453-fixes/verification.md#final-local-acceptance-and-operator-stopped-review-2026-10-08)
  records owner/assertion checks, current full Rush results, all 1,965
  historical dispositions and external limits. The final stopped review is not
  a pass; preceding completed review findings and accepted corrections remain
  separately recorded. `done` describes implementation and knowledge readiness
  for the authorized child delivery, not parent PR integration or platform acceptance.
- Knowledge owners: the product catalog, state/config ownership, service
  topology, Dispatcher orchestration/MCP, scheduling, channel/access,
  provider/plugin entries, non-blocking inbound, test policy and glossary were
  reconciled with the current source. Colocated guidance and the single owning
  maintenance references accompany source changes. Current routing in root.md
  needs no change because no new domain or discovery path was introduced.
  [Owner closeout](/.agents/tasks/architecture/code-organization-refactor/technical-design/review-453-fixes/verification.md#knowledge-owners-reconciled-for-child-delivery)
  links the current facts. Historical proposals and earlier evidence remain
  consultation and lineage, not broader implementation authority.


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
  product and coverage evidence is reconciled in the review-repair continuation below; parent integration remains a separate GitHub/operator boundary.
