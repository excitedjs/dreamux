# Technical Design: Minimal Provider Boundaries

## Status and authority

This is the authoritative technical solution for the frozen requirement at
`requirement.md` SHA-256
`349635060d19afe73ed3d1e84df5070bce225364553389f5074c624180598a07`.

It reconciles the three independent proposals and their single cross-review
round. Where proposals disagreed, this design follows the frozen requirement
and current source behavior rather than reviewer votes. It changes no product
code and does not grant development approval.

## Decision summary

The refactor replaces two growing provider contracts with capability-neutral
ports:

- a live Agent Runtime has only `start`, `submit`, and `stop`;
- runtime state flows only from the runtime into a Core-owned leased state
  sink;
- every Agent Runtime Provider supports context-continuous recovery,
  session-bound structured output, and neutral recent Activity Records;
- live runtime activity remains optional and feeds the existing COT projection;
- a Channel session is controlled directly in-process through lifecycle
  methods;
- Channel-to-Core mutation uses one generic `invoke(command, payload)` port;
- Core-to-Channel observation uses one live, best-effort subscription port;
- Agent-to-Channel MCP remains a separate optional composition;
- the initial Channel Command catalog contains only `team.submit` and
  idempotent `team.create`;
- the initial Channel event catalog contains only `team.state`, `teammate.state`,
  `teammate.turn.submitted`, `teammate.turn.settled`,
  `teammate.turn.message`, and `teammate.turn.tool_call`;
- external binding and provisioning become Channel-owned;
- Core binding and Collaboration Space authorities are deleted;
- scheduler and dissolve no longer depend on runtime idleness.

The new seams are deliberately incompatible. There are no compatibility
adapters, deprecated aliases, dual-write periods, or automatic state migrations.

## Ownership after the change

| Owner | Responsibilities |
| --- | --- |
| Dreamux Core | Team and Agent state, runtime ownership, Command schemas and execution, admission and settlement, Team-create idempotency, event schemas and projection, state persistence, dissolve safety, MCP forwarding and caller context |
| Agent Runtime Provider | Native process/session lifecycle, context restoration, schema adaptation, native activity discovery and normalization, optional live activity emission |
| Channel Provider | External transport, message interpretation, Command selection, external-route bindings, target hierarchy, provisioning saga, Channel-owned configuration/state, external rendering, Channel MCP tools |
| `@excitedjs/dreamux-types` | Neutral contracts and catalog types only; no provider-specific paths, selectors, or runtime-native record formats |

Core never branches on a provider id and never re-derives Channel-owned target
meaning. Channel never becomes an alternate owner of Team, Agent, Workflow, or
scheduler state.

## 1. Agent Runtime contract

### 1.1 Provider facade

Keep one provider facade for selection and creation, with optional operational
capabilities composed as optional objects rather than fake methods:

```ts
interface AgentRuntimeProvider<
  TConfig,
  TSession extends AgentRuntimeSessionRef = AgentRuntimeSessionRef,
> {
  getCapabilities(): AgentRuntimeProviderCapabilities;
  readRecentActivity(
    query: AgentActivityQuery<TSession>,
    context: AgentActivityReadContext<TConfig>,
  ): Promise<AgentActivityPage>;
  createRuntime(
    context: AgentRuntimeCreateContext<TConfig, TSession>,
  ): Promise<AgentRuntime>;

  readonly config?: AgentRuntimeConfigCapability<TConfig>;
  readonly onboard?: AgentRuntimeOnboardCapability;
  readonly diagnostic?: AgentRuntimeDiagnosticCapability;
}

interface AgentRuntimeProviderCapabilities {
  readonly tags: readonly string[];
  readonly publicConfig?: Readonly<Record<string, JsonValue>>;
}
```

Provider registration identity is Core-owned loader metadata, not a Provider
capability. The Provider interface therefore has no `ref` or `descriptor`
member. Core parses the configured canonical reference, validates its kind, and
keeps that descriptor beside the loaded implementation:

```ts
interface RegisteredProvider<TProvider> {
  readonly descriptor: ProviderDescriptor;
  readonly implementation: TProvider;
}
```

The loader never asks a Provider to echo metadata Core already owns. Registry
lookup, duplicate detection, diagnostics, onboarding, logging, and MCP naming
read from the registered wrapper. A direct capability invocation that needs a
provider id or canonical ref receives only that value in its operation context;
the implementation itself does not become a second identity authority.

`getCapabilities()` is provider-static and zero-argument. Current Core has no
config-resolved consumer, so adding parsed config would widen the seam without a
use case. `publicConfig` is optional, bounded, explicitly projected metadata;
raw provider config, environment variables, paths, credentials, and secrets are
forbidden. Recovery, structured output, and live activity are not capability
bits: the first two are mandatory, while absence of live activity changes only
presentation.

Provider identity is not echoed by either the facade or a live runtime.

### 1.2 Create context and session identity

Core supplies the neutral facts required to launch a Dreamux role:

```ts
interface AgentRuntimeCreateContext<
  TConfig,
  TSession extends AgentRuntimeSessionRef,
> {
  readonly identity: AgentRuntimeIdentity<TSession>;
  readonly config: TConfig;
  readonly cwd: string;
  readonly systemPrompt?: string;
  readonly mcpServers: readonly AgentRuntimeMcpServer[];
  readonly skillSources: readonly AgentRuntimeSkillSource[];
  readonly disabledFeatures: readonly string[];
  readonly outputSchema?: JsonSchema;
  readonly injectEnv?: Readonly<Record<string, string>>;
  readonly paths: AgentRuntimePathContext;
  readonly state: AgentRuntimeStateSink<TSession>;
  readonly activity?: AgentRuntimeActivitySink;
  readonly logger?: AgentRuntimeLogger;
}

interface AgentRuntimeIdentity<TSession extends AgentRuntimeSessionRef> {
  readonly runtimeId: string;
  readonly session: TSession | null;
}

interface AgentRuntimeSessionRef {
  readonly id: string;
}
```

Every Provider defines its own JSON-serializable `TSession`, with `id` as the
only shared field. A Provider that resumes from an id alone uses
`AgentRuntimeSessionRef`; a Provider that needs more native resume coordinates
extends it, for example with a workspace id or resume token. Core treats the
additional fields as opaque data: it validates JSON compatibility and the base
`id`, persists the complete object atomically, and returns it only to the same
Provider. It never interprets, indexes, or branches on Provider-specific fields.

No Core-defined `transcript_locator`, path blob, provider `dataDir`, scan mode,
or native history path is added to the common base type. Both built-in readers
already have bounded locator-free session discovery; their concrete session
types may remain the base `{ id }` shape. The implementation must retain and
test those discovery paths for active and closed sessions.

The existing locator value stops being authoritative and is not translated to
the new seam. If the persisted identity schema must change to remove it, that
change is fail-loud with an explicit rebuild instruction rather than an alias or
migration. Cache, log, and runtime-socket path capabilities remain because the
providers consume them; no new durable provider path capability is introduced.

`outputSchema` is bound once to the runtime session. Claude Code supplies it at
process spawn, while Codex stores the same fixed schema and applies it to each
native turn. A later submit cannot change it. Workflow already creates a
schema-specific runtime, so this is the portable minimum and requires no
structured-output scope negotiation.

### 1.3 Live handle

```ts
interface AgentRuntime {
  start(): Promise<AgentRuntimeStartOutcome>;
  submit(input: AgentRuntimeSubmissionInput): RuntimeSubmission;
  stop(): Promise<void>;
}

interface AgentRuntimeStartOutcome {
  readonly continuity: "fresh" | "resumed";
}

type AgentRuntimeSubmissionInput =
  | {
      readonly kind: "channel";
      readonly input: InboundTurnInput;
    }
  | {
      readonly kind: "text";
      readonly text: string;
      readonly source: RuntimeTurnSource;
      readonly sourceId?: string;
    };
```

The existing `RuntimeSubmission` object identity and settlement contract remain
unchanged because Core uses the object as its correlation key. The union keeps
Channel-rendered input distinct from Dreamux-owned plain text. It also preserves
source and deduplication semantics for completion, scheduled, control, prompt,
and Channel turns.

`start` receives prior session identity only through the immutable create
context. A non-null session must restore continuous model context; failure
rejects and never silently becomes fresh. The Provider must durably publish its
session and ready state before `start` resolves. Core consumes the returned
continuity before admitting the first submission so restart notification remains
correct.

`stop` keeps the current synchronous input fence and convergence guarantee. A
stop racing a still-pending start must stop the runtime that appears later; a
failed start must roll back all partial ownership.

The following live members are deleted: `resume`, `channelInput`,
`completionInput`, `waitIdle`, `getStatus`, `getCheckpoint`,
`wasCheckpointResumed`, `getContext`, live `getCapabilities`, and
`providerRef`.

### 1.4 Leased push-only state

```ts
interface AgentRuntimeStateSink<TSession extends AgentRuntimeSessionRef> {
  publish(update: AgentRuntimeStateUpdate<TSession>): Promise<void>;
}

type AgentRuntimeStateUpdate<TSession extends AgentRuntimeSessionRef> =
  | { readonly kind: "status"; readonly status: AgentRuntimeStatus; readonly lastError?: string }
  | { readonly kind: "session"; readonly session: TSession }
  | { readonly kind: "session_lost"; readonly reason: string };
```

Core creates a distinct closure for each runtime generation. The generation is
not a public field and the Provider supplies no sequence number. Core serializes
updates in call-receipt order and resolves `publish` only after the authoritative
state write is durable.

When a runtime is replaced or stopped, Core revokes both its state and activity
sinks. A post-revocation state write rejects with a typed lease-revoked error so
the Provider terminates the stale writer. A persistence failure is a separate
fatal error. No pull representation survives on the live handle and no `drain`
method is needed: awaiting the Provider's own initial `publish` calls is the
start fence.

The optional activity sink shares the same generation lease. Activity after
revocation is dropped and logged fail-open; it cannot enter a replacement
runtime's COT stream.

### 1.5 Recent Activity Records

Replace `readTranscript` with a mandatory provider operation that can read an
actively growing session:

```ts
interface AgentActivityQuery<TSession extends AgentRuntimeSessionRef> {
  readonly session: TSession;
  readonly cursor?: string;
  readonly limit?: number;
  readonly includeTools?: boolean;
}

interface AgentActivityReadContext<TConfig> {
  readonly config: TConfig;
  readonly cwd: string;
  readonly injectEnv?: Readonly<Record<string, string>>;
  readonly logger?: AgentRuntimeLogger;
}

type AgentActivityRecord =
  | {
      readonly kind: "assistant_message";
      readonly text: string;
      readonly occurredAt?: string;
    }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly status: "started" | "completed" | "failed";
      readonly occurredAt?: string;
    };

interface AgentActivityPage {
  readonly records: readonly AgentActivityRecord[];
  readonly nextCursor?: string;
  readonly truncated: boolean;
}
```

The exact exported names may be mechanically adjusted during implementation,
but the semantics are fixed:

- records are chronological within a page;
- pagination walks a stable recent tail without skipping or duplicating records
  as the native history grows;
- an active turn produces useful records before any completion marker;
- the same reader works after the live runtime closes;
- tools are included by default and can only be hidden as a group;
- tool arguments, results, provider-native lines, Core status, admission, and
  settlement never appear;
- cursors are opaque and bounded;
- Providers enforce native read bounds and set `truncated`; Core independently
  validates record count, text size, page size, cursor size, and public errors;
- public errors describe neutral states such as session unavailable, invalid
  cursor, corrupt activity, or provider failure, never filesystem paths or scan
  modes.

`cwd` and injected environment remain because built-in native history discovery
consumes them. No caller-selected or literal output-budget member crosses the
seam.

This reader and the live activity sink share neutral assistant/tool concepts but
not delivery identity: the sink is transient COT input, while the reader is a
stable progress view. Neither replays the other.

## 2. Channel contract

### 2.1 Lifecycle and the two generic ports

```ts
interface ChannelProvider<TConfig> {
  createSession(
    context: ChannelSessionCreateContext<TConfig>,
  ): Promise<ChannelInstance>;

  readonly config?: ChannelConfigCapability<TConfig>;
  readonly onboard?: ChannelOnboardCapability;
  readonly diagnostic?: ChannelDiagnosticCapability;
  readonly sessionlessMcp?: ChannelSessionlessMcpCapability;
}

interface ChannelInstance {
  readonly session: ChannelSession;
  readonly mcp?: ChannelSessionMcpCapability;
}

interface ChannelSession {
  initialize(port: ChannelCorePort): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
}

interface ChannelCorePort {
  readonly invoke: ChannelCommandInvoker;
  readonly events: ChannelEventSource;
}

interface ChannelCommandInvoker {
  invoke(command: string, payload: JsonValue): Promise<JsonValue>;
}

interface ChannelEventSource {
  subscribe(listener: (event: ChannelCoreEvent) => void | Promise<void>):
    ChannelEventSubscription;
}

interface ChannelEventSubscription {
  unsubscribe(): void;
}
```

`createSession`, `initialize`, `start`, and `close` are direct same-process
lifecycle calls, not Commands or events. `initialize` loads and validates
Channel-owned state, stores the Core port, and attaches any event consumer. It
must not open external input. `start` resumes Channel-owned provisioning sagas
and then opens external I/O. This split makes subscribe-before-admission
provable while leaving event consumption optional: a Channel that needs no
events simply does not subscribe.

One subscription receives the complete event union and demultiplexes inside the
Channel. Adding a Command or event changes only its catalog/schema and
consumers, not the base lifecycle interface.

MCP is deliberately composed outside the base session. A Channel with no tools
does not implement fake members, while live and provider-level sessionless tools
retain explicit owners. Provider identity/config discovery and operational
capabilities remain direct control-plane concerns. As with Agent Runtime
Providers, Channel registration `ref` and `descriptor` live only in Core's
`RegisteredProvider` wrapper and are not echoed on this interface.

### 2.2 Command protocol

The in-process invoker and any admin adapter use the same Core-owned registry.
The public function accepts a name and JSON-compatible payload, but Core resolves
that name to a versioned schema, validates size and shape, attaches the invoker's
dispatcher and Channel identity, and returns a typed result or error.

The initial registry is exactly:

#### `team.submit`

```ts
interface TeamSubmitCommand {
  readonly team_name?: string;
  readonly input: InboundTurnInput;
  readonly correlation?: string;
}

interface TeamSubmitResult {
  readonly status:
    | "submitted"
    | "duplicate"
    | "stopped"
    | "failed"
    | "ambiguous";
  readonly turn_id?: string;
  readonly error?: ChannelCommandError;
}
```

Omitting `team_name` targets the Dispatcher Agent; otherwise Core resolves the
stable Team and submits only to its TeamLeader. The invoker scopes source
deduplication to the calling Channel. A successful/duplicate result carries the
Core `turn_id`.

`TEAM_NOT_FOUND` and `TEAM_CLOSED` are typed pre-admission failures. Only those
failures permit the Channel to remove a stale binding and retry once to the
Dispatcher. An unknown boundary outcome is `ambiguous`; it is never retried.
The existing `skipped -> stopped` boundary normalization remains.

`correlation` is a bounded opaque Channel-chosen string. Core never parses,
routes, authorizes, or deduplicates with it. The session-bound invoker already
establishes Channel provenance, so no provider/channel wrapper is duplicated in
the value. Core echoes it unchanged on all related submitted/activity/settled
events.

#### `team.create`

```ts
interface TeamCreateCommand {
  readonly request_id: string;
  readonly name_prefix?: string;
  readonly agent_runtime: string;
  readonly intent?: string;
  readonly identity?: string;
  readonly repo?: ManagedRepoRequest;
}

interface TeamCreateResult {
  readonly status: "created" | "existing" | "closed";
  readonly team_name: string;
}
```

The payload preserves the existing automatic-provisioning inputs, including an
optional bounded identity, but does not expose arbitrary prompts or skill roots.
Core still injects mandatory TeamLeader instructions and skills. `identity` is
Channel-owned automatic-provisioning policy, not a general Agent-control port.

Core canonicalizes the validated creation payload and persists
`request_id -> {payload_hash, reserved_team_name, status}` before resource
creation. The same id and hash always return the same never-reused name,
including after Core restart or Team closure. Reusing an id with a different
hash returns `IDEMPOTENCY_CONFLICT`. A closed replay returns `closed`; a new
provisioning generation must use a new request id.

Accepted identities are never silently evicted. The ledger has an explicit
configured maximum; reaching it rejects a new identity before acceptance and
emits an actionable operational diagnostic. This failure is preferable to
creating a duplicate Team or silently editing server-owned state. The ledger is
Core-owned and atomically persisted; Channel targets never enter it.

No Team read, Team dissolve, TeamMate, Workflow, scheduler, binding, host, or
diagnostic capability is added to the Channel Command registry.

### 2.3 Event protocol and catalog

Every event uses a versioned immutable envelope with Core-owned validation and a
bounded JSON-compatible payload. The initial event union is exactly:

- `team.state`;
- `teammate.state`;
- `teammate.turn.submitted`;
- `teammate.turn.settled`;
- `teammate.turn.message`;
- `teammate.turn.tool_call`.

The two state events use these minimum payloads:

```ts
interface TeammateStateEvent {
  readonly kind: "teammate.state";
  readonly occurred_at: number;
  readonly teammate_name: string;
  readonly role: "dispatcher" | "teammate" | "team_leader" | "team_member";
  readonly team_name: string | null;
  readonly status: "starting" | "running" | "degraded" | "stopped" | "closed";
}

interface TeamStateMemberSummary {
  readonly teammate_name: string;
  readonly role: "team_leader" | "team_member";
  readonly status: "starting" | "running" | "degraded" | "stopped" | "closed";
}

interface TeamStateEvent {
  readonly kind: "team.state";
  readonly occurred_at: number;
  readonly team_name: string;
  readonly leader_name: string;
  readonly status: "starting" | "running" | "closed";
  readonly teammates: readonly TeamStateMemberSummary[];
}
```

All Dreamux Agent entities are TeamMates at this event boundary. Persisting a
new Dispatcher, TeamLeader, ordinary member, or standalone TeamMate publishes
its first `teammate.state`; later state transitions publish the same kind. No
separate creation event is added. A Dispatcher has `team_name: null` and never
appears in a `team.state` member summary.

`team.state` is intentionally redundant. Core republishes the aggregate when
the Team lifecycle changes or when a contained TeamLeader/member is created or
changes state. Its `teammates` array is a current bounded summary, not a second
state authority: Core Team and Agent stores remain authoritative.

The `teammate` namespace identifies the Core entity that owns the whole turn
event family; adding later domains does not overload a global `turn.*`
namespace. `teammate.turn.submitted` includes the Core `turn_id`,
`team_name`/agent identity, required `turn_source`, and optional unchanged
Channel correlation. Later turn events correlate by `turn_id` and carry the same
optional Channel correlation. `turn_source` is not duplicated on later events
because current consumers need it only to establish the COT anchor at
submission.

Provider-normalized live activity continues through the existing Core
conversation projection, redaction, truncation, and event payloads. Tool
arguments/results visible after current Core redaction remain unchanged. This
design does not reshape the tuned COT presentation.

Binding, Collaboration Space, Workflow, scheduler, and host-maintenance events
are absent.

### 2.4 Delivery isolation

Keep the current event delivery semantics instead of introducing a new queueing
system into the COT path. Core validates and freezes an event, then invokes each
live session listener in publication order. It does not await a listener's
returned promise. Synchronous exceptions and rejected promises are caught and
logged; they never escape into admission or settlement.

Channel listeners must keep the synchronous projection bounded. Feishu's COT
listener continues to perform only its existing local adapter projection. A
Channel reaction that needs asynchronous persistence, such as binding
invalidation, synchronously updates or fences its in-memory authority and
serializes the durable write on a Channel-owned mutation tail. `close()` awaits
that Channel-owned tail before releasing state resources.

This is intentionally live best-effort delivery, exactly as today. There is no
Core event FIFO, backpressure, handler timeout, acknowledgement, retry, replay,
snapshot, outbox, event-content persistence, or final-delivery guarantee. A
future need for delivery guarantees would be a new requirement, not hidden
machinery in this refactor.

### 2.5 Channel MCP forwarding

Core retains the existing Agent Runtime MCP injection and forwarding chain but
generalizes its types around the optional MCP composition. It validates the
declared tool, schema, execution location, result, and caller context, then
forwards to a live session MCP handler or provider-level sessionless handler.

Caller context survives only where MCP dispatch, audit, logging, and existing
COT anchoring consume it. Core binding-owner and message-to-target proof are
deleted and must not be recreated inside the Provider. External-platform access
rules and provider schema/errors remain intact.

Feishu owns `bind_channel`, `unbind_channel`, and `list_bindings`. They are
Dispatcher-audience tools enforced from the retained caller context. They are
not Core Commands and there is no `transfer_back` alias. Reply/react and other
Channel tools continue to use the same MCP path.

## 3. Channel-owned routing and provisioning

### 3.1 Binding state

Each Channel session is the single process-local writer for a versioned durable
routing document under the existing per-dispatcher Channel state root. Core
supplies only the root; the Channel owns filenames, schema, target hierarchy,
normalization, generations, and atomic writes. Core has no binding mirror or
cross-Channel index.

For Feishu, exact topic/thread matching and parent-chat fallback remain
provider-private. Binding records store the provider's own target metadata and
one stable TeamLeader `team_name`. Manual unbind or external target closure
removes only the binding. Unbound Teams are normal.

Every live Channel receives `team.state`. A durable Team-close transition causes
it to atomically remove all local bindings to that stable name. Channel and Core
share one process and lifecycle; listeners attach before relevant work is
admitted. There is no independent Channel offline/reconnect, Team-read startup
reconciliation, remote synchronization, replay, or snapshot protocol. A typed
`TEAM_NOT_FOUND`/`TEAM_CLOSED` response remains a defensive stale-row cleanup
path, not the normal synchronization mechanism.

Cross-domain views intentionally call Core Team reads through existing Agent MCP
and `list_bindings` through each relevant Channel MCP. No one-call Core join is
created.

### 3.2 Provisioning saga

An automatic-provisioning Channel persists `{generation, request_id, phase,
target_metadata, first_delivery_identity}` before invoking Core. It then:

1. calls `team.create` with the persisted request id;
2. receives the stable ready Team name;
3. atomically installs the default binding;
4. calls `team.submit` for the first external message using the original stable
   source identity;
5. marks the saga complete.

Restart resumes the same idempotent step. Per-target serialization and stale
generation rejection are entirely Channel-private. Core sees neither the target
nor the binding generation.

The first message is never sent to Dispatcher before bind-ready and is not
submitted twice by the saga. If a process crashes after the durable binding but
before first submission, platform redelivery may be needed; this refactor does
not introduce a retained external-message outbox.

The old Core Collaboration Space service, target claims, exact-delivery
callbacks, policy configuration, and events are deleted. Target close removes
the default binding and does not dissolve the ordinary Team.

### 3.3 Fail-loud cutover

There is no automatic importer. Startup detects old Core binding,
Collaboration Space state, and removed policy configuration and fails with a
named incompatible-state/configuration error. The operator backs up obsolete
state outside the active state root and recreates Channel bindings/configuration
through the new owning Channel surface. The implementation never parses,
renames, rewrites, deletes, or dual-writes legacy files.

Existing Channel-owned unrelated state, such as access policy or bot lists,
keeps its current owner and is not treated as binding migration input.

## 4. Lifecycle and concurrency

### 4.1 Startup

1. Load and validate Core state, configuration, and provider descriptors without
   opening input.
2. Construct every Channel session and call `initialize`, loading Channel state
   and attaching event subscriptions.
3. Recover Core operations that require recovery while event pumps are attached;
   retain current lazy runtime activation for ordinary dormant agents.
4. Call every Channel `start`; each Channel resumes provisioning sagas before
   opening external input.
5. Open ordinary dispatcher, Workflow, scheduler, and external admission only
   after all configured Channels have started.

Only idempotent Channel-owned saga recovery may invoke Commands before ordinary
admission opens. Startup failure unwinds created sessions and any late-starting
runtimes in reverse order.

### 4.2 Shutdown

1. Synchronously revoke every Channel invoker's ability to admit new Commands.
2. Close ordinary Core admission and converge work accepted before the fences.
3. Stop runtimes while Channel subscriptions and outbound rendering resources are
   still available for final settlement facts.
4. Revoke event subscriptions and Channel command leases after accepted Core
   work has converged.
5. Call `session.close()` to stop external I/O, await Channel-owned mutation
   tails, and release provider resources.

No post-fence Channel Command is accepted. A Command racing shutdown receives a
typed pre-admission shutdown rejection, never an ambiguous partial mutation.

### 4.3 Team dissolve

Delete `waitIdle`, idle capability checks, and idle-based scheduler/dissolve
paths.

Dispatcher-triggered non-force dissolve checks the managed worktree before
stopping anything. Self-dissolve stops Workflow and TeamMate processes first,
then checks while the TeamLeader remains only to admit the operation. Once
accepted, both paths fence work, stop all runtimes, and perform a post-stop
cleanliness recheck to catch races.

If a non-force post-stop check is dirty, persist `blocked_after_stop`, abandon
that dissolve operation, and reopen ordinary Team admission. Children remain
stopped but retain their normal lazy-reopen semantics. This is necessary so the
TeamLeader can inspect, commit, or clean the preserved work; otherwise `force`
or out-of-band filesystem surgery would be the only exit. A later dissolve is a
new operation and repeats all checks.

For a clean worktree, or explicit `force` on the exact owned managed worktree,
Core durably accepts logical close after child processes exit. The command does
not wait for physical worktree deletion. Cleanup runs in the background with an
observable `cleanup_pending`/failed/completed state and retries safely.

`force` may discard uncommitted, untracked, or unmerged changes only after
resolving and containment-checking the exact Team-owned managed worktree. It
never deletes a reused cwd, source repository, repository root, branch, or
committed history. TeamLeader self-dissolve may lose its MCP response after
durable acceptance; that is expected fail-open behavior.

### 4.4 Scheduler

At the due time, scheduler uses the ordinary submission path immediately. It
does not check busy/idle, wait, hold a fire, or create a second queue. Native
folding or steering into an active turn is allowed. Proven pre-admission failure
and ambiguous admission keep their generic semantics, including no retry after
ambiguity.

## 5. Change inventory

### Reuse

- Core turn admission, `RuntimeSubmission` settlement identity, and
  `skipped -> stopped` normalization;
- Core Agent identity/history/state projections;
- existing Provider config/onboard/diagnostic behavior;
- current COT activity normalization, projection, redaction, truncation, and
  Feishu display;
- current Channel MCP descriptor generation and admin forwarding concepts;
- Team creation, never-reused names, managed-worktree containment, and atomic
  JSON state primitives;
- dormant runtime activation and stop-racing-start protection.

### Delete

- live runtime pull/query/duplicate members listed in section 1.3;
- Provider-level `ref` and `descriptor` echo members and their loader echo
  assertions; Core keeps one authoritative registration descriptor;
- resume and structured-output capability bits, `structuredOutput.scope`, and
  the `resume` field projected by `teammate.get_capabilities`;
- transcript-oriented public types, native locator errors, and
  `RuntimeCompletion.displaySubmission` if final source inspection confirms it
  still has no consumer;
- `waitIdle` consumers and held scheduler fires;
- `ChannelRoutes`, `resolveTarget`, `resolveInboundBinding`,
  `messageBelongsToTarget`, direct session `reply`/`react`, and Core
  binding-owner egress authorization;
- Core channel-binding service/store/admin/Team MCP surface and binding events;
- Core Collaboration Space service/state/config/public types/MCP/admin/events;
- `bind_channel` and `transfer_back` from Team MCP, with no aliases.

### Add or reshape

- minimal Agent Runtime types and loader conformance;
- leased state/activity sinks and `fresh | resumed` start result;
- neutral active-session Activity reader and `last` adapter;
- Core Command registry, two schemas, in-process invoker, typed errors, and
  durable Team-create ledger;
- six-event registry, fail-open scoped subscriptions, and lifecycle fencing;
- Channel lifecycle port and optional MCP composition;
- Feishu-owned binding/provisioning state and tools;
- dissolve partial-state and background-cleanup state machine;
- fail-loud legacy-state/config detection and operator instructions.

## 6. Implementation sequence

One implementation branch and PR may contain the work, but changes land in this
dependency order:

1. reshape `@excitedjs/dreamux-types` contracts and root export locks;
2. update Codex and Claude Code providers to the new runtime, state, structured
   output, and Activity contracts;
3. implement Core runtime ownership, Activity reader, Command/event registries,
   lifecycle fences, scheduler, dissolve, and idempotency ledger;
4. reshape the Channel contract and MCP composition;
5. move Feishu binding, provisioning, and COT anchor ownership into the Channel;
6. delete Core binding and Collaboration Space code/config/state surfaces;
7. update skills, maintenance references, architecture knowledge, public docs,
   and Rush change files;
8. run full gates and live-runtime validation.

Do not retain temporary public dual interfaces between these steps. Internal
compile breaks are resolved inside the same implementation change.

## 7. Verification

### Contract fixtures

- A minimal Agent Runtime Provider loads and runs one fresh turn with only the
  mandatory provider members and a live handle containing only
  `start/submit/stop`.
- A resumed fixture proves non-null session continuity, loud recovery failure,
  continuity reporting before first submit, and stop-racing-start convergence.
- A generic-session fixture persists and restores an extended Provider-owned
  resume object without Core interpreting or dropping its extra JSON fields.
- Provider loader fixtures prove registration works without implementation-level
  `ref` or `descriptor` members and rejects descriptor kind/ref errors before
  implementation registration.
- State tests prove ordered durable writes, revoked-generation rejection, stale
  activity drop, and no pull-state consumer.
- Structured-output parity tests run the same fixed create-time schema through
  Codex and Claude Code; a per-submit schema change is unrepresentable.
- Active and closed Activity fixtures prove stable cursor pagination,
  chronological records, tool filtering, bounds, neutral errors, and absence of
  native paths or tool contents.
- A minimal Channel fixture constructs, initializes, subscribes, starts,
  invokes both Commands, receives each event kind, and closes without any
  provider-specific or MCP stub.
- A no-MCP fixture has no MCP composition; live and sessionless MCP fixtures
  both forward tools with caller context.

### Behavioral gates

- `team.submit` tests cover Dispatcher/default delivery, TeamLeader delivery,
  duplicate, stopped, failed, ambiguous, stable `turn_id`, opaque correlation,
  and retry only after `TEAM_NOT_FOUND`/`TEAM_CLOSED`.
- `team.create` tests cover crash points before reservation, after reservation,
  during creation, and after readiness; same-id replay, closed replay,
  different-payload conflict, capacity rejection, and never-reused names.
- Channel saga tests cover crash/restart at every persisted phase,
  ready-before-bind, bind-before-first-submit, generation replacement, and no
  target data in Core.
- Binding tests cover exact topic then parent fallback, independent unbind,
  multiple bindings per Team, Team-close invalidation, defensive stale cleanup,
  Dispatcher-only binding tools, and no Core binding mirror/query.
- State-event tests prove creation and every later lifecycle transition publish
  `teammate.state` for Dispatcher, TeamLeader, ordinary member, and standalone
  TeamMate roles; contained changes also republish `team.state` with the current
  TeamLeader/member summaries and never place Dispatcher in a Team snapshot.
- COT regression tests preserve the current cards, correlation, scheduled and
  completion anchors, redaction/truncation, and tool input/result rendering.
  Provider/observer errors and subscription revocation cannot change Core
  admission or settlement; Channel-owned asynchronous state mutations serialize
  and finish before session close.
- Startup tests prove subscription happens before recovery/admission. Shutdown
  tests prove Command fencing precedes convergence, settlement can still render,
  Channel-owned mutation tails settle before resource release, and no callback
  runs after final close.
- Dissolve tests cover both callers, preflight, stop-before-cleanup, post-stop
  dirty race, reopened blocked state, force containment, self-response loss,
  durable logical close, and background cleanup retry.
- Scheduler tests prove immediate submission while busy, allowed folding, and
  no held-fire/idle behavior.
- Negative surface tests prove deleted methods, callbacks, events, Commands,
  aliases, Collaboration Space types, and binding stores cannot be imported or
  loaded.

### Repository gates

During implementation run, from the monorepo root:

```bash
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js test
.agents/scripts/check.sh
git diff --check
```

Also run both built-in live runtime suites unless the environment explicitly
lacks the relevant native runtime. Do not weaken existing lifecycle, COT, or
admission assertions to make the refactor pass.

## 8. Release and knowledge updates

This is a source- and state-incompatible change:

- use Rush change files for every affected package;
- 0.x packages use `minor` with a `BREAKING:` lead; packages already past 1.0
  use the real semver breaking level required by the repository;
- every state/config incompatibility includes an exact `Rebuild:` instruction;
- no generated changelog is hand-edited;
- public type export-lock tests are updated intentionally;
- config/state ownership changes update
  `packages/dreamux/skills/dispatcher/dreamux-maintenance/` in the same change;
- update current architecture, Channel runtime, state/path, and repository
  references under `.agents/`, then run the knowledge gate.

Change notes must explicitly cover Provider contract replacement, Activity
Records, removed Collaboration Space and binding state/config, Channel-owned
binding recreation, scheduler/dissolve behavior, and removed MCP/admin names.

## 9. Rejected alternatives

- Do not translate every old `ChannelRoutes` callback into a Command.
- Do not expose Workflow, scheduler, TeamMate management, Team reads, or host
  maintenance to Channel.
- Do not add Core-to-Channel queries, binding mirrors, replay, snapshots, or
  independent Channel reconnection.
- Do not keep `waitIdle` or derive another idle model.
- Do not retain runtime pull state alongside the push sink.
- Do not require a Provider implementation to echo Core-owned registration
  `ref` or `descriptor` metadata.
- Do not make recovery, structured output, or optional activity into
  negotiable live capability bits.
- Do not bind output schema per submission or restart a resident session
  secretly to emulate it.
- Do not expose native transcript paths, locator fields, raw records, literal
  output budgets, or tool arguments/results through Activity Records.
- Do not add a Provider sequence counter or a state-sink drain method.
- Do not add a Core event queue, timeout, replay, or acknowledgement mechanism to
  the already tuned live COT path.
- Do not put MCP methods back on the base Channel session.
- Do not restore binding-scoped egress authorization in either Core or Channel.
- Do not import, rename, translate, or automatically delete old binding or
  Collaboration Space state.
- Do not auto-dissolve unbound Teams or treat a binding as exclusive ownership.
- Do not preserve `transfer_back` or other compatibility aliases.

## 10. Known risks and bounded trade-offs

- Locator-free Activity discovery may be slower on large native history roots.
  Providers must keep scans bounded; failure affects `last`, never Core status or
  turn settlement.
- A Channel listener that performs expensive synchronous work can delay the
  in-process publisher. Providers must keep synchronous projection bounded and
  move asynchronous persistence to their own serialized mutation tail; this
  preserves current COT semantics without adding a second delivery system.
- The non-evicting Team-create ledger can fill. New provisioning then fails
  before acceptance with an actionable diagnostic rather than risking duplicate
  Teams.
- Fail-loud state/config cutover requires operators to recreate bindings and
  automatic-provisioning configuration.
- A failed non-force dissolve may leave children stopped before ordinary Team
  admission reopens. The durable blocked state must be visible, and the next
  dissolve rechecks current worktree state.
- A process crash after binding but before first submission can lose one
  external delivery if the platform does not redeliver. Solving that requires a
  retained external-message outbox, intentionally outside this refactor.
- Channel-provided automatic-provisioning identity is privileged text. It is
  retained only as the bounded equivalent of the existing policy field; prompt
  and arbitrary skill injection remain excluded.

## Completion condition

The solution is ready for implementation only after the operator reviews the
linked public solution Issue and explicitly grants development approval. Until
then, product code, tests, configuration, scripts, and generated artifacts stay
unchanged.
