# Current `builtin:feishu` Channel Config

Accepted `dispatchers[].channels[].config` fields:

- `app_id`: required non-empty string identifying this Channel config;
- `app_secret`: required non-empty string authenticating the Feishu app.

There are no credential defaults and no other built-in Feishu config fields.

## Feishu-Owned Routing State

The built-in Feishu Channel owns which conversation reaches which Team, its
collaboration-space provisioning policy, and which documents' comments reach
which recipient. All three live in one server-owned document per configured
channel at
`~/.dreamux/state/<dispatcher-id>/feishu-routing.<channel-slug>.<digest>.json`,
where the slug and digest are both derived from the configured channel `id`.

- It is fully server-owned. Do not edit, copy over, synthesize, or delete it as
  an operational repair, and do not hand-write a binding into it.
- Change it only through the Channel's own MCP tools: `bind_channel` /
  `unbind_channel` for one conversation, `bind_collaboration_space` /
  `unbind_collaboration_space` for provisioning policy, and
  `subscribe_document` / `unsubscribe_document` for a document whose comments
  reach the caller. `list_bindings`, `get_collaboration_space`,
  `list_collaboration_spaces`, and `list_subscriptions` read it.
- A bind names an existing, open Team; Dreamux refuses a bind to a missing or
  closed Team and writes nothing. Dissolving a Team invalidates its routes and
  drops its document subscriptions, in the same commit.
- A chat carries either a whole-chat binding or a collaboration space, never
  both, because a whole-chat binding answers for every topic under it and would
  leave a space's new topics without a Team of their own. `bind_channel` refuses
  a chat a space is registered on, and `bind_collaboration_space` refuses a chat
  already bound as a whole; each names the conflict and writes nothing. Unbind
  the one you do not want first. Binding a single topic is unaffected — that is
  the row a space installs as it provisions.
- A document that already holds both still loads and the channel still starts;
  the rule is enforced on writes, not at startup. Such a chat keeps routing the
  way it has been — every topic under it answers to the whole-chat Team and new
  topics get no Team of their own — until the whole-chat binding is released.
  Nothing has to be rebuilt or hand-edited.
- A document subscription belongs to whoever created it — a Team, or the
  Dispatcher Agent. Neither recipient can create or remove another's, and
  `list_subscriptions` shows the caller's own rows only. Subscribing refuses a
  document the bot cannot see, and nothing is written for it.
- A row stores the document's own token, so a wiki page subscribed by its URL is
  stored as the document that node holds. If the bot's access to the node is
  later revoked, that URL can no longer name the row and `unsubscribe_document`
  refuses it; pass the `file_token` `list_subscriptions` shows instead. Do not
  hand-edit the row out.
- A comment on a document nobody follows reaches the Dispatcher Agent when it
  @-mentions the bot and the commenter is in the gate's `allow_users`; it is
  dropped and logged otherwise. That delivery writes no subscription row, so it
  changes nothing in this file — adding the commenter to `allow_users` is an
  access-state change, made through the pairing flow, not here.
- A document this Dreamux version cannot read fails loud at channel start,
  naming the file. Recreate the bindings through those tools rather than
  editing it.

## Feishu Peer-Bot Trust State

The built-in Feishu Channel tracks which peer bots it has passively observed
or been introduced to trust, per chat, in one server-owned file per dispatcher
at `~/.dreamux/state/<dispatcher-id>/chat-bots.json`.

- It is fully server-owned. Do not hand-edit it.
- Loaded at the session's first peer-bot operation (a passive bot message,
  `/introduce`, or a bot-added membership event), not at channel start, and
  held in memory for the life of the session from then on — a hand edit made
  while the channel is running is not read until the next restart, the same as
  the routing document. An unreadable or corrupt file degrades to an empty
  store rather than failing the channel's start or any operation, since
  peer-bot discovery is not security-critical the way `access.json` is.

## Feishu Extension State

Another plugin may register a Feishu extension: extra `channel-feishu` tools,
card actions, and a lifecycle that runs with each Feishu channel. Each
extension owns
`~/.dreamux/state/plugins/feishu/<dispatcher-id>/feishu-extensions/<extension>/<channel-slug>.<digest>/`,
one directory per configured Feishu channel, where the slug and digest are the
same ones the channel's routing document filename carries. This root is the
Feishu plugin's own state directory (`state/plugins/feishu/`, a plugin-scoped
directory Core hands to every plugin), not the dispatcher's Feishu channel
state — it is a different directory tree from `access.json`/`chat-bots.json`/
the routing document, so an extension cannot land among Feishu's own files.
Feishu passes the path and does not create it; the contents belong to that
extension. Do not edit, copy over, or delete it as an operational repair.

`dreamux doctor` lists each extension's tools and card actions on the
diagnostic line of each configured Feishu channel, and only there: with no
Dispatcher using a `builtin:feishu` channel, extensions are not listed. A
Feishu extension that fails to initialize or start fails that Feishu channel's
start.

## Collaboration-Space Identity At Team Creation

A Collaboration Space's configured `identity` stays exactly as the operator set
it in the routing document. When the Channel automatically provisions a Team for
a topic in that space, it creates the Team's leader with that identity plus the
bound conversation's reply address — the chat and the message that triggered the
creation — appended after it. An absent space identity creates the Team with the
reply address alone.

The appended text is generated per Team at creation time and belongs to the
Team's own server-owned identity. It is not written back to the space policy,
and an already-created Team is not revisited. To change the configured part, use
`bind_collaboration_space`; do not hand-edit either document.
