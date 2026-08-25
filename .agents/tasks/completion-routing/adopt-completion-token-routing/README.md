# Adopt provider completion token routing and settlement

## Current state

- Goal: Replace the interim PR #342 settlement gate with the completion-token architecture: provider-owned logical completion identity, core at-most-once ordered completion delivery, and the Last completion boundary fix.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/completion-routing/adopt-completion-token-routing/requirement.md)
- Final solution: [Final solution](/.agents/tasks/completion-routing/adopt-completion-token-routing/technical-design/final.md)
- Verification: [Verification](/.agents/tasks/completion-routing/adopt-completion-token-routing/verification.md)
- Solution review Issue: Not created — the operator approved the recorded final solution directly and waived further consultation (simplest path).
- Blockers: None.
- Next action: Wait for CI on PR #344, then merge with operator authority.
- Deleted test inventory (step 2, to be fully re-covered before PR): claude-code `rpc/runtime-activity/session/stream/transcript.test.ts`; codex `turn-manager.test.ts`; core `agent-runtime-provider`, `claude-code-live`, `claude-code-runtime`, `codex-completion`, `codex-live`, `core-event-owner-publishers`, `dispatcher-collaboration-space`, `entity-turn`, `external-runtime-parity`, `team-collection-read-path`, `team-scheduler`, `teammate-service`, `workflow-service` tests plus `helpers/fake-runtime`, `helpers/fake-team-runtime`, `helpers/runtime-turn`, `fixtures/external-runtime-provider`; types `fixtures.test.ts`, `root-exports.test.ts`, `fixtures/external-provider.ts`. Retained consumer suites (`team-dissolve-*`, `team-mcp-dissolve-boundary`, `collaboration-space-repo-close`, and all untouched files) compile again once the shared helpers are restored; the re-coverage stage must restore every deleted contract without weakening it.
- Related tasks: None.

## Development approval

- Status: Granted.
- Source: Operator instruction via the Team's bound channel, 2026-08-25 — implement the recorded solution as one PR, with a prescribed six-step process (task record; delete invalidated unit tests; one codex developer, code only; two independent reviewers checking the implementation against the approved architecture; batch multi-agent unit-test re-coverage on sonnet; open the PR).
- Approved implementation boundary: `packages/dreamux-types` runtime contract, `packages/dreamux` core completion-router and teammate-service wiring, `packages/agent-runtime/claude-code` settlement/rpc/stream/transcript-completion paths, `packages/agent-runtime/codex` turn-manager, associated tests and Rush change files. No other provider, no web/platform surface, no channel-facing telemetry projection.

## Delivery

- Pull request / CI / merge: PR #344 open against `next`; CI pending; merge pending operator authority.
- Knowledge closeout: Complete — decision record `provider-completion-token-routing`, current-architecture alignment, change files with breaking review notes, KB gate green (129 files reachable).
