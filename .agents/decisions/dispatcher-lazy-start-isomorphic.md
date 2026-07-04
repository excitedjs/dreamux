# Dispatcher Lazy Start And Agent-State Isomorphism

- **Status:** Accepted; implementation landed in this worktree
- **Date:** 2026-07-04
- **Affects:** `@excitedjs/dreamux-types`, `@excitedjs/feishu-channel`,
  dispatcher service startup, dispatcher runtime state, channel MCP descriptors,
  scheduler wakeup, restart notification delivery, dispatcher role prompts and
  skills
- **PR / Issue:** [PR #282](https://github.com/excitedjs/dreamux/pull/282)

## Context

PR #282 started as a documentation-only branch for aligning Dispatcher agent
construction with TeamLeader construction and making the Dispatcher runtime
lazy. The first draft lived under `.agents/specs/`, which is not a valid KB
document kind, and it proposed delaying Dispatcher agent creation until channel
sessions were built. This decision records the final design now implemented in
the current source: Dispatcher, TeamLeader, TeamMate, and Team member launches
all share the same identity-owned runtime state and launch boundary.

Current source facts:

- Dispatcher role inputs flow through `TeammateServiceOptions`, and Dispatcher
  runtime launch uses the same `TeammateService.resolveLaunch()` path as child
  roles.
- Dispatcher, TeamLeader, TeamMate, and Team member launches resolve provider
  config from `identity.agent_runtime -> agents[]`.
- The inline `buildDispatcherLaunch()` / `buildLaunch` launch fork and
  `applyRoleOptions()` helper are removed.
- Dispatcher writes and reads the root agent identity
  (`role: "dispatcher"`, `identity.json`, `turn.jsonl`) as authoritative runtime
  recovery state.
- Dispatcher runtime recovery no longer uses `DispatcherStore` or `status.json`.
  `DispatcherStore` is now a config-backed projection.
- `dispatchers[].agentRuntime` already points at a top-level `agents[].id`; the
  resolved `dispatchers[].runtime` field is config-load output, not a separate
  operator-facing runtime declaration.
- `dispatcherIdentity()` and `ensureDispatcherIdentity()` provide the explicit
  root identity read/ensure accessors. The identity parser round-trips
  `role: "dispatcher"`, while teammate collection lookup keeps the root
  Dispatcher non-enumerable and non-addressable.
- `providerRuntimeId()` derives provider-facing labels from identity: root
  Dispatcher keeps the bare dispatcher id, and child roles use scoped labels.
- `AgentRuntimePathContext` exposes `cacheDir()`, `logsDir()`, and
  `runtimeSocketDirs()`; the old writable `dispatcherDir(id)` provider state
  seam is removed. The durable `<state>/<dispatcherId>/runtime/<name>` path,
  `dispatcherTeamMateRuntimeDir()`, and `teammateHostPaths()` are removed.
- Claude Code MCP config is passed as inline `--mcp-config` JSON. Its skill
  adapter lives under the global cache root, is keyed by canonical source set,
  is atomically published, and is never refreshed in place.
- Channel MCP descriptors have moved to provider-level config assembly. The
  Feishu descriptor builds a `channel-mcp` stdio descriptor from host context
  plus a static tool catalog.
- `channel-mcp` serves `tools/list` from static descriptor metadata; only
  `tools/call` routes through admin back to the live channel session or a
  provider sessionless handler.
- `Server.start()` calls the aggregate `DispatcherService.start()` for each
  enabled Dispatcher. The ordering for prepare, restart-notice eager runtime
  start, channel-session start, and scheduler start is owned inside
  `DispatcherService`.
- Dispatcher cron already uses `absentRuntimeStrategy: 'submit'`, so scheduled
  input can wake a dormant runtime.
- `InboundDeliveryHooks` are already forwarded through Dispatcher and TeamLeader
  channel input paths.
- `ChannelService.adopt()` currently makes a session map live immediately. A
  lazy-start boot split must not publish unstarted sessions through that live
  slot.

## Decision

Use provider-level channel MCP descriptor assembly and keep the Dispatcher agent
as a contained `TeammateService` created from stable role options. Do not add
`mcpServersProvider`, do not add `onRuntimeStarted`, and do not preserve the
inline runtime-launch fork.

Remove the remaining dispatcher runtime-state fork instead of wrapping it in a
new resolver abstraction. Dispatcher, TeamLeader, and TeamMate are all agent
entities whose runtime recovery state is their `identity.json` record.
The dispatcher root `identity.json` becomes the authoritative Dispatcher runtime
state. `status.json` must stop being the Dispatcher runtime recovery authority.

Dispatcher runtime provider/config resolution uses the same
`identity.agent_runtime -> agents[]` path as TeamLeader and TeamMate. The
Dispatcher aggregate may still own channel sessions, teams, schedulers, routing,
and restart notices, but it should not own a parallel runtime-state entity.

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

Keep role surface as `TeammateServiceOptions` for every agent entity. Options
overwrite the four role-shaped fields:

- `skillSources`
- `mcpServers`
- `systemPrompt`
- `disableFeatures`

The runtime launch path should not set or merge these fields separately. Once
the inline launch fork is removed, Dispatcher, TeamLeader, TeamMate, and Team
member launches all receive role surface through the same option path.

### Dispatcher Runtime State Authority

Promote the dispatcher root agent identity from a write-only debug record into
the authoritative Dispatcher runtime identity.

The dispatcher root `identity.json` should carry the same recovery fields used
by TeamLeader and TeamMate:

- `agent_runtime`: the dispatcher config's `agentRuntime` reference;
- `session_id`: the runtime-native checkpoint id;
- `status`: the normalized runtime status;
- `last_error`: the latest runtime error;
- rolling turn metadata where normal `TeammateService` turn recording applies.

During dispatcher preparation, before constructing the contained Dispatcher
`TeammateService`, ensure that the root dispatcher identity exists and is
current with config-owned identity facts:

- `name: "dispatcher"`;
- `role: "dispatcher"`;
- `team_id: null`;
- `agent_runtime` from `dispatchers[].agentRuntime`;
- `cwd`, `source_cwd`, and `runtime_cwd` from the validated dispatcher
  workspace;
- `worktree.mode: "reuse-cwd"`.

If a dispatcher root identity already exists, preserve runtime-owned recovery
fields only when they are still compatible with the runtime selected by the
current dispatcher declaration. A checkpoint id is runtime-native state scoped to
both the runtime implementation and the runtime workspace context. It must not
be handed to a different runtime provider or to the same provider under a
different workspace identity. At minimum, if the dispatcher config changes
`dispatchers[].agentRuntime`, `cwd`, `runtime_cwd`, or the worktree identity away
from the identity's previous values, clear `session_id`, reset the runtime status
to a non-running state (`stopped`), and clear provider-specific error state
before constructing the runtime. A future provider may explicitly declare a
checkpoint portable across some workspace changes, but current built-in
providers should be treated as workspace-bound. Do not emit a restart-resumed
notice for a checkpoint that was cleared by this compatibility gate.

When the runtime and workspace selection are compatible, preserve runtime-owned
recovery fields such as `session_id`, `status`, `last_error`, and rolling turn
metadata. Update only config-owned fields that must track the current dispatcher
declaration. This keeps restart/resume state in one place while making
checkpoint invalidation explicit for runtime or workspace changes.

The identity ensure step must be an upsert merge, not a call to the existing
`create()` path. Existing identities keep compatible runtime-owned fields such
as `session_id`, `status`, `last_error`, `created_at`, `turn_count`,
`last_seen_at`, and turn previews. The ensure step overwrites only config-owned
fields that must reflect the current dispatcher declaration, plus the explicit
checkpoint/status/error cleanup when runtime selection changes. It must complete
before the `TeamMateRuntimeStateStore` is constructed and before any runtime
state callback can write the same identity, so there is a single writer snapshot
for the dispatcher identity during preparation.

This merge requirement is separate from the provider-facing runtime instance
key. TeamLeader and TeamMate identities are created once when the entity is
spawned and are later read back during rebuild/start; server boot does not
re-create them from config. Dispatcher is config-declared, so every server boot
must reconcile config-owned facts onto the root dispatcher identity. Once
`identity.json` becomes the runtime recovery authority, that reconciliation must
not erase the same file's runtime-owned recovery fields.

The identity store must round-trip the dispatcher role. Reading a persisted
`role: "dispatcher"` identity must not coerce it to `teammate`. Add an explicit
dispatcher-root read/ensure accessor for `DispatcherService`; do not overload
the dispatcher-scope teammate `get()` path, because that path intentionally
probes only `teammate/<name>/`.

The contained Dispatcher `TeammateService` is constructed from the
loaded dispatcher identity and uses `TeamMateRuntimeStateStore` over that
identity. Its runtime state callbacks then update `identity.json` exactly like
TeamLeader and TeamMate.

`DispatcherStore` no longer binds runtime callbacks or reads `status.json` as a
recovery source. Dispatcher list/view state is config-backed: dispatcher id,
enabled flag, and neutral channel identity. Runtime status, checkpoint id, and
last error are read from the
dispatcher agent identity and the live runtime.

This intentionally overturns the previous state-layout compromise where
Dispatcher runtime recovery lived in `status.json`. `status.json` is removed
from the current runtime state contract. Do not import it into
`identity.json`, do not keep reading it as a fallback, and do not fail server
boot only because a retired `status.json` file is present. Record the retirement
in the Rush changelog so the upgrade dispatcher/operator can handle stale local
state deliberately. The changelog must state that a dispatcher whose only
checkpoint lived in the retired `status.json` will start a fresh runtime after
upgrade unless the upgrade dispatcher/operator explicitly seeds the root
`identity.json` with a compatible `session_id`.

### Dispatcher Agent Construction

Construct the contained Dispatcher agent after the dispatcher root identity is
loaded/ensured, not before. This is an async preparation step because
`identity.json` is now authoritative state, not a best-effort debug artifact.
The agent still does not depend on live channel sessions: channel MCP
descriptors are provider/config-derived.

Because the contained agent is no longer synchronously available in the
`DispatcherService` constructor, do not let nullable access spread through the
service. Keep a single private agent slot owned by the existing prepare
transaction and expose it internally through `mustAgent()`. Scheduler callbacks,
channel routing, team-leader forwarding, and status helpers must either be
created after preparation or call `mustAgent()` only after the aggregate start
has prepared the Dispatcher. A failed preparation must not leave a half-created
agent published as live.

`createDispatcherAgent()` should receive a static `mcpServers` array built from:

- provider-level channel MCP descriptors for each configured channel;
- the Team MCP descriptor;
- the TeamMate MCP descriptor;
- the Cron MCP descriptor.

The Dispatcher inline launch path is removed rather than moved behind another
abstraction:

- `TeammateServiceLaunch = agent-ref | inline` is gone;
- `TeammateServiceDeps.buildLaunch` is gone;
- `buildDispatcherLaunch()` is gone;
- `TeammateService.resolveLaunch()` resolves every role from
  `identity.agent_runtime -> agents[]`;
- role surface options apply uniformly without an inline-branch helper.

`TeammateService.assertOwnRoster()` should accept the dispatcher root identity
explicitly (`role: "dispatcher"`, `team_id: null`, fixed dispatcher-agent name)
for the contained Dispatcher service instead of using `buildLaunch ===
undefined` as a proxy for roster membership. That allowance must not widen
`TeammateCollection`: dispatcher root identity remains outside the
`teammate/` collection, is not enumerable through teammate list/history, and is
not addressable through teammate send/status/last/close verbs.

The fixed Dispatcher agent name (`dispatcher`) is reserved. Teammate spawn/name
allocation must not create an ordinary teammate with that name, and admin
teammate entry points should treat it as unavailable rather than resolving the
root Dispatcher identity.

Do not keep a separate runtime-id selection branch in Dispatcher launch code.
Runtime launch should derive the provider-facing runtime instance key from the
already-loaded agent identity through one shared helper. That helper may inspect
the identity role for label compatibility: the root Dispatcher identity maps to
the bare `dispatcher_id`, while TeamLeader, TeamMate, and Team member identities
map to their scoped child-agent labels. This is a provider launch label only: it
is not persisted as recovery state, not a host path selector, and not a second
identity model.

Keep the public provider-facing `AgentRuntimeIdentity.runtime_id` field for this
implementation slice because built-in and external runtime providers use it as a
neutral instance label for logs, diagnostics, and socket error context. It
should become a derived launch value, not a separate Dreamux entity. Removing or
renaming that public field is a later provider-contract cleanup, not a
prerequisite for deleting `status.json` or the runtime scratch directory.

Collapse the previous three-layer story into two durable layers plus one
ephemeral launch label:

- entity identity is the host entity record and turn log location. Dispatcher is
  the root entity named `dispatcher`; TeamLeader, TeamMate, and Team member are
  child entities under team/teammate collections.
- runtime instance key is the provider-visible `runtime_id` field for now, but
  it is derived mechanically from the agent identity and has no storage
  authority. The derivation must be one shared helper over `TeamMateIdentity`.
  Dispatcher keeps the bare dispatcher id as its label for log/socket/diagnostic
  continuity; child roles receive scoped child-agent labels.
- runtime scratch is provider-owned and must not create a durable child-runtime
  state directory. Runtime recovery belongs in identity, logs belong under the
  logs root, sockets belong under run/socket roots, and provider launch config
  should be inline or rebuildable.

### Agent Runtime Path Context

Deleting `<state>/<dispatcherId>/runtime/<name>` required changing the neutral
provider path seam, not only deleting a host path helper. The current public
`AgentRuntimePathContext` no longer exposes the former writable
`dispatcherDir(id)` runtime state root. Keeping that method would have either
preserved the child runtime directory or tempted an implementation to point
provider scratch at the dispatcher root, where `identity.json`, `turn.jsonl`,
channel bindings, and team/teammate collections live.

The replacement is `AgentRuntimePathContext.cacheDir(): string`. This returns
the global Dreamux cache root, not `dispatcherCacheDir(dispatcherId)`: provider
cache artifacts that are keyed only by role inputs must be able to converge
across dispatchers. The cache root is rebuildable, droppable provider working
storage. It is not recovery state and must not be used for checkpoints,
identity, turn history, channel bindings, or admin state. `logsDir()` and
`runtimeSocketDirs()` remain the log and volatile socket seams.

Built-in runtime updates follow from that contract and are part of the landed
implementation:

- Codex continues to use `logsDir()` and `runtimeSocketDirs()` and does not
  need a writable dispatcher state directory.
- Claude Code passes MCP config inline and writes its shared skill compatibility
  adapter under `cacheDir()`.
- No built-in runtime writes under the dispatcher root state directory or under
  `<state>/<dispatcherId>/runtime/<name>`.

This is a public `@excitedjs/dreamux-types` contract change. Built-in providers,
tests, fixtures, and Rush change files are updated together.
If an external provider used `dispatcherDir()` for scratch, it should move that
scratch to `cacheDir()`. If it used `dispatcherDir()` for recovery, that was an
invalid layering dependency and must be replaced with the neutral checkpoint
contract (`identity.checkpoint_id` plus runtime state callbacks).

Claude Code does not require a `mcp.json` file for Dreamux-owned MCP servers.
Its `--mcp-config` option accepts JSON strings as well as JSON file paths, and
the CLI parser attempts JSON parsing before falling back to path loading.
Dreamux should pass the rendered MCP config as an inline JSON argument instead
of writing `mcp.json` under a runtime scratch directory.

Claude Code role skills are the only remaining reason the current
implementation writes a child runtime scratch directory: the runtime materializes
Dreamux direct skill roots into a `.claude/skills` tree and passes that tree via
`--add-dir`. That adapter is rebuildable launch data, not durable state.

The Claude Code runtime owns this compatibility adapter under the Dreamux cache
root, not under a per-runtime state path. The neutral runtime path context
provides the cache-root capability so the runtime does not hard-code
`~/.dreamux/cache`. For a given launch, the runtime scans the passed
`skillSources`, deduplicates repeated roots, and derives a content-addressed
cache key for the adapter it publishes. The preferred adapter keeps symlinks to
the canonical source skill directories, so the key may be a source-set key
derived from resolved skill names plus canonical target paths: skill file content
changes are observed through the symlinks without rebuilding the adapter. If an
implementation copies skill files instead of symlinking source directories, the
key must include a real content digest or stable version stamp so immutable
cache entries cannot serve stale skill content. The runtime publishes one shared
`<cacheRoot>/claude-code/skills/<key>/.claude/skills` tree and passes the adapter
root through `--add-dir`.

The adapter is immutable after publication. Building must be idempotent and
concurrency-safe: if the target key already exists, trust it; otherwise build in
a temporary sibling directory and atomically publish it. A losing concurrent
builder discards its temp directory after observing the published target. Never
`rm -rf` or refresh an adapter directory that a live runtime may be using.
Duplicate skill names from distinct roots should fail loud because Claude Code
would otherwise see an ambiguous skill.

The current Dreamux role surface has only two non-empty bundled skill source
sets, Dispatcher and TeamLeader, so the cache should converge to two shared
adapter directories rather than one directory per runtime instance. Empty
`skillSources` should produce no adapter and no `--add-dir`.

Do not keep `<state>/<dispatcherId>/runtime/<name>` as a contract.

`liveChannels`, `adminSocketPath`, and `DispatcherStore` runtime-state
dependencies are removed from `DispatcherAgentDeps`.

Do not add a separate `prepareAgent()` single-flight or a second nullable
prepared-agent slot. Fold dispatcher identity ensure and contained-agent
construction into the existing Dispatcher preparation transaction that already
owns workspace validation and channel-slot preparation. `stop()` waits on that
same transaction, so preparation remains one lifecycle boundary.

### Dispatcher Boot And Lazy Runtime Start

Split Dispatcher startup into three responsibilities inside `DispatcherService`:

- prepare the dispatcher host, dispatcher agent identity, and channel slots;
- start input sources;
- start the runtime.

Preparation resolves the dispatcher workspace, ensures the dispatcher root
identity, constructs the contained Dispatcher agent, validates runnable channel
shape, and builds channel sessions into a private prepared slot. It must not
publish those sessions through `ChannelService.live()`, must not start channel
sessions, and must not start the agent runtime. The prepared channel slot has
one owner: `DispatcherService`.

`startInputSources()` starts channel sessions, the Dispatcher scheduler, and
Team schedulers. It should be idempotent. Each channel session is adopted into
the `ChannelService` live slot only after that session's own `start()` succeeds;
sessions that have not started are never live. If input-source startup fails,
rollback must match today's `doStart()` cleanup: stop schedulers, clear any live
slot, close every built/prepared session, and leave no half-published channel
state behind.

Public `DispatcherService.start()` keeps the aggregate-level meaning used by
Server boot and admin `dispatcher.start`: it ensures the Dispatcher is prepared
and can receive inputs. It must not be narrowed into a runtime-only method.

An internal runtime-start method starts or resumes the contained Dispatcher agent
runtime through `agent.ensureStarted()`, then injects a restart notice only
through the existing `injectRestartNoticeIfNeeded()` path. The existing
`starting` guard semantics should remain the single runtime-start concurrency
guard.

Scheduler lazy-start must respect shutdown before starting a runtime. The
`shouldSubmit` guard carried by held scheduler fires must be checked before
`ensureStarted()` and checked again before submitting to the live runtime. If
`stop()` clears the held-fire token while a scheduler fire is in flight, the
fire returns `skipped` without starting a dormant runtime and without delivering
a completion input.

Server boot keeps the current aggregate boundary: it calls
`DispatcherService.start()` for each enabled Dispatcher. The service-owned start
transaction prepares the Dispatcher, then, for a `--notify-resumed` target whose
dispatcher identity has a persisted `session_id`, starts the runtime with the
internal runtime-start method and injects the restart notice before starting
channel sessions or schedulers. Non-targets start input sources while leaving
the runtime dormant.

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
for service-owned boot ordering. It must apply the same TTL check as `claim()`
so an expired restart marker cannot eager-start a runtime that will not receive
a notice. The eager-start gate checks the dispatcher identity's `session_id`,
not a dispatcher status row. Do not use `hasTarget()` for injection. Injection
remains owned by `claim()`, which is already single-use.

Do not add an `onRuntimeStarted` callback to `TeammateService`. It would serve
only this Dispatcher restart-notice concern, while the real ordering problem is
at the Server and Dispatcher input-source boundary.

## Required Deletions And Boundaries

The second Dispatcher runtime-state machine is deleted rather than bypassed:

- `buildDispatcherLaunch()` and the `DispatcherAgentDeps` dependency on
  `DispatcherStore` are gone;
- the inline launch variant, `TeammateServiceDeps.buildLaunch`, and the inline
  branch in `TeammateService.resolveLaunch()` are gone;
- `applyRoleOptions()` is gone because role options are applied in the single
  launch path;
- `DispatcherStore.bindRuntime()` and all `AgentRuntimeStateCallbacks` methods
  on `DispatcherStore` are gone;
- `DispatcherStore` persistence/hydration over `status.json` is gone, including
  `DispatcherStatusFile`, `readStatusFile()`, `rowFromConfig()` status merging,
  and `dispatcherStatusPath()` callers;
- `DispatcherRow` is shrunk to config-backed display fields such as dispatcher id,
  enabled flag, channel identity, and timestamps that truly belong to the config
  projection;
- the durable child runtime scratch path
  `<state>/<dispatcherId>/runtime/<name>`, `dispatcherTeamMateRuntimeDir()`, and
  the `teammateHostPaths()` role-specific state-root adapter are gone;
- `AgentRuntimePathContext.dispatcherDir(id)` is replaced with a cache-root
  seam, and every built-in provider, test fixture, diagnostic path context, and
  Rush change file that consumes the public type is updated;
- Claude Code MCP config is inline and Claude Code role skills use the shared
  cache-root adapter described above.

Do not recreate `last_lost_thread_id`, `last_started_at`, or `last_ready_at` on
the dispatcher identity just to preserve the old `status.json` shape. Those were
DispatcherStore/status-file diagnostics. The unified model reports checkpoint,
status, last error, and rolling turn summary from identity plus live runtime.

Keep these boundaries:

- dispatcher identity stays at the dispatcher root, not under `teammate/`;
- `TeammateCollection` continues to enumerate only physical teammate/member
  collections and continues to reject `role: "dispatcher"`;
- provider-facing runtime instance keys are derived from agent identity through
  one shared launch helper and are never a durable state or path contract;
- child runtime scratch does not belong in durable dispatcher state;
- `DispatcherService` continues to own channels, teams, schedulers, routing, and
  restart intent;
- provider-level channel MCP descriptor assembly remains dispatcher-scoped and
  independent of runtime recovery state.

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
  runtime after shutdown begins; the guarded scheduler fire skips before
  `ensureStarted()` when `shouldSubmit` is already false.
- A `--notify-resumed` target with a dispatcher identity checkpoint receives the
  restart notice before channel sessions and Dispatcher cron can deliver any
  other turn.
- A non-target, checkpoint-less Dispatcher, or Dispatcher targeted only by an
  expired restart intent does not start eagerly just because a restart intent
  file exists.
- Dispatcher runtime recovery uses the dispatcher root `identity.json`, not
  `status.json`.
- `buildDispatcherLaunch()`, `TeammateServiceDeps.buildLaunch`, and the inline
  launch branch are gone.
- `TeammateService.resolveLaunch()` resolves Dispatcher, TeamLeader, TeamMate,
  and Team member runtimes from `identity.agent_runtime -> agents[]`.
- Dispatcher identity ensure preserves compatible `session_id`, `status`,
  `last_error`, and rolling turn metadata across restart while updating
  config-owned fields.
- Dispatcher identity ensure clears `session_id` and provider-specific runtime
  status/error when `agent_runtime`, `cwd`, `runtime_cwd`, or worktree identity
  changes, unless a future provider explicitly declares the checkpoint portable
  across that workspace change. No restart-resumed notice is injected for a
  cleared checkpoint.
- Dispatcher preparation has one single-flight transaction; there is no separate
  `prepareAgent()` lifecycle cache.
- The contained Dispatcher agent is accessed through one prepared-agent slot and
  `mustAgent()`; nullable access does not spread through channel routing,
  scheduler callbacks, team forwarding, or status helpers.
- The identity parser round-trips `role: "dispatcher"`.
- The fixed name `dispatcher` is reserved for the root Dispatcher identity and
  cannot be spawned as an ordinary teammate/member.
- `TeammateService.assertOwnRoster()` accepts the contained Dispatcher identity
  explicitly; `TeammateCollection` and teammate admin verbs do not enumerate or
  address the Dispatcher root identity.
- Dispatcher, TeamLeader, TeamMate, and Team member launches use the same
  identity-derived runtime instance key helper. That helper returns the bare
  dispatcher id for `role: "dispatcher"` and scoped child-agent labels for
  TeamLeader, TeamMate, and Team member. There is no inline launch fork or
  role-specific path/state model.
- `AgentRuntimePathContext` no longer exposes `dispatcherDir(id)` as a writable
  provider state root. It exposes a rebuildable cache-root seam, plus logs and
  socket seams.
- TeamLeader/TeamMate runtime start does not create
  `<state>/<dispatcherId>/runtime/<name>`. Claude Code MCP config is passed
  inline, and Claude Code skill compatibility trees are shared under the Dreamux
  cache root by skill-source set rather than under per-runtime state.
- `AgentRuntimePathContext.cacheDir()` maps to the global Dreamux cache root, not
  a per-dispatcher cache directory, so identical Dispatcher/TeamLeader skill
  source sets converge across dispatchers.
- Claude Code skill adapter publication is concurrency-safe and immutable:
  concurrent same-key builders cannot expose an empty or partially-built
  `.claude/skills` tree, and no live adapter directory is removed or refreshed
  in place.
- Claude Code skill adapter keys match the artifact strategy: symlink adapters
  are keyed by canonical source set, while copied adapters are keyed by content
  digest or stable version stamp so immutable cache entries cannot serve stale
  copied skill content.
- Tests prove built-in runtimes do not write provider scratch under either
  `<state>/<dispatcherId>/runtime/<name>` or the dispatcher root state directory.
- Tests pin provider-facing runtime labels: Dispatcher keeps bare
  `dispatcher_id`; TeamLeader, TeamMate, and Team member use scoped child-agent
  labels. The helper is shared, but Dispatcher log/socket/diagnostic labels do
  not migrate to a child-agent hash form.
- Dispatcher admin/status/list surfaces report runtime status, checkpoint id,
  and last error from the dispatcher identity plus live runtime, not from a
  parallel status row.
- Retired `status.json` files are not imported and do not block boot merely by
  existing; the upgrade note is recorded in the Rush change file.
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
- `status.json` no longer remains the Dispatcher runtime state authority. The
  dispatcher root `identity.json` is the runtime recovery source. Existing
  `status.json` files are retired local state and are documented in the
  changelog, not migrated at runtime. The changelog explicitly notes that
  checkpoints left only in `status.json` are not resumed automatically.
- The lazy-start boot split keeps prepared/input-source/runtime phases inside
  `DispatcherService`; those phases stay single-owned and rollback-complete so
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

### Add A Runtime Launch Source Wrapper

A shared `RuntimeLaunchSource` wrapper would make the two launch paths look
similar but would preserve the underlying duplication: ordinary agents would
still recover from `identity.json`, while Dispatcher would still recover from
`status.json`. The target is to remove the second runtime-state entity, not to
hide it behind a new abstraction.

### Keep `status.json` As Dispatcher Runtime State

This was the earlier state-layout compromise. It kept Dispatcher recovery
working while the dispatcher agent was still outside the normal agent-entity
model, but the dispatcher root now already has an agent identity location.
Keeping `status.json` would leave Dispatcher recovery permanently different from
TeamLeader and TeamMate recovery.

### Keep Dispatcher Runtime Eager

This avoids startup-order work but fails the main requirement. The Dispatcher
runtime should be dormant after ordinary server boot and start only when an
actual Dispatcher turn source needs it.
