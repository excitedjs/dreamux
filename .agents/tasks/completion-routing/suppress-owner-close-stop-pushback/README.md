# Drop lifecycle-stop completion pushback

## Current state

- Goal: Stop reporting a turn or Workflow terminal to the owner whose own close, stop, dissolve, or shutdown ended it, by reading the scope fence on the recipient side rather than retiring obligations on the producer side.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/requirement.md)
- Final solution: [Fence completion delivery at the recipient's scope](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/technical-design/final.md)
- Solution review Issue: [#388](https://github.com/excitedjs/dreamux/issues/388)
- Superseded delivery: [PR #389](https://github.com/excitedjs/dreamux/pull/389),
  a producer-side design the operator rejected on 2026-09-08 for its shape
  (“他现在这个写法像是各处的堵漏”); its behavior tests are reused, its mechanisms
  are not, and its review trail stays on that PR.
- Blockers: None.
- Next action: None.
- Related tasks:
  - `builds-on`: [Adopt provider completion token routing and settlement](/.agents/tasks/completion-routing/adopt-completion-token-routing/README.md) — retains the general failed/stopped settlement path introduced before that refactor.
  - Historical behavior origin: [PR #149](https://github.com/excitedjs/dreamux/pull/149).
  - Lifecycle consolidation that made close use the common stop-and-deliver path: [PR #338](https://github.com/excitedjs/dreamux/pull/338).

## Development approval

- Behavioral rulings: recorded verbatim in the requirement; all were given
  during the PR #389 cycle on 2026-09-07 and 2026-09-08 and stand unchanged.
- Redo approval: granted on 2026-09-08 when the operator, shown the
  recipient-side design, replied “可以，按照你的思路重做吧，这个pr 不符合我的预期。”
  and then “从 next 上拉新分支出来重新做。”.
- Approved implementation boundary: the dispatcher admission gate read by
  `CompletionDeliveryPolicy`, the entity fence read by `EntityTurn`, the
  Workflow run's nullable terminal report, the behavior tests, the owning
  knowledge, and one patch Rush change file for `@excitedjs/dreamux`. Agent
  Runtime and Channel providers, public Command/MCP contracts, completion
  rendering, and persisted config/state remain outside the boundary.

## Delivery

- Pull request: [#391](https://github.com/excitedjs/dreamux/pull/391).
- Knowledge closeout: product catalog, dispatcher-orchestration domain, service
  topology, `service/CLAUDE.md`, and the maintenance service-lifecycle
  reference updated in the same change; no config or persisted-state shape
  changed.
