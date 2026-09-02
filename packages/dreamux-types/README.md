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
  skill sources, completion delivery, `RuntimeAdmission`, canonical
  `RuntimeSubmission`/`RuntimeCompletion` settlement, resume checkpoints, provider-native
  transcript queries/pages/errors, MCP server descriptor, neutral state
  callbacks, and diagnostic helper shapes. Provider-native Turn identifiers,
  cursor positions, and transcript formats remain private inside provider
  packages;
- Channel provider/session contracts, target shapes, inbound envelope shapes,
  tool descriptor/call shapes, config/session contexts, optional strict
  collaboration operations, optional Channel-owned Command definitions
  (`ChannelCommandDefinition` / `ChannelCommandCapability`), and
  dispatcher-scoped read-only core event DTOs. Channel delivery receipts are
  status-only and the core event surface carries no service Turn
  submitted/settled events;
- a minimal public logger type (`DreamuxLogger`).

It does **not** export runtime implementations, default loggers, loader logic,
provider registry implementations, path helpers, config parsers, or Dreamux host
state models.

## Runtime admission contract

`RuntimeAdmission.failed` is reserved for a provider-proven pre-admission
failure, so a host may safely retry the same immutable input. `ambiguous` means
the input may have crossed the provider's native admission boundary; hosts must
not retry it automatically. An untyped throw or rejected input promise is
therefore ambiguous unless the provider can prove that no native command was
accepted.

`AgentRuntime.stop()` publishes its admission fence synchronously. It resolves
only after every `channelInput()` and `completionInput()` call that had already
started has settled and no such call can later return `submitted`. Providers
must terminate or release their own pending native requests before satisfying
that convergence contract.

## Native transcript contract

Every Agent Runtime provider implements `readTranscript(query, context)` as a
cold read: it must not start or resume a runtime. The query accepts only a turn
count, an opaque provider cursor, and an optional tool-block toggle. Pages use
provider-neutral message/tool blocks and the host supplies the fixed
262144-byte output budget.

`AgentRuntimeResumeCheckpoint` persists the provider-native session id and an
optional canonical `transcript_locator` atomically. The provider validates that
locator against its own native roots and session, rediscovers a moved native
transcript when supported, owns cursor validity/staleness, and returns
`scan_unsupported` when its bounded reader cannot safely continue. Native IDs,
filesystem locators, raw reasoning, and provider control records never appear
in transcript pages.

A provider implements the full contract against this package only — see
`tests/fixtures/external-provider.ts` for a complete `AgentRuntimeProvider`
(`readConfig` + `getCapabilities` + `readTranscript` + `createRuntime`) and a
`ChannelProvider` authored with `@excitedjs/dreamux-types` imports alone.

> **Core convergence is in progress.** Dreamux core's own launcher still threads
> a host-coupled create context internally; converging it onto the neutral
> public `AgentRuntimeCreateContext` (and deleting the host-coupled variant in
> `packages/dreamux/src/agent-runtime/types.ts`) is the runtime-split slice's job
> (issue #209 slice 3). The public target published here is already stable for
> external and built-in runtime/channel packages to author against.

## Channel Command contract

A Channel may serve Commands of its own by composing an optional
`ChannelCommandCapability` beside its session, exactly the way it composes
`mcp` — a Channel with no Commands omits the member rather than returning an
empty catalog. `definitions()` is read once per created instance, so a catalog
is immutable for the life of that instance.

A `ChannelCommandDefinition` is authored like a Core one — `version`,
`input`/`output` JSON schemas, `parse`, `execute` — with one difference: it
declares a single stable `local_name` segment and the host derives the
registered name from it by encoding the dispatcher-local channel id, so a
Channel can occupy neither a host name nor another Channel's namespace. The host
applies the same payload bounds, schema validation, and result canonicalization
it applies to its own Commands.

A business refusal belongs in the declared `output` schema, not in a thrown
error. This package is declaration-only and exports no error base a provider
could construct, and the host classifies any unrecognized throw from a handler
as `INTERNAL` with no stated next step — so a refusal a caller is meant to read
and act on must be a value `execute` returns and `output` declares. Reserve
throwing for genuine implementation faults.

The host also owns when those Commands answer. They become resolvable when the
dispatcher registers the session's catalog and start accepting calls only once
that session's `start()` has opened external I/O; between those points, and
again from the moment teardown fences admission, a call is refused with the
retryable `CHANNEL_COMMAND_UNAVAILABLE` rather than reported as an unknown
method.

## Build / test

Built and tested through the monorepo (rush) path — the only supported install
path (see [the install-model decision](../../.agents/tasks/architecture/npm-package-split/requirement.md#install-model)).
From the repo root:

```sh
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js test
```

The design record is
[`.agents/tasks/architecture/npm-package-split/requirement.md`](../../.agents/tasks/architecture/npm-package-split/requirement.md#npm-package-split-and-channel-targets).
