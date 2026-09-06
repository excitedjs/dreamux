# Adopt provider completion token routing and settlement

## Current state

- Goal: Preserve completion-token routing while fixing Claude native background turns and requests steered into them.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/completion-routing/adopt-completion-token-routing/requirement.md)
- Final solution: [Final solution](/.agents/tasks/completion-routing/adopt-completion-token-routing/technical-design/final.md)
- Verification: [Verification](/.agents/tasks/completion-routing/adopt-completion-token-routing/verification.md)
- Solution review Issue: Not created — the operator approved the recorded final solution directly and waived further consultation (simplest path).
- Blockers: None.
- Accepted decision record: [accepted-decision.md](/.agents/tasks/completion-routing/adopt-completion-token-routing/accepted-decision.md) (backfilled 2026-09-01).
- Next action: Open the verified repair PR to `next` and report the five changed source files; await operator review without merging.
- Historical test replacement inventory (completed in PR #344; see verification): claude-code `rpc/runtime-activity/session/stream/transcript.test.ts`; codex `turn-manager.test.ts`; core `agent-runtime-provider`, `claude-code-live`, `claude-code-runtime`, `codex-completion`, `codex-live`, `core-event-owner-publishers`, `dispatcher-collaboration-space`, `entity-turn`, `external-runtime-parity`, `team-collection-read-path`, `team-scheduler`, `teammate-service`, `workflow-service` tests plus `helpers/fake-runtime`, `helpers/fake-team-runtime`, `helpers/runtime-turn`, `fixtures/external-runtime-provider`; types `fixtures.test.ts`, `root-exports.test.ts`, `fixtures/external-provider.ts`. Retained consumer suites (`team-dissolve-*`, `team-mcp-dissolve-boundary`, `collaboration-space-repo-close`, and all untouched files) compile again once the shared helpers are restored; the re-coverage stage must restore every deleted contract without weakening it.
- Related tasks: None.

## Development approval

- Status: Granted.
- Source: Operator instruction via the Team's bound channel, 2026-08-25 — implement the recorded solution as one PR, with a prescribed six-step process (task record; delete invalidated unit tests; one codex developer, code only; two independent reviewers checking the implementation against the approved architecture; batch multi-agent unit-test re-coverage on sonnet; open the PR).
- Approved implementation boundary: `packages/dreamux-types` runtime contract, `packages/dreamux` core completion-router and teammate-service wiring, `packages/agent-runtime/claude-code` settlement/rpc/stream/transcript-completion paths, `packages/agent-runtime/codex` turn-manager, associated tests and Rush change files. No other provider, no web/platform surface, no channel-facing telemetry projection.

## Original delivery (PR #344)

- Pull request / merge: PR #344 merged into `next` as `7fb1b8d3`.
- Knowledge closeout: Complete — decision record `provider-completion-token-routing`, current-architecture alignment, change files with breaking review notes, KB gate green (129 files reachable).

## Background-turn regression repair (2026-09-07)

- Lineage: reopens the regression introduced by PR #344, commit `7fb1b8d3`
  (author: YourWildDad). The original delivery remains historical above.
- Development approval: granted after the operator reviewed the revised
  requirement and solution in the bound conversation on 2026-09-07.
  Approval, translated from Chinese: "Fix it, then open a PR; after opening it,
  report how many source files you changed in total and why."
- Approved boundary: Claude provider runtime/protocol/activity handling and
  associated regression tests; task/owning knowledge and Rush release note.
  Neutral runtime contracts and Core completion routing remain unchanged.
  The Claude-specific custom session callback gains required command-group
  evidence, documented in the package README and a breaking release note.
- Current requirement: [Repair requirement](requirement.md#background-turn-repair-2026-09-07).
- Current solution: [Repair solution](technical-design/final.md#background-turn-repair-2026-09-07).
- Solution review: the operator directly reviewed and approved this repair in
  conversation; no additional solution Issue is required.
- PR authority: open a PR and report source-file count and purpose; no merge or
  deployment authority is implied.

## Repair knowledge closeout

- Requirement and solution: updated with background/steer behavior, positive
  UUID attribution and adjudicated cancellation/exit corrections.
- Owning knowledge: [provider runtime](/.agents/domains/provider-runtime.md#claude-code-stream-json-settlement)
  and the [product catalog](/.agents/product/README.md#background-work-and-completion-delivery)
  updated; historical COT records carry dated supersession links.
- Package extension contract: README and Rush breaking minor note document the
  required result command group. No neutral runtime or Core contract changed.
- Config/persisted state and maintenance synchronization: N/A; no shape, path,
  ownership, validation or meaning changed.
- Root routing/glossary/directory guidance: N/A; the existing completion-routing
  task and provider owner remain the correct entry points; no new concept needs
  another knowledge owner.
- Independent review: completed; accepted findings corrected, rejected
  hypotheses and evidence limits recorded in [verification](verification.md).
