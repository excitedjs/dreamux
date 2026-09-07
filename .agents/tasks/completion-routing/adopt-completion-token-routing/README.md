# Adopt provider completion token routing and settlement

## Current state

- Goal: Replace Claude request-window coordination with resident-session input and per-request settlement, preserving completion-token routing and background work.
- State: `done`
- PR correction requirement: [Accepted review corrections](pr-review-fixes.md)
- Requirement: [Current requirement](/.agents/tasks/completion-routing/adopt-completion-token-routing/requirement.md)
- Final solution: [Resident-session replacement](/.agents/tasks/completion-routing/adopt-completion-token-routing/technical-design/session-submissions.md)
- Operator rulings: [Rulings](/.agents/tasks/completion-routing/adopt-completion-token-routing/rulings.md)
- Verification: [Verification](/.agents/tasks/completion-routing/adopt-completion-token-routing/verification.md)
- Solution review Issue: Not created — the operator approved the recorded final solution directly and waived further consultation (simplest path).
- Blockers: None.
- Accepted decision record: [accepted-decision.md](/.agents/tasks/completion-routing/adopt-completion-token-routing/accepted-decision.md) (backfilled 2026-09-01).
- Next action: Push the verified PR review corrections to PR #384 and observe normal CI. Merge requires separate operator authority.
- Historical test replacement inventory (completed in PR #344; see verification): claude-code `rpc/runtime-activity/session/stream/transcript.test.ts`; codex `turn-manager.test.ts`; core `agent-runtime-provider`, `claude-code-live`, `claude-code-runtime`, `codex-completion`, `codex-live`, `core-event-owner-publishers`, `dispatcher-collaboration-space`, `entity-turn`, `external-runtime-parity`, `team-collection-read-path`, `team-scheduler`, `teammate-service`, `workflow-service` tests plus `helpers/fake-runtime`, `helpers/fake-team-runtime`, `helpers/runtime-turn`, `fixtures/external-runtime-provider`; types `fixtures.test.ts`, `root-exports.test.ts`, `fixtures/external-provider.ts`. Retained consumer suites (`team-dissolve-*`, `team-mcp-dissolve-boundary`, `collaboration-space-repo-close`, and all untouched files) compile again once the shared helpers are restored; the re-coverage stage must restore every deleted contract without weakening it.
- Related tasks: None.

## Development approval

- Status: Granted.
- Current approval: 2026-09-07 13:45 local time, explicitly authorizing implementation of the resident-session replacement described in the bound conversation. See [ruling R2](rulings.md#r2-implement-the-replacement).
- Current boundary: Claude provider input, native result attribution and request settlement; associated tests, package extension documentation, release notes and owning knowledge. Core and neutral runtime contracts remain unchanged. The previous development approval below records the original PR #344 delivery.
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

## Style and redundancy cleanup (2026-09-07)

- PR #384 is open at `72af66e5`; its alpha was published and verified before the
  independent Claude complexity review.
- The review found lower complexity and no required correctness correction.
  The operator then explicitly authorized cleaning style and redundant code
  instead of leaving it as optional follow-up. Translation of the instruction:
  "Pursue this more thoroughly; fix any code-style or redundant-code issues
  along the way."
- Development approval: granted for behavior-preserving cleanup of the affected
  Claude source/test path and its task records. Use the existing writer and
  update the existing PR. The repair requirement and completion-routing
  behavior remain the baseline.
- Verification: inspect removed state and all consumers, preserve compatibility
  tests, run the four Rush gates, then obtain an independent review of the
  cleanup. Await TeamMate completion notifications without result polling.
- Outcome: all four full-workspace gates passed. Independent Claude review
  found no behavior change or weakened assertion; both wording findings were
  corrected and checked by the TeamLeader. The final wording-only pass changed
  one fixture comment and five test titles, leaving executable test bodies and
  assertions intact.
- Complete PR scope: six Claude source files and seven test/fixture files.
  runtime-session.ts is the sixth source file because adjacent result-text
  handling repeated an error condition already handled by a throw.
- Cleanup knowledge owners: task requirement, solution and verification updated.
  Product/provider domain owners, neutral contracts, state/config maintenance,
  glossary and root routing need no additional changes: this cleanup preserves
  the repaired behavior and existing ownership, with no new concept or surface.

## Resident-session replacement (2026-09-07)

The operator rejected repeated local patching as the architectural standard and
asked what a fresh implementation would require. The TeamLeader traced the
retained request window through PR #344 and proposed replacing input-to-settlement
coordination while preserving unrelated provider capabilities. The operator
explicitly approved implementation of that proposal; see [rulings](rulings.md).

The current implementation baseline is `6acc6d28`. Earlier repair, cleanup,
alpha and review results above describe that earlier implementation, not the
replacement. Its acceptance and evidence will be recorded separately.

### Replacement knowledge closeout

- Implementation, TeamLeader whole-diff pre-review, four full-workspace Rush
  gates and three fresh real Claude/provider/Core scenarios passed. The
  operator omitted workflow review before it started; no independent review of
  this revision is claimed. See [verification](verification.md#resident-session-replacement-verification-2026-09-07).
- Task requirement, solution and rulings: current. Provider-runtime owner and
  package README: updated to unified submission and per-request settlement.
  Historical COT source links preserve their prior revision and identify the
  current activity owner. The Rush breaking minor note describes the final
  Claude-specific extension change and supersedes the earlier repair note.
- Product catalog: N/A for additional replacement changes; the existing
  background-work and completion-delivery entries remain satisfied.
- Config/persisted-state maintenance: N/A; no shape, path, default, ownership or
  meaning changes. `config.ts` changes only a stale comment.
- Root routing, glossary and directory guidance: N/A; the existing task and
  provider owner remain authoritative, without a new shared mechanism.
- Complete PR source scope: ten paths, all in the Claude package. Core and
  neutral runtime contracts are unchanged.

### PR failure correction closeout

- Accepted swallowed-error, failure/stop classification and public API note
  findings are corrected under rulings R4/R5. The Claude provider has no user
  cancellation entry point; native cancelled is not a user-stop signal.
- Full Rush gates, targeted TeamLeader reproductions and knowledge checks pass;
  see [correction verification](verification.md#pr-failure-handling-correction-2026-09-07).
  Current test-contract changes are checked against SDK/native evidence.
- Owning provider knowledge, requirement, design correction and rulings are
  updated together. Product catalog, config/state maintenance, root routing and
  glossary need no changes: this corrects failure reporting without adding a
  product action, shared mechanism or persisted fact.
- This correction changes five source and five test files, package README and
  the existing breaking minor note. The complete PR retains ten source paths.
