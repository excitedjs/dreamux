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

## Feishu Inbound Content Fidelity

Feishu content parsing and SDK ownership stay split across the two channel
packages. `@excitedjs/feishu-transport` parses event content into additive,
untrusted, source-ordered `text` / `code` / `resource` parts while retaining
the legacy flat text and de-duplicated resource views. It also exposes narrow
wrappers around `im.v1.message.get`, message-resource download, and optional
contact-backed sender-name lookup. `@excitedjs/feishu-channel` decides when
those calls are allowed, validates reread roots against the already accepted
event, resolves/downloads resources, and owns the model-facing XML.

The access gate runs before any message read or resource fetch. Accepted
interactive cards use the structured and default read representations with a
deterministic visible-text union. `nonsupport` events may adopt a matching
root's authoritative type/content. Merged-forward messages deliberately perform
no current-message read or child-resource fetch. The Channel emits an empty
`<content />` plus `<refs><merged-forward message_id="..."/></refs>`.
Actionable reply/quote ancestry is likewise a `<reply-to>` reference with only
the parent id and a best-effort proven type; parent content is never injected.
Channel content does not name or prescribe a lookup tool or command.

Rich posts preserve Markdown/code, links, mentions, rules, and inline resource
positions. The Channel wraps visible content in `<content>`, renders each
resource occurrence once as an inline `<attachment>` at its original position,
and de-duplicates only the download/cache result and neutral runtime attachment.
Code is Channel-owned `<code><![CDATA[...]]></code>` with safe `]]>` splitting,
so source operators remain literal without opening the surrounding XML. Cards
expose only visible labels/text/options and exclude callback or hidden values.
Audio and media map onto the existing file/image resource ABI; stickers, shared
entities, and future types receive explicit bounded fallbacks instead of raw
JSON.

Every accepted inbound owns a session-fenced enrichment context. Session close
revokes it before closing the transport and drains handlers that already
started. The context bounds the whole enrichment to 60 seconds, 32 unique
resources, 25 MiB per resource, 100 MiB aggregate, and one sequential download;
the complete pre-reminder structured body is capped at 160,000 UTF-16 code
units. The typed truncator charges XML wrappers, escaped text, CDATA splits,
refs, and optional trusted-bot context and always closes Channel-owned
structures. Untrusted text is escaped exactly once at the final Channel
boundary. After current-message enrichment, one optional two-second parent read
may add the bounded reply type; the returned parent body and children are
discarded.

Topic chat-mode discovery and received/in-progress reaction operations are
also bounded and session-aware. A hung SDK request cannot keep session close or
dispatcher restart waiting indefinitely. Late route results cannot record a
stale message target, and a late reaction result is cleaned up best-effort
without entering the current session ledger.

Sender names are best-effort and never gate delivery. Event-provided names win;
known/trusted bot state names bot senders without a contact call; accepted
mention pairs seed a positive transport-local cache; and an unnamed human may
use `contact.v3.user.get` with at most 800 ms of the remaining inbound budget.
Only Feishu code `99991672` opens the per-transport missing-scope circuit.
Per-user monotonic versions and the session abort signal prevent a timed-out or
revoked lookup from overwriting a newer cached/mention name or opening that
circuit after close. Unknown names are omitted. `create_time` is rendered in
the process-local time zone as unpadded `YYYY-M-d H:m:s`. The final concise
Channel reminder permits a direct substantive reply when no preliminary work
is needed and asks for an acknowledgement only before longer work.

Key source:

- `/packages/channel/feishu-transport/src/parse/`
- `/packages/channel/feishu-transport/src/transport/message-read.ts`
- `/packages/channel/feishu-transport/src/transport/user-name.ts`
- `/packages/channel/feishu-channel/src/feishu-inbound-enrichment.ts`
- `/packages/channel/feishu-channel/src/feishu-reply-ancestry.ts`
- `/packages/channel/feishu-channel/src/feishu-inbound-work.ts`
- `/packages/channel/feishu-channel/src/feishu-message.ts`
- `/packages/channel/feishu-channel/src/feishu-message-render.ts`
- `/packages/channel/feishu-channel/src/feishu-session-inbound.ts`

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
- TeamLeader projection:
  `bind_channel({ channel_id?, meta })` and
  `transfer_back({ channel_id?, meta })`, both scoped to the descriptor-bound
  current Team/leader. TeamLeader bind is create-only for unowned targets and
  refuses collaboration-managed routes; dispatcher bind keeps replacement
  semantics.

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

Collaboration target work has three entry points:

- **Target lifecycle events.** When the provider calls
  `ChannelRoutes.targetLifecycle` with `target_created` for a container with a
  bound collaboration-space record, or a channel default binding policy can
  create one, the collaboration target lifecycle path writes the durable claim
  and returns; heavy worktree/Team provisioning runs asynchronously under the
  `CollaborationSpaceService` lifecycle-task tracker. `DispatcherService`
  resumes durable `creating` / `failed` / `closing` targets before starting any
  channel session, releases stale managed claims for inactive targets, and
  drains accepted lifecycle tasks during stop/shutdown. For unknown containers
  without default binding, and for known unbound spaces, the create event is
  ignored without claiming a target. For `target_closed`, the target lifecycle
  path accepts the close event and asynchronously dissolves the Team and
  releases the binding.
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
- **Optional strict session operations.** A provider may feature-detect
  `ChannelRoutes.ensureCollaborationTarget` and `deliverExact`.
  `ensureCollaborationTarget` reuses `acceptAndProvisionTarget` but returns only
  after the target is active and bound, the Team is running, the TeamLeader is
  ready, local workspace preparation has completed, and the exact claimed route
  still matches. It returns the existing Team name and accepts no repository,
  cwd, or workspace-mode input; omitted-repo placement follows the dispatcher's
  local `workspace.enabled` policy. `deliverExact` holds the target and Team
  route fences, requires the authoritative owner to match
  `expected_team_name`, and submits directly to the TeamLeader. It never walks
  `binding_fallbacks` or invokes the dispatcher agent. Both methods use bounded
  public rejection codes and participate in dispatcher admission and shutdown
  drain. They add no remote close operation or retained submission state;
  `sourceId` remains a live-runtime correlation/dedupe hint. Every
  `ChannelSession.start` receives a fresh process-local lease for the two strict
  closures. Stop and failed-start rollback revoke it before session close; an
  old generation thereafter returns `dispatcher_unavailable` without entering
  routing or materializing a runtime.

Both paths bypass the dispatcher agent runtime but still go through
`DispatcherService` and core stores. Direct inbound and strict promises are
admitted and tracked by `DispatcherService`; session-lease revocation permanently
rejects later strict callbacks from an old generation, while dispatcher drain
waits for calls that crossed admission before sweeping materialized Team runtimes.
Failed Channel start uses the same fence and sweep after closing its sessions,
while retaining durable target and Team facts for the next generation.
Dispatcher and Team cron command
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

## Dispatcher-Scoped Core Events

Each `DispatcherService` owns one in-process `DispatcherCoreEventBus`. It is a
best-effort distribution helper, not a fact owner or store. Existing owners
publish after their normal write point:

- `TeamStore` publishes Team status and concrete leader changes;
- `AgentIdentityStore` publishes TeamLeader and TeamMate status changes;
- `AgentTurnsStore` publishes Team-owned submitted and settled turn rows after
  the append attempt, using the normalized Assistant value and truncation fact.

Channel sessions receive only a public `ChannelCoreEventSource`. It supports
typed `on(...)` subscriptions and idempotent per-listener `unsubscribe()`;
providers cannot emit, enumerate, or remove other listeners. The source covers
allowlisted Team, agent, and turn identities for the current dispatcher only.
It contains no dispatcher id, channel target, repository/path, prompt, raw
error, platform identity, cursor, or acknowledgement.

Core installs the source before calling `ChannelSession.start`, so a session may
subscribe before triggering a strict ensure. Stop and start-failure cleanup
revoke the whole session source and strict-route lease before closing sessions;
later subscription attempts fail and old subscription handles become no-ops.
Events are
live-session-only: the bus retains no history and provides no eventual-delivery
or historical-query guarantee. A settled Assistant uses the same 160k core cap
as the turn archive, and `assistant_truncated` is true when either the runtime
already truncated the result or the core cap did.

Key source:

- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/service/dispatcher-core-events/`
- `/packages/dreamux/src/service/agent-entity/identity-store.ts`
- `/packages/dreamux/src/service/agent-entity/turns-store.ts`
- `/packages/dreamux/src/service/team-collection/store.ts`
- `/packages/dreamux/src/service/dispatcher-service/collaboration-routing.ts`
- `/packages/dreamux/src/service/dispatcher-service/index.ts`

The built-in Feishu provider implements first-inbound collaboration routing for
real topic-mode groups. After the access gate accepts an inbound, the provider
uses `message.thread_id` as the stable target key and verifies the enclosing
chat through `im.v1.chat.get`. Only `chat_mode=topic` produces
`ChannelContainer { container_type: "topic_group", container_key: chat_id }`
and a bindable `ChannelTarget { target_type: "topic", target_key: thread_id }`.
`root_id` and `parent_id` remain diagnostic ancestry and never substitute for a
missing `thread_id`.

The topic target declares the enclosing group target through the neutral
`binding_fallbacks` capability. Routing checks an exact topic binding first,
then accepted collaboration provisioning or an existing exact claim, then the
provider-declared group binding, and finally the Dispatcher. Core never derives
the group target from a container key or Feishu metadata, and fallback targets
are never collaboration provisioning inputs. This preserves pre-topic group
bindings without letting them preempt bound collaboration spaces or explicit
topic bindings. If a more-specific active binding exists but its Team is not
open, routing does not cross that ownership boundary to a broader fallback.

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
After exact ownership succeeds, a TeamLeader may also be authorized by the
target's explicit group binding fallback. Group-bound leaders can therefore
reply safely to observed topic messages, while a leader bound only to another
topic remains outside scope.
Standalone `thread_id` selectors are rejected because Feishu does not expose
them as a safe send-to-topic primitive on this transport seam.
Every non-empty inbound `thread_id` is independently included in the opaque
display attrs rendered into the model-visible `<channel>` envelope. Ordinary
group threads expose that fact without acquiring a topic container or topic
routing semantics.
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

- [Channel-scoped collaboration and core events](../decisions/channel-scoped-collaboration-and-core-events.md)
- [NPM package split and channel targets](../decisions/npm-package-split-and-channel-targets.md)
- [Provider architecture realignment](../decisions/provider-architecture-realignment.md)
- [Channel provider](../decisions/channel-provider.md)
- [Channel input runtime assembly](../decisions/channel-input-runtime-assembly.md)
- [Feishu inbound attachments](../decisions/feishu-inbound-attachments.md)
- [Feishu pairing access v3](../decisions/feishu-pairing-access-v3.md)
- Archived background:
  [plugin/provider architecture proposal](../archive/proposals/plugin-provider-architecture.md)
