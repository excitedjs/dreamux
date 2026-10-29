# Fix workflow_run input schema rejected by Anthropic-compatible clients

## Current state

- Goal: Restore workflow_run visibility to Claude Code (and any client that rejects top-level anyOf in tool input schemas) by removing the schema-level anyOf and expressing the script/scriptPath one-of in the description; server-side validation stays the authority.
- State: `implementation`
- Requirement: [Final requirement](/.agents/tasks/workflow/fix-workflow-run-schema-anyof/requirement.md)
- Final solution: [Final solution (minimal-change fast path)](/.agents/tasks/workflow/fix-workflow-run-schema-anyof/technical-design/final.md)
- Solution review Issue: Not created (minimal-change fast path skips it).
- Blockers: None.
- Next action: Implement the approved change and run the four gates.
- Related tasks: None. Regression introduced by #453 (`75fc1ca0`), which had no task record.

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

## Delivery

- Pull request: Not opened.
- Knowledge closeout: Pending.
