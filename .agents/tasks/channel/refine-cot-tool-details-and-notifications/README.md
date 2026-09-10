# Refine COT tool details and notification display

## Current state

- Goal: Show actual tool output without an extra status line; when output is
  absent, show the divider and Complete or Failed for either outcome.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/channel/refine-cot-tool-details-and-notifications/requirement.md).
- Final solution: [Technical solution](/.agents/tasks/channel/refine-cot-tool-details-and-notifications/technical-design/final.md).
- Solution review Issue: None; the operator explicitly directed development
  after the interactive requirement and presentation-design alignment.
- Current repair baseline: Freshly fetched `origin/next` at
  `22cf0a7a53ea636daad9c939ff2185e3379bc42e`, which contains merged PR #401.
- Current repair branch: `fix/cot-status-placement`.
- Current repair approval (2026-09-10): "从 next 切分支出来修", followed by
  "不对，如果有输出就干掉，没有输出的时候才显示成" and the explicit
  `RESULT`, divider, `Failed` layout. This resumes the paused work and supersedes
  the interim selection of a status beside the RESULT title.
  The final success-alignment instruction is
  "成功也保持对齐，有输出就不显示 Complete ，没有输出才显示"
  with the same RESULT/divider/Complete layout. The repair uses
  the minimal-change fast path: Channel-owned result assembly, its behavioral
  checks, the affected knowledge, and a Rush patch change file. List-only rows
  and the existing event-size fallback remain unchanged.
- Final pre-merge refinement: "稍等，额外增加一个小点，就是给 RESULT 这个leading 字符删掉，只保留 /n/n--- 这个分割线".
  The result separator is now `\n\n---`, with no RESULT word. All status rules
  above remain in force.
- Current verification: Build, lint, full test (including real Codex),
  typecheck:tests, and the knowledge check passed. See the current correction in
  [verification.md](/.agents/tasks/channel/refine-cot-tool-details-and-notifications/verification.md).
- Current PR: [#403](https://github.com/excitedjs/dreamux/pull/403), targeting
  `next`; final implementation commit `cc3904cf` passed all nine GitHub CI checks.
- Current review: External final review approved the status behavior at
  `85c34b7a` and approved the final divider refinement at `cc3904cf`. No blocking
  findings remain. All four local gates passed on the final implementation.
- Merge approval: "可以合入了", followed by the additional divider refinement.
- Current next action: Squash-merge PR #403 into next under the operator's
  recorded authorization. No installation or restart is requested.

## Historical feature snapshot before PR #401 merged

The following implementation and delivery notes predate the current repair.

- Baseline: Freshly fetched `origin/next`,
  `00b858efa2f9cfdb7fdbf829aac9cfe0856b6915`, before implementation.
- Current review base: freshly fetched `origin/next` at
  `7ed1d886964e520025cbc1e8151c8ff2eefd9a58`, unchanged at final pre-review.
  The earlier implementation had been rebased after the operator clarified
  "不是 dev，说错了，是 next"; it was subsequently discarded as recorded below.
- Branch: `feat/cot-tool-details-and-notifications`.
- Restart baseline: Freshly fetched next at
  `7ed1d886964e520025cbc1e8151c8ff2eefd9a58`. On 2026-09-10 all non-.agents files
  and local branch HEAD were restored to this commit; the old developer was
  closed. At that reset only .agents records remained changed; the fresh Claude
  implementation passed final local pre-review. The remote draft PR and published Alpha
  still contain the discarded implementation.
- Blockers: External final review remains pending. The test-fixture scan failure
  was resolved under operator approval by changing only the synthetic commands;
  staged gitleaks now passes with its rules unchanged. The operator rejected the
  added shared START title/name budget; its withdrawal is verified while the
  approved 80-byte cap removal remains.
  Earlier implementation and gate results are historical.
  R2 remains unchanged, R3 keeps invocation-first selection, and R6 keeps the
  existing formatting entry under the operator's explicit rulings.
- Next action: Update the existing draft PR, run CI, and request the
  operator-selected external final review. Its
  [implementation brief](/.agents/tasks/channel/refine-cot-tool-details-and-notifications/implementation-brief.md)
  states the original presentation requirement plus failure ordering against next.
  External final review remains required. The replacement Codex writer was closed and its
  partial source edits were discarded before this reassignment.
- Related tasks: Builds on
  [Feishu COT cards](/.agents/tasks/channel/feishu-cot-conversation-cards/README.md)
  and [COT refinement](/.agents/tasks/channel/refine-feishu-cot-and-binding-cards/README.md).

## Development approval

- Status: Granted by the operator on 2026-09-09, following source investigation,
  private rendering probes, and iterative agreement on the presentation.
- Approval: "开始开发吧，推进到 PR 创建出来，然后给我发一个 Alpha 包。"
- Baseline constraint: "开始开发之前，你先从 next 分支拉出最新开发分支。"
- Scope: The linked requirement and its neutral runtime/Core/Channel plumbing,
  tests, release declarations, and repository knowledge. The operator's later
  refinements, "workflow 先不展示 name 了" and "参数全给我放开，不要做脱敏了",
  are included. The latter supersedes the brief withdrawal of argument display
  and approves raw argument/invocation presentation. It does not authorize a
  global redaction removal or ratify unrelated review findings.
- Workflow interpretation: The explicit instruction to start development
  authorizes this task record and routine implementation decisions without a
  further intake or development-permission round. Single-writer implementation
  and independent implementation review remain required. The later ruling
  "如果是代码简化的话，直接做就行了" permits behavior-preserving simplification
  directly; specific earlier no-change rulings still bind this task.
- Review handoff (2026-09-09): "你去找devbox去review". The operator selected the
  final reviewer. Prepare a draft PR as its concrete review surface while this
  task remains in review; do not claim review completion or release readiness
  merely because that draft exists. This review-handoff interpretation overrides
  the usual post-closeout PR timing, not the validation or final-review gate.
- Delivery boundary: Create the PR and publish an Alpha; merging, installing it
  into the running service, and restarting the service are not requested.
- Alpha feedback approval (2026-09-09): "ARGUMENTS 这个标题给删了，只保留 RESULT".
  Remove only the argument heading; preserve the argument payload and RESULT.
- Provider burden feedback (2026-09-10): "那你这就是在给provider适配增加负担。"
  The TeamLeader withdraws the unnecessary invocation-language contract while
  preserving argument display and the separate completion-provenance feature.
- Failure-order approval (2026-09-10): "确实，这个顺序问题要修一下。"
  Arguments precede the RESULT area, which contains Failed before actual output.
- Fixed-title correction (2026-09-10): "那几个固定的Read Search 之类的单词你给我恢复了吗？"
  The earlier blanket removal is superseded. After the reset, baseline action
  names and title words already exist and are preserved, not restored by the
  new implementation.
- Restart instruction (2026-09-10): "你把非.agents 目录的变更全部回退到和next
  分支一致，然后跟我复述需求，然后拉一个新的developer 重新做吧。"
  The new implementation is authorized after restoration and requirement playback;
  do not reuse the previous developer or replay its patch.
- Requirement-playback correction (2026-09-10): "我是说我最初定下来的需求。现在代码都
  让你回退了，哪还有恢复这一说了？" Describe the requested feature against next;
  repairs of the discarded implementation are not new development work items.
- Developer and method selection (2026-09-10): "原始需求再加上failed 顺序出错，派给claude，
  让他用ultracode 一次性搞定。" Claude owns the complete implementation through
  its own ultracode, including verification. It supersedes the interim Codex
  assignment. The operator clarified "不要告诉他dreamux 的ultracode，这俩不是一个东西";
  the TeamLeader's added skill-path and orchestration-tool requirements are
  withdrawn. Hand down the requirement and the ultracode instruction only.
- Fresh-context instruction (2026-09-10): "拉一个新的吧，那个claude 都被你污染了。"
  and "不要那么啰嗦。他比你还能干。" The first Claude seat was closed without
  implementation changes. A fresh Claude receives only the concise display
  brief, the ultracode instruction, and necessary ownership boundaries; it
  chooses the implementation itself.

## Delivery

- PR: [Draft #401](https://github.com/excitedjs/dreamux/pull/401), targeting `next`.
- Alpha: `0.25.0-alpha.g4a45d478cc7c`, published and verified on npm after the
  operator explicitly requested publication. It includes the rebase and heading
  removal. It belongs to the discarded implementation and does not validate the
  new attempt.
- Verification: [Local checks and review](/.agents/tasks/channel/refine-cot-tool-details-and-notifications/verification.md).
- Knowledge closeout: Product, Channel, provider, task, and requested workflow-skill
  records are aligned with the final local implementation; external review may
  require further updates.
