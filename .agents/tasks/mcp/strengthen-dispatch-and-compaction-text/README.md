# Strengthen dispatch reminders and uppercase compaction labels

## Current state

- Goal: Restore push-based dispatch guidance, display COMPACTED SESSION in both runtime projections, and add binding notification receipts
- State: `implementation`
- Requirement: [Current requirement](/.agents/tasks/mcp/strengthen-dispatch-and-compaction-text/requirement.md)
- Final solution: [Final technical solution](/.agents/tasks/mcp/strengthen-dispatch-and-compaction-text/technical-design/final.md)
- Solution review Issue: Not required for the minimal-change fast path.
- Blockers: None. Dependency installation passed after restoring the original Git environment for the install subprocess; repository hooks were installed normally.
- Next action: Finish the combined implementation, tests, knowledge updates, and repository gates before independent review.
- Workflow: The operator approved continued direct TeamLeader implementation of all three items with one independent read-only review.
- Branch: `fix/async-receipt-guidance-cot-label`, created from `origin/next` at `dd2fc68`.
- Related tasks: Builds on [refine-model-facing-surfaces](/.agents/tasks/mcp/refine-model-facing-surfaces/README.md) and [feishu-cot-conversation-cards](/.agents/tasks/channel/feishu-cot-conversation-cards/README.md). This new combined wording request does not reopen either historical implementation scope.

## Development approval

- Status: Granted on 2026-09-09 in the operator's direct reply to the exact-restoration development question: "可以，开始开发" (approved; start development).
- Approved inputs: [requirement.md](/.agents/tasks/mcp/strengthen-dispatch-and-compaction-text/requirement.md) and [technical-design/final.md](/.agents/tasks/mcp/strengthen-dispatch-and-compaction-text/technical-design/final.md), revised to restore the three pre-`dc2b7eb` strings verbatim.
- Approved implementation boundary: The three receipt strings, two provider compaction labels, associated tests and adjacent comments, current knowledge owners, patch Rush change files, and task records. Existing schemas, attachment conditions, descriptions, prompts, completion semantics, and rendering mechanisms remain unchanged; no deployment or service operation.
- Expanded approval on 2026-09-09: "可以，合并做了就行" (approved; implement together), covering the additional Channel success-text carrier, Feishu binding/unbinding messages, associated tests and knowledge, continued direct TeamLeader implementation, and one independent read-only review.
- Delivery approval on 2026-09-09: "ok，推进到开 pr 出来" (proceed through opening the PR). This authorizes commit, push, and a PR targeting `next`, not merge or deployment.

## Delivery

- Pull request / CI / merge: Not started.
- Knowledge closeout: Owner updates implemented; final reconciliation awaits review.
- Validation: [Verification and review](/.agents/tasks/mcp/strengthen-dispatch-and-compaction-text/verification.md).
