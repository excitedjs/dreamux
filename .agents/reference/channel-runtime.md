# Reference: channel runtime

This is the current Channel/Feishu runtime map. It is a reference page, not a
decision record. For detailed Feishu behavior, follow the domain documents and
then verify the current source.

## Channel Provider Seam

Dreamux core owns the neutral Channel provider contract. A Channel provider
creates sessions, resolves provider-owned targets, exposes provider tools, and
maps inbound channel events into neutral runtime input.

The built-in Feishu provider lives outside the host package:

- package: `@excitedjs/feishu-channel`
- provider ref: `builtin:feishu`
- source: `/packages/channel/feishu-channel/`

Dreamux core loads it through the same registry/catalog shape as external
Channel providers. The Feishu package depends on
`@excitedjs/dreamux-types` and `@excitedjs/feishu-transport`; it does not import
the Dreamux host package.

Key source:

- `/packages/dreamux/src/channel/catalog.ts`
- `/packages/dreamux/src/channel/external-channel-provider.ts`
- `/packages/dreamux/src/registry/`
- `/packages/channel/feishu-channel/src/provider.ts`

## Channel Sessions

Each live dispatcher owns a map of Channel sessions keyed by dispatcher-local
`channel_id`. The first configured channel is the primary/default egress
channel.

For Feishu, the session owns:

- long-connection event handling through `FeishuBot`;
- access and mention gating;
- `/introduce` trust changes;
- known/trusted peer-bot state;
- inbound message formatting and attachment normalization;
- channel-owned reaction state;
- Feishu MCP tool backing.

Key source:

- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/channel/feishu-channel/src/feishu-channel.ts`
- `/packages/channel/feishu-channel/src/bot.ts`
- `/packages/channel/feishu-transport/`

## Provider Tools And MCP

The Feishu package owns its tool names and JSON schemas:

- `reply`
- `react`
- `list_chat_bots`

Dreamux core injects a generic `channel-mcp` stdio shim. The shim is a conduit:
it serves provider-supplied `tools/list` metadata and forwards `tools/call` to
neutral admin methods, which route the call back to the live Channel session or
sessionless provider handler.

Key source:

- `/packages/channel/feishu-channel/src/feishu-mcp-tools.ts`
- `/packages/channel/feishu-channel/src/provider.ts`
- `/packages/dreamux/src/mcp/channel-mcp.ts`
- `/packages/dreamux/src/admin/methods.ts`

## Channel Targets And Binding

Channel providers normalize routing endpoints into `ChannelTarget` objects.
For Feishu group chat routing, the target carries provider-owned metadata such
as `chat_id` and `chat_type`.

Team channel binding is core-owned Team MCP state:

- `bind_channel({ team_name, channel_id?, meta })`
- `transfer_back({ channel_id?, meta })`

The `meta` object is provider-owned target selector input. For Feishu, that is
typically `{ "chat_id": "..." }`.

Key source:

- `/packages/dreamux/src/service/channel-binding/`
- `/packages/dreamux/src/mcp/team-mcp.ts`
- `/packages/channel/feishu-channel/src/provider.ts`

## Feishu Domain Contracts

Current cross-cutting Feishu contracts live in domain docs:

- [Feishu introduce](../domains/feishu-introduce.md)
- [Non-blocking dispatcher inbound](../domains/non-blocking-dispatcher-inbound.md)

Use those pages for `/introduce`, trusted bot context, reaction timing, and
Codex `turn/start` folding details.

## Decision Trail

- [NPM package split and channel targets](../decisions/npm-package-split-and-channel-targets.md)
- [Provider architecture realignment](../decisions/provider-architecture-realignment.md)
- [Channel provider](../decisions/channel-provider.md)
- [Channel input runtime assembly](../decisions/channel-input-runtime-assembly.md)
- [Feishu inbound attachments](../decisions/feishu-inbound-attachments.md)
- Archived background:
  [plugin/provider architecture proposal](../archive/proposals/plugin-provider-architecture.md)
