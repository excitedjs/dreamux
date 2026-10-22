# Simplify MCP results and preserve reminders

## Current state

- Goal: Reduce repeated Team and TeamMate MCP data, expose configured runtime guidance and collaboration-space identity, and preserve operation reminders in model-visible results.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/mcp/simplify-mcp-results/requirement.md)
- Final solution: [Technical solution](/.agents/tasks/mcp/simplify-mcp-results/technical-design/final.md)
- Solution review Issue: Not created.
- Blockers: None.
- Delivery: [PR #480](https://github.com/excitedjs/dreamux/pull/480) targets `next`; GitHub owns review, CI and merge state.
- Related tasks: Builds on `refine-model-facing-surfaces`, `strengthen-dispatch-and-compaction-text`, `enable-team-member-messaging`, and `architecture/unify-team-command-projections`.

## Development approval

- Status: The operator directly requested these changes on 2026-10-22, approved the capability-cleanup direction, and expanded the implementation scope to all Team/TeamMate results. No interactive approval card was sent; this record does not claim one. Work proceeds under direct task authorization and the session instruction to complete already-authorized work without repeated permission requests.
- Approved implementation boundary: MCP projections and reminder delivery, optional configured runtime guidance and instruction application, collaboration-space identity, demonstrated missing status facts, tests and documentation. Historical analysis is read-only. No live configuration replacement, deployment, or merge is authorized by this record.

## Verification and delivery

- Evidence: [Historical audit and independent review](/.agents/tasks/mcp/simplify-mcp-results/verification.md).
- Local gates: Rush build, lint, test and typecheck:tests passed again after the external-review corrections. Tests: 2,901 passed; six opt-in real-model cases were not enabled. SDK/shim tests prove wire behavior, not live model consumption.
- Knowledge closeout: Updated the product catalog, MCP writing/channel/orchestration/topology/runtime owners, provider author documentation and configuration maintenance reference. The full KB check passed (58 task records; 392 reachable files).
- Release notes: Ordinary minor changes; no persisted-file migration or schema bump. External Channel tools that can return text must omit outputSchema; an unadapted tool can execute before the SDK rejects its result.
- Publication boundary: No live configuration replacement, deployment, or merge was performed. Separate operator authority is required for merge.
