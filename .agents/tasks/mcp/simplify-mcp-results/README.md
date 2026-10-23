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
- Follow-up on 2026-10-23: The operator explicitly authorized writing actionable facts directly into success text instead of serializing business JSON beside the reminder. This in-scope refinement proceeds under that authorization. The separate `last` recommendation was initially kept separate; the later usability direction below includes its verified-path implementation.
- Style follow-up on 2026-10-23: The operator requested corrections to the latest PR review comments. This remains within the approved MCP implementation; it does not authorize another deployment or merge.

- Usability follow-up on 2026-10-23: "另外那几个为什么变成了后续改进记录？这次为什么不一起做了？" The implementation now includes bounded status-filtered MCP lists, cron prompt preview/full read, and provider-owned activity path/native turn metadata. These are implementation choices under the original request to supplement missing facts, not a claimed verbatim approval of individual fields. No new deployment or merge is included.

## Verification and delivery

- Last-default follow-up on 2026-10-23: The operator requested "给他改成默认 false ，默认不返回 toolcall。" MCP `last` now defaults `include_tools` to false, with explicit true preserving tool reads. Command/provider defaults and live COT display are outside this change. The separate instruction to publish an alpha and update the managed install remains active; no merge was authorized.

- Evidence: [Historical audit and independent review](/.agents/tasks/mcp/simplify-mcp-results/verification.md).
- Follow-up input: [Dispatcher usability feedback](/.agents/tasks/mcp/simplify-mcp-results/usability-feedback.md), including reported list sizes and the independently checked space-identity discrepancy. The operator subsequently asked to include these gaps in this PR; the implemented boundaries and evidence are recorded below.
- Prior delivery gates: Rush build, lint, test and typecheck:tests passed after the authored-text refinement (2,914 tests passed; six opt-in real-model cases were not enabled). The whole-diff architecture review found no remaining production blocker. SDK/shim tests prove wire behavior, not live model consumption.
- Style follow-up gates: Rush build, lint, test and typecheck:tests passed (2,989 tests passed; six opt-in real-model cases were not enabled). Independent whole-diff review and final delta review found no remaining blocker.
- Usability continuation gates: Rush build, lint, test and typecheck:tests passed; 3,023 tests passed and six opt-in real-model cases were not enabled. Final architecture review found no blocker. This continuation is not a deployment or live rendering certification.
- Knowledge closeout: Updated the product catalog, MCP writing/channel/orchestration/topology/runtime owners, provider author documentation and configuration maintenance reference. The full KB check passed (59 task records; 397 reachable files).
- Release notes: Ordinary minor changes; no persisted-file migration or schema bump. External Channel tools that can return text must omit outputSchema; an unadapted tool can execute before the SDK rejects its result.
- Publication boundary: This style-review follow-up performed no live configuration replacement, deployment, or merge. Separate operator authority is required for merge.
