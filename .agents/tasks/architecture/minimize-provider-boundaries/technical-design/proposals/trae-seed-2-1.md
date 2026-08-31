# Technical Design: Minimal Provider Boundaries

Author seat: `trae-seed-2-1`
Target branch: `refactor/minimal-agent-runtime-provider`
Revision: independent first-round proposal (no other proposal read)

## 1. Summary

This proposal replaces the growing `AgentRuntimeProvider` / `AgentRuntime`
handle and `ChannelProvider` / `ChannelSession` / `ChannelRoutes` surfaces with
four narrow, capability-neutral seams:

1. **Provider control plane** (synchronous, in-process): identity, config
   parsing, onboarding, diagnostics, Provider-level discovery metadata, and
   (for Agent Runtimes) a neutral `readRecentActivity` reader plus
   `createRuntime`.
2. **Live runtime handle**: exactly `start`, discriminated-union `submit`,
   `stop`. All state transitions push through a leased Core-owned sink; there
   are no pull queries and no idle wait.
3. **Channel session**: `start(commandSink, eventSource)`, `close()`, plus
   optional composed MCP-tool surfaces. The old `ChannelRoutes` bag of
   callbacks (`deliver`, `targetLifecycle`, `ensureCollaborationTarget`,
   `deliverExact`) collapses to one typed `invoke(command)` primitive and one
   `subscribe(kind, listener)` source.
4. **Channel-owned MCP registration**: a typed catalog + dispatcher that
   supports both live-session and sessionless tools, including Channel-owned
   `bind_channel` / `unbind_channel` / `list_bindings`. Binding moves entirely
   to Channel-owned state; Core Collaboration Space is deleted.

The design preserves every invariant called out in the requirement and review
findings: start/stop single-flight, synchronous submit fencing, late-start
termination, failed-start rollback, exactly-once immutable submission identity,
FIFO per-recipient delivery, fail-open observation, opaque turn correlation,
restart-durable idempotent `team.create`, immediate dissolve with optional
`force`, and frozen post-COT event display.

## 2. Ownership

- **Core (`packages/dreamux`)** owns:
  - Agent Runtime host orchestration (loader, launcher, runtime owner,
    settlement router, completion router).
  - Command catalog, Command bus, typed error envelope, idempotency ledger for
    `team.create`.
  - Event catalog, event bus, leased event source, shutdown fencing, ordered
    delivery, slow-consumer isolation.
  - Agent MCP server assembly, including the Channel MCP proxy.
  - Team / TeamMate / Dispatcher / Workflow / scheduler domain state (unchanged
    except for deletions listed in §10).
  - Team dissolve orchestration including worktree preflight, child stop,
    logical-close acceptance, and async cleanup.
  - Durable identity state for Teams, TeamMates, and the Dispatcher (the
    existing `identity.json` / `record.json` model).
  - Host path builders (`platform/paths.ts`), including new Channel-owned state
    roots.
- **`@excitedjs/dreamux-types`** owns the public, declaration-only contract
  surfaces every provider implements. All new interfaces are typed here so
  external packages compile against types alone.
- **Agent Runtime providers** (e.g. `@excitedjs/agent-runtime-codex`) own:
  - Engine lifecycle, native submission, engine-native checkpoint/recovery,
    engine-native activity projection into Dreamux Activity Records (for
    `readRecentActivity`), and push of status/checkpoint through the Core
    sink.
- **Channel providers** (e.g. built-in Feishu) own:
  - External transport, message normalization, Command selection, outbound
    rendering, provider-specific MCP tools, external-route binding state and
    persistence, automatic-provisioning saga (if any), and Channel-local state
    migration. They never parse or persist Dreamux internals beyond the stable
    `team_name`.

No layer depends on a concrete Channel or Runtime identity. Core production
code must not branch on `providerRef` or `channel_id`.

## 3. New public types

The following replaces the existing public surfaces in
`packages/dreamux-types/src/agent-runtime.ts` and
`packages/dreamux-types/src/channel.ts`. Type names are final for the purpose
of this design; field lists are complete.

### 3.1 Agent Runtime provider

```ts
// Mandatory base. Every loadable provider implements all of these.
export interface AgentRuntimeProvider<TConfig = unknown> {
  readonly ref: string;
  readonly descriptor: AgentRuntimeProviderDescriptor;

  // Discovery metadata. Dreamux may call this at any time after config is
  // parsed (or with unparsed config, in which case the provider returns
  // config-independent tags only). Return value is Provider-static plus
  // parsed-config characteristics; never exposes secrets or private env.
  getCapabilities(config?: TConfig): AgentRuntimeCapabilities;

  // Optional composed capabilities are accessed via feature tests on the
  // provider object, not via the capabilities record:
  //   readConfig?   — config parsing
  //   onboard?      — interactive config collection
  //   diagnostic?   — bin checks + runner-driven diagnostics

  readConfig?(raw: Record<string, unknown>, ctx: AgentRuntimeProviderConfigReadContext): TConfig | Promise<TConfig>;
  onboard?: ProviderOnboard<Record<string, unknown>>;
  diagnostic?: AgentRuntimeDiagnostic<TConfig>;

  // Mandatory. Neutral recent-activity reader. Returns stable Dreamux Activity
  // Records already written by the runtime, including records from the
  // currently active turn. Cursor is provider-opaque; Core never parses it.
  readRecentActivity(
    query: AgentRuntimeActivityQuery,
    context: AgentRuntimeActivityContext<TConfig>,
  ): Promise<AgentRuntimeActivityPage>;

  // Mandatory. Construct a live runtime handle. Does not start the engine.
  createRuntime(context: AgentRuntimeCreateContext<TConfig>): AgentRuntime;
}
```

```ts
// Capabilities record is for display/discovery only. It does not gate core
// admission or settlement. Recovery (closed-session context continuity) and
// structured-output conformance are mandatory, not bits.
export interface AgentRuntimeCapabilities {
  // Public-facing identity / tags. Examples: vendor name, engine version,
  // model family, authored-since package version. Free-form but stable; Core
  // may surface them in `teammate.get_capabilities` and `doctor` output.
  tags: readonly string[];
  // Whether this provider is capable of pushing live RuntimeActivity through
  // the activity sink. When false, Dreamux suppresses COT message/tool
  // presentation without changing admission or settlement. This is a reporting
  // fact, not a negotiation bit; it does not license omitting the sink.
  activityReporting: boolean;
}
```

### 3.2 Activity Records (replace `readTranscript`)

```ts
export interface AgentRuntimeActivityQuery {
  // Maximum number of stable records to return. 1..200; Core validates.
  limit: number;
  // Provider-opaque cursor from a prior page. Absent means "from the most
  // recent stable boundary". A cursor returned by a prior generation is
  // rejected with `cursor_stale`.
  cursor?: string;
  // If false, tool records are omitted (equivalent to caller filtering).
  // Default true. Core never asks the provider for tool arguments or outputs.
  includeToolRecords?: boolean;
}

export type AgentRuntimeActivityRecord =
  | {
      readonly kind: 'assistant.message';
      readonly id: string;           // provider-stable within session
      readonly occurred_at: number;  // ms since epoch
      readonly text: string;
      readonly truncated: boolean;
    }
  | {
      readonly kind: 'tool.lifecycle';
      readonly id: string;
      readonly call_id: string;
      readonly occurred_at: number;
      readonly tool_name: string;
      readonly action: RuntimeToolAction | null;
      readonly status: 'started' | 'completed' | 'failed';
      readonly error: string | null; // short provider error, redacted
    };

export interface AgentRuntimeActivityPage {
  // Oldest-first. The list is a stable prefix: a later query with the returned
  // next_cursor must extend it without reordering or gap.
  readonly records: readonly AgentRuntimeActivityRecord[];
  readonly next_cursor: string | null;
  // True when records were dropped to honor a size bound (mirrors existing
  // 262144-byte budget semantics).
  readonly truncated: boolean;
}

export interface AgentRuntimeActivityContext<TConfig = unknown> {
  // Identity (runtime_id + optional checkpoint) carries enough to locate the
  // session. The provider maps checkpoint.id and checkpoint.transcript_locator
  // to its native session history; the old per-call cwd/env fields are no
  // longer needed because the runtime or provider-owned session directory is
  // authoritative once identity is resolved.
  identity: AgentRuntimeIdentity;
  config: TConfig;
  // Soft output budget; providers truncate content and set truncated=true
  // rather than exceeding it.
  outputBudgetBytes: 262144;
  logger?: DreamuxLogger;
}

// Error shape replaces the old AgentRuntimeTranscriptError.
export interface AgentRuntimeActivityError extends Error {
  name: 'AgentRuntimeActivityError';
  reason:
    | 'checkpoint_missing'
    | 'not_found'
    | 'unreadable'
    | 'invalid'
    | 'locator_outside_root'
    | 'session_mismatch'
    | 'cursor_invalid'
    | 'cursor_query_mismatch'
    | 'cursor_stale';
}
```

**Invariants.**
- Records never contain tool arguments, tool outputs, user prompts, or
  provider-native transcript lines. Assistant messages and tool lifecycle
  markers are the only contents.
- The reader works against both the live session and (after stop) the
  durable session history that the runtime's checkpoint/locator resolves to.
  A closed TeamMate therefore returns the same Activity Records a caller would
  have seen immediately before close.
- Records from an in-progress turn are returned as soon as the provider has
  durably written them; the reader does **not** wait for turn completion.
- The sink (`activitySink` in the create context) remains the transient live
  COT projection; the reader is the stable progress-inspection surface. The
  two vocabularies intentionally align on assistant messages and tool
  lifecycle, but there is no one-to-one delivery guarantee between them
  (rejecting the review claim that they must match). The sink continues to
  carry the broader `arguments`/`result` payload used by Core's COT
  projection/redaction pipeline; the narrower reader is for `last` only.

### 3.3 Create context and leased state sink

```ts
export interface AgentRuntimeStateLease {
  // Monotonic generation assigned by Core at createRuntime time. Any push
  // whose generation does not match the current live lease is ignored by Core
  // and reported to the provider via the return value; this prevents a zombie
  // runtime from overwriting a replacement.
  readonly generation: string;
  setStatus(
    generation: string,
    status: AgentRuntimeStatus,
    extras?: { last_error?: string | null; last_started_at?: number; last_ready_at?: number },
  ): Promise<{ accepted: boolean }>;
  setCheckpoint(generation: string, checkpoint: AgentRuntimeResumeCheckpoint): Promise<{ accepted: boolean }>;
  recordLostCheckpoint?(
    generation: string,
    lost: AgentRuntimeResumeCheckpoint,
    replacement: AgentRuntimeResumeCheckpoint,
    error: string,
  ): Promise<{ accepted: boolean }>;
  // Revoke the lease. After this resolves, every subsequent push returns
  // accepted=false. Core calls this during stop/failed-start rollback; a
  // provider may call it proactively on fatal self-shutdown.
  revoke(): void;
}
```

`AgentRuntimeCreateContext` changes:

- Remove `outputSchema`. Structured-output schemas are per-submission only
  (see §3.4). The provider applies per-submission schema binding; there is no
  create-context-wide schema. This resolves the structured-output binding-time
  finding (review §"Structured-output binding time"): every submission may
  carry its own schema and providers bind it at submission time.
- Remove `state?:` optional; replace with `state: AgentRuntimeStateLease`
  (required).
- Keep: `identity`, `config`, `cwd`, `systemPrompt?`, `mcpServers`,
  `skillSources?`, `disableFeatures?`, `activitySink`, `logger?`, `paths?`,
  `injectEnv?`. These keep their existing neutral semantics.

### 3.4 Live runtime handle

```ts
export interface AgentRuntime {
  readonly providerRef: string;
  // Opaque per-instance generation, matches the state lease. Exported for tests
  // and provider logging; Core never branches on it.
  readonly generation: string;

  // Launch the engine. Resolves when the engine is ready to accept submit().
  // If identity.checkpoint is set and recovery fails, start() rejects with an
  // error (never silently falls back to fresh context); Core treats this as a
  // failed start and rolls back the runtime. The returned StartOutcome tells
  // Core whether a checkpoint was resumed so Dispatcher restart notices do not
  // depend on a post-start query.
  start(): Promise<AgentRuntimeStartOutcome>;

  // Submit one input. Replaces channelInput/completionInput/resume.
  submit(input: AgentRuntimeSubmissionInput): Promise<RuntimeAdmission>;

  // Synchronously fence new submissions, terminate the engine, and converge
  // every admission that started before the fence. Same guarantee as today:
  // stop() must not resolve while a pre-fence admission can still produce a
  // new RuntimeSubmission. Core calls stop() exactly once; the provider
  // treats duplicate calls as idempotent.
  stop(): Promise<void>;
}

export type AgentRuntimeStartOutcome =
  | { kind: 'fresh' }
  | { kind: 'resumed'; from_checkpoint: string };

export type AgentRuntimeSubmissionInput =
  | {
      readonly kind: 'channel_turn';
      readonly input: InboundTurnInput; // existing shape; channel-rendered
      readonly sourceId?: string;
      readonly outputSchema?: Record<string, unknown>;
      readonly correlation?: TurnCorrelation; // see §3.5
    }
  | {
      readonly kind: 'plain_turn';
      readonly text: string;
      readonly sourceId?: string;
      readonly outputSchema?: Record<string, unknown>;
    };
```

**Deleted members** (with reason and replacement):

| Deleted | Reason | Replacement |
|---|---|---|
| `resume()` | Recovery folded into `start()` via `identity.checkpoint`. | `start()` + `StartOutcome.kind`. |
| `channelInput()` / `completionInput()` | Two redundant input paths; discrimination is the input `kind`. | `submit({kind:'channel_turn'|'plain_turn', ...})`. |
| `waitIdle?()` | Deleted per requirement; scheduler fires immediately, dissolve stops. | None. |
| `getStatus()` / `getCheckpoint()` / `wasCheckpointResumed()` | Pull queries duplicate push sink. | `state.setStatus` / `setCheckpoint` / `StartOutcome`. |
| `getContext()` | No production Core consumer. | None. |
| `getCapabilities()` | Provider-level `getCapabilities` is the discovery surface. | `Provider.getCapabilities()`. |

**Submission/settlement invariants** (carried unchanged from current contract):

- `RuntimeAdmission` statuses remain `submitted | duplicate | stopped | skipped | failed | ambiguous` with the existing semantics; `failed` is the only
  safely-retryable-pre-admission state and `ambiguous` is never auto-retried.
- Thrown/rejected promises from `submit()` are treated as `ambiguous` unless
  the provider returns an explicit `failed`.
- `RuntimeSubmission.settled` remains the single authoritative completion
  signal; settlement is exactly-once with the existing `completion | failed | stopped` terminal kinds.
- Per-recipient FIFO admission and immutable completion identity are preserved
  (existing `RuntimeSubmission` object identity).
- `channel_turn` inputs continue to be rendered through the neutral
  `<channel source="…">` wrapper inside the provider; `plain_turn` inputs
  continue to be delivered as un-wrapped text. This distinction is preserved
  as a `kind` field rather than as two methods.

### 3.5 Turn correlation (Channel opaque handle)

```ts
// Channel-chosen opaque value. Core treats this as an uninterpreted blob;
// it is never used for routing, authorization, dedupe, or idempotency.
export type TurnCorrelation = {
  // The provider ref and channel id are attached by Core at submission time
  // (not by the Channel), so a Channel cannot spoof another Channel.
  readonly provider: string;
  readonly channel_id: string;
  readonly value: string; // Channel-owned; max 256 bytes (Core enforces)
};
```

Core carries `correlation` onto `ChannelTurnSubmittedEvent`, every
`ChannelTurnMessageEvent` / `ChannelTurnToolCallEvent` for that turn, and the
final `ChannelTurnSettledEvent`. The field is absent on turns that did not
originate from a Channel submission.

## 4. Channel provider and session

### 4.1 ChannelProvider

```ts
export interface ChannelProvider<TConfig = unknown> {
  readonly ref: string;
  readonly descriptor: ChannelProviderDescriptor;

  readConfig?(raw: unknown, ctx: ChannelConfigContext): TConfig | Promise<TConfig>;
  onboard?: ProviderOnboard<Record<string, unknown>>;
  diagnostic?: ChannelDiagnostic<TConfig>;
  // Optional identity string for `doctor`/status output; same semantics as today.
  getIdentity?(config: TConfig): string;

  // Construct a session. Core calls start() on the returned handle; construction
  // alone must not connect to external services or mutate state.
  createSession(context: ChannelSessionCreateContext<TConfig>): ChannelSession;

  // Optional composed MCP capabilities. When present, Core advertises the
  // returned catalog and dispatches tool calls to handleSessionlessTool (when
  // the call arrives outside any live session) or to the live session's
  // handleTool (when one exists). Omitting tools() means "no Channel MCP
  // surface"; Core does not insert a no-op catalog.
  tools?(config: TConfig): readonly ChannelToolDescriptor[];
  handleSessionlessTool?(
    name: string,
    args: Record<string, unknown>,
    ctx: ChannelSessionlessToolContext,
  ): Promise<unknown>;
}
```

### 4.2 ChannelSession and the two primitives

```ts
export interface ChannelSession {
  readonly provider: string;
  readonly channel_id: string;

  // Core calls start once after constructing the session, passing the two
  // narrow primitives. After start() resolves, the Channel may receive external
  // messages and invoke commands; Core will deliver events for any listener
  // that registered via eventSource.on() before the relevant fact occurred.
  // Core attaches event listeners before admitting any Team/Agent work that
  // could produce events this Channel must observe (see §7).
  start(sink: ChannelCommandSink, events: ChannelEventSource): Promise<void>;

  // Stop external I/O, release resources. After close() resolves the Channel
  // must not invoke sink and Core will not deliver further events.
  close(): Promise<void>;

  // Optional. Present exactly when provider.tools() is defined. Core dispatches
  // tool calls bound to a live Team/Agent session here.
  handleTool?(call: ChannelToolCall, context: ChannelToolContext): Promise<unknown>;
}
```

**Deleted members**: `resolveTarget`, `reply?`, `react?`,
`messageBelongsToTarget?`. `reply` / `react` behavior, when needed, is exposed
through Channel-owned MCP tools (existing Feishu outbound is already
tool-driven). `resolveTarget` and `messageBelongsToTarget` were Core-binding
helpers that become unnecessary when binding moves to Channel.

### 4.3 Command sink (Channel → Core)

```ts
export interface ChannelCommandSink {
  invoke<N extends ChannelCommandName>(
    name: N,
    payload: ChannelCommandPayloadOf<N>,
  ): Promise<ChannelCommandResultOf<N>>;
}
```

Commands are versioned by `schema_version` on the payload. Core validates
payload shape before running the command and returns a typed error envelope
(see §5).

**Initial Channel Command catalog** (exactly what the requirement names):

1. `turn.submit` — submit an external turn.

   ```ts
   // payload
   {
     schema_version: 1;
     input: InboundTurnInput;
     team_name?: string;          // absent => Dispatcher
     correlation_value?: string;  // ≤256 bytes; Core attaches provider/channel_id
   }
   // result
   | { status: 'submitted'; turn_id: string }
   | { status: 'duplicate' }
   | { status: 'stopped' }
   | { status: 'failed'; error: ChannelCommandError }
   | { status: 'ambiguous'; error: ChannelCommandError }
   | { status: 'team_not_found' | 'team_closed'; error: ChannelCommandError }
   ```

   Notes:
   - `team_not_found` / `team_closed` are **pre-admission rejections** (no
     turn was accepted). Channel may clean up stale bindings and optionally
     re-submit once to the Dispatcher; after any `ambiguous` it must not
     retry.
   - The `turn_id` returned is the same identity later used in events; this
     lets a Channel bind the submitted event to its invoke() call even when
     the event is delivered asynchronously.
   - Core does not read or interpret `correlation_value`.

2. `team.create` — restart-durable idempotent Team creation for Channel
   auto-provisioning.

   ```ts
   // payload
   {
     schema_version: 1;
     request_id: string;      // Channel-chosen; idempotency key, ≤128 bytes
     name_prefix: string;
     leader_agent_runtime: string;
     repo?: DreamuxManagedRepoRequest;
     worktree?: TeamCreateWorktreeInput;  // existing shape
     intent?: string;
     identity?: Record<string, unknown>;
     prompt?: string;
     skill_sources?: readonly AgentRuntimeSkillSource[];
   }
   // result
   { status: 'created' | 'existing'; team_name: string; leader_name: string }
   ```

   `request_id` is scoped to the `(dispatcher_id, channel_id)` pair and lives
   in a restart-durable Core ledger (see §6.2). A repeated `request_id` with
   the same canonical payload returns the prior `team_name`; a repeated
   `request_id` with a different canonical payload is rejected with
   `CHANNEL_COMMAND_DUPLICATE_REQUEST_MISMATCH`. Core garbage-collects ledger
   entries only when the Team is durably closed and the entry is older than
   30 days; otherwise a restart always returns the same `team_name`.

This catalog is intentionally the complete initial set. Adding a Channel
Command is a Core-owned catalog change; the base `ChannelSession` interface
does not grow. No `team.dissolve`, `workflow.*`, `scheduler.*`, host
maintenance, or agent-admin commands are exposed to Channel in this change.

### 4.4 Event source (Core → Channel)

```ts
export interface ChannelEventSource {
  // Subscribes to all events of the given kind. Listener is invoked in FIFO
  // order per Channel event-source lease (§7). Returns an unsubscribe handle.
  // If Core has already revoked the lease (during shutdown), on() returns a
  // no-op subscription whose unsubscribe() is a no-op.
  on<K extends ChannelCoreEventKind>(
    kind: K,
    listener: (event: ChannelCoreEventOfKind<K>) => void | Promise<void>,
  ): ChannelEventSubscription;
}

export interface ChannelEventSubscription {
  unsubscribe(): void;
}
```

The `ChannelRoutes.coreEvents` capability-negotiation field disappears; every
Channel receives a source. The old `targetLifecycle` and `deliverExact` are
not re-added as events — their effects are observable through the existing
`team.state`, `agent.state`, and turn events.

### 4.5 Event catalog changes

The existing event union is trimmed. Initial catalog:

- `team.state` — fields unchanged (`team_name`, `leader_name`, `status`).
- `agent.state` — fields unchanged (`team_name`, `agent_name`, `role`,
  `status`). Role remains `team_leader | team_member`; dispatcher agents are
  represented as `team_name: null, role: 'dispatcher'` (existing
  `ChannelConversationScope`).
- `turn.submitted` — adds optional `correlation?: TurnCorrelation`; the
  `channel_origin.binding` endpoint snapshot is removed (Core no longer stores
  binding routes). `channel_origin.target` is reduced to an opaque
  provider/channel/message triple — Core no longer carries a `ChannelTarget`
  struct because `target_key`/`binding_fallbacks` are gone.
- `turn.settled` — adds optional `correlation`. Existing display fields
  (`assistant`, `assistant_truncated`, `redacted`) are unchanged.
- `turn.message` — adds optional `correlation`; other fields unchanged.
- `turn.tool_call` — adds optional `correlation`; other fields unchanged.

Deleted event kinds: `binding.route`, `binding.collaboration_space`. They
lived on Core-owned binding state which is removed; Channel-internal binding
transitions are not Core facts.

**Event ordering and delivery guarantees (frozen COT-compatible):**

- FIFO per `(channel_id, kind, team_name)` key. Cross-kind and cross-team
  ordering is best-effort but stable per Core publication order.
- Listeners execute off the Core turn path with an in-memory bounded queue
  (1024 entries per Channel source). A slow consumer drops the oldest
  pending event and increments a per-channel `dropped_events` counter logged
  at warn level; turn admission and settlement are never blocked or rolled
  back. Listener exceptions are caught and logged; they also fail-open.
- Events reference frozen payloads; listeners cannot mutate them.
- No replay, no retention, no acknowledgement, no snapshot on subscribe.
- During shutdown, Core fences new turn/agent/team mutations, then drains the
  in-flight event queue, then revokes each Channel source, then calls
  `ChannelSession.close()`. This guarantees the Channel sees every event for
  work it was attached for (per lifecycle-coupling requirement) without
  requiring a snapshot protocol.

### 4.6 Channel-owned state paths

Add to `platform/paths.ts`:

```ts
// <state>/<dispatcher>/channel/<channel_id>/
export function dispatcherChannelDir(input: { dispatcherId: string; channelId: string }): string;
// <state>/<dispatcher>/channel/<channel_id>/bindings.json     (Channel-owned)
// <state>/<dispatcher>/channel/<channel_id>/provisioning.json (Channel-owned, if any)
// Logs: <logs>/channel/<channel_id>/*.log (reuse existing channelLogPath extended)
// Cache: <cache>/<dispatcher>/channel/<channel_id>/
```

Core creates these directories at session-start time (before `start()`) and
deletes them only if the channel is permanently removed from config. The
Channel reads/writes whatever JSON/document shape it needs inside this
directory; Core does not interpret or migrate its contents. A channel that
needs subdirectories is free to create them.

The existing `ChannelSessionCreateContext.state_root` / `cache_root` are
replaced by a stable `paths: ChannelPathContext` mirroring the runtime pattern,
so a Channel does not concatenate strings to find its own roots:

```ts
export interface ChannelPathContext {
  stateDir(): string;   // durable, backed up with Dreamux state
  cacheDir(): string;   // rebuildable
  logsDir(): string;
}
```

## 5. Command / error envelope

All Command failures return a uniform error object. The shape is stable across
all Commands so a Channel does not need Command-specific error parsing:

```ts
export interface ChannelCommandError {
  code: string;    // e.g. 'VALIDATION_ERROR' | 'CHANNEL_COMMAND_DUPLICATE_REQUEST_MISMATCH' | ...
  message: string; // operator-safe English, no secrets
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

Core validates:

- Payload parses to the declared schema for the Command (Draft-07 JSON
  Schema, compiled at Command registration). Invalid payloads yield
  `VALIDATION_ERROR` (not retryable).
- `correlation_value` length ≤ 256 bytes; `request_id` length ≤ 128 bytes.
- Idempotency ledger canonicalization for `team.create.request_id` (canonical
  form is the sorted JSON of all payload fields except `request_id` and
  `schema_version`).

No Channel-specific allowlist is applied after catalog admission. Commands
own their internal authorization/idempotency just as the existing MCP / admin
handlers do.

## 6. Core-internal architecture

### 6.1 Agent Runtime host changes

- **Loader** (`packages/dreamux/src/agent-runtime/loader.ts` or existing
  equivalent) validates that a loaded provider supplies `ref`, `descriptor`,
  `getCapabilities`, `readRecentActivity`, `createRuntime`; optional
  `readConfig`, `onboard`, `diagnostic` are feature-detected. It no longer
  requires `readTranscript` and rejects providers that still declare it (fail
  loud; the contract is intentionally incompatible).
- **Runtime owner** (existing `runtime-owner.ts`) is rewritten against the new
  handle. It owns generation allocation, lease construction, the
  activity→COT projection bridge, and the settled/failed/stopped→state-sink
  transitions. It also provides the `readRecentActivity` adapter used by
  TeamMate `last`.
- **Submission router** (existing `completion-router` extended) maps the
  existing internal submission types (scheduled, control, prompt, agent-to-agent,
  inbound turn) onto `submit()`'s discriminated union, preserving the
  current `channel_turn` vs `plain_turn` rendering distinction.
- **Launcher** (existing runtime launch path):
  - Fresh launch: `identity.checkpoint = null` → `start()` → expect
    `StartOutcome.kind === 'fresh'`.
  - Recovery launch: load checkpoint from identity state → pass as
    `identity.checkpoint` → `start()` → require
    `StartOutcome.kind === 'resumed'` with the matching checkpoint id;
    any failure is fatal to the runtime (no silent fresh-fallback).
- **Dissolve controller** is rewritten per §8. It no longer queries
  `waitIdle`; its first runtime action is `stop()` on every child runtime.
- **Scheduler** removes the `waitIdle` held-fire deferral. A due fire submits
  immediately through the ordinary submit path; provider-native folding into
  an active turn is accepted behavior (unchanged per runtime's own contract),
  and `ambiguous` remains non-retryable with no missed-fire retry queue. The
  existing `MAX_DEFER_MS` / `armMissed` code path is deleted.

### 6.2 Team create idempotency ledger

A new small store, `TeamCreateIdempotencyLedger`, lives at
`<state>/<dispatcher>/team-create-requests.jsonl` (append-only with
compaction). Entries:

```
{ request_id: string; channel_id: string; provider: string; canonical_payload_hash: string; team_name: string; created_at: number }
```

- Canonical payload hash is BLAKE3 over the sorted-JSON canonical payload.
- Replays of the same `(dispatcher, channel_id, request_id)` with matching
  hash return `{status:'existing', team_name}`.
- Replays with mismatched hash return `CHANNEL_COMMAND_DUPLICATE_REQUEST_MISMATCH` (not retryable).
- Compaction drops entries for closed Teams older than 30 days; entries for
  non-closed Teams are retained forever to keep the restart-durable guarantee.
- The ledger is the only Core-persisted record that mentions a Channel's
  `request_id`. It does not store any external target identifier.

### 6.3 Channel service rewrite

The existing `packages/dreamux/src/service/channel-service/` is reduced to:

- **Provider/session lifecycle**: construct, start, close each configured
  Channel in dispatcher start/stop order; attach the CommandSink and
  EventSource before calling `session.start()`.
- **Command dispatch**: validate schema, route to the appropriate Core
  capability (currently only `turn.submit` → existing turn admission path;
  `team.create` → existing Team collection create plus ledger).
- **Event fan-out**: own the leased event source per Channel, bounded queue,
  drop counter, slow-consumer isolation, and shutdown drain/revoke.
- **MCP tool proxy**: register Channel tools on the TeamLeader and Dispatcher
  MCP servers, route live calls to `session.handleTool` and sessionless calls
  to `provider.handleSessionlessTool`, remove the binding-scoped authorization
  path (`authorizeTeamLeaderEgress`, `messageBelongsToTarget`, binding owner
  checks). The only caller context that remains is `caller` for logging/COT
  (already carried in `ChannelToolContext`).
- **Deleted surfaces** (all go away without adapters): `resolveTarget`,
  `resolveInboundBinding`, `bindResolvedTarget`, `bindResolvedTargetIfAvailableToOwner`,
  `claimResolvedTarget`, `transferBack`, `transferResolvedTargetBack`,
  `releaseResolvedTargetIfOwned`, `releaseResolvedTargetIfClaimed`,
  `authorizeTeamLeaderEgress`, `messageBelongsToTarget`, and the route
  callback entry points (`deliver`, `targetLifecycle`,
  `ensureCollaborationTarget`, `deliverExact`).

The existing binding store (`channel-binding/store.ts`) is removed.
Core stores no `(channel_id, target_key) → team_name` map.

### 6.4 Core event bus

The existing `DispatcherCoreEventBus` (EventEmitter-based) stays but with two
changes:

1. Per-Channel scoped sources gain the leased async queue described in §4.5.
2. Publishing `binding.*` and `collaboration_space.*` events is removed from
   all producers.

The bus keeps its existing in-process, non-durable semantics. Adding a new
event kind is a catalog + type change; the base `ChannelSession` interface
does not move.

## 7. Lifecycle and concurrency

### 7.1 Startup ordering (in-process, lifecycle-coupled)

For one dispatcher:

1. Load Agent Runtime providers and Channel providers (already done at
   config-load time today).
2. Construct Core domain services (Team/Teammate/Workflow/scheduler stores).
3. Rehydrate Team/TeamMate identity state; do not start any runtimes yet.
4. Construct each configured Channel's `ChannelSession` (synchronous; no
   external I/O).
5. Build the per-Channel `ChannelEventSource` and `ChannelCommandSink`,
   attaching a source lease. Subscribe Channel listeners will immediately
   queue events (the queue is live before session.start).
6. Start runtime replay for already-existing Teams/TeamMates (call `start()`
   on each runtime). Their state transitions emit `agent.state` / `team.state`
   events through the bus, which the Channel sources will deliver if the
   Channel subscribed to those kinds in its own `start()`.
7. After every runtime's `start()` has resolved (fresh or resumed), call
   `session.start()` on each Channel. Only after `start()` resolves may the
   Channel begin accepting external messages and invoking Commands.
8. Start scheduler and Workflow service. Open for external work.

Because event listeners can be registered inside the Channel's `start()`, the
Channel receives all events for work that begins after step 7. Runtimes
started in step 6 may emit state events before the Channel subscribes; that is
consistent with the no-snapshot rule and with Channel lifecycle coupling
(Channel has no obligation to render pre-attach state — COT for existing
sessions is reconstructed via `last`/Activity Records when a user asks, not by
replaying).

### 7.2 Shutdown ordering

1. Stop accepting new external input (each Channel stops listening on its
   external transport as the first step of `close()` — see Channel
   responsibility).
2. Fence scheduler, prevent new Workflow/Team/Agent creation.
3. Stop all runtimes (`runtime.stop()`) and wait for convergence; this
   produces final state events.
4. Drain Channel event queues (bounded wait — ≤ 2s per channel); events still
   in queue after that are dropped with a log line.
5. Revoke every Channel event-source lease.
6. Call `session.close()` on every Channel; await.
7. Flush Core durable stores. Exit.

### 7.3 Runtime state lease concurrency

- `generation` is a random 128-bit token assigned at `createRuntime` and
  shared between the `AgentRuntime` handle and the `AgentRuntimeStateLease`.
- On `stop()` or failed-start rollback, Core revokes the lease. Any push
  arriving after revocation returns `{accepted:false}`; the provider should
  stop pushing.
- A late push from a zombie runtime cannot overwrite replacement runtime
  state because its `generation` no longer matches.
- `activitySink` is also scoped to the generation; Core ignores activity
  events from a revoked generation and logs them at debug level.
- Status/checkpoint callbacks are awaited by Core (async) so persistence
  order is preserved; the provider may rely on the callback resolving before
  the next push, but must not assume the push durably committed Core state
  unless it awaited the returned `{accepted:true}`.

### 7.4 Submission FIFO and folding

- Submission admission continues to be serialized per recipient (the existing
  route-lifecycle/serial queue pattern) to preserve FIFO settlement.
- Scheduler no longer waits for idle; a scheduled submission enters the same
  queue and may either be admitted as a new turn or folded natively by the
  provider. Core does not try to detect or prevent folding; `RuntimeSubmission`
  identity and the settled event carry the distinction.
- `ambiguous` admissions remain non-retryable for all submitters, including
  scheduler and Channel. Scheduler does not implement a missed-fire queue; a
  fire that lands `ambiguous` is logged and dropped (consistent with current
  missed-fire semantics after the existing `armMissed` path is removed, but
  without the idle-wait cause).

## 8. Team dissolve (rewritten)

The dissolve controller implements the new immediate-dissolve behavior. States
and transitions:

**Dispatcher-triggered dissolve (non-force, force):**

1. Mark Team `closing` in Core state; reject new turns at admission.
2. If `force: false`, perform the existing managed-worktree cleanliness
   preflight **before** stopping any runtime. A dirty/unmerged worktree
   returns `TEAM_DISSOLVE_WORKTREE_DIRTY` (retryable by operator); Team is
   returned to `running` with no runtimes stopped.
3. Stop Workflow runtime, then every TeamMate runtime, then TeamLeader
   runtime. Each `stop()` fences and converges; no `waitIdle` is observed.
4. Recheck worktree cleanliness (post-stop). If dirty and `force: false`,
   return the same dirty error; the Team is partially closed (children are
   stopped but the Team record and worktree remain, and another `force:true`
   dissolve is required to finish). Logical close is not accepted yet; this
   is the "recoverable partial state" called out in review findings §7.
5. If `force: true` at either preflight or post-stop check, discard
   uncommitted, untracked, and unmerged changes **only** in the Team's owned
   managed worktree (containment checks via existing worktree ownership
   guards; never delete source repo, reused cwd, or repository root).
6. Durably accept logical close (Team state `closed`). Publish
   `team.state`/`agent.state` closed events. Channel consumers of these
   events invalidate all bindings that reference the closed `team_name`.
7. Return to caller. Physical worktree deletion is queued to an existing
   cleanup queue (`cleanup-pending`); progress and final state are observable
   via Team state. The caller does not wait for it.

**TeamLeader self-dissolve:**

1. The TeamLeader MCP `dissolve` tool calls into the same controller.
2. The controller first stops Workflow and every TeamMate runtime (children),
   then runs worktree cleanliness check while the TeamLeader runtime is still
   alive.
3. On clean (or forced), controller durably accepts logical close.
4. Controller asynchronously calls `stop()` on the TeamLeader runtime. The
   MCP caller typically observes its own runtime exit before a response
   arrives; that interrupted response is fail-open and does not roll back
   dissolve.
5. Physical worktree cleanup remains background.

**Force invariants:**
- `force: true` only authorizes discarding local (uncommitted/untracked/unmerged)
  changes inside the Team's owned managed worktree. It never deletes the
  managed Git branch, committed history, a reused `cwd`, the source repo, or
  the repository root.
- Containment/target-resolution checks (existing guards in
  `platform/paths` and `worktree/`) remain fail-loud before any destructive
  action.

## 9. Channel-owned binding and auto-provisioning

### 9.1 Channel binding MCP tools

A binding-capable Channel (like Feishu) declares and implements:

- `bind_channel({target, team_name})` — persist a binding from the
  Channel-external target to `team_name`. The Channel validates the target
  (canonicalization, hierarchy, existence on external platform per provider
  policy) and that `team_name` names a running Team (via the dispatcher's
  Team read surface, called from within the tool handler which runs as a
  dispatcher-privileged agent). Returns `{bound: true, target, team_name}` or
  a provider-shaped error.
- `unbind_channel({target})` — remove one binding. Idempotent: unbinding a
  target with no binding returns `{bound: false}`.
- `list_bindings()` — return all current bindings as `[{target, team_name, created_at, ...}]`. This is the single authoritative read.

These are Channel-owned MCP tools, not Core Commands or Team MCP tools. They
run through the existing Channel MCP proxy (`packages/dreamux/src/mcp/channel-mcp.ts`)
with trivial changes: the `authorizeTeamLeaderEgress` gate is removed for all
Channel tool calls (TeamLeader or Dispatcher), but per-tool
validation/auth/ownership checks remain with the Channel provider.

### 9.2 Persistence and concurrency

Each Channel persists its binding store in Channel-owned state
(§4.6): `<state>/<dispatcher>/channel/<channel_id>/bindings.json`. The format
is Channel-defined; for Feishu it is a sorted list of `{chat_id, thread_id?, team_name, created_at, provisioning_request_id?}`. Concurrency is
single-writer within the Channel process (Channel MCP tool calls are
serialized by the existing admin/NDJSON socket and the Node event loop); no
cross-process locking is needed because Channel and Core are lifecycle-coupled
in one process.

Migration: on startup after upgrade, if Core's old
`<state>/<dispatcher>/channel-bindings.json` exists, Core renames it to
`channel-bindings.json.legacy` (fail-loud if rename fails) and logs a breaking
change note directing the operator to the Channel's migration guide. The
Feishu channel reads the legacy file once (if present) to import bindings
into its own store, then deletes the renamed file. Core never re-imports on
subsequent starts. The detail of Feishu migration lives in the Feishu
channel package, not in Core.

### 9.3 Inbound routing

On inbound external message:

1. Channel parses and normalizes the message.
2. Channel looks up its binding store for the originating target (chat,
   thread, topic, parent-group per Channel policy).
3. If a binding resolves to a `team_name`, Channel invokes
   `turn.submit({team_name, input, correlation_value})`.
4. If the result is `team_not_found` or `team_closed`, Channel deletes the
   stale binding and may invoke `turn.submit` **once** without `team_name`
   (Dispatcher delivery). It must not fall back on `ambiguous`, `failed`, or
   `stopped` results.
5. If no binding exists, invoke `turn.submit` without `team_name` (Dispatcher
   delivery). The Dispatcher Agent decides whether to auto-provision; if it
   calls `bind_channel` MCP it does so through the Channel MCP proxy.

### 9.4 Auto-provisioning saga (Channel-owned)

A Channel that supports automatic provisioning (like Feishu collaboration
spaces today) owns the full saga:

1. Receive inbound on unbound target; deliver to Dispatcher.
2. Dispatcher/TeamLeader decides to provision (policy lives in Channel
   config, e.g. "provision on first @mention" vs explicit command). This
   proposal does not change that policy — it just moves where the durable
   claim lives.
3. Channel generates a `request_id` (e.g. `prov-<chat_id>-<timestamp>-<rand>`)
   and persists a provisional saga record in `provisioning.json`.
4. Channel invokes `team.create({request_id, name_prefix, leader_agent_runtime, ...})`.
   Core returns existing `team_name` if the request already completed (crash
   recovery).
5. Channel calls its own `bind_channel` MCP implementation (in-process, since
   the Channel owns both sides) to persist the binding. Only after the
   binding is durable does the Channel submit the original message via
   `turn.submit({team_name, ...})`.
6. On crash/restart, Channel rehydrates `provisioning.json`: in-progress
   sagas are retried by re-invoking `team.create({request_id})` (idempotent)
   and re-binding.

Core has no Collaboration Space object, no target claim, and no
"provisioned-target" record. The Team created is a normal Team; removing the
binding leaves the Team alive, and dissolving the Team invalidates the
binding when the Channel observes the `team.state {status:'closed'}` event.

## 10. Deletions (Core surface)

The following are removed from Core without replacements, adapters, or
compatibility aliases. Each removal is a breaking change called out in Rush
change files.

- `packages/dreamux/src/service/collaboration-space/` — entire module
  (service, types, persistence, events, provisioning saga, `acceptTarget*`
  methods, `deliverExact`, `mutateTargetRoute`, `bindTargetRoute`,
  `dissolveTeam`, `reconcileInboundTargetRoute`).
- `packages/dreamux/src/service/channel-binding/` — entire module
  (store, route-claim CAS, `target_key`, `binding_fallbacks`,
  transfer/claim/release helpers).
- Collaboration-space config block in dispatcher config schema; this is an
  incompatible config change (breaking note with `BREAKING:` + `Rebuild:` for
  operator).
- Core `channel-bindings.json` and `collaboration-spaces.json` files
  (replaced by Channel-owned state per §9.2).
- Team MCP `bind_channel` and `transfer_back` tools. `transfer_back` has no
  alias.
- Core admin methods that operated on binding/Collaboration Space
  (reviewed item-by-item during implementation; the channel-binding admin
  surface is deleted alongside the store).
- `ChannelRoutes.deliver`, `targetLifecycle`, `ensureCollaborationTarget`,
  `deliverExact`, `coreEvents` capability-negotiation field.
- `ChannelSession.resolveTarget`, `reply`, `react`, `messageBelongsToTarget`,
  `handleTool` moves to optional (already so today).
- `AgentRuntime.waitIdle`, `getStatus`, `getCheckpoint`,
  `wasCheckpointResumed`, `getContext`, `getCapabilities`, `resume`,
  `channelInput`, `completionInput`.
- `AgentRuntimeProvider.readTranscript`, `AgentRuntimeTranscript*` types.
- The `AgentRuntimeCapabilities.resume` and `structuredOutput` bits; the
  `structuredOutput.scope` field.
- `ChannelTarget.target_key`, `binding_fallbacks`, and the old
  `ChannelBindingEndpointSnapshot` carried on events.

## 11. Contract test plan

New fixtures and tests in `packages/dreamux/src/...` (fixtures under
`packages/dreamux/src/agent-runtime/test-fixtures/` and
`packages/dreamux/src/channel/test-fixtures/`):

1. **Minimal runtime fixture**: implements only `start`, `submit`, `stop` and
   the push sink. Loads, runs a `plain_turn`, and settles correctly.
2. **Minimal no-activity runtime fixture**: never calls `activitySink`;
   verifies COT is suppressed but admission/settlement work.
3. **Minimal channel fixture**: implements `start(sink, events)` + `close`,
   invokes `turn.submit` and `team.create`, subscribes to event kinds,
   verifies events are delivered with correlation and that slow-listener
   drops are logged but not fatal.
4. **Lease revocation test**: a stale runtime whose lease was revoked cannot
   overwrite replacement state via `setStatus`/`setCheckpoint`.
5. **Generation test**: `start()` outcome (`fresh` vs `resumed`) is reported
   correctly; failed-resume start rejects and does not fall back.
6. **Submit fencing test**: after `stop()` resolves, no pre-fence admission
   produces a new submission (existing fence contract preserved).
7. **Activity reader test**: `readRecentActivity` returns assistant messages
   and tool lifecycle records for an in-progress turn and after close;
   never returns tool arguments/outputs; cursor pagination;
   `cursor_stale` after restart regeneration.
8. **Team create idempotency test**: same `request_id` returns same
   `team_name` across restart; mismatched payload fails with
   `DUPLICATE_REQUEST_MISMATCH`; 30-day compaction.
9. **Channel command validation**: schema-validated payloads accepted;
   invalid payloads fail with `VALIDATION_ERROR`; correlation length
   enforced.
10. **No waitIdle**: dissolve controller never observes an idle capability;
    immediate-stop behavior for long-running active turn; force=true cleans
    up dirty managed worktree; containment check rejects non-owned paths.
11. **Scheduler no-deferral**: fires are submitted immediately; no idle wait;
    `ambiguous` is not retried.
12. **Self-dissolve**: TeamLeader calling dissolve results in accepted close
    even when the MCP response is lost; cleanup-pending worktree removal
    proceeds in the background.
13. **Channel binding tools**: `bind_channel`, `unbind_channel`,
    `list_bindings` register through Channel MCP and work for both Dispatcher
    and TeamLeader callers; no authorization gate.
14. **Stale binding**: channel invokes `turn.submit` with closed `team_name`,
    receives `team_closed`, deletes binding, resubmits to Dispatcher; no
    retry on `ambiguous`.
15. **Team close invalidates bindings**: Channel listener observes
    `team.state{status:'closed'}` and removes binding; no Core query.
16. **Event delivery**: FIFO per scope; bounded queue drops oldest on
    overflow; listener exception does not fail turn; events delivered after
    listener registration; shutdown drain/revoke sequence; no replay
    available.
17. **Correlation carried through**: submitted, message, tool_call, settled
    events carry the same `correlation`; non-Channel turns have no
    correlation; Core does not route on it.
18. **Structured output**: per-submission `outputSchema` binds at submit
    time; Workflow turns flow through `plain_turn` with schema and every
    supported runtime conformed; no provider-capability preflight.
19. **Live COT unchanged**: existing Feishu COT golden-output fixtures
    (reference the tests added with the COT cards PR) continue to pass
    unchanged; `arguments_json`/`result_json` on `turn.tool_call` still carry
    redacted/truncated payloads for display.
20. **Loader fail-loud**: a provider declaring `readTranscript` or a handle
    with old methods fails at load with a clear migration error naming the
    missing/extra members.

The existing live Codex tests are updated to the new provider interface; the
`DREAMUX_SKIP_LIVE_CODEX=1` path is preserved.

## 12. Verification mapping (requirement acceptance → design)

| Requirement acceptance | Design section |
|---|---|
| Minimal external runtime fixture loads/runs a turn | §11 tests 1, 2 |
| Every mandatory member has unconditional Core consumer | §3.1, §3.4 — every base member is consumed by host/owner/launcher/dissolve/scheduler |
| Optional capabilities absent without no-op stubs; clear failure on request | §3.1 (diagnostic/onboard/readConfig optional), §3.2 (activity reporting capability tag) |
| Admission, settlement, stop fence, completion routing, activity delivery correct | §3.4 invariants, §11 tests 6, 10, 11, 19 |
| Structured output mandatory for every Provider; Workflow doesn't depend on preflight | §3.3 (remove create-context schema), §3.4 (per-submission schema binding), §11 test 18 |
| Live runtime is `start` + union `submit` + `stop`; status/checkpoint via push | §3.4, §6.1 |
| No waitIdle; immediate dissolve with force; async cleanup; self-dissolve fail-open | §3.4 (waitIdle deleted), §8, §11 tests 10, 12 |
| Scheduler fires immediately, may fold, no busy deferral, no retry after ambiguous | §6.1, §7.4, §11 test 11 |
| TeamMate close/send restores context; silent-fresh forbidden | §3.4 (`start` outcome + fatal on resume fail), §11 test 5 |
| No Core branch on provider id | §2 ownership; enforced by code review & lint (no `providerRef === '...'`) |
| Tests distinguish base vs optional; reject silent downgrades | §11 tests 1, 2, 20 |
| `last` works during active turn + after close; no tool inputs/outputs; no native transcript parsing | §3.2, §11 test 7 |
| `getContext` / handle-level `getCapabilities` absent | §3.4 deleted-member table |
| Provider `getCapabilities()` retained for discovery/tags; no structuredOutput scope | §3.1 |
| Minimal channel fixture (direct start/stop/invoke/events) | §4, §11 test 3 |
| Command catalog traced to Core use cases; initial catalog is `turn.submit` + idempotent `team.create` | §4.3 |
| Event catalog traced to stable facts; initial catalog only team/agent/turn lifecycle + frozen COT | §4.5 |
| Adding command/event changes catalog only, not base interface | §4.3, §4.5 |
| Live-only events; no replay/snapshot; no event-content persistence | §4.5, §6.4 |
| COT unchanged; observer failures fail-open | §4.5, §11 test 19 |
| Channel opaque correlation carried unchanged | §3.5, §11 test 17 |
| Channel with no MCP needs no fake members; live + sessionless MCP work | §4.1, §4.2 (handleTool optional), §6.3 |
| Binding-capable Channel persists/resolves own state; Core stores no binding | §9, §11 tests 13, 15 |
| Auto-provisioning saga Channel-owned; idempotent `team.create`; bind then send; no Core Collaboration Space | §6.2, §9.4, §11 tests 8, 14 |
| Dispatcher calls Channel-owned bind/unbind/list via MCP; Team MCP bind/transfer_back removed | §9.1, §10 deletions |
| Channel submits resolved team_name; Dispatcher fallback on team_not_found/team_closed only | §9.3, §11 test 14 |
| Binding reads are per-Channel; cross-domain joins are caller-joins | §9.1, §9.3 |
| TeamLeader Channel MCP forwarded without binding-owner proof | §6.3 (authorization gate removed) |
| resolveTarget / messageBelongsToTarget / reply? / react? / ChannelRoutes callbacks absent | §4.2 (deleted-member note), §10 deletions |

## 13. Breaking changes and upgrade

Three Rush change files (all `type: minor` per 0.x rule, with `BREAKING:` notes):

1. **`@excitedjs/dreamux-types`** — Contract rewrite. Lead: `BREAKING: Agent Runtime and Channel provider contracts rewritten to minimal start/submit/stop + invoke/onMessage surfaces.` Includes removed-member list. `Rebuild:` third-party providers must be re-authored against the new interfaces; no adapter is provided.
2. **`@excitedjs/dreamux` (core)** — Contract consumers. `BREAKING: Core binding store and Collaboration Space removed; channel-bindings.json and collaboration-spaces.json are replaced by Channel-owned state.` `Rebuild:` Operator must rebuild dispatcher state after upgrading; the built-in Feishu channel provides a one-time import of legacy `channel-bindings.json.legacy`.
3. **`@excitedjs/agent-runtime-codex`** — Codex provider re-architected to the new contract. `BREAKING: Codex runtime provider rewritten to start/submit/stop; readTranscript replaced by readRecentActivity.` `Rebuild:` rebuild the dispatcher state; existing Codex checkpoints from the previous contract are not loadable (operator should dissolve and re-create Teams if they hit `checkpoint_mismatch` — documented in release note).

No major bumps (0.x rule). No forward-compatibility adapter, no `transfer_back` alias.

## 14. Risks and mitigations

- **Risk: Provider binary distribution lags contract.**
  Mitigation: loader fails loud with a precise missing-member error (§11 test
  20); Rush change notes enumerate required changes; the Codex provider ships
  in the same PR so the built-in path is day-one compatible.
- **Risk: Event drops under burst COT hide user-visible messages.**
  Mitigation: bounded queue sized 1024 covers normal COT rates (today's COT
  events are in the low double-digits per turn); drop counter is logged at
  warn with channel/team identifiers for operator visibility; fail-open
  semantics guarantee the turn itself is not affected. A later iteration may
  add a metric, but not in this change.
- **Risk: Idempotency ledger grows unboundedly.**
  Mitigation: compaction drops closed-Team entries older than 30 days (§6.2);
  open-Team entries are kept (needed for guarantee) but at one entry per
  provisioned Team — bounded by number of Teams, which is already bounded by
  operational scale.
- **Risk: Channel crash mid-provisioning creates orphaned Teams.**
  Mitigation: `team.create` is idempotent across restart; Channel re-runs the
  saga from the provisional record on startup and either binds the existing
  Team or abandons it (leaving it as a normal unbound Team, which is
  explicitly supported state).
- **Risk: Removing waitIdle makes scheduler overlap turns in ways the Codex
  runtime does not handle.**
  Mitigation: Codex already supports completion folding/queueing natively
  (evidenced by the existing thread/start completion-input path); the
  per-recipient FIFO admission queue preserves Core-side ordering; if a
  runtime truly cannot tolerate overlapping submissions it serializes
  internally.
- **Risk: Self-dissolve MCP response loss leaves user without feedback.**
  Mitigation: explicitly documented fail-open behavior (§8, requirement
  "Immediate Team dissolve"); Channel observes the `team.state: closed` event
  and renders its own close confirmation asynchronously, so the user still
  sees the Team close.

## 15. Rejected alternatives

- **Keeping `waitIdle` as a derived Core state (e.g. "no in-flight
  submissions").**
  Rejected. Operator explicitly decided no idle model is retained; the
  derived state is both racy (a completion can arrive between check and
  action) and a feature anchor for the exact busy-defer behavior being
  removed.
- **Per-Command Channel capability negotiation on the session.**
  Rejected. Channels are trusted for the entire deliberately small catalog; a
  per-Command allowlist adds machinery with no demonstrated need. New
  Commands are added by explicit Core catalog change with review, not by
  Channel opt-in.
- **Snapshot/replay for events to cover Channel restarts.**
  Rejected. Channel and Core are lifecycle-coupled; "independently offline
  Channel" is not a product concept. Adding replay would require an event
  store and retention policy the operator explicitly declined.
- **Keeping `channel_origin.binding` / `target_key` as a Core-persisted fact
  for COT presentation.**
  Rejected. Opaque `TurnCorrelation` is sufficient to map COT events to the
  originating external interaction; Core does not need to know which external
  target resolved to the Team. The Feishu COT card renderer reads
  `correlation.value` to recover the originating chat/thread from its own
  binding state.
- **A generic Core→Channel query port (so Core can ask "who is bound?").**
  Rejected (requirement "No general Core-to-Channel query port"). The
  composite `team.list` + per-channel `list_bindings` join is the intentional
  shape; Core does not mirror Channel binding state.
- **Making `readRecentActivity` return the same wider payload as the activity
  sink (with tool arguments/results).**
  Rejected. The requirement narrows `last` to assistant messages plus tool
  name/status; the wider sink payload is for COT display only. Equating them
  would either regress COT (narrowing the sink) or leak tool content through
  `last` (which is an MCP tool).
- **Adding a `team.dissolve` Channel Command for Channel-initiated close.**
  Rejected. Team dissolve is an Agent/MCP capability in the initial catalog;
  a Channel that needs to dissolve a Team can do so through Agent action
  (e.g. Dispatcher policy) rather than exposing a new Command. This keeps the
  Command catalog at exactly the two specified Commands.
- **A base `ChannelSession.reply`/`react` retained alongside MCP tools.**
  Rejected. Outbound surface is already fully provider-owned MCP; dual base
  members create two code paths for the same behavior and complicate the
  contract without adding a non-MCP consumer.

---

## 16. Cross-review (single round)

This section records my review of the other two independent first-round
proposals (`codex.md`, `claude.md`) against the frozen requirement revision
`89e95d7…`, the review-findings synthesis, and the current source on
`refactor/minimal-agent-runtime-provider`. I read all three proposals in full
before writing this. Per the brief, no vote-count drives decisions; each
disputed point is resolved against the requirement, review findings, and
current code evidence. My independent proposal above is revised where I was
wrong and retained where I was right.

### 16.1 Points of agreement (all three proposals align, retained)

All three proposals independently arrive at the same core shape, which is
strong evidence the direction is correct:

- **Runtime handle is `start` / discriminated-union `submit` / `stop`.** All
  three delete `resume`, separate `channelInput`/`completionInput`, `waitIdle`,
  `getStatus`/`getCheckpoint`/`wasCheckpointResumed`, `getContext`, and the
  handle-level `getCapabilities`. All three retain the existing
  `RuntimeAdmission` / `RuntimeSubmission` / `RuntimeSubmissionSettlement`
  invariants verbatim.
- **Push-only runtime state through a leased sink, no pull queries.** All
  three introduce a generation/epoch token per runtime to stop zombie writes,
  with explicit revocation on stop/replacement and fatal behavior for a
  rejected push.
- **Channel is in-process, lifecycle-coupled; one `invoke` Command primitive
  and one event-delivery primitive; no RPC, no replay, no snapshot, no
  Core-to-Channel query port.** All three delete `ChannelRoutes`,
  `targetLifecycle`, `ensureCollaborationTarget`, `deliverExact`, `reply?`,
  `react?`, `resolveTarget`, `messageBelongsToTarget?`, `ChannelTarget`,
  `ChannelContainer`, `binding_fallbacks`, and the entire Core
  `channel-binding/` and `collaboration-space/` modules.
- **Initial Command catalog is exactly `turn.submit` + idempotent
  `team.create`; initial event catalog is exactly `team.state`, `agent.state`,
  `turn.submitted/settled/message/tool_call`; no Workflow/scheduler/host
  Commands or events.**
- **Channel-chosen opaque correlation carried through submitted/activity/
  settled events without becoming routing state.**
- **Schedules fires submit immediately with no idle wait; Provider-native
  folding into active work is accepted; `ambiguous` is not retried.**
- **Dissolve is immediate and destructive, with a worktree cleanliness
  preflight, a post-stop recheck, an explicit `force`, background physical
  cleanup, fail-open self-dissolve response loss, and a recoverable
  post-stop-dirty partial state.**
- **`readTranscript` is replaced (not renamed) by a mandatory neutral
  record-oriented Activity reader returning assistant messages plus tool
  lifecycle markers, with no tool arguments/results. Live activity sink keeps
  the wider COT payload (arguments/results, post-redaction); reader and sink
  are not a delivery contract for each other.**
- **External-route binding moves entirely to Channel-owned state in a
  Channel-namespaced directory under the dispatcher state root, with
  `bind_channel`/`unbind_channel`/`list_bindings` as Channel MCP tools, no
  `transfer_back` alias.**
- **TeamLeader Channel-tool egress has no Core binding-scoped authorization;
  the existing `authorizeTeamLeaderEgress`/`messageBelongsToTarget` path is
  deleted, while caller context is retained because the Feishu COT module
  uses it (`feishu-cot-session.ts:83-99`) for anchor management — a
  non-authorization consumer explicitly allowed by requirement §"Channel-tool
  egress".**
- **Fail-loud cutover; no adapter, no compatibility alias; Rush change files
  with `BREAKING:` lead notes and `Rebuild:`/`Review:` lines.**

### 16.2 Accepted arguments from other proposals (with evidence and resulting changes to my position)

#### 16.2.1 Structured-output binding time is **create-context (session-scoped), not per-submission**

My first-round §3.3 and §3.4 removed `outputSchema` from the create context
and bound schemas per submission, arguing "every submission may carry its own
schema." Codex (§"Create context and structured output") and Claude (§3.6)
both bind it at create-context and remove the per-submission field, on the
evidence that:

- `claude-code/src/runtime.ts:248-259` explicitly throws
  `UnsupportedAgentRuntimeFeatureError('outputSchema')` if a later submission
  supplies a different schema than the process was spawned with —
  per-submission binding is not a thing that runtime can honor without a
  hidden restart.
- `teammate-collection/index.ts:142-147` calls `assertStructuredOutputSupported`
  at `createLocked` time and supplies the schema in the **create context**
  (`runtime-owner.ts:216`); `teammate-service/index.ts:460-464` then does
  *not* pass `outputSchema` to `runtime.completionInput` for that case — the
  per-turn schema field is used by Workflow's `createLocked` path
  (`workflow-service/run.ts:346,381`) which also creates a dedicated TeamMate
  per schema via `createLocked({outputSchema})`.
- Therefore in current code there is **no** caller that switches schema on
  an existing session: every schema-constrained run creates a dedicated
  runtime at `createLocked` time, and the schema is a create-time fact for
  every supported provider.

**Evidence accepted.** I was wrong: per-submission binding cannot be honored
by Claude Code without hidden restarts, and no existing caller needs it.

**Change to my position:**

- `AgentRuntimeCreateContext.outputSchema` stays (required to be supported by
  every Provider), and the `plain_turn` submission input drops
  `outputSchema`. The submission union retains no schema field.
- A Provider whose engine binds per turn (Codex) stores the create-context
  schema and applies it to every native turn; this is provider-local, zero
  Core branching (matching Claude's §3.6).
- The Provider-level `getCapabilities()` discovery record drops any
  structured-output field entirely (my first round already did this); there
  is no `scope` to negotiate. Conformance is enforced by the loader + parity
  fixture.
- `UnsupportedAgentRuntimeFeatureError` with `feature:'outputSchema'` is
  removed from the runtime handle (since there is no per-submission feature
  to reject) but remains as a createRuntime failure mode: a provider that
  cannot honor the requested schema must reject createRuntime loudly (per
  Claude's §"Conformance" paragraph).

#### 16.2.2 Channel session lifecycle is split into `initialize` / `start` / `close` — not `start(sink, events)`

My first-round signature was `start(sink, events)`. Codex uses
`initialize({commands})` followed by a parameterless `start()` and supplies
events through a delivery callback `onMessage(kind, event)` (rejecting
subscribe-with-revocation in favor of direct delivery). Claude uses
`start(core: {invoke, subscribe})` (one port object, one call) and an explicit
revocable `subscribe` returning an unsubscribe handle.

Re-examining the lifecycle requirements in requirement §"Direct Provider
control and lifecycle" plus review §"Push-only runtime state and start
outcome" and §"Protocol, persistence, and shutdown contracts":

- Core must attach event consumers **before** admitting operations. Both
  `start(port)` (Claude) and `initialize(commands); start()` (Codex) satisfy
  this.
- The Channel must be able to register listeners synchronously before its
  external I/O opens. Both forms satisfy this.
- Core needs a revocation handle for shutdown ordering (event leases outlive
  runtime stop through settlement; Claude §9.2 makes this case explicitly —
  revoking events before runtimes stop drops `turn.settled`). Codex's
  `onMessage(kind,event)`-as-callback form leaves Core unable to revoke
  except by closing the session, which forces the wrong order.
- A no-MCP no-events Channel still needs zero no-op stubs. An events
  callback as a session member (Codex's shape) forces every Channel to
  implement an `onMessage` method even if it ignores all events — dead surface
  the minimality constraint is supposed to prevent (Claude rejects that shape
  on exactly these grounds in §13).
- The requirement's literal phrasing is "one event-delivery primitive
  equivalent to `onMessage(event, payload)`." A `subscribe(listener)` returning
  an unsubscribe handle *is* that primitive: one listener attachment, one
  delivery path. It is not a wider surface than a required `onMessage`
  method — it is narrower, because a Channel that consumes no events just
  never calls `subscribe`.

**Resolution:** Claude's shape (`start(corePort)`) is the closest fit, but
with one adjustment from Codex: split initialize from start so that the
Channel can do synchronous state loading/provisioning-saga recovery **before**
any Command invocations race external I/O open. Codex's reasoning is sound
that saga recovery belongs inside `start` once the port is available, but
"initialize-then-start" makes the contract explicit: no external I/O, no
external command invocations expected to affect external users, and no
listeners attached before `initialize` returns; `start` opens external I/O.

**Change to my position:**

- Session lifecycle is:
  `session = createSession(ctx)` → `await session.initialize({commands})` →
  (Core mints event lease for this session) → `await session.start({events})` →
  …run… → `await session.close()`.
- `initialize` is synchronous-in-spirit (returns `Promise<void>`) for state
  loading/validation and **must not** open external I/O; it may call
  `commands.invoke` to recover idempotent provisioning state (e.g., replay
  `team.create` for in-flight sagas — those calls are safe before open
  because they only resolve Team identity, not external delivery).
- `start` opens external I/O. The Channel may call `events.subscribe(...)`
  synchronously inside `start()` before opening external I/O, guaranteeing
  it sees every event for any Command invocation made after external I/O
  opens.
- Events are delivered through a revocable `subscribe(listener)` that
  returns an `unsubscribe()` handle — a single listener receives all event
  kinds (the listener discriminates on `event.kind`). This is narrower than
  my first-round per-kind `on(kind, listener)` because it forces the Channel
  to have at most one listener lease (simpler shutdown, simpler drop policy,
  no per-listener queue to reason about) and still satisfies "one primitive."
  If multiple internal components need events, the Channel demultiplexes
  internally.

#### 16.2.3 Activity reader context needs an explicit Provider-owned `dataDir` / `storage` (not just identity)

My first-round §3.2 claimed "provider-owned session directory is authoritative
once identity is resolved" and dropped `cwd`, `injectEnv` from the read
context. Codex (§"Create context and structured output", `AgentRuntimeStorage`)
and Claude (§3.3 `AgentSessionRef.provider_state`) both introduce a
durable Provider-owned locator:

- Codex gives a `storage.dataDir` (Provider-owned durable subdirectory per
  entity) and removes the public `transcript_locator` in favor of a
  Provider-internal mapping.
- Claude retains the existing `identity.json.transcript_locator` field as
  `AgentSessionRef.provider_state` (opaque to Core) on blast-radius grounds:
  renaming it destroys session continuity for every existing TeamMate.

Current source evidence: `agent-runtime/codex/src/runtime.ts:122,139,327,364`
writes an absolute filesystem path into `transcript_locator` and reads it
back to find the native JSONL transcript on resume. Codex's proposal would
have Core allocate an entity-scoped `dataDir` and let the Provider write
internally-meaningful locators inside it, removing the path from the public
identity record. Claude keeps the field (renamed conceptually to
`provider_state`, physically retained as `transcript_locator` to avoid a
forced rebuild).

**Resolution:** the functional requirement is "Core persists an opaque
Provider session-state blob and never interprets it." Two concrete
approaches, both acceptable, but Claude's blast-radius argument is decisive:
a field rename that breaks every existing TeamMate session across every
existing dispatcher is an extra forced rebuild on top of an already-breaking
contract change, and the value semantics are identical before and after.

Codex's addition of an explicit Provider-owned `dataDir` is still valuable:
without one, the Codex provider has to embed an absolute path into
`provider_state`, which is fragile across machines or state-root moves. A
stable entity-scoped directory Provider can use for durable scratch is a
path-builder concern (like `runtimeSocketDirs` for volatile sockets), not a
domain concept.

**Change to my position:**

- `AgentRuntimeIdentity` keeps `session_id: string | null` (replacing
  `checkpoint`) and adds `provider_state: string | null` (Provider-opaque
  state atomically persisted with `session_id`). The physical storage key is
  the existing `identity.json.transcript_locator` field, renamed in the
  TypeScript type to `provider_state` with a one-line store read/write
  backward alias that maps to the same JSON key (no migration — the field's
  semantics broaden from "native transcript path" to "any opaque Provider
  state"). This is not a compatibility adapter; it is renaming the public
  type while keeping the on-disk shape to honor existing sessions.
- Add `AgentRuntimeStorage` (matching Codex's shape) to the create context:
  `{dataDir, cacheDir, logsDir, runtimeSocketDirs}`, replacing my first-round
  `paths?: AgentRuntimePathContext`. This gives every Provider a known
  durable scratch directory scoped to the entity and Provider ref (Core
  creates it at
  `<state>/<dispatcher>/<team|teammate>/<name>/provider/<providerRef>/`),
  which the Codex provider can use to store its native transcript instead
  of embedding absolute paths. `cacheDir`/`logsDir` retain their existing
  roots; the Provider composes subpaths inside them.
- `readRecentActivity` context carries `identity: {runtime_id, session_id, provider_state}`, `config`, `storage` (same `AgentRuntimeStorage`), and
  `logger`; I was wrong to drop `cwd`/`injectEnv` — Codex is right that the
  Provider needs cwd to interpret relative history references if any.
  Adding `cwd` and `injectEnv` back. No caller-selected byte budget field;
  Core enforces the 256 KiB page budget centrally (matching Codex §"Rules").

#### 16.2.4 Runtime state sink: ordered, leased, and *one* publish method with a discriminated update (not three methods)

My first-round §3.3 exposed three methods (`setStatus`, `setCheckpoint`,
`recordLostCheckpoint`), each taking a `generation` argument. Codex exposes
one `publish({sequence, update})` where `update` is a discriminated union
(`status` / `session`) with strict ordering and fatal-on-rejection; Claude
exposes a `AgentRuntimeStateLease` with three methods (`setStatus`,
`setSession`, `reportSessionLost`) and uses the store's existing
`mutationTail` for serialization, plus a `lease.drain()` that Core awaits
before admitting the first submission.

The discriminated-union single-publish shape (Codex) is cleaner for ordering
enforcement: sequence number is a field on every update, out-of-order/duplicate
rejections are one code path, and Core's projection from update to
identity-store writes is a single switch. Claude's `drain()` is critical for
start fencing (the requirement says Core must know start outcome before the
first submission is admitted) and is easy to add onto either shape. My
three-method shape invites divergent ordering between status/checkpoint calls.

**Change to my position:**

- `AgentRuntimeStateLease` exposes one method:
  `publish(seq, update): Promise<{accepted:boolean}>` where `seq` starts at 1
  and increments by one per publish, and `update` is
  `{kind:'status', status, lastError?} | {kind:'session', sessionId, providerState?} | {kind:'session_lost', reason}`. The optional `recordLostCheckpoint`
  collapses to `session_lost`.
- Core rejects (returns `accepted:false`) duplicate, out-of-order, or
  post-revocation publishes. A rejected publish is fatal: the Provider must
  treat it as a stop signal and exit; Core marks the entity `degraded` and
  initiates stop (matching Claude §"Sink failure").
- The lease has `drain(): Promise<void>` which resolves when every accepted
  publish up to this point has been durably persisted to Core's identity
  store. Core calls `await lease.drain()` after `start()` resolves and
  before marking the runtime live; this is how we satisfy "restart notice
  consumes start result before first admission" without a separate query.
- `revoke()` closes the lease; subsequent publishes return
  `accepted:false`.

#### 16.2.5 Team-create idempotency ledger compaction and capacity

My first-round proposed JSONL with 30-day TTL for closed Teams. Codex
proposes a "fixed-cap ledger that never evicts accepted identities; fail loud
at capacity rather than create a duplicate Team." Codex's reasoning is
stronger: a 30-day TTL on a ledger whose correctness requirement is
"restart-durable same request_id returns same team_name forever" is a
correctness bug if a Channel resends an old request_id after TTL expiry (it
would silently create a second Team). A fixed-cap ledger (say 65 536
request_id entries per dispatcher, enforced at write time) and explicit
`IDEMPOTENCY_CONFLICT` on reuse with different canonical hash, plus no
eviction, is safer. A dispatcher that legitimately needs more than 65k
idempotency records over its lifetime is far outside realistic scale; fail
loud is the right behavior.

**Change to my position:** switch the ledger to a single JSON document (not
JSONL) with a fixed cap of 65 536 entries per dispatcher, no TTL-based
eviction. Compaction removes entries only when the corresponding Team record
is itself deleted (there is no such path today — concrete Team names are
never reused — so the ledger effectively grows monotonically but slowly).
The existing atomic JSON document store (`platform/json-document-store.ts`)
is reused, matching Claude's `team-create-ledger.json`. Codex's tighter
capacity-fail-loud stance is adopted.

#### 16.2.6 Event queue policy: drop display detail, never lifecycle; 2s listener timeout

My first-round used a single 1024-entry FIFO with "drop oldest" on overflow
and no lifecycle/display distinction, plus no per-listener timeout. Both
Codex and Claude separate lifecycle events (`team.state`, `agent.state`,
`turn.submitted`, `turn.settled`) from display detail
(`turn.message`/`turn.tool_call`), never dropping lifecycle, and both have
time bounds on listener invocation. Claude adds a 2-second await bound per
listener so a slow Channel cannot stall Core publication — important because
the current bus is fully synchronous (`EventEmitter`-like).

Evidence for lifecycle-vs-display priority: `turn.submitted` carries the
`turn_id` and the correlation anchor; dropping it leaves COT unable to
render any subsequent messages for that turn (the COT code keys on turn_id).
`turn.settled` closes the live card; dropping it leaves a card spinning
forever. These drops cause visible user-visible corruption, whereas dropping
a mid-turn `turn.message`/`turn.tool_call` is already best-effort.

**Change to my position:**

- One queue per Channel subscription (single-subscriber model per §16.2.2),
  512 entries.
- On overflow: drop the *oldest queued display-detail* event; if no
  display-detail event is queued (only lifecycle events remain), drop the
  *incoming* display-detail event; **never drop lifecycle events**.
- Each listener invocation is awaited with a 2-second wall bound; on
  timeout the event is abandoned and the queue proceeds. Listener
  exceptions are caught, logged, and fail-open (do not stall the queue).
- Drops are logged once per 10-second window per subscription with a
  counter.
- On shutdown (matching Claude §9.2 ordering): stop admitting new Commands →
  drain accepted Commands → close sessions (Channel stops external I/O) →
  stop runtimes (which may emit settlement events) → drain event queue →
  revoke event leases. Runtime stop therefore precedes event-lease
  revocation, so final `turn.settled` and `agent.state:closed` events reach
  the Channel.

#### 16.2.7 Team-create Command surface: narrow to the trusted minimum

My first-round `team.create` payload exposed `name_prefix`, `leader_agent_runtime`,
optional `repo`, `worktree`, `intent`, `identity`, `prompt`, `skill_sources`.
Claude narrows this to `name_prefix`, `leader_agent_runtime`, `intent`,
optional `repo.{cwd,worktree}`, optional `prompt` — explicitly excluding
`identity` and `skill_sources` from the Channel catalog as host-maintenance
capabilities. Codex's payload is similarly scoped (it constructs
`DreamuxManagedRepoRequest` from neutral fields).

Claude's narrower catalog is correct per requirement §"Channel-to-Core
Command invocation" ("A catalogued Command needs no second Channel-specific
allowlist, but still owns the validation, admission, authorization, and
idempotency rules that apply to all callers") and the freeze-audit note
"trust applies only to the deliberately small Channel Command catalog."
Injecting arbitrary skill sources or identity prompts is host-maintenance
(MCP/Dispatcher) surface; Channel is not trusted to do that at `invoke`
time. Core applies required TeamLeader skill sources (including the
dispatcher-default ones) itself, matching the existing `TEAM_LEADER_REQUIRED_SKILL_SOURCES` pattern.

**Change to my position:** `team.create` payload is
`{schema_version:1, request_id, name_prefix, leader_agent_runtime, intent, repo?:{path,base_ref}|null, prompt?:string|null}`.
`skill_sources` and `identity` are not Channel-exposed. Core applies
canonical defaults.

#### 16.2.8 Turn submission Command: retain `source_id` and `turn_source` as load-bearing fields

My first-round modeled `turn.submit` as taking the existing
`InboundTurnInput` plus `team_name` and `correlation_value`, leaning on
`input.sourceId` for dedupe. Claude (§4.2) makes `source_id` a top-level
field ≤ 512 bytes and adds a **required** `turn_source: ChannelTurnSource`,
remarking that `turn_source` is load-bearing for frozen COT anchor logic
(Feishu COT treats completion and channel turns differently). Codex scopes
`input.sourceId` by invoker Channel id to prevent cross-Channel dedupe
poisoning.

Current source: `ChannelTurnSubmittedEvent.turn_source` exists today but is
marked optional ("Optional for compatibility with older Core publishers and
fixtures"). The COT code does dispatch on it (and on `channel_origin`).
After Core binding is deleted, `channel_origin.binding` disappears; the
`turn_source` discriminator becomes more important, not less. Making it
required prevents fixtures from drifting.

**Change to my position:** `turn.submit` has top-level `correlation`
(opaque ≤256 bytes), optional `team_name`, and an `input` carrying the
`InboundTurnInput` shape (text/body/attrs/attachments/sourceId). Core scopes
`sourceId` by the invoker Channel id (Codex's scoping) and stamps
`turn_source: 'channel'` on the resulting events (the Channel cannot spoof
other sources). `turn_source` is required on every turn event.

#### 16.2.9 Activity Record status vocabulary: add `succeeded`, add error field

My first-round tool record used `status: 'started'|'completed'|'failed'`
with `error: string|null`. Codex uses `'started'|'completed'|'failed'`
without error. Claude uses `'started'|'succeeded'|'failed'|'unknown'` with
no error text.

Claude's `succeeded` naming aligns better with existing settled-vocabulary
nouns (`completed` is overloaded with turn completion). The requirement
(review-findings §"second-round direct corrections") says "assistant
messages and tool name/status" with no error string specified; an error
string on Activity Records would leak provider error text into the MCP
surface. Codex and Claude both omit tool error text. The current
`RuntimeActivity` on the sink uses `error: string|null` for live COT
display, which is separate.

**Change to my position:** Activity Record tool status is
`'started'|'succeeded'|'failed'|'unknown'`; no error field. Cursor is named
`next_cursor` (matching my first round, not Codex's `nextBefore` / Claude's
`next_cursor`), pagination is newest-first → backward (matching Claude),
records are chronological within a page. `include_tools` defaults to true.
Occurred-at is a ms-epoch number, not ISO string (Claude uses ISO, Codex
allows null; existing `RuntimeActivity.occurredAt` is ms-epoch, and we
should stay consistent for COT-time-ordering).

#### 16.2.10 Cutover: fail-loud on legacy state, no importer

Codex rejects startup on legacy `channel-bindings.json`/
`collaboration-spaces.json` and requires the operator to back them up
outside state and recreate bindings. Claude routes through the existing
`legacy-state.ts` detector (`legacy-state-fail-loud.test.ts` covers this
pattern) so `dreamux serve` aborts and `dreamux doctor` diagnoses. Codex
would have Feishu read a renamed legacy file once to import bindings
(§"Feishu binding persistence ... reads the legacy file once"); Claude
calls this out as an adapter and rejects it (§13 "Migrating Core binding
state... 0.x has no schema migration").

Re-examining requirement §"Confirmed operator decisions": "The full
Provider/Channel rewrite is intentionally incompatible. No legacy contract
adapter, forward-compatibility path, or old-name alias is designed." A
Feishu-internal one-time importer is still an adapter; it just lives in the
Feishu package instead of Core. The operator has said no adapter. Claude's
fail-loud path is strictly aligned.

My first-round was inconsistent (I said Feishu "may read the legacy file
once to import" in §9.2).

**Change to my position:** no importer anywhere (Core or Channel). Core
detects `channel-bindings.json` and `collaboration-spaces.json` at startup
via the existing `legacy-state.ts` mechanism and aborts with a named error
and explicit `Rebuild:` path (back up the files out of state, recreate
bindings via Channel MCP). Existing Teams remain valid ordinary Teams; only
binding/Collaboration Space state is lost. The Rush change notes lead with
this rebuild action.

### 16.3 Rejected arguments (with reason and current-source/requirement evidence)

#### 16.3.1 Codex's `getCapabilities(tags-only)` — activity reporting is not a tag

Codex §"Provider facade" drops `activityReporting` from the capability
record entirely, saying "it is harmless when absent." I retained an
`activityReporting: boolean` tag in my first round; Claude makes
`getCapabilities` a possibly-deletable discovery surface.

The requirement says (§"Minimal Agent Runtime contract"): "Activity
reporting is optional; a runtime that emits no activity is valid; Dreamux
omits COT presentation." For Dreamux to know whether to wire COT
presentation (and whether to surface `last` richer output, whether to
log a warning on a totally silent provider), it needs a fact about whether
the Provider emits activity. Without that bit, Dreamux has to infer from
"no events ever arrive," which is indistinguishable from "a very quiet
turn." A boolean tag on `getCapabilities()` is the right place — it is
discovery metadata, not a feature-negotiation bit. Codex and Claude are
both wrong to drop it entirely.

**Retained:** `AgentRuntimeCapabilities` carries `tags: readonly string[]`
plus `activityReporting: boolean`. No resume/structured-output bits (both
mandatory).

#### 16.3.2 Codex's required `initialize`/`start` split — adopted in spirit, but
with event port handed to `start`, not to `initialize`

Codex hands the invoker to `initialize` and delivers events through a
session `onMessage(kind,event)` method, then has a parameterless `start`. I
rejected the `onMessage`-as-required-member shape in §16.2.2 because it
forces every Channel to implement a dead no-op method when it consumes no
events and because it cannot be revoked independently of close (needed for
shutdown ordering where events outlive session close). I adopt Codex's
`initialize`/`start` phasing because it cleanly separates state recovery
from external I/O open, but combine it with Claude's revocable `subscribe`
on a `start(core: {events})` port.

#### 16.3.3 Claude's `ChannelCorePort.subscribe` accepts a single listener (no
per-kind `on`)

All three proposals end up with single-listener subscribe. I originally had
per-kind `on(kind,listener)` (matching the existing `ChannelCoreEventSource`).
The single-listener form is narrower: a Channel that wants to demultiplex
does so internally on `event.kind`; per-kind subscribe adds listener-list
management and per-listener queue bookkeeping in Core for no demonstrated
consumer. The existing bus supports per-kind filtering today but no Channel
actually uses per-kind listeners in a way that requires Core to enforce
separation.

**Accepted (from both):** single `subscribe(listener)` returning
`{unsubscribe()}`.

#### 16.3.4 Claude's retention of `identity.json.transcript_locator` as-is (keep
the name in the type)

Claude keeps the on-disk field named `transcript_locator` and would keep the
TypeScript name too. I rename the TypeScript-level type to
`provider_state` while keeping the on-disk JSON key as
`transcript_locator` via a one-line alias in the store. This is a strictly
better developer experience — the public type name now reflects the field's
actual semantics (opaque Provider state blob, not necessarily a transcript
path) without forcing a migration. Claude's blast-radius concern is
satisfied because the wire/on-disk shape is unchanged; Codex's semantic
concern is satisfied because the TypeScript name no longer lies. Neither
reviewer proposed this split.

#### 16.3.5 Codex's Feishu routing document includes target type (topic/chat/etc.)
in the binding record

Codex's `feishu-routing.json` schema (§"Feishu routing document") stores
`{chatId, threadId?, target: FeishuRouteTarget, ...}` with a discriminated
target union. This is necessary for Feishu's multi-target (ordinary chat vs.
topic-group topic vs. thread) hierarchy. My first-round binding store used
an opaque Feishu-defined record, which is fine — I don't prescribe a schema
for Channel-owned state, and neither should the core design. Codex's shape
is sensible for Feishu but is provider-local, not a contract concern.
**No change:** binding persistence schema is Channel-owned; the core
proposal only requires that Channel implement `bind/unbind/list` and
persist durably.

#### 16.3.6 Codex's `blocked_after_stop` vs. Claude's `blocked_worktree`

Codex uses `blocked_after_stop` and reopens ordinary Team admission
("children stay stopped and may be lazily reopened by later ordinary
operations"). Claude uses `blocked_worktree` and keeps the availability
fence closed ("no turns, mutations, or route changes are admitted" until
operator action).

Re-reading the requirement §"Immediate Team dissolve":
> Dispatcher-triggered dissolve performs a non-destructive managed-worktree
> cleanliness preflight before stopping the Team when `force` is false. A
> dirty or unmerged worktree rejects the request without partially dismantling
> the Team. Once the preflight passes, Core stops Workflow, every TeamMate,
> and the TeamLeader and converges their admissions and settlements.

For the dispatcher-triggered path, the preflight runs *before any child is
stopped*. If preflight passes but post-stop recheck finds dirt (races
during stop), the Team is partially dismantled. The requirement says
"non-forced dirty/unmerged cleanup blocks" — it does not say admissions
reopen. Reopening admissions after stopping children would land new turns
in an untracked state, which contradicts "converges their admissions."
Claude's closed-fence is correct.

For self-dissolve, requirement §"Immediate Team dissolve":
> TeamLeader self-dissolve first stops its Workflow and every TeamMate,
> then checks the managed worktree ... after a clean check, Core durably
> accepts the dissolve and stops the TeamLeader runtime without waiting
> for the caller turn to finish.

If dirty, the requirement says "blocked" — it does not say "return the Team
to normal." The Team is already partially dismantled (Workflow and TeamMates
are stopped). Codex's "children stay stopped and may be lazily reopened"
has no supporting requirement language; lazy restart creates a second
dissolve path that Core has to reason about.

**Rejected (Codex):** `blocked_worktree` (Claude's name is slightly better
than Codex's because the blocked fact is the worktree, not the timing).
Fence stays closed; operator cleans or runs with `force: true`; restart
re-enters `blocked_worktree`. No automatic child restart.

#### 16.3.7 Codex's claim that "there is deliberately no arbitrary
public-config map" in getCapabilities

Codex constrains tags to lowercase `namespace:value` form and 32 tags/64
bytes each. I initially had the same discipline. But the requirement (§"Open
technical design decisions") leaves tag vocabulary as an implementation
choice, and current code uses `getCapabilities()` for public display in
`doctor`/`get_capabilities` — aggressive length/tag-namespace validation is
an implementation choice, not a contract requirement. I drop the strict
validation from the *type-level* contract and keep a looser "non-secret,
reasonable size" validator in Core; the exact tag policy is a follow-up
policy decision, not something to lock in the types.

#### 16.3.8 Both other proposals drop `providerRef` from the runtime handle

Codex §"Live base" deletes `providerRef`; Claude §3.1 deletes `providerRef`.
I kept `providerRef` in my first round. Re-examining: Core knows which
provider a runtime came from (it called `provider.createRuntime()`); the
handle does not need to echo that back. No Core consumer reads
`runtime.providerRef` today (the explore found no production consumer), and
logging already carries the provider via the child-logger fields. Deleting
`providerRef` is consistent with minimality.

**Changed:** drop `providerRef` from `AgentRuntime`.

### 16.4 Revised end-to-end position

The final design I would implement is:

**Agent Runtime seam:**

- `AgentRuntimeProvider<TConfig>` has required `ref`, `descriptor`,
  `getCapabilities(config?)→{tags, activityReporting}`,
  `readRecentActivity(query, ctx)`, `createRuntime(CreateContext)`, with
  optional composed `readConfig`, `onboard`, `diagnostic`.
- `CreateContext` carries `identity: {runtime_id, session_id, provider_state}`,
  `config`, `cwd`, `systemPrompt?`, `mcpServers`, `skillSources`,
  `disableFeatures`, `outputSchema?` (session-bound, immutable once
  created), `activitySink?` (optional — presence matches
  `activityReporting`), `storage: {dataDir, cacheDir, logsDir, runtimeSocketDirs}`,
  `injectEnv?`, `logger?`, `state: AgentRuntimeStateLease`.
- `AgentRuntime` has only `start()→{continuity:'fresh'|'resumed'}`,
  `submit(input)`, `stop()`.
- `submit(input)` discriminates `{kind:'channel'} & InboundTurnInput` vs
  `{kind:'text', text, sourceId?}`. No `outputSchema`; no `sourceId` on
  channel inputs (it is a field on `InboundTurnInput`).
- `AgentRuntimeStateLease` has `publish(seq, update)` (discriminated
  `status|session|session_lost`), `drain()`, `revoke()`. Strict
  sequence ordering, fatal on rejection, zombie-proof per-generation.
- `readRecentActivity` returns pages of `assistant_message` /
  `tool_lifecycle` records, chronological, newest-first pagination via
  `next_cursor`, 256 KiB page budget, tool args/results never cross the
  seam, `succeeded` (not `completed`) for successful tool outcome,
  `occurred_at` in ms epoch.

**Channel seam:**

- `ChannelProvider<TConfig>` has required `ref`, `descriptor`,
  `createSession(CreateContext)`, optional `readConfig?`, `getIdentity?`,
  `tools?`, `onboard?`, `diagnostic?`, `handleSessionlessTool?`.
- `ChannelSession` has required `initialize(core:{invoke})→Promise<void>`,
  `start(core:{events})→Promise<void>`, `close()→Promise<void>`, optional
  `handleTool?`. No `onMessage` method; no `reply`/`react`; no
  `resolveTarget`/`messageBelongsToTarget`.
- `events` is `{ subscribe(listener)→{unsubscribe} }`, single listener per
  session, listener gets all events and discriminates on `event.kind`.
- Command catalog is exactly `turn.submit` and `team.create`, versioned
  `schema_version:1`, with typed rejections and bounds; Core validates
  payloads at the port.
- `team.create` is restart-durable idempotent via a fixed-cap JSON ledger
  (`<state>/<dispatcher>/team-create-ledger.json`, 65k entry cap, no
  TTL eviction, hash-of-canonical-input conflict detection); same
  `request_id` + same canonical payload returns the same `team_name`.
- Event catalog is exactly `team.state`, `agent.state`,
  `turn.submitted`, `turn.settled`, `turn.message`, `turn.tool_call`;
  single-FIFO per session, lifecycle events never dropped, display events
  dropped first on overflow, 2s listener bound, fail-open, no replay, no
  retention, revocable only after runtime stop drains settlement.
- Opaque `correlation` (string, ≤256 bytes) attached by Channel to
  `turn.submit`, carried on submitted/message/tool_call/settled events,
  stamped by Core with invoker Channel id/provider, never parsed by Core.

**Core ownership changes:**

- Delete `channel-binding/`, `collaboration-space/`, `binding-events.ts`,
  the `ChannelService` binding methods, `authorizeTeamLeaderEgress`,
  `transfer_back`, the `ChannelRoutes` bag, `ChannelTarget`/`ChannelContainer`
  types, the `binding.*` events, `resolveTarget`/`messageBelongsToTarget`/
  `reply?/react?` on ChannelSession, and the `collaborationSpace` config
  block.
- Delete runtime idle/dissolve wait paths, scheduler held-fire/idle defer,
  `waitIdle`, `getStatus/getCheckpoint/wasCheckpointResumed/getContext`
  runtime handle methods, handle-level `getCapabilities`, separate
  `resume`/`channelInput`/`completionInput` methods,
  `readTranscript`/transcript types, `UnsupportedAgentRuntimeFeatureError`
  on the runtime handle, and capability bits for resume/structured output.
- Add per-Channel state directory
  `<state>/<dispatcher>/channel/<channel_id>/` (Core creates it) owned by
  the Channel.
- Add entity-scoped Provider `dataDir` under
  `<state>/<dispatcher>/<team|teammate>/<name>/provider/<providerRef>/`
  for Provider-owned durable scratch.
- Add a path alias in `AgentEntityIdentity` serialization mapping the
  TypeScript field `provider_state` to the existing JSON key
  `transcript_locator`, so existing sessions survive without migration
  while the public type reflects the field's new semantics.
- Add blocked-dissolve state `blocked_worktree` with fence closed,
  restart-recoverable, operator-only exit (clean or `force:true`).
- Replace legacy-state detection to fail-loud on old
  `channel-bindings.json`/`collaboration-spaces.json`, matching the
  existing `legacy-state-fail-loud.test.ts` pattern.

**Channel-owned changes (Feishu built-in):**

- Feishu persists bindings and provisioning sagas in its own state
  directory, owns bind/unbind/list MCP tools, resolves inbound against its
  own routing table, invokes `team.create` with idempotent `request_id`
  for auto-provisioning, installs the binding before first submit, and
  invalidates bindings on `team.state{status:'closed'}`. No legacy
  importer.
- Feishu COT anchor mapping moves from `ChannelOrigin.binding` to
  correlation-based lookup using the Channel's own binding state.
- TeamLeader tool calls (`reply`, `react`, send-message, etc.) flow
  through the Channel MCP proxy without Core binding-owner authorization,
  while `caller` context is retained for COT anchor management.

### 16.5 Changes to my first-round proposal (summary)

Material revisions (other proposals changed my mind):

1. **Structured output binding time**: moved from per-submission to
   create-context (session-scoped, immutable); submission carries no schema.
2. **Session lifecycle**: split into `initialize(commands)` +
   `start({events})`; events delivered via `subscribe(listener)` returning
   `{unsubscribe}` instead of per-kind `on(kind,listener)`.
3. **State lease shape**: one `publish(seq, update)` with discriminated
   union, plus `drain()` for start-fencing, instead of three methods.
4. **Runtime storage**: added explicit `AgentRuntimeStorage` to create
   context with entity-scoped `dataDir`; read context carries cwd+injectEnv
   back.
5. **Identity field**: TypeScript `provider_state` with on-disk alias to
   existing `transcript_locator` key (no forced rebuild).
6. **Ledger**: switched from JSONL+TTL to fixed-cap JSON document, no
   eviction, fail-loud at capacity.
7. **Event queue policy**: lifecycle/display split, lifecycle-never-drop,
   2s listener bound, single listener per Channel.
8. **Shutdown ordering**: event leases outlive runtime stop so
   `turn.settled` reaches the Channel.
9. **`team.create` payload**: narrowed to remove `skill_sources` and
   `identity` (Core applies defaults).
10. **`turn.submit`**: Core stamps `turn_source: 'channel'`; scopes
    `sourceId` by invoker Channel id; `turn_source` is required on events.
11. **Activity Record status vocabulary**: `succeeded` replaces
    `completed`, no error string, `occurred_at` is ms epoch.
12. **Drop `providerRef`** from `AgentRuntime`.
13. **No legacy importer**: fail-loud only.
14. **Dissolve blocked state**: fence stays closed in `blocked_worktree`;
    no lazy child restart.

Points I retain from my first round against disagreement:

- `activityReporting: boolean` on the Provider capability record (16.3.1).
- Correlation is a structured `{provider, channel_id, value}` triple (Core
  stamps provider/channel_id so Channel cannot spoof it); other proposals
  use plain `string` correlation, which risks cross-Channel confusion if
  a Team is bound to multiple channels. The correlation attachment is a
  Core-populated envelope, not a Channel-chosen blob. The requirement says
  "Channel-chosen opaque correlation value ... Core does not parse or
  authorize against that value" — stamping provenance is not parsing or
  authorizing, it is preventing a Channel from attributing events to
  another Channel. This aligns with how the existing `channel_origin`
  carries `provider`/`channel_id` today.
- Provider `getCapabilities(config?)` may be called with parsed config
  (not only with no argument); Codex makes it config-resolved, Claude
  makes it parameterless. Config-resolved is needed so runtime availability
  can depend on config (e.g., a future provider that disables activity
  reporting via config).

### 16.6 Residual risks and unresolved disagreement

- **`dataDir` vs `transcript_locator` path semantics for Codex.** Codex's
  provider currently writes an absolute path into `transcript_locator`.
  With the new `dataDir`, the Codex provider should migrate to storing
  just a filename/relative locator inside `provider_state` and resolving
  it against `storage.dataDir`, which makes state roots relocatable.
  Whether the Codex implementation does this in the first cut or lands
  with absolute paths first is an implementation choice, not a contract
  issue; the contract permits opaque `provider_state` either way. No
  proposal-level disagreement.
- **Single-listener vs per-kind `on` for events.** I adopted the single
  listener form for minimality. If implementation reveals a concrete
  consumer that needs separate queues (e.g., two internal Feishu components
  that need independent drop/isolation semantics), adding a per-kind
  `on(kind, listener)` later is an additive catalog change on the
  `events` object, not a seam change.
- **`team.dissolve` in the Channel Command catalog.** I omit it (and so do
  both other proposals); Claude flags this as a potential future addition.
  Adding it later is an additive catalog entry.
- **Whether Provider tags need strict validation (namespace:value, length
  caps).** I defer that policy; codifying strict caps in the type contract
  now would be premature.
- **Feishu binding persistence schema.** Provider-local; not a Core
  contract. Codex's schema is reasonable but Feishu implementers own it.
- **The size of the Rush change file set.** All three proposals agree on
  BREAKING changes for `dreamux`/`dreamux-types`/`agent-runtime-codex`/
  `agent-runtime-claude-code`; Claude notes `@excitedjs/feishu-channel`
  needs a real semver major (post-1.0 package). Codex and I did not
  explicitly call this out, but Claude is right per the repo rules in
  AGENTS.md ("packages already past 1.0 use real semver majors"), so the
  Feishu Channel change file should be `type: major`. I adopt that.

No residual disagreement that would materially change ownership, contracts,
migration, lifecycle, concurrency, or verification. The three proposals
converge on the same architecture; the differences above are type-shape and
implementation-detail decisions that do not alter the seam boundaries.
