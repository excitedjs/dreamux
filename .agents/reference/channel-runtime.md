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

Channel providers normalize routing endpoints into `ChannelTarget` objects. The
target carries provider-owned metadata; Dreamux core treats that metadata as an
opaque selector and routes by the normalized target key.

Team channel binding is Dreamux core state exposed through role-gated Team MCP
projections:

- dispatcher projection:
  `send({ team_name, prompt, intent? })` to submit a turn to the TeamLeader,
  `bind_channel({ team_name, channel_id?, meta })` and
  `transfer_back({ channel_id?, meta })`
- TeamLeader projection: only scoped
  `transfer_back({ channel_id?, meta })`

The `meta` object is provider-owned target selector input. Team peer send
remains future work and is not part of channel binding.

Dreamux core owns channel sessions and durable binding rows through the
dispatcher-local `ChannelService`. Channel providers remain Team-agnostic: they
normalize targets, expose provider tools, and report message ownership facts.

Key source:

- `/packages/dreamux/src/service/channel-service/`
- `/packages/dreamux/src/service/channel-binding/`
- `/packages/dreamux/src/mcp/team-mcp.ts`
- `/packages/channel/feishu-channel/src/provider.ts`

## Collaboration Spaces

Dreamux core also exposes a dispatcher-only `collaboration_space` MCP namespace
for externally created provider containers that should be bound to a repository.
This is not a provider Channel MCP surface. For Feishu, creating or finding the
topic group remains a dispatcher-agent action through `lark-cli`; the core tool
only records and releases Dreamux's repository/provisioning binding.

The current core surface is:

- `bind`: register an existing external container when needed and bind it to a
  repository, managed-worktree policy, TeamLeader runtime, and optional default
  TeamLeader identity;
- `dissolve`: release the current collaboration-space routing/provisioning
  binding. It does not delete the external container and does not dissolve
  already provisioned Teams;
- `status` / `list`: read compact public state. There is no first-version
  `history` or recovery tool.

The Channel contract has optional provider-neutral collaboration-space fields:
providers may attach `ChannelInboundEnvelope.container` on inbound deliveries
and may call `ChannelRoutes.targetLifecycle` with `target_created` /
`target_closed` events. `ChannelRoutes.deliver(input, envelope)` returns the
neutral `InboundDeliveryResult`; the channel provider owns any platform ACK or
reaction lifecycle around this call. Core never directly acknowledges the
platform.

Core uses only `(channel_id, container_key, target_key)` plus the current
binding generation; it must not parse Feishu `chat_id`, `thread_id`, chat mode,
or provider-specific `target.meta` to infer collaboration-space membership.

Provisioning has two entry points:

- **Target lifecycle events.** When the provider calls
  `ChannelRoutes.targetLifecycle` with `target_created` for a container with a
  bound collaboration-space record, `CollaborationSpaceService` writes the
  durable claim and returns; heavy worktree/Team provisioning runs
  asynchronously. For `target_closed`, the service accepts the close event and
  asynchronously dissolves the Team and releases the binding.
- **First-inbound provisioning.** When a bindable target has no existing binding
  and `envelope.container` is set on `deliver()`, `routeChannelInput` calls
  `acceptAndProvisionTarget` synchronously before routing. If provisioning
  succeeds and the Team is active, the inbound is delivered to the TeamLeader;
  if it fails, a failed `InboundDeliveryResult` is returned. This path never
  falls back to the dispatcher agent for bound collaboration spaces.

Both paths bypass the dispatcher agent runtime but still go through
`DispatcherService` and core stores. When the space is dissolved, future
deliveries fall back to the normal dispatcher path unless the space is rebound.

Key source:

- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/service/collaboration-space/`
- `/packages/dreamux/src/mcp/collaboration-space-mcp.ts`
- `/packages/dreamux/src/service/dispatcher-service/index.ts`

## Feishu Domain Contracts

Current cross-cutting Feishu contracts live in domain docs:

- [Feishu introduce](../domains/feishu-introduce.md)
- [Feishu pairing access](../domains/feishu-pairing-access.md)
- [Non-blocking dispatcher inbound](../domains/non-blocking-dispatcher-inbound.md)

Use those pages for `/introduce`, trusted bot context, reaction timing,
pairing-token gate rules, Owner-only approval card semantics, and
Codex `turn/start` folding details.

## Decision Trail

- [NPM package split and channel targets](../decisions/npm-package-split-and-channel-targets.md)
- [Provider architecture realignment](../decisions/provider-architecture-realignment.md)
- [Channel provider](../decisions/channel-provider.md)
- [Channel input runtime assembly](../decisions/channel-input-runtime-assembly.md)
- [Feishu inbound attachments](../decisions/feishu-inbound-attachments.md)
- [Feishu pairing access v3](../decisions/feishu-pairing-access-v3.md)
- Archived background:
  [plugin/provider architecture proposal](../archive/proposals/plugin-provider-architecture.md)
