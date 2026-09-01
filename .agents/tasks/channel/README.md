# Channel Tasks

## Scope

- Channel provider, routing, transport, and conversation-presentation capabilities.

## Code signals

| Area | Current code signal |
| --- | --- |
| Channel provider contract | `packages/dreamux-types/src/channel.ts` |
| Dreamux Channel integration | `packages/dreamux/src/channel` |
| Built-in Feishu Channel | `packages/channel/feishu-channel` |
| Feishu transport | `packages/channel/feishu-transport` |

## Child Scopes

## Tasks
- [Channel Input Assembly Record](/.agents/tasks/channel/channel-input-assembly/README.md) — `done`: Preserve the channel-input runtime assembly decision (routing/display split), whose vehicles were later deleted by the #350 cleanup.
- [Feishu Access Foundation Records](/.agents/tasks/channel/feishu-access-foundations/README.md) — `done`: Preserve the Feishu access decisions: pairing access V3, allow_chats trust semantics, and inbound attachments.

- [Feishu conversation-of-thought cards](/.agents/tasks/channel/feishu-cot-conversation-cards/README.md) — `done`: Render dispatcher and TeamLeader conversations as conversation-anchored Feishu COT cards through a neutral, display-only core projection.
