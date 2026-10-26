# @excitedjs/feishu-channel

The built-in Feishu **plugin** for [Dreamux](../../dreamux): it contributes the
Feishu `ChannelProvider` behind the `builtin:feishu` provider reference and
publishes an extension api for other plugins. The provider implements the
neutral `@excitedjs/dreamux-types` channel contract on top of
[`@excitedjs/feishu-transport`](../feishu-transport), which stays the sole owner
of the Lark SDK.

`@excitedjs/dreamux` depends on this package and always loads its plugin, so
the Feishu channel ships out of the box.

## What it owns

- The live Feishu channel **session** (bot start/close) above raw Lark JSAPI
  calls.
- **Access / trust** behavior: the @-mention/allowlist gate and the chat-bots
  store, read and written under a host-supplied state directory.
- **Inbound normalization**: turning Feishu events into agent-facing channel
  results, including the Channel-owned inner body and inline `<attachment>`
  blocks. Core owns the outer `<channel source="feishu" …>` envelope.
- **Topic routing**: projecting `thread_id` as a neutral collaboration target
  whatever the group's current message format is, observing that format only to
  decide whether an unbound topic may receive a new Team, and recording exact
  per-message targets for scoped TeamLeader replies.
- **Attachment handling**: downloading inbound attachments after the host access
  gate allows delivery, plus cache layout, path sanitization, permissions, and
  honest fallback references when a resource is not downloaded. Inline XML is
  path-only for a downloaded resource and status/key-only for a non-downloaded
  resource; structured formatter results retain the detailed metadata.
- The Feishu MCP **tool backing**: the `reply` / `react` / `list_chat_bots`
  tool parsing and handlers.

## What it does not own

- It never imports `@excitedjs/dreamux` core, and never imports the Lark SDK
  directly — platform calls go through `@excitedjs/feishu-transport`. The Core
  import boundary is enforced by the shared lint configuration.
- Dispatcher lifecycle, agent process supervision, Team lifecycle, the neutral
  command port, and MCP lease/shim routing stay in `@excitedjs/dreamux`.
  Feishu routing, binding state, access policy, and tool definitions belong to
  this package. The host supplies the bot
  secret / app id and the state / cache directories; the package reconstructs no
  Dreamux host layout or path contract.

## Public API

- The default export is the neutral provider factory for
  `npm:@excitedjs/feishu-channel`. `createFeishuPlugin()` is the named plugin
  factory. The plugin
  contributes the `feishu` channel provider (`builtin:feishu`) and publishes
  `FeishuApi`, through which another plugin registers Feishu extensions: extra
  MCP tools, card actions, and a per-channel-instance lifecycle with an
  instance api (`FeishuExtension`, `FeishuInstanceApi`). That api includes
  `submitToBoundTeam`: an extension delivers work of its own (after a click or
  from a timer) to the one Team the conversation still routes to, with no card
  callback and no Core port of its own, and receives Core's actual admission
  outcome. It never provisions a Team or falls back to another recipient, and
  it claims no presentation anchor.
- `createFeishuChannelProvider()` — the same provider with no extensions. Its
  `createSession` returns a `ChannelInstance`: a `session` with
  `initialize` / `start` / `close`, plus the optional `mcp` capability beside it.
- The public extension contracts and inbound message formatter support plugin
  authors and cross-package callers. Session, gate, stores, tool parsers, and
  bot adapter implementations remain package-internal.

For extension tools, `successText(result)` supplies the complete model-visible
result: include every actionable fact and reminder in that text. Nonempty text
is forwarded verbatim in MCP `content`, without `structuredContent` or a JSON
copy of the result. Returning `undefined` or `''` exposes the structured result
instead. Tools declaring `successText` publish no `outputSchema`, because MCP
requires structured content when an output schema is advertised.

Successful submission receipts can carry a Dreamux Turn identifier. The
channel distinguishes admitted, duplicate, stopped, failed, ambiguous, and
proven Team-rejection outcomes. A proven pre-admission Team rejection permits
the bound-route fallback; ambiguous delivery is never replayed. The read-only
core event stream projects
sanitized submitted, activity, and settled lifecycle facts for dispatcher and
TeamLeader conversations; Feishu anchors each presentation to the turn's
inbound message.

Binding a topic retires the displaced Team's presentation even when that Team
served the topic through its parent group. Removing an exact topic binding
retires that route's presentation and permits fresh submissions through a
remaining parent binding, including one to the same Team. A standing anchor
keeps the serving-route provenance captured when it was created.

Test doubles are deliberately test-local and are not part of the published
package API.

## Feishu access and trusted groups

The Channel accepts only exactly classified inbound identities. `chat_type`
must be `p2p` or `group`; a human is exactly `sender_type: "user"` with a
non-empty sender id, and a bot is exactly `sender_type: "bot" | "app"` with a
non-empty sender id. Other chat types fail with `unsupported_chat_type`, and
other sender shapes fail with `sender_unknown`, before bot observation,
`/introduce`, pairing, or delivery.

The `dreamuxFeishuGate` input is unchanged: it still has `chat_type` and
`is_bot_sender` and has no `sender_kind`. Callers must perform the exact
classification above first. Passing `is_bot_sender: false` asserts a known
human; negating `isBotSenderType(...)` alone is not sufficient because unknown
sender types are not humans.

Feishu access state remains `access.json` version 3. For human group messages,
`group.require_mention` runs first and `group.policy: "block"` remains the kill
switch. Under `allowlist`, an unlisted chat is dropped and a listed chat trusts
every exactly classified human member. Under `follow-user`, a listed chat has
the same trust, while an unlisted chat follows `dm_policy` and `allow_users` as
before. A trusted chat therefore bypasses `dm_policy`, `allow_users`, and
pairing, including when `dm_policy` is `disabled`; it does not bypass the global
mention switch. Bot/trusted-bot and P2P behavior are unchanged.

This is an in-place authorization semantic change, not a state-shape change:
version 3 needs no rebuild. Before deploying, review every non-empty
`group.allow_chats` entry under both `group.policy: "allowlist"` and
`"follow-user"`. Keep only groups whose human membership should be trusted and
whose passive known-bot observation should remain enabled. The new meaning
takes effect when the new server starts.

`/introduce` deliberately remains sender-scoped. A human outside `allow_users`
may deliver ordinary text in a trusted chat but cannot mutate peer-bot trust;
the command is diagnosed as `sender_not_followed` and writes no trust.

## Feishu chat information permission

Topic identity is Feishu's own `thread_id`: a group message carrying one is a
topic whatever the group's current message format is — a native topic group, an
ordinary group switched to thread message format, or an ordinary group back in
chat message format whose old topics members keep talking in. Neither `root_id`
nor `parent_id` is ever read as identity. What the message format decides is
only whether a still-unbound topic may automatically receive a new Team, and
that mutable fact is observed fresh per message, never remembered for the
session.

That observation reads the enclosing chat through Feishu's
`im.v1.chat.get` API. The bot must have a group information read permission
accepted by that API, such as `im:chat:readonly`, and must be a member of the
group. If the API fails or omits a recognized message format, the channel logs
a warning, keeps the message's identity, and withholds automatic provisioning
for it: saved bindings still answer — an exact topic binding first, then a
parent-group binding — and an unbound topic reaches the Dispatcher instead of
being given a Team. Every non-empty inbound `thread_id` is also included in the
provider-owned display attributes, so runtimes render it in the model-visible
`<channel>` envelope.

The same read can decide who may answer a card, as a last resort. A click on
an ask-user or extension card names its chat but not whether that chat is
direct or a group, so the channel applies the inbound access policy for both
kinds and establishes the kind only when the two answers differ. It takes the
kind from the chat itself, never from the access lists it is judging: the kind
reported by the last admitted inbound message this session routed in that chat
(a group message dropped for lacking a mention, an untrusted bot's message, or
a consumed `/introduce` teaches nothing). Only then does it ask the platform. A person the policy
admits in a direct chat and in a group alike, or in neither, never triggers the
read. When the answer does depend on the kind and it cannot be established, the
click is refused with an error toast rather than admitted on a guess — the
access kind is the only fact at stake here; a failed message-format read never
changes what a message is, only whether an unbound topic may provision. On an
install whose bot lacks the group information read permission, this affects
only a click in a chat this session has not yet routed an admitted message
from.

A topic target declares its enclosing group as a less-specific binding
fallback. An exact topic binding wins first, then its parent-group binding,
and only a still-unbound topic may then be provisioned — one whose group is
currently in the topic message format and carries a registered Collaboration
Space policy. If no policy claims it, delivery stays with the Dispatcher.
This fallback is also
used for TeamLeader egress authorization after exact message/topic ownership is
verified, allowing a group-bound TeamLeader to reply to an observed topic
message without weakening cross-topic authorization for topic-bound leaders.
Topic replies still require an observed source `message_id`; a standalone
`thread_id` is rejected because the transport preserves topic placement through
Feishu's reply-to-message API rather than a send-to-thread endpoint.

> Production note: `@excitedjs/dreamux` drives this package through a thin
> core-owned adapter that uses the richer host-shaped session API. The neutral
> `ChannelSession.start(routes)` path is real and contract-tested, but is not the
> production wiring today. See
> [`.agents/tasks/architecture/npm-package-split/requirement.md`](../../../.agents/tasks/architecture/npm-package-split/requirement.md#npm-package-split-and-channel-targets).

## Build / test

Built and tested via rush in topological order (dependencies first):

```sh
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build --to @excitedjs/feishu-channel
node common/scripts/install-run-rush.js test --to @excitedjs/feishu-channel
```
