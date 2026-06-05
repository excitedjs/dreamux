# Feishu inbound attachments live in feishu-channel

- **Status:** Accepted
- **Date:** 2026-06-05
- **Affects:** `@excitedjs/feishu-transport`, `@excitedjs/feishu-channel`,
  `@excitedjs/dreamux`, Feishu inbound message format, attachment cache
- **PR / Issue:** [#92](https://github.com/excitedjs/dreamux/issues/92)

## Context

Feishu `image` / `file` inbound messages used to reach Codex as plain text
markers such as `(image)` or `(file: name.ext)`. That preserved delivery, but
it did not tell Codex whether there was a readable local file, where it was
cached, which Feishu resource key could be used to retry, or why an automatic
download failed.

The monorepo already had the package boundary needed for a cleaner split:
`@excitedjs/feishu-transport` is the Lark SDK / JSAPI boundary,
`@excitedjs/feishu-channel` is the channel layer, and `@excitedjs/dreamux` is
the host runtime. Before this decision, `feishu-channel` was only scaffolded
and Dreamux still owned the Codex-facing `<feishu_message>` serializer.

## Decision

Move Feishu inbound serialization and attachment handling into
`@excitedjs/feishu-channel`.

- `@excitedjs/feishu-transport` exposes structured resource metadata from
  parsed content and a raw message-resource fetch seam. It does not choose
  cache paths, write files, assemble `<feishu_message>` / `<attachment>` text,
  or parse model-facing special formats.
- `@excitedjs/feishu-channel` owns the Codex-facing inbound body, including the
  existing `<feishu_message>` envelope, `<group_bots>` block, fallback parser
  note, and attachment blocks. It also owns attachment download, cache-first
  lookup, filename sanitization, byte caps, timeouts, owner-only file modes,
  and fallback text.
- `@excitedjs/dreamux` calls the channel formatter after access gating passes,
  passes a per-dispatcher cache directory and the transport-backed fetcher, and
  submits the returned `formattedText` without reassembling channel-specific
  XML.

## Message Body Contract

The Codex-facing body keeps the existing `<feishu_message>` wrapper. Downloaded
resources add a compact attachment tag:

```xml
<attachment type="file" name="debug.zip" key="FILE_KEY" path="/abs/cache/file" status="downloaded" />
```

When a resource cannot be downloaded, the body must be honest: no `path`, a
short `reason`, the resource key when available, and a lark-cli fallback
direction. The fallback command must not use the attacker-controlled original
filename as `--output`; it uses a fixed safe output basename.

```xml
<attachment type="file" name="debug.zip" key="FILE_KEY" status="not_downloaded" reason="missing_scope">
Use lark-cli to fetch it if needed:
lark-cli im +messages-resources-download --message-id MSG_ID --file-key FILE_KEY --type file --output ./feishu-attachment-file
</attachment>
```

The core attributes are `type`, `name`, `key`, `path`, `status`, and `reason`.
`path` only appears when the local file exists and is expected to be readable by
Codex. `key` stays present even for downloaded resources so a cleaned cache can
be refetched later.

## Cache Contract

Dreamux provides the cache root through `dispatcherFeishuAttachmentCacheDir()`.
The channel package creates a sanitized per-resource file under that root,
never trusts raw filenames as paths, resolves the final path back under the
cache root, writes a temp file first, and renames into place only after the
download completes under the configured limits.

The cache is server-owned state. It is safe to delete; deletion only turns a
future duplicate delivery into another Feishu resource fetch or a fallback
block.

## Consequences

- Gate drop / pair / unauthorized paths must not download resources because
  Dreamux invokes the channel formatter only after `dreamuxFeishuGate()` returns
  `deliver`.
- Dreamux tests should assert that Dreamux consumes channel output. Channel
  tests own serialization, cache, sanitize, and fallback details.
- Future Feishu resource types should first extend the channel contract and
  tests. Transport remains a JSAPI wrapper and should not grow Dreamux- or
  model-specific serialization helpers.
