# Archived Proposals

These proposals are preserved for historical context. They are not current
implementation guidance; use the linked decisions and reference docs first.

| Proposal | Current pointer |
|---|---|
| [Concrete entity name suffix length](concrete-name-suffix-length.md) | [Current architecture](../../reference/current-architecture.md), [Dispatcher orchestration](../../domains/dispatcher-orchestration.md), [Service topology](../../reference/service-topology.md) |
| [Dynamic Workflow 编排](dynamic-workflow.md) | Implemented in PR #312 (`feat(workflow): Dynamic Workflow MVP`); see bundled skill `workflow` and `service/workflow-service/` |
| [Dreamux maintenance progressive disclosure and self-upgrade SOP](dreamux-maintenance-progressive-disclosure.md) | [Dispatcher skill](../../reference/dispatcher-skill.md), [Model-facing writing](../../reference/model-facing-writing.md), [Repository operations and release](../../domains/repository-operations-and-release.md) |
| [Feishu allow-chats trust semantics](feishu-allow-chats-trust-semantics.md) | [Accepted decision](../../decisions/feishu-allow-chats-trust-semantics.md), [Feishu pairing access](../../domains/feishu-pairing-access.md) |
| [Feishu sender-name reliability and minimal attachment markup](feishu-sender-name-and-minimal-attachments.md) | [Channel runtime](../../reference/channel-runtime.md), [Feishu inbound attachments](../../decisions/feishu-inbound-attachments.md) |
| [Feishu inbound structured body](feishu-inbound-structured-body.md) | [Channel runtime](../../reference/channel-runtime.md), [Feishu inbound attachments](../../decisions/feishu-inbound-attachments.md) |
| [Feishu lazy message identity hints](feishu-lazy-message-lookup.md) | [Channel runtime](../../reference/channel-runtime.md), [Feishu inbound message fidelity](feishu-inbound-message-fidelity.md) |
| [Feishu inbound message fidelity](feishu-inbound-message-fidelity.md) | [Channel runtime](../../reference/channel-runtime.md), [Feishu inbound attachments](../../decisions/feishu-inbound-attachments.md) |
| [Feishu topic-close lifecycle](feishu-topic-close.md) | [Channel runtime](../../reference/channel-runtime.md), [Channel routing and binding](../../domains/channel-routing-and-binding.md) |
| [Feishu trusted-bot context](feishu-bot-trust-context.md) | [Feishu introduce](../../domains/feishu-introduce.md), [non-blocking dispatcher inbound](../../domains/non-blocking-dispatcher-inbound.md), [Channel routing and binding](../../domains/channel-routing-and-binding.md) |
| [Global `dreamux` bin, `onboard`, and `serve`](global-bin-onboard-serve.md) | [global bin/onboard/serve decision](../../decisions/global-bin-onboard-serve.md), [dispatcher tm packaging](../../decisions/dispatcher-tm-packaging.md) |
| [Plugin and provider architecture](plugin-provider-architecture.md) | [current architecture](../../reference/current-architecture.md), [Provider runtime](../../domains/provider-runtime.md), [provider architecture realignment](../../decisions/provider-architecture-realignment.md), [NPM package split and channel targets](../../decisions/npm-package-split-and-channel-targets.md) |
| [Post-MVP hardening](post-mvp-hardening.md) | Historical pre-#209 hardening backlog; write a current proposal before implementation |
| [Subscribe channel event feeds](subscribe-channel-event-feeds.md) | Archived event-feed exploration; no current code or public contract |
