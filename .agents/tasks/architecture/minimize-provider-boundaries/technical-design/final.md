# Technical Design: Minimal Provider Boundaries

## Status and working authority

This is the current technical design baseline for the requirement at
`requirement.md` SHA-256
`29d1b68baf4e5dc69ad43d8d7a94b76a51ea3a70d2e8e6df59f06189d76ea42b`.

It reconciles the three independent proposals and their single cross-review
round. Requirement text, this design, current source, and prior Decisions are
evidence, not independent authorities that must be preserved. The target is the
final product shape and the operator's explicit product principles. Existing
mechanisms survive only when their purpose remains real and their ownership and
cost fit that target; being deployed, load-bearing, or historically recorded is
not a preservation argument. A discovered conflict stops implementation only
when it reveals a genuinely unmodeled product choice. Otherwise the TeamLeader
uses evidence to remove the obsolete or bad design rather than mechanically
making either the document or current code true. Development approval is tracked
separately in the task README.

This solution targets a fresh installation. Local Dispatcher, Team, Agent,
scheduler, and workflow records are operational and discardable; this task does
not design old-shape migration, lazy backfill, compatibility reads, or rebuild
instructions for them. Public package changes still receive normal release
notes, but an old local record is never allowed to complicate or become an
authority over the final state model.

## Governing principle: domain ownership drives names and code layout

The public protocol, exported types, internal modules, classes, and functions
must use the same Dreamux domain language. A name starts with the domain entity
that owns the action or fact, not the transport that happened to carry it, the
current call site, or a generic technical noun:

- Team-owned actions and aggregates use `team.*`, such as `team.create`,
  `team.submit`, and `team.state`;
- an individual Dreamux Agent entity is consistently called a TeamMate at the
  Core domain boundary, including Dispatcher and TeamLeader roles, so its facts
  use `teammate.state` and `teammate.turn.*`;
- `AgentRuntime` is reserved for the Provider/native execution seam and is not
  used as a competing name for the Core TeamMate entity;
- `Channel` names are reserved for bridge lifecycle, external transport,
  provider-owned routing, and the generic Command/event ports; a Channel call
  site never determines the name or owner of a Core capability.

Code organization follows the same rule. Team Command handlers, aggregates,
state, and policies live under the Team domain owner. TeamMate identity,
lifecycle, submission, settlement, Activity adaptation, and event publication
live under the TeamMate domain owner. Agent Runtime adapters and native session
logic stay behind the Provider seam. Channel transport adapters contain no Team
or TeamMate policy; generic Command/event dispatch contains no provider-specific
branching.

Internal classes and functions use the same ubiquitous language as their public
contract. Examples include `TeamSubmitCommand`, `submitToTeam`,
`TeammateStateEvent`, and `publishTeammateState`; ambiguous remnants such as
generic `agent`, global `turn.*`, transport-named domain handlers, and historical
callback names are renamed or deleted rather than hidden behind aliases. A
namespace is an ownership statement, not cosmetic grouping.

This is a standing implementation and review gate. Adding or moving behavior
requires identifying its authoritative domain owner first. If the natural owner
does not exist, reshape the module boundary instead of attaching the behavior to
the nearest service. Tests mirror the same domains and must prove that adapters
delegate to domain owners rather than reimplementing policy.

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
- Channel-to-Core mutation and `admin.sock` both use one generic Core Command
  registry through transport adapters with identical semantics;
- Core-to-Channel observation uses one live, best-effort subscription port;
- Channel MCP registration flows through Core into Dispatcher and TeamLeader
  Agent Runtimes, while their tool calls return through the same Core-owned
  proxy to live-session or provider-level Channel handlers;
- every registered Core Command is callable through both `admin.sock` and the
  Channel port, with no exposure policy; the Feishu refactor consumes only
  `team.submit` and idempotent `team.create`;
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
| Dreamux Core | Team and TeamMate state, runtime ownership, Command schemas and execution, admission and settlement, Team-create idempotency, event schemas and projection, state persistence, dissolve safety, MCP forwarding and caller context |
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
  readonly systemPrompt?: AgentRuntimeSystemPrompt;
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

interface AgentRuntimeMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

interface AgentRuntimeIdentity<TSession extends AgentRuntimeSessionRef> {
  readonly runtimeId: string;
  readonly session: TSession | null;
}

interface AgentRuntimeSessionRef {
  readonly id: string;
}

interface AgentRuntimeSystemPrompt {
  readonly replace?: string;
  readonly append?: readonly string[];
}
```

The two system-prompt forms are a neutral capability bridge, not duplicated
content. Dispatcher construction supplies both the complete replacement prompt
and a focused append delta. The Codex Provider consumes `replace` and ignores
`append` when replacement is present; the Claude Code Provider cannot replace
its native system prompt and consumes `append`. TeamLeader construction supplies
only `append`, which both Providers apply. Core therefore never branches on a
concrete Provider id, and a Provider never applies both Dispatcher forms.

Ordinary TeamMate and team-member construction also remains append-only. The
owner preserves the current fragment order: operation-owned fragments first,
followed by the persisted `identity_prompt` when present. Workflow contributes
`WORKFLOW_AGENT_SYSTEM_PROMPT` as an operation-owned fragment before the
identity fragment so its machine-result and structured-output contract remains
model-facing policy rather than turn text. TeamLeader construction similarly
keeps its deterministic Team role fragments before its optional persisted
identity fragment.

Dreamux owns prompt sources, not rendered Provider prompt blobs. Persisted
identity records and deterministic owner policy reconstruct the same ordered
bundle for initial creation, close/reopen, process restart, Team rebuild, and
runtime resume. Codex receives append-only bundles as rendered
`developerInstructions` on fresh `thread/start`, `thread/resume`, and fallback
`thread/start`; it cannot rely on native persistence because Codex does not
persist `developerInstructions`. Claude Code receives the rendered bundle again
through `--append-system-prompt` whenever its resident process is spawned,
including a `--resume` spawn. Providers own idempotence against their native
session model, but they never become the source of prompt persistence.

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
  submit(input: AgentRuntimeSubmissionInput): Promise<RuntimeAdmission>;
  stop(): Promise<void>;
}

interface AgentRuntimeStartOutcome {
  readonly continuity: "fresh" | "resumed";
}

interface AgentRuntimeSubmissionInput {
  readonly text: string;
}
```

`RuntimeAdmission` contains `submitted`, `stopped`, `skipped`, `failed`, and
`ambiguous`. Only `submitted` carries the immutable `RuntimeSubmission` object
whose identity Core uses as the settlement correlation key. Source-derived
`duplicate` is no longer a Provider result: Core returns it before calling the
runtime when its admission ledger has already accepted the same source key. The
Command boundary normalizes internal `skipped` to public `stopped`; the Provider
seam does not.

The runtime input is deliberately flat. Core keeps stable source identity,
authoritative origin, intent, opaque display correlation, and event
`turn_source` on its own turn/admission state. A Provider receives only text; it
neither receives nor interprets an `InboundTurnInput`, a Channel/Dreamux source
enum, source id, or XML rendering instructions.

Channel produces its source attributes, faithful model-facing body text, and
optional reminder before invoking Core. Dreamux-owned completion, scheduler,
control, prompt, and Workflow paths likewise provide their source-specific
body. `TeammateService` assembles the common outer source envelope, then calls
the Runtime with final text. Consequently replacing `channelInput` and
`completionInput` does not introduce a Provider-side discriminator that
recreates the old split under `submit`.

Core applies the same reduction at the `TeammateService` admitted-input seam.
One internal `submitInput` accepts the model-facing quartet `source`, `attrs`,
`text`, and optional `reminder`, plus only the separate Core admission/turn
metadata actually consumed by that submission. `source` is an open string that
must be a safe tag name; it is not a Core enum, while the exact semantic name
`system` is always rejected. A Channel invocation obtains `channel` from its
factual `CoreCommandContext` and cannot supply or override the value. Stable
source identity, authoritative Channel admission scope, intent, correlation,
and completion delivery do not become XML attributes. The service exposes no
`channelInput`, `scheduledInput`, or `controlInput` wrappers, no
caller-selected `reopenClosed`, and no logging label. Every ordinary admitted
input starts or reopens the target before Runtime submission.

The renderer emits `<source ...attrs>`, the body text exactly as the source's
model-facing formatter produced it, and `</source>` with no extra content node
or pretty-print indentation. Attribute names are validated as snake_case XML
names and invalid names fail loud; attribute values are escaped. The body is
not rewritten merely to satisfy an XML parser: no entity conversion, CDATA
wrapper, or XML-specific code element is added. Channel code uses ordinary
Markdown fences. An optional reminder is emitted once after the closed source
block as the final generic `<reminder>...</reminder>` sibling. It is never
repeated inside each message. These XML-like tags improve model provenance and
boundary recognition; they are not treated as an injection or authorization
boundary.

Cron cancellation remains private to Scheduler. A due fire checks its lifecycle
generation and current durable job immediately before calling `submitInput`.
Scheduler never passes an `AbortSignal` through Core: the signal could only
prevent a held fire before Runtime admission and could never cancel an already
submitted turn. Because this design has no idle wait or held fire, the signal
and its cross-service contract have no surviving purpose.

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
  readonly identity?: ChannelIdentityCapability<TConfig>;
  readonly onboard?: ChannelOnboardCapability;
  readonly diagnostic?: ChannelDiagnosticCapability;
  readonly mcp?: ChannelMcpCapability<TConfig>;
}

interface ChannelIdentityCapability<TConfig> {
  get(config: TConfig): string;
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

type ChannelMcpCaller =
  | { readonly kind: "dispatcher" }
  | {
      readonly kind: "team_leader";
      readonly team_name: string;
      readonly leader_name: string;
    };

interface ChannelMcpCapability<TConfig> {
  describe(
    config: TConfig,
    context: { readonly caller: ChannelMcpCaller },
  ): readonly ChannelMcpToolRegistration[];

  invoke?(
    call: ChannelMcpCall,
    context: ChannelMcpCallContext,
  ): Promise<JsonValue>;
}

interface ChannelMcpToolRegistration {
  readonly tool: ChannelMcpToolDescriptor;
  readonly target: "session" | "provider";
}

interface ChannelSessionMcpCapability {
  invoke(
    call: ChannelMcpCall,
    context: ChannelMcpCallContext,
  ): Promise<JsonValue>;
}

interface ChannelMcpCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
}

interface ChannelMcpCallContext {
  readonly dispatcher_id: string;
  readonly channel_id: string;
  readonly caller: ChannelMcpCaller;
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
does not implement fake members. A `target: "session"` registration requires the
created instance's `mcp` handler; a `target: "provider"` registration requires
the Provider capability's optional `invoke` handler. Core validates those pairs
before injection, so no unavailable tool is advertised. Provider
identity/config discovery and operational capabilities remain direct
control-plane concerns. As with Agent Runtime Providers, Channel registration
`ref` and `descriptor` live only in Core's `RegisteredProvider` wrapper and are
not echoed on this interface.

### 2.2 Command protocol

There is one authoritative `CoreCommandRegistry`, not an admin method table plus
a Channel catalog. Three adapters converge on it:

```text
admin CLI / Dreamux MCP shims -> admin.sock NDJSON adapter --\
ChannelProvider              -> in-process invoke adapter ----> CoreCommandRegistry
Channel MCP stdio shim       -> admin.sock NDJSON adapter --/          |
                                                                      v
                                                           domain Command handler
```

Both public adapters accept a name and JSON-compatible payload. They resolve the
same definition, run the same input shape/size validation and output
shape/JSON-representability validation, attach their factual caller context,
execute the same domain handler, and return the same typed result or error. The
registry adds no generic output byte cap without a concrete domain failure
scenario: Activity, history, list, and capability results retain their existing
domain-owned pagination or source bounds. The socket envelope
`{id, method, params}` is only transport framing.
`adminMethods` is deleted as an independent authority; the admin server becomes
an adapter over the registry.

Errors remain ordinary classes, not a second public layering protocol:

```ts
class DreamuxError extends Error {
  readonly code: string;
}

class ValidationError extends DreamuxError {}
class TransportError extends DreamuxError {}
class InternalError extends DreamuxError {}

class TeamNotFoundError extends DreamuxError {}
class TeamClosedError extends DreamuxError {}
class TeamGenerationChangedError extends DreamuxError {}
class IdempotencyConflictError extends DreamuxError {}
class ServerShuttingDownError extends DreamuxError {}
```

There is no `DomainError` base class and no public `layer`, `category`, or
`retry` taxonomy. The registry validates all inputs before domain execution.
Only cross-process framing, connection, timeout, malformed-response, and
delivery failures become `TransportError` with stable code `TRANSPORT_ERROR`;
they are never reported as `BAD_REQUEST`. Business handlers throw their specific
`DreamuxError` subclass. Team absence, closure, and generation replacement are
different errors with operation-independent codes; a read or route lease never
reports `TEAM_SUBMIT_FAILED`. Only an unknown implementation failure becomes
`InternalError`. MCP adapters convert these errors into one stable, concise,
model-understandable tool failure format without exposing the inheritance tree
on the wire.

```ts
interface CoreCommandDefinition<Name extends string, Input, Output> {
  readonly name: Name;
  readonly version: 1;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
  parse(payload: JsonValue): Input;
  execute(context: CoreCommandContext, input: Input): Promise<Output>;
}

type CoreCommandSource = "admin_socket" | "channel" | "mcp_proxy";

interface CoreCommandContext {
  readonly source: CoreCommandSource;
  readonly dispatcher_id?: string;
  readonly channel_id?: string;
  readonly caller?: ChannelMcpCaller;
}

interface CoreCommandRegistry {
  invoke(
    context: CoreCommandContext,
    name: string,
    payload: JsonValue,
  ): Promise<JsonValue>;
}
```

`source` and caller fields are facts needed by some domain operations, logging,
deduplication, or the Channel-MCP lease. They never filter the registry. There
is deliberately no exposure/audience property, allowlist, describe-by-caller,
or capability negotiation: every registered Command is callable by both the
admin-socket and Channel adapters, subject only to the Command's ordinary input
and domain invariants.

The normalized registry is grouped by the entity that owns each action:

| Namespace | Canonical Commands after this refactor |
| --- | --- |
| Server | `server.status` |
| Dispatcher | `dispatcher.list`, `dispatcher.status`, `dispatcher.start`, `dispatcher.stop` |
| Team | `team.create`, `team.submit`, `team.list`, `team.status`, `team.history`, `team.dissolve` |
| TeamMate | `teammate.spawn`, `teammate.submit`, `teammate.close`, `teammate.list`, `teammate.status`, `teammate.history`, `teammate.last`, `teammate.capabilities` |
| Workflow | `workflow.run`, `workflow.status`, `workflow.stop`, `workflow.list` |
| Scheduler | `scheduler.cron.create`, `scheduler.cron.update`, `scheduler.cron.delete`, `scheduler.cron.list` |
| Channel MCP infrastructure | `channel.mcp.describe`, `channel.mcp.invoke` |

The inventory deliberately removes `team.bind_channel` and
`team.transfer_back`: external binding is Channel-owned MCP behavior. It removes
the complete `collaboration_space.*` family with the deleted Core container.
`channel.invoke_tool` is replaced by the generic lease-bound
`channel.mcp.invoke`. `team.send` and `teammate.send` become the domain-consistent
`team.submit` and `teammate.submit`; no old-name aliases remain. CLI and
Agent-facing MCP tool names may remain human-oriented adapter vocabulary, but
their execution delegates to these canonical Commands rather than reimplementing
schemas or policy.

Feishu uses only `team.submit` and `team.create` in this implementation. That is
a consumer scope statement, not a smaller registry or a permission boundary.
Another Channel can invoke any Command above without a Core contract change.

The two Commands whose contracts change materially for Channel use are:

#### `team.submit`

```ts
interface TeamSubmitCommand {
  readonly team_name?: string;
  readonly text: string;
  readonly intent?: string;
  readonly source_id?: string;
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
stable Team and submits only to its TeamLeader. Channel and admin adapters use
the same Command definition. A Channel supplies attributes, faithful body text,
and an optional reminder; `TeammateService` renders the paired `<channel>` block
and forces the source from factual Channel context. The invoker scopes a
Channel-supplied source identity to the calling Channel. A
`submitted` result carries the Core `turn_id`; `duplicate` does not invent one
because Core did not create a second runtime submission or turn identity.

Core owns one bounded, process-local admission ledger per target entity and
Core-known invocation-origin scope. A non-empty `source_id` reserves the key
before runtime admission. Concurrent repeats await the same pending admission;
`submitted` or `ambiguous` commits the key into the bounded recent window and a
later repeat returns `duplicate`; `failed`, `stopped`, or provider-internal
`skipped` releases it. An omitted or empty `source_id` bypasses deduplication.
The ledger deliberately retains the current no-cross-restart guarantee.

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
type TeamCreateRepoRequest =
  | {
      readonly mode: "reuse-cwd";
      readonly path?: string;
    }
  | {
      readonly mode: "managed";
      readonly path?: string;
      readonly base_ref?: string;
      readonly branch?: string;
      readonly slug?: string;
      readonly cleanup?: "keep" | "delete-on-close";
    };

interface TeamCreateCommand {
  readonly request_id: string;
  readonly name_prefix: string;
  readonly intent: string;
  readonly leader: {
    readonly agent_runtime: string;
    readonly identity?: string;
    readonly prompt?: string;
    readonly skill_sources?: readonly AgentRuntimeSkillSource[];
  };
  readonly repo?: TeamCreateRepoRequest;
}

interface TeamCreateResult {
  readonly status: "created" | "existing" | "closed";
  readonly team_name: string;
  readonly leader_name: string;
}
```

The payload preserves the existing admin Team-creation capability while adding
restart-durable request identity. An omitted `repo` retains the existing default
workspace behavior. `reuse-cwd` preserves reuse of a caller-selected or default
working directory. `managed` preserves the existing optional path, base ref,
branch, slug, and cleanup controls. Core still injects mandatory TeamLeader
instructions and skill sources; supplied values extend rather than remove those
requirements.

Feishu automatic provisioning supplies only the smaller repository policy it
owns. The Channel maps its local `{path, base_ref}` policy into
`{mode: "managed", path, base_ref, cleanup: "delete-on-close"}` before invoking
the canonical Command. This fixed mapping is private to Feishu-owned automatic
provisioning. The generic Team MCP and `admin.sock` surfaces continue to expose
the complete canonical repository union and honor an explicit cleanup value;
neither is a Feishu-specific tool. The shared Command therefore does not define
a Feishu-only schema.

Core canonicalizes the validated creation payload and writes its `request_id`
and payload hash into the Team record. Exclusive atomic publication of that
record is the single acceptance and concrete-name ownership point. There is no
separate `team-create-requests.json`, `name-claim.json`, claim token, or Team-name
tombstone.

Before the Team record is published, no Team exists and no name is occupied. A
hard process loss in that interval may cause the retry to choose a different
random candidate, which is correct because no accepted Team or externally valid
route existed. After publication, the same id and hash return that Team across
Core restart and Team closure; the same id with a different hash raises
`IdempotencyConflictError`. A closed replay returns `closed`; a new provisioning
generation uses a new request id.

At startup Core scans Team records to reconstruct a process-local request-id
index; that index is derived acceleration, never another persisted authority. A
missing, malformed, or unreadable record means that Team does not exist for
lookup, routing, or name allocation and produces `TeamNotFoundError`. It cannot
receive a Channel turn or reserve a concrete name. A real write failure while
publishing a replacement record is reported as a persistence failure rather
than creating a phantom Team.

All other state below that Team directory is subordinate for Team existence.
Without a valid Team record, an old TeamLeader identity, scheduler file,
workflow state, member collection, or cached in-memory record is orphan data: it
cannot block reuse of the concrete name, be adopted by routing, or recreate the
Team through a later ordinary update. This is intentional data handling: an
identity without the sole existence record belongs to no product Team and has
no preservation authority.

The Team record is not a second complete TeamLeader identity. It retains Team
existence and lifecycle, `leader_name`, and only the stable Team-owned creation
inputs required to call the ordinary `TeamMateService` creation path when the
leader has no usable identity: the accepted normalized identity prompt and
normalized skill sources are included. Provider session, Agent status, last
error, and other mutable runtime state remain solely in the TeamLeader identity.
An aligned identity is restored exactly; the Team record fields are neither
compared with it nor used to overwrite it. This is a creation request plus a
minimal relationship check, not two peer Agent-state authorities.

Records that predate this final shape are outside the implementation contract.
If the two stable creation-input fields are absent, they read as an empty prompt
and empty caller-supplied skill list. Core does not backfill them from an aligned
identity and does not fail the Team for their absence. This narrow default is not
an upgrade system; it merely keeps missing disposable data from becoming a new
product authority.

`AgentEntityIdentity` no longer persists `role`. Runtime topology already owns
that fact: `DispatcherService` creates the Dispatcher Agent, its
`TeammateCollection` creates Dispatcher-scoped TeamMates, `TeamService` creates
the TeamLeader, and its `TeammateCollection` creates Team-scoped TeamMates. The
directory hierarchy encodes the same scope. `team_member` is deleted from
persisted types, internal domain vocabulary, and public event values without a
compatibility alias.

The object graph binds persistence roots at construction:

```text
{DREAMUX_HOME}/state/{dispatcher_id}/
├── identity.json
├── teammate/{teammate_name}/identity.json
└── team/{team_name}/
    ├── record.json
    ├── identity.json
    └── teammate/{teammate_name}/identity.json
```

`DispatcherService` receives the Dispatcher state root and passes its
`teammate/` and `team/` child roots to the corresponding Collections.
`TeamCollection` passes `team/{team_name}` to `TeamService`; `TeamService` uses
that root for its TeamLeader and passes its `teammate/` child root to the
Team-scoped `TeammateCollection`. A Collection appends only the concrete entity
name. A `TeamMateService` and its identity storage receive the already-resolved
entity directory.

Consequently no lower layer receives a logical locator tuple and recomputes its
own path. In particular, identity read/write/update APIs do not accept or inspect
`role` to choose a directory, and persisted identity contents never decide where
they are stored. The host path builders are used by the owning composition root
when it initializes children, not by an identity store trying to rediscover its
owner.

Reconciliation checks only `dispatcher_id`, `team_id`, and
`name === team.leader_name` to prove that the identity belongs to the Team's
leader. It does not compare or synchronize every identity field with the Team
record. If the readable identity agrees, Core preserves it verbatim and asks
`TeamMateService` to restore the TeamLeader only from that identity, including
its Provider session.

When prompt/skill composition, completion routing, runtime validation, or event
presentation needs a role, the owning Service or Collection supplies the
runtime-derived value `dispatcher`, `team_leader`, or `teammate`. No derived role
is written back into durable identity.

If an active `starting` or `running` Team has no readable aligned identity, the
Team layer does not synthesize or persist one. It calls the normal
`TeamMateService` creation operation with the Team-owned leader creation inputs;
that owner creates and persists identity as part of creating the TeamLeader and
then starts the runtime from its own identity. A malformed or ownership-
mismatched identity, including orphan identity at a reused concrete name, is
replaceable only inside that TeamMate-owned creation operation. A `starting`
Team moves to `running` only after the leader is usable; a `running` Team
restores its leader without inventing a second Team; a `closed` Team never
starts one. Ordinary-error cleanup remains in place. This is deterministic
aggregate reconciliation through the existing owner, not direct cross-store
repair, a new durable recovery record, name claim, or general coordinator.

All other surviving definitions retain their current domain behavior while
moving parsing, errors, and execution out of `admin/methods.ts` into their
domain-owned Command modules. The Channel adapter can invoke them without
additional registration. Non-Command Provider configuration, onboarding, and
diagnostics remain direct control-plane capabilities.

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
  /** Runtime projection supplied by the owning Service; never persisted. */
  readonly role: "dispatcher" | "teammate" | "team_leader";
  readonly team_name: string | null;
  readonly status: "starting" | "running" | "degraded" | "stopped" | "closed";
}

interface TeamStateTeammateSummary {
  readonly teammate_name: string;
  /** Runtime projection supplied by TeamService; never persisted. */
  readonly role: "team_leader" | "teammate";
  readonly status: "starting" | "running" | "degraded" | "stopped" | "closed";
}

interface TeamStateEvent {
  readonly kind: "team.state";
  readonly occurred_at: number;
  readonly team_name: string;
  readonly leader_name: string;
  readonly status: "starting" | "running" | "closed";
  readonly teammates: readonly TeamStateTeammateSummary[];
}
```

All Dreamux Agent entities are TeamMates at this event boundary. Persisting a
new Dispatcher, TeamLeader, Team-scoped TeamMate, or Dispatcher-scoped TeamMate
publishes its first `teammate.state`; later state transitions publish the same
kind. No separate creation event is added. A Dispatcher has `team_name: null`
and never appears in a `team.state` teammate summary. Event `role` is derived by
the publisher from its runtime owner and scope; it is not read from identity.

`team.state` is intentionally redundant. Core republishes the aggregate when
the Team lifecycle changes or when a contained TeamLeader/TeamMate is created or
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

Channel MCP has two opposite halves and is the third cross-boundary mechanism,
separate from Channel Commands and events:

```text
registration / injection
ChannelProvider.mcp.describe(config, caller)
  -> Core validates the caller-specific registrations
  -> Core builds its own channel-MCP proxy descriptor
  -> AgentRuntimeCreateContext.mcpServers
  -> Agent Runtime Provider configures the native Agent exactly as supplied

tool invocation
native Agent tools/call
  -> MCP JSON-RPC over the Core-owned stdio proxy
  -> Core Channel-MCP router with baked caller/channel scope
  -> ChannelInstance.mcp.invoke OR ChannelProvider.mcp.invoke
  -> canonical Channel result/error returns along the same route
```

Core asks `describe` only for Dispatcher and TeamLeader runtime construction.
It never injects Channel MCP into an ordinary Team member or standalone
TeamMate. The Channel returns a caller-specific catalog, so Feishu's
`bind_channel`, `unbind_channel`, and `list_bindings` registrations appear only
for Dispatcher while reply/react may also appear for TeamLeader. Core does not
know those names or encode their product policy.

For each non-empty catalog, Core validates unique names, JSON-compatible tool
metadata, input/output schemas, and declared handler target. It then creates a
short-lived in-memory `ChannelMcpLease` bound to the runtime generation,
dispatcher, configured Channel instance, caller, validated registrations, and
resolved handlers. The public Provider seam does not expose this host lease.

Core gives the Agent Runtime an `AgentRuntimeMcpServer` for one generic
`dreamux channel-mcp` stdio shim. Its launch data contains only the admin-socket
location and an opaque lease token, preferably through the child environment
rather than command-line JSON. It does not carry a base64 tool catalog,
provider ref, caller fields, or Channel policy. The Agent Runtime Provider
launches exactly the supplied MCP server list; it neither discovers Channel
tools nor loads Channel packages.

At shim startup, one internal `channel.mcp.describe` request presents the lease
token over the existing Unix admin socket. Core checks the live lease and
returns its already validated tool metadata. The shim creates one official MCP
SDK `McpServer` and programmatically calls `registerTool` for every returned
descriptor. Each registered SDK handler is the same small closure parameterized
only by tool name: it sends `channel.mcp.invoke {lease, name, arguments}` back
over the socket. The official SDK remains the sole owner of MCP negotiation,
`tools/list`, input/output schema validation, cancellation, and JSON-RPC error
framing.

On invoke, Core verifies that the lease is live and the named tool belongs to
its frozen catalog, then dispatches using the registration's `target`, never a
hard-coded tool name. `session` reaches the resolved
`ChannelInstance.mcp.invoke`; `provider` reaches the resolved
`ChannelProvider.mcp.invoke` and works without a live session. The canonical
result/error returns through the same Unix socket and stdio connection. The
model supplies only tool arguments; routing identity is absent from its schema.

Catalogs are immutable for one runtime generation. A configuration or catalog
change takes effect on the next runtime construction rather than mutating an
already initialized MCP server. Runtime replacement or stop revokes all of its
Channel MCP leases synchronously; a late describe/invoke fails before Channel
dispatch. Channel handlers remain alive until accepted runtime work and MCP
calls have converged during shutdown.

This retains one unavoidable process hop: the native Agent owns a stdio MCP
child while the authoritative Channel instance lives inside Dreamux Core. The
generic shim plus one Unix-socket hop is the minimum that preserves both facts.
Loading the Channel Provider in the shim would create a second Channel authority;
moving MCP serving into every Agent Runtime Provider would leak Channel and MCP
policy through the neutral runtime seam; a Core-hosted HTTP MCP server would add
listener, authentication, transport-support, and lifecycle surface without
removing the proxy boundary. All three alternatives are rejected.

Caller context survives only where MCP dispatch, audit, logging, and existing
COT anchoring consume it. Core binding-owner and message-to-target proof are
deleted and must not be recreated inside the Provider. External-platform access
rules and provider schema/errors remain intact.

Feishu owns `bind_channel`, `unbind_channel`, and `list_bindings`. They are
Dispatcher-audience tools enforced from the retained caller context. They are
not Core Commands and there is no `transfer_back` alias. Feishu also owns the
Dispatcher-only `bind_collaboration_space`, `unbind_collaboration_space`,
`get_collaboration_space`, and `list_collaboration_spaces` tools. This suite
preserves the explicit product operation of registering a Feishu group/topic
container for automatic Team provisioning; it does not restore a Core
Collaboration Space entity. Reply/react and other Channel tools continue to use
the same MCP path.

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

The same Channel-owned document has a separate Collaboration Space policy
section keyed by Feishu's opaque container metadata. It records the Team
creation policy and the hierarchy rule used to recognize child targets; it does
not contain a Core Collaboration Space id. The four Feishu Collaboration Space
MCP tools create, remove, read, and list only those policy records.

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

When an unmatched Feishu child target belongs to a locally registered
Collaboration Space policy, the Channel starts automatic provisioning. It
persists `{generation, request_id, phase, space_policy_id, target_metadata,
first_delivery_identity}` before invoking Core. It then:

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
callbacks, policy configuration, and events are deleted. The Feishu MCP suite
and Channel-owned policy replace the external user flow without recreating that
Core authority. Unbinding a Collaboration Space stops future automatic
provisioning but does not dissolve already-created Teams; target close removes
the target's default binding and does not dissolve the ordinary Team.

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
ambiguity. Scheduler validates its own lifecycle generation and the current
durable job immediately before submission; this owner-local fence does not add
an `AbortSignal` or scheduler-specific method to `TeammateService`.

## 5. Change inventory

### Reuse

- Core turn admission, `RuntimeSubmission` settlement identity, and
  `skipped -> stopped` normalization;
- Core Agent identity/history/state projections;
- existing Provider config/onboard/diagnostic behavior;
- current COT activity normalization, projection, redaction, truncation, and
  Feishu display;
- current Channel MCP descriptor generation and admin forwarding concepts;
- Team creation, valid-record-owned names, managed-worktree containment, and
  atomic JSON state primitives;
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
  the similarly named Feishu Channel MCP product flow remains;
- `bind_channel` and `transfer_back` from Team MCP, with no aliases.

### Add or reshape

- minimal Agent Runtime types and loader conformance;
- retained neutral system-prompt `{ replace?, append? }` delivery, with
  Dispatcher replacement/append selection owned by each Provider adapter and
  TeamLeader instructions remaining append-only;
- leased state/activity sinks and `fresh | resumed` start result;
- neutral active-session Activity reader and `last` adapter;
- unified Core Command registry, domain-owned schemas/handlers, admin-socket and
  in-process adapters, typed errors, and Team-record-owned creation identity;
- six-event registry, fail-open scoped subscriptions, and lifecycle fencing;
- Channel lifecycle port and optional MCP composition;
- Feishu-owned direct binding and Collaboration Space policy/provisioning state,
  plus both MCP tool suites;
- dissolve partial-state and background-cleanup state machine;
- fail-loud legacy-state/config detection and operator instructions.

## 6. Implementation sequence

One implementation branch and PR may contain the work, but changes land in this
dependency order:

1. reshape `@excitedjs/dreamux-types` contracts and root export locks;
2. update Codex and Claude Code providers to the new runtime, state, structured
   output, Activity, and prompt-re-supply contracts;
3. organize Core implementation by the Team and TeamMate domain owners, then
   implement runtime ownership, Activity reader, Command/event registries,
   lifecycle fences, scheduler, dissolve, and Team-record-owned idempotency;
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
- Runtime contract fixtures prove `submit` accepts only prepared text, with no
  source identity, Channel/plain-text discriminator, source enum, inbound
  envelope, or runtime-owned XML rendering.
- A resumed fixture proves non-null session continuity, loud recovery failure,
  continuity reporting before first submit, and stop-racing-start convergence.
- Prompt fixtures prove Dispatcher replace/append selection, TeamLeader
  append-only delivery, ordinary TeamMate/Workflow fragment ordering, and
  re-supply on close/reopen, process restart, Team rebuild, native resume, and
  resume-fallback fresh launch without Core Provider-id branching.
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
- A minimal Channel fixture constructs, initializes, subscribes, starts, invokes
  `team.submit` and `team.create`, receives each event kind, and closes without
  any provider-specific or MCP stub.
- Registry contract tests enumerate every canonical Command and prove the admin
  socket and Channel adapters resolve the same definition, schema, handler,
  result, and error. No adapter owns a second method table or exposure policy.
- A no-MCP fixture has no MCP composition; live and sessionless MCP fixtures
  both forward tools with caller context.
- Channel MCP injection tests prove caller-specific catalogs reach only
  Dispatcher and TeamLeader create contexts, ordinary TeamMates receive none,
  and Agent Runtime Providers launch the exact Core-supplied MCP descriptors.

### Behavioral gates

- `team.submit` tests cover Dispatcher/default delivery, TeamLeader delivery,
  duplicate, stopped, failed, ambiguous, stable `turn_id`, opaque correlation,
  and retry only after `TEAM_NOT_FOUND`/`TEAM_CLOSED`.
- Core admission tests prove target-and-origin-scoped pending coalescing,
  bounded process-local dedupe, commit only after `submitted`/`ambiguous`, key
  release after `failed`/`stopped`/`skipped`, bypass without `source_id`, and no
  source id crossing the Agent Runtime seam.
- Channel submission tests prove TeammateService renders the paired `<channel>`
  block with direct faithful body text and at most one final sibling
  `<reminder>`, while Core preserves origin, correlation, event source,
  admission, and settlement outside the Runtime payload. Tests retain Markdown
  code fences and prove the body is not entity-escaped, CDATA-wrapped,
  XML-code-wrapped, or indented by the outer renderer.
- `team.create` tests cover failure before record publication, failure after the
  record acceptance point, and readiness; same-id replay, closed replay,
  different-payload conflict, exclusive atomic publication, request-index
  reconstruction, and name ownership only while a valid record exists.
- Channel saga tests cover crash/restart at every persisted phase,
  ready-before-bind, bind-before-first-submit, generation replacement, and no
  target data in Core.
- Binding tests cover exact topic then parent fallback, independent unbind,
  multiple bindings per Team, Team-close invalidation, defensive stale cleanup,
  Dispatcher-only binding tools, and no Core binding mirror/query.
- Feishu Collaboration Space tests cover explicit bind/unbind/get/list, child
  target recognition, idempotent Team provisioning, no eager Core container,
  unbind without Team dissolve, and absence of Core Collaboration Space state,
  Commands, events, or types.
- State-event tests prove creation and every later lifecycle transition publish
  `teammate.state` for Dispatcher, TeamLeader, ordinary member, and standalone
  TeamMate roles; contained changes also republish `team.state` with the current
  TeamLeader/member summaries and never place Dispatcher in a Team snapshot.
- Channel MCP round-trip tests cover registration validation, Dispatcher versus
  TeamLeader visibility, lease-bound caller/channel scope, official-SDK dynamic
  registration, session and provider handler targets, canonical result/error
  return, lease revocation, and absence of catalog JSON or tool-name branches in
  launch arguments and Core.
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
- Negative surface tests prove deleted methods, callbacks, events, Core
  Collaboration Space Commands/types, aliases, and binding stores cannot be
  imported or loaded; they do not reject the Feishu-owned MCP tools or policy.
- Architecture tests enforce the domain vocabulary and import boundaries:
  `team.*` handlers delegate to the Team owner, `teammate.*` facts originate in
  the TeamMate owner, `AgentRuntime` names stay behind the Provider seam, and
  Channel/transport modules do not own Team or TeamMate policy.

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

This is a source-incompatible change and defines a fresh local-state model:

- use Rush change files for every affected package;
- 0.x packages use `minor` with a `BREAKING:` lead; packages already past 1.0
  use the real semver breaking level required by the repository;
- no migration, compatibility, or `Rebuild:` contract is created for superseded
  local Dispatcher/Team/Agent runtime state;
- no generated changelog is hand-edited;
- public type export-lock tests are updated intentionally;
- config/state ownership changes update
  `packages/dreamux/skills/dispatcher/dreamux-maintenance/` in the same change;
- update current architecture, Channel runtime, state/path, and repository
  references under `.agents/`, then run the knowledge gate.

Change notes must explicitly cover Provider contract replacement, Activity
Records, removal of the Core Collaboration Space and binding state/config,
replacement by Feishu-owned Collaboration Space policy/tools, Channel-owned
binding recreation, scheduler/dissolve behavior, and removed MCP/admin names.

## 9. Rejected alternatives

- Do not translate every old `ChannelRoutes` callback into a Command.
- Do not build a Channel-specific Command subset, exposure policy, or duplicate
  handler table. Feishu's two-command consumption scope is not a registry
  boundary.
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
