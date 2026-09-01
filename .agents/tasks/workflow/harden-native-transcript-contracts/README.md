# Harden native transcript contracts

## Current state

- Goal: Turn the merged native-transcript non-leakage and receipt semantics into enforceable tests, repair stale knowledge/change notes, and fix bounded reader edge cases
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/workflow/harden-native-transcript-contracts/requirement.md)
- Final solution: [Direct hardening solution](/.agents/tasks/workflow/harden-native-transcript-contracts/technical-design/final.md)
- Solution review Issue: Skipped by explicit operator instruction for this bounded follow-up.
- Verification: [Current verification evidence](/.agents/tasks/workflow/harden-native-transcript-contracts/verification.md)
- Blockers: No accepted finding or required CI gate remains unresolved.
  External Codex model-service gates remain outside this bounded hardening
  change; GitHub review approval remains required.
- Next action: Obtain GitHub review approval for PR #339. Do not merge
  automatically.
- Related tasks: Builds on [Unify Workflow agents with TeamMate lifecycle ownership](/.agents/tasks/workflow/unified-teammate-lifecycle/README.md) and merged PR [#338](https://github.com/excitedjs/dreamux/pull/338).

## Development approval

- Status: Granted.
- Source: Operator directed the Team to merge PR #338, create the follow-up PR,
  skip requirement consultation and solution review, and directly orchestrate
  development plus review at `2026-08-16T22:48:15+08:00`.
- Approved implementation boundary:
  - Add enforceable static and behavioral gates proving `transcript_path` stays
    restricted to direct TeamMate `spawn` / `send` receipts.
  - Pin receipt path nullability to established session association rather than
    submission status.
  - Remove the deleted Turn-store path and duplicate entry from the current KB
    source list.
  - Make the `@excitedjs/dreamux-types` breaking note explicitly name removal of
    `AgentRuntime.getLast()`.
  - Remove the unnecessary final empty Codex transcript page.
  - Make page `truncated` describe returned clipping only.
  - Bound model-visible tool names and validate the same limit in core.
  - Keep runtime-native formats, public query shape, persisted state, and
    provider-neutral ownership unchanged.
- Workflow override: One workflow may run the single writer and fresh read-only
  review stages in sequence. The developer may not edit `.agents/**`; the
  TeamLeader owns task and KB writes.

## Delivery

- Pull request: [#339](https://github.com/excitedjs/dreamux/pull/339),
  targeting `next`.
- CI: Passed on reviewed head
  `df52ebb7bf771a225d24734efef87cd8329172a5`: Rush change declaration,
  author metadata, Linux/macOS shellcheck, KB validation, full-history
  gitleaks, and Linux/macOS Rush build/typecheck/lint/test.
- Merge: Not authorized or attempted.
- Independent review:
  - Combined development/review workflow
    `run-08ea99ea-91c9-46c0-bda1-71937f0079e7`: `FIX_REQUIRED`; all accepted
    findings repaired.
  - Complete corrected working-tree xhigh review
    `run-4c2aa8c3-9ae5-49ef-853c-ee1954d155c1`: one confirmed multi-segment
    exact-budget pagination finding; repaired.
  - Final scoped xhigh review
    `run-1ac4b860-df9d-47e2-9767-9bf0f3b9cf67`: zero findings, no partial
    coverage.
- Knowledge closeout: Complete.
  - Updated [State, config, and files](/.agents/domains/state-config-and-files.md)
    and [Channel routing and binding](/.agents/domains/channel.md)
    to remove stale current-source pointers.
  - Decision update: N/A — this follow-up enforces and repairs the already
    accepted native-transcript contract without changing ownership or public
    architecture.
