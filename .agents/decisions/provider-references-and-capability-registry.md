# Provider references and Capability Registry

- **Status:** Accepted, refined by
  [npm-package-split-and-channel-targets](npm-package-split-and-channel-targets.md)
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

Builtin provider descriptors are registered eagerly for both `agentRuntime`
(`builtin:codex`, `builtin:claude-code`) and `channel` (`builtin:feishu`).
External refs in `dispatchers[].runtime.provider` and
`dispatchers[].channels[].provider` are loaded before config validation by
dynamic-importing the installed package, selecting its default export or
`#named` export, calling the provider factory with the seed descriptor, and
registering the returned provider implementation into the same registry instance
used by config validation and server startup. Dreamux does not install provider
packages; a missing package, missing export, invalid provider contract, incomplete
capability declaration, or descriptor mismatch fails startup loudly with the
selected provider ref.

Issue #209 demotes the old "Capability Registry" idea into a process-local
provider registry / loader. Wired runtime providers attach their implemented
capabilities to the provider implementation. Codex and Claude Code both own the
same `AgentRuntimeProvider` interface with their own delivery shapes. Feishu owns
the `ChannelProvider` implementation behind `builtin:feishu`; core consumes it
through the channel catalog, the same shape future `npm:` channel providers use.
The registry records descriptors and implementation handles only; it does not
mirror or synthesize provider capabilities.

The provider registry is process-local and server-owned. It records:

- provider descriptors;
- provider kind (`agentRuntime` or `channel`);
- provider-local implementation handles;
- validation status.

Core consumers must consume runtime and channel providers from the registry view
instead of maintaining parallel provider maps. Provider-specific channel MCP
surfaces are contributed by the selected Channel provider and injected by the
Dispatcher Service; Team binding remains a Dreamux Team MCP capability.

## Consequences

- Builtin Agent Runtime and Channel providers become explicit extension points
  rather than special server branches.
- External provider packages use the same registry, lifecycle, and Dispatcher
  Service creation path as builtin providers of the same kind.
- Startup validation must distinguish "unknown builtin", "external package or
  export failed to load", "invalid provider contract", and "registered
  descriptor without runnable implementation".
- Feishu channel behavior is reviewed at the `@excitedjs/feishu-channel`
  provider boundary, not as core-owned special-case wiring.

## Alternatives considered

- **Hard-code builtin providers until external plugins exist:** rejected because
  Channel and Agent Runtime abstractions would still be shaped by Feishu and
  Codex implementation details.
- **Load only external runtimes, not channels:** superseded by issue #209.
  Bidirectional Channel providers now use the same provider loader/catalog shape.
  One-way subscription channels remain a separate reserved contract.
- **Use only object refs in config:** rejected for operator ergonomics. String
  refs are concise, while the normalized object form keeps implementation
  unambiguous.
