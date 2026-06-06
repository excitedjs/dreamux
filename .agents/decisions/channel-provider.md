# Channel providers

- **Status:** Accepted
- **Date:** 2026-06-06
- **Affects:** channel lifecycle, Feishu channel integration, channel-owned MCP,
  reply capability, dispatcher config
- **PR / Issue:** [issue #110](https://github.com/excitedjs/dreamux/issues/110)

## Context

The current MVP binds one dispatcher to one Feishu long-connection channel and
one Feishu MCP shim. That shape is accurate for the current runtime, but issue
#110 requires a provider abstraction that can support Feishu now and
subscription-style channels later.

Feishu has provider-specific access and reply semantics. Future channels, such
as issue or repository subscription channels, may not share those semantics.

## Decision

Introduce `ChannelProvider` as the owner of channel execution behavior.

A Channel provider owns:

- channel startup, shutdown, and health;
- provider-local config validation;
- inbound event normalization into dispatcher context envelopes;
- provider-specific access and trust semantics;
- channel-owned MCP descriptors;
- reply, reaction, or other channel capabilities when the provider exposes them.

Dreamux core must not classify channels as one-way or two-way. It consumes
capabilities exposed by the provider. A dispatcher can reply only when the
provider exposes a reply capability and the runtime receives the corresponding
MCP surface.

The target config shape uses `channels[]`. The current `1 dispatcher : 1 Feishu
channel` runtime assumption is no longer a target architecture invariant,
although Phase 1 may still support only one enabled Feishu channel while the
provider boundary lands.

`builtin:feishu` is the Phase 1 Channel provider. It keeps current Feishu-style
behavior while moving Feishu lifecycle, MCP, reply, reaction, and access logic
behind the provider boundary.

## Consequences

- The server stops constructing a hard-coded Feishu MCP surface as the generic
  dispatcher shape.
- Feishu access rules stay Feishu-owned; core channel code must not copy them
  into a generic access model.
- Future channels can expose inbound-only, reply-capable, or custom capability
  sets without changing core classification enums.
- Channel-owned MCP descriptors become the stable interface consumed by Agent
  Runtime providers.

## Alternatives considered

- **Keep Feishu as a server special case:** rejected because it would make the
  registry superficial and preserve the old 1-channel assumption.
- **Add a core one-way/two-way channel enum:** rejected because reply is a
  provider capability, not a universal channel class.
- **Put access policy in core:** rejected because Feishu access semantics do not
  generalize to every future channel.
