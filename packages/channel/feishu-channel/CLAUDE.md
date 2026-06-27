# @excitedjs/feishu-channel

This package is the built-in Feishu `ChannelProvider` for Dreamux (alias
`builtin:feishu`, issue #209 slice 5). It sits between
`@excitedjs/feishu-transport` and `@excitedjs/dreamux`, implements the neutral
`@excitedjs/dreamux-types` `ChannelProvider`/`ChannelSession` contract, and
depends on `@excitedjs/dreamux-types` + `@excitedjs/feishu-transport` **only** —
never on `@excitedjs/dreamux` core.

## Responsibilities

- Own Feishu channel semantics above raw Lark JSAPI calls: the live channel
  session (bot start/close), access/trust behavior (the gate + chat-bots store,
  read/written under a host-supplied state dir), and provider-local
  message-to-target ownership tracking.
- Own the Feishu MCP surface end-to-end: the **tool backing** (`reply` / `react`
  / `list_chat_bots` tool parsing + handlers) AND the MCP **server descriptor**
  the runtime launches (`mcpServerDescriptor`, built from the host's neutral bin
  command + admin socket). Core owns only the generic, channel-agnostic conduit —
  the `channel-mcp` stdio shim + the neutral `channel.invoke_tool` /
  `channel.list_tools` admin methods; see Boundaries.)
- Normalize inbound Feishu content into agent-facing channel results.
- Download inbound attachments after the host access gate allows delivery.
- Own attachment cache layout, path sanitization, permissions, retention, and
  cleanup policy.
- Generate honest fallback references when a resource is not downloaded,
  including the resource key and a lark-cli fetch direction that uses
  placeholder-safe identifiers in docs and tests.
- Serialize Codex/agent-facing inbound bodies, including the
  `<channel source="feishu" …>` envelope and `<attachment>` blocks.
- If the channel ever needs to parse model/channel-specific markup, keep that
  deserialization here rather than in `@excitedjs/feishu-transport`.

## Boundaries

- Do not import the Lark SDK directly. Use `@excitedjs/feishu-transport` for
  platform calls. Do not import `@excitedjs/dreamux` core.
- Allowed upstream deps: `@excitedjs/dreamux-types`, `@excitedjs/dreamux-utils`,
  and `@excitedjs/feishu-transport`. Pure neutral helpers (atomic writes, OS
  primitives, config validation) go to `@excitedjs/dreamux-utils` — channel
  source may import from there but may not add new host-owned path/layout/socket
  contracts into dreamux-utils (see `dreamux-utils/src/os.ts` header for the
  primitives-vs-contracts boundary).
- Do not own dispatcher lifecycle, agent/Codex process supervision, thread
  state, admin socket handling, routing, binding state, authorization, or Team
  lifecycle. The generic channel-MCP transport — the core `channel-mcp` stdio
  shim and the neutral `channel.invoke_tool` / `channel.list_tools` admin-method
  routing (Dreamux bin + admin socket) — stays in `@excitedjs/dreamux`; the
  package only shapes the MCP server descriptor that points at that shim. The
  host supplies the bot secret/app id and the state/cache dirs; the package
  reconstructs no Dreamux host layout/path contract.
- Do not write private Feishu identifiers, internal domains, operator paths, or
  real resource keys into committed fixtures or docs.
- Do not make download failure look like success. If no local readable file
  exists, omit `path`, keep the key when available, and include a short reason.

## Attachment Message Contract

Keep the core attachment block short and stable:

```xml
<attachment type="file" name="debug.zip" key="FILE_KEY" path="/abs/cache/debug.zip" status="downloaded" />
```

For fallback:

```xml
<attachment type="file" name="debug.zip" key="FILE_KEY" status="not_downloaded" reason="missing_scope">
lark-cli im +messages-resources-download --message-id MSG_ID --file-key FILE_KEY --type file --output ./feishu-attachment-file
</attachment>
```

Optional fields such as size, mime, or preview may be added only when they are
useful and bounded. They are not part of the minimal core contract.

## Upstream / Downstream Contract

- Upstream: `@excitedjs/feishu-transport` low-level Lark operations.
- Intended downstream: `@excitedjs/dreamux`. After issue #97, Dreamux does not
  depend on this package at runtime until the channel package is deliberately
  reintroduced into the published dependency graph.
- Dreamux may provide cache roots, limits, and logging hooks, but the channel
  owns how resources are downloaded, cached, represented, and degraded.
