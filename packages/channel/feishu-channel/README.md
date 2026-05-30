# @excitedjs/feishu-channel

The **dreamux-side channel layer**: stateful orchestration on top of
[`@excitedjs/feishu-transport`](../feishu-transport).

> **Status: PR0 scaffold.** No business logic yet. See
> [issue #25](https://github.com/excitedjs/dreamux/issues/25).

## Scope (when filled in by later PRs)

- **① Filter** — @-mention gate (`isBotAddressed`) + access gate (allowlist),
  orchestrating the core's pure `gate()`.
- **② Map + forward** — conversation→Codex-thread mapping (`conversationKey` →
  thread) and forwarding inbound to the engine / outbound back to Feishu.

This is dreamux's counterpart of claudemux's proxy/daemon. The two are
symmetric but **never depend on each other** — both depend only on
`@excitedjs/feishu-transport`. The engine (`DispatcherRuntime`) stays in
`@excitedjs/dreamux` and implements this layer's `InboundSink` / `OutboundPort`
interfaces, so there is no dependency cycle.

## Build / test

Built via rush in topological order (core first):

```sh
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
```
