# Built-in Feishu Channel

What: how `builtin:feishu` implements the neutral
[Channel mechanism](index.md): Feishu targets, routing, Collaboration Spaces,
inbound content, access, tools, and conversation display.

Read this before changing the built-in Feishu provider, transport, routing or
Collaboration Space state, inbound normalization, or Feishu presentation.

## Ownership

The built-in provider lives outside the host package:

- package: `@excitedjs/feishu-channel`
- provider ref: `builtin:feishu`
- source: `/packages/channel/feishu-channel/`

The Feishu package depends on `@excitedjs/dreamux-types` and
`@excitedjs/feishu-transport`; it must not import `@excitedjs/dreamux`. The
transport package is the sole owner of the Lark SDK and raw Feishu platform I/O:
it parses events and exposes narrow request wrappers, while the channel package
decides when those calls are allowed.

`@excitedjs/feishu-channel` owns Feishu policy and behavior: target resolution,
access decisions, inbound normalization, tools, routing state, Collaboration
Spaces, and presentation. Its routing document is the provider-owned durable
state supplied through Core's per-dispatcher state root.

Source:

- `/packages/channel/feishu-channel/src/provider.ts`
- `/packages/channel/feishu-transport/src/transport/feishu.ts`
- `/packages/dreamux/tests/package-boundary-guards.test.ts`

## Contracts

### Session

The Feishu session owns long-connection event handling through `FeishuBot`,
access and mention gating, `/introduce` trust changes, known/trusted peer-bot
state, inbound formatting and attachment normalization, channel-owned
conversation display state, and the Feishu MCP tool backing.
It implements the lifecycle and uses the `ChannelCorePort` described by the
[neutral Channel contract](index.md#instances-and-sessions).

Source:

- `/packages/channel/feishu-channel/src/feishu-channel.ts`
- `/packages/channel/feishu-channel/src/bot.ts`
- `/packages/channel/feishu-transport/`

### Provider tools and MCP

The Feishu package owns its tool names and JSON schemas. Twelve definitions are
registered, and the served surface is caller-scoped:

- messaging (both callers): `reply`, `react`, `list_chat_bots`
- Dispatcher routing: `bind_channel`, `unbind_channel`, `list_bindings`
- TeamLeader routing: `bind_channel`, `unbind_channel`, each with no team field
- Dispatcher Collaboration Space: `bind_collaboration_space`,
  `unbind_collaboration_space`, `get_collaboration_space`,
  `list_collaboration_spaces`

A name appearing twice with different authority is the authorization model, not
a duplicate. The provider returns the caller-scoped definitions through the
[neutral MCP capability](index.md#provider-tools-and-mcp); it does not expose one
definition that branches on caller identity.

The built-in provider supplies closed input and output schemas for every tool.
Successful results are canonical values: `reply` returns
`{ message_ids: string[] }`, `react` returns `{ reaction_id: string }`, and
`list_chat_bots` returns `{ chat_id, known, trusted }`. The shared server exposes
the value unchanged as `structuredContent` with exact `content: []` and validates
it against the provider output schema.

Source:

- `/packages/channel/feishu-channel/src/tools/registry.ts`
- `/packages/channel/feishu-channel/src/tools/messaging-tools.ts`
- `/packages/channel/feishu-channel/src/tools/routing-tools.ts`
- `/packages/channel/feishu-channel/src/tools/space-tools.ts`

### Targets and chat-mode discovery

Feishu targets remain behind the
[neutral Channel seam](index.md#targets-routing-and-inbound-submission); Core
never sees them.

Feishu normalizes its own selectors into a package-local `FeishuTarget` with
three kinds, because Feishu has three: `p2p` (a direct chat), `group` (an
ordinary group), and `topic` (one topic inside a topic-mode group). A topic is
the only kind with a parent. `targetKey` is injective over the three kinds
because a chat id cannot contain `\0`. A `p2p` target is deliberately not
bindable: it is one person's conversation with the bot, and binding it would
route somebody's direct messages into a shared Team without them being told. It
still talks to the Dispatcher Agent, as an unbound conversation always has.

The resolution chain is one level deep: a topic resolves to itself and then to
its enclosing group and stops; an ordinary group resolves only to itself. There
is no chain to walk and no inherited binding beyond the conversation the message
is visibly in.

Topic detection needs one platform lookup, so it is bounded and fails open. The
router uses `message.thread_id` as the stable topic key and verifies the
enclosing chat through `im.v1.chat.get`, bounded to 2,000 ms. Only
`chat_mode=topic` produces a topic target and a container chat id a Collaboration
Space policy could be registered on. Missing group-information permission, a
missing or unknown chat mode, a timeout, and an API failure each warn in the
channel log and fall back to the group route. Operators using Feishu topic
collaboration must grant the bot a group information read permission accepted by
the chat-get API, such as `im:chat:readonly`.

Cache and concurrency are precise, and the two ledgers are not the same shape:

- successfully resolved chat modes are cached for the life of the session, with
  no eviction; unsuccessful lookups are not cached at all, so a later accepted
  inbound retries;
- concurrent lookups for one chat share a single in-flight request, which is
  removed once it settles;
- the observed-message ledger is bounded at 4,096 entries and evicts the oldest;
  it and the per-target anchor ledger are display and addressing aids, never
  authority.

Target projection runs only for an accepted inbound: the access and pairing gate
decides first, so a rejected or gate-consumed message reaches no chat API call
and writes no ledger entry.

Source:

- `/packages/channel/feishu-channel/src/routing/target.ts`
- `/packages/channel/feishu-channel/src/feishu-target-router.ts`
- `/packages/channel/feishu-channel/src/feishu-session-inbound.ts`

### Inbound routing

Routing is one small service over the Channel's own document. Every read is
synchronous against the last committed document, and every write is a commit, so
a caller told a route exists is being told what disk says. The plan is one of
three answers: `bound` (with the row that answered, which may be the parent
group), `provision` (the committed Collaboration Space policy snapshot to create
a Team under), or `dispatcher` (`no_binding` or `not_bindable`).

The Feishu Channel resolves its target, consults its bindings, and states the
recipient through the neutral submission contract:

- a resolved `team_name` reaches that Team's TeamLeader;
- omitting it reaches the Dispatcher Agent, which is the recipient for a
  conversation no binding or Collaboration Space claims.

Nothing about chats, threads, or topic mode crosses the seam. The returned
`turn_id` names the exact turn the call created, which lets Feishu claim the
matching submitted event as its own. The complete neutral contract is in
[Channel](index.md#targets-routing-and-inbound-submission).

Source:

- `/packages/channel/feishu-channel/src/routing/index.ts`
- `/packages/channel/feishu-channel/src/feishu-submit.ts`
- `/packages/channel/feishu-channel/src/feishu-channel.ts`
- `/packages/dreamux/src/service/team-collection/commands.ts`
- `/packages/dreamux/src/service/channel-submission.ts`
- `/packages/dreamux/src/service/submission-sources.ts`

### Inbound content fidelity

Before any content work, the Feishu session classifies raw chat/sender identity
once. Only `p2p | group` and exact `user | bot | app` senders with non-empty ids
proceed; unknown chat/sender shapes fail closed before access mutation, passive
bot observation, `/introduce`, pairing, or delivery.

Feishu content parsing and SDK ownership stay split across the two channel
packages. `@excitedjs/feishu-transport` parses event content once into ordered,
untrusted `text` / `code` / `resource` parts. That sequence is the internal source
of truth; the transport projects the legacy flat text and de-duplicated resource
views only at its public compatibility boundary. It also exposes narrow wrappers
around `im.v1.message.get`, message-resource download, and contact-backed
sender-name lookup. `@excitedjs/feishu-channel` decides when those calls are
allowed, validates reread roots against the already accepted event,
resolves/downloads resources, and owns the model-facing XML.

The access gate runs before any message read or resource fetch. Accepted
interactive cards use the structured and default read representations with a
deterministic visible-text union. `nonsupport` events may adopt a matching root's
authoritative type/content. Merged-forward messages deliberately perform no
current-message read or child-resource fetch. The Channel emits an empty
`<content />` plus `<refs><merged-forward message_id="..."/></refs>`. Actionable
reply/quote ancestry is likewise a `<reply-to>` reference with only the parent id
and a best-effort proven type; parent content is never injected. Channel content
does not name or prescribe a lookup tool or command.

Rich posts preserve Markdown/code, links, mentions, rules, and inline resource
positions. The Channel wraps visible content in `<content>`, renders each
resource occurrence once as an inline `<attachment>` at its original position,
and de-duplicates only the download/cache result and neutral runtime attachment.
Downloaded occurrences render exactly `<attachment path="..." />`. Non-downloaded
occurrences render exactly `<attachment status="not_downloaded" key="..." />`; a
missing Feishu key is an empty escaped value. The exported structured attachment
retains type/name/key/path/status/reason details, diagnostics retain the detailed
failure reason, and the neutral runtime attachment retains applicable
`kind`/`name`/`localPath` facts. Those facts are not repeated in the
model-visible XML. Code is Channel-owned `<code><![CDATA[...]]></code>` with safe
`]]>` splitting, so source operators remain literal without opening the
surrounding XML. Cards expose only visible labels/text/options and exclude
callback or hidden values. Audio and media map onto the existing file/image
resource ABI; stickers, shared entities, and future types receive explicit
bounded fallbacks instead of raw JSON.

Every accepted inbound owns a session-fenced enrichment context. Session close
revokes it before closing the transport and drains handlers that already started.
A Channel-owned bounded-operation primitive supplies the shared absolute-deadline,
abort, settle-once, and optional late-value-cleanup semantics. The lifecycle
context bounds the whole enrichment to 60 seconds; the attachment resolver
separately owns the 32-unique-resource, 25-MiB-per-resource, and
100-MiB-aggregate policy while retaining one sequential download, each resource
bounded to 20 seconds. The complete pre-reminder structured body is capped at
160,000 UTF-16 code units. The typed truncator charges XML wrappers, escaped
text, CDATA splits, refs, and optional trusted-bot context and always closes
Channel-owned structures. Untrusted text is escaped exactly once at the final
Channel boundary. After current-message enrichment, one optional two-second
parent read may add the bounded reply type; the returned parent body and children
are discarded.

Every Feishu SDK request on this path — enrichment, chat-mode discovery, and
conversation-display I/O alike — is bounded and session-fenced, so a hung request
cannot keep session close or dispatcher restart waiting, a late route result
cannot record a stale message target, and expired display work is reaped.

Sender names are best-effort and never gate delivery. Event-provided names win;
known/trusted bot state names bot senders without a contact call; and every
accepted unnamed human message makes one thin `contact.v3.user.get` attempt. The
Channel bounds that attempt to the lesser of 2,000 ms and the remaining inbound
budget and fences it with the current session lifecycle. The transport keeps no
positive/negative cache, in-flight de-duplication, per-user version, or
permission circuit. Feishu code `99991672`, any other nonzero response,
malformed/missing names, timeouts, and transient errors affect only the current
message, so the next accepted unnamed message queries Feishu again. Unknown names
are omitted. `create_time` is rendered in the process-local time zone as unpadded
`YYYY-M-d H:m:s`. The final concise Channel reminder permits a direct substantive
reply when no preliminary work is needed and asks for an acknowledgement only
before longer work.

Source:

- `/packages/channel/feishu-transport/src/parse/`
- `/packages/channel/feishu-transport/src/transport/message-read.ts`
- `/packages/channel/feishu-transport/src/transport/feishu.ts`
- `/packages/channel/feishu-channel/src/feishu-bounded-operation.ts`
- `/packages/channel/feishu-channel/src/feishu-inbound-enrichment.ts`
- `/packages/channel/feishu-channel/src/feishu-inbound-work.ts`
- `/packages/channel/feishu-channel/src/feishu-reply-ancestry.ts`
- `/packages/channel/feishu-channel/src/feishu-message.ts`
- `/packages/channel/feishu-channel/src/feishu-message-render.ts`
- `/packages/channel/feishu-channel/src/feishu-session-inbound.ts`

### Routing document

The Feishu document lives at
`~/.dreamux/state/<dispatcher-id>/feishu-routing.<channel-slug>.<digest>.json`,
one file per configured channel id, written `0600`. It holds two sections in one
consistency domain: `bindings[]`, the target routes actually installed, each
carrying its Team name, its `manual` or `space` origin, and its optional space
id; and `spaces[]`, the registered Collaboration Space policies with their
creation facts. A space policy is what entitles a binding to be installed, and a
Team closing removes the bindings that named it, so splitting the two would only
invent a cross-file transaction.

Work in flight is deliberately absent. Disk commit is the authority: every change
is queued on one tail, prepared on an isolated copy of the last committed
document, written atomically, and only then published, so what a caller reads is
what was persisted. A mutator reports whether anything really changed, so an
idempotent repeat costs no write and no false `updated_at` bump. Session close
drains the tail so no queued commit is abandoned.

There is no migration path. A malformed document, an unsupported version, a
foreign `channel_id`, or a missing section fails loud, and the operator recreates
the rows through `bind_channel` / `bind_collaboration_space`. Core's own removed
routing state is detected, not read: `channel-bindings.json` and
`collaboration-spaces.json` at the dispatcher root fail loud as old state.

Source:

- `/packages/channel/feishu-channel/src/routing/store.ts`
- `/packages/channel/feishu-channel/src/routing/document.ts`
- `/packages/dreamux/src/service/legacy-state.ts`

### Team binding and authorization

Binding a conversation to a Team is the Channel's own decision, made with that
Channel's own tools. Team MCP has no `bind_channel` and no `transfer_back`: only
Feishu knows what a chat, a topic, and a parent group are, so only Feishu can say
which of them a Team answers in. Rebinding is `bind_channel` with a different
`team_name`, and the previous owner is reported back.

Authorization is the caller-scoped catalog itself, not a check inside a shared
handler. `bind_channel` and `unbind_channel` are registered twice, once per caller
kind, with disjoint schemas:

- the Dispatcher's take a `team_name` and may move any route;
- the TeamLeader's have no team field at all — its Team is the one Core baked
  into the lease — and reach only routes that are free or already its own.

A TeamLeader therefore cannot address another Team, correctly or otherwise,
because the argument that would say so does not exist. Proving which external
platform identity created a target is out of scope on purpose: Core has no
neutral creator fact, and these create-only route semantics prevent target
takeover without inventing a provider-specific ownership model. A refusal says
only that the route belongs to someone else — which Team owns a route is a
Dispatcher read. `list_bindings` and every Collaboration Space tool stay
Dispatcher-only: the channel-wide routing table and Space policy are operator
work.

The order of a bind is a concurrency contract, not an implementation detail.
Target resolution from the selector, the bindability check, and the Core
`team.status` routability proof all complete **before** the routing commit is
queued, so no external call is ever in flight while the commit tail is held. The
commit mutator itself is synchronous and performs no external I/O. The
`requireOwner` precondition and the displaced-owner read are evaluated **inside**
the mutator, because a precondition read outside the commit is a precondition
about a document that has already moved on. Only after the commit does the
Channel fence the previous owner's presentation, release the fence for the new
one, and send the notification card.

Refusing to route to a Team that cannot answer is the one moment the question can
be asked: `team.status` is invoked before the row is written and before the
conversation is told, and only a definite answer refuses — `TEAM_NOT_FOUND`,
`TEAM_CLOSED`, or a `closed` status. A Team that dissolves afterwards converges
through the `team.state` event instead.

What Core owns is the lease scope. Every Channel MCP call carries a
`ChannelMcpCallContext` of `dispatcher_id`, `channel_id`, and the caller
(`dispatcher`, or `team_leader` with its `team_name` and `leader_name`), baked in
when the runtime's catalog was frozen. Routing identity is never part of the
model-facing tool schema, so a runtime cannot name a scope it was not given.

Source:

- `/packages/channel/feishu-channel/src/feishu-session-bindings.ts`
- `/packages/channel/feishu-channel/src/routing/index.ts`
- `/packages/channel/feishu-channel/src/routing/store.ts`
- `/packages/channel/feishu-channel/src/tools/routing-tools.ts`
- `/packages/channel/feishu-channel/src/tools/registry.ts`
- `/packages/dreamux/src/service/channel-service/mcp-delegate.ts`
- `/packages/dreamux/src/service/team-collection/mcp-delegate.ts`

### Collaboration Spaces and provisioning

A Collaboration Space is a Channel product flow, not a Core entity. Core has no
Collaboration Space service, no space store, and no `collaboration_space` Command
namespace; the operator config no longer accepts a `collaborationSpace` block,
and a leftover one is a loud config error.

For Feishu a Space is a registered topic group whose child topics are provisioned
automatically. Its four Dispatcher-only tools register an existing external
container with a creation policy (leader runtime, optional identity, optional
repository) and read it back. They do not create the external container, and
unbinding releases routing and provisioning ownership without deleting the
container or dissolving Teams already provisioned under it; dissolving one of
those is an ordinary `team.dissolve`.

Provisioning is process-local by design. It runs as an in-memory sequence and
persists nothing until the binding is actually installed: no saga, phase, outbox,
or recovery cursor. Losing the process loses the unfinished operation, and a
restart recovers only the already-persisted Team records, Space policies, and
completed bindings, with no resume scan. What Core sees is only `team.create` and
`team.submit`; it is never told that a Space exists or that a topic is a child of
a group. The provider claims no topic-created or topic-closed lifecycle support;
provisioning begins on first accepted topic inbound.

The run order is the one that degrades honestly — create the Team, commit the
route, announce it, deliver the message — and every exit before `team.submit`
answers `unsubmitted`, so the message it was carrying goes to the Dispatcher
Agent like any other message this Channel could not hand to a Team. Failing to
provision is not a reason to drop what somebody wrote. A failure after
`team.create` leaves an ordinary Team nothing routes to: an accepted orphan an
operator can see and use, deliberately not compensated.

Idempotency comes from one choice with several consequences: the `team.create`
`request_id` is the inbound message id, used bare.

- The platform redelivering one message replays that id, so Core's `team.create`
  idempotency answers with the Team the first attempt made instead of building a
  second one. If the first attempt died between `team.create` and the routing
  bind, the replay answers `existing` and the run installs the binding, which
  recovers half-finished provisioning rather than duplicating it.
- A new message always mints a new id, so after a Team is dissolved the next
  message to that topic provisions a fresh Team. A thread-scoped id could not:
  Core keeps a request's acceptance record permanently, so it would replay
  `closed` forever and the topic could never be provisioned again. A replay whose
  Team has since closed is reported `unsubmitted` and falls back to the
  Dispatcher Agent.
- The cost of message scope is that a *different* message arriving after a
  partial failure creates a second Team. That window is knowingly left
  undefended: closing it needs durable per-target request state this design has
  declined to keep.
- A redelivered id whose policy snapshot changed in between hashes differently,
  so Core raises an idempotency conflict, the run reports `unsubmitted`, and the
  message falls back to the Dispatcher Agent.

Concurrent messages to the same new topic share one in-flight run keyed by target:
the first supplies the first delivery, and the rest wait for the binding and are
then submitted through the route it installed. That process-local map is the only
thing that prevents two Teams for one topic, and it is enough, because a process
that dies mid-run leaves no Team the next process could duplicate a route for. A
waiter that finds no installed route answers `unsubmitted`.

A policy `generation` advances when the policy is rebound with different creation
facts; it cancels nothing — a creation already under way keeps the snapshot it
captured, and only a creation that starts afterwards sees the new one.

Source:

- `/packages/channel/feishu-channel/src/feishu-provisioning.ts`
- `/packages/channel/feishu-channel/src/routing/document.ts`
- `/packages/channel/feishu-channel/src/routing/index.ts`
- `/packages/channel/feishu-channel/src/routing/naming.ts`
- `/packages/channel/feishu-channel/src/tools/space-tools.ts`
- `/packages/dreamux/src/config/config.ts`
- `/packages/dreamux/src/service/legacy-state.ts`

### Routing notification cards

Routing notification cards are rendered from this Channel's own records, at the
moment this Channel changes them, and no Core event is involved — Core publishes
no binding fact, because it holds none.

There are four renderers, and their field sets are the content contract:

- **route bound** (manual bind, or an automatic provisioning announcement):
  target display, binding kind (topic or group), Team name, and the space name
  when the row was installed for a Space;
- **route unbound** (manual unbind, and every route a closing Team gives up):
  target display, Team name, and a status line;
- **space bound**: space name, container group display, TeamLeader runtime, the
  workspace — which renders the configured repository path when the policy has
  one — base ref, and a note that new topics get their own Team;
- **space unbound**: space name, container group display, and a status line
  saying provisioning stopped while existing Teams and bindings are unchanged.

Cards use Feishu `plain_text` elements only and render display fields, Team
facts, and the Space's own policy without rendering prompts or raw errors. The
repository path is deliberately visible to the members of the bound conversation;
the user-visible half of that disclosure is
[`/.agents/product/README.md`](/.agents/product/README.md).

Where a card goes follows the target. A route card for a topic replies under the
newest message this session has seen in that topic, and falls back to the parent
chat when it has seen none — the operator who just bound it is in that chat. A
route card for a group is sent to the group. Collaboration Space cards always
send a fresh top-level card to the container chat, which in a Feishu topic group
creates a new topic.

Delivery is best-effort and live-session-only. The send is never awaited by the
operation that caused it, so a card that does not arrive leaves the routing
change committed, which is the fact that mattered. Each notification runs
independently with no ordering guarantee relative to another, is bounded to 20
seconds, and retries one failed attempt exactly once. A stale session fence stops
it before the first attempt and before the retry. `FeishuTransport.sendCard`
accepts a caller-owned `AbortSignal` and forwards it through the SDK client's
cancellable HTTP request path, and session close aborts in-flight notification
work before closing the bot, so a hung card request cannot hold dispatcher
shutdown. Cancellation cannot retract a request already accepted by Feishu, so a
retry can duplicate a remotely accepted card.

A successfully sent card is also observed into the message ledger, which makes it
an address this Channel can reply into later and, for a bind, the fallback anchor
for that Team's first conversation card.

Source:

- `/packages/channel/feishu-channel/src/feishu-binding-notification-card.ts`
- `/packages/channel/feishu-channel/src/feishu-session-bindings.ts`
- `/packages/channel/feishu-channel/src/feishu-channel.ts`
- `/packages/channel/feishu-channel/src/feishu-target-router.ts`
- `/packages/channel/feishu-transport/src/transport/feishu.ts`

### Feishu conversation display

The Feishu session consumes the
[dispatcher-scoped Core event source](index.md#dispatcher-scoped-core-events)
through `feishu-cot-adapter`. It owns card
anchoring, event-to-card projection, bounded outbox batching, serialized I/O, and
diagnostics. An inbound card is pinned to that turn's message. For a TeamLeader,
each successfully created Reply message is observed synchronously and fail-open;
its same-target receipt may anchor the next card, while the team-group binding
notification is the fallback before any inbound exists. A receipt cannot recreate
missing leader state or cross the current conversation target: the chat, target
type, and target key must all match, so topic groups also stay within the same
topic thread. A delayed notification commits its fallback only if the endpoint
still routes to the same Team and leader.

Late submitted and fallback anchors consult two bounded fences: a leader-wide
fence set by Team close and endpoint-scoped route fences set by unbind or
replacement, each retaining at most 512 entries. Team starting/running clears both
kinds for that leader, while a matching re-bind clears its endpoint route fence.
Re-anchor, unbind, replacement, Team close, and session close therefore fence late
callbacks without disabling another live endpoint. Fence matching and route-driven
interruption use the anchor's authoritative binding endpoint, not its visible
target fallbacks. TeamLeaders keep one active presentation and settle it only on a
matching `turn_id`. Dispatcher presentation state is keyed by agent, chat, and
turn, so concurrent chats and interleaved turns cannot steal or close each other's
cards; a foreign `channel_origin` is a strict no-op. These next/fallback anchor
mechanics are TeamLeader-only and do not apply to dispatchers. Feishu ignores
Team-member events explicitly; it never routes them through the leader state
machine. Leader message and tool activity must also match the state's single
admitted `turn_id`, preventing a fence-rejected or superseded turn from opening or
appending to another endpoint's card.

The Core projection's early-activity buffer and projected activity-id set each
retain at most 512 facts per submission and drop newest with one warning. Feishu
retains at most
512 dispatcher conversations, 512 dispatcher turns per session, and 64 turns per
chat, again refusing newest work without partial index state. Card I/O has a
20-second operation deadline so settled draining state is eventually reaped.

The whole path is display-only and fail-open. Projection publisher, sanitizer,
identity, and logger failures cannot change runtime admission, settlement,
completion delivery, or retention cleanup. Card transport failures abandon only
the presentation. The automatic received/in-progress reaction lifecycle is
removed; the deliberate model-facing `react` tool and `addReaction` transport
surface remain.

Source:

- `/packages/dreamux/src/channel/conversation-projection.ts`
- `/packages/dreamux/src/service/teammate-service/turn-coordinator.ts`
- `/packages/channel/feishu-channel/src/feishu-cot-adapter.ts`
- `/packages/channel/feishu-channel/src/feishu-cot-state.ts`
- `/packages/channel/feishu-channel/src/feishu-cot-session.ts`
- `/packages/channel/feishu-channel/src/feishu-cot-events.ts`
- `/packages/channel/feishu-channel/src/feishu-cot-outbox.ts`
- `/packages/channel/feishu-channel/src/feishu-cot-io.ts`
- `/packages/channel/feishu-transport/src/transport/cot.ts`

### Feishu access contracts

The Feishu session classifies raw chat/sender identity before routing or trust
side effects, and current V3 `group.allow_chats` semantics trust exact human
members of a listed group under either non-block policy after the one global
mention gate. Those rules, the pairing-token gate, Owner-only approval card
semantics, and the `/introduce` authority split are owned elsewhere:

- [Feishu pairing access](../feishu-pairing-access.md)
- [Feishu introduce](../feishu-pairing-access.md)
- [Non-blocking dispatcher inbound](../non-blocking-dispatcher-inbound.md)

## Invariants

- A `p2p` target is never bindable.
- Every routing ownership precondition is enforced inside the commit that
  persists it, and no external call is in flight while the commit tail is held.
- Nothing durable exists for provisioning work in flight.
- Chat-mode lookup failures and unknown modes are not cached; later accepted
  inbound retries.
- Automatic received/in-progress reactions remain absent; the explicit `react`
  tool is the only reaction surface.

## Regression Traps

### `thread_id` is the only topic key

Feishu topic routing keys on `message.thread_id` and nothing else. `root_id` and
`parent_id` remain diagnostic reply ancestry and must never independently enable
topic routing or substitute for a missing `thread_id`: an ordinary group stays a
group target even when Feishu exposes thread-style messages inside it, and every
non-empty inbound `thread_id` is included in the opaque display attrs rendered
into the model-visible `<channel>` envelope without acquiring a topic container or
topic routing semantics.

The egress side follows the same rule from the other direction. TeamLeader egress
resolution uses the observed-message ledger, rejects conflicting chat/thread
selectors, and authorizes message ownership against the exact topic rather than
the enclosing chat; reply execution uses Feishu's source-message reply API, which
preserves the authorized topic. After exact ownership succeeds a TeamLeader may
also be authorized by the target's explicit group binding fallback, so a
group-bound leader can reply to observed topic messages while a leader bound only
to another topic stays out of scope. Standalone `thread_id` selectors are rejected
because Feishu does not expose them as a safe send-to-topic primitive on this
transport seam.

Source:

- `/packages/channel/feishu-channel/src/feishu-target-router.ts`
- `/packages/channel/feishu-channel/src/feishu-inbound-anchor.ts`
- `/packages/channel/feishu-transport/src/parse/content.ts`

History: [/.agents/tasks/channel/README.md](/.agents/tasks/channel/README.md)
