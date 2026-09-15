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
- [Channel Input Assembly Record](/.agents/tasks/channel/channel-input-assembly/README.md) — Preserve the channel-input runtime assembly decision (routing/display split), whose vehicles were later deleted by the #350 cleanup.
- [Feishu Access Foundation Records](/.agents/tasks/channel/feishu-access-foundations/README.md) — Preserve the Feishu access decisions: pairing access V3, allow_chats trust semantics, and inbound attachments.

- [Feishu conversation-of-thought cards](/.agents/tasks/channel/feishu-cot-conversation-cards/README.md) — Render dispatcher and TeamLeader conversations as conversation-anchored Feishu COT cards through a neutral, display-only core projection.
- [Refine Feishu COT and binding cards](/.agents/tasks/channel/refine-feishu-cot-and-binding-cards/README.md) — Bound plain-text COT tool results by line count, restore Team runtime context on binding cards, distinguish route-removal notifications, and complete superseded COT cards successfully
- [Feishu slash commands](/.agents/tasks/channel/add-feishu-slash-commands/README.md) — Handle /stop, /teams, and /dissolve deterministically in the Feishu channel through one extensible command table
- [Align Codex command display parsing](/.agents/tasks/channel/align-codex-command-display/README.md) — Show the inner shell script in Codex tool rows instead of the shell launcher wrapper
- [Display turn usage summaries](/.agents/tasks/channel/display-turn-usage-summary/README.md) — Implement native context and cumulative token usage as the final assistant activity.
- [Refine COT tool details and notification display](/.agents/tasks/channel/refine-cot-tool-details-and-notifications/README.md) — Restore a sixth-level RESULT heading above the divider after native COT visual comparison; preserve #403 output and status behavior.
- [Keep question-card replies in their topic](/.agents/tasks/channel/fix-question-card-topic-routing/README.md) — Send explicit card replies and route settlements from the actual card's conversation.
- [Redact tool call arguments and invocations](/.agents/tasks/channel/redact-tool-call-arguments/README.md) — Run every projected tool.call member through the redactor, removing the argument/invocation exemption so a secret in a command or its arguments cannot reach a chat surface
- [Simplify Feishu replies with native Markdown](/.agents/tasks/channel/simplify-feishu-replies/README.md) — Send native rich-text replies with inline mentions, preserve inbound peer formats and initial topic reply guidance, and expose actionable send errors.
- [Read Feishu inbound messages as text](/.agents/tasks/channel/read-feishu-inbound-as-text/README.md) — Deliver every inbound Feishu message to the model as one text body whose mentions use the outbound reply syntax, with cards reduced to their text and attachments plus a lark-cli pointer, and replies sent as Markdown cards again
- [Filter list_bindings by target and Team](/.agents/tasks/channel/add-list-bindings-filters/README.md) — Answer a precise Feishu binding question with optional exact-match query parameters instead of returning the whole routing table
- [Feishu /bind and /help slash commands](/.agents/tasks/channel/add-bind-and-help-slash-commands/README.md) — Add /bind <team_name> and /help to the Feishu slash-command table, and settle whether the table needs an argument-parsing library
- [Subscribe to Feishu document comments](/.agents/tasks/channel/subscribe-document-comments/README.md) — Let a caller subscribe one Feishu document so the comment events Feishu pushes for it reach that caller's own recipient, and let the channel drop a subscription whose Team can no longer answer
