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
for externally created provider containers that should be bound to a worktree
policy. This is not a provider Channel MCP surface. For Feishu, creating or
finding the topic group remains a dispatcher-agent action through `lark-cli`;
the core tool only records and releases Dreamux's provisioning binding.

The current core surface is:

- `bind`: register an existing external container when needed and bind it to a
  worktree policy, TeamLeader runtime, and optional default TeamLeader identity.
  `repo` is optional: supplied repo creates managed worktrees, omitted repo
  follows that dispatcher's default workspace policy;
- `dissolve`: release the current collaboration-space routing/provisioning
  binding. It does not delete the external container and does not dissolve
  already provisioned Teams;
- `status` / `list`: read compact public state. There is no first-version
  `history` or recovery tool. Target failures are public-safe summaries; raw
  provider/runtime/worktree errors remain local diagnostics.

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
The store allocates the generation in the same atomic transition that validates
the unbound state and commits the complete binding policy. Dispatcher state has
one process-level writer authority; separate store objects share that fence.

Dispatcher channel config may enable a core-owned automatic binding policy at
`dispatchers[].channels[].collaborationSpace.defaultBinding.enabled`. When
enabled, an inbound/lifecycle event with a neutral `container` for an unknown
external space can create a safe derived collaboration-space record and bind it
with the dispatcher's default agent runtime plus optional configured `repo` and
`identity`. The provider still only supplies `container`/`target`; it does not
create Dreamux spaces, Teams, worktrees, or bindings. A known unbound space
created by `collaboration_space.dissolve` is not auto-bound again; explicit
`bind` is required to reattach it.

Provisioning has two entry points:

- **Target lifecycle events.** When the provider calls
  `ChannelRoutes.targetLifecycle` with `target_created` for a container with a
  bound collaboration-space record, or a channel default binding policy can
  create one, the collaboration target lifecycle path writes the durable claim
  and returns; heavy worktree/Team provisioning runs asynchronously under the
  `CollaborationSpaceService` lifecycle-task tracker. `DispatcherService`
  resumes durable `creating` / `failed` / `closing` targets after channel
  sessions start, releases stale managed claims for inactive targets, and drains
  accepted lifecycle tasks during stop/shutdown. For unknown containers without
  default binding, and for known unbound spaces, the create event is ignored
  without claiming a target. For `target_closed`, the target lifecycle path
  accepts the close event and asynchronously dissolves the Team and releases
  the binding.
- **First-inbound provisioning.** When a bindable target has no existing binding
  and `envelope.container` is set on `deliver()`, `routeChannelInput` calls
  `acceptAndProvisionTarget` synchronously before routing. This may use channel
  default binding to register an unknown collaboration space. If provisioning
  succeeds and the Team and TeamLeader are routable, the inbound is delivered
  to the TeamLeader; if it fails, a failed `InboundDeliveryResult` is returned.
  This path never falls back to the dispatcher agent after collaboration-space
  provisioning has claimed the target. If a later inbound for the same
  `(channel_id, target_key)` omits `envelope.container`, core still checks for
  an existing durable collaboration-space target claim before falling back to
  the dispatcher agent.

Both paths bypass the dispatcher agent runtime but still go through
`DispatcherService` and core stores. Direct inbound promises are admitted and
tracked by `DispatcherService`, so stop rejects later callbacks and drains older
ones before sweeping materialized Team runtimes. Dispatcher and Team cron command
surfaces expose only `SchedulerCommands`; cron fires use the same owner
admission, while scheduler lifecycle methods stay owner-only through the
dispatcher container or TeamCollection's private lifecycle capability. Stop
closes admission, closes channel sessions, aborts held scheduler fires, drains
accepted work, then stops schedulers again before sweeping runtimes. The sweep
retains partially booted Team services that failed before live-cache
publication, and one runtime stop failure does not prevent sibling members or the
TeamLeader from receiving a stop attempt. Accepted provisioning rechecks the
shutdown fence before creating a Team, starting its leader, or claiming a route;
a Team whose in-flight create crosses that fence is closed before the drain
settles, and a late create failure stops any leader it already launched.
Explicit Team transfer, dissolve, or route replacement shares a `(channel_id,
target_key)` lock with collaboration provisioning and first detaches matching
intent for transfer-back; explicit bind instead commits the replacement before
detaching intent, so a rejected bind does not destroy the managed route. Route
publication also holds a Team lifecycle lease. Every Team close raises the
closing fence, detaches matching collaboration intent, transfers all routes
owned by that Team, and only then dissolves it. Managed bindings carry an opaque
`claim_id`, while explicit binds clear it; reconciliation therefore releases
only the stale matching claim and preserves an explicit replacement even when it
names the former Team. The binding store is v3; v2 rows that already have
`(channel_id, target_key)` are reused as explicit routes with `claim_id: null`
only when no open collaboration target shares that route key. If such an
overlap exists, startup/doctor fails loud because the old row could be either
explicit or collaboration-managed. Older rows without route keys still fail
loud. A missing route is reclaimed only when the original Team is still
routable. Detached targets fall back to the normal dispatcher path.
When the space is dissolved, future deliveries also fall back unless the space
is rebound.

The built-in Feishu provider implements first-inbound collaboration routing for
real topic-mode groups. After the access gate accepts an inbound, the provider
uses `message.thread_id` as the stable target key and verifies the enclosing
chat through `im.v1.chat.get`. Only `chat_mode=topic` produces
`ChannelContainer { container_type: "topic_group", container_key: chat_id }`
and a bindable `ChannelTarget { target_type: "topic", target_key: thread_id }`.
`root_id` and `parent_id` remain diagnostic ancestry and never substitute for a
missing `thread_id`.

Ordinary groups remain group targets even when Feishu exposes thread-style
messages inside them. Missing group-information permission, API failure, and
missing or unknown chat mode warn in the channel log and fail safe to the group
route; unsuccessful lookups are not cached, so later accepted inbound retries.
Operators using Feishu topic collaboration must grant the bot a group
information read permission accepted by the chat-get API, such as
`im:chat:readonly`.

The Feishu session records the exact normalized target for accepted inbound
message ids. TeamLeader egress target resolution uses that message ledger,
rejects conflicting chat/thread selectors, and authorizes message ownership
against the exact topic rather than the enclosing chat. Reply execution still
uses Feishu's source-message reply API, which preserves the authorized topic.
Standalone `thread_id` selectors are rejected because Feishu does not expose
them as a safe send-to-topic primitive on this transport seam.
The provider does not claim topic-created or topic-closed lifecycle support;
provisioning begins on first accepted topic inbound.

Key source:

- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/config/collaboration-space-config.ts`
- `/packages/dreamux/src/service/channel-binding/store.ts`
- `/packages/dreamux/src/service/channel-binding/preflight.ts`
- `/packages/dreamux/src/service/collaboration-space/`
- `/packages/dreamux/src/mcp/collaboration-space-mcp.ts`
- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/dispatcher-service/collaboration-routing.ts`
- `/packages/channel/feishu-transport/src/parse/content.ts`
- `/packages/channel/feishu-transport/src/transport/feishu.ts`
- `/packages/channel/feishu-channel/src/feishu-target-router.ts`
- `/packages/channel/feishu-channel/src/provider.ts`

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
