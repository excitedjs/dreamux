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
- channel-owned COT presentation state;
- Feishu MCP tool backing.

Key source:

- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/channel/feishu-channel/src/feishu-channel.ts`
- `/packages/channel/feishu-channel/src/bot.ts`
- `/packages/channel/feishu-transport/`

## Feishu Inbound Content Fidelity

### Inbound trust boundary

Before any content work, the Feishu session classifies raw chat/sender identity
once. Only `p2p | group` and exact `user | bot | app` senders with non-empty ids
proceed; unknown chat/sender shapes fail closed before access mutation, passive
bot observation, `/introduce`, pairing, or delivery.

V3 `group.allow_chats` is trusted human group membership under either non-block
group policy after the one global mention gate. `allowlist` drops an unlisted
chat; `follow-user` sends only an unlisted chat through the existing
`dm_policy`/`allow_users` path. Bot/P2P behavior is unchanged, passive known-bot
observation remains list-scoped, and `/introduce` remains sender-scoped.

Current contract:

- [Feishu pairing access](../domains/feishu-pairing-access.md)
- [Feishu introduce](../domains/feishu-introduce.md)

Feishu content parsing and SDK ownership stay split across the two channel
packages. `@excitedjs/feishu-transport` parses event content once into ordered,
untrusted `text` / `code` / `resource` parts. That sequence is the internal
source of truth; the transport projects the legacy flat text and de-duplicated
resource views only at its public compatibility boundary. It also exposes
narrow wrappers around `im.v1.message.get`, message-resource download, and
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
Downloaded occurrences render exactly `<attachment path="..." />`.
Non-downloaded occurrences render exactly
`<attachment status="not_downloaded" key="..." />`; a missing Feishu key is an
empty escaped value. The exported structured attachment retains
type/name/key/path/status/reason details, diagnostics retain the detailed
failure reason, and the neutral runtime attachment retains applicable
`kind`/`name`/`localPath` facts. Those facts are not repeated in the model-visible
XML.
Code is Channel-owned `<code><![CDATA[...]]></code>` with safe `]]>` splitting,
so source operators remain literal without opening the surrounding XML. Cards
expose only visible labels/text/options and exclude callback or hidden values.
Audio and media map onto the existing file/image resource ABI; stickers, shared
entities, and future types receive explicit bounded fallbacks instead of raw
JSON.

Every accepted inbound owns a session-fenced enrichment context. Session close
revokes it before closing the transport and drains handlers that already
started. A Channel-owned bounded-operation primitive supplies the shared
absolute-deadline, abort, settle-once, and optional late-value-cleanup semantics.
The lifecycle context bounds the whole enrichment to 60 seconds; the attachment
resolver separately owns the 32-unique-resource, 25-MiB-per-resource, and
100-MiB-aggregate policy while retaining one sequential download. The complete
pre-reminder structured body is capped at 160,000 UTF-16 code units. The typed
truncator charges XML wrappers, escaped text, CDATA splits, refs, and optional
trusted-bot context and always closes Channel-owned structures. Untrusted text
is escaped exactly once at the final Channel boundary. After current-message
enrichment, one optional two-second parent read may add the bounded reply type;
the returned parent body and children are discarded.

Topic chat-mode discovery and COT create/append/finish operations are also
bounded and session-aware. A hung SDK request cannot keep session close or
dispatcher restart waiting indefinitely. Late route results cannot record a
stale message target, and expired COT work is reaped from the session-local
presentation indexes.

Sender names are best-effort and never gate delivery. Event-provided names win;
known/trusted bot state names bot senders without a contact call; and every
accepted unnamed human message makes one thin `contact.v3.user.get` attempt.
The Channel bounds that attempt to the lesser of 2,000 ms and the remaining
inbound budget and fences it with the current session lifecycle. The transport
keeps no positive/negative cache, in-flight de-duplication, per-user version, or
permission circuit. Feishu code `99991672`, any other nonzero response,
malformed/missing names, timeouts, and transient errors affect only the current
message, so the next accepted unnamed message queries Feishu again. Unknown
names are omitted. `create_time` is rendered in the process-local time zone as
unpadded `YYYY-M-d H:m:s`. The final concise Channel reminder permits a direct
substantive reply when no preliminary work is needed and asks for an
acknowledgement only before longer work.

Key source:

- `/packages/channel/feishu-transport/src/parse/`
- `/packages/channel/feishu-transport/src/transport/message-read.ts`
- `/packages/channel/feishu-transport/src/transport/feishu.ts`
- `/packages/channel/feishu-channel/src/feishu-bounded-operation.ts`
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

Each provider descriptor carries a name, optional presentation metadata,
mandatory input schema, optional output schema, and standard annotations. The
neutral contract in `@excitedjs/dreamux-types` has no MCP SDK dependency.
Descriptor assembly validates the complete catalog, unique names, JSON-safe
shape, and SDK-compilable schemas before it encodes the child-process command.
The `channel-mcp` CLI repeats the fail-loud validation and refuses a missing,
malformed, empty, or invalid catalog.

Dreamux core injects a generic `channel-mcp` stdio shim through the shared
official-SDK server. The shim is a conduit: it serves provider-supplied
`tools/list` metadata and forwards SDK-validated `tools/call` arguments to
neutral admin methods, which route the call back to the live Channel session or
sessionless provider handler. Core does not name a Feishu tool or inspect its
result fields.

The built-in Feishu provider supplies closed input and output schemas for every
tool. Successful results are canonical values: `reply` returns
`{ message_ids: string[] }`, `react` returns `{ reaction_id: string }`, and
`list_chat_bots` returns `{ chat_id, known, trusted }`. The live and sessionless
paths produce the same `list_chat_bots` result shape. The shared server exposes
the value unchanged as `structuredContent` with exact `content: []` and
validates it against the provider output schema.

Key source:

- `/packages/channel/feishu-channel/src/feishu-mcp-tools.ts`
- `/packages/channel/feishu-channel/src/tools/registry.ts`
- `/packages/channel/feishu-channel/src/provider.ts`
- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/mcp/server.ts`
- `/packages/dreamux/src/mcp/channel-mcp.ts`
- `/packages/dreamux/src/service/channel-service/mcp-descriptors.ts`
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
  `dissolve({ note })`, `bind_channel({ channel_id?, meta })`, and
  `transfer_back({ channel_id?, meta })`, all scoped to the descriptor-bound
  current Team/leader. Self-dissolve maps to the existing core
  `team.dissolve` method and accepts no Team selector; it is not a provider
  tool. TeamLeader bind is create-only for unowned targets and refuses
  collaboration-managed routes; dispatcher bind keeps replacement semantics.

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
neutral `InboundDeliveryResult`; the channel provider owns any platform
acknowledgement or conversation presentation around this call. Core never
directly acknowledges the platform.

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
owned by that Team, and only then logically closes it. Managed bindings carry an opaque
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

A collaboration target close persists a generation-specific handoff while
holding its target lock, accepts or joins the TeamCollection-owned dissolve,
then releases the lock while awaiting the accepted handle's `logicalClosed`
milestone. Final target close reacquires the lock and requires the same closing
record and handoff. The Team operation stores all joined target handoff ids;
route reconciliation re-reads that authoritative set after acquiring each
target lock and skips only an exact match. Thus target `closed` means Team routes
and runtimes are logically closed, not merely that durable acceptance occurred.

## Dispatcher-Scoped Core Events

Each `DispatcherService` owns one in-process `DispatcherCoreEventBus`. It is a
best-effort distribution helper, not a fact owner or store. Existing owners
publish after their normal write point:

- `TeamStore` publishes Team status and concrete leader changes;
- `AgentIdentityStore` publishes TeamLeader and TeamMate status changes;
- `ChannelService` publishes route bind/unbind events after the binding store
  returns a real transition.
- `CollaborationSpaceService` publishes collaboration-space bind/unbind events
  after the space store returns a real transition.
- the conversation projection publishes display-only turn lifecycle and
  activity facts for the dispatcher agent and TeamLeaders.

Channel sessions receive only a public `ChannelCoreEventSource`. It supports
typed `on(...)` subscriptions and idempotent per-listener `unsubscribe()`;
providers cannot emit, enumerate, or remove other listeners. The source covers
allowlisted Team, agent, route-binding, collaboration-space-binding, and
conversation-display facts for the current dispatcher only. The display union
contains `turn.submitted`, `turn.message`, `turn.tool_call`, and `turn.settled`.
It exposes one process-local `turn_id` for presentation correlation but no
runtime-native Turn object or transcript. Binding events are dispatcher-wide
live broadcasts, not
channel-id scoped streams; the endpoint snapshot names the provider ref and
provider-owned opaque `meta`, so only the matching provider should interpret
it. Bound route events include the concrete TeamLeader name, TeamLeader runtime
id, and runtime cwd; ordinary Team/agent events still carry no repository/path
data. Conversation events may contain bounded, redacted user/assistant display
text and bounded tool arguments/results. Other events contain no prompt or
assistant text. No event contains native transcript paths, raw errors, platform
user identity, cursor, acknowledgement, `claim_id`, or binding fallbacks.

The two binding kinds are action-discriminated public unions. A route-bound
event requires its runtime-bearing current Team projection, a route-unbound
event requires the previous Team owner and has no current Team, and
collaboration-space policy is required only on bound events. `ChannelService`
owns the only public route mutation paths and always classifies/publishes after
the store write; stores retain pure transition primitives but callers cannot
choose a silent service mutation.

Core installs the source before calling `ChannelSession.start`, so a session may
subscribe before triggering a strict ensure. Stop and start-failure cleanup
revoke the whole session source and strict-route lease before closing sessions;
later subscription attempts fail and old subscription handles become no-ops.
Events are
live-session-only: the bus retains no history and provides no eventual-delivery
or historical-query guarantee.

Key source:

- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/service/binding-events.ts`
- `/packages/dreamux/src/service/dispatcher-core-events/`
- `/packages/dreamux/src/service/agent-entity/identity-store.ts`
- `/packages/dreamux/src/service/team-collection/store.ts`
- `/packages/dreamux/src/service/channel-service/index.ts`
- `/packages/dreamux/src/service/collaboration-space/index.ts`
- `/packages/dreamux/src/channel/conversation-projection.ts`
- `/packages/dreamux/src/service/teammate-service/turn-coordinator.ts`
- `/packages/dreamux/src/service/dispatcher-service/collaboration-routing.ts`
- `/packages/dreamux/src/service/dispatcher-service/index.ts`

## Feishu COT Conversation Display

The neutral conversation projection is a capability of the dispatcher agent
and team-scoped entities, not a Feishu role filter in core. TeamLeaders and
Team members publish the event surface; team-less dispatcher-spawned TeamMates
do not participate. Its scope is either a team-less dispatcher or a named
TeamLeader/Team member; an origin-less
dispatcher turn is rejected by one core predicate before submitted, activity,
or settled facts can enter the bus.

The Feishu session subscribes through `feishu-cot-adapter`. It owns card
anchoring, event-to-card projection, bounded outbox batching, serialized I/O,
and diagnostics. An inbound card is pinned to that turn's message. For a
TeamLeader, each successfully created Reply message is observed synchronously
and fail-open; its same-target receipt may anchor the next card, while the
team-group binding notification is the fallback before any inbound exists. A
receipt cannot recreate missing leader state or cross the current conversation
target: the chat, target type, and target key must all match, so topic groups
also stay within the same topic thread. A delayed notification commits its
fallback only if the endpoint still routes to the same Team and leader.
Late submitted and fallback anchors consult two bounded fences: a leader-wide
fence set by Team close and endpoint-scoped route fences set by unbind or
replacement. Team starting/running clears both kinds for that leader, while a
matching re-bind clears its endpoint route fence. Re-anchor, unbind,
replacement, Team close, and session close therefore fence late callbacks
without disabling another live endpoint. Fence matching and route-driven
interruption use the anchor's authoritative binding endpoint, not its visible
target fallbacks. TeamLeaders keep one active
presentation and settle it only on a matching `turn_id`. Dispatcher
presentation state is keyed by agent, chat, and turn, so concurrent chats and
interleaved turns cannot steal or close each other's cards; a foreign
`channel_origin` is a strict no-op. These
next/fallback anchor mechanics are TeamLeader-only and do not apply to
dispatchers.
Feishu ignores Team-member events explicitly; it never routes them through the
leader state machine. Leader message and tool activity must also match the
state's single admitted `turn_id`, preventing a fence-rejected or superseded
turn from opening or appending to another endpoint's card.

Every admitted EntityTurn that enters conversation projection publishes exactly
one terminal display fact from its own submission settlement, including
`completed`, `failed`, and `stopped`; non-participating turns publish no display
events. Completed assistant text and live activity are redacted and bounded in
core. The early-activity buffer and projected activity-id set each retain at
most 512 facts per submission and drop newest with one warning. Feishu retains
at most 512 dispatcher conversations, 512 dispatcher turns per session, and 64
turns per chat, again refusing newest work without partial index state. COT I/O
has a 20-second operation deadline so settled draining state is eventually
reaped.

The whole path is display-only and fail-open. Projection publisher, sanitizer,
identity, and logger failures cannot change runtime admission, settlement,
completion delivery, or retention cleanup. COT transport failures abandon only
the presentation. The automatic received/in-progress reaction lifecycle is
removed; the deliberate model-facing `react` tool and `addReaction` transport
surface remain.

Key source:

- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/channel/conversation-projection.ts`
- `/packages/dreamux/src/service/teammate-service/turn-coordinator.ts`
- `/packages/channel/feishu-channel/src/feishu-cot-adapter.ts`
- `/packages/channel/feishu-channel/src/feishu-cot-state.ts`
- `/packages/channel/feishu-channel/src/feishu-cot-session.ts`
- `/packages/channel/feishu-channel/src/feishu-cot-events.ts`
- `/packages/channel/feishu-channel/src/feishu-cot-outbox.ts`
- `/packages/channel/feishu-channel/src/feishu-cot-io.ts`
- `/packages/channel/feishu-transport/src/transport/cot.ts`

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
For topic collaboration provisioning, Feishu also records the triggering inbound
`message_id` in the normalized topic target `meta`. Core persists that opaque
metadata in the initial `ProvisionedTargetRecord`, restores it through
`targetFromRecord()`, and persists it into the resulting `ChannelBinding`. This
preserves the reply anchor across the crash window between durable target claim
and route write. Legacy records without the metadata restore an empty `meta`
object; the Feishu notification path skips malformed topic endpoints with a
warning instead of sending a topic notification to the group root. The provider
does not claim topic-created or topic-closed lifecycle support; provisioning
begins on first accepted topic inbound.

The built-in Feishu session subscribes to `binding.route` and
`binding.collaboration_space` from its dispatcher-wide core event source and
ignores events whose endpoint provider is not `builtin:feishu`. Delivery is
best-effort and live-session-only. Each notification runs independently, retries
one failed attempt once, and has no ordering guarantee relative to another
notification. Session close aborts in-flight notification work before closing
the bot, so a hung card request cannot hold dispatcher shutdown.
`FeishuTransport.sendCard` accepts a caller-owned `AbortSignal` and forwards it
through the SDK client's cancellable HTTP request path. A live notification
timeout aborts that attempt before the immediate retry. Cancellation cannot
retract a request already accepted by Feishu, so retry can duplicate a remotely
accepted card. Route topic cards
reply to the persisted triggering `message_id`; route group cards send to the
group;
collaboration-space cards always send a fresh top-level card to the container
chat, which creates a new topic in a Feishu topic group. Cards use Feishu
`plain_text` elements only and render display fields, Team facts, runtime cwd,
and repository/workspace policy without rendering raw provider `meta`,
`claim_id`, prompts, or raw errors.

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
- `/packages/channel/feishu-channel/src/feishu-binding-notification-card.ts`
- `/packages/channel/feishu-channel/src/feishu-target-router.ts`
- `/packages/channel/feishu-channel/src/feishu-channel.ts`
- `/packages/channel/feishu-channel/src/provider.ts`

## Feishu Domain Contracts

Current cross-cutting Feishu contracts live in domain docs:

- [Feishu introduce](../domains/feishu-introduce.md)
- [Feishu pairing access](../domains/feishu-pairing-access.md)
- [Non-blocking dispatcher inbound](../domains/non-blocking-dispatcher-inbound.md)

Use those pages for `/introduce`, trusted bot context, COT progress display,
pairing-token gate rules, Owner-only approval card semantics, and Codex
`turn/start` folding details.

## Decision Trail

- [Channel-scoped collaboration and core events](../decisions/channel-scoped-collaboration-and-core-events.md)
- [Feishu COT conversation display](../decisions/feishu-cot-conversation-display.md)
- [Feishu binding notification events](../decisions/feishu-binding-notification-events.md)
- [NPM package split and channel targets](../decisions/npm-package-split-and-channel-targets.md)
- [Provider architecture realignment](../decisions/provider-architecture-realignment.md)
- [Channel provider](../decisions/channel-provider.md)
- [Channel input runtime assembly](../decisions/channel-input-runtime-assembly.md)
- [Feishu inbound attachments](../decisions/feishu-inbound-attachments.md)
- [Feishu pairing access v3](../decisions/feishu-pairing-access-v3.md)
- [Feishu trusted allow-chats semantics](../decisions/feishu-allow-chats-trust-semantics.md)
- Archived background:
  [plugin/provider architecture proposal](../archive/proposals/plugin-provider-architecture.md)
