# Technical Proposal — Minimize Provider Boundaries

Author seat: Claude. Independent first round.
Frozen requirement revision: `89e95d7fb3fd0dcf5585484becbd529a34d6d425e73aae500a31595210a5433c`
(verified locally against `requirement.md` with `sha256sum`).

Grounded in current source at `57a2cf8a` on
`refactor/minimal-agent-runtime-provider`. This proposal changes no product
code; it specifies the change.

---

## 1. Position in one paragraph

The two neutral seams are too wide because Core currently *pulls* facts a
Provider already owns, and *owns* facts a Provider should own. The fix is
symmetric on both seams: on the Agent Runtime seam, delete every pull surface
and every capability negotiation, leaving a three-verb live handle
(`start` / `submit` / `stop`) plus a Provider facade that pushes state through a
leased sink and answers exactly one record-oriented read (activity). On the
Channel seam, delete every Core-owned Channel concept (binding store,
Collaboration Space, target resolution, egress authorization) and replace the
five-member `ChannelRoutes` callback bag with one bidirectional port: a
two-Command `invoke` and one `subscribe` event primitive. Everything the seams
stop carrying moves to the layer that already holds the domain model — the
Provider package — not into a compatibility shim. There is no adapter, no alias,
and no migration; the cutover is fail-loud with named rebuild actions.

The work is one coherent change to five owners that already exist. It creates
exactly four new capabilities (activity reader, state lease, Channel Core port,
`team.create` idempotency ledger) and deletes eleven.

---

## 2. Ownership map after the change

| Fact / behavior | Owner today | Owner after | Note |
|---|---|---|---|
| Runtime session continuity decision | Core (`runtime-owner.startFromRecord` branches on `capabilities.resume.supported`) | Provider (`AgentRuntime.start`) | Core reads the returned outcome, never the capability |
| Runtime status / session id / session state | Provider *pushes* via `AgentRuntimeStateCallbacks` **and** Core *pulls* via `getStatus`/`getCheckpoint`/`wasCheckpointResumed` | Provider pushes only, through a leased sink | duplicate pull surface deleted |
| Structured-output support | negotiated per submission (`capabilities.structuredOutput.scope`, `UnsupportedAgentRuntimeFeatureError`) | mandatory, bound once at create-context | Provider adapts per-turn natively |
| Runtime idleness | Provider (`waitIdle?`) consumed by scheduler + dissolve | nobody | both consumers redesigned, not re-derived in Core |
| Recent TeamMate activity | Provider `readTranscript` returning provider-shaped turn/block pages | Provider `readActivity` returning neutral Activity Records | mandatory, record-oriented, active-session capable |
| Session-to-native-history location | Core-visible `transcript_locator` on the checkpoint | Provider-written opaque `provider_state` on the session ref | Core persists, never interprets |
| External-route (channel binding) authority | Core `ChannelService` + `ChannelBindingStore` + `channel-bindings.json` | Channel Provider, in Provider-owned state | Core keeps no binding concept |
| TeamLeader egress authorization | Core `authorizeTeamLeaderEgress` | Channel Provider, against its own binding state | caller context is already forwarded (`feishu-channel/src/provider.ts:168`) |
| Automatic external-target provisioning | Core `CollaborationSpaceService` + route reconciliation + `collaboration-spaces.json` | Channel Provider saga over ordinary Commands | Core Collaboration Space deleted entirely |
| Channel target resolution / message-belongs-to-target | Core calls back into `ChannelSession.resolveTarget` / `messageBelongsToTarget` | Channel Provider, internally | Core stops asking |
| Turn-to-conversation association | Core `ChannelOrigin { target, binding }` | Channel-chosen opaque `correlation`, carried unchanged | Core never parses it |
| Turn origin *category* | `ChannelTurnSource` | unchanged, and now **required** on turn events | see 6.2 — load-bearing for frozen COT |
| Team create idempotency | none | Core, restart-durable ledger | generic request id, no Channel target parsed |
| Team dissolve quiescence | wait for `waitIdle` of every live writer | immediate stop + post-stop cleanliness recheck | new recoverable blocked phase |
| Scheduler busy handling | held fire + idle wait | immediate submission through normal admission | folding is accepted Provider behavior |

Unchanged owners, stated so reviewers do not have to infer it: `TeammateService`
still owns one agent entity's runtime and logical close; `CompletionDeliveryPolicy`
(`service/completion-router/index.ts`) still owns completion-token routing and
per-recipient delivery; `EntityTurnCoordinator` still owns admission
continuation, submission retention, and settlement; `WorktreeManager` still owns
non-destructive `assessCleanup` and mutation-time reassessment;
`DispatcherCoreEventBus` still owns event fan-out and lease revocation;
`conversation-projection.ts` still owns COT projection and redaction.

---

## 3. Agent Runtime contract

All types live in `packages/dreamux-types/src/agent-runtime.ts`. The loader
`packages/dreamux/src/agent-runtime/external-provider.ts` is the conformance gate.

### 3.1 Live handle — three verbs

```ts
export interface AgentRuntime {
  start(): Promise<AgentRuntimeStartOutcome>;
  submit(input: AgentRuntimeSubmission): Promise<RuntimeAdmission>;
  stop(): Promise<void>;
}

export interface AgentRuntimeStartOutcome {
  /** Neutral continuity fact, known before the first submission is admitted. */
  readonly continuity: 'fresh' | 'resumed';
}
```

Deleted from the handle: `providerRef`, `resume`, `channelInput`,
`completionInput`, `waitIdle?`, `getStatus`, `getCheckpoint`,
`wasCheckpointResumed`, `getContext`, `getCapabilities`.

`resume` disappears as a *verb*, not as a *behavior*. Continuity is mandatory:
`start()` receives `AgentRuntimeCreateContext.identity.session` and must continue
that session when it is non-null and continuable, reporting
`continuity: 'resumed'`. When it is null, or the native session is gone, the
Provider starts fresh, reports `continuity: 'fresh'`, and — if a session was
present but lost — reports that loss through the state lease (3.3) so Core can
mark the entity `degraded` exactly as `recordLostCheckpoint` does today.

`RuntimeAdmission`, `RuntimeSubmission`, `RuntimeCompletion`,
`RuntimeSubmissionSettlement`, and the admission vocabulary
(`submitted | duplicate | stopped | skipped | failed | ambiguous`) are unchanged
types, moved under one verb. This is deliberate: they encode invariants the
review requires to survive (`failed` proves pre-admission; `ambiguous` is never
auto-retried; folding vs queuing is Provider-native; completion identity is
immutable; settlement is exactly-once).

### 3.2 Submission union

```ts
export type AgentRuntimeSubmission =
  | ({ readonly kind: 'channel' } & InboundTurnInput)
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly sourceId?: string;
    };
```

The discriminant preserves the distinction the review pins: `kind: 'channel'`
carries the opaque display passthrough (`attrs`, `body`, `attachments`) that the
Provider renders verbatim into its native channel envelope (see
`packages/dreamux/CLAUDE.md`, "opaque display passthrough", and
`.agents/decisions/channel-input-runtime-assembly.md`); `kind: 'text'` is
Core-owned plain text (completion delivery, restart notice, scheduled fire) and
must never be rendered as external speech. `sourceId` keeps its current meaning
and namespace — the dedupe key is scoped to the receiving agent entity, exactly
as today — so no dedupe namespace moves.

`AgentRuntimeTextInput.outputSchema` is deleted along with
`UnsupportedAgentRuntimeFeatureError` and `assertStructuredOutputSupported`.

### 3.3 State lease — push only, epoch by construction

```ts
export interface AgentRuntimeStateLease {
  setStatus(status: AgentRuntimeStatus): Promise<void>;
  setSession(session: AgentSessionRef): Promise<void>;
  reportSessionLost(reason: string): Promise<void>;
}

export interface AgentSessionRef {
  /** Runtime-native session identifier. Core stores it, never parses it. */
  readonly id: string;
  /**
   * Opaque Provider-written state needed to locate this session's native
   * history later. Core persists it atomically with `id` and never interprets
   * it. Replaces `transcript_locator` on the Core seam.
   */
  readonly provider_state: string | null;
}
```

`AgentRuntimeCreateContext.state` becomes a **required** `AgentRuntimeStateLease`
(today `AgentRuntimeStateCallbacks` is optional and the parity fixture calls it
with `?.`). The lease *is* the epoch: `AgentRuntimeStateStore`
(`service/agent-entity/runtime-state.ts`) mints one lease object per
`createRuntime` call and records it as the entity's current lease.

- **Ordering** — every lease write goes through the existing serialized
  `mutationTail`, so writes from one runtime apply in call order.
- **Revocation** — the store revokes a lease when (a) `stop()` resolves,
  (b) a new lease is minted for the same entity, or (c) dispatcher shutdown
  fences the entity. A revoked lease resolves its methods without writing and
  logs once at debug level. A late-terminating runtime therefore cannot
  overwrite its replacement — the exact failure the review names.
- **Start fencing** — `TeammateService` awaits `start()`, then awaits
  `lease.drain()` (a new store method that awaits the current `mutationTail`)
  before publishing the runtime as live. Any status/session write issued during
  `start()` is durable before the first `submit()` is admitted, so the restart
  notice and the `continuity` value cannot disagree with persisted state.
- **Sink failure** — a rejected lease write is fatal to the runtime, not
  swallowed: the store logs the failure, marks the entity `degraded`, and the
  owner stops the runtime. Silently continuing would let Core's persisted view
  diverge from the live session, which is precisely what push-only state exists
  to prevent.

`recordLostCheckpoint` becomes `reportSessionLost`; the store keeps its current
behavior (record the loss, set status `degraded`).

### 3.4 Provider facade

```ts
export interface AgentRuntimeProvider<TConfig = unknown> {
  readonly ref: string;
  readonly descriptor: AgentRuntimeProviderDescriptor;
  getCapabilities(): AgentRuntimeCapabilities;   // discovery labels only
  readConfig?(raw: Record<string, unknown>): TConfig;
  onboard?(...): Promise<AgentRuntimeOnboardResult>;
  diagnostic?(...): Promise<AgentRuntimeDiagnosticResult>;
  createRuntime(context: AgentRuntimeCreateContext<TConfig>): AgentRuntime;
  readActivity(
    query: AgentActivityQuery,
    context: AgentActivityContext<TConfig>,
  ): Promise<AgentActivityPage>;
}
```

`AgentRuntimeCapabilities` loses `resume` and `structuredOutput` — both are now
mandatory, so there is nothing to negotiate. What remains is descriptive only
(display label, docs ref); if nothing survives the trim in review,
`getCapabilities` goes too and the descriptor carries the labels. I keep it
because `AgentRuntimeProviderCatalog` already surfaces it to `dreamux doctor`
and onboarding, and removing it is orthogonal churn.

`readTranscript` is replaced, not renamed: its contract (Provider-shaped turns
and blocks, completion-gated, cold-read) fails the clarified `last` user story.

### 3.5 Activity reader

```ts
export interface AgentActivityQuery {
  /** Max records in this page. Core clamps to [1, 200]. */
  readonly limit: number;
  /** Opaque Provider cursor from a previous page; null starts at newest. */
  readonly cursor: string | null;
  /** Caller may omit tool records as a group. Assistant text is never omitted. */
  readonly include_tools: boolean;
}

export interface AgentActivityContext<TConfig = unknown> {
  readonly session: AgentSessionRef;
  readonly config: TConfig;
  readonly cwd: string;
  readonly injectEnv?: Record<string, string>;
  readonly outputBudgetBytes: number;   // Core supplies 262_144, unchanged
  readonly logger?: AgentRuntimeLogger;
}

export type AgentActivityRecord =
  | {
      readonly kind: 'assistant_message';
      readonly at: string | null;          // ISO-8601 or null
      readonly text: string;
      readonly truncated: boolean;
    }
  | {
      readonly kind: 'tool_call';
      readonly at: string | null;
      readonly tool_name: string;
      readonly status: 'started' | 'succeeded' | 'failed' | 'unknown';
    };

export interface AgentActivityPage {
  /** Chronological within the page; the first page is the newest. */
  readonly records: readonly AgentActivityRecord[];
  /** Cursor for the next older page, or null at the beginning of the session. */
  readonly next_cursor: string | null;
  readonly truncated: boolean;
}
```

Content policy is fixed by the operator decision and enforced by the *type*:
there is no field in which a Provider could return tool arguments or tool
output. Assistant text is bounded by Core (`ASSISTANT_TEXT_MAX`, reused from
`conversation-projection.ts`) and by `outputBudgetBytes`; over-budget text sets
`truncated: true`.

**Active-session stability and growing-session cursors.** The reader must return
records already written by the *active* turn — that is the whole point of the
change. Stability rule: a record, once returned under a cursor, is immutable;
new activity only appears at the newest end. This is satisfiable because both
concrete Providers append to a native log. A `tool_call` record may therefore be
returned with `status: 'started'` and be superseded by a *later, distinct*
record when the call ends; Providers do not retroactively mutate the earlier
record. `status: 'unknown'` is the honest value when the native log does not
distinguish an outcome. Paging walks backwards from newest, so a session growing
during pagination cannot shift a page's contents.

Core-side reuse: `service/agent-entity/transcript-reader.ts` becomes
`activity-reader.ts` and keeps its shape — identity-first existence/scope check,
cold read with no materialization and no runtime start, bounds verification
(`verifyTranscriptPage` becomes `verifyActivityPage`), and
`AgentTranscriptReadError` becomes `AgentActivityReadError` with the same reason
union minus the reasons that no longer exist. Provider-native locators stay out
of every projection, as today.

This reader is **not** a replay of the activity sink. `RuntimeActivitySink`
remains an optional transient real-time projection feeding COT; the reader is
stable progress inspection. Neither is a delivery contract for the other, and
Core creates no Turn archive for either.

### 3.6 Structured output — bound once, at create-context

**Decision: session-scoped, bound in `AgentRuntimeCreateContext.outputSchema`,
immutable for the runtime's lifetime. Later submissions cannot change it.**

This is the portable choice and the evidence is decisive: the only consumer is
`service/workflow-service/run.ts`, which already supplies `outputSchema` to
`createLocked` *and* spawns a dedicated TeamMate per structured call, so no
runtime is ever asked to switch schemas mid-session; and
`workflow-service/index.ts::recoverRunningRecords()` marks an interrupted
`running` run `stopped` rather than resuming it, so no recovery path re-binds a
schema either. A Provider whose native mechanism is per-turn (codex,
`structuredOutput.scope: 'per-turn'`) stores the create-context schema and
applies it to every turn — Provider-local, zero Core branching. A Provider whose
mechanism is create-scoped (claude-code, `--json-schema`) is already aligned.

Choosing per-submission instead would force create-scoped Providers to restart a
session to change schema, which is strictly worse and buys a capability nothing
uses.

Conformance: the loader validates that a Provider accepts an `outputSchema` in
its create context; a Provider that cannot honor it must fail `createRuntime`
loudly rather than return unconstrained text.

### 3.7 Loader conformance

`assertRuntimeHandle` narrows from ten members to three: `start`, `submit`,
`stop`. Provider requirements become `ref`, `descriptor`, `createRuntime`,
`readActivity` (mandatory), with `getCapabilities`, `readConfig`, `onboard`,
`diagnostic` optional. The `capabilities.resume.supported` and
`structuredOutput.scope` validations are deleted. A Provider built against the
old contract fails to load with a message naming the missing members and
pointing at the change note — the accepted compatibility consequence.

---

## 4. Channel contract

Types in `packages/dreamux-types/src/channel.ts`. Loader
`packages/dreamux/src/channel/external-channel-provider.ts`.

### 4.1 Session and Core port

```ts
export interface ChannelSession {
  readonly provider: string;
  readonly channel_id: string;
  start(core: ChannelCorePort): Promise<void>;
  close(): Promise<void>;
  handleTool?(call: ChannelToolCall, context: ChannelToolContext): Promise<unknown>;
}

export interface ChannelCorePort {
  invoke<K extends ChannelCommandKind>(
    command: K,
    payload: ChannelCommandInput<K>,
  ): Promise<ChannelCommandResult<K>>;
  subscribe(listener: ChannelCoreEventListener): ChannelEventSubscription;
}

export type ChannelCoreEventListener =
  (event: ChannelCoreEvent) => void | Promise<void>;

export interface ChannelEventSubscription {
  unsubscribe(): void;
}
```

Deleted from `ChannelRoutes` / `ChannelSession`: `deliver`, `targetLifecycle?`,
`coreEvents?`, `ensureCollaborationTarget?`, `deliverExact?`, `resolveTarget`,
`reply?`, `react?`, `messageBelongsToTarget?`. `ChannelRoutes` itself is deleted.
`ChannelSessionCreateContext` (including `state_root` / `cache_root`) is
unchanged and becomes load-bearing for Channel-owned binding state.

`reply` and `react` are already reachable through `handleTool`; the Feishu
package owns its reply/react wire mapping end-to-end (see
`packages/dreamux/CLAUDE.md`). Keeping them as separate seam members duplicated
the tool path for no Core consumer.

`handleTool` keeps `ChannelToolContext.caller: ChannelToolCallerContext`. This
survives *not* for authorization — that moves to the Provider — but because it
has a proven non-authorization consumer:
`feishu-channel/src/feishu-cot-session.ts:83-99` uses `caller.team_name` and
`caller.leader_name` to refresh the COT next-anchor, and the same file's
`setFallbackAnchorIfAbsent` path uses it for the leader fallback anchor.
Removing it would silently change frozen COT display.

### 4.2 Command catalog — exactly two

Both envelopes are versioned and validated at the port, with typed errors and
declared bounds. `protocol: 1` is required and mismatches are rejected with
`UNSUPPORTED_PROTOCOL`.

**`turn.submit`**

```ts
{
  protocol: 1;
  team_name?: string | null;   // null/absent => the dispatcher itself
  source_id: string;           // dedupe key, <= 512 bytes
  correlation?: string | null; // opaque, Core-carried, <= 256 bytes
  turn_source: ChannelTurnSource;
  text: string;                     // <= existing inbound text bound
  attrs?: Record<string, string>;   // <= 32 keys, <= 4 KiB total
  body?: unknown;                   // <= 64 KiB serialized
  attachments?: ChannelAttachment[];// <= 16
}
```

Result: `{ admission: 'submitted' | 'duplicate' | 'stopped' | 'skipped' | 'failed' | 'ambiguous' }`.
Typed errors: `TEAM_NOT_FOUND`, `TEAM_CLOSED`, `INVALID_PAYLOAD`,
`UNSUPPORTED_PROTOCOL`, `PAYLOAD_TOO_LARGE`.

`TEAM_NOT_FOUND` / `TEAM_CLOSED` are the defensive-cleanup path the freeze audit
authorizes: a Channel still holding a binding for a Team that is gone learns so
on its next submission and removes the binding. They are not a synchronization
mechanism, and there is no read Command to enumerate Teams.

Core maps this onto the existing path — `channelRoutes.route(channelId, ...)`
into `TeamService` / dispatcher delivery, normalized by
`asInboundDeliveryResult` — with one change: the Channel now names the Team,
where today Core resolved the Team from its own binding record.

**`team.create`**

```ts
{
  protocol: 1;
  request_id: string;          // <= 128 bytes, [A-Za-z0-9._:-]
  name_prefix: string;
  leader_agent_runtime: string;
  intent: string;
  repo?: { cwd?: string; worktree?: string } | null;
  prompt?: string | null;
}
```

Result: `{ team_name: string; created: boolean }`.
Typed errors: `IDEMPOTENCY_CONFLICT`, `INVALID_PAYLOAD`,
`UNSUPPORTED_PROTOCOL`, `TEAM_CREATE_FAILED`.

Core applies `TEAM_LEADER_REQUIRED_SKILL_SOURCES` itself; `skill_sources` and
`identity` are **not** in the Channel catalog. Channel trust is limited to the
catalog, and injecting arbitrary skill sources or identity prompts is a
host-maintenance capability, not a Channel one.

`team.dissolve` is deliberately **absent** from the initial catalog. The
requirement says a provisioning Channel composes "ordinary idempotent
`team.create`, turn submission, and optional `team.dissolve`". Since unbound
Teams are explicitly normal and need no orphan policy, no current Channel
behavior requires dissolve; adding it now would be speculative catalog growth.
The `invoke` port is the extension point — adding `team.dissolve` later is a
catalog entry, not a seam change. I flag this as the one place a cross-reviewer
may reasonably disagree; the cost of being wrong is one additive entry.

### 4.3 Event catalog — exactly six

```
team.state | agent.state | turn.submitted | turn.settled | turn.message | turn.tool_call
```

Deleted: `binding.route`, `binding.collaboration_space`, and with them
`packages/dreamux-types/src/channel-binding.ts`
(`ChannelBindingEndpointSnapshot`, `ChannelBindingRouteEvent`,
`ChannelBindingCollaborationSpaceEvent`).

On the four turn events, `ChannelOrigin` (`provider`, `channel_id`,
`message_id`, `target`, `binding`) is replaced by
`correlation: string | null` — the value the Channel passed to `turn.submit`,
carried through unchanged and never parsed. `turn_source: ChannelTurnSource`
becomes **required**.

No Workflow or scheduler events are added; both remain internal Agent/MCP
capabilities.

Payload bounds are unchanged from the frozen projection
(`ASSISTANT_TEXT_MAX = 160_000`, `CONVERSATION_MESSAGE_MAX = 100_000`,
`CONVERSATION_TOOL_ARGUMENTS_MAX = 60_000`,
`CONVERSATION_TOOL_RESULT_MAX = 120_000`,
`CONVERSATION_ACTIVITY_FACTS_MAX = 512`), as is the redaction set.

---

## 5. Channel-owned routing and provisioning

### 5.1 Binding state

The Feishu package gains `feishu-binding-store.ts`, persisting
`<state_root>/bindings.json`, where `state_root` is the existing
`ChannelSessionCreateContext.state_root` (host-derived from `dispatcherDir(id)`).
Per the repo path contract, the *host* path builder stays in
`platform/paths.ts` (unchanged — `state_root` already exists) and the
Provider-owned derivation of the filename lives in the Provider package.

Record shape (Provider-private, never in `dreamux-types`):

```jsonc
{
  "version": 1,
  "bindings": [
    {
      "binding_id": "...",
      "team_name": "...",      // null => dispatcher-owned
      "chat_id": "...",
      "topic_id": "...",       // Feishu-specific; Core never sees it
      "created_at": "...",
      "provisioned": true       // created by the auto-provisioning saga
    }
  ]
}
```

**Single writer / concurrency.** Channel and Core are same-process and
lifecycle-coupled (README: "Blockers: None"). One `FeishuBindingStore` instance
per `ChannelSession` is the single writer; all mutations serialize on an
in-process promise tail (the same pattern as
`AgentRuntimeStateStore.mutationTail`), and each write is an atomic replace. No
cross-process locking is needed and none is added. Reads are served from the
in-memory projection loaded at `start()`.

**Egress authorization** moves here: `handleTool` for a `team_leader` caller
checks the caller's `team_name` against the store before allowing a reply/react
to a chat, replacing `ChannelService.authorizeTeamLeaderEgress` and
`ownerCanUseTarget`. The guarantee is preserved; the owner moves.

**Binding invalidation.** The Feishu session subscribes to `team.state` and, on
a Team reaching a dissolved state, removes every binding for that Team from its
own store. This is why `team.state` is in the event catalog at all. A dissolve
missed across a restart is covered by the defensive `TEAM_NOT_FOUND` /
`TEAM_CLOSED` result on the next `turn.submit` for that Team, which triggers the
same removal — no replay and no reconciliation protocol.

**COT fallback anchor.** `binding.route` events currently feed
`setFallbackAnchorIfAbsent`. After the change, the Feishu session derives the
same anchor from its own binding store at `start()` and on each binding
mutation, and calls the same adapter method. COT display is unchanged; only the
source of the fact moves — which is exactly the review obligation.

### 5.2 Provisioning saga

`CollaborationSpaceService`, `collaboration-space/route-reconciliation.ts`,
`collaboration-space/target-close-lifecycle.ts`, `collaboration-space-mcp.ts`,
the four `collaboration_space.*` admin methods, and
`collaboration-spaces.json` are all deleted. Team is the only Core container.

Feishu's saga, in its own state, composes the two Commands:

1. Inbound message on an unbound target.
2. Persist `{ target, request_id, phase: 'creating' }` (crash point A).
3. `invoke('team.create', { request_id, ... })` — idempotent, so a retry after a
   crash returns the same `team_name`.
4. Persist the binding and `phase: 'ready'` (crash point B).
5. Only then `invoke('turn.submit', { team_name, correlation, ... })` — the
   ready-before-first-delivery sequence, now Provider-owned.

Recovery at `start()`: a `creating` record replays step 3 with the same
`request_id`; a `ready` record needs nothing. Because `team.create` idempotency
is restart-durable in Core, the saga needs no distributed protocol — only a
durable request id and a retry.

Provisioning *policy* (which chats auto-provision, name prefix, leader runtime,
repo template) moves from Core `dispatchers[].collaboration_space` config to the
Channel's own provider config block. This is an explicit breaking configuration
change.

### 5.3 Core `team.create` idempotency ledger

New host-owned path builder in `platform/paths.ts`:
`dispatcherTeamCreateLedgerPath(id)` giving
`<dispatcherDir>/team-create-ledger.json`. Owner: a small
`service/team-create-ledger.ts` used only by the Channel command handler, writing
through the dispatcher admission gate
(`dispatcher-service/inbound-task-drain.ts`) so nothing lands after shutdown
begins.

Key: `channel_id` plus `request_id`. Entry:
`{ key, input_hash, team_name, phase: 'pending' | 'committed', created_at }`,
where `input_hash` is a SHA-256 over the canonicalized payload minus
`request_id`.

Restart-durable protocol:

1. Look up the key. `committed` with a matching `input_hash` returns
   `{ team_name, created: false }`. `committed` with a different hash returns
   `IDEMPOTENCY_CONFLICT` and mutates nothing.
2. `pending` with a matching hash is recovery: if the recorded `team_name`
   resolves to an open Team, commit and return it; otherwise re-create under the
   *same reserved name* and commit.
3. No entry: allocate the Team name first, write `pending` durably, create the
   Team, then commit. A crash between the write and the create lands in case 2.

The reserve-name-first ordering is what makes "returns the same `team_name` for
the same accepted request identity" survive a crash *before* the Team exists.

Bounding/GC: at most 1000 entries and at most 30 days, evicted oldest-first at
write time; entries whose Team no longer exists are also evicted, since a later
retry should legitimately provision a new Team.

---

## 6. Turn correlation and COT

### 6.1 Flow

`correlation` is chosen by the Channel at `turn.submit`, stored by Core on the
Turn's origin, and echoed unchanged on `turn.submitted`, `turn.message`,
`turn.tool_call`, and `turn.settled`. Core validates only its bounds (non-empty
string of at most 256 bytes, or null) and never parses it.

`AgentEntityTurnOrigin` (`service/agent-entity/types.ts`) changes its channel arm
from `{ kind: 'channel'; channel_origin: ChannelOrigin | null }` to
`{ kind: 'channel'; correlation: string | null }`. `ChannelOrigin` is deleted
from `dreamux-types`.

`conversation-projection.ts::channelOriginOf(turn)` becomes
`correlationOf(turn)`; everything else in that file — the bounds, the redaction
regexes, `projectSubmitted` / `projectActivity` / `projectSettled`, and
`eventScope` — is untouched. This is the frozen baseline and the change must not
move it.

### 6.2 Why the opaque value alone is not enough

`feishu-cot-adapter.ts::onTurnSubmitted` derives its `VisibleMessageAnchor` from
`event.channel_origin`, and when the origin is `undefined` it continues only for
`turn_source === 'completion' || turn_source === 'scheduled'`, reusing the
leader's existing anchor. Completion-delivered and scheduled turns have no
Channel origin by construction and will have no `correlation` either. If
`turn_source` were dropped in favor of "one opaque correlation", those turns
would be indistinguishable from unattributable turns and the COT card would stop
updating for exactly the long-running cases COT exists to show.

**Therefore `turn_source` is retained and becomes required on all four turn
events.** This is a substantive finding, not bookkeeping: the natural reading of
"replace `ChannelOrigin` with an opaque correlation" breaks frozen COT.

### 6.3 Bounded asynchronous observer isolation

`DispatcherCoreEventBus` keeps its lease/revocation model. The scoped source
(`dispatcher-core-events/scoped-source.ts`) changes from synchronous per-kind
dispatch to a per-subscription bounded queue:

- **Ordering** — one FIFO per subscription, drained serially, one event at a
  time. `turn.submitted` therefore always precedes that turn's messages, which
  the COT anchor logic depends on.
- **Capacity** — 512 events per subscription.
- **Drop policy** — on overflow, drop the oldest *display-detail* event
  (`turn.message` / `turn.tool_call`) still queued and enqueue the new one; if
  the queue holds only lifecycle events (`team.state`, `agent.state`,
  `turn.submitted`, `turn.settled`), drop the incoming display-detail event
  instead. **Lifecycle events are never dropped.** Rationale: lifecycle events
  are bounded by real operations and carry anchor creation and settlement;
  display detail is already lossy by contract ("live, best-effort,
  non-retained, non-replayed, fail-open"). Dropped counts are logged once per
  10-second window per subscription.
- **Time isolation** — each listener invocation is awaited with a 2-second
  bound; on timeout the event is abandoned and the queue continues. A slow
  Channel can no longer stall Core publication, which today it can.
- **Failure isolation** — unchanged fail-open `try`/`catch` around each listener.
- **Revocation** — `unsubscribe()` or lease revocation discards the queue
  without draining.

The publisher-side `hasSources()` fast path is unchanged.

---

## 7. Dissolve and scheduler after `waitIdle`

### 7.1 Deletions

- `team-collection/dissolve-controller.ts` — `requireIdleCapability(writers)`
  and the `TeamDissolveFailedError` it throws for a missing capability.
- `team-collection/dissolve-runner.ts` — `operation.writers.map(w => w.waitIdle!())`.
- `scheduler/service.ts` — `heldFires`, `heldFireControllers`, and the
  `writer.waitIdle()` wait.
- The captured-writer surface loses `waitIdle`, keeping only `name` and `stop`.
- `.agents/decisions/agent-activity-capability.md` is superseded by a new
  decision record; the old one is marked superseded rather than deleted.

### 7.2 Dissolve phases

```ts
export type TeamDissolvePhase =
  | 'stopping_children'
  | 'closing_resources'
  | 'blocked_worktree'
  | 'worktree_cleanup_pending'
  | 'complete'
  | 'failed';
```

`waiting_for_team_idle` is removed. `TeamDissolvePublicError` gains no member;
`worktree-dirty` / `worktree-unmerged` / `worktree-unique-commits` now also
describe the blocked phase.

**Dispatcher-triggered dissolve.** Availability fence closes, `assessCleanup`
preflight runs; if `blocked` and not `force`, reject with the typed public error
and leave the Team fully intact. Otherwise persist `stopping_children`, stop
Workflow, members, and leader immediately with no idle wait; re-assess after all
children have exited; if now `blocked` and not `force`, enter
`blocked_worktree`; otherwise `closing_resources`, `logicalClosed`,
`worktree_cleanup_pending`, background physical deletion, `complete`.

**TeamLeader self-dissolve.** Same machine, entered after stopping Workflow and
members, with the leader stopped without waiting for the caller turn. The
leader's own MCP response is expected to be lost; that failure is fail-open and
does not affect the durably accepted dissolve.

**`blocked_worktree` is durable and recoverable.** It is the partial state the
review asks for: children stopped, worktree dirty, Team not closed. The read
model reports `status: 'dissolving'` with `cleanup: { state: 'blocked', reason }`.
The availability fence stays closed, so no turns, mutations, or route changes are
admitted. Restart recovery (`recoverTeamDissolves`) re-enters `blocked_worktree`;
it never auto-progresses and never auto-forces. Two exits: the operator cleans or
commits the worktree and re-issues `team.dissolve` (which re-assesses and
proceeds), or re-issues with `force: true`.

**Post-stop cleanliness recheck** is preserved exactly, so only explicit `force`
can discard changes created *after* preflight. `force` authorizes discarding
local changes in the Team-owned managed worktree only — never a `reuse-cwd` or
source workspace, never committed history. `WorktreeManager.cleanup` reassesses
immediately before mutation, unchanged.

The command returns after children exit and logical close is durably accepted;
physical deletion runs in the background as observable
`worktree_cleanup_pending` state.

### 7.3 Scheduler

Every due fire submits immediately through ordinary admission. The admission
status is recorded on the fire result; `duplicate`, `stopped`, and `skipped` are
logged and not retried. Provider-native folding into an active turn is accepted.
The one-hour idle wait, the busy-only deferral, and the independent queued-turn
guarantee are gone, and the change notes must say so — an operator relying on
"the cron fire waits for the agent" gets different behavior.

---

## 8. Persistence and cutover

0.x policy: fail loud, no migration.

| State | Change | Operator action |
|---|---|---|
| `<dispatcherDir>/channel-bindings.json` | deleted from Core | `dreamux serve` aborts naming the path; delete it and re-bind through the Channel's `bind_channel` tool |
| `<dispatcherDir>/collaboration-spaces.json` | deleted from Core | abort and delete |
| `dispatchers[].collaboration_space` config | deleted | remove the block; move provisioning policy to the Feishu provider config |
| `<dispatcherDir>/team-create-ledger.json` | **new** | none; created on demand |
| `team/<t>/record.json` dissolve phase | `waiting_for_team_idle` removed | an in-flight dissolve in that phase is rejected at recovery, naming the Team |
| `identity.json` `session_id` | unchanged | none |
| `identity.json` `transcript_locator` | **retained as the persisted key**, remapped to the neutral `AgentSessionRef.provider_state` | none |

`service/legacy-state.ts` gains `channel-bindings.json` and
`collaboration-spaces.json` at the dispatcher root as detected legacy leaves,
following the existing `detectLegacyDispatcherState` pattern (probe only, never
read, never rewritten, never removed by Dreamux). `dreamux serve` aborts;
`dreamux doctor` diagnoses and names the exact paths. This reuses the mechanism
`legacy-state-fail-loud.test.ts` already covers.

**The `transcript_locator` decision, stated explicitly because it is a real
trade-off.** Renaming the persisted key to `session_state` would be cleaner, but
it would force `assertNoRemovedRecordFields` to reject every existing
`identity.json` that carries a locator, destroying session continuity for every
TeamMate in every dispatcher. The value semantics are identical before and
after: same writer (the Provider), same reader (the Provider's activity reader),
Core-opaque in both. I take the smaller blast radius, document the field in the
maintenance reference as "opaque Provider session state; Core never interprets
it", and record the rename as a follow-up in `.agents/` per the cleanup-trail
rule. This change already imposes two mandatory rebuilds; a third that buys only
a field name is not worth it. A reviewer who disagrees should say so — it is a
one-line store mapping either way.

**Maintenance skill synchronization** (mandatory, same change):
`/packages/dreamux/skills/dispatcher/dreamux-maintenance/` — remove the
Collaboration Space reference and the Core channel-binding reference, add the
`team-create-ledger.json` reference naming it fully server-owned and prohibiting
direct editing, update the agent-identity reference for `provider_state`
semantics, and keep `SKILL.md` routing accurate.

---

## 9. Lifecycle and concurrency

### 9.1 Startup ordering

`dispatcher-service/input-source-lifecycle.ts::doStart()` currently assembles
`ChannelRoutes` inline and starts sessions after
`collaborationSpaces.resumePendingTargets()`. After the change:

1. `recoverTeamDissolves()` (now able to land in `blocked_worktree`)
2. `workflows.recover()`
3. `prepareChannels()`
4. `workflows.start()`
5. optional dispatcher agent start plus restart notice, using
   `AgentRuntimeStartOutcome.continuity`
6. **for each prepared session: mint the event lease, build the `ChannelCorePort`
   bound to that lease, then `await session.start(port)`** — the lease exists
   before `start` is called, so a `subscribe` issued synchronously inside
   `start` observes every event published afterwards
7. `scheduler.start()` / `teams.startSchedulers()`
8. `started = true`

`collaborationSpaces.resumePendingTargets()` disappears from Core; the Channel's
own saga recovery runs inside its `start()` at step 6, which is after Team
recovery and before any admission — the correct order, and one fewer Core step.

Because the port is handed to the Channel at `start()` and Core admits Commands
only from a live port, "consumers attached before operations are admitted" holds
by construction. Anything the Channel misses across a restart is covered by the
defensive `TEAM_NOT_FOUND` / `TEAM_CLOSED` results, not by replay.

Failed start rolls back exactly as today (`workflows.closeAdmission()`,
`channelRoutes.revokeSessionLeases()` becoming `revokeEventLeases()`,
`admittedTasks.closeAdmission()`, `rollbackFailedInputSourceStart`).

### 9.2 Shutdown ordering

1. Process admission closes (`Server.admitAdminRequest`); dispatcher fences
   publish synchronously — unchanged.
2. `ChannelCorePort.invoke` starts rejecting new Commands (`SHUTTING_DOWN`);
   accepted Commands drain.
3. `session.close()`.
4. Runtimes stop; each `stop()` fences new submissions synchronously and
   converges admissions already begun — unchanged.
5. State leases revoked after the corresponding `stop()` resolves.
6. Event leases revoked last, after work is fenced, so settlement events emitted
   during convergence still reach the Channel.

Revoking event leases before step 4 would drop `turn.settled` for turns
converging during shutdown and leave COT cards stuck "in progress"; revoking
after is the ordering the freeze audit requires.

### 9.3 Preserved concurrency invariants

Explicitly retained, unchanged: start/stop single-flight per runtime;
synchronous submit fencing inside `stop()`; late-start termination (a runtime
that finishes starting after close is stopped — `runtime-owner.stopForClose`'s
double-stop); failed-start rollback; the `EntityTurnCoordinator` retention
guarantee that `stop` never returns with unsettled submissions;
`EARLY_ACTIVITY_EVENTS_MAX = 512` early-activity buffering; immutable completion
identity and exactly-once settlement in `CompletionDeliveryPolicy`;
per-recipient FIFO delivery; `submitObserved` mapping a thrown boundary error to
`ambiguous` with no automatic retry.

---

## 10. Change inventory

**New (4 Core capabilities)**
`AgentActivityQuery` / `Context` / `Record` / `Page` plus Provider
`readActivity`; `AgentRuntimeStateLease` plus `AgentSessionRef`;
`ChannelCorePort` plus the Command/event envelopes; `TeamCreateLedger` plus
`dispatcherTeamCreateLedgerPath`. Provider-side: `feishu-binding-store.ts`, the
provisioning saga, and `bind_channel` / `unbind_channel` / `list_bindings` in the
Feishu static tool catalog.

**Deleted (11)**
Handle pull surface (`getStatus`, `getCheckpoint`, `wasCheckpointResumed`,
`getContext`, handle `getCapabilities`, `providerRef`); the `resume` verb;
`waitIdle` and its two consumers; `readTranscript`; capability negotiation
(`resume`, `structuredOutput`, `UnsupportedAgentRuntimeFeatureError`,
`assertStructuredOutputSupported`); `ChannelRoutes` and its five members plus
`resolveTarget` / `reply` / `react` / `messageBelongsToTarget`;
`packages/dreamux-types/src/channel-binding.ts` and the two `binding.*` events;
`ChannelOrigin`; Core `ChannelBindingStore` and the binding half of
`ChannelService`; the Core Collaboration Space domain (service, route
reconciliation, target-close lifecycle, MCP adapter, four admin methods, config
block, state file); Team MCP `bind_channel` / `transfer_back` and their two admin
methods, with no alias.

**Reshaped**
`transcript-reader.ts` becomes `activity-reader.ts`; `runtime-state.ts` gains
lease/epoch/drain; `scoped-source.ts` gains the bounded queue;
`conversation-projection.ts` swaps origin for correlation and nothing else;
`dissolve-controller.ts` / `dissolve-runner.ts` swap the idle wait for immediate
stop plus `blocked_worktree`; `runtime-owner.startFromRecord` drops the resume
branch; `teammate-mcp.ts` `last` narrows to Activity Records with
`include_tools` and `cursor`.

**Change files** (Rush; never hand-edit changelogs)
`@excitedjs/dreamux` — `minor`, leading `BREAKING:`, with `Rebuild:` lines for
the binding store, the Collaboration Space state and config, and the dissolve
phase, plus `Review:` guidance for the changed scheduler missed-fire behavior and
the narrowed `last` content.
`@excitedjs/dreamux-types`, `@excitedjs/agent-runtime-codex`,
`@excitedjs/agent-runtime-claude-code` — `minor` with leading `BREAKING:` (0.x
line; CI forbids `major`).
`@excitedjs/feishu-channel` — real semver **`major`**; this package is past 1.0.

**Knowledge delta**: `.agents/reference/current-architecture.md`,
`channel-runtime.md`, `state-and-paths.md`; a new decision record superseding
`.agents/decisions/agent-activity-capability.md`; then `.agents/scripts/check.sh`.

---

## 11. Verification mapping

| Obligation | Gate |
|---|---|
| Minimal handle loads | `external-runtime-parity.test.ts` plus the fixture rewritten to three verbs, mandatory continuity, and `readActivity` |
| Continuity mandatory, no Core branch | new: a provider whose `identity.session` is non-null must yield `continuity: 'resumed'`; Core asserts no read of a resume capability |
| Start fencing | new: a session write issued inside `start()` is durable before the first `submit` is admitted |
| State lease epoch/revocation | new: a lease revoked by a replacement cannot write; a revoked lease resolves without writing |
| Sink failure | new: a rejected lease write yields `degraded` plus a stopped runtime |
| Activity Record content policy | new `activity-reader.test.ts`: no field can carry tool args/results; `include_tools: false` omits tool records; assistant text is never omitted |
| Active-session stability plus cursors | new: records returned during an open turn are byte-stable across pages while the session grows |
| Schema bound once | new: the create-context schema applies to every submission; the per-submission field no longer exists |
| Submission union distinctness | extend `agent-runtime-provider.test.ts`: `kind: 'channel'` carries passthrough, `kind: 'text'` cannot |
| Admission invariants | existing coordinator/settlement tests unchanged and must stay green |
| Command catalog plus validation | new `channel-core-port.test.ts`: exactly two Commands, protocol/bounds validation, typed `TEAM_NOT_FOUND` / `TEAM_CLOSED` / `IDEMPOTENCY_CONFLICT` |
| `team.create` restart durability | new: the same `request_id` after a simulated crash between reserve and create returns the same `team_name`; a conflicting hash rejects without mutating; GC bounds hold |
| Correlation passthrough | new: an arbitrary opaque value survives unchanged on all four turn events |
| `turn_source` required | extend `conversation-projection.test.ts` and the COT adapter tests: completion/scheduled turns with a null correlation still resolve the leader anchor |
| Frozen COT preserved | `conversation-projection.test.ts` **must pass with assertion changes limited to the origin-to-correlation substitution** — any other edit to that file's assertions is a red flag |
| Observer isolation | extend `dispatcher-core-events.test.ts`: per-subscription FIFO order; overflow drops display detail only; a hung listener does not stall publication; revocation discards |
| Attach/revoke ordering | new: `subscribe` inside `start()` sees the first post-start event; event leases outlive runtime stop through settlement |
| Dissolve immediate stop | `team-dissolve-quiescence.test.ts` rewritten to assert *no* idle wait — authorized by the operator decision recorded in `review-findings.md`, "Dissolve and scheduler behavior after removing provider idle"; the rewrite must be reviewed against that decision, not against a green run |
| Post-stop recheck | `team-dissolve-acceptance.test.ts`: changes created after preflight block a non-forced dissolve |
| `blocked_worktree` recovery | new: restart re-enters the phase; both `force` and clean-then-retry exit it; the fence stays closed throughout |
| Scheduler immediate fire | `scheduler.test.ts` / `team-scheduler.test.ts` lose held-fire assertions and gain immediate-submission assertions |
| Cutover fail-loud | `legacy-state-fail-loud.test.ts` gains the two new leaves; `dreamux doctor` names them |
| MCP surface | `mcp-contract-whitelist.test.ts`, `team-mcp.test.ts` (tools gone, no alias), `teammate-mcp.test.ts` (narrowed `last`) |
| Egress authorization moved | new Feishu-package test: a `team_leader` caller cannot reply into a chat its Team is not bound to |
| Layering | `architecture-boundary-gate.test.ts` / `architecture-ownership-gate.test.ts` extended to forbid any Core reference to binding, collaboration space, or `waitIdle` |
| Non-blocking inbound (issue #63) | the existing live gate must stay green, untouched |

Deleted suites: the four `collaboration-space-*.test.ts`,
`channel-binding-store.test.ts`, `channel-service-feishu-topic-auth.test.ts`, and
the binding half of `channel-service.test.ts` — with equivalent coverage
re-established in the Feishu package, not dropped.

Full gate: `node common/scripts/install-run-rush.js build`, then
`node common/scripts/install-run-rush.js test`, plus `.agents/scripts/check.sh`.

---

## 12. Risks

1. **Frozen COT regression.** The highest risk in the change. Mitigated by
   touching `conversation-projection.ts` only for the origin-to-correlation
   substitution, keeping `turn_source`, and treating any other assertion edit in
   that suite as a review stop.
2. **The binding rebuild cost is real.** Every operator loses their bindings and
   must re-bind. There is no migration and 0.x policy forbids one. This must be
   the lead line of the change note, not a footnote.
3. **Activity-reader stability is a Provider promise Core cannot enforce.** A
   Provider that rewrites native history retroactively will produce shifting
   pages. Mitigated by conformance tests in the parity fixture and by an
   explicit contract sentence; not by defensive Core caching, which would
   recreate the Turn archive the operator rejected.
4. **Scheduler behavior change is user-visible.** Fires now fold into active
   turns. This is an accepted operator decision, but it needs a `Review:` note.
5. **`blocked_worktree` can strand a Team.** Children are stopped, the Team is
   unusable, and only operator action clears it. This is the honest consequence
   of "never discard changes without `force`"; the read model must surface the
   reason clearly enough to act on.
6. **The two-Command catalog may prove too small.** If a Channel later needs
   `team.dissolve`, it is an additive catalog entry behind the existing
   `invoke` — cheap to add, and cheaper than shipping speculative surface now.
7. **Bounded async delivery changes timing.** Events now arrive on a later tick.
   Any Channel code that assumed synchronous delivery during a Core call would
   break; the Feishu adapter is already `guard`-wrapped and best-effort, so this
   is expected to be inert, but the COT suite is the check.

---

## 13. Rejected alternatives

**Keep `waitIdle` under a different name (for example `getBusy`), or re-derive
idle in Core from submission bookkeeping.** Rejected: the operator explicitly
removed the behavior, and re-deriving it in Core would be exactly the "state
re-derived in core that a lower layer already owns" anti-pattern CLAUDE.md
forbids. The correct answer is that dissolve stops work and the scheduler
submits.

**A required `onMessage(event, payload)` member on `ChannelSession` instead of
`subscribe` on the port.** This is the literal reading of the requirement's
"generic `invoke` and `onMessage` ports", so it deserves a real defense. I reject
it because a Channel that consumes no events would have to ship a no-op stub
member — dead surface the minimality constraint exists to prevent — and because
Core needs a *revocable* handle for the shutdown ordering in 9.2, which a plain
method does not give it. `subscribe` is still exactly one event-delivery
primitive; the listener *is* `onMessage`, with a lease attached. If a reviewer
insists on the member form, the fix is mechanical (`onMessage?` plus a Core-side
revocation flag), but it loses the guarantee that revocation is observable to the
Channel.

**A per-submission structured-output schema.** Rejected on evidence: no consumer
needs it (3.6), and it would force create-scoped Providers to restart sessions to
change schema.

**Renaming the persisted `transcript_locator` key.** Rejected on blast radius
(section 8), with the cleanup recorded rather than silently dropped.

**Migrating Core binding state into Channel-owned state at startup.** Rejected:
0.x has no schema migration (issue #98), and a one-shot importer is exactly the
compatibility machinery the requirement's no-adapter policy removes. Fail-loud
plus a named rebuild is the house rule.

**Keeping a thin Core binding *cache* so COT anchors survive without Channel
state.** Rejected: it recreates dual ownership of the fact this change exists to
consolidate. The Channel already has the state; it should read its own.

**Adding `team.dissolve`, `team.status`, or a Team read Command to the catalog
now.** Rejected: the freeze audit explicitly removed the startup Team read and
added no read Command, and the operator fixed the initial catalog at two
Commands. Extensibility lives in `invoke`, not in speculative entries.

**Synchronous event delivery with a Core-side timeout only.** Rejected: it
cannot preserve per-subscription ordering under a slow consumer without
buffering, and buffering is the queue. Since the queue is required anyway, the
synchronous path adds nothing.

**A general Core-to-Channel query port.** Rejected by the requirement and by the
freeze audit's correction: Channel and Core are same-process and
lifecycle-coupled, the Channel maintains its own authoritative local state, and a
query port would reintroduce the remote-service model the operator rejected.

---

# Cross-Review Round — Claude seat

Read in full: `codex.md` (1124 lines), `trae-seed-2-1.md` (1161 lines), and my own
round-1 sections 1–13 above. Sections 1–13 are unchanged; this section records
what I accept, what I reject, and my revised position. Adjudication is by
requirement text and current source, not by how many seats agreed.

## CR.1 Where all three converge

All three proposals independently reach the same core shape, which I treat as
settled rather than re-argued: a three-verb live handle (`start` / `submit` /
`stop`); `start` returning a neutral fresh-vs-resumed outcome consumed before the
first admission; a discriminated submission union preserving the
channel-rendered vs Core-text distinction; deletion of `providerRef` semantics
from Core branching, `resume`, `channelInput` / `completionInput`, `waitIdle`,
`getStatus` / `getCheckpoint` / `wasCheckpointResumed`, `getContext`, and
handle-level `getCapabilities`; a leased push-only state sink whose generation
prevents a zombie runtime from overwriting its replacement; `readTranscript`
replaced by a mandatory record-oriented activity reader that returns assistant
messages plus tool name/status and never tool arguments or results; deletion of
`ChannelRoutes` and of `resolveTarget` / `reply` / `react` /
`messageBelongsToTarget`; a two-Command catalog (`turn.submit`, idempotent
`team.create`) with no `team.dissolve`; a six-kind event catalog with
`binding.route` / `binding.collaboration_space` deleted; opaque Channel
correlation carried on the turn events; complete deletion of Core Collaboration
Space and the Core binding store; Channel-owned `bind_channel` /
`unbind_channel` / `list_bindings` with no `transfer_back` alias; deletion of
`authorizeTeamLeaderEgress` with caller context retained only for COT/audit;
immediate dissolve with `force`, a post-stop cleanliness recheck, a recoverable
blocked state, and background physical cleanup; and a scheduler that submits
every due fire immediately with no held-fire deferral and no retry after
`ambiguous`.

Convergence on that much is not evidence it is right, but it does mean the
remaining disagreements are the whole decision surface.

## CR.2 Accepted arguments (my position changes)

**A1 — Remove `outputBudgetBytes` from the activity read context (Codex).**
Codex's read context deliberately contains "no native locator, scan mode, or
caller-selected byte budget". I had `outputBudgetBytes: number` in
`AgentActivityContext` (§3.5); Trae went further the wrong way and pinned the
literal type `262144`. The requirement is explicit at `requirement.md:422-425`:
"Names such as `transcript_locator`, **literal host output budgets**, native
scan modes, and provider filesystem assumptions are removed from the Provider
seam." My round-1 context violated that clause. **Change:** the Provider owns
its own read bound and sets `truncated`; Core revalidates the returned page
against Core-owned bounds in `activity-reader.ts`. This is a straight
correction, not a preference.

**A2 — A `team.create` ledger must never evict an identity that can still be
retried (Codex and Trae, independently).** My round-1 §5.3 said "at most 1000
entries and at most 30 days, evicted oldest-first ... entries whose Team no
longer exists are also evicted, since a later retry should legitimately
provision a new Team." That is wrong against the round-2 invariant the
TeamLeader wrote directly: "Team-create idempotency survives Core restart and
returns the same `team_name` for the same accepted request identity." Evicting a
live identity lets one `request_id` create two Teams. Codex states the reason
exactly — "eviction could create a second Team on a late retry". **Change:**
retain every entry whose Team is open, indefinitely; evict only entries whose
Team is *durably closed* and older than a retention window (Trae's rule). This
bounds the ledger by live Team count, which is already operationally bounded.

**A3 — A closed Team returns its historical name instead of being silently
re-created (Codex).** Codex's `status: 'closed'` result returns the same
historical `team_name` without recreating, and requires a new `request_id` for a
new provisioning generation. That is strictly better than my round-1 behavior
(no entry → create), and it composes with A2: the ledger keeps the name, the
Channel learns the Team is gone, and the next generation is explicit rather than
accidental. **Change:** adopt a three-way result `created | existing | closed`.

**A4 — A revoked state lease must reject, not resolve silently (Codex, and
Trae's `{accepted:false}` return reaches the same goal).** My round-1 §3.3 had a
revoked lease "resolve its methods without writing and log once at debug level".
That leaves a zombie runtime pushing forever with no signal. **Change:** a
revoked lease rejects with a distinct `AgentRuntimeStateLeaseRevokedError`,
which the Provider must treat as "stop pushing and terminate", explicitly
*distinct* from a persistence failure (which stays fatal per §3.3). Two
outcomes, two meanings. I prefer rejection over Trae's `{accepted:boolean}`
return because a boolean is ignorable and a rejection is not.

**A5 — Drop `lease.drain()`; put the fence in the sink contract (Codex).**
Codex: "Before `start` resolves, the Provider must have durably published its
session id and `ready` status", with `publish` acknowledging "only after durable
persistence". That is cleaner than my Core-side `drain()` helper: if `publish`
resolves only after the identity write lands, a Provider that awaits its own
publishes before resolving `start()` gives Core the start-completion fence for
free, with no extra Core method. **Change:** `publish` resolves after durable
persistence; the Provider must have awaited its session and `ready` publishes
before resolving `start()`; `drain()` is deleted from my design.

**A6 — The blocked post-stop state must reopen ordinary Team admission
(Codex).** My round-1 §7.2 said of `blocked_worktree`: "The availability fence
stays closed, so no turns, mutations, or route changes are admitted." Codex's
self-dissolve path instead "enters `blocked_after_stop`, reopens ordinary Team
admission, and returns `TEAM_DISSOLVE_BLOCKED`; children stay stopped and may be
lazily reopened by later ordinary operations." Codex is right and my round-1 risk
6 understated the problem: with the fence closed, the TeamLeader — the one agent
that can inspect, commit, or clean the dirty worktree — is unreachable, so the
only exit is `force` (which discards the very work that blocked the dissolve) or
manual filesystem surgery. Reopening is also consistent with the existing
"send reopens a closed teammate" semantics recorded in
`packages/dreamux/src/service/CLAUDE.md`. **Change:** `blocked_worktree` is
durable, recoverable, and *admission-open*; the Team is usable again and a later
clean-then-retry or `force` dissolve starts a new operation. I keep my phase name
and keep restart recovery re-entering the phase without auto-forcing.

**A7 — `teammate.get_capabilities` currently projects `resume`, and that
projection must be deleted (Codex).** I did not name this consumer in round 1.
Verified: `packages/dreamux/src/service/agent-entity/agent-config.ts:64` returns
`resume: capabilities?.resume ?? { supported: false }` into
`AgentEntityRuntimeCapability`, surfaced by `teammate.get_capabilities`
(`mcp/teammate-mcp.ts:193`, `admin/methods.ts:281`). **Change:** add the removal
of the `resume` field from `AgentEntityRuntimeCapability` and its MCP projection
to my §10 deletion inventory and to the `teammate-mcp.test.ts` row of §11.

**A8 — `turn.submit` should return the Core `turn_id` (Codex and Trae).** Both
return it; I returned only the admission status. Trae's reason is the good one:
"this lets a Channel bind the submitted event to its invoke() call even when the
event is delivered asynchronously" — which matters precisely because I am making
event delivery asynchronous in §6.3. It does not replace `correlation` (a
completion or scheduled turn has a `turn_id` but no Channel correlation); it
removes one race for the Channel-originated case. **Change:** the `submitted`
result carries `turn_id`.

**A9 (partial) — the three binding tools are Dispatcher-audience (Codex).**
Codex declares `bind_channel` / `unbind_channel` / `list_bindings` as
"Dispatcher only" via an `audience` field on the tool descriptor. I accept the
*policy* — binding mutation is not a TeamLeader capability — but not the seam
change: `ChannelToolDescriptor` (`packages/dreamux-types/src/channel.ts:98-124`)
has `name`, `title`, `icons`, `description`, `inputSchema`, `outputSchema`,
`annotations` and no audience/visibility member today, and adding one widens the
seam this task is narrowing. Since `ChannelToolContext.caller` survives anyway
(§4.1), the Provider enforces `caller.kind === 'dispatcher'` inside `handleTool`.
**Change:** state the Dispatcher-only rule for the three tools in §5.1 and add
its test to §11.

## CR.3 Rejected arguments, with evidence

**R1 — Trae §3.3/§3.4: per-submission structured-output binding, with
`outputSchema` removed from the create context.** Rejected on direct source
evidence. `packages/agent-runtime/claude-code/src/runtime.ts:248-259` compares a
per-turn `input.outputSchema` against the spawn schema and, on mismatch, throws
`UnsupportedAgentRuntimeFeatureError('outputSchema', 'claude-code runtime does
not support per-turn outputSchema on the resident session')`; the declared
capability is `structuredOutput: { supported: true, scope: 'create-context' }`.
The schema reaches the process as a spawn argument (`args.ts:163-164`,
`--json-schema`). Removing create-context binding therefore either breaks
claude-code structured output outright or forces a hidden session restart per
schema — the exact "hidden restart/fresh-context behavior" Codex names.
Trae's design is also internally inconsistent: §3.4 keeps `outputSchema?` on both
submission arms while §10 deletes `structuredOutput.scope`, so nothing remains to
tell Core which Providers can honor a per-turn schema — the negotiation is
removed but the incompatibility is not. Codex and I independently reach
create-context binding; that is the only binding time both built-ins honor
(codex applies a fixed schema per native turn at `turn-manager.ts:116-117` and
itself rejects an *incompatible* per-turn schema mid-turn at
`turn-manager.ts:199-200`).

**R2 — Trae §3.2: `AgentRuntimeActivityContext.identity` carrying
`checkpoint.transcript_locator`** ("The provider maps checkpoint.id and
checkpoint.transcript_locator to its native session history"). Rejected by
`requirement.md:422-425`, which names `transcript_locator` as removed from the
Provider seam. Trae's own error union also keeps `locator_outside_root` as a
public reason, which re-exports a provider filesystem assumption through the
neutral error type.

**R3 — Trae §9.2: Core renames `channel-bindings.json` to `.legacy`, the Feishu
channel imports it once, then deletes it.** Rejected as a settled-rule
violation. `packages/dreamux/src/service/CLAUDE.md`: "Old state fails loud, it is
never migrated (issue #199 Slice 5, #233). 0.x has no schema migration (issue
#98) ... Detection only: the legacy paths/files are never read for migration,
rewritten, or removed." `review-findings.md` requires "an explicit fail-loud
cutover from the current Core-owned persisted state", and the requirement's
no-compatibility policy removes adapters. A one-shot importer is an adapter with
a shorter life, and it makes Core write to a path it is supposed to have stopped
owning. Codex reaches the same rejection independently ("Core metadata is not the
new Provider-owned authority"). My §8 fail-loud cutover stands.

**R4 — Trae §7.1: start every runtime (step 6) before `session.start()` (step
7).** Rejected on two grounds. First, it contradicts the freeze-audit obligation
to "order in-process startup and shutdown so event consumers are attached before
operations are admitted"; Trae accepts the loss explicitly ("Runtimes started in
step 6 may emit state events before the Channel subscribes"), and its own step 5
claim that "the queue is live before session.start" is inconsistent with its step
7, where the Channel's listeners are first registered. Second, eager runtime
start contradicts current behavior: `packages/dreamux/src/service/CLAUDE.md`
states "Ordinary start prepares channel sessions and input sources while leaving
the dispatcher runtime dormant; unbound channel inbound, dispatcher cron, or an
explicit resume notice lazy-starts the contained agent." Making dispatcher start
eagerly launch every Team/TeamMate runtime is a large behavior change nothing in
the requirement asks for. My §9.1 ordering (lease minted, port built, `start`
called, *then* admission opened) and Codex's equivalent ordering both hold.

**R5 — Trae §3.4: `AgentRuntime.providerRef` and `generation` retained on the
handle** ("Exported for tests and provider logging; Core never branches on it").
Rejected by the acceptance criterion that every mandatory member has an
unconditional Core consumer, and by the constraint against members that exist
only for stubs or tooling. A member Core never reads is exactly the surface this
task removes. Codex deletes `providerRef` for the same reason.

**R6 — Trae §3.1: `AgentRuntimeCapabilities.activityReporting: boolean`.**
Rejected. `review-findings.md`: "Activity reporting remains optional; absent
activity suppresses live COT detail without affecting execution or settlement."
Core must handle absence correctly whether or not a bit is declared, so the bit
has no consumer; and it is not trustworthy — a Provider declaring `true` may
still emit nothing. Trae's own annotation concedes the emptiness: "This is a
reporting fact, not a negotiation bit; it does not license omitting the sink."
Codex rejects it on the same reasoning.

**R7 — Trae §3.5: `TurnCorrelation` as a struct `{provider, channel_id, value}`
with Core attaching the first two "so a Channel cannot spoof another Channel".**
Rejected. Trae states in the same block that the value is "never used for
routing, authorization, dedupe, or idempotency" — so there is no authority to
spoof. The event already carries its Channel scope, and the Command invoker is a
closure bound to one dispatcher and one `channel_id` in all three designs, so the
provenance is structural. A plain opaque string with a length bound is the
minimal correct shape.

**R8 — Trae §4.3: `team.create` payload carrying `skill_sources` and `identity`
(and Codex's `identity`).** Rejected. `review-findings.md`: "Channel is trusted
only for its deliberately minimal Command catalog; internal Agent/MCP and
host-maintenance capabilities remain outside it." `admin/methods.ts:334` applies
`TEAM_LEADER_REQUIRED_SKILL_SOURCES` as a host invariant, and `identity_prompt`
is durable append-only role guidance. Both are host-maintenance capabilities, not
external-bridge inputs. Codex is right to exclude `skill_sources` but inconsistent
to keep `identity` while dropping `prompt`: `prompt` is equivalent to a first
`turn.submit` the Channel can already make, whereas `identity` is strictly more
powerful. I keep `prompt`, reject `identity` and `skill_sources`.

**R9 — Codex: per-publish `sequence` numbers, with Core accepting only the exact
next sequence.** Rejected as machinery without requirement evidence. Ordering is
already guaranteed by construction: one sink object per generation, awaited
calls, and `AgentRuntimeStateStore`'s existing serialized `mutationTail`. A
mandatory monotonic counter adds a Provider obligation whose only novel failure
mode is self-inflicted — a Provider that gaps or restarts its counter
permanently deadlocks its own state writes, turning a benign bug into a dead
runtime. The lease object is the epoch; that is sufficient and is what
`runtime-state.ts` already supports.

**R10 — Codex: `getCapabilities(config: TConfig)`.** Rejected (minor). Current
Core calls it with no argument at
`packages/dreamux/src/service/agent-entity/agent-config.ts:56`
(`providers.resolve(agent.provider).getCapabilities()`). Codex's premise about
*what* is enumerated is correct — `agent-config.ts:59-266` maps configured
`agents[]` — but the call is config-free today and no named consumer needs
parsed config. I keep the zero-argument form.

**R11 — Codex: an activity read context with no `injectEnv`.** Rejected on
source. The built-in Codex reader composes its environment from
`context.injectEnv` and `context.config.extra_env` at
`packages/agent-runtime/codex/src/transcript/reader.ts:642-643`; removing
`injectEnv` breaks it. Codex's companion trim of `cwd` I *accept* — no usage of
`context.cwd` appears in `packages/agent-runtime/codex/src/transcript/`, so it is
dead context. Net: the activity context keeps `session`, `config`, `injectEnv`,
`logger`; it loses `cwd` (accepted here) and `outputBudgetBytes` (accepted in
A1).

**R12 — Codex: a provider-owned durable `dataDir` as the home for the
session-to-history locator, with existing `transcript_locator` state failing a
new state-version check.** Rejected, and this is the most consequential
disagreement. Two costs. First, it is a new host path capability, not a reuse:
`AgentRuntimePathContext` (`packages/dreamux-types/src/agent-runtime.ts:198-220`)
exposes only `cacheDir()`, `logsDir()`, and `runtimeSocketDirs` — there is no
durable per-entity data directory to hand a Provider today. Second and more
seriously, it splits two facts that are currently written atomically together:
`packages/dreamux/src/service/CLAUDE.md` records "`session_id` is the
runtime-native thread id, persisted atomically with `transcript_locator`". Under
`dataDir`, a crash between Core's identity write and the Provider's own file
write leaves the session id and its locator divergent with no Core-side
atomicity, and the failure surfaces as an unreadable `last` on a session that
Core believes is fine. An opaque `provider_state` carried on `AgentSessionRef`
and persisted in the same atomic identity write preserves the existing
guarantee, removes `transcript_locator` from the Provider seam as the
requirement demands, and needs no new path capability. `cacheDir()` already
covers the rebuildable provider scratch that `dataDir` would otherwise justify.
The migration consequence is the real stake — see CR.6/U1.

**R13 — Codex: ledger capacity capped at 50,000 with fail-loud
`IDEMPOTENCY_LEDGER_FULL`.** The *retention rule* is accepted in A2; the hard cap
as the primary bound is rejected. It converts ledger growth into a dispatcher
outage: provisioning stops working entirely and the only recovery is operator
surgery on a server-owned file that the maintenance rules prohibit editing. With
A2's rule the ledger is bounded by live Team count, which is already
operationally bounded, so no cap is load-bearing. I keep a capacity threshold
only as a fail-loud *alarm* that never silently evicts a retriable identity.

**R14 — Codex: a timed-out event handler revokes the consumer permanently**
("a timed-out handler revokes the consumer and no later event is delivered").
Rejected. `review-findings.md` freezes COT delivery as "live, best-effort,
non-retained, non-replayed, and fail-open"; a single slow render permanently
blinding a Channel for the remaining process lifetime is not fail-open, and it is
a far larger COT regression than dropping display detail. Codex's stated
motivation — "a late completion cannot overtake later state" — is already solved
by the per-subscription FIFO in my §6.3: the abandoned handler's result is
discarded and the next event is dispatched only after the deadline, so
publication order is preserved without revocation. My §6.3 (abandon the event,
continue the queue) stands.

**R15 — Codex: "if no activity event can be evicted, the pump revokes the
consumer."** Rejected for the same reason as R14. A queue holding only lifecycle
events is bounded by real operations (Team/Agent state changes and turn
submit/settle), so it cannot grow without bound in practice; letting it reach its
own ceiling is strictly better than going blind. My §6.3 drop policy —
lifecycle events are never dropped, display detail is — is unchanged.

## CR.4 Factual disputes resolved against current source

1. **Structured-output binding time.** Resolved for create-context.
   `claude-code/src/runtime.ts:248-259` + capability `scope: 'create-context'`
   proves per-submission is not honorable by the resident claude-code session;
   `codex/src/turn-manager.ts:116-117` proves a fixed schema is applicable per
   native turn. Trae is contradicted; Codex and I agree.
2. **Is `transcript_locator` Core-interpreted?** No.
   `codex/src/transcript/path.ts:149-157` resolves it and validates
   `locator_outside_root` inside the Provider. It is already an opaque blob from
   Core's side, which is what makes `provider_state` a rename rather than a
   semantic change (§8).
3. **Do Channel state roots already exist?** Yes.
   `service/channel-service/channel-sessions.ts:89-90` supplies
   `state_root: dispatcherDir(id)` and `cache_root: dispatcherCacheDir(id)` on
   `ChannelSessionCreateContext`. Trae's proposed `dispatcherChannelDir` +
   `ChannelPathContext` is optional ergonomics — a Channel can namespace inside
   `state_root` today — and Codex agrees the create context "retains the current
   per-dispatcher durable and cache roots". Non-blocking; I do not adopt it,
   because adding per-channel host path builders in this change grows
   `platform/paths.ts` for no contract need.
4. **Does `get_capabilities` project `resume`?** Yes —
   `agent-entity/agent-config.ts:64`. Codex's claim is correct (accepted as A7).
   Its companion claim that the call takes parsed config is not
   (`agent-config.ts:56` calls it with no argument) — see R10.
5. **Does `ChannelToolDescriptor` carry audience today?** No —
   `dreamux-types/src/channel.ts:98-124`. Codex's `audience` is a new seam
   member, so the policy is accepted and the mechanism is not (A9).
6. **Does the Codex activity reader need `cwd` or `injectEnv`?** `injectEnv`
   yes (`transcript/reader.ts:642-643`), `cwd` no (no occurrence in
   `codex/src/transcript/`). Resolves R11 in both directions.

## CR.5 Revised position — exact deltas from round 1

Sections 1–13 stand except for the following. Each delta names the section it
amends.

1. **§3.5** — `AgentActivityContext` drops `outputBudgetBytes` and `cwd`; it is
   `{ session, config, injectEnv?, logger? }`. The Provider owns its read bound
   and sets `truncated`; `activity-reader.ts` revalidates the page against
   Core-owned bounds. (A1, R11)
2. **§3.3** — `publish` semantics: each lease write resolves only after durable
   persistence; the Provider must have awaited its session and `ready` writes
   before resolving `start()`. Core-side `lease.drain()` is deleted. (A5)
3. **§3.3** — a revoked lease **rejects** with
   `AgentRuntimeStateLeaseRevokedError` (meaning "stop pushing and terminate"),
   distinct from a persistence rejection (which remains fatal). (A4)
4. **§4.2** — `turn.submit` success result becomes
   `{ admission: ...; turn_id: string }`. (A8)
5. **§5.3** — ledger retention rule replaced: retain every entry whose Team is
   open, indefinitely; evict only entries whose Team is durably closed and older
   than the retention window; a capacity threshold is a fail-loud alarm, never a
   silent evictor. Result becomes `created | existing | closed`, where `closed`
   returns the historical `team_name` and requires a new `request_id` for a new
   provisioning generation. (A2, A3, R13)
6. **§5.1** — `bind_channel` / `unbind_channel` / `list_bindings` are
   Dispatcher-audience, enforced by the Provider inside `handleTool` via the
   retained `ChannelToolContext.caller`; no `audience` member is added to
   `ChannelToolDescriptor`. (A9)
7. **§7.2** — `blocked_worktree` **reopens ordinary Team admission** instead of
   holding the availability fence closed. Children remain stopped and are lazily
   reopenable by ordinary operations; the phase is still durable, still re-entered
   on restart, still never auto-forced. Round-1 risk 5 ("can strand a Team") is
   downgraded accordingly. (A6)
8. **§10** — add to the deletion inventory: the `resume` field on
   `AgentEntityRuntimeCapability` (`agent-entity/agent-config.ts:64`) and its
   `teammate.get_capabilities` projection. (A7)
9. **§11** — add rows: ledger never evicts an open-Team identity and a
   closed-Team replay returns the historical name without re-creating; a revoked
   lease rejects with the typed error while a persistence failure is fatal;
   `turn_id` returned by `turn.submit` matches the id on the delivered
   `turn.submitted`; `blocked_worktree` admits ordinary Team work; the three
   binding tools reject a `team_leader` caller; `get_capabilities` no longer
   exposes `resume`.

Everything else I hold: create-context schema binding (§3.6), `provider_state`
on `AgentSessionRef` with the persisted key unchanged (§8, R12), required
`turn_source` on turn events (§6.2), the bounded-queue drop policy with lifecycle
events never dropped and no consumer revocation (§6.3, R14/R15), `subscribe` on
the port rather than an `onMessage` member (§13), the two-Command catalog with
`prompt` but not `identity` or `skill_sources` (§4.2, R8), and fail-loud cutover
with no importer (§8, R3).

## CR.6 Residual risks after the revision

Round-1 risks 1–4, 6, 7 are unchanged. Risk 5 is downgraded by delta 7. New or
changed:

- **Reopened `blocked_worktree` admits work that dirties the worktree further.**
  Accepted: the next dissolve re-assesses, and the alternative (a stranded Team
  reachable only by `force`) is worse. The read model must show the blocked
  reason prominently or an operator will not know why dissolve keeps failing.
- **Ledger retention keyed to Team closure means a long-lived dispatcher with
  many closed Teams still holds entries until the retention window elapses.**
  Bounded and observable; the fail-loud alarm is the backstop.
- **Provider-owned read bounds (A1) mean a misbehaving Provider can return a
  very large page.** Mitigated by Core-side revalidation in `activity-reader.ts`,
  which is where the current `verifyTranscriptPage` bounds already live — so this
  is a move of enforcement, not a loss of it.

## CR.7 Unresolved disagreements that would materially change the design

These are genuine forks, not preferences. Each changes something the task asks to
be explicit about, so I state my position and the cost of being wrong.

**U1 — Where the session-to-native-history locator lives. Materially changes
migration.** Mine: opaque `provider_state` on `AgentSessionRef`, persisted in the
same atomic identity write, persisted key `transcript_locator` retained → **no
agent-state rebuild**. Codex: Provider-owned durable `dataDir`, with existing
`transcript_locator` state failing a new state-version check → **every agent
entity in every dispatcher is rebuilt**, losing session continuity and `last`
history. Trae: locator stays in the seam → rejected by `requirement.md:422-425`.
I argue mine on atomicity (R12) and on upgrade cost; Codex argues its own on
seam purity. This is partly an operator cost decision, not purely technical: the
difference is whether upgrading destroys every TeamMate's resumable session.

**U2 — Event delivery under a stuck consumer. Materially changes COT behavior
and concurrency.** Mine: abandon the event after the deadline and keep the
subscription alive; lifecycle events are never dropped. Codex: revoke the
consumer on timeout, and also revoke when a lifecycle event finds no evictable
activity event. Trae: drop the oldest pending event with no deadline at all
(which can drop a `turn.submitted` and orphan every later message for that turn —
a third position I reject as strictly worse than either). The fork matters
because revocation is permanent within a process lifetime.

**U3 — MCP composition shape. Materially changes the Channel contract and loader
conformance.** Mine and Trae's: optional `handleTool?` on `ChannelSession`.
Codex's: `createSession` returns `ChannelInstance { session, mcp? }` with a
separate `ChannelProviderMcp` carrying `tools()` and `handleSessionless?`. Codex's
split is cleaner for a Provider with tools but no live session and it keeps tool
methods off the base session; mine is one fewer type and matches the current
optional-member shape. I hold optional-member because no current path needs
sessionless dispatch in-process, but I do not think Codex's version is wrong —
it is a real trade between one extra type and one optional member.

**U4 — `team.create` ledger bound. Materially changes failure mode.** Mine
(revised): retention keyed to durable Team closure, capacity as a fail-loud
alarm. Codex: hard cap at 50,000 with `IDEMPOTENCY_LEDGER_FULL` as a normal
rejection. The fork is whether a full ledger stops provisioning or merely warns.

Not unresolved, listed only so a later reader does not reopen them: Trae's
per-submission schema (R1), legacy-state importer (R3), eager runtime start
(R4), retained `providerRef`/`generation` (R5), and `activityReporting` (R6) are
each settled against Trae by current source or by a recorded decision, not by
seat count.
