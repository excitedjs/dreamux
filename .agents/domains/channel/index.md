# Channel

What: the provider-neutral Channel mechanism through which external
communication surfaces reach Dreamux core. This page owns the seam: provider
loading, session lifetime, Core Command invocation, provider-owned MCP tools,
recipient selection, and the Core event source.

Read this before changing Channel provider contracts, `ChannelService`, the
Channel MCP delegate, inbound recipient selection, or the event source a Channel
subscribes to. For the concrete target, routing, content, and presentation
behavior of `builtin:feishu`, read the
[built-in Feishu Channel](feishu-channel.md).

## Ownership

A Channel provider owns its external platform boundary end to end: platform I/O,
inbound normalization, target resolution, provider-specific tools, message
ownership facts, routing, and presentation. Dreamux core owns Channel instance
and session lifetime, the Command port a Channel invokes, the scoped Core event
source it subscribes to, and generic MCP forwarding. Core holds no binding table,
target model, or provider-specific collaboration container.

Core loads built-in and external Channel providers through the same registry and
catalog shape. The neutral contract lives in `@excitedjs/dreamux-types`; a
provider implementation must not import `@excitedjs/dreamux`.

Routing state is provider-owned durable state. Core supplies a per-dispatcher
state root and nothing else: filenames, schemas, validation, and commit semantics
belong to the Channel that understands the platform.

Source:

- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/channel/catalog.ts`
- `/packages/dreamux/src/channel/external-channel-provider.ts`
- `/packages/dreamux/src/registry/`
- `/packages/dreamux/tests/package-boundary-guards.test.ts`

## Contracts

### Instances and sessions

Each live dispatcher builds one `ChannelInstance` per configured channel and
holds it by dispatcher-local `channel_id`. The first configured channel is the
primary/default egress channel. `ChannelService` builds, holds, hands out, and
closes those instances and nothing else.

`ChannelSession` is a direct, same-process lifecycle. `initialize(port)` loads
and validates Channel-owned state and attaches event consumers but must not open
external input. `start()` opens external I/O. `close()` stops it and awaits the
Channel-owned mutation tail. That split makes subscribe-before-admission
provable.

Everything a Channel reaches Core through is the `ChannelCorePort`: the shared
Command invoker and one read-only, dispatcher-scoped event source. A Channel
names a Command, passes a payload, and receives one answer. The Channel and admin
socket adapters bind the same Command registry, so a Channel gets no smaller
catalog and no private Core door.

Source:

- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/channel-service/index.ts`
- `/packages/dreamux/src/command/`

### Provider tools and MCP

A provider owns its tool names, JSON schemas, handlers, and caller-specific
surface. Core asks the provider's `ChannelMcpCapability` to describe a catalog
for a caller, freezes that answer for one runtime generation, and admits only
the names in it. Resolution reuses the same caller, so the served definition is
the advertised definition rather than one shared handler branching on identity.

Each descriptor carries a name, optional presentation metadata, mandatory input
schema, optional output schema, standard annotations, and optional icon metadata.
The neutral contract has no MCP SDK dependency. Core validates the complete
catalog, including unique names, JSON-safe values, and SDK-compilable schemas. A
tool without a handler is not advertised.

The Channel MCP server uses the same in-server delegate contract as every
internal domain. The lease registry, transport Commands, descriptor, and shim do
not know which provider owns a tool. A registration explicitly targets either
the provider capability, which needs no live session, or the created instance's
session capability. Both receive the scope Core baked into the lease. Core names
no provider tool, inspects no provider result field, and performs no
provider-specific egress gate.

Source:

- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/mcp/server.ts`
- `/packages/dreamux/src/service/channel-service/mcp-delegate.ts`
- `/packages/dreamux/src/service/channel-service/mcp-delegates.ts`
- `/packages/dreamux/src/service/mcp/`

### Targets, routing, and inbound submission

A target never crosses the provider seam. The neutral contract publishes no
`ChannelTarget`: Core never sees a platform conversation id, thread id, target
key, or bindability flag, holds no binding table, and makes no routing decision.
Target kinds and lookup rules belong to each provider.

The Channel resolves its own target, consults its own routes, and states the
recipient through the generic `team.submit` Command:

- a resolved `team_name` reaches that Team's TeamLeader;
- omitting `team_name` reaches the Dispatcher Agent.

Omission is a Channel decision, not a Core fallback heuristic. The submission
also carries provider-owned display attributes, faithful body text, an optional
standing reminder, and a stable `source_id`; Core owns generic deduplication and
renders the provenance envelope. The returned `turn_id` lets the Channel match
the submitted event to the exact turn it created.

A binding is therefore a Channel-owned expected route, not a Core assertion
about an external platform object. A Collaboration Space is likewise a Channel
product flow composed from provider-owned policy and ordinary Core Commands; Core
has no Collaboration Space entity or Command namespace.

Source:

- `/packages/dreamux/src/service/team-collection/commands.ts`
- `/packages/dreamux/src/service/channel-submission.ts`
- `/packages/dreamux/src/service/submission-sources.ts`

### Dispatcher-scoped Core events

Each `DispatcherService` owns one in-process `DispatcherCoreEventBus`. It is a
best-effort distribution helper, not a fact owner or store. Existing owners
publish after their normal write point. Routing produces no Core event: the
Channel already owns its routes, and publishing them back from Core would require
Core to hold a duplicate routing fact. Workflow, scheduler, and host-maintenance
events are absent.

The sealed catalog contains six kinds: `team.state`, `teammate.state`,
`teammate.turn.submitted`, `teammate.turn.settled`, `teammate.turn.message`, and
`teammate.turn.tool_call`. An event outside that set, with a `schema_version`
other than `1`, or without a finite `occurred_at` is dropped and logged rather
than thrown. A sealed event is deeply frozen before broadcast.

A Channel receives one read-only `ChannelEventSource` with
`subscribe(listener)` and an idempotent `unsubscribe()`. One subscription receives
the complete `ChannelCoreEvent` union and demultiplexes inside the Channel. Turn
events expose a process-local `turn_id`, not a runtime-native Turn or transcript.
Conversation events may contain bounded, redacted display text and tool
arguments/results; no event contains native transcript paths, raw errors, or
platform user identity.

Delivery is live and best-effort. Core calls listeners in publication order
without awaiting them, and listener failure never escapes into admission or
settlement. There is no FIFO, backpressure, timeout, acknowledgement, retry,
replay, snapshot, or final-delivery guarantee. A provider keeps synchronous
projection bounded and owns any serialized durable reaction to an event.

Core installs the source during `initialize`, before `start` opens external
input. Stop and start-failure cleanup revoke the whole session source before
closing the session; later subscription attempts fail and old handles become
no-ops.

Source:

- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/service/dispatcher-core-events/`
- `/packages/dreamux/src/service/agent-entity/identity-store.ts`
- `/packages/dreamux/src/service/team-collection/store.ts`
- `/packages/dreamux/src/service/channel-service/index.ts`
- `/packages/dreamux/src/channel/conversation-projection.ts`
- `/packages/dreamux/src/service/teammate-service/turn-coordinator.ts`
- `/packages/dreamux/src/service/dispatcher-service/index.ts`

### Conversation presentation

The neutral conversation projection is a capability of the dispatcher agent and
team-scoped entities, not a provider-specific role filter in Core. TeamLeaders
and Team members publish the event surface; team-less dispatcher-spawned
TeamMates do not. An origin-less dispatcher turn is rejected before submitted,
activity, or settled facts enter the bus.

Every admitted EntityTurn that participates in conversation projection publishes
one terminal display fact from its own submission settlement, including
`completed`, `failed`, and `stopped`; non-participating turns publish none.
Completed assistant text and live activity are redacted and bounded in Core. The
provider owns anchors, presentation state, batching, and external I/O. The entire
path is display-only and fail-open: it cannot change runtime admission,
settlement, completion delivery, or retention cleanup.

Source:

- `/packages/dreamux/src/channel/conversation-projection.ts`
- `/packages/dreamux/src/service/teammate-service/turn-coordinator.ts`

## Invariants

- A target never crosses the seam: Core receives a `team_name` or no recipient.
- Assistant text alone is never a Channel delivery contract. A runtime that must
  answer visibly calls a provider-owned tool; Core owns no durable outbound retry
  queue.
- Core state must not grow provider presentation state, a reaction ledger, an
  inbound message queue, or provider routing facts.
- Core must not implement provider-specific tool handlers or re-derive a routing
  fact from Channel data.
- Adding a `ChannelCoreEvent` kind means adding it to the sealed catalog; an
  unlisted kind is logged and dropped.

History:
[/.agents/tasks/architecture/minimize-provider-boundaries/README.md](/.agents/tasks/architecture/minimize-provider-boundaries/README.md)
