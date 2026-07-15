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
- the optional Task Channel Host contract: strict task-attempt submit/lookup/
  cancel, logical repository resolution, scoped capability negotiation,
  Core-pushed event batches, consecutive-prefix acknowledgement, and staged
  snapshot pagination;
- a minimal public logger type (`DreamuxLogger`).

It does **not** export runtime implementations, default loggers, loader logic,
provider registry implementations, path helpers, config parsers, or Dreamux host
state models.

A provider implements the full contract against this package only — see
`tests/fixtures/external-provider.ts` for a complete `AgentRuntimeProvider`
(`readConfig` + `getCapabilities` + `createRuntime`) and a `ChannelProvider`
authored with `@excitedjs/dreamux-types` imports alone.

## Task-capable Channels

A task-capable provider declares `task_channel_host_v1` separately from the
conversational Channel surface. During `ChannelSession.start`, it negotiates the
Core-created `ChannelRoutes.taskHost`, stages and atomically applies a complete
snapshot (or replays from a compatible durable cursor), and exposes
`ChannelSession.taskHostEvents`. Core then pushes committed execution telemetry
to that sink; the provider never polls host status and never uses replies,
reactions, provider tools, or model behavior as a synchronization mechanism.

The scoped host handle publishes its required capabilities, stable stream id,
stream generation, host status, and session fence. A superseding or detached
session revokes the handle. Logical repository submissions contain only a key
and optional policy revision; the trusted provider resolver maps that key to a
host-local repository policy before Core validates and pins it.

Snapshot pages are one immutable capture. An adapter must verify the shared
snapshot id, stream facts, watermark, total count, and consecutive item offsets,
stage every page, atomically install the projection only when `complete` is
true, durably persist the watermark, and then acknowledge that consecutive
prefix. The compile fixture demonstrates this protocol without local shadow
DTOs.

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
[`Task Channel Host`](../../.agents/decisions/task-channel-host.md). The package
split and root-export policy are recorded in
[`npm-package-split-and-channel-targets.md`](../../.agents/decisions/npm-package-split-and-channel-targets.md).
