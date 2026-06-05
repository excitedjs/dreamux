# @excitedjs/feishu-channel

This package is the Feishu channel layer for Dreamux-side behavior. It sits
between `@excitedjs/feishu-transport` and `@excitedjs/dreamux`.

## Responsibilities

- Own Feishu channel semantics above raw Lark JSAPI calls.
- Normalize inbound Feishu content into agent-facing channel results.
- Download inbound attachments after the host access gate allows delivery.
- Own attachment cache layout, path sanitization, permissions, retention, and
  cleanup policy.
- Generate honest fallback references when a resource is not downloaded,
  including the resource key and a lark-cli fetch direction that uses
  placeholder-safe identifiers in docs and tests.
- Serialize Codex/agent-facing inbound bodies, including `<feishu_message>` and
  `<attachment>` blocks.
- If the channel ever needs to parse model/channel-specific markup, keep that
  deserialization here rather than in `@excitedjs/feishu-transport`.

## Boundaries

- Do not import the Lark SDK directly. Use `@excitedjs/feishu-transport` for
  platform calls.
- Do not own dispatcher lifecycle, Codex process supervision, thread state,
  admin socket handling, or Feishu MCP tool execution. Those stay in
  `@excitedjs/dreamux`.
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
