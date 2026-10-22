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
- **One runtime dependency, `tapable`, by type only.** The plugin hook contract
  is tapable's hook types; beyond it `package.json` declares only dev tooling.
- **No host-private types.** Provider create contexts here are neutral; Dreamux
  core adapts its private objects (dispatcher rows, stores, identity records)
  into these public shapes rather than exposing them.

## What it exports

- provider descriptor / ref shapes;
- the complete Agent Runtime provider contract: `AgentRuntimeProvider`,
  `AgentRuntime`, the neutral `AgentRuntimeCreateContext`, identity, system
  prompts, skill sources, `RuntimeAdmission`, canonical
  `RuntimeSubmission`/`RuntimeCompletion` settlement, leased state and event
  sinks, MCP server descriptors, and optional operational capabilities;
- live `RuntimeActivity` and cold `AgentActivityRecord` shapes, with recent
  activity queries/pages/errors. Provider-native turn identifiers, cursor
  positions, and history formats remain private inside provider packages;
- Channel provider/session contracts, target shapes, inbound envelope shapes,
  tool descriptor/call shapes, config/session contexts, optional strict
  collaboration operations, and dispatcher-scoped read-only core event DTOs.
  Channel delivery receipts are status-only and the core event surface carries
  no service Turn submitted/settled events;
- plugin contracts: `DreamuxPlugin`, its `ContributeHost` / `ServerHost`, the
  hooked `Dispatcher` / `Team` faces, `LaunchDraft`, and the
  `DreamuxPluginApis` map a plugin augments to type its published `api`;
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
only after every `submit()` call that had already started has settled and no
such call can later return `submitted`. Providers
must terminate or release their own pending native requests before satisfying
that convergence contract.

## Runtime event contract

`AgentRuntimeCreateContext.events` is the required synchronous
`AgentRuntimeEventSink` for live activity, `session.title.changed`, and
`turn.result`. The separate `state` sink persists identity and fences startup;
events are observations without a durable acknowledgement. Core admits events
only while their generation is current. Owners may enqueue accepted facts for
persistence, and catch and log observer failures without stopping the provider.

Publish every normal or failed native terminal once as `turn.result`, in native
terminal-finalization order and before submission settlement, including turns
with no host submission. Its `completion` must be the original immutable
`RuntimeCompletion` shared by every settlement answering that result. Object
identity is the host's folding key; cloning can duplicate reports.

Interrupted terminals, refusal, transport/connection loss and teardown do not
manufacture native results. Their existing bound settlements remain available.
Live activity remains display-only. Providers and hosts must implement the
required event sink; there are no separate activity/result sinks or compatibility
fallbacks.

## Runtime provider contract

`AgentRuntimeProvider<TConfig>` requires two methods:

- `createRuntime(context)` receives the neutral, immutable
  `AgentRuntimeCreateContext<TConfig>` and returns a handle with `start`,
  `submit`, `interrupt`, and `stop`. Core supplies parsed config, cwd, prior
  session identity, prompt alternatives, MCP servers, skill sources, and leased
  state/event sinks. A non-null prior session must resume continuous context;
  failure rejects rather than silently starting fresh.
- `readRecentActivity(query, context)` reads the native session without starting
  or resuming a runtime. It works while the session is growing and after the
  runtime closes. The query carries `sessionId`, optional opaque `cursor`,
  `limit`, and `includeTools`; the context supplies config, cwd, and a logger.
  A chronological page contains assistant text and tool names/statuses, optional
  `nextCursor`, and `truncated`. Tool arguments/results and native history paths
  do not appear in these records. Providers own native read and cursor bounds;
  recognized failures use the `AgentActivityError` contract.

Optional operational members are `config.read`, `onboard`, `diagnostic`
(`binChecks` and `runDiagnostic`), and `operatorStateRoot`. Registration identity
belongs to the host's descriptor, not the provider or live handle. Runtime
selection metadata comes from the host's configured runtime IDs, descriptions,
and tags; it is not a provider `getCapabilities` result or snapshot. Resume,
structured output, and recent activity reads are required behavior rather than
negotiated flags.

Built-in and external providers use this same neutral interface, defined in
[`src/agent-runtime.ts`](src/agent-runtime.ts) and
[`src/activity.ts`](src/activity.ts); Core constructs that context directly.

## Channel tool result contract

`ChannelMcpToolOutcome.text`, when nonempty, is the complete model-visible
success result. Include actionable addresses, outcomes and reminders in that
text: the MCP adapter forwards it verbatim in `content`, without
`structuredContent` or a serialized copy of `value`. Omitted or empty text
exposes `value` as structured content instead. A tool that can return nonempty
text must omit its advertised `outputSchema`; otherwise the MCP SDK rejects the
result after execution because structured content is absent.

## Plugin loading contract

A plugin factory returns its `DreamuxPlugin` synchronously; `config.read`
synchronously validates the plugin's config. Returning a thenable fails loading
with the ref or plugin name and phase. Loaded plugin names must be unique
ignoring ASCII case, so `Foo` and `foo` cannot coexist. A single mixed-case
name keeps its original API key and `state/plugins/<name>` spelling.

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
