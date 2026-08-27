# Minimize Core Provider Boundaries

## Current state

- Goal: Reduce the public Agent Runtime and Channel contracts to minimal capability-neutral ports, with Channel bridging external interaction through Core Command invocation and Core event subscription.
- State: `development`
- Requirement: [Current requirement](/.agents/tasks/architecture/minimize-provider-boundaries/requirement.md)
- Current solution input revision: `requirement.md` SHA-256 `996580fa8f32fdd09795d79f6639581f4a9e70cdb3cdaf13b66f2b8f8083e9dd`
- Prior solution input revision: `requirement.md` SHA-256 `2b3fa58302dca9d533f97a2c92b35cd2b4e74cfcab6846f3a859c744578ade2e`; the operator then made the implementation stop rule explicit: written baselines never silently override unexamined load-bearing source behavior or prior Decisions.
- Prior solution input revision: `requirement.md` SHA-256 `803bf0d086f38c583ba3d146f96de098c828e07bb27ef5b1510e63536da8798d`; implementation review exposed the previously omitted, load-bearing neutral system-prompt replace/append behavior, which the operator restored before Agent Runtime migration continued.
- Prior solution input revision: `requirement.md` SHA-256 `7895d39a7f47c557afb82f8f0bc7c46520566566cc14557bae5572d646bd5e2c`; the operator subsequently retained the explicit Collaboration Space user flow as a Feishu Channel-owned MCP and provisioning policy without restoring the deleted Core container.
- Prior solution input revision: `requirement.md` SHA-256 `349635060d19afe73ed3d1e84df5070bce225364553389f5074c624180598a07`; the operator subsequently specified the complete Channel-MCP registration/forwarding path and unified `admin.sock` with Channel invocation through one unrestricted, domain-namespaced Core Command registry.
- Prior solution input revision: `requirement.md` SHA-256 `527711f503b9a948a1e5eb0b58187b6736abeae3b9f7fb74084a4793df47642e`; the operator subsequently unified Agent state as `teammate.state`, added redundant member summaries to `team.state`, and namespaced the submit Command as `team.submit`.
- Prior solution input revision: `requirement.md` SHA-256 `89e95d7fb3fd0dcf5585484becbd529a34d6d425e73aae500a31595210a5433c`; the operator subsequently namespaced the complete TeamMate turn-event family as `teammate.turn.*`.
- Superseded solution input revision: `requirement.md` SHA-256 `28ecbb5363f0d0faa2a696a6bf0eb0670192c89e7c778241c37aafecc5a3fbdc`; third-round review temporarily reopened a binding-reconciliation concern whose independent-offline-Channel premise the operator rejected.
- Independent review: [Consolidated findings](/.agents/tasks/architecture/minimize-provider-boundaries/review-findings.md)
- Solution consultation:
  [Codex proposal and cross-review](/.agents/tasks/architecture/minimize-provider-boundaries/technical-design/proposals/codex.md),
  [Claude proposal and cross-review](/.agents/tasks/architecture/minimize-provider-boundaries/technical-design/proposals/claude.md), and
  [Trae Seed 2.1 proposal and cross-review](/.agents/tasks/architecture/minimize-provider-boundaries/technical-design/proposals/trae-seed-2-1.md).
- Current solution baseline: [Technical design](/.agents/tasks/architecture/minimize-provider-boundaries/technical-design/final.md), SHA-256 `c456165258757c1ea6df8a753691d118b691fca379e65205f9c3450395e7c452`. It governs modeled scenarios but never silently overrides a conflicting load-bearing source behavior or prior Decision discovered during implementation; every such conflict returns to the operator.
- Prior final-solution revision: SHA-256 `137db732ebdcd07f902f1b31d45682610f656d240bbad831e3b9744af8a7fdda`; it restored system-prompt semantics before the operator made the stronger current-code conflict stop rule explicit.
- Prior final-solution revision: SHA-256 `62e48dc31ea49356b0836abb2bf73523591989d57a199bb8266ab59061b6477d`; it incorrectly flattened the load-bearing system-prompt replace/append pair to one string.
- Implementation plan: [Staged implementation ledger](/.agents/tasks/architecture/minimize-provider-boundaries/implementation-plan.md)
- Prior Fable audit: `READY` for requirement SHA-256 `803bf0d086f38c583ba3d146f96de098c828e07bb27ef5b1510e63536da8798d` and final-solution SHA-256 `62e48dc31ea49356b0836abb2bf73523591989d57a199bb8266ab59061b6477d`. A focused re-audit of the corrected system-prompt contract is pending before Stage 2 resumes.
- Solution review Issue: [#349 Architecture: minimize Agent Runtime and Channel provider boundaries](https://github.com/excitedjs/dreamux/issues/349)
- Solution workflow: Complex three-proposal consultation with one independent round followed by one cross-review round; selected by the operator through the Team's bound channel on 2026-08-27.
- Blockers: None. Channel and Core are same-process and lifecycle-coupled; no independent Channel offline/reconnect, remote state synchronization, startup Team-read reconciliation, snapshot, or replay model is required. Remaining items are technical-solution obligations.
- Next action: Re-audit the corrected system-prompt requirement/design, then restore the retained Codex system-prompt test, correct the Stage 1 public type, and resume the same Claude Developer at Stage 2.
- Related tasks: Surfaced after [Feishu COT Conversation Cards](/.agents/tasks/channel/feishu-cot-conversation-cards/README.md); this is an independent architecture outcome.

## Development approval

- Status: Granted by the operator on 2026-08-27.
- Approved implementation boundary: The complete frozen requirement and final
  technical design, executed through the staged protocol in
  `implementation-plan.md`.
- Review-fix boundary: No Reviewer finding may be implemented without a new
  explicit operator approval for that correction round.

## Delivery

- Pull request / CI / merge: Not started.
- Knowledge closeout: Pending.
