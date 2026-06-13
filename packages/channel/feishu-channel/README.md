# @excitedjs/feishu-channel

The built-in Feishu **`ChannelProvider`** for [Dreamux](../../dreamux) — the
package behind the `builtin:feishu` provider reference. It implements the
neutral `@excitedjs/dreamux-types` channel contract on top of
[`@excitedjs/feishu-transport`](../feishu-transport), which stays the sole owner
of the Lark SDK.

`@excitedjs/dreamux` depends on this package by default and resolves
`builtin:feishu` to it, so the Feishu channel ships out of the box.

## What it owns

- The live Feishu channel **session** (bot start/close) above raw Lark JSAPI
  calls.
- **Access / trust** behavior: the @-mention/allowlist gate and the chat-bots
  store, read and written under a host-supplied state directory.
- **Inbound normalization**: turning Feishu events into agent-facing channel
  results, including the `<channel source="feishu" …>` envelope and
  `<attachment>` blocks.
- **Attachment handling**: downloading inbound attachments after the host access
  gate allows delivery, plus cache layout, path sanitization, permissions, and
  honest fallback references when a resource is not downloaded.
- The Feishu MCP **tool backing**: the `reply` / `react` / `list_chat_bots`
  tool parsing and handlers.

## What it does not own

- It never imports `@excitedjs/dreamux` core, and never imports the Lark SDK
  directly — platform calls go through `@excitedjs/feishu-transport`. Both
  boundaries are enforced by `tests/import-boundary.test.ts`.
- Dispatcher lifecycle, agent/Codex process supervision, routing, binding state,
  authorization, Team lifecycle, and the Feishu MCP **server descriptor** /
  admin-method routing stay in `@excitedjs/dreamux`. The host supplies the bot
  secret / app id and the state / cache directories; the package reconstructs no
  Dreamux host layout or path contract.

## Public API

- `createFeishuChannelProvider()` plus the default-exported provider factory —
  builds the neutral `ChannelProvider` the generic channel loader registers for
  `builtin:feishu`. Its `createSession` returns a contract-valid `ChannelSession`
  (`reply` / `react` / `resolveTarget` / `tools` / `handleTool` /
  `messageBelongsToTarget`).
- The session class plus the gate, chat-bots store, message formatter, MCP tool
  parser, and bot helpers, used by the core adapter that drives the production
  host-shaped session path.

> Production note: `@excitedjs/dreamux` drives this package through a thin
> core-owned adapter that uses the richer host-shaped session API (a
> result-returning inbound submitter the reaction ledger keys off). The neutral
> `ChannelSession.start(routes)` path is real and contract-tested, but is not the
> production wiring today. See
> [`.agents/decisions/npm-package-split-and-channel-targets.md`](../../../.agents/decisions/npm-package-split-and-channel-targets.md).

## Build / test

Built and tested via rush in topological order (dependencies first):

```sh
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build --to @excitedjs/feishu-channel
node common/scripts/install-run-rush.js test --to @excitedjs/feishu-channel
```
