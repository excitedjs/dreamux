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
- Follow-up on 2026-10-23: The operator explicitly authorized writing actionable facts directly into success text instead of serializing business JSON beside the reminder. This in-scope refinement proceeds under that authorization. The separate question about `last` is a recommendation only; no transcript path implementation is included.
- Style follow-up on 2026-10-23: The operator requested corrections to the latest PR review comments. This remains within the approved MCP implementation; it does not authorize another deployment or merge.

## Verification and delivery

- Evidence: [Historical audit and independent review](/.agents/tasks/mcp/simplify-mcp-results/verification.md).
- Follow-up input: [Dispatcher usability feedback](/.agents/tasks/mcp/simplify-mcp-results/usability-feedback.md), including reported list sizes and the independently checked space-identity discrepancy. These are follow-up proposals, not additional implementation approval.
- Prior delivery gates: Rush build, lint, test and typecheck:tests passed after the authored-text refinement (2,914 tests passed; six opt-in real-model cases were not enabled). The whole-diff architecture review found no remaining production blocker. SDK/shim tests prove wire behavior, not live model consumption.
- Style follow-up gates: Rush build, lint, test and typecheck:tests passed (2,989 tests passed; six opt-in real-model cases were not enabled). Independent whole-diff review and final delta review found no remaining blocker.
- Knowledge closeout: Updated the product catalog, MCP writing/channel/orchestration/topology/runtime owners, provider author documentation and configuration maintenance reference. The full KB check passed (59 task records; 396 reachable files).
- Release notes: Ordinary minor changes; no persisted-file migration or schema bump. External Channel tools that can return text must omit outputSchema; an unadapted tool can execute before the SDK rejects its result.
- Publication boundary: This style-review follow-up performed no live configuration replacement, deployment, or merge. Separate operator authority is required for merge.
