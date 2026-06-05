# @excitedjs/dreamux

This package is the Dreamux host: CLI, server, dispatcher runtime, Codex
app-server orchestration, Feishu MCP shim, state, and logs.

## Responsibilities

- Own the `dreamux` and `tm` package bins.
- Load operator config and server-owned state.
- Start, stop, and supervise dispatcher Codex app-server processes.
- Manage Codex threads, turn submission, restart notices, and fail-fast approval
  handling.
- Own access-gate decisions, dispatcher trust-domain policy, reaction state, and
  outbound Feishu MCP request routing.
- For issue #97, keep Feishu inbound formatter consumption host-local until
  `@excitedjs/feishu-channel` is intentionally reintroduced as a runtime
  dependency and publish-chain participant.

## Boundaries

- Do not spread Lark SDK or raw Feishu JSAPI details into Dreamux core. Direct
  platform calls belong in `@excitedjs/feishu-transport`; channel semantics
  are intended to move to `@excitedjs/feishu-channel` once the runtime package
  dependency is deliberately restored.
- Do not reimplement Feishu attachment download/cache/serialization logic in
  this package beyond the host-local issue #97 bridge.
- Do not assemble channel-specific `<attachment>` bodies in server/runtime code;
  call the channel layer and submit its output to Codex.
- Do not create dispatcher-private `CODEX_HOME` directories for the MVP.
  Dispatchers use the operator's normal Codex home.
- Do not automatically send Codex assistant text to Feishu. Outbound remains
  MCP tool driven.
- Do not commit internal Feishu identifiers, secrets, private paths, internal
  domains, or real resource keys.

## Upstream / Downstream Contract

- Upstream: `@excitedjs/feishu-transport` for low-level platform primitives
  currently consumed by Dreamux; `@excitedjs/feishu-channel` becomes an
  upstream runtime dependency only when Dreamux imports it again deliberately.
- Downstream: Codex app-server, dispatcher workspace skills, and operator CLI
  workflows.
- If a new feature needs both Feishu semantics and Codex-facing formatting,
  design the channel package API first, then keep Dreamux as the orchestrator.

## Testing Focus

- Server and dispatcher orchestration tests should assert that Dreamux consumes
  channel outputs and submits them to Codex.
- While the issue #97 bridge is host-local, formatter behavior may be covered
  in Dreamux host tests. Once the channel package is the runtime dependency
  again, channel formatting details should live in `@excitedjs/feishu-channel`
  tests.
- Keep fixtures public-safe: use placeholder chat, message, user, app, and
  resource identifiers.
