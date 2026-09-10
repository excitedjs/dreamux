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
- [Refine Feishu COT and binding cards](/.agents/tasks/channel/refine-feishu-cot-and-binding-cards/README.md) — `review`: Bound plain-text COT tool results by line count, restore Team runtime context on binding cards, distinguish route-removal notifications, and complete superseded COT cards successfully
- [Feishu slash commands](/.agents/tasks/channel/add-feishu-slash-commands/README.md) — `done`: Handle /stop, /teams, and /dissolve deterministically in the Feishu channel through one extensible command table
- [Align Codex command display parsing](/.agents/tasks/channel/align-codex-command-display/README.md) — `done`: Show the inner shell script in Codex tool rows instead of the shell launcher wrapper
- [Display turn usage summaries](/.agents/tasks/channel/display-turn-usage-summary/README.md) — `done`: Implement native context and cumulative token usage as the final assistant activity; draft-only delivery pending live Codex verification.
- [Refine COT tool details and notification display](/.agents/tasks/channel/refine-cot-tool-details-and-notifications/README.md) — `review`: Restore a sixth-level RESULT heading above the divider after native COT visual comparison; preserve #403 output and status behavior.
- [Keep question-card replies in their topic](/.agents/tasks/channel/fix-question-card-topic-routing/README.md) — `review`: Send explicit card replies and route settlements from the actual card's conversation.
