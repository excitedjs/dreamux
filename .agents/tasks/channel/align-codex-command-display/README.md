# Align Codex command display parsing

## Current state

- Goal: Show the inner shell script in Codex tool rows instead of the shell launcher wrapper
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/channel/align-codex-command-display/requirement.md)
- Final solution: [Final solution](/.agents/tasks/channel/align-codex-command-display/technical-design/final.md)
- Solution review Issue: Not required for the minimal-change fast path.
- Workflow: TeamLeader implementation after approval, followed by one independent read-only review.
- Verification: [Checks and display evidence](/.agents/tasks/channel/align-codex-command-display/verification.md).
- Blockers: No functional or architecture blocker; both review findings are approved and applied. All four repository gates also passed on the isolated delivery branch based on `next`, excluding the unrelated baseline commit.
- Next action: Commit and push the isolated task patch, open the authorized PR to `next`, and wait for CI. Feishu client visual verification remains unperformed.
- Related tasks: Builds on [Feishu conversation-of-thought cards](/.agents/tasks/channel/feishu-cot-conversation-cards/README.md); dedicated task creation confirmed by the operator on 2026-09-09.

## Development approval

- Status: Granted by the operator on 2026-09-09, directly answering the explicit development question: "批准，开始开发 (Recommended)".
- Approved requirement: [Requirement](/.agents/tasks/channel/align-codex-command-display/requirement.md).
- Approved solution: [Final solution](/.agents/tasks/channel/align-codex-command-display/technical-design/final.md).
- Approved implementation boundary: Codex display-only shell decoding, directly affected regression tests, task/knowledge closeout, and package change notes; TeamLeader implementation and one independent read-only review. No commit, push, deployment, service restart, or merge authority.

## Installation authorization

- On 2026-09-09 the operator answered the installation-permission question:
  "绕过 traex 的 githooks，安装 rush 的 hooks" (Bypass the Trae hooks and
  install Rush's hooks).
- Applied only to the dependency-installation child process: removed the injected
  Git hook-path environment entries, then ran ordinary Rush update successfully.
  Rush installed the repository pre-commit hook. No persistent Git configuration
  change, `--bypass-policy`, or repository-hook suppression was used.

## Delivery

- Authorization: On 2026-09-09 the operator selected "提交并创建 PR (Recommended)"
  in response to the explicit commit, push, and PR question. This authorizes
  delivery to a PR targeting `next` and waiting for CI, not merge, deployment,
  or service restart.
- Pull request / CI / merge: Not started.
- Knowledge closeout: Complete; owner updates and final local checks passed.

## Knowledge closeout

- [Provider runtime owner](/.agents/domains/provider-runtime.md): Updated the
  Codex display-command description and linked the owning source. Both review
  rulings and their implementation are recorded in [verification](verification.md).
- [Product catalog](/.agents/product/README.md#observing-agents): N/A for a new
  decision; this restores the existing **A tool row says what the call was,
  not how the runtime spelled it** contract. No row or execution capability
  is removed, and layout, labels, and redaction are unchanged.
- Task record and parent index: Reconciled with the actual diff. The requirement
  labels the initial raw-command behavior as an investigation baseline; the
  approved solution still matches the implementation without a scope change.
- Directory invariants, glossary, root routing, and maintenance references:
  N/A; no package boundary, term, entry point, CLI, config/state, protocol,
  lifecycle, or cross-process invariant changed. The provider's existing
  display owner remains responsible for its own command vocabulary.
- Release notes: Rush-generated Codex `patch` and Feishu test-only `none`
  changes; no upgrade blocker or rebuild action. Committed-branch verification
  runs before the authorized push.
