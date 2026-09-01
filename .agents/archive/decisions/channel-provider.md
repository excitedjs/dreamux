# Channel plugin seam and built-in Feishu channel

> **Archived 2026-09-01** (decisions tree dissolved into task records). Historical channel-provider boundary; superseded by the package split (now backfilled at [/.agents/tasks/architecture/npm-package-split/requirement.md](/.agents/tasks/architecture/npm-package-split/requirement.md)) and by #350's Channel seam.

- **Status:** Historical; superseded by
  [npm-package-split-and-channel-targets](/.agents/tasks/architecture/npm-package-split/requirement.md#npm-package-split-and-channel-targets)
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

This record is preserved as historical issue #110/#135 context. The current
accepted design is issue #209:

- `builtin:feishu` is a Channel provider package
  (`@excitedjs/feishu-channel`) loaded through the same provider loader/catalog
  shape as external `npm:` channel providers.
- Dreamux core owns Team routing, authorization, and binding state. Binding a
  channel target to a Team is a Team MCP capability (`bind_channel` /
  `transfer_back`), not a generic Channel MCP capability.
- Channel providers own platform I/O, inbound normalization, target resolution,
  message ownership facts, and provider-specific tools (`reply`, `react`,
  `list_chat_bots` for Feishu). Their MCP descriptors expose those tools through
  the generic `channel-mcp` shim, which forwards tool calls to the live session.
- Subscription channels are a separate reserved contract. They publish one-way
  events and do not reuse chat ids, channel targets, Team binding, or reply/react
  ownership.

## Consequences

- The server never constructs provider-specific tool implementations. The
  selected Channel provider/session owns the tool definitions and handlers; core
  forwards calls and enforces TeamLeader egress authorization.
- Feishu access rules stay Feishu-owned; core channel code must not copy them
  into a generic access model.
- Future subscription channels can expose their own MCP and event model through
  the reserved interface once loading is designed.
- Channel-owned MCP descriptors become the stable provider-tool interface
  consumed by Agent Runtime providers. Team binding stays on the Team MCP.

## Alternatives considered

- **Keep Feishu handlers in `server.ts`:** rejected because it preserves the
  old god-object boundary and makes provider-specific tools a core concern.
- **Add a core one-way/two-way channel enum:** rejected because reply is a
  provider capability, not a universal channel class.
- **Put access policy in core:** rejected because Feishu access semantics do not
  generalize to every future channel.
