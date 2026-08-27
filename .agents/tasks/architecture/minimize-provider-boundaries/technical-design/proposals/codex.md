# Technical Design: Minimal Provider Boundaries

## Status and input

- Author: Codex, independent first-round proposal
- Requirement revision: `89e95d7fb3fd0dcf5585484becbd529a34d6d425e73aae500a31595210a5433c`
- Scope: an intentionally incompatible rewrite of the public Agent Runtime and
  Channel contracts, the owning Core adapters, and the built-in providers
- Development approval: not granted; this document proposes implementation but
  does not authorize it

## Summary

Use two small, typed ports and keep all other behavior with its real owner.

1. An Agent Runtime Provider describes a configured runtime, reads recent
   neutral activity, and creates a live runtime. The live runtime has only
   `start`, `submit`, and `stop`. Runtime status and session changes flow through
   one leased state sink; there are no live pull methods or idle query.
2. A Channel session is directly controlled through
   `initialize`, `start`, `onMessage`, and `close`. Its initialized Core port has
   one `invoke` method. The initial Command catalog contains only `turn.submit`
   and idempotent `team.create`; the initial event catalog contains only Team,
   Agent, and turn facts.
3. Agent-to-Channel MCP is a separately composed optional capability. It is not
   part of either the Channel Command port or the event port.
4. External routing and automatic provisioning move completely into each
   Channel implementation. The Feishu provider gets one authoritative routing
   document and one process-local writer. Core binding and Collaboration Space
   code and state are deleted.
5. Team dissolve becomes an immediate stop operation. It removes Provider idle
   waiting, adds bounded destructive authority through `force`, durably closes
   the Team before asynchronous physical worktree deletion, and preserves a
   post-stop cleanliness check.

This is the smallest coherent end-to-end change: it deletes duplicated
authorities and current zero-consumer methods instead of replacing them with
compatibility adapters, general query ports, snapshots, or new capability bags.

## Current source anchors

The proposal follows the current ownership seams rather than treating the
requirement's inventory as hypothetical:

- `packages/dreamux-types/src/agent-runtime.ts` declares the duplicated runtime
  pull methods, separate input methods, optional idle wait, create context, and
  mandatory transcript reader. `packages/dreamux/src/agent-runtime/external-provider.ts`
  currently loader-requires all of them except `waitIdle`.
- `packages/dreamux/src/service/teammate-service/runtime-owner.ts` is the one
  live runtime owner and currently chooses `start` versus `resume`, queries
  status/checkpoint/resume outcome, and supplies `AgentRuntimeStateStore`.
  `turn-coordinator.ts` and `turn-recording.ts` already own the neutral
  admission/submission/completion invariants this design preserves.
- `packages/dreamux/src/service/agent-entity/runtime-state.ts` already serializes
  runtime-pushed state into the Core identity store, making it the natural home
  for lease, ordering, and revocation rather than a new cross-layer service.
- `packages/dreamux-types/src/channel.ts` currently exposes the growing
  `ChannelRoutes`, target/binding vocabulary, direct reply/react, and the event
  source. `packages/dreamux/src/service/dispatcher-service/input-source-lifecycle.ts`
  constructs those callbacks during Channel startup.
- `packages/dreamux/src/service/channel-service/` and
  `packages/dreamux/src/service/channel-binding/` currently own target
  resolution, binding persistence, TeamLeader egress proof, and MCP forwarding.
  The target keeps only the generic lifecycle/MCP forwarding composition and
  moves routing authority out.
- `packages/dreamux/src/service/dispatcher-core-events/` is already a
  dispatcher-scoped, live-only, non-retained bus. The new event pump strengthens
  its isolation and bounds without creating another fact store.
- `packages/dreamux/src/channel/conversation-projection.ts` owns the current COT
  bounds, redaction, and truncation. Those functions remain the only Core
  presentation transformation.
- `packages/dreamux/src/service/collaboration-space/`,
  `packages/dreamux/src/service/binding-events.ts`, and the Core
  `collaborationSpace` config are the complete obsolete authority to delete.
- `packages/channel/feishu-channel/src/provider.ts`, `feishu-target-router.ts`,
  `feishu-session-inbound.ts`, and the COT modules already own Feishu I/O,
  target interpretation, inbound sequencing, and display. They are the correct
  home for the replacement route store and provisioning saga.
- `packages/dreamux/src/service/scheduler/service.ts` contains the held-fire idle
  delay, while `packages/dreamux/src/service/team-collection/dissolve-controller.ts`
  and `dissolve-runner.ts` contain the idle-dependent durable dissolve phases.
  These existing owners change behavior; no new scheduler or dissolve facade is
  added.

## Ownership model

| Owner | Owns after this change | Explicitly does not own |
| --- | --- | --- |
| Core Team and Agent services | Team/Agent identity, lifecycle, runtime leases, Command execution, admission, settlement, completion delivery, Team-create idempotency | External target identity, target matching, Channel binding metadata |
| Agent Runtime Provider | Native process/session control, native admission and completion boundaries, context recovery, structured output adaptation, native-history projection | Dreamux Team/Agent state, Channel routing, Core settlement history |
| Channel Provider/session | External I/O, access policy, target canonicalization and hierarchy, bindings, provisioning saga, external presentation, provider MCP tools | Team/Agent domain state, Workflow/scheduler/host maintenance |
| Core event publisher | Stable, bounded, live-only Team/Agent/turn facts and COT safety projection | Replay, snapshots, binding facts, Channel synchronization |
| Worktree manager | Exact owned-worktree assessment and physical removal | Team lifecycle decisions, source repository or branch deletion |

The existing package dependency direction remains load-bearing:
`@excitedjs/dreamux` depends on provider packages; provider packages depend only
on `@excitedjs/dreamux-types` and provider-private dependencies. Core does not
import a concrete runtime or Channel implementation.

## Agent Runtime contract

### Provider facade

Keep one facade because config parsing, onboarding, diagnostics, discovery,
history projection, and runtime construction all describe the same selected
Provider. Optional control-plane capabilities remain composed members; no fake
method is required.

```ts
interface AgentRuntimeProvider<TConfig = unknown> {
  readonly ref: string;
  readonly descriptor: AgentRuntimeProviderDescriptor;

  getCapabilities(config: TConfig): AgentRuntimeProviderCapabilities;
  readConfig?(
    raw: Record<string, unknown>,
    context: AgentRuntimeProviderConfigReadContext,
  ): TConfig | Promise<TConfig>;
  onboard?: ProviderOnboard<Record<string, unknown>>;
  diagnostic?: AgentRuntimeDiagnostic<TConfig>;

  readRecentActivity(
    query: AgentRuntimeActivityQuery,
    context: AgentRuntimeActivityReadContext<TConfig>,
  ): Promise<AgentRuntimeActivityReadResult>;
  createRuntime(context: AgentRuntimeCreateContext<TConfig>): AgentRuntime;
}

interface AgentRuntimeProviderCapabilities {
  readonly tags: readonly string[];
}
```

`getCapabilities` is resolved against parsed config because the existing
`teammate.get_capabilities` projection enumerates configured `agents[]`, not
unconfigured packages. Core validates unique, lowercase
`namespace:value` tags, at most 32 tags and 64 UTF-8 bytes per tag. The initial
built-ins publish only non-secret selection tags such as `engine:codex` and
`engine:claude-code`. There is deliberately no arbitrary public-config map: it
would invite accidental secret exposure and has no current consumer. Resume,
structured output, and activity reporting are not tags or optional capability
bits. The first two are mandatory semantics; the last is harmless when absent.

The `teammate.get_capabilities` result keeps `id`, `spawn`,
`runtime_available`, `unsupported_reason`, and adds `tags`; it deletes the
current `resume` projection.

### Live base and submission

```ts
interface AgentRuntime {
  start(): Promise<AgentRuntimeStartResult>;
  submit(input: AgentRuntimeSubmitInput): Promise<RuntimeAdmission>;
  stop(): Promise<void>;
}

type AgentRuntimeStartResult =
  | { readonly mode: 'fresh' }
  | { readonly mode: 'resumed' };

type AgentRuntimeSubmitInput =
  | {
      readonly kind: 'channel';
      readonly input: InboundTurnInput;
    }
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly sourceId?: string;
    };
```

The current `RuntimeAdmission`, `RuntimeSubmission`, `RuntimeCompletion`, and
`RuntimeSubmissionSettlement` object-identity contracts remain unchanged.
`kind: 'channel'` preserves provider-owned Channel rendering;
`kind: 'text'` remains plain Dreamux text. Core never converts one into the
other.

`start` examines `context.identity.sessionId`:

- `null` requires a fresh native session and returns `fresh`;
- non-null requires continuous recovery of that exact session and returns
  `resumed`;
- recovery failure rejects. The Provider must not create a fresh replacement.

Core admits no submission until `start` resolves. This result replaces both
`resume` and `wasCheckpointResumed`, and is the sole input to Dispatcher restart
notice selection.

`stop` keeps the current strong contract: it fences new `submit` calls
synchronously, initiates native termination before waiting on work that
termination must release, and does not resolve while any admission begun before
the fence can still produce a newly accepted submission. Every accepted
submission settles exactly once. Provider-native fold/steer keeps one immutable
completion object; Provider-native queueing creates ordered distinct
completions. Core completion delivery remains FIFO per recipient and independent
from activity reading.

The following live members are deleted with no replacements:

- `providerRef`
- `resume`
- `channelInput` and `completionInput`
- `waitIdle`
- `getStatus`, `getCheckpoint`, and `wasCheckpointResumed`
- `getContext`
- live `getCapabilities`

### Create context and structured output

Keep the neutral launch inputs Core already owns, but make their authority and
binding time explicit:

```ts
interface AgentRuntimeIdentity {
  readonly runtimeId: string;
  readonly sessionId: string | null;
}

interface AgentRuntimeStorage {
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly logsDir: string;
  readonly runtimeSocketDirs: readonly string[];
}

interface AgentRuntimeCreateContext<TConfig> {
  readonly identity: AgentRuntimeIdentity;
  readonly config: TConfig;
  readonly cwd: string;
  readonly systemPrompt?: AgentRuntimeSystemPrompt;
  readonly mcpServers: readonly AgentRuntimeMcpServer[];
  readonly skillSources: readonly AgentRuntimeSkillSource[];
  readonly disableFeatures: readonly string[];
  readonly outputSchema?: Record<string, unknown>;
  readonly state: AgentRuntimeStateSink;
  readonly activity?: RuntimeActivitySink;
  readonly storage: AgentRuntimeStorage;
  readonly injectEnv?: Readonly<Record<string, string>>;
  readonly logger?: DreamuxLogger;
}
```

`outputSchema` is bound once for the lifetime of the created native session.
Every submission to a schema-bound runtime uses that schema. A later submission
cannot select a different schema, and the submission union has no schema field.
A caller that needs a different schema creates a distinct runtime entity. This
is the portable binding point: Claude Code already binds at process creation,
while Codex can apply the fixed schema to every native `turn/start`. Workflow
workers are already separately created and can remain schema-specific.

On recovery, Core must supply the same canonical schema fingerprint recorded by
the owner of the recoverable Workflow/runtime. A mismatch fails before native
launch; it never silently resumes with a different output contract. Ordinary
TeamMate and TeamLeader sessions remain unbound.

`dataDir` is a provider-owned durable subdirectory scoped to the concrete Agent
entity and Provider ref. Core owns only its placement and containment. A Provider
may persist a session-id-to-native-history locator there. This replaces the
public `transcript_locator`: Core persists only the neutral `sessionId`, and the
Provider owns how that session is found after the runtime closes. `cacheDir`,
`logsDir`, and socket candidates retain their current durability meanings.

### Leased push-only runtime state

Replace three callback methods with one ordered sink:

```ts
type AgentRuntimeStateUpdate =
  | {
      readonly kind: 'status';
      readonly status:
        | 'starting'
        | 'ready'
        | 'degraded'
        | 'stopping'
        | 'stopped';
      readonly lastError?: string | null;
    }
  | {
      readonly kind: 'session';
      readonly sessionId: string;
    };

interface AgentRuntimeStateSink {
  publish(input: {
    readonly sequence: number;
    readonly update: AgentRuntimeStateUpdate;
  }): Promise<void>;
}
```

Core creates one opaque lease per runtime generation and closes it over the
sink; the lease id is not a Provider field. Each Provider starts sequence at 1,
serializes publishes, and increments by one. Core accepts only the current
entity lease and the exact next sequence, serializes the resulting identity
store write, and acknowledges only after durable persistence. Duplicate,
out-of-order, or revoked writes reject.

Before `start` resolves, the Provider must have durably published its session id
and `ready` status. For a resumed launch, the published session id must equal the
requested id. A state-sink rejection is fatal: the Provider stops accepting
input, terminates its native process, and rejects `start` or fails/stops active
submissions as appropriate. It must not log and continue with state that Core
cannot recover.

Core revokes the lease after `stop` has converged admissions, and before it
installs a replacement runtime. A close racing a late `start` still stops the
late runtime; its subsequent state updates hit the revoked lease. Failed start
rollback stops the created runtime, revokes the lease, and records the public
failure through the Core-owned identity store, not through an already failed
Provider sink.

Core status/checkpoint reads use the identity projection only. A Provider may
rotate its native session representation while retaining the same continuous
`sessionId`; no `recordLostCheckpoint` public method survives.

### Recent Activity Records

Replace completed-turn transcript pages with stable, append-oriented records:

```ts
interface AgentRuntimeActivityQuery {
  readonly limit?: number;          // default 50, range 1..200
  readonly before?: string;         // opaque Provider cursor
  readonly includeTools?: boolean;  // default true
}

type AgentActivityRecord =
  | {
      readonly kind: 'assistant.message';
      readonly recordId: string;
      readonly occurredAt: number | null;
      readonly text: string;
      readonly truncated: boolean;
    }
  | {
      readonly kind: 'tool.lifecycle';
      readonly recordId: string;
      readonly occurredAt: number | null;
      readonly toolName: string;
      readonly status: 'started' | 'completed' | 'failed';
    };

interface AgentRuntimeActivityPage {
  readonly records: readonly AgentActivityRecord[]; // chronological
  readonly nextBefore: string | null;
  readonly truncated: boolean;
}

type AgentRuntimeActivityReadResult =
  | { readonly status: 'ok'; readonly page: AgentRuntimeActivityPage }
  | {
      readonly status: 'error';
      readonly error: {
        readonly code:
          | 'NO_SESSION'
          | 'HISTORY_NOT_FOUND'
          | 'HISTORY_UNAVAILABLE'
          | 'HISTORY_INVALID'
          | 'CURSOR_INVALID'
          | 'CURSOR_MISMATCH';
      };
    };
```

The read context contains `runtimeId`, `sessionId`, parsed Provider config,
`cwd`, the Provider `dataDir`, injected environment, and logger. It contains no
native locator, scan mode, or caller-selected byte budget.

Rules:

- A cursor identifies an exclusive stable boundary in one session and one
  `includeTools` mode. Appends after the cursor is issued cannot shift or
  duplicate older pages. Providers use native record identity/offset, not a
  tail-relative array index.
- A no-cursor read selects the newest bounded tail and returns it in
  chronological order. `nextBefore` pages backward.
- Providers exclude partially written native records. A tool lifecycle change
  is a new immutable record, not an in-place change to an already returned
  record.
- Tool filtering occurs before the limit is applied. Tool arguments, results,
  and errors never cross this seam.
- Assistant text is limited to 100,000 Unicode code points, tool names to 200,
  record ids/cursors to 4,096 bytes, and a page to 256 KiB of canonical JSON.
  Providers truncate text and set `truncated`; Core revalidates the page.
- Expected public failures use the result union. Unexpected throws are logged
  and mapped to the existing generic `last` failure without exposing paths or
  native history details.

`teammate.last` changes from `turns`/`blocks` to `records`,
`returned_records`, and `next_before`. Its separate TeamMate status projection
remains. The built-in readers must prove that an active native turn exposes
records before completion and that the same session remains readable after
runtime close and process restart.

The optional live activity sink keeps the current `RuntimeActivity` shape,
including tool arguments/results needed by frozen COT. It remains synchronous,
non-backpressuring, transient, and fail-open. Core supplies a wrapper that never
throws into Provider execution. A Provider can omit all live activity emission;
the mandatory reader remains independent. There is no one-for-one sink/reader
assertion and no Core activity archive.

## Channel contract

### Direct lifecycle and two generic ports

```ts
interface ChannelCommandInvoker {
  invoke<K extends ChannelCommandName>(
    command: K,
    request: ChannelCommandRequestMap[K],
  ): Promise<ChannelCommandResultMap[K]>;
}

interface ChannelSessionCreateContext<TConfig> {
  readonly dispatcherId: string;
  readonly channelId: string;
  readonly provider: string;
  readonly config: TConfig;
  readonly stateRoot: string;
  readonly cacheRoot: string;
  readonly logger?: DreamuxLogger;
}

interface ChannelSession {
  initialize(context: {
    readonly commands: ChannelCommandInvoker;
  }): Promise<void>;
  start(): Promise<void>;
  onMessage<K extends ChannelEventKind>(
    kind: K,
    event: ChannelEventMap[K],
  ): void | Promise<void>;
  close(): Promise<void>;
}
```

Core constructs the session directly from `ChannelProvider.createSession`,
calls `initialize` once, attaches its event-delivery lease, calls `start` once,
and finally calls `close` once. `initialize` loads and validates Provider state
but does not open external inbound admission. `start` first resumes Provider
sagas through `commands.invoke`, then opens external I/O. `close` synchronously
fences new external input and waits for already-started Command invocations to
return or become admission-ambiguous.

The Core constructs the invoker as a closure bound to one dispatcher and one
configured Channel id. Neither locator is accepted from provider payloads.
Adding a Command changes only the two catalog maps and Core handler registry;
adding an event changes only `ChannelEventMap`, publishers, and Channel-local
selection. The session interface does not widen.

The create context retains the current per-dispatcher durable and cache roots;
this task does not relocate Feishu access, pairing, or peer-bot state. A Channel
must namespace any new files it owns within that root. The Core supplies paths
and never parses the resulting Provider document.

Removed base members and types include `ChannelRoutes`, `deliver`,
`targetLifecycle`, `ensureCollaborationTarget`, `deliverExact`,
`ChannelCoreEventSource`, `resolveTarget`, `messageBelongsToTarget`, `reply`,
`react`, and all neutral target/container/binding types. Provider-specific target
types move into the owning Channel package.

### Initial Command catalog

Every request carries `schemaVersion: 1`; unknown versions, commands, fields,
or non-JSON values are rejected before domain execution. A generic thrown or
rejected invocation is admission-ambiguous to the Channel unless Core returned
one of the typed results below.

#### `turn.submit`

```ts
interface ChannelTurnSubmitRequest {
  readonly schemaVersion: 1;
  readonly input: InboundTurnInput;
  readonly teamName?: string;
  readonly correlation?: string;
}

type ChannelTurnSubmitResult =
  | { readonly status: 'submitted'; readonly turnId: string }
  | { readonly status: 'duplicate' }
  | {
      readonly status: 'rejected';
      readonly code:
        | 'INVALID_INPUT'
        | 'TEAM_NOT_FOUND'
        | 'TEAM_CLOSED'
        | 'DISPATCHER_STOPPED'
        | 'RUNTIME_STOPPED'
        | 'RUNTIME_REJECTED';
      readonly message: string;
    }
  | {
      readonly status: 'ambiguous';
      readonly code: 'ADMISSION_AMBIGUOUS';
      readonly message: string;
    };
```

Omitted `teamName` submits only to the Dispatcher Agent. A present name is
validated and looked up before runtime admission, and submits only to that
Team's TeamLeader. `TEAM_NOT_FOUND` and `TEAM_CLOSED` therefore prove that no
runtime accepted the turn. Only after either result may a Channel remove its
stale binding and submit once more without `teamName`. It must not fall back
after `ambiguous`, a thrown invoke, `submitted`, or `duplicate`.

Core scopes a non-empty `input.sourceId` by the invoker's configured Channel id
before forwarding it to the runtime, preserving dedupe isolation without
putting Channel identity in the public payload. Correlation is a Channel-chosen
opaque UTF-8 string of at most 512 bytes. Core compares or parses neither value.
It retains correlation only on the in-memory Core Turn and copies it unchanged
to every submitted, message, tool-call, and settled event for that turn.

The request is limited to 1 MiB canonical JSON, 32 attachments, and the existing
normalized Channel input vocabulary. Error messages are public, sanitized, and
limited to 2 KiB.

#### `team.create`

```ts
interface ChannelTeamCreateRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly namePrefix: string;
  readonly leaderAgentRuntime: string;
  readonly intent: string;
  readonly identity?: string;
  readonly repo?: TeamMateWorktreeRequest;
}

type ChannelTeamCreateResult =
  | {
      readonly status: 'ready' | 'closed';
      readonly teamName: string;
      readonly leaderName: string;
    }
  | {
      readonly status: 'rejected';
      readonly code:
        | 'INVALID_INPUT'
        | 'IDEMPOTENCY_CONFLICT'
        | 'IDEMPOTENCY_LEDGER_FULL'
        | 'TEAM_CREATE_FAILED'
        | 'DISPATCHER_STOPPED';
      readonly message: string;
    }
  | {
      readonly status: 'ambiguous';
      readonly code: 'CREATE_OUTCOME_UNKNOWN';
      readonly message: string;
    };
```

There is no prompt field. `ready` means the ordinary Team and leader identity
are durably created and eligible for input; it does not require an idle resident
model process. The Channel binds only after `ready`, then invokes `turn.submit`
for the first message. `closed` returns the same historical Team name without
recreating it; a new provisioning generation must use a new request id.

No Team read, send, dissolve, TeamMate, Workflow, scheduler, binding, or host
maintenance operation is a Channel Command. In particular, target closure only
unbinds local Channel state, so there is no `team.dissolve` Command in this
catalog.

### Restart-durable Team-create idempotency

Add a Core-owned per-dispatcher `team-create-requests.json` version-1 document.
Each entry contains only request id, canonical input digest, preallocated
never-reused `team_name`, leader name, `allocated | ready` phase, and timestamps.
It never contains a Channel id or external target.

Under a per-request keyed queue, Core:

1. validates the complete canonical input before writing;
2. rejects an existing id with a different digest as
   `IDEMPOTENCY_CONFLICT`;
3. allocates the concrete Team name and atomically persists `allocated` before
   creating Team resources;
4. creates or resumes the Team at that exact name through one Team-owned
   `createAtName` capability;
5. persists `ready` before returning.

An existing entry always returns or resumes the same Team. A crash in any step
is retried with the same id and name. The ledger is capped at 50,000 compact
entries per dispatcher. Accepted ids are never automatically evicted, because
eviction could create a second Team on a late retry. When full, new ids fail
loud with `IDEMPOTENCY_LEDGER_FULL`; this is preferable to violating
idempotency. The maintenance surface reports count/capacity. The document uses
the existing atomic, mode-0600 versioned JSON mechanism.

### Initial event catalog and delivery isolation

The new envelope is version 1 and intentionally incompatible with the current
callback/source types. Keep the existing flat COT presentation fields while
removing binding payloads:

- `team.state`: team name, leader name, `starting | running | closed`;
- `agent.state`: team name, agent name, role, current lifecycle status;
- `turn.submitted`: existing scope, turn id, turn source, and mandatory
  `correlation: string | null`;
- `turn.message`: existing message role/content/truncation/redaction fields plus
  correlation;
- `turn.tool_call`: existing tool/action/status and redacted bounded argument
  and result presentation fields plus correlation;
- `turn.settled`: existing status/assistant/truncation/redaction fields plus
  correlation.

`ChannelOrigin`, `binding.route`, and `binding.collaboration_space` are deleted.
Workflow and scheduler get no lifecycle/status event kinds. A scheduled or
Workflow-caused model turn may still produce the existing generic turn facts;
that is a turn observation, not a Workflow or scheduler catalog. Existing
`turn_source` filtering and COT behavior remain unchanged.

Core keeps one per-session asynchronous FIFO event pump. Publication clones and
freezes a validated event and never awaits Provider code. Each pump has 1,024
pending slots and a five-second handler deadline:

- delivered events retain publication order for that session;
- when full, the newest `turn.message` or `turn.tool_call` is dropped and a
  rate-limited warning records the count;
- a Team/Agent/submitted/settled event may evict the oldest queued activity
  event; if no activity event can be evicted, the pump revokes the consumer;
- a thrown/rejected handler is logged and the next event proceeds;
- a timed-out handler revokes the consumer and no later event is delivered, so
  a late completion cannot overtake later state;
- revocation invalidates the Channel's local state-writer generation, so a late
  timed-out handler cannot commit after a replacement session starts.

There is no retry, acknowledgement, replay, snapshot, content persistence, or
final-delivery promise. Observer failure never changes the Core operation or
turn settlement. Queue limits and deadlines are injectable in tests, not config
surface.

Startup and shutdown make the same-process lifecycle assumption explicit:

1. Build and `initialize` every configured Channel.
2. Attach every event pump before recovering or admitting Team/Agent work that
   can publish catalog events.
3. Recover Core Team state and then call Channel `start`; Channel provisioning
   sagas recover before external transport admission opens.
4. Open dispatcher/scheduler external admission only after all configured
   Channels started.
5. On shutdown, call Channel `close` first to fence inbound Commands, fence and
   drain relevant Core work while pumps remain active, drain each event queue to
   the bounded deadline, then revoke pumps and local writer leases.

Failed startup closes external admission, rolls back started sessions, drains
or revokes their pumps, and then rolls back Core resources. There is no
independent reconnect state. A stale binding discovered after restart remains a
defensive `TEAM_NOT_FOUND`/`TEAM_CLOSED` cleanup case.

### Optional Channel MCP composition

Do not put tool methods on the base session. `createSession` returns a composed
instance:

```ts
interface ChannelProvider<TConfig = unknown> {
  readonly ref: string;
  readonly descriptor: ChannelProviderDescriptor;
  readConfig?(
    raw: unknown,
    context: ChannelConfigContext,
  ): TConfig | Promise<TConfig>;
  onboard?: ProviderOnboard<Record<string, unknown>>;
  diagnostic?: ChannelDiagnostic<TConfig>;
  createSession(context: ChannelSessionCreateContext<TConfig>): ChannelInstance;
  readonly mcp?: ChannelProviderMcp<TConfig>;
}

interface ChannelInstance {
  readonly session: ChannelSession;
  readonly mcp?: ChannelSessionMcpHandler;
}

interface ChannelProviderMcp<TConfig> {
  tools(config: TConfig): readonly ChannelToolDescriptor[];
  handleSessionless?(
    call: ChannelToolCall,
    context: ChannelSessionlessToolContext,
  ): Promise<unknown>;
}

interface ChannelSessionMcpHandler {
  handle(call: ChannelToolCall, context: ChannelToolContext): Promise<unknown>;
}
```

`ChannelProvider.mcp` is absent when the Provider has no tools. Each descriptor
declares `execution: 'session' | 'provider'` and
`audience: 'dispatcher' | 'team_leader' | 'all'`, so Core routes deliberately
instead of treating sessionless handling as a runtime fallback. Catalog JSON
Schema validation, canonical result validation, and the existing Agent Runtime
MCP descriptor/proxy remain Core-owned.

Core selects the configured Channel, validates the declared tool/audience, and
forwards name, arguments, and caller context. It deletes
`authorizeTeamLeaderEgress`, target resolution, binding-owner checks, and
message ownership checks. Caller context remains only for audit and existing
COT anchor selection. Provider/platform validation and external authorization
still apply.

The Feishu audiences are initially:

- `reply`, `react`, and `list_chat_bots`: current permitted audiences;
- `bind_channel`, `unbind_channel`, and `list_bindings`: Dispatcher only.

There is no `transfer_back` alias. Team MCP deletes `bind_channel` and
`transfer_back`; TeamLeader Team MCP retains only `dissolve`. Core admin deletes
Team binding methods and stops joining `bound_target(s)` into Team create/list,
status, history, or dissolve results. A composite client explicitly joins Team
reads with one `list_bindings` call per relevant Channel.

## Feishu-owned routing and provisioning

### Local model and tools

Move `ChannelTarget` concepts into the Feishu package as closed local types:

```ts
type FeishuRouteTarget =
  | { readonly kind: 'chat'; readonly chatId: string }
  | {
      readonly kind: 'topic';
      readonly chatId: string;
      readonly threadId: string;
    };
```

Inbound keeps current fail-safe chat-mode lookup. A verified topic first tries
its exact topic binding, then its parent chat binding; an ordinary group or P2P
tries only its chat target. These matching rules never cross the Core seam.

Provider tools are:

- `bind_channel({ team_name, chat_id, thread_id? })`: canonicalize and upsert an
  exact manual binding; same target/team is idempotent, another team conflicts;
- `unbind_channel({ chat_id, thread_id?, team_name? })`: idempotently remove the
  exact binding, with optional compare-and-remove protection;
- `list_bindings({ team_name?, chat_id? })`: return canonical Feishu target,
  team name, source, and timestamps from the authoritative document.

Channel tool egress uses the target arguments already owned by `reply`/`react`;
it no longer asks Core to resolve or prove them.

### Durable single-writer state

Add one Provider-owned version-1 `feishu-routing.json` under the configured
Channel's durable state directory:

```ts
interface FeishuRoutingDocumentV1 {
  readonly version: 1;
  readonly revision: number;
  readonly bindings: readonly {
    readonly target: FeishuRouteTarget;
    readonly teamName: string;
    readonly generation: number;
    readonly source: 'manual' | 'automatic';
    readonly createdAt: number;
    readonly updatedAt: number;
  }[];
  readonly provisions: readonly {
    readonly target: FeishuRouteTarget;
    readonly generation: number;
    readonly requestId: string;
    readonly phase: 'creating' | 'binding' | 'failed';
    readonly teamName: string | null;
    readonly lastError: string | null;
    readonly updatedAt: number;
  }[];
}
```

One live Feishu session owns one mutex, one in-memory document, and one atomic
writer. Inbound resolution, MCP tools, Team-close invalidation, target closure,
and saga transitions all enter that writer. Per-target keyed queues prevent two
provision generations from invoking `team.create` concurrently. There is no
file lock because the Dreamux server and Channel instance are one process and
the existing daemon ownership prevents two writers. The session-generation
lease rejects commits from a revoked or replaced session.

Manual unbind or target closure removes only the binding and advances the local
generation. The Team remains alive. A Team-close event removes every binding
whose `teamName` matches and marks matching incomplete provisions failed. Team
names are never reused, so no replacement Team can inherit a stale route.

### Provider-owned automatic provisioning

Delete the Core-level `channels[].collaborationSpace` config. Add this optional
Feishu-owned block inside the Feishu `config` object:

```json
{
  "automatic_provisioning": {
    "enabled": true,
    "targets": "topics",
    "name_prefix": "feishu-topic",
    "leader_agent_runtime": "<agents[].id>",
    "identity": "optional TeamLeader identity",
    "repo": {
      "path": "/operator-selected/repository",
      "base_ref": "HEAD"
    }
  }
}
```

The block defaults to disabled. `targets` initially accepts only `topics` to
match the built-in Provider's verified topic-group capability. `repo` and
`identity` are optional. Core parses none of these fields; Feishu validates them
and sends neutral Team-create input. Intent is generated from external display
title when present, otherwise the stable phrase `Feishu topic collaboration`;
target identifiers are not smuggled into prompt text.

For one unbound eligible target, the target queue performs:

1. persist a new local generation, random stable request id, and `creating`;
2. invoke `team.create` with that request id;
3. on `ready`, persist `teamName`, then atomically install the automatic binding;
4. only after the binding write succeeds, invoke `turn.submit` for the inbound
   message with `teamName`;
5. on a proven `closed` Team or Team lookup rejection, remove the stale binding
   and allow one Dispatcher fallback; never compensate after ambiguity.

`start` resumes `creating`/`binding` records with the same request id. It never
allocates a second id for the same local generation. The saga persists no
message text or attachment content. Therefore a process crash after binding but
before first submission can lose that one external delivery unless the platform
redelivers it; it cannot create a duplicate Team or deliver before readiness.
This preserves the required ownership and safety without inventing a Channel
message archive.

Feishu has no target-close signal today and supplies no fake callback. A future
transport event calls the same generation-checked local unbind operation.

### COT correlation after Core binding deletion

Before invoking `turn.submit`, Feishu creates its current COT anchor and stores
a session-local random correlation-to-anchor entry. It passes that correlation
to Core. The submitted/activity/settled handlers use the returned correlation
instead of `ChannelOrigin.binding`; the map entry exists before invocation, so
early activity is safe. Proven rejection deletes it; settled release keeps the
current COT lifecycle.

Manual/automatic binding transitions update the existing Feishu leader COT
state directly from the authoritative local transaction. Team-close facts clear
it. Provider MCP reply/react caller context continues to refresh the current
outbound anchor, preserving the existing non-channel TeamLeader display path.
Core keeps the current activity normalization, workspace/secret redaction,
truncation, and Feishu COT rendering. In particular, live tool arguments and
results remain available only through the redacted COT event path; the narrower
recent-activity reader does not change them.

## Immediate Team dissolve and scheduler

### Scheduler

Delete `getWriter().waitIdle`, held-fire tokens, the one-hour defer timer, and
idle-specific missed-fire handling. At due time the scheduler performs its
ordinary admitted `scheduledInput` immediately. `submitted` and `ambiguous`
record the fire; ambiguity is not retried. Proven pre-admission rejection uses
the scheduler's existing generic failure/re-arm policy. A Provider may fold the
input into an active native turn.

### Dissolve state machine

Add `force: boolean` to Dispatcher and self-dissolve requests and persist it on
the dissolve operation. Remove `waiting_for_team_idle` and every captured
`waitIdle` capability.

Dispatcher-triggered dissolve:

1. Under the Team lifecycle queue, validate the exact Team-owned workspace. If
   `force` is false, assess cleanliness before accepting any destructive stop;
   dirty/unmerged rejects with no stopped children.
2. Persist the dissolve operation and fence new Team work.
3. Stop Workflow, all TeamMates, and the TeamLeader immediately; each runtime's
   normal `stop` converges admission/settlement.
4. Reassess the managed worktree after stop. A non-forced dirty/unmerged result
   enters `blocked_after_stop` rather than deleting changes.
5. Persist Team logical `closed` plus worktree `cleanup-pending`, then return
   only after all child processes have exited. Launch physical cleanup in the
   tracked background owner.

TeamLeader self-dissolve:

1. Fence Team mutation and stop Workflow and every TeamMate, but keep the leader
   alive for the decision.
2. Assess/reassess the worktree. A non-forced dirty/unmerged result enters
   `blocked_after_stop`, reopens ordinary Team admission, and returns
   `TEAM_DISSOLVE_BLOCKED`; children stay stopped and may be lazily reopened by
   later ordinary operations. Stopped Workflow runs remain terminal and are
   visible through existing Workflow reads.
3. Persist logical close and `cleanup-pending` before stopping the leader.
4. Stop the leader without waiting for its invoking turn or MCP response. A lost
   response does not change the durable accepted result.

`blocked_after_stop` is a recoverable, non-closing Team state recorded with the
reason and timestamp. A later clean or forced dissolve starts a new operation;
server restart does not silently continue destructive cleanup from the blocked
state.

For `force: true`, worktree code first proves all of the following from durable
Team identity and current Git registration: mode is `managed`, path is the
exact Team-owned registered worktree, the path is contained by the Dreamux
managed-worktree root, and the source repository is not the target. It then runs
`git worktree remove --force <exact-path>`. It never deletes the branch,
committed history, source repository, reused cwd, or an arbitrary directory.

Physical cleanup is always asynchronous after logical close. The durable owner
retries operational failures with capped exponential delay across restart and
keeps `cleanup-pending`/last error observable in Team status/history until the
worktree is deleted. Non-forced cleanup never changes a dirty worktree. Forced
cleanup retains its authorization in the operation and continues retrying the
exact validated managed target; it does not broaden the target on retry.

## Persistence, cutover, and release

### New and changed durable state

- Core: `team-create-requests.json` version 1, authoritative and server-owned.
- Agent Runtime Provider: entity-scoped durable `dataDir`, including private
  session/history location data.
- Feishu Channel: authoritative `feishu-routing.json` version 1.
- Team dissolve record: new phases and persisted `force`; the owning Team record
  version changes.
- Config: Core `collaborationSpace` is deleted; Feishu
  `config.automatic_provisioning` is new.

All owning maintenance references and routes must change in the implementation.
Server-owned files prohibit direct edits. Feishu routing is Provider-owned and
must be changed through its MCP tools, not by hand.

### Fail-loud cutover

There is no state or public-contract adapter.

- Config loading rejects any `channels[].collaborationSpace` key and names the
  corresponding owning Provider config replacement.
- Startup/doctor rejects existing Core `channel-bindings.json` or
  `collaboration-spaces.json` before any Channel opens external admission.
- Existing agent identity with `transcript_locator` or a Provider lacking the
  new durable activity locator fails the new state-version check; it is not
  silently treated as a fresh session.
- External Provider loaders name the missing new method or stale removed member
  and the required public contract version. The loader requires exactly
  `start`, `submit`, and `stop` on a runtime handle and validates the Channel
  instance composition.

The breaking Rush notes lead with `BREAKING:` and include exact operator
actions. For legacy binding/Collaboration Space state, the action is to stop
Dreamux, move the named legacy files to an operator backup outside the active
state directory, start the new version, and recreate desired routes with each
Channel's `bind_channel`. Existing Teams remain ordinary Teams. Provider/runtime
state rebuild instructions must make the loss of old resumable session/`last`
history explicit. No release note suggests editing a server-owned document.

This requires at least minor change files for 0.x Dreamux/types/runtime packages
and the correct real semver level for the post-1.0 Feishu Channel package.

## Implementation boundaries and sequencing

Use one feature branch but land implementation in owner-complete slices that do
not introduce adapters:

1. Rewrite `@excitedjs/dreamux-types` declarations and external loader
   conformance fixtures. Old providers fail immediately.
2. Migrate both built-in Agent Runtime packages and Core runtime ownership in
   one compile-complete slice: start/submit/stop, fixed schema, leased state,
   activity reader, scheduler, and restart notice.
3. Add Team-create idempotency and immediate dissolve in the Team owners.
4. Introduce the Channel Command registry, event pump, lifecycle composition,
   and MCP composition; migrate Feishu direct lifecycle and frozen COT.
5. Add Feishu routing/saga/tools, then delete Core binding and Collaboration
   Space services, state, types, admin/MCP surfaces, config, and events in the
   same end-to-end slice.
6. Update maintenance/current architecture references and breaking change files;
   run the complete repository gates.

Temporary compile-only commits may exist on the development branch, but no
published or mergeable state carries both binding authorities, an old/new
contract adapter, or a partially translated callback catalog.

### Reuse

Reuse without changing ownership:

- `RuntimeAdmission`, `RuntimeSubmission`, `RuntimeCompletion`, settlement, and
  completion-delivery policies;
- entity-owned `TeammateService` lifecycle and Core identity store;
- normalized `InboundTurnInput` and provider-private Channel rendering;
- current conversation projection limits, redaction, and Feishu COT rendering;
- generic provider registry/loader skeleton, config delegation, diagnostics,
  onboarding, MCP proxy, and tool-schema validation;
- Team factory, never-reused names, lifecycle queues, atomic JSON store
  mechanics, and exact worktree containment/registration checks;
- Feishu target router's provider-private chat-mode lookup and fallback behavior.

### Delete

Delete rather than deprecate:

- all removed runtime methods/capability bits/transcript types;
- `ChannelRoutes`, neutral target/container/binding types, source subscription
  facade, direct reply/react, and Core target proof;
- Core `ChannelBindingStore`, `ChannelService` binding methods,
  `binding-events`, binding event public types, and binding joins;
- the complete Core Collaboration Space service/store/config/public surface and
  its target claim/recovery machinery;
- Team MCP/admin `bind_channel` and `transfer_back`, including the old alias;
- idle scheduler and dissolve paths and tests that encode graceful waiting.

### New capabilities

The only new foundational capabilities are:

- leased `AgentRuntimeStateSink`;
- mandatory Provider `readRecentActivity`;
- Core `ChannelCommandInvoker` with two initial handlers;
- bounded per-session event pump;
- Team-create idempotency ledger and resumable `createAtName`;
- Feishu-owned routing document/writer and provisioning saga;
- exact forced managed-worktree cleanup.

None is a compatibility layer or a provider-specific method in Core.

## Verification matrix

| Contract / acceptance | Verification |
| --- | --- |
| Minimal runtime base | Public type tests and an external fixture implementing only Provider discovery, activity read, create, and runtime `start/submit/stop`; loader rejects each missing member and accepts absent activity emission/onboard/diagnostic |
| Fresh/resumed start | Codex and Claude unit plus live tests: null session returns fresh, existing session returns resumed with preserved context, invalid recovery fails without fresh fallback, restart notice consumes start result before first admission |
| Fixed structured output | Provider conformance suite runs the same neutral schema through both built-ins; later submissions use the fixed schema; mismatched recovery and unsupported schema vocabulary fail before admission; no capability preflight remains |
| Push-only state | Deterministic lease tests cover ordered persistence, duplicate/out-of-order updates, revoked old generation, late start, sink failure, failed-start rollback, and Core status/checkpoint reads with no runtime query |
| Submission invariants | Existing fold/queue, source reservation, immutable completion, exactly-once settlement, same-recipient FIFO, ambiguous admission, and stop-fence suites run through union `submit` for both variants |
| Active `last` | Provider reader tests append native records during a long active turn and page them before completion; repeat after runtime close/restart; verify chronological stable cursors, tool filtering, bounds, and absence of tool input/output |
| Optional activity | Minimal runtime emits none and settles; built-ins retain normalized activity. Conversation/COT tests prove projection exceptions do not affect admission or settlement and that reader records need not equal sink events |
| Scheduler | Fake busy runtime receives a due submission immediately; fold is accepted; no idle call/timer/held fire exists; ambiguity records once without retry |
| Immediate dissolve | Dispatcher clean/dirty preflight, post-stop dirty race, self-dissolve lost response, stopped children, restart recovery, logical-close return boundary, background cleanup, force containment, reused-cwd refusal, and no branch deletion |
| Minimal Channel base | External fixture implements initialize/start/onMessage/close, invokes both Commands, receives all event kinds, has no MCP/binding/worktree methods, and stops directly |
| Command catalog | Exhaustive registry test contains exactly `turn.submit` and `team.create`; strict version/shape/bounds tests; Team lookup is pre-admission; thrown admission is ambiguous; no internal capability becomes callable |
| Team-create idempotency | Concurrent same-id single flight, restart in every phase, same result, different-input conflict, closed-Team result, capacity failure, no target data in ledger, and atomic/corrupt/version behavior |
| Event delivery | Per-session order, multi-session independence, activity drop, lifecycle eviction/revocation, thrown/rejected/timeout handler, Core fail-open, late revoked writer, startup attachment before publication, and shutdown drain/revoke order |
| MCP composition | No-tools provider has no MCP member; session and provider execution routes are explicit; schema/result validation remains; audience is enforced; TeamLeader egress has no binding/message proof |
| Feishu routing | Exact topic then parent fallback, ordinary chat, concurrent bind/unbind, CAS unbind, list filters, one writer, state corruption/version failure, Team-close invalidation across multiple targets, and target close leaves Team alive |
| Provisioning saga | Persist-before-create, crash/restart in creating/binding, same request id/Team, bind-before-first-submit, no target in Core ledger, closed stale binding fallback once, and no retry after ambiguity |
| Frozen COT | Existing post-COT golden tests preserve message/tool categories, redaction/truncation and rendered effect; new correlation works for multiple external conversations bound to one Team; local bind transitions replace Core binding anchors |
| Breaking cutover | Config and state fixtures fail with named files/keys and exact recovery guidance; old Provider fixtures fail contract loading; no compatibility alias or migration path passes |
| Architecture | Package-boundary tests prohibit concrete Provider imports and removed symbols; static searches find no `target_key`, `binding_fallbacks`, Core binding/Collaboration Space type, `waitIdle`, runtime pull state, `readTranscript`, or `transfer_back` in live surfaces |

Final implementation gates are:

```bash
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js test
.agents/scripts/check.sh
```

Also run the repository lint, change-file verification, anti-leak scan, built-in
Provider package tests, and real Codex/Claude live gates in an environment that
has those runtimes. A missing required live runtime fails loudly unless the
environment explicitly uses the documented skip flag.

## Risks and mitigations

| Risk | Mitigation / accepted trade-off |
| --- | --- |
| Event overload loses presentation | Bounded, logged activity dropping is accepted; lifecycle facts displace activity, Core remains authoritative, and no replay store is introduced |
| Timed-out Channel handler later completes | Revoke delivery and the local writer generation; deliver no later event through that generation |
| Stale binding survives a missed Team-close fact | First later `turn.submit` returns proven `TEAM_NOT_FOUND`/`TEAM_CLOSED`; Channel removes and falls back once. This is defensive, not normal synchronization |
| Idempotency ledger growth | Compact fixed-cap ledger never evicts accepted identities; fail loud at capacity rather than create a duplicate Team |
| Provider-private history locator is lost | Durable Provider `dataDir` owns it; corrupt/missing data fails `last` without exposing paths and never changes Core status or settlement |
| Session-wide schema is less flexible than Codex per-turn schemas | It is the only portable binding time across supported runtimes. Schema-specific work uses a distinct runtime entity |
| Non-forced post-stop dirtiness partially dismantles a Team | Persist `blocked_after_stop`, reopen ordinary Team admission, leave Team unclosed, and make stopped children/workflows observable; operator cleans or retries with explicit force |
| Forced cleanup fails operationally | Exact destructive authority is persisted and retried only for the validated owned worktree; source repo, branch, and other workspaces remain out of scope |
| Incompatible external Providers and state stop startup | Intentional fail-loud cutover with exact loader/config/state errors and breaking notes; no silent downgrade or adapter |

## Rejected alternatives

1. **Translate every `ChannelRoutes` callback into a Command.** Rejected because
   callbacks describe current Feishu/Collaboration Space wiring, not the minimal
   externally callable Core catalog.
2. **Keep a Core binding mirror or query Channels for a joined Team view.**
   Rejected because either creates two authorities or adds the prohibited
   Core-to-Channel query port.
3. **Add Team reads, dissolve, Workflow, or scheduler to Channel Commands.**
   Rejected because no clarified external bridge use case justifies that trust.
4. **Retain runtime status/checkpoint/idle pulls for diagnostics.** Rejected
   because production has no diagnostic consumer and pull recreates duplicate
   authority. Idle-dependent product behavior is intentionally removed.
5. **Use optional recovery or structured-output capability bits.** Rejected
   because both are mandatory product semantics; an unsupported mode is not a
   valid Provider configuration.
6. **Bind output schema per submission.** Rejected because it cannot be honored
   by a resident Claude Code process without hidden restart/fresh-context
   behavior. Start-time binding is portable and explicit.
7. **Make the activity reader a Core turn archive or replay the live sink.**
   Rejected because active native history is the authority for progress, while
   Core settlement and live COT have different content and guarantees.
8. **Use unbounded event promises to preserve every COT update.** Rejected
   because a slow observer can otherwise retain memory without limit. Bounded
   best-effort delivery matches the clarified contract.
9. **Gracefully wait for self-dissolve response or model idle.** Rejected because
   it recreates the operational deadlock being removed; durable acceptance is
   authoritative even when the caller process exits.
10. **Automatically import old Core binding/Collaboration Space state into
    Feishu.** Rejected because the public rewrite explicitly has no migration
    adapter and Core metadata is not the new Provider-owned authority.
11. **Keep `transfer_back` as an alias.** Rejected by the explicit no-
    compatibility decision; the owning Channel verb is `unbind_channel`.

## Completion criteria

The implementation is complete only when the old public members, Core binding
authority, Collaboration Space domain, idle behavior, and compatibility names
are absent; both built-in runtimes and Feishu use the new contracts directly;
all new durable owners fail loud on incompatible state; the verification matrix
passes; required maintenance/architecture knowledge and Rush change files are
updated; and the operator separately grants development approval before any of
that product work begins.

# Cross-Review Round — Codex Seat

## Review basis

I read the frozen requirement and findings and all three proposal files to EOF,
including both subsequently appended cross-reviews. The requirement still has
SHA-256
`89e95d7fb3fd0dcf5585484becbd529a34d6d425e73aae500a31595210a5433c`;
the source reviewed is commit `57a2cf8a4d24`. The first-round proposal above is
unchanged. Where this section differs from it, this section is my revised
position.

The three proposals agree on much of the destination, but agreement is not the
decision rule. The decisions below follow the frozen contract and current
source, especially the native structured-output constraints, the current
atomic session/locator write, the COT submission-anchor dependency, and the
same-process Channel lifecycle.

## Converged foundation

The following survives cross-review without a material dispute:

- the live Agent Runtime handle has only `start`, discriminated-union `submit`,
  and `stop`; recovery is mandatory, `start` reports `fresh | resumed`, and a
  requested recovery never silently becomes fresh;
- runtime status/session facts are push-only through a Core-owned generation
  lease; live state pulls, `resume`, `waitIdle`, `getContext`, live
  `getCapabilities`, and `providerRef` are deleted;
- structured output is mandatory, live activity reporting is optional, and
  `readTranscript` is replaced by a mandatory active-session-capable Activity
  Record reader which excludes tool arguments and results;
- the Channel Command catalog is exactly `turn.submit` and restart-durable
  idempotent `team.create`; the event catalog is exactly `team.state`,
  `agent.state`, `turn.submitted`, `turn.settled`, `turn.message`, and
  `turn.tool_call`;
- Core binding and Collaboration Space authorities are deleted; Feishu owns
  binding persistence, matching, provisioning recovery, and binding tools;
- Channel MCP remains distinct from Commands and events, supports live and
  sessionless tools, and has no `transfer_back` alias;
- scheduler fires immediately through ordinary admission, and dissolve stops
  work immediately, rechecks worktree safety, durably accepts logical close,
  and performs physical cleanup in the background.

This convergence is retained because each item is independently required and
has a current owner to reshape or delete; it is not retained because two or
three authors chose it.

## Accepted arguments from the other proposals

### 1. Keep `turn_source` as a load-bearing COT fact

Claude correctly identifies that opaque correlation does not replace the
source category. The Feishu adapter accepts a TeamLeader submission without a
Channel origin only when `turn_source` is `completion` or `scheduled`
(`packages/channel/feishu-channel/src/feishu-cot-adapter.ts:127-140`). Current
Core derives that category independently from `ChannelOrigin`
(`packages/dreamux/src/channel/conversation-projection.ts:193-213`).

I therefore make `turn_source` required on `turn.submitted`. I do not copy it
onto all four turn event kinds: current COT consumes it at admission, and the
settled/message/tool payloads have no unconditional consumer for a duplicate
field. Correlation remains required as `string | null` on all submitted,
activity, and settled facts for a Channel-originated turn.

### 2. Make Provider discovery static unless a consumer proves otherwise

Claude is correct that my `getCapabilities(config)` adds a parameter with no
current consumer. Core currently calls `getCapabilities()` without config
(`packages/dreamux/src/service/agent-entity/agent-config.ts:48-66`). The revised
surface is therefore:

```ts
getCapabilities(): { readonly tags: readonly string[] };
```

Configured `agents[]` still select the Provider whose static tags are
projected. A future config-dependent public characteristic needs a separately
justified contract change; it is not smuggled into this minimum.

### 3. Remove the locator without adding a second durable writer

Claude's strongest correction is that my new durable `dataDir` would separate
the session id from Provider history-location state. Today `identity.json`
stores `session_id` and `transcript_locator` together
(`packages/dreamux/src/service/agent-entity/runtime-state.ts:63-67`), and the
identity write is one atomic replace
(`packages/dreamux/src/service/agent-entity/identity-store.ts:386-393`). I
accept the atomicity criticism but not Claude's rename-only
`provider_state`: if the opaque value remains a native path, renaming the field
still lets a raw storage path cross the public seam, contrary to the frozen
requirement.

The revised public session reference therefore contains only the neutral
session id:

```ts
interface AgentRuntimeSessionRef {
  readonly id: string;
}
```

No new Provider durable directory is needed. Both built-in readers already
have locator-free discovery paths: Codex falls back from a missing locator to
session-id discovery (`packages/agent-runtime/codex/src/transcript/path.ts:148-174`),
and Claude derives and scans candidates from session id, cwd, and environment
(`packages/agent-runtime/claude-code/src/transcript/path.ts:74-129`,
`:178-233`). New runtime state persists only `session_id`. An old stored
`transcript_locator` is ignored as an internal unknown extra and can disappear
on a later normal identity rewrite; it is never supplied to a new Provider and
does not force a session rebuild. This removes the locator value, locator
errors, and filesystem terminology from the public contract without creating a
second authority.

Trae's revised combination of both `dataDir` and `provider_state` is rejected
for the same reason. It adds a new host path and still permits the native path
to cross as opaque state, while the current readers prove that neither is
necessary for the mandatory capability.

The Activity read context keeps the neutral session reference, parsed config,
`cwd`, injected environment, and logger. `cwd` and environment remain real
built-in inputs: Claude history location consumes both
(`packages/agent-runtime/claude-code/src/transcript/reader.ts:91-98`,
`:676-683`), while Codex consumes injected environment
(`packages/agent-runtime/codex/src/transcript/reader.ts:637-644`). Literal host
output budgets, native scan modes, locator names, and filesystem-specific
public errors are still removed as required.

### 4. Let the lease object provide ordering; do not require Provider sequence numbers

Claude is correct that my per-publish `sequence` counter duplicates an existing
mechanism. `AgentRuntimeStateStore` serializes mutations on one tail in call
receipt order (`packages/dreamux/src/service/agent-entity/runtime-state.ts:82-98`).
A distinct sink closure per runtime generation supplies the epoch. The revised
sink is one `publish(update)` operation whose implementation serializes and
durably persists before resolving. There is no Provider-managed counter.

Revoked writes still reject, rather than silently succeeding. Persistence
failure remains fatal. Before `start` resolves, the Provider must await the
session and `ready` publications; thus no separate `drain()` method is needed.
This retains ordered updates, start fencing, and zombie exclusion with less
surface and fewer self-inflicted sequence-gap failures.

### 5. Make event consumption an optional subscription, while preserving explicit initialization

Claude and Trae both correctly observe that a Channel which consumes no events
should not implement a fake handler. I accept their subscription argument but
not their start-only lifecycle. The revised base is:

```ts
interface ChannelSession {
  initialize(port: {
    readonly commands: ChannelCommandInvoker;
    readonly events: ChannelEventSource;
  }): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
}
```

`initialize` loads Channel state and registers any event listeners without
opening external input. `start` resumes Channel-owned sagas and then opens the
transport. This split lets Core prove that subscriptions exist before recovery
or runtime work can publish events, which a listener registered somewhere
inside an asynchronous `start(port)` cannot prove. A no-event Channel simply
does not subscribe. Adding an event changes the catalog and subscribers, never
this interface.

### 6. Scope optional runtime activity to the same generation lease

Trae explicitly scopes `activitySink` to the runtime generation. I accept that
argument. Status writes from a zombie runtime are not the only late callback
risk; late activity must not enter a replacement runtime's COT projection.
Core closes both state and activity sinks over the same opaque lease and drops
activity after revocation. The token remains absent from the Provider-facing
payload and live handle.

### 7. Keep caller context for proven COT use and return `turn_id`

Claude correctly traces caller context to COT anchoring, and both other
proposals support returning `turn_id` from successful `turn.submit`. These are
already compatible with my first-round design, but cross-review makes their
verification explicit: caller context survives only for COT/audit, never for
the removed binding authorization, and the returned id must equal the id on
the corresponding `turn.submitted` event.

### 8. Reopen an admission-blocked Team after a non-forced post-stop worktree block

Claude's cross-review accepts the first-round Codex behavior here for the right
reason: keeping the fence closed would make the TeamLeader that can inspect and
commit the worktree unreachable. `blocked_after_stop` remains durable and
visible, but ordinary Team admission reopens; stopped TeamMates can be lazily
reopened. A later dissolve starts a new operation and rechecks cleanliness.

## Rejected arguments and factual resolutions

### Recovery cannot become fresh after a lost checkpoint

Claude round 1 says that a missing native session may start fresh, report
`continuity: fresh`, and record loss. That contradicts the frozen requirement:
a non-null prior session must restore continuous context and recovery failure
must reject. Current Core's capability branch
(`packages/dreamux/src/service/teammate-service/runtime-owner.ts:153-169`) is
the duplicated mechanism being removed, not evidence for preserving a fallback.
Trae and my first-round proposal are correct on this point.

### Structured output is session-bound, not per submission

Trae removes create-context schema and puts it on every submission. Current
Claude Code makes `--json-schema` a spawn-time argument
(`packages/agent-runtime/claude-code/src/args.ts:159-165`) and rejects a
different per-turn schema on its resident process
(`packages/agent-runtime/claude-code/src/runtime.ts:248-263`). Codex can apply
the fixed schema to each native `turn/start`
(`packages/agent-runtime/codex/src/turn-manager.ts:108-121`). Workflow already
creates a schema-specific agent and supplies the schema at creation
(`packages/dreamux/src/service/workflow-service/run.ts:330-347`). The portable
contract therefore remains create/session-bound and immutable for that runtime.

### The live handle cannot retain logging/test members

Trae retains `providerRef` and `generation` on the live handle while saying Core
never consumes them. The requirement says the handle has exactly the three
execution methods and explicitly deletes duplicate `providerRef`. Logging and
tests are not unconditional Core consumers. Both fields remain rejected.

### Optional activity needs no discovery bit

Trae adds `activityReporting: boolean`. The frozen contract explicitly says
absence needs no preflight bit because it changes presentation only. A true bit
cannot guarantee that a runtime emits an event, and a false bit changes no Core
admission path. Core can always install the fail-open sink and a Provider can
emit zero events; current create context already wires the sink without an
activity capability check (`packages/dreamux-types/src/agent-runtime.ts:435-439`).
Trae's stated needs to “wire COT” or warn on a quiet turn therefore do not
create a consumer for the bit. It is dead negotiation surface and is rejected.

Trae's Activity Record also includes `call_id`, action, and an error string,
retains `transcript_locator`, a literal output budget, and filesystem-shaped
errors. The accepted record policy is assistant text plus tool name and
lifecycle status only. Those extra fields and native assumptions are rejected.
Its revised `succeeded | unknown` vocabulary is also rejected: the existing
neutral activity vocabulary is `started | completed | failed`
(`packages/dreamux-types/src/agent-runtime.ts:321-338`), and both supported
Providers must project that mandatory lifecycle fact. Reusing it minimizes
translation and aligns the reader with the sink without equating their delivery
guarantees.

### Removing Core's egress restriction removes the effect, not only its location

Claude moves the current binding-scoped TeamLeader reply/react restriction into
the Feishu store. That preserves behavior which the requirement explicitly
deletes. Current Core performs that proof in
`packages/dreamux/src/service/channel-service/index.ts:141-176`; the target
removes it and `messageBelongsToTarget`. A Provider may still enforce tool
schema, external-platform permissions, and platform access policy, but it must
not recreate Dreamux Team-to-binding ownership proof under a different owner.
Trae and my proposal correctly remove the restriction.

Claude's cross-review summary later lists the authorization as deleted, but its
round-1 ownership section, Feishu behavior, verification row, and exact revision
list never retract the Provider-side binding check. The revised design must
delete the effect explicitly; a summary sentence is not a contract change.

### `team.create` retains the current automatic-provisioning identity input, not prompt or skills

Claude rejects `identity` but keeps `prompt`; Trae exposes identity, prompt, and
arbitrary skill sources. Neither boundary matches current automatic
provisioning. The current Channel Collaboration Space config deliberately owns
an optional identity (`packages/dreamux/src/config/collaboration-space-config.ts:15-31`,
`:56-75`) and passes it into Team creation
(`packages/dreamux/src/service/collaboration-space/target-lifecycle.ts:425-440`).
Moving the same policy to Channel must preserve that effect. Conversely, the
current provisioning path passes neither prompt nor arbitrary skill roots, and
Core must continue injecting mandatory TeamLeader skills itself.

The catalog therefore keeps bounded `identity?: string` and rejects `prompt`
and `skill_sources`. This is a migration of an existing automatic-provisioning
choice, not blanket Channel authority over agent role assembly.

### A safety-blocked Team reopens; it is not stranded behind the dissolve fence

Trae's cross-review keeps `blocked_worktree` admission closed until an operator
cleans out-of-band or retries from Dispatcher with `force`. The frozen findings
require a recoverable partial state but do not require permanent unavailability.
After Core has durably abandoned that dissolve operation, the normal lazy-start
owner can reopen stopped runtimes; every later dissolve re-runs the safety
assessment. Reopening preserves the non-forced work and lets the TeamLeader
inspect or commit it. The blocked phase and stopped-child facts remain visible,
so this does not pretend the failed operation completed. I retain
`blocked_after_stop` plus reopened ordinary admission.

### Accepted idempotency identities cannot expire

Claude round 1 evicts after 30 days and after Team disappearance. Trae compacts
closed-Team entries after 30 days. Claude's cross-review then both accepts a
closed replay returning its historical Team and retains eventual closed-entry
eviction; those rules are mutually inconsistent. The frozen invariant says the
same accepted request identity returns the same Team on every retry, not only
while the Team is open or younger than 30 days.

The first-round fixed-cap ledger therefore stands: no accepted entry is
automatically evicted; a closed replay returns `closed` with its historical,
never-reused Team name; a new provisioning generation uses a new request id;
and capacity exhaustion rejects new identities before acceptance. Current Team
name claims are never reusable
(`packages/dreamux/src/service/team-collection/index.ts:161-176`), so an expired
ledger entry could not safely recreate at the same name anyway. Capacity and
usage are observable; maintenance never edits the server-owned file.

### Binding-state cutover is fail-loud, never an importer

Trae's rename/import/delete flow reads old Core binding state into Feishu and is
a compatibility adapter. Current 0.x policy says legacy state is detected but
never read, rewritten, removed, or migrated
(`packages/dreamux/src/service/CLAUDE.md:241-248`). The frozen findings require
an explicit fail-loud cutover. Core therefore aborts on old binding or
Collaboration Space state; the operator backs it up outside active state and
recreates routes through the Channel tools. Claude and my proposal are correct
on this point.

Ignoring an obsolete locator field inside the otherwise current identity record
is not such an importer: no removed file is read by a new owner, no value is
translated into the new seam, and no second authority is created. The neutral
session id remains current state.

### Startup must attach Channel consumers before event-producing recovery

Trae starts runtimes before `session.start`, explicitly allowing state events
to occur before Channel listeners exist. That violates the freeze-audit
lifecycle obligation. It is also broader than current lazy activation: ordinary
dispatcher start leaves its runtime dormant
(`packages/dreamux/src/service/CLAUDE.md:40-43`). The revised initialization
ordering below rejects eager runtime startup and attaches listeners before
active recovery.

Trae's shutdown description does not give Core an explicit admission fence that
precedes its final event drain. A full `session.close()` cannot be that first
step because it may destroy the outbound resources needed to render settlement
events. The correct first action is to synchronously close the Core-owned
Channel invoker admission. Event and session resources remain live while work
accepted before that fence converges; Core revokes the event lease only after
the bounded drain, then calls `session.close()` to release the transport.

### Per-kind event ordering and timeout continuation are unsafe

Trae proposes FIFO per `(channel, kind, team)` and drops the oldest event. That
does not preserve the cross-kind `turn.submitted` before `turn.message` ordering
on which COT anchoring depends, and it can drop the anchor while retaining later
detail. One FIFO per Channel session is required.

Claude times out a listener and continues the queue. JavaScript promise timeout
does not cancel the timed-out handler's side effects: it can later mutate
Channel state after a newer event, violating the very ordering the FIFO is meant
to provide. Claude's claim that lifecycle events can never be dropped is also
not a bounded algorithm when a full queue contains only lifecycle events.

I also revise my own first-round permanent mid-process revocation: the frozen
lifecycle says revocation follows the Core work fence during shutdown. The
resolved pump is described below; it neither advances past a still-running
handler nor revokes a configured Channel mid-run.

### Provisioning cannot deliver the first message to Dispatcher first

Trae's saga initially delivers the unbound message to Dispatcher and later
submits the original message to the new Team. The frozen sequence requires the
Channel to persist the saga, create the Team, bind it, and only then submit the
first message. Sending first to Dispatcher either violates ready-before-first-
delivery or duplicates the external message. My first-round sequence stands.

### Channel binding tools cannot secretly acquire a Core read port

Trae has `bind_channel` validate `team_name` through a Dispatcher Team read
surface from inside the Provider. No such Core-to-Channel query exists, and the
initial Command catalog deliberately has no Team read. A Dispatcher may
separately use its existing Agent/MCP Team read before calling the Channel tool;
the Channel stores the stable name and later removes it on `team.state: closed`
or a proven submission rejection. The tool handler itself gets no hidden Core
read capability.

### Correlation remains the Channel's plain opaque value

Trae retains a Core-stamped `{provider, channel_id, value}` wrapper. The invoker
closure and per-session event pump already establish Provider/Channel
provenance, and Core neither routes nor authorizes with the correlation. Adding
the same provenance to every turn payload is duplicate state and changes the
frozen “returned unchanged” value into a structured envelope. A bounded plain
string remains sufficient even when one Team has several bindings: each Channel
maps only the value it created within its own session.

### `turn_source` belongs on submission, not every later event

Trae's revised design requires `turn_source` on every turn event. Current types
and COT use it only on `turn.submitted`
(`packages/dreamux-types/src/channel.ts:347-367`,
`packages/channel/feishu-channel/src/feishu-cot-adapter.ts:110-140`). Message,
tool, and settled handlers correlate by `turn_id` after that admission. Repeating
the source on all later payloads has no unconditional consumer and widens the
event catalog. Core stamps the non-spoofable source once on submitted; Channel
never supplies it in `turn.submit`.

### MCP composition remains separate from the base session

Claude and Trae retain optional `handleTool?` on `ChannelSession`. That is
smaller in type count but makes a no-tools session expose tool-shaped surface and
does not model the current sessionless `list_chat_bots` owner cleanly. The
first-round `ChannelInstance { session, mcp? }` plus Provider-level sessionless
handler remains the revised position. Its additional type encodes a real
optional capability and keeps the lifecycle base free of MCP behavior.

## Revised end-to-end position

### Runtime ownership and contracts

The Provider facade remains one selected-Provider control plane with static
descriptor/tags, optional config/onboard/diagnostic capabilities, mandatory
`readRecentActivity`, and `createRuntime`. Its live result has only
`start/submit/stop`.

Core supplies one immutable create context including the optional session-bound
output schema and one neutral session reference. A non-null session reference
must resume; failure rejects. `start` durably publishes session and ready state
through the current lease before returning its `fresh | resumed` outcome. The
owner admits no input before that result and stops a late start after close.

The leased state sink serializes writes in receipt order and rejects writes
after revocation. The optional activity sink shares the generation fence but is
synchronous, non-backpressuring, and fail-open. Sink activity remains the broad
redacted COT input; Activity Records remain the narrow stable `last` source.

The recent-activity reader pages immutable records backward from a stable native
boundary while returning each page chronologically. It receives only the
neutral session id and context needed for Provider-owned discovery; no native
path, locator state, or filesystem-shaped public failure crosses the seam.
Providers own read-size enforcement and truncation; Core revalidates a fixed
maximum page before projection.

### Channel lifecycle, Commands, events, and MCP

Core creates every session in-process, calls `initialize({commands, events})`,
then `start`, and finally `close`. The invoker closure fixes dispatcher and
configured Channel identity. The event source offers optional typed
subscriptions and a Core-owned revocable lease. The initial Command and event
catalogs remain exactly the two and six kinds listed above.

`turn.submit` retains strict shape/bounds, scopes source dedupe to the invoking
Channel, accepts optional `teamName` and opaque correlation, and returns a
`turnId`. Only `TEAM_NOT_FOUND` and `TEAM_CLOSED` prove stale-target
pre-admission rejection and permit one Dispatcher fallback. Throws and unknown
boundary outcomes are `ambiguous` and never retried.

`team.create` validates one canonical payload, reserves and persists a concrete
never-reused Team name before resource creation, and resumes the same name after
crash. Its request-id ledger never stores an external target or silently evicts
an accepted identity. The external catalog carries only the current
provisioning inputs: name prefix, runtime, intent, optional identity, and
optional managed-repo request.

The event pump is one bounded FIFO per initialized Channel session. Publishing
only validates, freezes, and enqueues; it never awaits Provider code. A rejected
handler is logged and the next event runs. A handler that does not settle keeps
the head position; Core continues authoritatively while the bounded queue drops
new activity first, then evicts oldest queued activity for lifecycle events. If
a lifecycle-only queue is full, the newest lifecycle event is dropped with a
high-severity, rate-limited diagnostic; it is not falsely promised or allowed
to grow without bound. This is lossy by the frozen contract but never executes
later Channel side effects ahead of the stuck handler. Shutdown has a bounded
drain; only after the work fence does Core revoke the source and discard any
remainder. There is no retry, acknowledgement, replay, snapshot, or event-content
store.

Provider MCP remains separate composition. Core validates the declared tool,
execution location, schema, result, and caller audience; then it forwards.
Binding tools are Dispatcher-only. TeamLeader reply/react is not checked against
Dreamux bindings; external platform policy still applies. Caller context remains
only for tool dispatch, audit, and frozen COT anchoring.

### Feishu routing and provisioning

One Feishu session is the single process-local writer for a versioned routing
document namespaced by its configured `channelId` under the existing
per-dispatcher Channel state root. The document contains exact target bindings,
generations, and incomplete provisioning records. Core supplies the host root;
the Provider owns its filename and schema. There is no second Core index or
cross-process lock.

Inbound exact-topic then parent-chat matching stays Feishu-private. Manual
unbind and external target close remove only bindings. A Team-close event removes
every local binding to that stable name. A missed close can only be cleaned
defensively on the next proven `TEAM_NOT_FOUND`/`TEAM_CLOSED` result.

Automatic provisioning persists a generation and stable request id before
calling `team.create`, persists the ready Team as the binding, and submits the
first message only after the binding write. Restart resumes the same request.
A crash after binding and before first submission may lose that delivery in the
absence of platform redelivery; it cannot duplicate a Team or admit before
readiness. Core receives no external target.

### Startup, shutdown, dissolve, and scheduler

Startup order is:

1. passively load and validate Core state and configured Providers;
2. construct every Channel and call `initialize`, which loads its local state
   and establishes listeners and writer leases without external input;
3. recover active Core dissolve/Workflow/Team operations while event pumps are
   attached, preserving lazy runtime activation where no recovery requires it;
4. call every Channel `start`, where Channel sagas resume before the transport
   opens;
5. open external Channel, dispatcher, Workflow, scheduler, and Team scheduler
   admission only after all configured Channels started. Commands issued by a
   Channel's own step-4 saga recovery are the only pre-open invocations.

On shutdown, Core first synchronously closes every Channel invoker's admission,
so external messages that race shutdown can receive only a pre-admission
shutdown rejection. Already accepted Commands and runtime admissions converge
while event pumps and Channel outbound resources remain attached. Core stops
runtimes, performs a bounded pump drain, revokes event and Channel writer
leases, and only then calls `session.close()` to stop external I/O and release
Provider resources. Failed startup rolls back in reverse order and stops any
late-starting session or runtime.

Dissolve and scheduler remain as in round 1. In particular, no idle model
returns; self-dissolve may lose its MCP response after durable acceptance;
post-stop dirty state reopens ordinary Team admission without auto-forcing; and
physical deletion is always background cleanup of only the exact owned managed
worktree.

## Exact changes from the first-round position

1. `getCapabilities(config)` becomes static zero-argument
   `getCapabilities()`.
2. New Provider `dataDir`, `providerState`, and the agent-identity rebuild are
   removed. `AgentRuntimeSessionRef` carries only `id`; an old internal locator
   field is ignored and never crosses the new seam.
3. The state sink drops Provider-authored sequence numbers. One leased sink and
   Core's serialization tail establish order; durable acknowledgement and
   revoked-write rejection remain.
4. The optional runtime activity sink is explicitly covered by the same
   generation revocation as the state sink.
5. Mandatory `ChannelSession.onMessage` becomes optional subscription through
   `ChannelEventSource`; `initialize` remains separate from `start` to prove
   attach-before-recovery ordering.
6. `turn_source` is explicitly required on `turn.submitted` and tested for
   scheduled/completion COT anchoring; it is not duplicated onto later turn
   events.
7. Event timeout no longer permanently revokes a configured consumer, and a
   timed-out handler is not bypassed. Publisher isolation plus bounded queue and
   shutdown drain provide time isolation without out-of-order late effects.
8. Runtime/identity cutover no longer rejects an otherwise-current identity
   solely because it contains the now-unused locator field. The value is not
   translated or passed to a Provider. Binding, Collaboration Space, config,
   and public Provider cutovers remain fail-loud.
9. Shutdown fences the Core-owned Channel invoker first, not the entire session;
   final session close follows accepted-work convergence and event revocation so
   settlement/COT delivery retains its Provider resources.

All other first-round choices stand, including fixed schema binding, no activity
capability bit, no idle model, the hard-bounded non-evicting idempotency ledger,
plain opaque correlation, separate MCP composition, Channel-owned routing,
identity-preserving `team.create`, no binding migration, one session FIFO,
reopened `blocked_after_stop`, and exact forced-worktree containment.

## Verification changes after cross-review

The first-round verification matrix remains authoritative with these deltas:

| Revised contract | Required verification |
| --- | --- |
| Static discovery | Assert the Provider and every consumer call zero-argument `getCapabilities`; tags contain no config or secret projection; `resume` disappears from `teammate.get_capabilities` |
| Locator-free session identity | Prove fresh and resumed runtimes persist only session id; both readers locate active/closed history without a supplied native path; an old unused locator field neither crosses the seam nor forces fresh recovery |
| Lease without sequence | Concurrent calls serialize in receipt order; old-generation state and activity reject/drop after replacement; `start` cannot resolve before durable session and ready writes |
| Fixed schema | Claude spawn-schema and Codex per-native-turn adapters pass the same session-bound conformance suite; a differing later schema is unrepresentable, not a negotiated failure |
| Activity context | Built-in active and closed readers work with neutral session state, config, cwd, and environment; public types/errors contain no locator, path, scan mode, or literal byte budget |
| Channel initialization | A listener registered during `initialize` sees Core recovery events; only Channel-owned saga-recovery Commands run during `start`, and no external inbound or ordinary admission opens before every Channel `start` resolves |
| Channel shutdown | Invoker admission rejects synchronously before convergence; settlement events can still use live Channel resources; event revocation precedes final `session.close`; no post-fence Command is accepted |
| Event stall | A never-resolving listener never blocks Core or permits a later handler side effect to overtake it; queue memory remains bounded, drop classes are deterministic, and shutdown revokes only after the work fence and bounded drain |
| COT source/correlation | Scheduled and completion submissions with null correlation retain their anchor via required `turn_source`; Channel submissions return `turnId`, and opaque correlation is unchanged on all four turn fact categories |
| Team-create catalog | Identity is accepted and bounded; prompt and skill roots are rejected; an accepted id is never evicted, a closed replay returns the historical name, and full capacity rejects before acceptance |
| Egress | TeamLeader reply/react reaches any Provider/platform-permitted target without Core or Feishu binding-owner proof; caller context still drives only COT/audit |
| Fail-loud binding cutover | Old Core binding/Collaboration Space files are detected but never renamed, parsed, imported, rewritten, or removed; operator rebuild guidance is exact |
| First delivery | Automatic provisioning never sends the first message to Dispatcher before bind-ready and never submits it twice inside the saga |

The full Rush build/test, architecture gate, change-file verification, leak scan,
and both live runtime suites remain required during implementation. This design
round changes no product code and therefore runs no product gate itself.

## Residual risks

- **Locator-free discovery can be slower or fail in unusually large native
  history roots.** Both built-ins already bound discovery, but the locator fast
  path is removed. Active/closed reader benchmarks and bounded-scan failure
  fixtures are required; failure affects `last`, never Core status or settlement.
- **A permanently stuck Channel handler stalls that session's observer queue.**
  Core remains correct and memory remains bounded, but COT and Team-close
  invalidation can be lost until process restart. Advancing would permit
  out-of-order side effects; mid-run revocation would violate lifecycle
  coupling. This is the accepted best-effort trade-off.
- **The non-evicting idempotency ledger can reach capacity.** New provisioning
  then fails loud until an operator-approved future contract introduces a safe
  id-retirement horizon; this design never trades correctness for silent GC.
- **Fail-loud binding cutover has real operator cost.** Existing bindings must
  be recreated. Importing them would create the compatibility machinery and
  cross-owner state interpretation the task rejects.
- **A failed non-forced dissolve leaves children stopped and can admit more
  work after reopening.** The next dissolve rechecks current state; UI/MCP
  status must make `blocked_after_stop` and stopped children visible.
- **A crash after binding but before first submission may lose one external
  delivery.** Avoiding that would require a retained external-message outbox,
  which is not in the frozen persistence model. Team creation and readiness
  remain correct.
- **Channel-provided identity is privileged role text.** It is retained only to
  preserve current automatic-provisioning configuration, bounded and validated
  as a `team.create` field. Arbitrary prompt and skill-source injection remain
  excluded.

## Material disagreements that remain

Current source resolves the factual disputes above. Four solution trade-offs
remain disputed across proposals and would materially change the selected
design:

1. **Session-history location and migration.** My revised position passes only
   session id and uses bounded Provider discovery, avoiding both a new
   `dataDir` and an agent rebuild. Claude renames and transports the current
   locator as opaque Provider state; Trae keeps native locator concepts in the
   public seam. Selection changes the public Activity context, discovery cost,
   and upgrade behavior. I select locator-free discovery because the frozen
   contract excludes raw paths from the seam and both built-ins already support
   it.
2. **Slow event consumers.** Claude advances after a deadline, my first round
   revoked permanently, and Trae drops oldest events with weaker per-kind
   ordering. The revised position stalls only that session's pump, bounds its
   queue, and revokes after shutdown fencing. Selection changes concurrency and
   COT ordering, not Core authority.
3. **MCP capability composition.** Claude and Trae keep optional tool handling
   on the session; I keep a separate optional `mcp` composition so the lifecycle
   base has no tool member and sessionless tools have an explicit owner. This
   changes the public Channel contract and loader fixtures, but not behavior.
4. **Admission after a post-stop worktree block.** Claude's cross-review and my
   position reopen the Team so its leader can inspect/commit and stopped
   children can reopen lazily; Trae keeps the fence closed until Dispatcher or
   operator intervention. The requirement fixes the partial state but not this
   exit policy. Selection changes lifecycle availability and recovery tests. I
   select reopen-with-visible-blocked-state because a non-forced safety block
   must not make `force` or out-of-band filesystem work the only practical exit.

None of these disagreements justifies widening the Command catalog, restoring a
Core binding mirror, adding replay/snapshot, weakening recovery, or preserving a
legacy adapter. Those alternatives remain rejected.
