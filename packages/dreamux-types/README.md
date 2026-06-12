# @excitedjs/dreamux-types

Declaration-only provider-authoring contracts for **Dreamux**.

External Agent Runtime and Channel providers compile against this package for
Dreamux contracts and **must not** import `@excitedjs/dreamux`. The host package
owns Dispatcher/Team/TeamMate orchestration, provider loading, the Channel MCP
shim, binding state, routing, and authorization; this package owns only the
shared structural types.

## Guarantees

- **Declarations only.** The package emits `.d.ts` files (`emitDeclarationOnly`)
  and publishes a `types`-only `exports` map — there is no runtime JS contract
  surface to import as a value.
- **No runtime dependencies.** `package.json` declares only dev tooling.
- **No host-private types.** Provider create contexts here are neutral; Dreamux
  core adapts its private objects (dispatcher rows, stores, identity records)
  into these public shapes rather than exposing them.

## What it exports

- provider descriptor / ref shapes;
- the complete Agent Runtime provider contract: `AgentRuntimeProvider`,
  `AgentRuntime`, the neutral `AgentRuntimeCreateContext`, capabilities, role,
  skill sources, completion delivery, resume/last/context, MCP server
  descriptor, neutral state callbacks, and diagnostic helper shapes;
- Channel provider/session contracts, target shapes, inbound envelope shapes,
  tool descriptor/call shapes, and config/session contexts;
- a minimal public logger type (`DreamuxLogger`).

It does **not** export runtime implementations, default loggers, loader logic,
provider registry implementations, path helpers, config parsers, or Dreamux host
state models.

A provider implements the full contract against this package only — see
`tests/fixtures/external-provider.ts` for a complete `AgentRuntimeProvider`
(`readConfig` + `getCapabilities` + `createRuntime`) and a `ChannelProvider`
authored with `@excitedjs/dreamux-types` imports alone.

> **Core convergence is in progress.** Dreamux core's own launcher still threads
> a host-coupled create context internally; converging it onto the neutral
> public `AgentRuntimeCreateContext` (and deleting the host-coupled variant in
> `packages/dreamux/src/agent-runtime/types.ts`) is the runtime-split slice's job
> (issue #209 slice 3). The public target published here is already stable for
> external and built-in runtime/channel packages to author against.

## Build / test

Built and tested through the monorepo (rush) path — the only supported install
path (see [the install-model decision](../../.agents/decisions/install-model.md)).
From the repo root:

```sh
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js test
```

The design record is
[`.agents/decisions/npm-package-split-and-channel-targets.md`](../../.agents/decisions/npm-package-split-and-channel-targets.md).
