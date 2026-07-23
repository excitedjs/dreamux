# Channel Routing And Binding

This page is the stable contract for Channel providers, provider tools, target
normalization, Team channel binding, and TeamLeader channel authorization.

Read this before changing Channel provider contracts, `channel-mcp`, Team MCP
`bind_channel` / `transfer_back`, binding state, or inbound channel routing.

## Provider Ownership

A Channel provider owns platform I/O, inbound normalization, target resolution,
provider-specific tools, and message ownership facts. Dreamux core owns Channel
session lifetime, Team routing, binding state, authorization, and generic MCP
forwarding.

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

Each live dispatcher owns a map of `ChannelSession`s keyed by dispatcher-local
`channel_id`. The first configured channel is the primary/default egress channel.
Core builds one generic `channel-mcp` stdio shim for provider tools and forwards
tool calls through neutral admin methods to the live session or sessionless
provider handler.

For Feishu, the provider tool surface is:

- `reply`
- `react`
- `list_chat_bots`

Those names and schemas are Feishu package-owned. Core must not implement
Feishu-specific tool handlers.

Source:

- `/packages/dreamux/src/service/channel-service/`
- `/packages/dreamux/src/mcp/channel-mcp.ts`
- `/packages/channel/feishu-channel/src/feishu-mcp-tools.ts`
- `/packages/channel/feishu-channel/src/provider.ts`

## Delivery And Ownership

Channel providers own platform-specific delivery, reactions, message ownership
facts, and provider tool schemas. Core exposes those tools to runtimes through a
neutral MCP forwarding layer and authorizes calls by dispatcher or TeamLeader
scope.

Assistant text alone is never a channel delivery contract. If a runtime should
respond visibly in the source channel, it must call a provider-owned channel
tool. Tool failures are returned as MCP errors and logged; there is no durable
outbound retry queue in core.

Reaction ownership and inbound de-duplication are process-local provider facts
unless the provider domain page says otherwise. Core state must not grow a
generic persisted reaction ledger or inbound message queue.

Source:

- `/packages/dreamux/src/mcp/channel-mcp.ts`
- `/packages/dreamux/src/service/channel-service/index.ts`
- `/packages/channel/feishu-channel/src/provider.ts`
- `/packages/channel/feishu-channel/src/feishu-mcp-tools.ts`

## Targets

Channel providers normalize provider-defined selectors into `ChannelTarget`:

- `target_type`
- opaque provider-owned `target_key`
- `bindable`
- optional `display`, `canonical_url`, and `meta`

Core routes by `(channel_id, target_key)`. A provider must therefore keep
`target_key` stable and unique across the whole Channel, not merely within one
container. Provider selector metadata stays in `meta`; core does not promote
provider-specific fields such as chat ids to generic top-level columns.

If a conversational target cannot be normalized to a stable key, the provider
must fail loudly rather than store an ambiguous selector.

Source:

- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/service/channel-service/index.ts`
- `/packages/channel/feishu-channel/src/provider.ts`

## Team Binding

Binding a Channel target to a Team is a Dreamux core Team capability. The tools
live on Team MCP, not on a generic Channel MCP binding surface:

- dispatcher projection:
  `bind_channel({ team_name, channel_id?, meta })`
- dispatcher projection:
  `transfer_back({ channel_id?, meta })`
- TeamLeader projection:
  scoped `bind_channel({ channel_id?, meta })` and
  `transfer_back({ channel_id?, meta })`

`channel_id` selects the configured channel. It defaults only when the
dispatcher has one configured channel. `meta` is provider-owned selector input;
core passes it to the selected Channel session's `resolveTarget(meta)`.

The old Feishu-specific `bind_group`, `transfer_channel_back`, and
`create.bind_group` tools are removed without aliases.

Source:

- `/packages/dreamux/src/mcp/team-mcp.ts`
- `/packages/dreamux/src/service/channel-service/index.ts`
- `/packages/dreamux/src/service/channel-binding/store.ts`

## Binding Store

Channel binding state is durable server state at:

```text
~/.dreamux/state/<dispatcher-id>/channel-bindings.json
```

The current store version keys active rows on `(channel_id, target_key)`. One
target can be active for only one Team at a time. Dispatcher rebinding
reassigns it. TeamLeader bind instead uses an atomic available-to-owner write:
it creates an unowned explicit route, returns the exact same explicit owner
unchanged, and rejects another owner or any active managed claim. The caller's
descriptor-bound Team/leader generation and route readiness are checked under
the Team route lifecycle lease before that write; no managed intent is detached
on this path.
Rows carry provider ref, target type/key, display/canonical URL, provider
`meta`, Team name, TeamLeader name, active flag, and timestamps.

Store mutation methods return atomic transition DTOs from inside the existing
write fence. Route `bound`, `replaced`, and `unbound` transitions are the only
ones that higher services publish; metadata/display refreshes and already
inactive replays are `unchanged` and produce no binding event. A managed
collaboration claim (`claim_id != null`) may be replaced by an explicit binding
for the same Team, but a managed claim cannot take over an explicit active route
through the claim API.

The binding store is v3. Version 2 rows that already carry `channel_id` and
`target_key` are reused as explicit routes with `claim_id: null` only when no
open collaboration target shares the route key. If such an overlap exists,
startup/doctor fails loud because the old row could be either an explicit bind
or a collaboration-managed route. Older rows, old `team_id`-keyed rows, or
pre-target-key schemas also fail loud and must be rebuilt.

Source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/service/channel-binding/preflight.ts`
- `/packages/dreamux/src/service/channel-binding/store.ts`
- `/packages/dreamux/src/service/legacy-state.ts`

## Inbound Routing

The Channel session tags inbound delivery with the `channel_id` that actually
received the event. Core routing is:

- non-bindable or P2P target: route to the dispatcher;
- bindable target with an active `(channel_id, target_key)` binding: route to
  the bound TeamLeader;
- unbound bindable target: route to the dispatcher.

P2P targets short-circuit before any binding lookup and can never be bound to a
TeamLeader.

Source:

- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/channel-service/index.ts`
- `/packages/dreamux-types/src/channel.ts`

## Optional Strict Collaboration Operations

`ChannelRoutes` retains the existing conversational `deliver` and asynchronous
`targetLifecycle` behavior. It also offers two optional, provider-neutral
capabilities for sessions that require a synchronous ready boundary:

- `ensureCollaborationTarget({ container, target, title? })` reuses the current
  collaboration-space target claim and provisioning owner. A ready result means
  the Space binding, local workspace, Team, TeamLeader, active target, and exact
  claimed route are ready, and returns only the existing Team name. Providers
  cannot pass repository, cwd, workspace mode, dispatcher, channel, or provider
  authority; workspace placement remains local dispatcher policy.
- `deliverExact({ target, expected_team_name, turn })` validates the same exact
  claimed route under the target and Team lifecycle fences, then submits
  directly to that TeamLeader. It fails closed on a missing, replaced, detached,
  closing, closed, or stale route and never uses target fallbacks or the
  dispatcher agent.

Both methods enter dispatcher admission and return bounded rejection DTOs
instead of raw errors. `turn.sourceId` remains a runtime-local hint; the strict
surface adds no retained submission state or cross-restart delivery guarantee.
Each `ChannelSession.start` gets a fresh process-local lease for these strict
closures. Stop and failed-start rollback revoke that lease before closing the
session, so later calls through an old generation return
`dispatcher_unavailable` without creating, starting, or reviving a runtime.
Failed-start rollback then closes admission, drains accepted strict and lifecycle
work, and sweeps materialized Team runtimes while retaining durable Team and
target facts for recovery. There is no corresponding remote close/cancel method.

Collaboration-space records persist container metadata opaquely. Provisioned
target records persist a copy of the provider-owned target `meta` in the initial
durable claim, and `targetFromRecord()` restores it for retry/reconciliation
paths before the channel route write. This keeps provider addressing facts across
the crash window between target claim and binding persistence while core still
treats the metadata as opaque.

Source:

- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/service/collaboration-space/target.ts`
- `/packages/dreamux/src/service/dispatcher-service/collaboration-routing.ts`
- `/packages/dreamux/src/service/collaboration-space/target-lifecycle.ts`
- `/packages/dreamux/src/service/dispatcher-service/index.ts`

## Core Fact Subscriptions

Each dispatcher has an in-process typed event bus fed by the existing Team,
agent-identity, turn, channel-binding, and collaboration-space owners. A Channel
session receives only a scoped, read-only event source with owned subscription
handles. The DTO allowlist covers Team and Team agent state changes, Team-owned
turn submitted/settled facts, route binding transitions, and
collaboration-space binding transitions. Turn settled facts include settle
status, nullable Assistant text, and truncation. Binding event endpoint
snapshots include provider ref, endpoint type/key/display/canonical URL, and
opaque provider-owned `meta`; route-bound snapshots also include the concrete
TeamLeader, TeamLeader runtime id, and runtime cwd.

The source is installed before session start and revoked before session close on
stop or failed start. It is live-session-only and best-effort: it retains no
history and provides no eventual-delivery or historical-query guarantee. Binding
notifications are ordered only by each provider session's own serialized
consumer queue. The bus does not become a new state owner, and providers never
receive core service/store instances or raw `EventEmitter` management methods.
Binding events are dispatcher-wide broadcasts rather than channel-id scoped
streams; providers filter by the provider ref on the endpoint snapshot.

Source:

- `/packages/dreamux/src/service/dispatcher-core-events/`
- `/packages/dreamux/src/service/binding-events.ts`
- `/packages/dreamux/src/service/agent-entity/identity-store.ts`
- `/packages/dreamux/src/service/agent-entity/turns-store.ts`
- `/packages/dreamux/src/service/team-collection/store.ts`
- `/packages/dreamux/src/service/channel-service/index.ts`
- `/packages/dreamux/src/service/collaboration-space/index.ts`
- `/packages/dreamux/src/service/dispatcher-service/index.ts`

## TeamLeader Egress Authorization

TeamLeader channel tool calls are authorized by core. Provider facts such as
`messageBelongsToTarget` are inputs, not replacements for core authorization.

Before a TeamLeader can use a provider channel tool, core checks:

- caller identity and Team ownership;
- the active binding for the target key;
- that the selected channel id matches the bound target;
- provider message ownership when a message id is present.

The dispatcher keeps the global channel management surface. TeamLeaders can use
channel tools only for their bound Team channels.

Source:

- `/packages/dreamux/src/service/channel-service/index.ts`
- `/packages/dreamux/src/service/channel-service/mcp-descriptors.ts`
- `/packages/dreamux/src/service/channel-service/errors.ts`
- `/packages/dreamux/src/service/dispatcher-service/mcp-descriptors.ts`

## Feishu-Specific Contracts

Detailed Feishu behavior lives in focused domain pages:

- [Feishu introduce](feishu-introduce.md)
- [Feishu pairing access](feishu-pairing-access.md)
- [Non-blocking dispatcher inbound](non-blocking-dispatcher-inbound.md)

## Decision Trail

- [Channel-scoped collaboration and core events](../decisions/channel-scoped-collaboration-and-core-events.md)
- [Feishu binding notification events](../decisions/feishu-binding-notification-events.md)
- [NPM package split and channel targets](../decisions/npm-package-split-and-channel-targets.md)
- [Channel provider](../decisions/channel-provider.md)
- [Channel input runtime assembly](../decisions/channel-input-runtime-assembly.md)
- [Feishu inbound attachments](../decisions/feishu-inbound-attachments.md)
- [Feishu pairing access v3](../decisions/feishu-pairing-access-v3.md)
