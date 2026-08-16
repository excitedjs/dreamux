# Unify Workflow agents with TeamMate lifecycle ownership

## Current state

- Goal: Define and implement owner-correct lifecycle boundaries so Workflow-created agents remain ordinary TeamMates in the shared collection, close through the TeamMate-owned lifecycle, and expose recent conversation history from each Agent Runtime's native transcript without Dreamux-owned Turn archives or rolling conversation snapshots in `identity.json`
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/workflow/unified-teammate-lifecycle/requirement.md)
- Current solution input revision: `requirement.md` SHA-256
  `e44f6411914cd1ff5ea49c55f09bbae17ad162f62335123f43d89ea0405208d0`
- Final solution: [Native transcript history with entity-owned lifecycle](/.agents/tasks/workflow/unified-teammate-lifecycle/technical-design/final.md),
  SHA-256 `157cb2602c2986d7877ab34085be6b7401c33c5778f9657ec85f4c866c05f300`
- Superseded turn-only path-receipt revision: `requirement.md` SHA-256 `43122c1a1b266f9f852a300da46328cf2002efe53ce53ef5de7e448288bfc526`; clarified that transcript path availability follows the TeamMate session association rather than the current turn-admission status
- Superseded fixed-budget expanded-query revision: `requirement.md` SHA-256 `59d8129a9c010b75bc0067de9d60812be6850dbde9f300ff45fb8f675a72ec2b`; operator removed built-in grep/time filters and required native transcript paths on `spawn` / `send`
- Superseded expanded-query input revision: `requirement.md` SHA-256 `6328cda7055dd43dc1fe1ac0a79ecff581ab0f4c57ff159a48f1b281f325b4cc`; operator removed caller-configurable `max_bytes`
- Previous native-transcript solution input revision: `requirement.md` SHA-256 `2950501723ad83692d759cfbd2285bb7ca7db419996f3d09bb2c959d8143dee7`; superseded by the expanded transcript-query requirement
- Previous solution input revision: `requirement.md` SHA-256 `4367fcdee10bbe23c5af6a2a3806772fcda3eb57887432552d3b0488e45c264a`; superseded by the reopened native-transcript clarification
- Consultation proposals:
  - [Entity lifecycle proposal](/.agents/tasks/workflow/unified-teammate-lifecycle/technical-design/proposals/arch-entity.md)
  - [Event and dependency proposal](/.agents/tasks/workflow/unified-teammate-lifecycle/technical-design/proposals/arch-events.md)
  - [Membership proposal](/.agents/tasks/workflow/unified-teammate-lifecycle/technical-design/proposals/arch-membership.md)
- Focused simplification reviews:
  - [Entity ownership review](/.agents/tasks/workflow/unified-teammate-lifecycle/technical-design/reviews/lock-native-id-entity.md)
  - [Membership and compatibility review](/.agents/tasks/workflow/unified-teammate-lifecycle/technical-design/reviews/lock-native-id-membership.md)
  - [Event and race review](/.agents/tasks/workflow/unified-teammate-lifecycle/technical-design/reviews/lock-native-id-events.md)
- Repository-red-line reviews:
  - [Ownership and repository scan](/.agents/tasks/workflow/unified-teammate-lifecycle/technical-design/reviews/redline-ownership.md)
  - [Requirement and transcript fidelity](/.agents/tasks/workflow/unified-teammate-lifecycle/technical-design/reviews/redline-requirement.md)
  - [Public surface and delivery](/.agents/tasks/workflow/unified-teammate-lifecycle/technical-design/reviews/redline-public-surface.md)
- Superseded final solution revision: `technical-design/final.md` SHA-256 `ab3e27fbc6e6c46f4ae12ab60cc616b22b7a746bd9a62eb1f653024c9fb97e6d`; its strict Dreamux Turn archive and rolling identity projection are rejected by the current final solution
- Solution review Issue: [#337](https://github.com/excitedjs/dreamux/issues/337)
- Verification: [Current verification evidence](/.agents/tasks/workflow/unified-teammate-lifecycle/verification.md)
- Implementation writer: one approved non-Codex writer completed the contracted
  implementation, the TeamLeader pre-review remediation, and the accepted
  independent-review remediation. TeamLeader whole-diff review, focused tests,
  full build/typecheck/test-typecheck/lint/test, change verification, task/KB
  checks, deletion scans, and publication-surface scans passed. Evidence is
  recorded in
  [verification.md](/.agents/tasks/workflow/unified-teammate-lifecycle/verification.md#current-native-transcript-iteration).
- Blockers: No accepted implementation-review finding or required CI gate
  remains unresolved. Two non-required Codex real-model gates remain limited by
  external model-service health and are recorded as residual live coverage.
- Next action: Obtain the required GitHub review and operator merge authority
  for PR #338. Do not merge automatically.
- Related tasks: Builds on public issue [#328](https://github.com/excitedjs/dreamux/issues/328). PRs [#329](https://github.com/excitedjs/dreamux/pull/329) and [#330](https://github.com/excitedjs/dreamux/pull/330) are competing historical inputs, not an accepted solution.

## Execution constraint

- Do not use any Codex-backed TeamMate for the reopened solution review,
  implementation, or implementation review.
- Use only available non-Codex TeamMate runtimes that comply with the
  repository publication red line; resolve exact runtime IDs from Team
  capabilities outside repository artifacts before dispatch.
- The previous implementation writer is not reused. The reopened implementation
  must still have exactly one write-capable TeamMate.
- Repository publication red line: do not name, register, package, document,
  test, or otherwise expose the operator-prohibited external provider family.
  This task adds no new built-in provider. Generic external providers continue
  to integrate through the neutral `AgentRuntimeProvider` contract.

## Development approval

- Status: Approved for implementation.
- Source: Operator approval received in the active conversation at
  `2026-08-16T14:36:07+08:00`.
- Superseded requirement: `requirement.md` SHA-256 `bc6c770f46362b535050f69342a68dd4a954346abb2eea8200e63946ca87df54`.
- Superseded solution: `technical-design/final.md` SHA-256 `3ce44602ca9b47a9fcf4c17f0c8456b2d70ab03d4cb506bf9aea996e1d1cb20d`.
- Pending approval requirement: `requirement.md` SHA-256
  `e44f6411914cd1ff5ea49c55f09bbae17ad162f62335123f43d89ea0405208d0`.
- Pending approval solution: `technical-design/final.md` SHA-256
  `157cb2602c2986d7877ab34085be6b7401c33c5778f9657ec85f4c866c05f300`.
- Approved requirement: `requirement.md` SHA-256
  `e44f6411914cd1ff5ea49c55f09bbae17ad162f62335123f43d89ea0405208d0`.
- Approved solution: `technical-design/final.md` SHA-256
  `157cb2602c2986d7877ab34085be6b7401c33c5778f9657ec85f4c866c05f300`.
- Approved implementation boundary:
  - Retain the entity-owned lifecycle, in-process Turn object, captured
    delivery, close-first Workflow/Team/shutdown, and bounded termination
    implementation already present.
  - Remove Dreamux Turn archives, archive preflight/repair/migration, rolling
    identity conversation fields, archive-gated settlement, and live-runtime
    history caches with no-touch fail-open compatibility.
  - Finish the provider-neutral cold transcript contract and the existing
    public Codex/Claude Code built-in readers; add no new built-in provider.
  - Keep direct `spawn`/`send` `transcript_path`, turn-only `last`, fixed output
    bounds, tool blocks, typed transcript-error reasons, fixed core error
    mapping, boundary-integrity cursors, strict continuation progress, and
    null-cursor open-tail semantics.
  - Complete every acceptance fixture in final verification items 13-19,
    including archive/lineage/compression/rewrite, Claude native history
    branches, error mapping, locator safety, and publication red-line scans.
  - Update change notes and public/current-state docs without exposing the
    operator-prohibited provider family.
- Iteration staffing: use one new non-Codex implementation writer and a new
  non-Codex implementation-review cohort; do not reuse either stopped
  implementation writer or any prior reviewer.

## Delivery

- Pull request: [#338](https://github.com/excitedjs/dreamux/pull/338),
  targeting `next`. Its public head must match this reviewed workspace and pass
  the normal CI gate before merge.
- Local final gate: Passed on the reviewed native-transcript workspace:
  focused remediation tests, Rush build/typecheck/test-typecheck/lint/test,
  Rush change verification, task/KB checks, diff validation, deletion scans,
  and repository-publication scans.
- CI: Passed on reviewed head
  `e09c64fef47b7afa4c686f403198d18d030b4302`: Rush change declaration,
  author metadata, Linux/macOS shellcheck, KB validation, full-history
  gitleaks, and Linux/macOS Rush build/typecheck/lint/test.
- Merge: Not authorized or attempted.
- Independent implementation review: Complete. The non-Codex `xhigh` workflow
  verified all 32 candidates with no partial coverage, reported 14 primary
  findings, and refuted 13 candidates. TeamLeader adjudication accepted eight
  findings and rejected six against the frozen requirement and solution; all
  accepted findings were repaired and revalidated.
- Knowledge closeout: Complete for the native-transcript iteration. Current
  owners and the accepted decision trail are recorded in
  [verification.md](/.agents/tasks/workflow/unified-teammate-lifecycle/verification.md#knowledge-closeout).
