# @excitedjs/agent-runtime-codex

The built-in **Codex** Agent Runtime provider for
[Dreamux](https://github.com/excitedjs/dreamux), published behind the stable
`builtin:codex` alias.

It implements the public `AgentRuntimeProvider` contract from
[`@excitedjs/dreamux-types`](../../dreamux-types) against the Codex
`app-server`: process supervision, the WebSocket RPC client, the `initialize`
handshake, thread start/resume, the per-runtime turn manager, teammate
completion delivery, and Codex doctor diagnostics.

## Boundary

This package depends on `@excitedjs/dreamux-types` **only**. It never imports
`@excitedjs/dreamux` core. Everything host-specific — per-dispatcher paths, the
volatile rendezvous-socket root, the durable state sink, the process `PATH`
seeded from the host package bins, and bundled-skill installation — is supplied
by the Dreamux host through the neutral `AgentRuntimeCreateContext` and the
provider factory options. The package owns only Codex-engine mechanics and its
own `~/.codex` home/config paths.

The host resolves `builtin:codex` to this package and wraps it with a
core-owned adapter that maps its private dispatcher objects onto the neutral
contract; see
`.agents/decisions/npm-package-split-and-channel-targets.md`.

## Logger

The package logs through the optional `DreamuxLogger` the host passes in. With
no logger it falls back to a minimal `console.error`-backed sink for standalone
use and tests.

## Standalone use

External callers can register this provider directly:

```ts
import { createCodexAgentRuntimeProvider } from '@excitedjs/agent-runtime-codex';
```

The factory accepts the neutral create context plus optional host hooks
(socket allocator, base process env, workspace skill preparation, and test
factories for the Codex process / WS client / home doctor).
