# Feishu topic collaboration routing

- **Status:** In review
- **Date:** 2026-07-15
- **Affects:** `@excitedjs/feishu-transport`, `@excitedjs/feishu-channel`,
  Feishu inbound routing and TeamLeader channel egress authorization
- **Related design:** [Collaboration space provisioning](collaboration-space-provisioning.md)

## Intent

Make externally created Feishu topic groups usable as Dreamux collaboration
spaces. The first inbound message in a real topic must project the neutral
container and target facts that core needs to provision a Team. Later messages
in that topic must resolve to the same target, and a provisioned TeamLeader must
be authorized to reply only through messages that belong to its topic.

## Scope

The Feishu transport preserves `message.thread_id` together with the existing
message, chat, root, and parent identifiers. The Feishu Channel provider
classifies a group with `im.v1.chat.get` and projects a topic target only when
both of these facts are present:

- the inbound event contains a non-empty `thread_id`;
- the chat API returns `chat_mode=topic` for the event's `chat_id`.

For a confirmed topic group, the provider emits:

- `ChannelContainer { container_type: "topic_group", container_key: chat_id }`;
- `ChannelTarget { target_type: "topic", target_key: thread_id }` with
  provider-owned chat and thread metadata.

The provider keeps a session-local cache of successfully resolved chat modes.
Concurrent lookups for one chat share an in-flight request. API failures or
missing/unknown modes are not promoted to topic mode and are not permanently
cached, so a later inbound can retry. Classification happens only after the
existing access gate accepts the message for delivery; dropped and pairing-only
messages must not call the chat API or populate the message-target ledger.
Failures and incomplete responses produce a structured warning containing the
chat identifier and safe error details, but never credentials or message text.

The Feishu session records the normalized target for each accepted inbound
`message_id`. `resolveTarget` prefers this authoritative message route when a
provider tool supplies `message_id`, and `messageBelongsToTarget` compares the
recorded target identity rather than only the enclosing chat. Reply transport
continues to use Feishu's reply-to-message API, which preserves the topic of the
authorized source message. When a known message selector also contains
`chat_id`, `thread_id`, or `chat_type`, each supplied value must agree with the
recorded provider identity; a mismatch fails target resolution before egress.

One provider-local routing capability creates `{ target, container? }` exactly
once for an accepted inbound. The same target object is recorded in the message
ledger and passed through the provider adapter to `ChannelInboundEnvelope`; the
adapter must not reconstruct a second routing identity.

The root-exported custom-bot and transport seams remain source compatible:
chat-mode lookup is an optional capability, and the public Feishu submitter
envelope retains its legacy `chatId` and `chatType` fields. Production sessions
also supply the normalized target; only a legacy envelope without that field
uses the adapter's pre-topic group/P2P fallback. The root-exported raw session
also retains synchronous target resolution and its deprecated chat-level
ownership helper, while core authorization uses the new exact-target helper.

Feishu topic egress is source-message based: the provider uses the reply API to
preserve the source message's topic. A standalone `thread_id` selector is not a
send-to-topic primitive and is rejected without an observed `message_id`, even
when it names the TeamLeader's own topic.

## Constraints

- Dreamux core must remain provider-neutral and must not parse `chat_id`,
  `thread_id`, `root_id`, or `chat_mode`.
- `thread_id` is the topic key. `root_id` and `parent_id` are diagnostic
  metadata only and must not independently enable topic routing.
- A normal group whose messages use thread/reply form remains a normal group
  when `chat_mode` is not `topic`.
- If chat-mode verification cannot complete because of permissions, network
  failure, an unavailable SDK seam, or an incomplete response, the provider
  must fail safe to the existing non-collaboration group route.
- Feishu topic collaboration requires the bot to have permission to read group
  information (for example `im:chat:readonly`). Missing permission remains
  fail-safe but must be visible in channel warnings and operator documentation;
  this slice does not add a new diagnostic/doctor surface.
- A topic TeamLeader cannot authorize egress to another topic in the same chat
  merely by supplying that chat's identifier.
- The provider must not create Teams, worktrees, bindings, or collaboration
  records; it only supplies neutral routing facts to the existing core seam.

## Acceptance Criteria

- A topic root and replies carrying the same `thread_id` normalize to the same
  bindable topic target and topic-group container.
- A different `thread_id` in the same topic group normalizes to a different
  target under the same container.
- A normal group message, including a normal-group thread/reply with
  `root_id`, `parent_id`, or `thread_id`, does not carry a collaboration
  container and keeps the group target.
- A confirmed topic-mode chat event without `thread_id` remains a group target
  with no container. `root_id` or `parent_id` must not substitute for the topic
  key.
- A real `@excitedjs/feishu-channel` provider delivery reaches
  `DispatcherService` with the projected container and provisions the bound
  collaboration target on first inbound.
- Later inbound for the same topic routes to the already provisioned
  TeamLeader.
- TeamLeader reply authorization accepts a recorded message in its own topic
  and rejects a recorded message from another topic in the same chat.
- Topic TeamLeader egress rejects chat-only replies, unknown message ids, and a
  standalone thread selector. It also rejects a known own-topic message combined
  with a conflicting chat or thread selector.
- Successfully resolved `topic` and `group` modes are cached, concurrent
  lookups for one chat are single-flighted, and API errors plus missing or
  unknown modes warn, remain uncached, and are retried by later accepted input.
- Messages rejected or consumed by the access gate do not query chat mode or
  create message-target entries.
- Transport, provider, Dispatcher integration, typecheck, lint, and relevant
  repository validation cover the new contract.

## Out Of Scope

- Feishu topic creation, close/archive lifecycle discovery, or automatic
  deletion of external topics.
- Inferring historical topics that have not produced an inbound event during
  the current session.
- Treating ordinary groups configured with thread-style messages as
  collaboration spaces.
- Adding Feishu-specific configuration or selectors to Dreamux core.
