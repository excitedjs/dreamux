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
- **Topic routing**: verifying `chat_mode=topic`, projecting `thread_id` as a
  neutral collaboration target, and recording exact per-message targets for
  scoped TeamLeader replies.
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

## Feishu topic-group permission

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
