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
- Own the Feishu MCP tool surface: `reply` / `react` / `list_chat_bots` static
  tool catalog plus parsing and handlers. Core owns every channel MCP server
  descriptor, the `channel-mcp` stdio shim, admin socket args, and caller/team
  routing args; see Boundaries.
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
  shim and the neutral `channel.invoke_tool` admin-method routing (Dreamux bin,
  admin socket, caller/team args, and descriptor rendering) — stays in
  `@excitedjs/dreamux`; the package only exposes static tool catalogs and
  handlers. The host supplies the bot secret/app id and the state/cache dirs;
  the package reconstructs no Dreamux host layout/path contract.
- Do not write private Feishu identifiers, internal domains, operator paths, or
  real resource keys into committed fixtures or docs.
- Do not make download failure look like success. If no local readable file
  exists, omit `path`, keep the key when available, and include a short reason.

## Owner-Only Pairing Approval Card

The Feishu pairing flow is an interactive-card approval flow, not a
model-visible approval tool.

Requirements:

- When an untrusted sender reaches a `pairing` gate path, send an interactive
  approval card. Do not send or expose a pairing code in user-visible text.
- The card must carry the opaque pairing token only in the button value under
  `dreamux_pairing_token`. The token must not appear in card text, toast text,
  specs, fixtures, or logs committed to the repo.
- The Feishu MCP surface must not include an `access` tool. Keep approval out
  of the agent/model tool list; the channel MCP tools are `reply`, `react`, and
  `list_chat_bots`.
- Only the Feishu App Owner may approve. Resolve owner identity through the
  transport-owned Feishu application API wrapper, then compare the click
  operator's open_id with the creator/owner open_id values returned there.
- Non-Owner clicks must return a toast only:
  `只有 App Owner 才有权限点击批准授权`. They must not mutate `access.json` or
  update the card.
- Owner clicks approve the hidden token under the access mutex. Approval adds
  the pending requester to `allow_users` and removes the pending entry.
- A successful click must respond through the official card callback ACK shape:
  `{ toast, card: { type: "raw", data: <green success card> } }`. Do not use
  ordinary `im.v1.messages.patch` from the click handler, and do not return a
  bare `{ card: <raw card> }` wrapper.
- The success card must be green, must not contain the token, and must not
  expose raw Feishu ids.
- Visible card copy must use Feishu card i18n fields so the client displays a
  single language. Default copy is Simplified Chinese; `en_us` carries the
  English copy. Do not concatenate both languages into one visible string.
- The approval card must @-mention the requester with the Feishu card
  Markdown `<at id="open_id"></at>` form so the Owner can see who requested
  access.

Design constraints:

- `allow_users` remains the source of truth for ordinary message delivery.
  App Owner identity is checked only in the card action handler; it is not an
  implicit gate bypass. If `allow_users` is empty, an Owner message still
  triggers pairing under the normal `dm_policy` / `group.policy` rules, then
  the Owner can approve the generated card.
- Keep card rendering in `feishu-pairing-card.ts`, gate state transitions in
  `feishu-gate.ts`, and IO/mutation orchestration in `feishu-session-ops.ts`.
  Transport code owns only thin Feishu SDK wrappers such as card send and owner
  lookup. Bot display names come from the transport's runtime bot info
  (`/open-apis/bot/v3/info` `app_name`); if missing, the channel falls back to
  the neutral `Dreamux bot` label.
- Any change to this flow must update `feishu-pairing-card.test.ts`,
  `feishu-mcp-tools.test.ts`, the transport tests for new SDK wrappers, and the
  `.agents` pairing-access spec/decision docs when the contract changes.

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
