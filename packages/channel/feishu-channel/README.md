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
- **Topic routing**: verifying `chat_mode=topic`, projecting `thread_id` as a
  neutral collaboration target, and recording exact per-message targets for
  scoped TeamLeader replies.
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
  instance api (`FeishuExtension`, `FeishuInstanceApi`).
- `createFeishuChannelProvider()` — the same provider with no extensions. Its
  `createSession` returns a `ChannelInstance`: a `session` with
  `initialize` / `start` / `close`, plus the optional `mcp` capability beside it.
- The public extension contracts and inbound message formatter support plugin
  authors and cross-package callers. Session, gate, stores, tool parsers, and
  bot adapter implementations remain package-internal.

Successful submission receipts can carry a Dreamux Turn identifier. The
channel distinguishes admitted, duplicate, stopped, failed, ambiguous, and
proven Team-rejection outcomes. A proven pre-admission Team rejection permits
the bound-route fallback; ambiguous delivery is never replayed. The read-only
core event stream projects
sanitized submitted, activity, and settled lifecycle facts for dispatcher and
TeamLeader conversations; Feishu anchors each presentation to the turn's
inbound message.

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

Topic collaboration routing reads the enclosing chat through Feishu's
`im.v1.chat.get` API. The bot must have a group information read permission
accepted by that API, such as `im:chat:readonly`, and must be a member of the
group. If the API fails or omits a recognized `chat_mode`, the channel logs a
warning and deliberately treats the inbound as an ordinary group message; it
does not infer topic mode from `root_id`, `parent_id`, or `thread_id` alone.
Every non-empty inbound `thread_id` is also included in the provider-owned
display attributes, so runtimes render it in the model-visible `<channel>`
envelope. Displaying that identifier does not classify an ordinary group
thread as a collaboration topic.

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
click is refused with an error toast rather than degrading to an ordinary group
as topic detection does, which on an install whose bot lacks the group
information read permission affects only a click in a chat this session has not
yet routed an admitted message from.

A confirmed topic target declares its enclosing group as a less-specific
binding fallback. An exact topic binding wins first; a bound collaboration
space then provisions or reuses the exact topic Team; only a topic group that
has no accepted collaboration route may reuse an existing group binding. If no
such binding exists, delivery stays with the Dispatcher. This fallback is also
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
