# Channel Routing And Binding

This page is the stable contract for Channel providers, provider tools, Channel
routing, and how a Channel reaches Core.

Read this before changing Channel provider contracts, the Channel MCP delegate,
Channel-owned routing or Collaboration Space state, inbound recipient selection,
or the Core event source a Channel subscribes to.

## Provider Ownership

A Channel provider owns platform I/O, inbound normalization, target resolution,
provider-specific tools, message ownership facts, and **routing**: which
conversation reaches which Team, and what a Collaboration Space is. Dreamux core
owns Channel session lifetime, the Command port a Channel invokes, the scoped
Core event source it subscribes to, and generic MCP forwarding. Core holds no
binding table, no target model, and no Collaboration Space container.

The built-in Feishu provider is `builtin:feishu`, implemented by
`@excitedjs/feishu-channel`. The Feishu channel package depends on
`@excitedjs/dreamux-types` and `@excitedjs/feishu-transport`; it must not import
`@excitedjs/dreamux`. The transport package is the sole owner of the Lark SDK
and raw Feishu platform I/O.

Source:

- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/channel/catalog.ts`
- `/packages/dreamux/src/channel/external-channel-provider.ts`
- `/packages/channel/feishu-channel/src/provider.ts`
- `/packages/channel/feishu-transport/src/transport/feishu.ts`
- `/packages/dreamux/tests/package-boundary-guards.test.ts`

## Channel Sessions And Provider Tools

Each live dispatcher builds one `ChannelInstance` per configured channel and
holds it by dispatcher-local `channel_id`. The first configured channel is the
primary/default egress channel. `ChannelService` builds, holds, hands out, and
closes those instances and nothing else.

`ChannelSession` is the direct, same-process lifecycle: `initialize(port)` loads
and validates Channel-owned state and attaches event consumers but must not open
external input, `start()` opens external I/O, and `close()` stops it and awaits
the Channel-owned mutation tail. That split is what makes
subscribe-before-admission provable.

A Channel's MCP surface reaches runtimes through the same generic delegate every
internal domain implements: Core asks the provider's `ChannelMcpCapability` to
`describe` a catalog **per caller**, freezes it for one runtime generation, and
admits only names in it. Core neither authors nor interprets a tool, and asks
only when constructing a Dispatcher or TeamLeader runtime.

For Feishu, the current tool surface is:

- messaging: `reply`, `react`, `list_chat_bots`
- routing: `bind_channel`, `unbind_channel`, `list_bindings`
- Collaboration Space: `bind_collaboration_space`,
  `unbind_collaboration_space`, `get_collaboration_space`,
  `list_collaboration_spaces`

Those names and schemas are Feishu package-owned. Core must not implement
Feishu-specific tool handlers. There is no sessionless Feishu tool: Core takes a
channel's MCP capability from the built instance, which exists from creation
rather than from connection.

The neutral provider descriptor carries standard title, description, input
schema, optional output schema, annotations, and optional icon metadata without
depending on the MCP SDK. Core validates catalogs as JSON-safe, uniquely named,
SDK-compilable tool definitions, and a tool whose handler does not exist is
never advertised rather than advertised and then failed at invocation.

Source:

- `/packages/dreamux/src/service/channel-service/index.ts`
- `/packages/dreamux/src/service/channel-service/mcp-delegate.ts`
- `/packages/dreamux/src/service/channel-service/mcp-delegates.ts`
- `/packages/dreamux/src/mcp/server.ts`
- `/packages/dreamux-types/src/channel.ts`
- `/packages/channel/feishu-channel/src/tools/registry.ts`
- `/packages/channel/feishu-channel/src/provider.ts`

## Delivery And Ownership

Channel providers own platform-specific delivery, reactions, message ownership
facts, and provider tool schemas. Core exposes those tools to runtimes through a
neutral MCP forwarding layer and scopes them by caller.

Assistant text alone is never a channel delivery contract. If a runtime should
respond visibly in the source channel, it must call a provider-owned channel
tool. Tool failures are returned as MCP errors and logged; there is no durable
outbound retry queue in core.

Inbound de-duplication and Channel presentation state are process-local provider
facts unless the provider domain page says otherwise. Feishu automatic progress
uses session-local COT cards; explicit reactions remain model-facing tool calls.
Core state must not grow a persisted COT presentation, reaction ledger, or
inbound message queue.

Source:

- `/packages/dreamux/src/service/channel-service/index.ts`
- `/packages/channel/feishu-channel/src/provider.ts`
- `/packages/channel/feishu-channel/src/tools/messaging-tools.ts`

## Targets

A target is a Channel concept and does not cross the seam. The neutral contract
publishes no `ChannelTarget`: core never sees a chat id, a thread id, a target
key, or a bindable flag, and therefore cannot route on one.

Feishu normalizes its own selectors into a package-local `FeishuTarget` — an
ordinary chat, or one topic inside a topic group — and derives a stable
`targetKey` from it. Topic detection needs one platform lookup, so it is cached
per chat, bounded, and fails open: a chat whose mode cannot be established is
treated as an ordinary group rather than an invented topic. Session-local
observation ledgers are display and addressing aids, never authority.

Source:

- `/packages/dreamux-types/src/channel.ts`
- `/packages/channel/feishu-channel/src/routing/target.ts`
- `/packages/channel/feishu-channel/src/feishu-target-router.ts`

## Team Binding

Binding a conversation to a Team is the Channel's own decision, made with that
Channel's own tools. Team MCP has no `bind_channel` and no `transfer_back`:
only Feishu knows what a chat, a topic, and a parent group are, so only Feishu
can say which of them a Team answers in. Rebinding is `bind_channel` with a
different `team_name`, and the previous owner is reported back.

Authorization is the caller-scoped catalog itself, not a check inside a shared
handler. `bind_channel` and `unbind_channel` are registered twice, once per
caller kind, with disjoint schemas:

- the Dispatcher's take a `team_name` and may move any route;
- the TeamLeader's have no team field at all — its Team is the one Core baked
  into the lease — and reach only routes that are free or already its own.

A TeamLeader therefore cannot address another Team, correctly or otherwise,
because the argument that would say so does not exist. `list_bindings` and every
Collaboration Space tool stay Dispatcher-only: the channel-wide routing table
and Space policy are operator work.

Source:

- `/packages/channel/feishu-channel/src/tools/routing-tools.ts`
- `/packages/channel/feishu-channel/src/tools/space-tools.ts`
- `/packages/channel/feishu-channel/src/tools/registry.ts`
- `/packages/dreamux/src/service/team-collection/mcp-delegate.ts`

## Routing State

Routing state is Channel-owned durable state. Core supplies a per-dispatcher
state root and nothing else — the filename, the schema, and what counts as a
valid document belong to the Channel.

The Feishu document lives at
`~/.dreamux/state/<dispatcher-id>/feishu-routing.<channel-slug>.<digest>.json`,
one file per configured channel id. It holds two sections in one consistency
domain: `bindings[]`, the target routes actually installed, each carrying its
Team name and whether it came from an explicit bind or from Space provisioning;
and `spaces[]`, the registered Collaboration Space policies with their creation
facts and a policy `generation`. A space policy is what entitles a binding to be
installed, and a Team closing removes the bindings that named it, so splitting
the two would only invent a cross-file transaction.

Work in flight is deliberately absent. Automatic provisioning is process-local:
losing the process loses the unfinished operation, no resume scan runs, and a
target no binding claims is simply an unmatched target afterwards. Disk commit
is the authority — every change is queued, prepared on an isolated copy, written
atomically, and only then published, so what a caller reads is what was
persisted.

There is no migration path. An incompatible document fails loud and the operator
recreates the rows through `bind_channel` / `bind_collaboration_space`.

Core's own removed routing state is detected, not read: `channel-bindings.json`
and `collaboration-spaces.json` at the dispatcher root fail loud as old state.

Source:

- `/packages/channel/feishu-channel/src/routing/store.ts`
- `/packages/channel/feishu-channel/src/routing/document.ts`
- `/packages/dreamux/src/service/legacy-state.ts`

## Inbound Routing

Core makes no routing decision. The Channel resolves its own target, consults
its own bindings, and states the recipient in the Command:

- a resolved `team_name` reaches that Team's TeamLeader;
- omitting it reaches the Dispatcher Agent, which is the recipient for a
  conversation no binding or Collaboration Space claims.

Omission *is* the Channel's decision. Both forms are the one generic
`team.submit` Command, carrying opaque display attributes, faithful body text, an
optional standing reminder, and a stable `source_id` that Core deduplicates a
repeat on; Core renders the provenance envelope itself. Nothing about chats,
threads, or topic mode crosses. The returned `turn_id` names the exact turn the
call created, which is what lets a Channel claim the matching submitted event as
its own.

Source:

- `/packages/dreamux/src/service/team-collection/commands.ts`
- `/packages/dreamux/src/service/channel-submission.ts`
- `/packages/dreamux/src/service/submission-sources.ts`
- `/packages/channel/feishu-channel/src/feishu-submit.ts`
- `/packages/channel/feishu-channel/src/feishu-channel.ts`

## Core Fact Subscriptions

Each dispatcher has an in-process typed event bus fed by the existing Team,
agent-identity, and turn owners. A Channel session receives one read-only,
dispatcher-scoped source and demultiplexes the whole `ChannelCoreEvent` union
inside the Channel, so adding an event changes only that catalog and its
consumers. Workflow, scheduler, routing, and host-maintenance events are
deliberately absent — routing is the Channel's own fact, so Core has none to
publish back.

The union covers Team state, Team agent state, and Team-owned turn
submitted/settled/message/tool-call facts. Delivery is live and best-effort:
Core invokes listeners in publication order without awaiting them, and a
listener's exception or rejection never escapes into admission or settlement.
There is no FIFO, backpressure, timeout, acknowledgement, retry, replay,
snapshot, or final-delivery guarantee.

A listener must keep its synchronous projection bounded. A Channel reaction that
needs asynchronous persistence synchronously updates or fences its in-memory
authority and serializes the durable write on a Channel-owned mutation tail that
`ChannelSession.close` awaits. The source is installed before session start and
revoked before session close on stop or failed start. The bus does not become a
new state owner, and providers never receive core service/store instances or raw
`EventEmitter` management methods.

Source:

- `/packages/dreamux/src/service/dispatcher-core-events/`
- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/service/agent-entity/identity-store.ts`
- `/packages/dreamux/src/service/team-collection/store.ts`
- `/packages/dreamux/src/service/channel-service/index.ts`

## TeamLeader Tool Authorization

Core runs no egress gate. It no longer resolves a target out of a provider's own
tool arguments and holds no proof that a message belongs to one — those were
Core re-deriving Channel facts from Channel data.

What Core owns is the lease scope. Every Channel MCP call carries a
`ChannelMcpCallContext` of `dispatcher_id`, `channel_id`, and the caller
(`dispatcher`, or `team_leader` with its `team_name` and `leader_name`), baked in
when the runtime's catalog was frozen. Routing identity is never part of the
model-facing tool schema, so a runtime cannot name a scope it was not given. The
Channel is told who is calling and owns its own access rules.

Source:

- `/packages/dreamux/src/service/channel-service/mcp-delegate.ts`
- `/packages/dreamux/src/service/channel-service/mcp-delegates.ts`
- `/packages/dreamux-types/src/channel.ts`
- `/packages/channel/feishu-channel/src/tools/registry.ts`

## Feishu-Specific Contracts

Detailed Feishu behavior lives in focused domain pages:

- [Feishu introduce](feishu-introduce.md)
- [Feishu pairing access](feishu-pairing-access.md)
- [Non-blocking dispatcher inbound](non-blocking-dispatcher-inbound.md)

The Feishu session classifies raw chat/sender identity before routing or trust
side effects. Current V3 `allow_chats` semantics trust exact human members of a
listed group under either non-block policy after the global mention gate;
`/introduce` remains a distinct sender-scoped mutation path.

## Decision Trail

- [Channel-scoped collaboration and core events](../decisions/channel-scoped-collaboration-and-core-events.md)
- [Feishu binding notification events](../decisions/feishu-binding-notification-events.md)
- [NPM package split and channel targets](../decisions/npm-package-split-and-channel-targets.md)
- [Channel provider](../decisions/channel-provider.md)
- [Channel input runtime assembly](../decisions/channel-input-runtime-assembly.md)
- [Feishu inbound attachments](../decisions/feishu-inbound-attachments.md)
- [Feishu pairing access v3](../decisions/feishu-pairing-access-v3.md)
- [Feishu trusted allow-chats semantics](../decisions/feishu-allow-chats-trust-semantics.md)
