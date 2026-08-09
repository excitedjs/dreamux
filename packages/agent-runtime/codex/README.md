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

This package depends only on the neutral `@excitedjs/dreamux-types` contracts
and shared `@excitedjs/dreamux-utils`; it never imports `@excitedjs/dreamux`
core. Everything host-specific — per-dispatcher paths, the volatile
rendezvous-socket root, the durable state sink, the process `PATH` seeded from
the host package bins, and bundled-skill installation — is supplied by the
Dreamux host through the neutral `AgentRuntimeCreateContext` and provider
factory options. The package owns only Codex-engine mechanics and its own
`~/.codex` home/config paths.

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

## Portable Structured Output

The neutral `AgentRuntimeTextInput.outputSchema` contract accepts ordinary
optional object properties. Codex strict structured output requires every
declared property to appear in `required`, so this package privately compiles a
narrow portable subset before `turn/start`:

- one closed root object (`additionalProperties: false`);
- nested closed objects and single-schema arrays;
- `string`, `number`, `integer`, `boolean`, `null`, and nullable
  `[T, "null"]`;
- `description`, primitive-value `enum`, and numeric `minimum` / `maximum`.

Every wire property is required. An originally optional non-nullable property is
made nullable for Codex, then a `null` placeholder is removed from the completed
JSON before Dreamux observes the result. Required nullable values remain
present as `null`.

Open objects, optional fields that already accept `null`, tuples, non-null
unions, composition/reference keywords, unknown keywords, and other unsupported
constraints fail before `turn/start` with
`UnsupportedAgentRuntimeFeatureError(feature = "outputSchema")`. The adapter
does not drop constraints or fall back to unconstrained text.

Concurrent submissions may fold into one active Codex turn only when both are
structured with the same compiled wire schema and restoration plan, or both are
unstructured. Structured/unstructured mixing and incompatible schemas fail
before another `turn/start`.

Each turn collector owns one notification subscription. It unsubscribes on
normal completion, terminal failure, explicit disposal, or runtime stop. A
rejected `turn/start` therefore cannot leave a stale collector observing or
buffering notifications from a later turn.

See
[Provider Runtime](../../../.agents/domains/provider-runtime.md#codex-portable-output-schema)
for the complete current lifecycle and failure contract.
