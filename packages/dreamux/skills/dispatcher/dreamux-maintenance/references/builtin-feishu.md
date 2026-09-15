# Current `builtin:feishu` Channel Config

Accepted `dispatchers[].channels[].config` fields:

- `app_id`: required non-empty string identifying this Channel config;
- `app_secret`: required non-empty string authenticating the Feishu app.

There are no credential defaults and no other built-in Feishu config fields.

## Feishu-Owned Routing State

The built-in Feishu Channel owns which conversation reaches which Team, and its
collaboration-space provisioning policy. Both live in one server-owned document
per configured channel at
`~/.dreamux/state/<dispatcher-id>/feishu-routing.<channel-slug>.<digest>.json`,
where the slug and digest are both derived from the configured channel `id`.

- It is fully server-owned. Do not edit, copy over, synthesize, or delete it as
  an operational repair, and do not hand-write a binding into it.
- Change it only through the Channel's own MCP tools: `bind_channel` /
  `unbind_channel` for one conversation, and `bind_collaboration_space` /
  `unbind_collaboration_space` for provisioning policy. `list_bindings`,
  `get_collaboration_space`, and `list_collaboration_spaces` read it.
- A bind names an existing, open Team; Dreamux refuses a bind to a missing or
  closed Team and writes nothing. Dissolving a Team invalidates its routes.
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
- A document this Dreamux version cannot read fails loud at channel start,
  naming the file. Recreate the bindings through those tools rather than
  editing it.

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
