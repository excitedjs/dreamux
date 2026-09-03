# Channel

What: how a Channel provider reaches Dreamux core, and how the built-in Feishu
provider owns targets, routing, Collaboration Spaces, inbound content, and
conversation display.

Read this before changing Channel provider contracts, the Channel MCP delegate,
Channel-owned routing or Collaboration Space state, inbound recipient
selection, or the Core event source a Channel subscribes to.

## Ownership

A Channel provider owns platform I/O, inbound normalization, target resolution,
provider-specific tools, message ownership facts, and **routing**: which
conversation reaches which Team, and what a Collaboration Space is. Dreamux core
owns Channel session lifetime, the Command port a Channel invokes, the scoped
Core event source it subscribes to, and generic MCP forwarding. Core holds no
binding table, no target model, and no Collaboration Space container.

The built-in Feishu provider lives outside the host package:

- package: `@excitedjs/feishu-channel`
- provider ref: `builtin:feishu`
- source: `/packages/channel/feishu-channel/`

Core loads it through the same registry/catalog shape as an external Channel
provider. The Feishu package depends on `@excitedjs/dreamux-types` and
`@excitedjs/feishu-transport`; it must not import `@excitedjs/dreamux`. The
transport package is the sole owner of the Lark SDK and raw Feishu platform I/O:
it parses events and exposes narrow request wrappers, while the channel package
decides when those calls are allowed.

Routing state is Channel-owned durable state. Core supplies a per-dispatcher
state root and nothing else — the filename, the schema, and what counts as a
valid document belong to the Channel.

Source:

- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/channel/catalog.ts`
- `/packages/dreamux/src/channel/external-channel-provider.ts`
- `/packages/dreamux/src/registry/`
- `/packages/channel/feishu-channel/src/provider.ts`
- `/packages/channel/feishu-transport/src/transport/feishu.ts`
- `/packages/dreamux/tests/package-boundary-guards.test.ts`

## Contracts

### Channel sessions

Each live dispatcher builds one `ChannelInstance` per configured channel and
holds it by dispatcher-local `channel_id`. The first configured channel is the
primary/default egress channel. `ChannelService` builds, holds, hands out, and
closes those instances and nothing else.

`ChannelSession` is the direct, same-process lifecycle: `initialize(port)` loads
and validates Channel-owned state and attaches event consumers but must not open
external input, `start()` opens external I/O, and `close()` stops it and awaits
the Channel-owned mutation tail. That split is what makes
subscribe-before-admission provable.

For Feishu, the session owns long-connection event handling through `FeishuBot`,
access and mention gating, `/introduce` trust changes, known/trusted peer-bot
state, inbound formatting and attachment normalization, channel-owned
conversation display state, and the Feishu MCP tool backing.

Everything a Channel reaches Core through is the `ChannelCorePort`: the shared
Command invoker and one read-only, dispatcher-scoped event source. A Channel
names a Command, hands it a payload, and gets one answer; both public adapters
bind the same registry, so a Channel gets no smaller catalog and no private door.

Source:

- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/channel-service/index.ts`
- `/packages/channel/feishu-channel/src/feishu-channel.ts`
- `/packages/channel/feishu-channel/src/bot.ts`
- `/packages/channel/feishu-transport/`

### Provider tools and MCP

The Feishu package owns its tool names and JSON schemas. Thirteen definitions
are registered, and the served surface is caller-scoped:

- messaging (both callers): `reply`, `react`, `list_chat_bots`,
  `ask_user_question`
- Dispatcher routing: `bind_channel`, `unbind_channel`, `list_bindings`
- TeamLeader routing: `bind_channel`, `unbind_channel`, each with no team field
- Dispatcher Collaboration Space: `bind_collaboration_space`,
  `unbind_collaboration_space`, `get_collaboration_space`,
  `list_collaboration_spaces`

A name appearing twice with different authority is the authorization model, not
a duplicate: Core asks the provider's `ChannelMcpCapability` to `describe` a
catalog per caller, freezes the answer for one runtime generation, and admits
only names in it. Core asks only when constructing a Dispatcher or TeamLeader
runtime, and resolving a call re-uses the caller, so the served definition is
identical to the advertised one rather than one definition branching on who
called it.

Each provider descriptor carries a name, optional presentation metadata,
mandatory input schema, optional output schema, standard annotations, and
optional icon metadata. The neutral contract in `@excitedjs/dreamux-types` has no
MCP SDK dependency. Core validates the complete catalog — unique names,
JSON-safe shape, SDK-compilable schemas — and a tool whose handler does not exist
is never advertised rather than advertised and then failed at invocation.

The channel's MCP server is the same in-server delegate contract every internal
domain implements; nothing in the lease registry, the transport Commands, the
descriptor, or the shim knows a Channel exists. A call reaches the created
instance's MCP capability, carrying the scope Core baked into the lease. Core
names no Feishu tool, inspects no result field, and runs no egress gate of its
own. There is no sessionless Feishu tool: the capability is taken from the built
instance, which exists from creation rather than from connection.

The built-in provider supplies closed input and output schemas for every tool.
Successful results are canonical values: `reply` returns
`{ message_ids: string[] }`, `react` returns `{ reaction_id: string }`, and
`list_chat_bots` returns `{ chat_id, known, trusted }`. The shared server exposes
the value unchanged as `structuredContent` with exact `content: []` and validates
it against the provider output schema.

#### `ask_user_question`

The arguments deliberately mirror Claude Code's own AskUserQuestion, down to the
field descriptions, so a model reads the two as one tool: 1-4 `questions`, each
with a `header` chip, a `question`, and 2-4 `options` of `label` +
`description`. Four fields differ, and two of them are the chat. A `chat_id` is
required, because a chat tool needs a destination and AskUserQuestion has no
such concept; a `message_id` is optional, and when the model names the message
its question came out of, the card is addressed the way a reply is — into that
message's topic, under the anchor the target router already holds for it. With
no message named, the card is addressed at the chat, which in a topic group
opens a topic of its own: right for a question belonging to no particular
message, wrong for one that does. A message id from another chat is ignored
rather than obeyed, the same rule `reply` follows, so a stale id cannot
redirect a question into a conversation it was not meant for.

The other two fields are gone. There is no `multiSelect`: the operator ruled
multi-select out of this channel, so every question takes exactly one answer.
And there is no `preview`: it was first drawn as a column beside the options,
and the operator removed it on sight — "这个 preview 有点复杂了，给他去掉，
他也会影响卡片的布局". A per-option preview cannot be drawn without a second
column, and that column reshaped the layout of every question carrying one, so
the field went with the column.

The difference that shapes the design is not an argument at all: **the tool does
not return the answer.** It returns `{ request_id, status: 'asked', next }` as soon
as the card is sent, and `next` instructs the model to end its turn. A click
settles the round server-side and the answer reaches Core as an ordinary
inbound submission, on the path a typed reply takes. Blocking the tool call was
the alternative and it loses the case that matters — a person who answers after
lunch — because the MCP client, not Dreamux, bounds how long a tool call may
run.

The card carries no client state, and that is deliberate rather than incidental.
Feishu has no radio component: `select_static` is its only native single-select
and its options hold a label and nothing else, so an option's description would
vanish the moment the dropdown closed. Each option is therefore an
`interactive_container`, which holds no state at all — so "which option is
selected" exists only in the session's registry, every click is a callback, and
the selection is visible solely because the whole card is repainted from the
server's answer map. There is no `form`, because a form batches its inputs until
submit and would cost each question the ability to settle on its own.

Anyone in the chat may answer the card, and that is a decision rather than an
oversight: asked whether a non-asker clicking should be gated, the operator
ruled "不需要限制，所有人都可以点". The answer carries the clicker's open_id as
`sender_id`, so who answered is never lost — but no authorization check stands
between a group member and the card.

A round exists only once its card does. The registry builds the round and the
card together but puts neither in play until the send lands, so a send that
throws leaves nothing waiting — rather than a question with no card, whose TTL
would later report an unanswered question to a model whose user was never asked
one.

提交 with nothing chosen is refused with a toast instead of settling. The button
sits directly under the questions, so it is also the one pressed by accident,
and a round settles exactly once: spending that settlement to tell the model
every question was left unanswered is worse than saying nothing. A partial
answer still submits, and the questions nobody answered are reported as such.

A round closes itself after `ASK_USER_CARD_TTL_MS`, which is under the 15
minutes after which Feishu stops accepting clicks on a card. Past that cutoff
the card still looks live but every click is dropped, so an unanswered round
repaints the card as closed and tells the model no answer came and to stand
still until the user's next message. Rounds live in memory: a session teardown
abandons them, and a later click reports the round as gone rather than
answering nothing.

Source:

- `/packages/channel/feishu-channel/src/tools/registry.ts`
- `/packages/channel/feishu-channel/src/tools/messaging-tools.ts`
- `/packages/channel/feishu-channel/src/tools/ask-user-question.ts`
- `/packages/channel/feishu-channel/src/feishu-ask-user.ts`
- `/packages/channel/feishu-channel/src/feishu-ask-user-card.ts`
- `/packages/channel/feishu-channel/src/tools/routing-tools.ts`
- `/packages/channel/feishu-channel/src/tools/space-tools.ts`
- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/mcp/server.ts`
- `/packages/dreamux/src/service/channel-service/mcp-delegate.ts`
- `/packages/dreamux/src/service/channel-service/mcp-delegates.ts`
- `/packages/dreamux/src/service/mcp/`

### Targets and chat-mode discovery

A target does not cross the seam. The neutral contract publishes no
`ChannelTarget`: Core never sees a chat id, a thread id, a target key, or a
bindable flag, holds no binding table, and makes no routing decision.

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
- `/packages/dreamux-types/src/channel.ts`

### Inbound routing

Routing is one small service over the Channel's own document. Every read is
synchronous against the last committed document, and every write is a commit, so
a caller told a route exists is being told what disk says. The plan is one of
three answers: `bound` (with the row that answered, which may be the parent
group), `provision` (the committed Collaboration Space policy snapshot to create
a Team under), or `dispatcher` (`no_binding` or `not_bindable`).

Core makes no routing decision. The Channel resolves its own target, consults its
own bindings, and states the recipient in the Command:

- a resolved `team_name` reaches that Team's TeamLeader;
- omitting it reaches the Dispatcher Agent, which is the recipient for a
  conversation no binding or Collaboration Space claims.

Omission *is* the Channel's decision. Both forms are the one generic
`team.submit` Command, carrying opaque display attributes, faithful body text, an
optional standing reminder, and a stable `source_id` that Core deduplicates a
repeat on; Core renders the provenance envelope itself. Nothing about chats,
threads, or topic mode crosses. The returned `turn_id` names the exact turn the
call created. A Channel recognizes its own submission by the `source_id` it
sent, which Core echoes on `teammate.input`; there is no per-submission turn
event left to claim.

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

### Dispatcher-scoped core events

Each `DispatcherService` owns one in-process `DispatcherCoreEventBus`. It is a
best-effort distribution helper, not a fact owner or store. Existing owners
publish after their normal write point: `TeamStore` publishes Team status and
concrete leader changes; `AgentIdentityStore` publishes TeamLeader and TeamMate
status changes; the conversation projection publishes display-only input and
activity facts for the dispatcher agent and TeamLeaders. Routing produces no
core event — a Channel already owns its routing records, so it describes its own
state from them at the moment it changes them, and Core publishing a binding fact
back would mean Core holding one. Workflow, scheduler, and host-maintenance events
are deliberately absent.

The published catalog is an explicit set of four kinds: `team.state`,
`teammate.state`, `teammate.input`, and `teammate.activity`. The last two are
the whole conversation, split by producer: Core says what it admitted, and the
runtime says what it did. Both are **actor-scoped** — they name the Dispatcher
or TeamLeader whose conversation they belong to and carry no `turn_id`, member
set, or presentation identity, because a provider folds any number of Dreamux
submissions into one runtime-native turn and no display fact can honestly name
the submission that caused it.

`teammate.input` is published at the moment of submission, before any runtime
has accepted it, so a submission that fails is visible together with the text
that failed. `teammate.activity` carries a nested payload in the runtime's own
vocabulary (`assistant.message`, `tool.call`, `turn.ended`), so a runtime that
learns to report something new adds a member and changes no event catalog, no
seal, and no Channel subscription. `turn.ended` is the display stream's
terminal, carrying the producer's own reason when it has one. Core publishes
that same terminal itself for an input no runtime ever accepted, because such
an input still opened a surface that nothing else would close.

The seal's catalog is declared as a total record over the event union, so a new
kind that is not listed fails to compile rather than being published and
silently dropped. Sealing is the one place
a fact becomes deliverable: an event outside the set, an event whose
`schema_version` is not `1`, or one without a finite `occurred_at` is dropped and
logged rather than thrown, because producers publish synchronously from inside
operations whose durable work has already succeeded. A sealed event is deeply
frozen, so nothing can rewrite it after it has been broadcast.

A Channel session receives one read-only `ChannelEventSource` with a single
`subscribe(listener)` and an idempotent `unsubscribe()`. One subscription receives
the whole `ChannelCoreEvent` union and demultiplexes inside the Channel, so adding
an event changes only that catalog and its consumers.

No event carries a turn identity: presentation correlation is the `source_id` a
caller supplied, echoed back on its own input, and nothing exposes a
runtime-native Turn object or transcript. Conversation events may contain bounded,
redacted user/assistant display text and bounded tool arguments/results; other
events contain no prompt or assistant text. No event contains native transcript
paths, raw errors, or platform user identity.

Delivery is live and best-effort: Core invokes listeners in publication order
without awaiting them, and a listener's exception or rejection never escapes into
admission or settlement. There is no FIFO, backpressure, timeout, acknowledgement,
retry, replay, snapshot, or final-delivery guarantee. A listener keeps its
synchronous projection bounded; a reaction needing asynchronous persistence fences
its in-memory authority synchronously and serializes the durable write on a
Channel-owned mutation tail that `ChannelSession.close` awaits. The bus does not
become a new state owner, and providers never receive core service/store instances
or raw `EventEmitter` management methods.

Core installs the source during `initialize`, before `start` opens external input,
which is what makes subscribe-before-admission provable. Stop and start-failure
cleanup revoke the whole session source before closing the session; later
subscription attempts fail and old handles become no-ops.

Source:

- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/service/dispatcher-core-events/`
- `/packages/dreamux/src/service/agent-entity/identity-store.ts`
- `/packages/dreamux/src/service/team-collection/store.ts`
- `/packages/dreamux/src/service/channel-service/index.ts`
- `/packages/dreamux/src/channel/conversation-projection.ts`
- `/packages/dreamux/src/service/teammate-service/index.ts`
- `/packages/dreamux/src/service/teammate-service/runtime-owner.ts`
- `/packages/dreamux/src/service/dispatcher-service/index.ts`

### Feishu conversation display

The neutral conversation projection is a capability of the dispatcher agent and
team-scoped entities, not a Feishu role filter in core. TeamLeaders and Team
members publish the event surface; team-less dispatcher-spawned TeamMates do not
participate. Its scope is either a team-less dispatcher or a named
TeamLeader/Team member; an origin-less dispatcher turn is rejected by one core
predicate before any input or activity fact can enter the bus.

The Feishu session subscribes through `feishu-cot-adapter`. It owns card
anchoring, event-to-card projection, bounded outbox batching, serialized I/O, and
diagnostics. Presentation is keyed by *recipient*: every TeamLeader, and the
Dispatcher Agent, owns one standing anchor and at most one open card, whichever
Feishu chat, DM, group, or topic supplied that anchor. A target is an attribute
of the anchor, not a state key or a card partition, so a conversation that moves
between chats moves its one card rather than growing a second. None of it is
durable — closing or restarting the session loses every anchor and open-card
reference by design, with no restore, replay, or backfill.

Only a Channel user message moves an anchor, and the Channel moves it at the
moment it submits rather than after Core answers: the anchor is the Channel's
own state, which Core neither carries nor validates, and waiting for Core to
confirm admission was what pushed the user's own body and any early activity
onto the predecessor card. Taking it closes the recipient's open card as
interrupted — a card still open at that moment is showing work the runtime never
reported an end for, so the newer message cut it off rather than finishing it —
replaces the standing anchor, and opens the successor under the new message with
an opening label that claims nothing about admission, without waiting for a
settlement or a native turn end; a submission Core proves it did not admit
retires that anchor again, closing the spent card and leaving the recipient
anchorless rather than restoring its predecessor, while an ambiguous outcome
proves nothing and leaves the new anchor standing. A Reply is outbound only: its
receipt never
creates, replaces, defers, or retires an anchor and never opens, moves, or closes
a card. A visible Team bind card may initialize a TeamLeader that has no standing
anchor and never replaces one, while the Dispatcher has no installation or
restart anchor and stays anchorless until its first Channel user message.

Anchors consult two bounded fences: a leader-wide fence set by Team close and
endpoint-scoped route fences set by unbind or replacement, each retaining at most
512 entries. Team starting/running clears both kinds for that leader, while a
matching re-bind clears its endpoint route fence. Fence matching and route-driven
interruption use the anchor's authoritative binding endpoint, not its visible
target fallbacks. Fencing is the whole of the TeamLeader's extra lifecycle
policy; the Dispatcher, having no Team, is never fenced. Feishu ignores
Team-member events explicitly and never routes them through a recipient's state.

Once a recipient has an anchor, everything Core projects for it displays:
assistant text, tool calls and results, and every input whatever its source name,
including `task`, `task-notification`, `cron`, `system`, and a restart notice
delivered inside a live session. The one exception is the body of the message
this Channel itself submitted, which the operator can already see as their own
Feishu message: the session holds a bounded set of the caller-owned ids it
issued and recognizes an input by **comparing** `source_id` against them. Its
mere presence proves nothing — cron fires, task push-backs, and restart notices
carry one too. There is no source whitelist. A fact
that arrives before the recipient has an anchor produces no card because there is
nowhere to place one, not because its source or kind was filtered.

A tool row is composed from what the runtime said about the call, never from
its argument schema. The row's `TOOL_CALL_START` carries the built-in `icon`
the COT Message Brief documents for the call's `tool_action` (`read`; `write`
for an edit; `search` for a search or a listing; `bash` for a run) and a
`title` composed from the runtime's `summary`: the summary alone for a run,
whose summary is already a sentence; a Chinese verb before it for a read,
listing, search or edit; the display tool name before it for a call with no
action. A titled row sends no `TOOL_CALL_ARGS`. The raw JSON arguments go out
only on a row nothing could title — a Channel-owned or teammate tool keeps its
own title as before, and an MCP tool no runtime can label still shows its
arguments inline, which is the one raw row left. The `TOOL_CALL_RESULT` of a
runtime-labelled row is the documented segment array: `执行失败` first when it
failed, the `invocation` as a `code` segment (`language: bash` for a run),
then the output as a `code` segment, each spelling its body in the documented
`code` field. A probe card sent to the operator on 2026-09-03 settled the
three client facts this rests on: a titled row shows the `title` alone, with
no tool name in front of it; an `ARGS` delta sent beside a title is shown
nowhere, which is why the invocation has to travel in the result; and the
client renders a code segment's body from `code` and from the older `content`
alike, so the switch follows the docs, not a rendering failure.

A card's one terminal is a `turn.ended` activity. There is no per-submission
lifecycle fact at this boundary at all: a provider folds any number of
submissions into one native turn, so settlement could never say whether the card
an operator is watching has finished. The end's three statuses are the
card's three terminals, and they are spelled across two AG-UI events, not one:
`completed` and `interrupted` are `RUN_FINISHED` statuses (`done` and
`interrupted`), while `failed` is the separate `RUN_ERROR` event. `RUN_FINISHED`
takes exactly `done | paused | interrupted` — a `RUN_FINISHED` carrying `failed`
was probed live and renders as *completed*, identically to a deliberately
nonsense status, because the client ignores a status it does not know rather
than rejecting the batch. `paused` is documented but never produced here: a card
is open or ended, never held. `RUN_ERROR` carries `{ code }` alone: the
reference documents a `message` beside it, but a card finished with one shows
the client's own fixed failure line and never the supplied string, and a card
finished with `code` alone renders identically, so the field is neither
rendered nor required. The end's reason reaches the operator only as ordinary
text printed on the card just before the terminal — that print is load-bearing,
not a second copy.

The reference for all of this is **COT Message Brief** on the enterprise docs
host, `open.larkoffice.com`
(`/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message_cot/cot-message-brief`);
the public `open.feishu.cn` documentation carries no `message_cot` reference at
all, so a reader who checks only the public host will conclude, wrongly, that
this surface is undocumented. It gives the event vocabulary as a numbered enum
(`1 RUN_STARTED`, `2 RUN_FINISHED`, `3 RUN_ERROR`, `10-13 TEXT_MESSAGE_*`,
`20-24 TOOL_CALL_*`, …), accepts either the name or the number in `event_type`,
and spells fields in camelCase — which is what this Channel sends. The fact
closes an already open card and
never opens one, so it is ignored when no card is open — a repeated end is
therefore harmless. A create or append the platform refuses abandons only that
presentation: the standing anchor survives it, and the next opening activity may
open a card there again.

Facts Core publishes synchronously inside the admitting call land on the
successor card, not the predecessor, because the Channel takes its anchor and
writes its receipt before it calls Core. What remains is the window that opens
between that receipt and Core's answer: a submission Core disproves leaves a
spent card on the message that produced no turn, because retiring the anchor
closes that card as interrupted rather than erasing it. That window,
the exceptionally early native end, and a tool result crossing an anchor
replacement are operator-adjudicated accepted losses, recorded with their
reasoning in the
[task verification record](/.agents/tasks/channel/feishu-cot-conversation-cards/verification.md).

Every admitted input publishes exactly one `teammate.input`, and the runtime's
own stream carries everything after it; an entity whose conversation is out of
scope publishes nothing. Input bodies and live activity are redacted and bounded
in core, and operator paths are renamed rather than blanked — the workspace
reads `.` and this host's home reads `~`, from prefixes `Server.start()` resolves
once and injects into each conversation projection as a value. Card I/O has a
20-second operation deadline so settled draining state is eventually reaped.

The whole path is display-only and fail-open. Projection publisher, sanitizer,
identity, and logger failures cannot change runtime admission, settlement,
completion delivery, or retention cleanup. Card transport failures abandon only
the presentation. The automatic received/in-progress reaction lifecycle is
removed; the deliberate model-facing `react` tool and `addReaction` transport
surface remain.

Source:

- `/packages/dreamux/src/channel/conversation-projection.ts`
- `/packages/dreamux/src/service/teammate-service/index.ts`
- `/packages/dreamux/src/service/teammate-service/runtime-owner.ts`
- `/packages/dreamux/src/platform/home-paths.ts`
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

- [Feishu pairing access](feishu-pairing-access.md)
- [Feishu introduce](feishu-pairing-access.md)
- [Non-blocking dispatcher inbound](non-blocking-dispatcher-inbound.md)

## Invariants

- A target never crosses the seam: Core is told a `team_name` or nothing at all.
- A `p2p` target is never bindable.
- Assistant text alone is never a channel delivery contract. A runtime that
  should answer visibly in the source channel must call a provider-owned channel
  tool; tool failures return as MCP errors and are logged, and core holds no
  durable outbound retry queue.
- Core state must not grow a persisted conversation-display presentation, a
  reaction ledger, or an inbound message queue. Inbound de-duplication and
  presentation state are process-local provider facts unless a Feishu domain page
  says otherwise.
- Core must not implement a Feishu-specific tool handler, and must not re-derive
  a Channel routing fact out of Channel data — that is what its removed egress
  gate was.
- Every routing ownership precondition is enforced inside the commit that
  persists it, and no external call is in flight while the commit tail is held.
- Nothing durable exists for provisioning work in flight.
- Adding a `ChannelCoreEvent` kind means adding it to the sealed catalog; an
  unlisted kind is dropped and logged, never delivered and never thrown.

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
