# Fix workflow_run input schema rejected by Anthropic-compatible clients

## Current state

- Goal: Restore workflow_run visibility to Claude Code (and any client that rejects top-level anyOf in tool input schemas) by removing the schema-level anyOf and expressing the at-least-one-of script/scriptPath rule in the description; server-side validation stays the authority.
- State: `done`
- Requirement: [Final requirement](/.agents/tasks/workflow/fix-workflow-run-schema-anyof/requirement.md)
- Final solution: [Final solution (minimal-change fast path)](/.agents/tasks/workflow/fix-workflow-run-schema-anyof/technical-design/final.md)
- Solution review Issue: Not created (minimal-change fast path skips it).
- Blockers: None.
- Next action: Wait for CI and operator merge authority on the PR.
- Related tasks: None. Regression introduced by [#453](https://github.com/excitedjs/dreamux/pull/453), which had no task record.

## Development approval

- Status: Granted on 2026-10-30.
- Approved implementation boundary:
  - `packages/dreamux/src/service/workflow-service/mcp.ts`: remove
    `inputConstraints` from the `workflow_run` descriptor; move the
    at-least-one-of `script`/`scriptPath` rule into its description.
  - `packages/dreamux/tests/mcp-tool-descriptions.test.ts`: one catalog-level
    regression assertion banning top-level `anyOf`/`oneOf`/`allOf` on
    advertised tool input schemas.
  - One `rush change` patch note for `@excitedjs/dreamux`.
  - Everything else (generic `inputConstraints` utility and its test, server
    validation, request readers, other tools) is out of scope.
- Approval evidence: the operator approved the development-authorization card
  sent on 2026-10-30 in the bound collaboration-space chat, selecting
  "批准，进入开发".

## Review

- Path: minimal-change fast path, one independent review seat.
- Reviewer: external Devbox review, per the channel's dev-workflow ruling that
  permits external review in place of the multi-seat workflow review.
- Review surface: [PR #482](https://github.com/excitedjs/dreamux/pull/482),
  review `CHANGES_REQUESTED` with the code change approved; every finding was
  task-record documentation, not source.
- Adjudication (operator ratified one item at a time on 2026-10-30):
  - Accepted: set this record to `done`; replace commit-hash citations with PR
    links; fill delivery facts; align two residual "exactly one" wordings with
    the inclusive at-least-one semantics.
  - Deferred by operator ruling, no tracking record: the regression guard
    walks the five Core-owned delegate catalogs but not channel-delegate
    catalogs. The built-in Feishu channel has no input-schema combinator (its
    single `anyOf` is in an output schema), so there is no live exposure;
    moving the rule into the neutral catalog freeze point is an architecture
    decision for another task if that surface grows.
- The branch was rebased onto the then-current `next` before review at the
  reviewer's request ([#480](https://github.com/excitedjs/dreamux/pull/480)
  had changed the same file); all four gates were rerun green on the rebased
  head.

## Verification and delivery

- Gates: `rush build`, `rush lint`, `rush test`, and `rush typecheck:tests`
  all pass on the rebased head.
- Mutation check: the new assertions fail against the pre-fix descriptor
  (three red: the two catalogs carrying `workflow_run` plus the description
  assertion) and pass after the fix; reproduced by both the TeamLeader and
  the independent reviewer.
- Knowledge closeout: added the input-schema portability rule to
  [model-facing-writing.md](/.agents/domains/model-facing-writing.md)
  (advertised input schemas carry no top-level combinators; cross-field rules
  live in descriptions with service-side enforcement). No other domain owner
  moved. `.agents/scripts/check.sh` passes.
- Release notes: ordinary `patch` change; no CLI/API contract, persisted
  file, or upgrade behavior changes.
- Delivery: [PR #482](https://github.com/excitedjs/dreamux/pull/482) targets
  `next`; GitHub owns review, CI, and merge state. Merge needs separate
  operator authority.
