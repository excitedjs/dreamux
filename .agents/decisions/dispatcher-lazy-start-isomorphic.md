# Dispatcher Agent Lazy Start And Isomorphic Role Options

- **Status:** Accepted
- **Date:** 2026-07-04
- **Affects:** `@excitedjs/dreamux-types`, `@excitedjs/feishu-channel`,
  dispatcher service startup, channel MCP descriptors, scheduler wakeup,
  restart notification delivery, dispatcher role prompts and skills
- **PR / Issue:** [PR #282](https://github.com/excitedjs/dreamux/pull/282)

## Context

PR #282 started as a documentation-only branch for aligning Dispatcher agent
construction with TeamLeader construction and making the Dispatcher runtime
lazy. The first draft lived under `.agents/specs/`, which is not a valid KB
document kind, and it proposed delaying Dispatcher agent creation until channel
sessions were built. The goal is still valid, but the route should be grounded
in the current ownership boundaries before any package code changes.

Current source facts:

- Dispatcher role inputs are still hard-coded inside the inline
  `buildDispatcherLaunch()` path in
  `/packages/dreamux/src/service/dispatcher-service/agent.ts`.
- TeamLeader role inputs already flow through `TeammateServiceOptions`.
- `TeammateService.resolveLaunch()` applies options only on the `agent-ref`
  branch; the inline branch returns `buildLaunch()` directly.
- Channel MCP descriptors are currently owned by `ChannelSession`, even though
  the Feishu descriptor only builds a `channel-mcp` stdio descriptor from host
  context plus a static tool catalog.
- `channel-mcp` serves `tools/list` from static descriptor metadata; only
  `tools/call` routes through admin back to the live channel session or a
  provider sessionless handler.
- `Server.start()` still starts every enabled Dispatcher runtime eagerly.
- Dispatcher cron uses `absentRuntimeStrategy: 'miss'`, so a dormant runtime
  cannot be woken by scheduled input.
- `TeammateService.channelInput()` does not forward
  `InboundDeliveryHooks`, so moving Dispatcher channel delivery through the
  contained service without extending that method would drop channel acceptance
  hooks.
- `ChannelService.adopt()` currently makes a session map live immediately. A
  lazy-start boot split must not publish unstarted sessions through that live
  slot.

## Decision

Use provider-level channel MCP descriptor assembly and keep the Dispatcher agent
as a contained `TeammateService` created from stable construction-time options.
Do not add `mcpServersProvider`, do not add `onRuntimeStarted`, and do not make
the Dispatcher agent nullable just to wait for live channel sessions.

The Dispatcher keeps its legitimate inline differences: it resolves runtime
config from `dispatchers[].runtime`, persists thread/status through
`status.json`, and runs in the configured dispatcher workspace. The role-shaped
inputs that match TeamLeader, `mcpServers`, `skillSources`, `systemPrompt`, and
`disableFeatures`, must flow through `TeammateServiceOptions`.

## Technical Design

### Channel MCP Descriptor Ownership

Move the optional MCP descriptor method from `ChannelSession` to
`ChannelProvider<TConfig>`:

```ts
mcpServerDescriptor?(
  context: ChannelMcpDescriptorContext,
  config: TConfig,
): AgentRuntimeMcpServer | null;
```

The descriptor is a provider capability over provider config and host context.
It is not a live-session capability. Feishu's implementation moves from
`FeishuChannelSessionAdapter` to the provider object without changing the
descriptor shape. The generated descriptor still points at the generic
`channel-mcp` shim with provider, channel id, caller scope, static tool catalog,
and admin socket args.

Live tool semantics stay unchanged:

- `tools/list` is static metadata carried in the descriptor.
- `tools/call` still reaches `ChannelService.invokeTool()`.
- `reply` and `react` still require a live session.
- `list_chat_bots` can still use the existing sessionless provider handler when
  no live session exists.

`ChannelService` should expose the already-resolved dispatcher-scoped channel
configs through one small read method instead of duplicating config traversal in
`mcp-descriptors.ts`. The returned set is exactly the channels assigned to that
Dispatcher, never a process-wide channel list. Both Dispatcher and TeamLeader
channel MCP descriptor assembly should use that same config/provider path.

That read method must consolidate existing dispatcher-channel config traversal
rather than becoming another lookup path. In particular, implementation review
should reject a patch that adds a new `config.dispatchers.find(...)` loop in MCP
descriptor assembly while leaving the existing `ChannelSessions` /
`ChannelService` traversal split untouched.

### TeammateService Role Options

Make inline launch specs receive the same role options as `agent-ref` launch
specs. Add a small internal helper that applies `TeammateServiceOptions` to a
`RuntimeLaunchSpec` context.

For the inline path, options overwrite the four role-shaped fields:

- `skillSources`
- `mcpServers`
- `systemPrompt`
- `disableFeatures`

This avoids a hidden two-source merge where `buildLaunch()` and `options` can
both set the same field. The Dispatcher inline builder must stop setting those
fields directly. Implementation review should treat any new inline
`buildDispatcherLaunch()` assignment to these four fields as a regression.

### Dispatcher Agent Construction

Keep the Dispatcher agent constructed during `DispatcherService` construction.
Now that channel MCP descriptors are provider/config-derived, the agent no
longer needs live channel sessions to know its MCP servers.

`createDispatcherAgent()` should receive a static `mcpServers` array built from:

- provider-level channel MCP descriptors for each configured channel;
- the Team MCP descriptor;
- the TeamMate MCP descriptor;
- the Cron MCP descriptor.

`buildDispatcherLaunch()` should keep only Dispatcher-specific launch data:

- runtime provider and runtime config from `dispatchers[].runtime`;
- checkpoint id and runtime state from `DispatcherStore.bindRuntime(id)`;
- dispatcher workspace cwd from `resolveCwd()`;
- dispatcher host paths and logger.

Remove `liveChannels` and `adminSocketPath` from `DispatcherAgentDeps` once they
are no longer consumed by the inline launch builder.

### Dispatcher Boot And Lazy Runtime Start

Split Dispatcher startup into three responsibilities:

- prepare the dispatcher host and channel slots;
- start input sources;
- start the runtime.

`prepareChannels()` resolves the dispatcher workspace, validates runnable channel
shape, and builds channel sessions into a private prepared slot. It must not
publish those sessions through `ChannelService.live()`, must not start channel
sessions, and must not start the agent runtime. The prepared slot has one owner:
`DispatcherService`.

`startInputSources()` starts channel sessions, the Dispatcher scheduler, and
Team schedulers. It should be idempotent. Only after every channel session starts
successfully may the sessions be adopted into the `ChannelService` live slot.
If input-source startup fails, rollback must match today's `doStart()` cleanup:
stop schedulers, clear any live slot, close every built/prepared session, and
leave no half-published channel state behind.

Public `DispatcherService.start()` keeps the aggregate-level meaning used by
Server boot and admin `dispatcher.start`: it ensures the Dispatcher is prepared
and can receive inputs. It must not be narrowed into a runtime-only method.

An internal runtime-start method starts or resumes the contained Dispatcher agent
runtime through `agent.ensureStarted()`, then injects a restart notice only
through the existing `injectRestartNoticeIfNeeded()` path. The existing
`starting` guard semantics should remain the single runtime-start concurrency
guard.

Server boot changes to:

- prepare every enabled Dispatcher;
- for a `--notify-resumed` target that has a persisted checkpoint, start the
  runtime with the internal runtime-start method and inject the restart notice
  before starting input sources;
- then start input sources;
- for non-targets, start input sources while leaving the runtime dormant.

That ordering prevents inbound channel events or Dispatcher cron fires from
winning the first-start race and causing the restart notice to arrive after a
user or scheduled turn.

### Lazy Start Triggers

After boot, these inputs may start a dormant Dispatcher runtime:

- unbound channel inbound routed to the Dispatcher agent;
- Dispatcher cron with `absentRuntimeStrategy: 'submit'`;
- explicit restart-notification eager start during `Server.start()`.

Bound channel inbound that routes to an open Team should continue to wake the
TeamLeader only; it must not start the Dispatcher runtime.

`routeChannelInput()` should route unbound input through
`this.agent.channelInput(input, hooks)` instead of checking
`this.agent.getRuntime()` and returning `{ status: 'stopped' }`. The contained
service already owns `ensureStarted()` and the start concurrency guard.

`TeammateService.channelInput()` must accept optional `InboundDeliveryHooks` and
forward them to `runtime.channelInput(input, hooks)`. TeamLeader delivery must
use the same path: `DispatcherService.routeChannelInput()` passes hooks into
`TeamService.deliverToLeader(input, hooks)`, `TeamService` forwards them to
`leader.channelInput(input, hooks)`, and the routing-layer manual
`hooks.onAccepted` special case is removed. This makes acceptance timing one
contract for Dispatcher and TeamLeader channel turns.

### Restart Intent

Add a non-consuming `RestartIntentConsumer.hasTarget(dispatcherId, now)` method
for server boot ordering. It must apply the same TTL check as `claim()` so an
expired restart marker cannot eager-start a runtime that will not receive a
notice. Do not use `hasTarget()` for injection. Injection remains owned by
`claim()`, which is already single-use.

Do not add an `onRuntimeStarted` callback to `TeammateService`. It would serve
only this Dispatcher restart-notice concern, while the real ordering problem is
at the Server and Dispatcher input-source boundary.

## Acceptance Gates

- `.agents/scripts/check.sh` passes after the decision record move.
- The old `.agents/specs/` document is gone; the decision index links the new
  record.
- Dispatcher boot prepares channel sessions and starts input sources without
  starting the Dispatcher runtime for ordinary server starts.
- Unstarted prepared sessions are not visible through `ChannelService.live()`,
  channel MCP tool invocation, target ownership checks, or any other live-session
  read path.
- Public `DispatcherService.start()` remains an aggregate input-readiness method;
  runtime-only start is internal.
- An unbound channel inbound to a dormant Dispatcher starts the runtime,
  submits the turn, records the channel turn, and fires `onAccepted`.
- A bound channel inbound to a Team wakes the TeamLeader path and does not start
  the Dispatcher runtime.
- Bound TeamLeader channel input and unbound Dispatcher channel input use the
  same `InboundDeliveryHooks` forwarding path; no routing-layer manual
  `onAccepted` special case remains.
- A Dispatcher cron fire with no live runtime submits through
  `agent.scheduledInput()` and starts the runtime.
- A Dispatcher `stop()` racing an already-held scheduler fire cannot resurrect a
  runtime after shutdown begins.
- A `--notify-resumed` target with a checkpoint receives the restart notice
  before channel sessions and Dispatcher cron can deliver any other turn.
- A non-target, checkpoint-less Dispatcher, or Dispatcher targeted only by an
  expired restart intent does not start eagerly just because a restart intent
  file exists.
- Channel provider MCP descriptors still expose the same tool list and route
  tool calls back to live/sessionless provider handling as before.
- Provider-level channel MCP descriptor assembly uses only dispatcher-scoped
  channels.

## Consequences

- The channel provider contract changes, so this needs a Rush change file when
  implemented.
- Channel MCP descriptor ownership moves to the layer that owns static provider
  capability metadata.
- The Dispatcher agent no longer depends on live channel sessions for role MCP
  construction.
- Dispatcher scheduler semantics change intentionally: scheduled jobs can now
  wake a dormant Dispatcher runtime instead of being marked missed.
- Restart notice delivery remains explicit and one-shot; no new lifecycle
  callback is added to `TeammateService`.
- `status.json` remains the Dispatcher runtime state authority.
- The lazy-start boot split introduces prepared/input-source/runtime phases; the
  implementation must keep those phases single-owned and rollback-complete so
  they do not become competing state sources.

## Alternatives Considered

### Delay Dispatcher Agent Creation Until Channels Are Built

This was the original PR #282 route. It makes static `mcpServers` possible but
does so by making the Dispatcher agent nullable and by tying agent construction
to channel preparation. That treats the symptom, not the ownership issue:
channel MCP descriptors are still hanging off live sessions even though they are
static provider metadata.

### Add `mcpServersProvider`

A lazy provider would solve descriptor timing but add another construction
concept that TeamLeader does not need. It would make Dispatcher a special case
instead of making the shared contract cleaner.

### Add `onRuntimeStarted`

This would let Dispatcher inject restart notices after any lazy start path, but
restart notices only exist for the explicit `--notify-resumed` server-start
path. The real bug is input-source ordering during server boot, not a missing
generic lifecycle callback.

### Keep Dispatcher Runtime Eager

This avoids startup-order work but fails the main requirement. The Dispatcher
runtime should be dormant after ordinary server boot and start only when an
actual Dispatcher turn source needs it.
