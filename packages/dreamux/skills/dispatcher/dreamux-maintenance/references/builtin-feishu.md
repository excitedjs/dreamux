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
- A document this Dreamux version cannot read fails loud at channel start,
  naming the file. Recreate the bindings through those tools rather than
  editing it.
