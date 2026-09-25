# Add runtime config Commands

## Current state

- Goal: Move every persisted runtime store onto one transactional store kind (file first, then memory), and add a Config Service with Core Commands that let a Channel read and replace the `agents` section of config.json at runtime
- State: `blocked`
- Requirement: [Current requirement](/.agents/tasks/architecture/add-runtime-config-commands/requirement.md)
- Final solution: [Final technical solution](/.agents/tasks/architecture/add-runtime-config-commands/technical-design/final.md)
- Solution review Issue: https://github.com/excitedjs/dreamux/issues/448
- Solution path: three independent proposals with one cross-review round, merged by the TeamLeader into `technical-design/final.md`, then reviewed by Devbox on a GitHub Issue (operator, 2026-09-19: "三份独立方案（推荐）").
- Solution input: `requirement.md` and `rulings.md` as committed with this state change.
- Blockers: Development is authorized, riding the [Code organization refactor](/.agents/tasks/architecture/code-organization-refactor/README.md)'s own approval (operator, 2026-09-24: "并入这次重构"). This solution's §2/§3.1–3.3 (the `TransactionalStore<T>` primitive; the routing document, `access.json`, and `chat-bots.json` moved onto it) shipped as that refactor's Stage 4a. Blocked on Stage 4b next (§3.4's Core stores: Agent identity, Team record, cron jobs, Workflow run/journal), which the refactor's own next-action sequencing gates.
- Authority order: the confirmed final product shape decides. Existing code, prior decisions, and existing documents are evidence of how the system got here; any of them may be overturned to fit the current product scenario, knowingly — by naming what is being changed and why its original rationale no longer holds. User-visible behavior changes are operator decisions. This is a multi-stage architecture refactor; [`rulings.md`](/.agents/tasks/architecture/add-runtime-config-commands/rulings.md) is its rulings ledger.
- Next action: None in this record. On 2026-09-24 the operator folded this solution into the [Code organization refactor](/.agents/tasks/architecture/code-organization-refactor/README.md) ("并入这次重构"); its own next action (Stage 4b, then the remaining stages) governs delivery from here.
- Related tasks: changes a configuration-ownership decision recorded in [Minimize Core Provider Boundaries](/.agents/tasks/architecture/minimize-provider-boundaries/README.md); sibling request [Give the Dispatcher Agent its own Commands](/.agents/tasks/architecture/add-dispatcher-submit-command/README.md); folded into the [Code organization refactor](/.agents/tasks/architecture/code-organization-refactor/README.md) by operator ruling on 2026-09-24 (recorded in its rulings).

## Development approval

- Status: Granted, via the [Code organization refactor](/.agents/tasks/architecture/code-organization-refactor/README.md)'s own approval record, not the card below. That refactor's development approval (operator, 2026-09-24: "你先看一下这个重构，然后往 453上开pr，最后跟随453一起合入next 。没问题的话就开始ultracode ，节点都选sonnet 。然后每个pr让devbox 去 review ，逐个合入。") covers this solution's implementation now that it is folded in. The 2026-09-20 card below is superseded, not retracted — it stays as the historical record of the standalone-delivery boundary this task no longer uses.
- Approved implementation boundary: the code-organization refactor's own — this solution delivered as that refactor's stages (Stage 4a done; Stage 4b next for §3.4's Core stores), inside PR #453's branch, one stage at a time.
- Historical record (superseded): a development-authorization card was sent on 2026-09-20 through the channel's question card, playing back the recorded requirement, the final solution, the three-pull-request implementation scope, and the verification plan. The operator answered "暂不开发" at that time. The same card re-confirmed write validation by the next start's rules and the `workflow_status` change; both are recorded in [`rulings.md`](/.agents/tasks/architecture/add-runtime-config-commands/rulings.md) and remain in force.

## Delivery

- Pull request: None of this record's own. Stage 4a shipped inside [PR #453](https://github.com/excitedjs/dreamux/pull/453)'s branch, per the code-organization refactor's delivery model.
- Knowledge closeout: Pending — tracks the code-organization refactor's own closeout (Stage 4b and the remaining stages still open).
