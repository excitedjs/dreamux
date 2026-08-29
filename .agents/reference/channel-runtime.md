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

The Feishu package owns its tool names and JSON schemas. The current surface is
caller-scoped:

- messaging (both callers): `reply`, `react`, `list_chat_bots`
- Dispatcher routing: `bind_channel`, `unbind_channel`, `list_bindings`
- TeamLeader routing: `bind_channel`, `unbind_channel`, each with no team field
- Dispatcher Collaboration Space: `bind_collaboration_space`,
  `unbind_collaboration_space`, `get_collaboration_space`,
  `list_collaboration_spaces`

A name appearing twice with different authority is the authorization model, not
a duplicate: Core asks the provider what this caller may see, freezes the answer
for one runtime generation, and admits only names in it.

Each provider descriptor carries a name, optional presentation metadata,
mandatory input schema, optional output schema, and standard annotations. The
neutral contract in `@excitedjs/dreamux-types` has no MCP SDK dependency. Core
validates the complete catalog — unique names, JSON-safe shape, SDK-compilable
schemas — and a tool whose handler does not exist is never advertised.

The channel's MCP server is the same in-server delegate contract every internal
domain implements; nothing in the lease registry, the transport Commands, the
descriptor, or the shim knows a Channel exists. A call reaches the created
instance's MCP capability, carrying the scope Core baked into the lease
(`dispatcher_id`, `channel_id`, and the caller). Core names no Feishu tool,
inspects no result field, and runs no egress gate of its own. There is no
sessionless Feishu tool: the capability is taken from the built instance, which
exists from creation rather than from connection.

The built-in Feishu provider supplies closed input and output schemas for every
tool. Successful results are canonical values: `reply` returns
`{ message_ids: string[] }`, `react` returns `{ reaction_id: string }`, and
`list_chat_bots` returns `{ chat_id, known, trusted }`. The shared server
exposes the value unchanged as `structuredContent` with exact `content: []` and
validates it against the provider output schema.

Key source:

- `/packages/channel/feishu-channel/src/tools/registry.ts`
- `/packages/channel/feishu-channel/src/tools/messaging-tools.ts`
- `/packages/channel/feishu-channel/src/tools/routing-tools.ts`
- `/packages/channel/feishu-channel/src/tools/space-tools.ts`
- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/mcp/server.ts`
- `/packages/dreamux/src/service/channel-service/mcp-delegate.ts`
- `/packages/dreamux/src/service/mcp/`

## Channel Targets And Routing

A target does not cross the seam. The neutral contract publishes no
`ChannelTarget`: Core never sees a chat id, a thread id, or a target key, holds
no binding table, and makes no routing decision.

Feishu normalizes its own selectors into a package-local `FeishuTarget` — a p2p
chat, an ordinary group, or one topic inside a topic group — and derives a
stable `targetKey` from it. A p2p chat is deliberately not bindable: it is one
person's conversation with the bot, and binding it would route somebody's DM
into a shared Team without them being told.

Routing is one small service over the Channel's own document. Every read is
synchronous against the last committed document, and every write is a commit, so
a caller told a route exists is being told what disk says. A topic resolves
through a two-step chain — the exact topic row first, then its enclosing group
row — and an ordinary group resolves only to itself. The plan is one of three
answers: `bound` (with the row that answered, which may be the parent group),
`provision` (the committed Collaboration Space policy snapshot to create a Team
under), or `dispatcher` (`no_binding` or `not_bindable`).

Binding tools are the Channel's, not Team MCP's. Team MCP has no `bind_channel`
and no `transfer_back`; rebinding is `bind_channel` with a different
`team_name`, and the previous owner is reported back. The Dispatcher's copies
take a `team_name` and may move any route; a TeamLeader's copies have no team
field at all and reach only routes that are free or already its own.

Key source:

- `/packages/channel/feishu-channel/src/routing/`
- `/packages/channel/feishu-channel/src/feishu-target-router.ts`
- `/packages/channel/feishu-channel/src/tools/routing-tools.ts`
- `/packages/dreamux/src/service/channel-service/`
- `/packages/dreamux-types/src/channel.ts`

## Collaboration Spaces

A Collaboration Space is a Channel product flow, not a Core entity. Core has no
Collaboration Space service, no space store, and no `collaboration_space`
Command namespace; the operator config no longer accepts a
`collaborationSpace` block, and a leftover one is a loud config error.

For Feishu a Space is a registered topic group whose child topics are
provisioned automatically. Its four Dispatcher-only tools —
`bind_collaboration_space`, `unbind_collaboration_space`,
`get_collaboration_space`, `list_collaboration_spaces` — register an existing
external container with a creation policy (leader runtime, optional identity,
optional repository) and read it back. They do not create the external
container, and unbinding releases routing and provisioning ownership without
deleting the container or dissolving Teams already provisioned under it.

Policy and installed bindings share one document, because they are one
consistency domain: a space policy is what entitles a binding to be installed,
and a Team closing removes the bindings that named it. A policy `generation`
advances when the policy is rebound with different creation facts; it cancels
nothing — a creation already under way keeps the snapshot it captured, and only
a creation that starts afterwards sees the new one.

Provisioning is process-local by design. It runs as an in-memory sequence and
persists nothing until the binding is actually installed: no saga, phase,
outbox, or recovery cursor. Losing the process loses the unfinished operation,
and a restart recovers only the already-persisted Team records, Space policies,
and completed bindings, with no resume scan. A Team created but never bound
stays as an accepted orphan; a first message not submitted before the crash is
lost, and a later message follows the still-persisted policy normally. What
Core sees is only `team.create` and `team.submit`.

Key source:

- `/packages/channel/feishu-channel/src/feishu-provisioning.ts`
- `/packages/channel/feishu-channel/src/routing/document.ts`
- `/packages/channel/feishu-channel/src/tools/space-tools.ts`
- `/packages/dreamux/src/config/config.ts`
- `/packages/dreamux/src/service/legacy-state.ts`

## Dispatcher-Scoped Core Events

Each `DispatcherService` owns one in-process `DispatcherCoreEventBus`. It is a
best-effort distribution helper, not a fact owner or store. Existing owners
publish after their normal write point:

- `TeamStore` publishes Team status and concrete leader changes;
- `AgentIdentityStore` publishes TeamLeader and TeamMate status changes;
- the conversation projection publishes display-only turn lifecycle and
  activity facts for the dispatcher agent and TeamLeaders.

Routing produces no core event. A Channel already owns its routing records, so
it describes its own state from them at the moment it changes them; Core
publishing a binding fact back would mean Core holding one.

A Channel session receives one read-only `ChannelEventSource` with a single
`subscribe(listener)` and an idempotent `unsubscribe()`. One subscription
receives the whole `ChannelCoreEvent` union and demultiplexes inside the
Channel, so adding an event changes only that catalog and its consumers. The
union is Team state, TeamMate state, and the four turn facts `turn.submitted`,
`turn.message`, `turn.tool_call`, and `turn.settled`. Workflow, scheduler,
routing, and host-maintenance events are deliberately absent.

Turn events expose one process-local `turn_id` for presentation correlation but
no runtime-native Turn object or transcript. Conversation events may contain
bounded, redacted user/assistant display text and bounded tool
arguments/results; other events contain no prompt or assistant text. No event
contains native transcript paths, raw errors, or platform user identity.

Delivery is live and best-effort: Core invokes listeners in publication order
without awaiting them, and a listener's exception or rejection never escapes
into admission or settlement. There is no FIFO, backpressure, timeout,
acknowledgement, retry, replay, snapshot, or final-delivery guarantee. A
listener keeps its synchronous projection bounded; a reaction needing
asynchronous persistence fences its in-memory authority synchronously and
serializes the durable write on a Channel-owned mutation tail that
`ChannelSession.close` awaits.

Core installs the source during `initialize`, before `start` opens external
input, which is what makes subscribe-before-admission provable. Stop and
start-failure cleanup revoke the whole session source before closing the
session; later subscription attempts fail and old handles become no-ops.

Key source:

- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/service/dispatcher-core-events/`
- `/packages/dreamux/src/service/agent-entity/identity-store.ts`
- `/packages/dreamux/src/service/team-collection/store.ts`
- `/packages/dreamux/src/service/channel-service/index.ts`
- `/packages/dreamux/src/channel/conversation-projection.ts`
- `/packages/dreamux/src/service/teammate-service/turn-coordinator.ts`
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

The built-in Feishu provider resolves first-inbound topic routing entirely
inside the package. After the access gate accepts an inbound, the provider uses
`message.thread_id` as the stable target key and verifies the enclosing chat
through `im.v1.chat.get`. Only `chat_mode=topic` produces a topic target and a
container chat id that a Collaboration Space policy could be registered on;
`root_id` and `parent_id` remain diagnostic ancestry and never substitute for a
missing `thread_id`.

Resolution is the Channel's own two-step chain: the exact topic row first, then
its enclosing group row, and an ordinary group resolves only to itself. If no row
answers, a registered Space policy on the container turns the message into a
provisioning run; otherwise the message reaches the Dispatcher Agent. This
preserves pre-topic group bindings without letting them preempt an explicit
topic binding. Core is told a `team_name` or nothing at all, and derives no part
of this.

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
Provisioning holds no durable record and needs no crash-window anchor. It is
composed from two generic Core Commands — `team.create`, then `team.submit` —
and Core is never told that a Space exists or that a topic is a child of a
group. A run that fails before it invokes `team.submit` answers `unsubmitted`
and the message it was carrying goes to the Dispatcher Agent like any other
message this Channel could not hand to a Team: failing to provision is not a
reason to drop what somebody wrote. The provider claims no topic-created or
topic-closed lifecycle support; provisioning begins on first accepted topic
inbound.

Routing notification cards are rendered from this Channel's own records, at the
moment this Channel changes them, and no Core event is involved — Core publishes
no binding fact, because it holds none. Delivery is best-effort and
live-session-only. Each notification runs independently, retries one failed
attempt once, and has no ordering guarantee relative to another notification. Session close aborts in-flight notification work before closing
the bot, so a hung card request cannot hold dispatcher shutdown.
`FeishuTransport.sendCard` accepts a caller-owned `AbortSignal` and forwards it
through the SDK client's cancellable HTTP request path. A live notification
timeout aborts that attempt before the immediate retry. Cancellation cannot
retract a request already accepted by Feishu, so retry can duplicate a remotely
accepted card. Route topic cards
reply to the persisted triggering `message_id`; route group cards send to the
group;
Collaboration Space cards always send a fresh top-level card to the container
chat, which creates a new topic in a Feishu topic group. Cards use Feishu
`plain_text` elements only and render display fields, Team facts, and the
Space's own policy without rendering prompts or raw errors.

Key source:

- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/channel/feishu-channel/src/routing/`
- `/packages/channel/feishu-channel/src/feishu-provisioning.ts`
- `/packages/channel/feishu-channel/src/feishu-inbound-anchor.ts`
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
