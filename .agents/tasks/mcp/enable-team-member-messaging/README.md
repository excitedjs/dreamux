# Enable proactive ordinary-member messaging

## Current state

- Goal: Let ordinary Team-owned and Dispatcher-root members contact their actual owner and same-collection peers across turns, using a concise reusable communication/reporting mechanism.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/mcp/enable-team-member-messaging/requirement.md)
- Solution input revision: Requirement revision 3, consolidated on 2026-10-13 with Q5's managed-Team/request-reply boundary. The prior approved solution and completed consultation used revision 2.
- Final solution: [Selected revision 3 solution](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/final.md), with [architecture adjudication](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/architecture-selection.md).
- Requirement source: [Issue #471](https://github.com/excitedjs/dreamux/issues/471).
- Solution review Issue: [Issue #471](https://github.com/excitedjs/dreamux/issues/471); selected revision 3 solution published and read-back verified on 2026-10-14. Revision 2 publication remains historical evidence below.
- Solution workflow: Three independent proposals, then one cross-review round, confirmed by the operator on 2026-10-13; reuse the DeepSeek, MiMo, and Trae Seed consultation sessions.
- Classification: Complex; the new member MCP surface and runtime-neutral completion contract cross Core and both in-tree runtime packages.
- Blockers: None in the reviewed implementation scope; declared provider-contract and live-coverage limits are recorded in verification.md. The operator's delegated final-quality authority and requested rebase are preserved below.
- Next action: GitHub owns review, CI and merge status; the delivery link below is the continuation surface.
- Related tasks:
  - `builds-on`: [Provider completion token routing and settlement](/.agents/tasks/completion-routing/adopt-completion-token-routing/README.md) — existing submission settlement and native-completion folding.
  - `builds-on`: [Lifecycle-stop completion suppression](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/README.md) — existing owner-stop reporting boundary.

## Task authorization

- On 2026-10-13, the operator selected the task-creation option on the interactive intake card. English translation of the selected answer: "Create task (Recommended)".
- Authorized boundary: Initialize this task and clarify its requirement. This is not development approval.

## Historical development approval and reassessment

- Status: Granted on 2026-10-13 through the revision 2 development-authorization card and its explicit approving response.
- Approved requirement and solution: [Archived requirement revision 2](/.agents/tasks/mcp/enable-team-member-messaging/requirement-revision-2.md) and [archived final revision 2 solution](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/revision-2.md), as published on Issue #471 before the card. The current product snapshot is revision 3; it does not lift the later hold.
- Approved implementation boundary: One ordinary-member MCP capability supplied by actual Team/Dispatcher owner services, the internal Dispatcher inbox-verb alignment, leased ordered native results and both adapters, shared fact mapping and owned delivery convergence, supporting tests/docs/minor change notes. No other product scope is inferred.
- Prior approved implementation boundary is retained as historical authority above. Neutral-interface/architecture reassessment does not authorize changing the delivered implementation.
- On 2026-10-13, the development-authorization card for requirement revision 1 and the published solution was sent. The operator's response raised capability placement and Dispatcher-created members instead of approving development; no implementation was authorized.
- The revision 2 authorization playback is prepared against the published final solution: both owning scopes, shared actual-owner capability, ordered native results, the named terminal-publication stop timing, existing offline-owner limits, and the four Rush gates. Product scope choices and solution review do not substitute for an approving development-card response.
- On 2026-10-13, the TeamLeader sent the explicit revision 2 development-authorization card after publishing and read-back verifying the final solution. It asked whether the operator approved requirement revision 2, the final technical solution, and the displayed scope to enter development. The operator explicitly answered that card on 2026-10-13: "批准进入开发 (Recommended)". English rendering: "Approve entering development (Recommended)". This opens the implementation gate for the boundary above.
- On 2026-10-13, the TeamLeader preserved the task records and fast-forwarded the shared worktree to `next` after #473, #469, and #467. One Codex developer was assigned the approved artifacts and implementation boundary. Its verification report must cover all four Rush gates and distinguish live acceptance from fake/runtime-unit evidence. Task and KB writes remain TeamLeader-owned.
- On 2026-10-13, the developer returned implementation changes and reported all four Rush gates passing, with authenticated model acceptance explicitly unrun. During TeamLeader pre-review, the operator said: "你先稍等，你确定这个是架构最优的方案吗？" English rendering: "Wait a moment first. Are you certain this is the architecturally optimal solution?" The TeamLeader stopped workflow advancement. Prior development approval remains recorded, but does not authorize proceeding through this explicit hold or a materially changed solution.
- On 2026-10-13, the operator authorized further discussion and emphasized caution for any neutral agent-runtime interface change. The exact instruction and the read-only consultation boundary are recorded in the reassessment input. Product requirement revision 2 remains the shared baseline; the existing implementation and prior interface choice are comparison evidence.
- On 2026-10-13, all three neutral-interface independent reassessments and their single cross-review appendices were received. The TeamLeader recorded source adjudication separately from the prior final: new native capability versus transport shape, both version-skew directions, constructor/consumer compatibility, and the distinct single-Core-report-owner alternative. No vote substitutes for the outstanding interface-evolution policy or lifts the operator hold.
- On 2026-10-13, the operator challenged treating Dispatcher-to-TeamLeader as the same reporting relationship as ordinary members, because many Teams must not push their internal activity into the Dispatcher. The TeamLeader traced the separate construction paths and recorded the existing per-request TeamLeader reply behavior for explicit clarification. This input does not remove Q4 ordinary-root-member coverage, authorize code changes, or lift the hold.
- On 2026-10-13, the operator answered that clarification card: "保留请求答复是正确的，要不我们把现在敲定的产品行为重新梳理一遍吧。" English rendering: "Keeping request replies is correct. Let's reorganize the product behaviors we have agreed so far." The TeamLeader archived requirement revision 2 and consolidated revision 3, recording Q5 without changing Q1/Q1a/Q2/Q3/Q4 or lifting the hold. No implementation artifacts were changed.
- On 2026-10-13, the operator accepted the settled product behavior and requested the code mechanism be designed as if written completely from scratch. The exact instruction is recorded in the greenfield input. This authorizes an ideal-first solution comparison using the already selected three-seat path, not implementation or a lift of the hold. Existing classes, prior interface choices and proposal votes are comparison evidence, not design constraints.
- On 2026-10-13, all three independent greenfield proposals were received. The TeamLeader's source pass identified completion-shaped bound Codex interruptions, explicit-request folding, request identity consumers and the Dispatcher input fence as concrete tests of proposed removals. The same three seats were assigned one cross-review against those facts; no source/test changes or architecture choice were approved from the initial proposals.
- On 2026-10-13, all three greenfield cross-reviews were received. The TeamLeader rejected the native-only payload partition that loses bound Codex partial results, distinguished reporting ownership from transport, and reconciled the single-event ideal with explicit pre-invocation Core-issued request ids. The ideal/adoption comparison names actual deletions, public contract growth, compatibility and requested-reply stop timing; it neither claims executed verification nor lifts the hold.

## Resumed delivery authority (2026-10-14)

The operator stated:

> 这样吧，我不管了，你们整个团队为最终交付质量负责，包括架构质量、代码质量、工程质量等。

English rendering: "I leave this with you; the whole team is responsible for final
delivery quality, including architecture, code and engineering quality."

The operator then explicitly instructed:

> 你最好先 rebase 一下最新next，然后再动手

English rendering: "Rebase onto the latest next first, then proceed."

Together with the preceding delegated architecture choice, these instructions
resume the approved task and put internal architecture selection, implementation,
verification and review corrections with the team. This is direct operator
authorization, not consultant agreement or an unanswered card. The TeamLeader
applies the user instruction over routine repeated stage/technical-choice card
requests within the settled product scope. Product scope remains requirement
revision 3. No Team dissolution or production release is authorized.

The TeamLeader selected the result-value/one-report-owner design after the three
independent comparisons and one cross-review, recording both real alternative
deletions and source counterexamples. The same developer completes its current
working change against final.md; no concurrent source writer is authorized.

The requested rebase advanced the [#473](https://github.com/excitedjs/dreamux/pull/473) baseline through
[#474](https://github.com/excitedjs/dreamux/pull/474). Its only upstream change was workflow guidance; tracked patch, untracked files and Git index
were restored byte-for-byte before implementation resumed.

## Solution consultation authorization

- On 2026-10-14, the operator stated: "我不确定之前重构的是否是架构最优啊。我感觉你们可以选一个最优方案". English rendering: "I am not certain the previous refactoring is architecturally optimal. I think you can choose the best design." The TeamLeader opened an independent complete-design comparison under requirement revision 3 and will select the architecture without outsourcing that technical decision. This does not explicitly resume implementation or supersede the product behavior.

- On 2026-10-14, after the operator requested direct Codex/DSH source research and asked which design to use, the TeamLeader recorded a source-informed recommendation retaining request Promises and completion identity while converging notification ownership in AgentService. The same three seats performed bounded read-only validation; live-consumer and compatibility qualifications were incorporated. Optional public result observation is a TeamLeader recommendation, not a confirmed operator ruling. The delivered implementation and hold remain unchanged.

- On 2026-10-13, the operator selected the solution-workflow card. Selected answer (verbatim quoted evidence): "三位独立方案再交叉评议 (Recommended)". English rendering: "Three independent proposals, then cross-review (Recommended)".
- The operator also explicitly allowed reuse of the preceding consultation members. English rendering: "You can reuse the TeamMates from the preceding discussion."
- Authorized boundary: Each seat writes only its assigned proposal file under `technical-design/proposals/`; the TeamLeader maintains the authoritative requirement and final solution. This authorizes consultation, not implementation.
- Proposal files: [DeepSeek](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/proposals/deepseek.md), [MiMo](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/proposals/mimo.md), and [Trae Seed](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/proposals/trae-seed.md).
- On 2026-10-13, all three independent proposals and their single cross-review appendices were received. The TeamLeader's source-based adjudication is recorded in the final solution, including the mixed bound/unbound result-ordering concern.
- On 2026-10-13, the operator acknowledged the agent-module MCP placement and owner-scoped routing division. This revised ownership input requires reconciliation through the existing three-seat consultation path; it does not grant development authorization.
- On 2026-10-13, the operator explicitly selected both member categories and required a concise abstract reusable mechanism without excessive branching. The exact answer and its bounded interpretation are recorded as Q4 in requirement revision 2. The original Team-only solution and review sections are superseded for renewed consultation, not implementation authority.
- On 2026-10-13, the same three seats completed independent revision 2 proposals and one cross-review appendix each. The TeamLeader reconciled them against owning source in the final solution: direct structural views of actual owners, synchronous native-result publication, no synthetic Codex connection-failure terminals, explicit locked construction, and convergence of started native delivery. The archived revision 1 solution remains historical evidence.

## Delivery

- Pull request: [#475](https://github.com/excitedjs/dreamux/pull/475), targeting next; GitHub owns its review, CI and merge status.
- Verification: [Current evidence](/.agents/tasks/mcp/enable-team-member-messaging/verification.md).
- Independent review: [Source adjudication](/.agents/tasks/mcp/enable-team-member-messaging/review.md).
- Knowledge closeout: Complete; product, provider-runtime, dispatcher-orchestration, service-topology, current-architecture and glossary owners were reconciled with the final reviewed implementation, including F1's barrier removal. Existing root routing already discovers the owning task/domain; no routing change was needed.
- State/config maintenance: N/A; no persisted shape, config/default or path change is selected.

## Design evidence

The selected solution is final.md. Earlier consultations remain comparison
history; their prior authority/hold descriptions are dated evidence.

- [Complete-comparison input](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/optimality-input.md) and [single cross-review input](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/optimality-cross-review.md).
- [Earlier source-informed recommendation](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/source-informed-design.md).
- [Greenfield reconciliation](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/greenfield-conclusion.md).
- [Neutral-interface reassessment conclusion](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/interface-reassessment-conclusion.md).
- [Managed-Team reporting boundaries](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/reporting-boundaries.md).
