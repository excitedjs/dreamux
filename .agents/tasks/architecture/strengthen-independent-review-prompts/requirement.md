# Requirement

## Initial request

- Start a fresh branch from `next`, update the TeamLeader-only `dev-workflow`
  skill, and open a new pull request.
- Strengthen the identities and hand-down prompts used for technical solution
  consultation and review. The diagnosis is the PR #389 TeamLeader's own
  retrospective, not an operator ruling: the design could have been challenged,
  but the prompts let reviewers inherit the TeamLeader's premise and keep
  improving the wrong architecture. The record on the PR #389 branch supports
  it: all three consultation reviews affirmed the source-side owner, and the
  verification review noticed the recipient was stopping too, then stepped
  back because that read as a behavior change.
- Operator wording: “你是一名挑战者，请从各个角度挑战 Team leader 给出的技术方案
  和实现方式。如果方案细节或者是代码实现朝着不可控的方向膨胀，就需要高度警惕
  是否架构设计出了问题。”
- Operator wording: “要守住当前仓库【熵减】的核心原则。任何导致架构劣化和混乱
  程度增加的代码，都是不允许的。”

## Current alignment

- Status: Clarified and approved for a minimal documentation-only change on
  2026-09-08.
- Baseline: `origin/next` at
  `2c8f4269b32f407bce3a477c0f4ac6b9f35223b5`, including PR #393.
- The operator explicitly rejected adding a process that tries to prove whether
  the prompt works: “这个效果你自己是观察不出来的。只有我能观察”. Effectiveness
  remains an operator-observed outcome in later real work.

## Desired behavior

- Solution and implementation-review TeamMate identities say that the seat is a
  challenger, not a confirmer of the TeamLeader's framing.
- A reviewer independently reconstructs the user story, authoritative owner,
  and simplest coherent mechanism from the requirement and current source before
  extending or defending the proposed solution.
- Entropy reduction is a hard repository acceptance criterion. A solution or
  implementation that degrades architecture or unnecessarily increases the
  concepts, states, special cases, or cross-layer hops needed to reason about it
  is unacceptable even when behavior and tests pass.
- Uncontrolled growth in solution detail or implementation mechanics is a strong
  signal to challenge the architecture or owner before proposing another local
  patch.
- Challenge remains evidence-based. A reviewer may return no finding and must not
  manufacture disagreement or make an operator decision.

## Scope

- Update the existing `dev-workflow` standing guidance.
- Update the existing solution and implementation-review identity blocks.
- Clarify the existing solution-consultation hand-down prompt so reviewers reason
  independently before comparing with the TeamLeader's draft.
- Keep the change inside `.agents/**` and record it in this task.

## Non-goals

- No product, runtime, provider, Channel, TeamMate, or Workflow behavior change.
- No new reviewer, review round, workflow state, output schema, validation
  framework, or orchestration mechanism.
- No change to the shared dynamic code-review method.
- No claim that a prompt can make independent reasoning structurally guaranteed
  or automatically measurable.

## Acceptance criteria

- The solution identity set and the common implementation-review identity carry
  the challenger and entropy-reduction posture.
- The solution-reviewer and implementation-review identities treat TeamLeader
  drafts, approved solutions, and current implementations as evidence to evaluate
  rather than conclusions to complete; the solution-author identity remains a
  complete-proposal author rather than inheriting reviewer language.
- `solution-consultation.md` passes the solution-reviewer identity that requires
  an independent requirement-and-source model before draft evaluation, without
  adding a new turn or review seat or duplicating that posture in the work prompt.
- The change does not alter existing review counts, workflow topology, approval
  authority, write boundaries, or shared review machinery.
- Skill frontmatter validation, task validation, `.agents/scripts/check.sh`, and
  `git diff --check` pass.

## Decisions

- The operator narrowed the task after consultation began: “我怎么感觉你把这个事情
  做复杂了？你先简单做”. The consultation expansion was stopped and its proposal
  artifacts were removed.
- Prompt effectiveness will be judged by the operator through later real review
  output, not by a new automated or multi-agent test harness.
- PR #392 review on 2026-09-08: the common identity is not composed into the
  shared finders or the sweep. The shared method already owns architecture
  challenge through the cleanup finder's simplification and Altitude angles;
  composing the Dreamux identity there would give the same responsibility two
  owners. The identity reaches the fast-path reviewer and the
  requirement-fidelity finder. The `SKILL.md` standing rule links to the identity
  blocks instead of restating them, and work prompts carry only turn-specific
  inputs, boundaries, and report contracts.
- Blocking unknowns: None.
