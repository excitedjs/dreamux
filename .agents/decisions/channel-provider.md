# Channel plugin seam and built-in Feishu channel

- **Status:** Superseded/refined by
  [provider-architecture-realignment](provider-architecture-realignment.md)
- **Date:** 2026-06-06
- **Affects:** channel lifecycle, Feishu channel integration, channel-owned MCP,
  reply capability, dispatcher config
- **PR / Issue:** [issue #110](https://github.com/excitedjs/dreamux/issues/110),
  [issue #135](https://github.com/excitedjs/dreamux/issues/135)

## Context

The current MVP binds one dispatcher to one Feishu long-connection channel and
one Feishu MCP shim. That shape is accurate for the current runtime, but issue
#110 requires a provider abstraction that can support Feishu now and
subscription-style channels later.

Feishu has provider-specific access and reply semantics. Future channels, such
as issue or repository subscription channels, may not share those semantics.

## Decision

Issue #135 refines the decision: `builtin:feishu` is not a provider-registry
channel implementation. It is a built-in bidirectional conversational channel
owned by Dreamux core. Its lifecycle, inbound normalization, access/trust rules,
MCP descriptor, and MCP tool handlers live in the channel module, not in
`server.ts` and not in the provider registry.

The external `channel` seam remains interface-only for future
subscription-style channels. It reserves the TypeScript contract for channels
that can inject MCP descriptors and push subscribed events, but this phase does
not load, resolve, import, or run channel plugins.

The target config shape still uses `dispatchers[].channels[]`; the selected
Feishu channel is recognized directly by config validation as the built-in
`builtin:feishu` channel. The provider registry is reserved for
`agentRuntime` providers in the current implementation.

## Consequences

- The server stops constructing or handling Feishu MCP tools. The Feishu channel
  module owns the tool definitions and handlers end to end.
- Feishu access rules stay Feishu-owned; core channel code must not copy them
  into a generic access model.
- Future subscription channels can expose their own MCP and event model through
  the reserved interface once loading is designed.
- Channel-owned MCP descriptors become the stable interface consumed by Agent
  Runtime providers.

## Alternatives considered

- **Keep Feishu handlers in `server.ts`:** rejected because it preserves the
  old god-object boundary and makes channel MCP a core concern.
- **Add a core one-way/two-way channel enum:** rejected because reply is a
  provider capability, not a universal channel class.
- **Put access policy in core:** rejected because Feishu access semantics do not
  generalize to every future channel.
