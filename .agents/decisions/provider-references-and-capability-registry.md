# Provider references and Capability Registry

- **Status:** Accepted, refined by
  [provider-architecture-realignment](provider-architecture-realignment.md)
- **Date:** 2026-06-06
- **Affects:** provider references, plugin manifests, Capability Registry,
  dispatcher startup validation, MCP descriptor discovery
- **PR / Issue:** [issue #110](https://github.com/excitedjs/dreamux/issues/110)

## Context

Issue #71 proposed a registry-first internal cleanup. Issue #110 expands that
into a provider architecture for Channel providers, Agent Runtime providers, and
Dispatcher Service capabilities.

The architecture needs a public ref syntax that can describe builtin providers
now and external package/export providers later. It also needs a registry that
lets Dreamux core discover capabilities without hard-coding every channel,
runtime, or MCP surface in the server.

## Decision

Use explicit provider refs and an in-process Capability Registry.

Provider refs have string shorthand and a normalized internal object form:

```text
builtin:<id>
npm:<package-spec>
npm:<package-spec>#<export-name>
```

Examples:

```text
builtin:codex
builtin:claude-code
npm:@example/dreamux-provider
npm:@example/dreamux-provider#thirdPartyRuntime
```

The normalized form separates source, package, export, and builtin id so config
validation and future manifests do not depend on ad hoc string parsing after
startup.

Phase 1 registers builtin provider descriptors and runs only provider
implementations that have been wired by their dedicated PRs. Npm refs may be
parsed, stored, and validated as reserved syntax, but they must fail clearly if
selected for execution. Dreamux must not install, import, or execute external
npm providers in Phase 1.

Issue #135 demotes the Capability Registry into a provider registry for the
`agentRuntime` seam. Wired builtin runtime providers attach their implemented
capabilities to the runtime implementation as the provider PRs land. The Codex
runtime provider declares runtime lifecycle, Dreamux MCP injection, inbound turn
submission, and Codex-style TeamMate completion delivery capability metadata.
Claude Code owns the same AgentRuntime interface with its own delivery shape.
Feishu is no longer a provider-registry entry; it is a built-in bidirectional
channel.

The provider registry is process-local and server-owned. It records:

- provider descriptors;
- provider kind (`agentRuntime` in the current implementation);
- provider-local implementation handles and runtime capability declarations;
- validation status.

Core consumers must consume runtime providers from the registry view instead of
maintaining parallel provider maps. Channel MCP surfaces are owned by the
channel module and injected by the Dispatcher Service.

## Consequences

- Builtin Agent Runtime providers become explicit extension points rather than
  special server branches.
- External provider syntax can be documented early without creating package
  loading or supply-chain risk in Phase 1.
- Startup validation must distinguish "unknown builtin", "reserved external
  runtime provider", and "valid but unsupported in this phase".
- Feishu channel behavior is reviewed at the channel module boundary, not as a
  registry provider descriptor.

## Alternatives considered

- **Hard-code builtin providers until external plugins exist:** rejected because
  Channel and Agent Runtime abstractions would still be shaped by Feishu and
  Codex implementation details.
- **Load npm providers immediately:** rejected for Phase 1. The Epic needs the
  schema and manifest model first; package installation and execution policy
  can be decided later.
- **Use only object refs in config:** rejected for operator ergonomics. String
  refs are concise, while the normalized object form keeps implementation
  unambiguous.
