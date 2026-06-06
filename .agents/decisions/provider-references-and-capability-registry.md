# Provider references and Capability Registry

- **Status:** Accepted
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
builtin:feishu
builtin:codex
builtin:claude-code
npm:@example/dreamux-provider
npm:@example/dreamux-provider#feishuLikeChannel
```

The normalized form separates source, package, export, and builtin id so config
validation and future manifests do not depend on ad hoc string parsing after
startup.

Phase 1 registers and runs only builtin providers. Npm refs may be parsed,
stored, and validated as reserved syntax, but they must fail clearly if selected
for execution. Dreamux must not install, import, or execute external npm
providers in Phase 1.

The Capability Registry is process-local and server-owned. It records:

- provider descriptors;
- provider kind (`channel`, `agentRuntime`, or Dreamux service capability);
- capability descriptors such as MCP servers, reply capability, runtime delivery
  hooks, and provider-local config schemas;
- validation status.

Capability ids are namespaced by provider id to avoid collisions. Core consumers
must consume descriptors from the registry instead of constructing channel,
runtime, or MCP surfaces by hard-coded provider-specific names.

## Consequences

- Builtin providers become explicit extension points rather than special server
  branches.
- External provider syntax can be documented early without creating package
  loading or supply-chain risk in Phase 1.
- Startup validation must distinguish "unknown builtin", "reserved external
  provider", and "valid but unsupported in this phase".
- Registry descriptors become part of the review surface for future provider
  PRs.

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
