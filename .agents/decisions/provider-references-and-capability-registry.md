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
and externally installed package/export providers. It also needs a registry that
lets Dreamux core discover runtime implementations without hard-coding every
runtime or MCP surface in the server.

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

Builtin Agent Runtime provider descriptors are registered eagerly. External
`agentRuntime` refs in `dispatchers[].runtime.provider` are loaded before config
validation by dynamic-importing the installed npm package, selecting its default
export or `#named` export, calling the provider factory, and registering the
returned provider implementation into the same registry instance used by config
validation and server startup. Dreamux does not install provider packages; a
missing package, missing export, invalid provider contract, or incomplete
capability declaration fails startup loudly with the selected provider ref.

External `channel` refs remain an interface-only reservation in this cycle.
They are parsed by the same provider-ref grammar, but config validation rejects
them because no external channel loader exists yet.

Issue #135 demotes the Capability Registry into a provider registry / loader for
the `agentRuntime` seam. Wired runtime providers attach their implemented
capabilities to the provider implementation. The Codex runtime provider declares
runtime lifecycle, Dreamux MCP injection, inbound turn submission, and
Codex-style TeamMate completion delivery capability metadata. Claude Code owns
the same AgentRuntime interface with its own delivery shape. External runtime
providers self-declare capabilities through the same `AgentRuntimeProvider`
contract; the registry does not mirror or synthesize them. Feishu is no longer a
provider-registry entry; it is a built-in bidirectional channel.

The provider registry is process-local and server-owned. It records:

- provider descriptors;
- provider kind (`agentRuntime` in the current implementation);
- provider-local implementation handles;
- validation status.

Core consumers must consume runtime providers from the registry view instead of
maintaining parallel provider maps. Channel MCP surfaces are owned by the
channel module and injected by the Dispatcher Service.

## Consequences

- Builtin Agent Runtime providers become explicit extension points rather than
  special server branches.
- External Agent Runtime packages use the same registry, lifecycle, and
  Dispatcher Service creation path as builtin providers.
- Startup validation must distinguish "unknown builtin", "external package or
  export failed to load", "invalid provider contract", and "registered
  descriptor without runnable implementation".
- Feishu channel behavior is reviewed at the channel module boundary, not as a
  registry provider descriptor.

## Alternatives considered

- **Hard-code builtin providers until external plugins exist:** rejected because
  Channel and Agent Runtime abstractions would still be shaped by Feishu and
  Codex implementation details.
- **Load external channel providers with external runtimes:** rejected for this
  cycle. Runtime provider loading is now implemented, while subscription-style
  channel plugins still need their own routing and push-delivery contract.
- **Use only object refs in config:** rejected for operator ergonomics. String
  refs are concise, while the normalized object form keeps implementation
  unambiguous.
