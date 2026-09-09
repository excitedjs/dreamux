# Display turn usage summaries

## Current state

- Goal: Show native context and cumulative token usage as the final assistant activity before each supported runtime turn ends
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/channel/display-turn-usage-summary/requirement.md), revision 2026-09-09.
- Final solution: [Native-data-only display solution](/.agents/tasks/channel/display-turn-usage-summary/technical-design/final.md).
- Solution workflow: Operator selected the minimal-change fast path on 2026-09-09.
- Solution review Issue: Omitted under the selected fast path.
- Blockers: Real Codex model requests time out independently of Dreamux; full live verification is not green.
- Next action: Wait for PR CI and clear live-verification limitations before readiness. `done` records implementation/review/knowledge closeout, not live-verification or merge readiness.
- Verification: [Commands, coverage, and residual risk](/.agents/tasks/channel/display-turn-usage-summary/verification.md).
- Related tasks: Builds on [Feishu COT cards](/.agents/tasks/channel/feishu-cot-conversation-cards/README.md) and preserves [display/push-back separation](/.agents/tasks/architecture/split-streaming-display-from-pushback/README.md).

## Development approval

- Status: Granted against the linked requirement revision and final solution.
- Source: The operator selected "Approve development" in direct response to the final development-approval question on 2026-09-09; recorded at 2026-09-08T20:33:27Z.
- Approved implementation boundary: Native usage parsing and display in the Codex and Claude Code runtime packages, related tests, and task/product/runtime knowledge updates; TeamLeader implementation followed by one independent read-only review.
- Delivery authority: On 2026-09-09 the operator explicitly requested progressing through PR creation, authorizing commit and push after verification/review and a PR targeting `next`.
- Hook correction: The operator superseded the one-install policy exception and directed removing the environment-injected hook override while preserving Rush's repository checks. Commands clear only that injected environment; repository/global Git configuration is unchanged.
- Excluded authority: No merge, release, production runtime restart, or Team dissolution.

## Delivery

- Pull request: [#397](https://github.com/excitedjs/dreamux/pull/397), draft targeting `next`; implementation commit `6da5210`. Not ready for merge.
- CI / merge: Await normal PR CI; merge is not authorized.
- Independent review: APPROVE with no findings; TeamLeader adjudication and the final optional-outcome compatibility correction are recorded in verification.
- Knowledge closeout: Complete. Updated [Observing agents](/.agents/product/README.md#observing-agents), [native usage ownership](/.agents/domains/provider-runtime.md#native-turn-usage-display), and the [repository hook trap](/.agents/domains/repository-operations-and-release.md#an-environment-injected-hookspath-hides-the-repository-hooks).
- Unchanged owners: Config/state/maintenance, neutral contracts, CLI, glossary, and root routing are N/A because their shape and behavior did not change.
- Release notes: Generated patch change files for both runtimes; this additive display enhancement imposes no rebuild or custom-session migration.
- Validation: Task check, knowledge check, diff check, build, lint, source/test typechecks, both runtime suites, and built-CLI smoke pass. The full suite remains failed in five real-model Codex cases; live Claude and Feishu UI were not observed.
