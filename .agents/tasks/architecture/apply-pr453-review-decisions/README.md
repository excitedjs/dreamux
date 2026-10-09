# Apply selected PR #453 review decisions

## Current state

- Goal: Fix the selected PR #453 findings and remove all remaining re-exports from Dreamux core under the operator's subsequent explicit instruction.
- State: `done`
- Requirement: [Accepted requirement](/.agents/tasks/architecture/apply-pr453-review-decisions/requirement.md).
- Final solution: [Repair solution](/.agents/tasks/architecture/apply-pr453-review-decisions/technical-design/final.md).
- Solution review Issue: The operator selected the concrete repair directions directly in review comments; no separate solution Issue is claimed.
- Blockers: None. C1/R1 and the added core re-export removal are corrected, independently verified and locally validated.
- Next action: Submit the reviewed core deletion in the existing PR. Merge, release and deployment remain separate authority.
- Verification: [Pre-review and final evidence](/.agents/tasks/architecture/apply-pr453-review-decisions/verification.md).
- Related tasks: Builds on [Code organization refactor](/.agents/tasks/architecture/code-organization-refactor/README.md), delivered in [PR #453](https://github.com/excitedjs/dreamux/pull/453); scheduling context is [Cron foundations](/.agents/tasks/mcp/scheduler/cron-foundations/README.md).

## Development approval

- Status: Granted by the operator's direct review comments on 2026-10-09, quoted with their exact finding scopes in the requirement. No additional approval card is claimed.
- Approved implementation boundary: F2 scheduler transactions, F3 mandatory team_name decoding, A1 shared activity file opening, and A4–A9's specific dead/redundant mechanisms. F1, A2, A3 and A10 are outside this implementation.
- Additional authority: On 2026-10-09 the operator said, “有点扯淡，先给 core 的重导出都删掉。” This expressly adds removal of every core forwarding export and the consumer/configuration/smoke changes necessary to complete that removal. It does not extend to sibling packages or their public entries. No additional approval card is claimed.

## Review runtime selection

The operator's initial runtime selection was narrowed to two finding seats (Mimo and Trae Seed) with Codex verification. The operator then stopped that workflow: “先停掉吧”. Seed had returned zero candidates; Mimo had returned two candidates, but neither Codex verifier completed. No clean-review verdict is claimed from any stopped run.

The selected-repair review followed the later rulings: “简化流程，你手动调度，然后拉起一个codex 去 verify” and “seed没有找到问题的话，你就直接 拉 mimo 和 deepseek 去 review 就可以了”. Two direct TeamMates, Mimo and DeepSeek, independently reviewed the selected repairs; one Codex TeamMate verified recovered and new candidates. The added core re-export removal received a separate read-only verification turn from the same Codex verifier, which passed after inspecting the full addition and compiled main/service graph. No workflow was restarted.

## Delivery

- Pull request: [PR #466](https://github.com/excitedjs/dreamux/pull/466), targeting next. Merge, release and deployment are not included in this task's authority.
- Knowledge closeout: Updated scheduled-work.md, provider-runtime.md, channel.md, product/README.md, the owning maintenance references and the utils README. Plugin/runtime argv/terminal references are N/A: the selected deletions preserve their existing documented contracts; implementation and adjudication are recorded in this task. The additional core deletion updates core/service instructions, operations/smoke ownership and the orchestration source map; no product behavior or persisted schema changes.
