# Requirement

## Outcome

Reduce the public Agent Runtime and Channel provider contracts to the smallest
capability-neutral mechanisms Dreamux actually needs. Channel remains Dreamux
Core's only bridge to the outside world: it owns external-message handling and
external-route bindings and selects Core Commands, while Core owns Dreamux
domain state and Command execution.

The design is capability-first. The Core-owned domain capabilities and facts are
defined independently of any Channel implementation; only then are the generic
Channel invocation and observation ports designed. Existing Feishu behavior,
`ChannelRoutes` members, or other provider call sites are migration evidence,
not the source of the new Core Command or event catalogs.

The implementation target is a fresh installation. This task does not design an
old-to-new transition for superseded local runtime state, does not preserve old
record shapes, and does not add migration, lazy backfill, compatibility reads, or
operator rebuild flows for them. Team records, Agent identities, scheduler data,
and other state below a Dispatcher are operational state that may be discarded;
their value is the current product behavior they enable, not cross-version data
retention.

This document, current source, and prior Decisions are investigation evidence;
none is automatically the target architecture. The final product shape and the
operator's explicit product principles are authoritative. During implementation,
the TeamLeader must ask why every existing mechanism exists, whether it solves a
real target-product problem, and whether its cost and ownership still belong in
the final design. A behavior is not preserved merely because it is deployed,
load-bearing, or recorded historically; refactoring deliberately removes bad
designs once their product value is disproved. Work stops for the operator only
when a conflict exposes a genuinely unmodeled choice that would change final
product behavior, persistence, destructive handling, or another product policy.

This clarification intentionally changes some existing behavior and public
surface. In particular, external-route binding moves from Core to the owning
Channel, TeamLeader Channel-tool egress is no longer restricted by Core
bindings, and the old Team `transfer_back` surface is removed rather than kept
as a compatibility alias.

## Confirmed current behavior and evidence

### Agent Runtime boundary

- `AgentRuntimeProvider` currently requires provider identity, capability
  reporting, transcript reading, and runtime creation. The external-provider
  loader rejects a provider without `getCapabilities`, `createRuntime`, or
  `readTranscript`.
- The live `AgentRuntime` handle currently declares lifecycle, two input paths,
  status, checkpoint, resume observation, context usage, and capability
  reporting. The external-provider loader requires every method except
  `waitIdle`.
- Core reads capabilities from `AgentRuntimeProvider`. Current Core source has
  no production consumer of the live runtime handle's `getCapabilities` or
  `getContext`, although external runtimes must implement both.
- Core pulls live status and checkpoint state through `getStatus`,
  `getCheckpoint`, and `wasCheckpointResumed`, while the create context also
  supplies state callbacks through which the runtime pushes status and
  checkpoint transitions into Core-owned durable identity state. The target
  contract must choose one authoritative direction instead of preserving both
  representations by default.
- A runtime must expose `resume` even when its declared resume capability is
  unsupported, and transcript reading is mandatory even though it is an
  operational read capability rather than turn execution.
- The create context requires an MCP-server list and an activity sink, while
  system prompt, skill sources, feature disabling, structured output, paths,
  state callbacks, logging, and injected environment are mixed into one surface
  with different necessity and support characteristics.
- The system-prompt input already has two neutral forms because the built-in
  runtimes have different native capabilities. A Dispatcher supplies both a
  complete replacement prompt and a focused append prompt: Codex consumes the
  replacement form, while Claude Code, which cannot replace its native system
  prompt, consumes the append form. A TeamLeader supplies append-only role
  instructions, which both built-in runtimes append. This distinction is
  load-bearing behavior and must not be flattened to one string or implemented
  by branching on a concrete Provider id in Core.
- Ordinary TeamMates, whether Dispatcher-scoped or Team-scoped, also use
  append-only prompt fragments.
  Their owner currently preserves the established ordering of operation-owned
  fragments first and the persisted `identity_prompt` last. Workflow supplies
  its machine-result and structured-output guidance as an operation-owned
  fragment through that same path. These fragments are load-bearing role and
  execution policy, not first-turn text.
- Dreamux owns the durable or deterministic sources from which append fragments
  are rebuilt. Native sessions are not prompt-state authorities: Codex does not
  persist `developerInstructions`, and Claude Code receives
  `--append-system-prompt` on every resident-process spawn, including a
  `--resume` spawn. Initial creation, close/reopen, process restart, Team
  rebuild, and runtime resume therefore all re-supply the ordered fragments.
- TeamMate MCP `last` is a required user capability but currently obtains its
  data exclusively through `provider.readTranscript`, asking each provider to
  locate and parse a runtime-native transcript after the runtime may already be
  closed. The public tool contract and this provider mechanism are currently
  coupled even though they are not the same capability.
- TeamMate `list`, `status`, `history`, and `get_capabilities`, and Team
  `list`, `status`, and `history`, are served from Core-owned identity/config
  state rather than live provider queries.
- Team dissolve currently refuses a live writer whose runtime omits
  `waitIdle`; scheduler also calls runtime `waitIdle` before submitting a held
  fire. These are the only production consumers of this optional runtime
  method. This waiting behavior has caused operational problems in dissolve
  and is not retained in the target design.
- TeamMate `send` promises to reopen a closed TeamMate from its recorded
  runtime session, while Workflow uses structured output and fails clearly when
  the selected runtime lacks it. These product contracts impose different
  universality requirements and must not be flattened into one undifferentiated
  capabilities object.

The current production consumer matrix for public Agent Runtime functions is:

| Function | Current Core consumer |
| --- | --- |
| `Provider.getCapabilities()` | Provider-load shape/value validation; resume launch selection; Agent Runtime capability projection; Workflow structured-output preflight. It is retained in the target state as the Provider discovery/description surface so Dreamux can enumerate Provider characteristics and tags, even though resume and structured output are no longer optional bits. |
| `Provider.readConfig?()` | Config loading and provider-owned config validation only. |
| `Provider.onboard?.collect()` | Interactive onboard config collection when no explicit config block is supplied. |
| `Provider.diagnostic?.binChecks()` | `doctor`/onboard binary-check discovery and deduplication. |
| `Provider.diagnostic?.runDiagnostic()` | `doctor`/onboard provider diagnostics. |
| `Provider.readTranscript()` | TeamMate `last` only; this is being replaced by a mandatory neutral recent-activity reader that can observe the currently active turn. |
| `Provider.createRuntime()` | Creation of a live Dispatcher/TeamLeader/TeamMate runtime. |
| `Runtime.start()` | Fresh runtime launch. |
| `Runtime.resume()` | Checkpoint launch when provider-level resume capability says supported; target design folds this into mandatory context-continuous `start`. |
| `Runtime.stop()` | Entity close/shutdown and failed-start rollback; owns the synchronous input fence and admission convergence guarantee. |
| `Runtime.channelInput()` | External Channel/user turn submission only; target design moves Channel rendering into Channel and folds the resulting text into one flat `submit`. |
| `Runtime.completionInput()` | Scheduled, control, prompt/workflow, and Agent-to-Agent completion submissions; target design folds their prepared text into the same flat `submit`. |
| `Runtime.waitIdle?()` | Scheduler held-fire delay and Team dissolve only; confirmed for deletion without a replacement idle model. |
| `Runtime.getStatus()` | Live status/history projection and live-writer/start checks; target design replaces it with runtime-to-Core state push. |
| `Runtime.getCheckpoint()` | Runtime status/thread projection with persisted-state fallback; target design replaces it with runtime-to-Core state push. |
| `Runtime.wasCheckpointResumed()` | Dispatcher restart-notice injection only; target design reports start outcome without this query. |
| `Runtime.getContext()` | No production Core consumer. It is loader-required dead surface and is deleted, not retained as an optional capability. |
| `Runtime.getCapabilities()` | No production Core consumer. All current capability reads use the Provider-level function; the handle method is deleted. |

The create context also exposes reverse-direction Core callbacks. These are not
Provider query methods: `activitySink` accepts transient assistant/tool facts
for live conversation projection; `state.setStatus` and `state.setCheckpoint`
persist authoritative lifecycle/recovery state; optional
`state.recordLostCheckpoint` records a provider-reported checkpoint replacement;
and path callbacks supply provider-owned cache, log, and runtime-socket roots.

### Channel boundary

- Core currently starts a Channel session with a growing `ChannelRoutes`
  callback object. Inbound delivery uses `deliver`; collaboration behavior adds
  `targetLifecycle`, `ensureCollaborationTarget`, and `deliverExact`.
- The dispatcher Core event bus flows from Core to Channel. It publishes Team,
  Agent, binding, collaboration, turn, and activity facts through a scoped,
  read-only event source.
- `targetLifecycle` accepts `target_created` and `target_closed` facts from a
  Channel and drives Collaboration Space provisioning or close. The Core
  receiver and tests exist, but the built-in Feishu Channel currently has no
  production call site for this callback.
- Agent-facing Channel MCP first uses MCP JSON-RPC over stdio, then the Dreamux
  NDJSON admin Unix-socket protocol, then `channel.invoke_tool`; Core finally
  invokes the provider's live or sessionless tool handler.
- Channel MCP tool discovery is static provider/config metadata. Dreamux builds
  the MCP descriptor and injects it into the Agent Runtime; invocation later
  reaches a live session or a provider-level sessionless handler.
- Binding currently accepts provider-defined `meta`, calls the live session's
  `resolveTarget(meta)`, and stores a provider-produced `target_key`. The
  accepted issue #209 decision chose this because it assumed selectors could
  have multiple equivalent forms. For a simple Feishu `{ chat_id }` selector,
  current `resolveTarget` performs a local conversion rather than checking that
  the external chat exists.
- TeamLeader Channel MCP currently passes through
  `authorizeTeamLeaderEgress`, including target resolution, binding-owner
  checks, and optional `messageBelongsToTarget` proof before provider dispatch.
- `ChannelSession.reply?` and `react?` have no Core production consumers;
  provider-owned MCP tools are the actual outbound surface.

### Core capability and fact inventory

- Current Core domain services expose seven user-facing capability families:
  turn submission/admission, Team lifecycle and reads, TeamMate lifecycle and
  reads, Channel binding, scheduled turns, Workflow lifecycle and reads, and
  Collaboration Space lifecycle and reads. Admin methods and Agent-facing MCP
  tools currently adapt overlapping subsets of these services, but are
  transports rather than the authority for the capability catalog.
- Completion routing and Agent Runtime ownership are internal orchestration
  capabilities. Server status plus Dispatcher list, status, and initial start
  are host-maintenance capabilities already invoked through `admin.sock`; they
  remain Commands in the unified Core catalog even though a current Channel may
  never call them. Stopping or restarting one Dispatcher is not a product
  capability. There is no `dispatcher.stop` Command or CLI verb; process-level
  graceful shutdown remains owned by the daemon/server lifecycle. Daemon
  process bootstrap, configuration, onboarding, and diagnostics that are not
  current admin Commands remain direct host control-plane capabilities.
- Turn admission currently has two equivalent boundary adapters, one for
  dispatcher delivery and one for Team delivery. Both normalize the shared
  internal `TurnAdmission` vocabulary to
  `submitted | duplicate | stopped | failed | ambiguous`, including
  `skipped -> stopped`. This duplication is evidence that turn submission and
  admission is one Core capability rather than a Channel-specific delivery
  callback.
- The current Core event source already broadcasts the complete event stream to
  each live Channel source; the Channel id attached to a source is used for
  lifecycle and logging rather than server-side event filtering.
- The current public event union contains Team state, Agent state, turn
  submitted/settled/message/tool-call facts, binding route facts, and
  Collaboration Space binding facts. It has no Workflow or scheduler state
  facts.
- Team, Agent, and turn lifecycle are stable Core facts. Current binding event
  and `ChannelOrigin` payloads depend on the `target_key` model being removed,
  while the Collaboration Space binding event exposes runtime and worktree
  policy. Those payloads are deleted rather than adopted into the target event
  catalog.
- Turn message and tool-call events are conditional on optional Agent Runtime
  activity reporting and currently include presentation-oriented projection,
  redaction, and truncation behavior. Their status as stable externally
  observable Core facts remains a product decision.

## Desired behavior

### 1. Direct Provider control and lifecycle

- Dreamux Core directly constructs and controls every Channel through a small
  in-process Provider/session interface. Construction, initialization, start,
  and close do not use RPC.
- Provider configuration, identity, onboarding, and diagnostics remain in this
  host-to-Provider control-plane category. Which are base members and which are
  optional composed capabilities remains to be decided.
- Product-specific routing, collaboration, binding, or platform methods do not
  become base lifecycle members.

### 2. Unified Core Command invocation

- A Channel owns the complete loop for receiving an external message,
  interpreting it, deciding what Dreamux action to take, and selecting a Core
  Command.
- The base mutation boundary is one request/response primitive equivalent to
  `const result = await invoke(command, payload)`.
- Core owns one Command registry. `admin.sock` and the in-process Channel
  `invoke` port are peer transport adapters into that same registry; they do not
  own separate method tables, schemas, validation, errors, or execution paths.
- Every Command registered in the Core registry is callable through both
  adapters. There is no transport-specific exposure policy, allowlist, or
  capability negotiation. A current Channel may consume only a small subset,
  but non-consumption is not a permission boundary and does not produce a
  second Channel catalog.
- Each Command has a Core-owned name, input, result, error, authorization,
  admission, and idempotency contract independent of Feishu, Slack, Telegram,
  or another provider.
- The shared registry validates Command inputs and outputs against the same
  schemas and JSON-representability rules for every adapter. It does not impose
  a speculative registry-wide output byte limit: Activity, history, list, and
  capability domains retain their existing pagination or source-owned bounds,
  and any future large-result problem is solved by the owning Command contract.
- Command failure uses a small ordinary `Error` inheritance tree rather than a
  second result-envelope taxonomy. `DreamuxError` carries a stable code;
  reusable boundary failures such as `ValidationError`, `TransportError`, and
  `InternalError` extend it, while specific business failures such as
  `TeamNotFoundError`, `TeamClosedError`, `TeamGenerationChangedError`, and
  `IdempotencyConflictError` extend it directly. There is no `DomainError`
  layer. Unknown implementation failures alone are normalized to
  `InternalError`.
- Registry input validation runs before every handler regardless of whether the
  call arrived through `admin.sock`, the in-process Channel adapter, or the
  generic MCP delegate infrastructure. Agent-facing domain MCP tools do not map
  themselves to domain Commands: one generic MCP call Command resolves an
  opaque runtime-bound delegate, and that delegate invokes the owning object
  method directly. A cross-process adapter may then raise a specific
  `TransportError` when framing, connection, or delivery fails; ordinary
  business execution raises its concrete business error. The final MCP adapter renders every
  `DreamuxError` as one consistent, concise, model-understandable error without
  exposing the internal inheritance tree as a public protocol layer.
  `TransportError` has its own stable `TRANSPORT_ERROR` code and is never
  reported as request validation.
- Caller and transport identity may be attached as execution context where the
  domain operation needs it, but it must not be used to hide registered
  Commands from Channel callers. Domain validation and authorization remain
  properties of the Command itself rather than an exposure layer.
- Agent-facing MCP is not an alternate spelling of the domain Command catalog.
  Every MCP shim sends actual tool calls through the same generic
  `mcp.toolcall` infrastructure Command. Core resolves a runtime-generation
  `McpServerDelegate`; the delegate owns the tool catalog, caller context,
  model-input source, completion behavior, error projection, and direct call to
  a Team, TeamMate, Scheduler, Workflow, Channel session, or Channel provider
  object. Individual MCP tools never become Command definitions merely because
  the shim is cross-process. `mcp.describe` exposes the delegate's validated
  catalog to the generic official-SDK shim without flattening it into Core.
- Existing `deliver`, `ensureCollaborationTarget`, `deliverExact`, and
  `targetLifecycle` are only a migration inventory. Requirement and solution
  work must decide whether their underlying Core use cases belong in the new
  catalog, are already covered by a more fundamental Core capability, or should
  be removed. They are not automatically translated one-for-one into Commands.
- Future Channel-originated behavior extends the Core-owned Command
  registry/schema rather than the base Channel interface or a parallel admin
  method table.
- The unified catalog is organized by authoritative Dreamux domains. Its
  surviving public families are `server.*`, `dispatcher.*`, `team.*`,
  `teammate.*`, `workflow.*`, and `scheduler.cron.*`; the exact target names are
  frozen by the technical design after a complete inventory of current
  `admin.sock` methods. This refactor does not create a generic capability
  namespace or retain transport-named domain actions.
- The current Core Channel-binding and Collaboration Space command families are
  not carried forward. External binding moves to Channel-owned MCP tools, while
  Team is the sole Core container used to realize an external collaboration
  target. Channel MCP uses the same generic `McpServerDelegate` and
  `mcp.describe`/`mcp.toolcall` infrastructure as every other MCP server; it is
  not a Channel-specific Command family.
- The Feishu Channel implementation changed in this refactor calls only
  `team.submit` and restart-durable idempotent `team.create`. That implementation
  scope does not narrow what another Channel may invoke through the shared port.
- Turn submission accepts an optional stable `team_name`. A Channel supplies it
  when its binding or provisioning selects a TeamLeader, and omits it when its
  routing selects the Dispatcher Agent; `admin.sock` has the same target
  semantics. Team lookup failure is a proven pre-admission result; admission
  ambiguity remains non-retryable.
- `team.submit` has one content payload rather than inbound/text variants.
  Channel interprets its external envelope and supplies source attributes,
  original model-facing body text, and an optional Channel reminder before
  invoking the Command. `TeammateService` owns the common source-envelope
  assembly; Agent Runtime receives only the resulting text. Optional source
  identity and intent remain separate non-rendering fields. Core does not carry
  a Channel presentation anchor or a duplicate correlation field.

### 3. Core-to-Channel event delivery

- The base observation boundary is one event-delivery primitive equivalent to
  `onMessage(event, payload)`.
- A Channel may subscribe to the complete Core event stream and locally select
  the event kinds it needs.
- Core owns the event catalog. Events are stable Core domain facts chosen for
  external observation, not a copy of callbacks or projections required by one
  Channel implementation.
- Observation is read-only and fail-open relative to authoritative Core
  operations. Adding an event extends the event catalog/schema rather than the
  base Channel interface.
- Event delivery is live-only and has no replay or subscribe-time snapshot.
  Channel Providers run in the Dreamux process and share its lifecycle; there is
  no product model in which Core continues operating while a configured Channel
  is independently offline and later reconnects. Core attaches the Channel event
  consumer before admitting operations and revokes it only after relevant Core
  work is fenced during shutdown. Process restart restores Channel-owned local
  state rather than replaying or remotely synchronizing Core events.
- Channel is not given general Core read Commands to compensate for missed
  events. A later `team.submit` result of `TEAM_NOT_FOUND` or `TEAM_CLOSED`
  remains a defensive stale-binding cleanup path, not the normal synchronization
  mechanism.
- Core does not persist event message/tool contents for replay. It records only
  critical operational logs and does not use a local event-content store.
- The current post-COT message/tool-call behavior, exposed through the target
  `teammate.turn.message` and `teammate.turn.tool_call` events, is a
  frozen compatibility baseline, not a redesign target. Providers emit the
  existing normalized real-time activity shape. Core applies the existing
  bounded presentation projection, workspace/secret redaction, and truncation,
  then publishes the resulting display-only facts for Channel consumption.
  Delivery is best-effort: there is no retry, retransmission, replay, retention,
  acknowledgement, or final-delivery guarantee, and observer failure remains
  fail-open relative to the turn.
- The COT event payload boundary is intentionally independent from the narrower
  `last` Activity Record boundary. This refactor must not remove current COT
  tool arguments/results after Core redaction, alter their presentation fields,
  or otherwise change the tuned Channel display effect.
- Channel keeps the visible-message anchor local before invoking Core. A
  submitted result identifies the exact `turn_id`, and the submitted event
  identifies the selected Dispatcher or TeamLeader, so only the invoking
  Channel session binds its anchor to that turn without injecting
  `ChannelOrigin` or an opaque correlation through Core.
- The initial event catalog is deliberately minimal: `team.state`,
  `teammate.state`, `teammate.turn.submitted`, `teammate.turn.settled`,
  `teammate.turn.message`, and `teammate.turn.tool_call` facts required for Team
  binding invalidation and the frozen COT behavior. The `teammate` namespace
  makes the owning Core entity explicit for the complete turn-event family.
  Core binding/Collaboration Space events are deleted; Workflow, scheduler,
  TeamMate-management, and other internal MCP capabilities add no Channel events
  in this change.
- `teammate.state` covers every Dreamux Agent entity: Dispatcher, TeamLeader,
  ordinary Team members, and standalone TeamMates. Creation publishes the first
  state fact immediately after the identity is durably created; later lifecycle
  transitions publish the same event kind. There is no separate
  `teammate.created` event.
- `team.state` is the redundant aggregate view. In addition to Team lifecycle
  state, it carries the current bounded summary of that Team's TeamLeader and
  members. Core republishes it when the Team lifecycle or a contained
  TeamMate's state changes. A Dispatcher has no Team and therefore appears only
  in `teammate.state`.

### 4. Generic MCP delegation and optional Channel extension

- Every Agent-facing MCP server is represented in Core by a short-lived
  `McpServerDelegate` bound to one runtime generation. The Agent Runtime receives
  only a generic Core-owned stdio shim descriptor and an opaque lease. At
  startup the shim obtains the delegate's validated catalog through
  `mcp.describe`; every registered handler sends `mcp.toolcall { lease, name,
  arguments }`. The generic router validates the lease and tool membership, then
  calls the delegate. It never switches on a domain or provider tool name.
- Internal delegates call Team, TeamMate, Scheduler, Workflow, and other owning
  objects directly. They do not translate tools into `team.*`, `teammate.*`, or
  other domain Commands. This is where Agent-task `source`, reverse completion,
  caller identity, tool visibility, and model-understandable error projection
  belong. The shim contains transport/SDK mechanics only.
- A Team-scoped `WorkflowService` receives only a narrow `createLocked`
  capability backed by that Team's `TeammateCollection`. It neither constructs
  nor owns `TeammateService` instances, and it does not hold a raw
  `TeamService` or `TeammateCollection`. Each Workflow-created TeamMate is
  published in the current Team's collection and returned as a
  `LockedTeammate`; the Workflow owns that lock until terminal cleanup releases
  it. This path must not bounce through `TeamCollection.withTeamLeaderLease` to
  rediscover the same `TeamService`. Workflow admission and `stopAll()` own
  shutdown convergence; per-spawn Team-generation revalidation is not a second
  lifecycle mechanism.

- A Channel may register a provider/config- and caller-specific MCP tool
  catalog. Channel MCP is injected only into Dispatcher and TeamLeader Agent
  Runtimes; ordinary Team members and standalone TeamMates do not receive it.
  The Channel owns which tools are visible to each of those two caller roles.
- The registration direction is Channel Provider -> Dreamux Core -> Agent
  Runtime Provider -> native Agent. Dreamux owns and validates the concrete
  Agent Runtime MCP server descriptor and proxy launcher; a Channel declares
  tool schemas and handling ownership but does not inject arbitrary launcher
  commands into Agent Runtime configuration.
- The invocation direction is native Agent -> generic MCP stdio shim ->
  `mcp.toolcall` -> the Channel delegate -> the registered Channel handler.
  The delegate attaches the Dispatcher, configured
  Channel instance, and caller identity from the scoped MCP server; tool
  arguments cannot forge that routing context. The provider's canonical result
  or error returns through the same path.
- This mechanism is distinct from Channel-to-Core domain Command invocation and
  Core-to-Channel event delivery.
- The design must support both live-session tools and provider-level
  sessionless tools such as the current `list_chat_bots` behavior. Tool
  registration declares which owner handles a call; Core contains no
  tool-name-specific routing branches.
- Direct `reply?` and `react?` base-session members are not retained when their
  behavior is already provider-owned MCP capability.
- A Channel that supports external-route binding owns provider-specific
  `bind_channel`, `unbind_channel`, and `list_bindings` MCP tools. They are
  present only in the Dispatcher catalog; a TeamLeader does not see them.
  Feishu additionally retains its explicit Collaboration Space MCP product
  flow as Channel-owned tools: Dispatcher can bind an external Feishu
  container as an automatic-provisioning space, unbind it, and inspect the
  Channel-owned space state. These are Feishu Channel tools, not restored Core
  Collaboration Space Commands or types.
  Reply/react and other Channel tools may be exposed to Dispatcher and/or
  TeamLeader according to Channel policy. None are Team MCP or Core Commands.

### Channel-owned external routing

- Each configured Channel instance is the sole authority for mapping its own
  external targets to Dreamux agents. It owns target interpretation,
  canonicalization, hierarchy/fallback rules, authorization, persistence, and
  migration in its provider state. Core stores no external-route binding or
  provider metadata.
- Feishu may distinguish ordinary chats, ordinary threads, topic-group topics,
  and parent groups using its own state and matching rules. Another Channel may
  use a completely different model or no binding capability at all. None of
  these identities or hierarchy concepts enter the Core contract.
- A binding targets a stable Dreamux `team_name` and can route only to that
  Team's TeamLeader; arbitrary TeamMate binding is not supported. Concrete Team
  names are occupied only by valid readable Team records. There is no separate
  forever-reserved name tombstone for a Team that does not exist.
- On inbound, Channel resolves its own binding or completes its own automatic
  Team provisioning before invoking Core. A resolved Team route supplies
  `team_name`; when no binding or provisioning policy selects a Team, Channel
  omits the target and delivers the input to the Dispatcher Agent.
- Core validates the requested Team before admission. A typed
  `TEAM_NOT_FOUND` or `TEAM_CLOSED` result proves that no turn was accepted;
  Channel may remove stale binding state and submit once to the Dispatcher
  Agent. Channel must not retry or fall back after an ambiguous admission.
- Core removes its Channel binding store, binding matching, target resolution,
  binding ownership, and Team bind/unbind operations. `resolveTarget`,
  `resolveInboundBinding`, `target_key`, `binding_fallbacks`, and Core
  `binding.route` facts do not survive as target-architecture concepts.
- Channel's authoritative `list_bindings` returns each external target together
  with its target Team/agent identity. This single read answers which external
  targets are bound. A composite view that also needs all Teams, including
  unbound Teams and current Team status, deliberately joins `team.list` with
  each configured Channel instance's `list_bindings`; Core does not query
  Channels or replicate their binding index merely to hide that join.
- The current Team MCP `bind_channel` and `transfer_back` tools are removed.
  Channel-owned tools use `bind_channel`, `unbind_channel`, and
  `list_bindings`; there is no `transfer_back` compatibility alias.

### Channel-tool egress

- Remove Dreamux Core's binding-scoped TeamLeader Channel-tool egress
  restriction.
- Remove `authorizeTeamLeaderEgress`, `messageBelongsToTarget`, target-binding
  ownership checks, and message-to-target ownership checks from this path.
- Core selects the configured Channel instance and forwards the provider MCP
  tool name and payload. An Agent may address any target permitted by the
  Channel provider and the external platform.
- This does not remove provider tool-schema validation, external-platform
  permissions/errors, or Channel-owned inbound access/trust policy.
- Caller context may remain only where a non-authorization consumer such as
  logging or COT presentation proves it is necessary.

### No general Core-to-Channel query port

- The target contract does not add a generic Core-to-Channel request/query
  mechanism or a Core-only Channel capability catalog.
- Moving external-route authority to Channel and removing binding-scoped egress
  proof eliminates the current reasons for `resolveTarget`,
  `resolveInboundBinding`, and `messageBelongsToTarget`.
- The four Channel mechanisms are therefore: direct Provider control/lifecycle,
  Channel-to-Core Command invocation, Core-to-Channel event delivery, and the
  optional Agent-to-Channel MCP registration/forwarding path.

### Minimal Agent Runtime contract

- A new Agent Runtime implements only execution semantics that every supported
  Dreamux runtime necessarily provides and Core necessarily consumes.
- The live runtime handle has exactly three mandatory execution methods:
  `start`, `submit`, and `stop`.
- `submit` accepts one flat neutral input containing only prepared `text`. It
  replaces the separate `channelInput` and `completionInput` methods without
  retaining a `kind`, source taxonomy, or Dreamux idempotency key at the
  Provider seam. Channel owns external-envelope interpretation and its body
  formatting; Core assembles the source envelope before Runtime submission.
- Core retains source identity, intent, completion delivery, and the open model
  `source` echoed as event `turn_source` in its own admission/turn state. Those
  Core facts do not cross the Agent Runtime Provider seam merely to classify
  identical text submission behavior.
- Stable submission source identity and bounded process-local deduplication
  belong to the Core admission owner. Each source owner supplies a stable
  optional `sourceId`. One Dispatcher-lifetime ledger keys the target entity and
  that ID; it does not carry an additional origin scope or retain one child
  ledger per historical entity. Concurrent repeats share the pending admission;
  after `submitted` or `ambiguous`, a globally bounded recent repeat returns
  public `duplicate`; `failed`, `stopped`, and provider-internal `skipped` do not
  consume the key. Pending entries exist only for unsettled work. This keeps the
  existing no-cross-restart guarantee while bounding retained memory and
  removing Dreamux idempotency policy from every Provider adapter.
- `TeammateService` has one admitted-input operation. It does not preserve
  `channelInput`, `scheduledInput`, or `controlInput` wrappers after the Runtime
  seam has become one text-only `submit`. Every accepted ordinary input may
  materialize or reopen its target, so callers cannot select a `reopenClosed`
  mode. Its exact input consists only of required `source`, optional
  `Readonly<Record<string, string>>` `attrs`, `text`, optional `reminder`,
  optional `sourceId`, optional `intent`, and optional `deliverCompletion`.
  `sourceId` serves only the one bounded Core duplicate ledger; `intent` updates
  the durable recovery subject only for a newly accepted turn; and
  `deliverCompletion` is the optional Core completion callback. These three
  fields are never rendered. COT records the original `text`, not the assembled
  envelope or reminder. No `scope`, opaque correlation, `turnOrigin`,
  `AbortSignal`, or logging label survives beside this signature.
  Missing `attrs` is exactly an empty attribute set. Attributes have no semantic
  order, and the object shape prevents duplicate names. `source` is an open
  safe tag name rather than a Core enum. Core validates only the generic
  envelope shape and never interprets or branches on the business meaning of a
  concrete source or attribute, so adding a new Channel form does not change
  Core. `system` is reserved to Core-owned
  notices: ordinary callers cannot select it, while Dispatcher restart
  notification uses it. Channel Command and `admin.sock` inputs use `channel`.
  Agent-facing MCP spawn and submit inputs default to `task`, and model
  completion delivery defaults to `task-notification`. Core source identity,
  intent, and completion delivery remain separate non-rendering facts rather
  than being smuggled through attributes.
- `TeammateService` renders one paired root named by `source`, with open
  validated attribute names and escaped attribute values, then inserts the
  source body directly and closes the root. It does not add a `<content>` child,
  pretty-print indentation, XML entity rewriting of the body, or CDATA-based
  code transformation. Channel
  code blocks retain ordinary Markdown fences and the body stays faithful to
  the model-facing source text. When supplied, one generic `<reminder>` appears
  once after the closed source block at the end of the complete input, never
  repeated inside each message. XML-like tags are model-facing provenance and
  boundary hints, not a security boundary.
- Scheduler owns cron-fire lifecycle and cancellation entirely within the
  scheduler boundary. A due fire validates its current generation and durable
  job immediately before invoking the ordinary admitted-input operation. No
  `AbortSignal`, held-fire token, busy wait, or scheduler-specific cancellation
  mechanism crosses into `TeammateService`; once admission reaches Runtime,
  deletion or shutdown does not retroactively pretend the turn was never
  submitted.
- `start` owns both fresh launch and checkpoint-aware launch using the create
  context supplied by Core. With no prior session it starts fresh; with a prior
  session reference it must restore continuous model context. Recovery failure
  fails loud and must not silently start fresh. Continuity is a mandatory
  Provider semantic rather than an optional capability or separate `resume`
  method. Before Core admits the first submission, `start` must report whether
  the actual launch was fresh or resumed so Dispatcher restart notification
  remains correct; no separate `wasCheckpointResumed` query survives.
- `stop` retains the current synchronous input fence and convergence guarantee
  for every admission that began before the fence.
- Runtime status and checkpoint transitions have one authoritative direction:
  Runtime pushes them into a Core-owned state sink supplied in the create
  context. The live handle no longer exposes `getStatus`, `getCheckpoint`, or
  `wasCheckpointResumed`, and Core reads its own state projection.
- The live handle also drops zero-consumer `getContext`, handle-level
  `getCapabilities`, and duplicate `providerRef` members.
- The live handle drops `waitIdle`. Team dissolve does not wait for or derive a
  provider-native idle state. Dissolve intentionally terminates active runtime
  work immediately, relies on the normal runtime stop fence and convergence
  contract, and then cleans resources. Scheduler submits each due fire
  immediately through the normal Core admission path without a busy check,
  idle wait, held-fire delay, or independent-turn guarantee. Provider-native
  folding or steering into the currently active turn is explicitly allowed.
- Structured output is mandatory for every Provider. Every runtime must honor
  the neutral output schema supplied by Core; it is not feature-gated, and the
  current `structuredOutput.supported`/`scope` capability advertisement is
  removed.
- System-prompt delivery retains the neutral `{ replace?, append? }` pair. For
  a Dispatcher, Core supplies both the complete replacement instructions and
  the focused append instructions; each Provider selects the native form it
  supports. For a TeamLeader, Core supplies only append instructions and every
  Provider appends them. Ordinary TeamMate and team-member identity guidance,
  plus Workflow or other operation-owned guidance, also remains ordered
  append-only input. The current owner-defined ordering is preserved:
  operation-owned fragments precede the persisted identity fragment. Core must
  not branch on a concrete Provider id to make this choice, and a Provider must
  not apply both forms when `replace` is present.
- Core persists or deterministically reconstructs prompt sources and re-supplies
  the selected ordered fragments whenever it rebuilds a runtime context:
  initial creation, close/reopen, process restart, Team rebuild, and runtime
  resume. Providers map that value to their native start/resume mechanism and
  own idempotence against native persistence. They must not assume a resumed
  native session retained prior append guidance or hide the prompt source in
  Provider-owned state.
- Live activity reporting is optional. A runtime may emit transient assistant
  message and tool-call facts through the Core-supplied activity sink. A
  runtime that emits none still executes and settles turns normally; its COT
  display and corresponding live activity events are simply absent.
- The optional activity sink is a real-time projection path; the mandatory
  recent-activity reader is stable progress inspection. They share the neutral
  Activity Record vocabulary where applicable, but a transient sink update is
  not required to have a one-for-one durable reader record and the reader is
  not a replay source for the event stream.
- Resume continuity and neutral turn reading are mandatory elsewhere in this
  contract. Context-window reporting is removed because Core has no consumer.
- TeamMate `last` remains a required Dreamux progress-inspection capability for
  Dispatcher and TeamLeader. Its primary user story is observing what a
  TeamMate has done recently while one active turn may run for tens of minutes
  or longer without completing. Dreamux execution status is obtained through
  the separate status capability; `last` neither reconstructs nor returns that
  Core-owned status.
- Every Provider therefore implements a mandatory neutral recent-activity read
  capability. It reads stable records from the current native session history,
  including records already written by an in-progress turn; it must not wait
  for a turn-completion boundary before returning useful progress.
- The public result is record-oriented rather than completed-turn-oriented.
  It returns a bounded recent tail in chronological order with an opaque cursor,
  truncation, and typed public failure reasons. Each Provider projects its
  native records into one unified Dreamux Activity Record model; Provider-native
  JSONL lines and record formats are never returned directly. Provider internals
  may read a native transcript file, remote history API, database, or another
  source, but raw storage paths and provider-native record formats do not enter
  the Core seam. The public records expose assistant messages plus tool name and
  lifecycle status. Tool input arguments and tool output content are not exposed.
  Tool records are included by default, while the caller may request that they
  be omitted as a group. The exact public method name and field schema remain
  technical solution choices.
- The activity reader does not synthesize Core admission or settlement facts.
  It does not require canonical failed, stopped, or ambiguous outcomes, and its
  output is never a live settlement source or a replacement for Core status.
- Core supplies neutral runtime/session identity and provider config/context to
  the activity reader. Names such as `transcript_locator`, literal host output
  budgets, native scan modes, and provider filesystem assumptions are removed
  from the Provider seam.
- The required Provider capabilities are derived from the settled Team and
  TeamMate MCP behavior, including creation, role/tool availability, turn
  submission and settlement, close/dissolve safety, reopen continuity, status,
  and `last`; the current Provider type is not treated as the requirements list.
- Core must not branch on concrete provider ids or import provider
  implementations.
- Provider-level `getCapabilities` is retained as a discovery/description
  surface. Dreamux uses it to enumerate each Provider's public configuration
  characteristics, selection metadata, and tags. It does not duplicate live
  runtime state; context-continuous recovery and structured output are
  mandatory rather than optional capability bits. Optional activity reporting
  requires no preflight bit because absence only suppresses live projection.
- The exact provider facade and composition of optional capabilities remain
  open during clarification.

### External target lifecycle without a Core Collaboration Space

- Dreamux Core no longer defines or persists a Collaboration Space container.
  Team is the only Core container used to represent an automatically created
  external collaboration target. The Core Collaboration Space service, state,
  commands, reads, target claims, binding events, and public types are removed.
- Removing the Core container does not remove the external product story.
  Feishu Channel exposes Dispatcher-only MCP operations to bind/unbind/list/read
  a Feishu container as a Collaboration Space. That label denotes a
  Channel-owned automatic-provisioning policy and target hierarchy, not a Core
  entity. Binding the space persists the Feishu container identity plus Team
  creation policy in Channel state; later unmatched child targets provision and
  bind ordinary Teams through generic `team.create` and `team.submit` Commands.
- External target creation is a real Channel-owned input. A supporting Channel
  owns the policy, the provider-specific target identity, and the binding. The
  automatic provisioning that composes them is volatile execution, not durable
  product state: the Channel invokes the ordinary public `team.create` Command,
  persists the resulting `team_name` as its active binding once the Team is
  ready, and only then invokes ordinary turn submission for the first message.
  It persists no provisioning record, phase, saga, outbox, recovery cursor, or
  target-interruption marker, and it runs no restart-resume scan.
- Losing the process loses the unfinished operation and nothing else. A restart
  recovers exactly what was already persisted: the Team records Core owns, the
  Channel's Collaboration Space policy, and its completed bindings. A Team that
  was created but never bound stays as an accepted orphan Team — it is a real
  Team, reachable by name, simply with no route to it. A first message that was
  not submitted before the crash is lost, and a later message on that target
  follows the still-persisted Space policy as an ordinary new provisioning.
- A retried `team.create` for the same accepted request must not create a
  second Team. The generic Team creation capability therefore exposes a
  transport-neutral request identity, which Core stores together with the
  canonical payload hash in the Team record itself. A valid, readable Team
  record is the sole proof that a Team exists, the sole durable owner of its
  concrete name, and the sole durable authority for accepted `team.create`
  idempotency. Core does not persist a separate request ledger, name claim, or
  name tombstone.
- Publishing the Team record through an exclusive atomic create is the
  acceptance point. Before that record exists, the Team was not created, the
  request was not accepted, and its generated candidate name remains free; a
  retry may allocate a different candidate without creating a duplicate Team.
  After publication, the same request id and payload hash resolve to that Team,
  including after restart or closure, while the same id with a different hash
  fails with an idempotency conflict.
- Idempotent `team.create` is a Core-side guarantee about one Command, not a
  Channel-side resume mechanism: it is what makes a Channel's own retry safe,
  and it does not authorize persisting the attempt that produced it.
- Core reconstructs its process-local request-id index by scanning Team records.
  Missing, malformed, or unreadable Team records are treated as nonexistent for
  lookup, routing, and name allocation: they cannot receive a turn, do not
  reserve their path-derived name, and produce `TEAM_NOT_FOUND` rather than a
  phantom route. A real persistence failure while publishing a new record still
  fails creation normally.
- TeamLeader identity and every other file below a Team scope are subordinate to
  that valid Team record for Team existence. When no valid record exists,
  leftover identity, scheduler, workflow, or member state is orphan data: it
  does not prove a Team exists and cannot reserve the concrete name. Likewise,
  a cached in-memory Team snapshot may not overwrite an invalid record and
  resurrect a Team that the durable authority says does not exist.
- Closed Teams and closed TeamMates exist only as persisted records. Collection
  caches contain live entity objects only; list, status, history, and other
  reads load `TeamRecord` or Agent Identity data into plain projections without
  constructing `TeamService` or `TeammateService`. Process startup likewise
  never rebuilds a closed entity. A closed Team is never materialized again,
  including for `cleanup-pending` worktree recovery: that maintenance reads and
  patches the stored record directly. Only `send` may lazily construct a closed
  TeamMate, and it does so as part of reopening that TeamMate into a live entity;
  no other read, recovery, or mutation creates it. The Collection publishes the
  object only after that reopen succeeds and never caches an object that remains
  closed. This bounds live memory by active entities rather than the lifetime
  number of historical records.
- The Team record and TeamLeader identity have different, deliberately narrow
  authority. The Team record owns Team existence, Team lifecycle, `leader_name`,
  and only the stable Team-owned creation inputs needed to ask `TeamMateService`
  to create a missing leader. Those inputs include the normalized TeamLeader
  identity prompt and normalized skill sources originally accepted for the Team.
  It does not mirror Provider session state or mutable Agent lifecycle fields.
  The TeamLeader identity owns the TeamLeader's actual Agent state and is the
  only input from which an existing TeamLeader runtime is reconstructed. An
  aligned identity is restored exactly and is never overwritten or compared
  against the Team record's creation-input copy.
- An Agent identity does not persist `role`. Runtime ownership already supplies
  that fact without ambiguity: `DispatcherService` owns the Dispatcher Agent,
  its `TeammateCollection` owns Dispatcher-scoped TeamMates, `TeamService` owns
  the TeamLeader, and its `TeammateCollection` owns Team-scoped TeamMates. The
  directory hierarchy encodes the same scope. `team_member` is not a Dreamux
  entity or vocabulary and is removed without a compatibility alias.
- Persistence roots are bound when those owners are constructed. From
  `{DREAMUX_HOME}/state/{dispatcher_id}`, `DispatcherService` owns its root Agent,
  its `TeammateCollection` owns `teammate/`, and its `TeamCollection` owns
  `team/`. Each `TeamService` owns `team/{team_name}`, its TeamLeader uses that
  same Team root, and its `TeammateCollection` owns
  `team/{team_name}/teammate/`. An individual collection appends only the entity
  name to its already-bound root. No Agent identity field participates in path
  selection.
- Identity storage APIs therefore operate on an entity directory or a
  construction-bound collection root supplied by the owner. They must not
  accept `dispatcher_id`, `team_id`, `role`, and `name` as a locator tuple and
  re-derive a path from persisted contents. Read, create, update, and recovery
  all use the same owner-bound location.
- Core validates only the minimum persisted ownership link needed to know that
  an identity belongs to the TeamLeader: `dispatcher_id`, `team_id`, and
  `name === team.leader_name`. It does not compare or synchronize every identity
  field with Team state. When the identity is readable and that link agrees,
  Core preserves it exactly and asks `TeamMateService` to restore the TeamLeader
  from the identity.
- When runtime behavior needs an entity role for prompt/skill composition,
  completion routing, validation, or event presentation, the owning Service or
  Collection supplies the derived value `dispatcher`, `team_leader`, or
  `teammate`. That runtime projection is never written back into identity.
- When an active `starting` or `running` Team has no usable aligned TeamLeader
  identity, the Team record still decides that the Team and its leader should
  exist, but the Team layer must not construct or persist an identity itself. It
  invokes the ordinary `TeamMateService` creation path with the Team-owned leader
  creation inputs; that service creates and persists the identity as part of
  creating the TeamLeader, then starts the runtime from its own identity. A
  malformed or ownership-mismatched identity is replaced only through that same
  TeamMate-owned creation path. A `starting` Team becomes `running` only after
  the leader is usable; a `running` Team restores its leader; a `closed` Team
  never restarts one. This is aggregate reconciliation through the existing
  owner, not direct cross-store repair, a separate durable recovery coordinator,
  or another state authority.
- Records produced before this final shape are outside the task contract. Missing
  TeamLeader identity-prompt or skill-source fields are treated as empty values;
  Dreamux does not backfill them from an aligned Identity and does not block the
  Team on their absence. No upgrade-time compatibility behavior may become a
  second authority or complicate the fresh-install design.
- The canonical `team.create` Command preserves the complete transport-neutral
  repository capability already available through `admin.sock`. Its repository
  request is a discriminated union: `reuse-cwd` may reuse a specified or default
  working directory, while `managed` may specify `path`, `base_ref`, `branch`,
  `slug`, and `cleanup`. Omitting the repository request keeps the existing
  default workspace behavior. This shared Command must not be narrowed to the
  smaller subset currently needed by Feishu.
- Feishu automatic provisioning owns only a repository path and base reference.
  It translates that local policy into the canonical `managed` request and
  always supplies `cleanup: "delete-on-close"`; it does not expose or infer the
  advanced repository controls, so automatic provisioning does not leave managed
  worktrees permanently on disk. This fixed Feishu mapping does not narrow the
  generic Team MCP or `admin.sock` creation surfaces: both retain the complete
  canonical repository union and honor the caller's explicit cleanup policy.
- A Channel serializes its own concurrent work per target in memory, which is
  what preserves one-Team creation and ready-before-first-delivery within a
  process. Nothing about that serialization is durable, and no Core
  target/claim/generation model replaces it: an operation interrupted by a
  restart is simply gone.
- Provisioning creates an ordinary Team plus one Channel-owned default binding;
  it does not create an exclusive ownership relation between the external target
  and the Team. The default binding can be removed independently. The Team may
  remain alive with no bindings, and a later message from the same now-unbound
  target may provision a different Team. Unbound Teams are normal and require no
  orphan cleanup policy.
- A provider may react to target closure when its platform exposes that fact by
  generation-checking and removing its own binding. Target closure does not by
  itself dissolve the Team or imply `force`. Feishu's lack of a close signal
  does not require a fake callback.
- A Team may have bindings in multiple targets or Channels. When the Team itself
  is dissolved, every Channel invalidates all bindings that reference its stable
  `team_name`; this is a consequence of Team closure, independent of which actor
  requested dissolve. The in-process lifecycle-coupled Channel consumes the
  Team-close fact and updates its own authoritative local binding state. There is
  no independently offline Channel, startup Team-read reconciliation, remote
  state synchronization, or replay protocol.
- Automatic-provisioning policy is Channel-owned configuration. The current
  Core-owned Collaboration Space policy block is removed as an incompatible
  configuration change; its provider-specific replacement and operator rebuild
  instructions belong to the owning Channel and the breaking change record.
- The current dedicated `targetLifecycle`, `ensureCollaborationTarget`, and
  `deliverExact` callbacks are deleted rather than translated into Core
  Commands. Their user-visible effects compose from Channel state plus generic
  Team and turn Commands.

### Immediate Team dissolve

- Team dissolve is a destructive stop-and-reclaim operation, not a graceful
  drain. It never waits for an active turn to finish naturally and never exposes
  Provider or Core idle detection. Its first runtime action is to fence new work
  and stop the relevant Workflow and TeamMate runtimes so unfinished turns cannot
  continue consuming tokens.
- Dispatcher-triggered dissolve performs a non-destructive managed-worktree
  cleanliness preflight before stopping the Team when `force` is false. A dirty
  or unmerged worktree makes the submitted background operation refuse to close
  the Team without partially dismantling it. Once the preflight passes, Core
  stops Workflow, every TeamMate, and the TeamLeader and converges their
  admissions and settlements.
- TeamLeader self-dissolve first stops its Workflow and every TeamMate, then
  checks the managed worktree while the TeamLeader remains only long enough to
  submit the dissolve operation. A dirty or unmerged worktree is the only
  non-forced blocker inside that background operation. The MCP submission
  receipt returns before Core stops the TeamLeader runtime, so self-dissolve
  does not depend on delivering a tool result from a process that has already
  been terminated.
- A successful dissolve invocation returns as soon as Core has validated the
  caller and submitted one background dissolve operation to the Team. It does
  not wait for worktree assessment, Workflow/TeamMate/TeamLeader stop, durable
  logical close, or physical worktree removal. This submission boundary keeps
  the MCP call below Agent Runtime tool timeouts and lets self-dissolve answer
  before its own runtime is stopped. The receipt reports submission, not a
  premature `closed` fact.
- The background operation performs the required cleanliness checks, stops the
  child processes, commits logical close, and then continues any
  `cleanup-pending` physical removal. A later refusal or failure leaves the Team
  open and is logged; it does not retroactively change the already-returned
  submission receipt or require a durable dissolve-phase state machine.
- The dissolve surface adds `force`. For an owned managed worktree, `force: true`
  explicitly authorizes discarding uncommitted, untracked, or unmerged local
  changes so the worktree checkout can be removed and cannot remain as permanent
  disk usage. It does not authorize deleting the managed Git branch or committed
  history.
- `force` never permits deletion of a reused cwd, source repository, repository
  root, or any workspace not owned as this Team's managed worktree. Target
  resolution and containment checks remain fail-loud before destructive cleanup.

## Scope

- Public Agent Runtime declarations in `@excitedjs/dreamux-types`.
- Core provider loading, runtime ownership, launch adaptation,
  submission/settlement consumers, transcript consumers, and capability
  negotiation.
- Public Channel provider/session declarations, Core event distribution,
  Channel inbound routing, Channel-owned external-target provisioning, and
  provider-owned Channel MCP forwarding.
- Removal of the Core Collaboration Space domain, persistence, public types,
  commands, reads, events, routing callbacks, tests, and maintenance/docs
  surfaces. Team remains the only Core collaboration container, while the
  Feishu Channel retains the external Collaboration Space MCP workflow and owns
  its replacement policy/state.
- Removal of the Core binding store and Team binding surfaces; Channel-owned
  binding persistence, provider tools, state migration, tests, and public
  documentation.
- Contract fixtures, architecture gates, built-in provider adaptation, and Rush
  change files required by the final public contract. Migration or rebuild
  handling for superseded local Dispatcher/Team/Agent state is out of scope.

## Non-goals

- Reducing Channel product responsibility or adding a Web UI/TUI as an
  alternate external interaction surface.
- Standardizing how a Channel parses external messages, detects intent, or
  selects a Core Command.
- Preserving each current `ChannelRoutes` callback as a same-shaped Command, or
  using an existing Channel implementation as the authority for the Core
  capability catalog.
- Moving Dreamux state ownership or Command implementation into a Channel.
- Making Core understand Feishu, Slack, Telegram, or another provider's binding
  metadata.
- Preserving a single `team.list` response that joins authoritative Team state
  with authoritative binding state owned by one or more Channels.
- Removing Channel-owned input validation, platform authorization, or inbound
  access/trust policy when removing Core's binding-scoped outbound restriction.
- Preserving source compatibility for the `transfer_back` tool name.
- Preserving source compatibility for the rewritten Agent Runtime or Channel
  Provider contracts, or adding a temporary forward-compatibility adapter.
- Preserving, importing, backfilling, or migrating local state written by an
  older Dreamux design. The target state layout and schemas are evaluated as a
  fresh installation.

## Constraints and invariants

- Core remains behind provider-neutral Agent Runtime and Channel seams.
- A mandatory member must represent a capability every supported provider
  necessarily supplies and Core necessarily consumes.
- Optional capability absence must not require a fake implementation merely to
  load a provider and must fail clearly when explicitly requested.
- Agent admission ambiguity, immutable submission identity, settlement, stop
  fencing, and completion-delivery ordering remain intact.
- Channel Command results preserve the current ambiguity rule: a request whose
  admission may have crossed the boundary must not be reported as safely
  retryable.
- Channel binding state has one authority: the configured Channel instance.
  Core must not retain a second binding projection or query Channel to
  reconstruct one.
- Channel event observation remains read-only and fail-open relative to
  authoritative Core operations.
- Adding a Core Command or Core event must not widen the base Channel
  provider/session interface.
- Every public Core Command must be justified by a Core-owned domain capability
  and remain independent of the Channel or transport that invokes it.
- Every externally observable Core event must be justified by a stable
  Core-owned fact and remain independent of the Channel that consumes it.
- Incompatible public package contracts still receive the required Rush change
  records. This task does not add compatibility or rebuild machinery for old
  local runtime-state shapes; fresh-install state is the only accepted model.

## Acceptance criteria

- A minimal external-runtime fixture loads and executes a turn without
  implementing non-universal operational capabilities.
- Every mandatory provider/runtime member has an unconditional Core consumer
  and a documented provider-neutral invariant.
- Optional runtime capabilities can be absent without no-op methods; Core fails
  clearly only when a caller requests an absent capability.
- Existing runtime admission, settlement, stop fencing, completion routing, and
  supported activity delivery remain correct.
- Agent Runtime `submit` accepts only prepared text and has no source id or
  source-derived `duplicate` result. Core preserves public duplicate behavior
  through one globally bounded Dispatcher-lifetime admission ledger keyed by
  target entity plus optional `sourceId`.
- Every supported Provider honors neutral structured-output schemas. Workflow
  does not depend on a provider capability advertisement or fail as an
  unsupported feature solely because a different Provider is selected.
- Dispatcher system-prompt behavior remains runtime-correct without a Core
  Provider-id branch: Codex replaces its base instructions from `replace`,
  Claude Code appends the focused Dispatcher delta from `append`, and neither
  duplicates both forms. TeamLeader instructions are append-only for both
  built-in runtimes. Ordinary TeamMate and team-member identity guidance and
  Workflow/operation-owned guidance remain ordered append-only fragments, with
  operation fragments before persisted identity guidance.
- Fresh launch, close/reopen, process restart, Team rebuild, and runtime resume
  all re-supply append-only prompt fragments from Dreamux-owned durable or
  deterministic sources. Codex passes them as `developerInstructions` on
  `thread/start`, `thread/resume`, and resume-fallback `thread/start`; Claude
  Code passes them through `--append-system-prompt` on every fresh or resumed
  resident-process spawn. Neither Provider relies on native session retention.
- The minimal live runtime handle implements only `start`, text-only `submit`,
  and `stop`; Core status/checkpoint reads come from the Core-owned
  state projection populated by the push sink.
- No Provider or live runtime exposes `waitIdle`, and neither scheduler nor
  Team dissolve waits for or derives an idle state before continuing. Dissolve
  immediately stops active work; safety is provided by the mandatory stop fence,
  convergence guarantee, trigger-specific worktree check, and owned-worktree
  containment. Non-forced dirty/unmerged cleanup blocks, while `force: true`
  discards local changes only in the owned managed worktree. The invocation
  returns after submitting the background operation, before assessment, stop,
  logical close, or physical deletion. Self-dissolve can therefore return its
  submission receipt before Core terminates the caller runtime.
- A scheduled fire submits at its due time even when another turn is active. It
  may fold into that turn and share its native completion boundary. Scheduler
  does not implement busy-only deferral or missed-fire behavior; proven
  pre-admission failures and admission ambiguity retain their normal generic
  submission semantics, including no retry after ambiguity.
- Closing and later sending to a TeamMate restores its prior model context for
  every supported Provider; a provider cannot advertise a non-resumable mode or
  silently replace recovery with a fresh session.
- No Core production path branches on a concrete Agent Runtime provider id.
- Contract tests distinguish the minimal runtime base from each optional
  capability and reject silent capability downgrades.
- TeamMate `last` works for every supported Agent Runtime during a long-running
  active turn and after the live runtime closes through the mandatory neutral
  recent-activity reader. It returns recent stable activity without requiring a
  completed-turn boundary. Results contain assistant messages and tool
  name/status records, never tool inputs or outputs; callers may omit all tool
  records. Core never parses a runtime-native transcript format.
- `Runtime.getContext()` and handle-level `getCapabilities()` are absent from
  the target contract because they have no production Core consumer.
- Provider-level `getCapabilities()` remains available for Provider discovery,
  public characteristics, and tags. The structured-output `scope` field is
  absent: recovery and structured output are mandatory, while activity
  reporting is optional and requires no preflight query.
- A minimal Channel fixture can be directly constructed/started/stopped,
  invoke Core Commands, and receive Core events without Team-, worktree-, or
  provider-specific base methods.
- The final unified Command catalog is traced to Core-owned domain use cases,
  organized by domain namespace, and shared without drift by the `admin.sock`
  and Channel adapters; it is not a one-for-one rewrite of current Channel
  callback members.
- Every surviving registered Command is invocable through both `admin.sock` and
  Channel `invoke`, with no exposure policy. The Feishu Channel implementation
  in this refactor invokes only external `team.submit` and restart-durable
  idempotent `team.create`; Team, TeamMate, Workflow, scheduler, dispatcher, and
  server Commands remain available through the same port without requiring
  Feishu to consume them.
- The final event catalog is traced to stable Core facts rather than the needs
  of a concrete Channel implementation.
- The initial event catalog contains only Team state, the unified
  `teammate.state`, and the namespaced `teammate.turn.*` lifecycle/activity
  facts required by binding invalidation and current COT. It adds no Workflow,
  scheduler, binding, Collaboration Space, or other internal capability event.
- Adding a Channel-originated Core capability or a Core event changes only its
  catalog/schema and consumers, not the base Channel interface.
- Event subscribers receive live facts only. Core has no event replay/snapshot
  requirement and persists no message/tool event-content history.
- Existing normalized Provider activity, Core projection,
  redaction/truncation, payload behavior, and Channel display remain unchanged;
  the turn event kinds move under `teammate.turn.*`. Tests
  preserve the post-COT baseline and prove observer failures cannot affect turn
  admission or settlement.
- Channel keeps presentation anchors locally. Submitted events return
  `team_name`, Agent identity, and `turn_id`; later events correlate by
  `turn_id`. Core carries neither `ChannelOrigin` nor presentation correlation.
- A Channel with no MCP tools does not implement fake MCP members. Live and
  sessionless provider MCP tools remain functional when declared.
- A binding-capable Channel persists and resolves its own provider-specific
  routing state without exposing external identifiers or matching rules to
  Core.
- An automatic-provisioning Channel persists only its Space policy and its
  completed bindings; it uses restart-durable idempotent `team.create`, binds
  only after Team readiness, and submits the first message only after binding.
  An interrupted provisioning leaves at most an accepted orphan Team and a lost
  first message, and is never resumed. Core contains no Collaboration
  Space object, external target claim, or collaboration binding event.
- Dispatcher can call Channel-owned `bind_channel`, `unbind_channel`, and
  `list_bindings` through the existing MCP proxy. Feishu also provides
  Dispatcher-only `bind_collaboration_space`, `unbind_collaboration_space`,
  `get_collaboration_space`, and `list_collaboration_spaces` tools backed only
  by Feishu Channel state and generic Team Commands. Team MCP and Core admin
  methods no longer expose `bind_channel`, `transfer_back`, or
  `collaboration_space.*`.
- Channel submits a resolved stable `team_name` for TeamLeader delivery and
  omits it for Dispatcher delivery. Unmatched inbound reaches the Dispatcher
  Agent, and a stale target may fall back only after a typed pre-admission
  rejection.
- Binding-only reads require one `list_bindings` call per relevant Channel.
  Cross-domain views intentionally join Channel binding reads with Core Team
  reads rather than creating a duplicate Core binding index.
- TeamLeader provider MCP calls are forwarded without binding-owner or
  message-to-target proof, while provider schema checks and platform errors
  remain intact.
- `resolveTarget`, `messageBelongsToTarget`, direct `reply?`/`react?`, and the
  dedicated growing `ChannelRoutes` callbacks are absent from the final base
  Channel contract.

## Confirmed operator decisions

- This is an Architecture-domain task; the changed package does not determine
  task ownership.
- `dispatcher.stop` is not a product capability and is removed from the shared
  Command registry, admin-socket mapping, and CLI. `dispatcher.start` is only an
  initial activation control, not one half of a stop/restart lifecycle. Daemon
  shutdown still stops owned resources internally as part of process teardown.
- A Team owns its repository/worktree record. TeamLeader-created TeamMates are
  CWD-only borrowers of the Team runtime directory: their identities use the
  neutral `reuse-cwd`/keep representation and never copy the Team's managed
  worktree identity or cleanup result. Closing one such TeamMate cannot clean
  the Team worktree. Dispatcher-scoped TeamMates may still independently own a
  managed delete-on-close worktree, whose metadata remains in their own
  identities so `send` can reprepare it after close.
- Team dissolve must promptly close every materialized member through its
  `TeammateService`, stopping its runtime and preventing background turns or
  token use. A non-materialized member has no runtime in the current process;
  its Team-scoped Collection writes the existing Identity directly to `closed`
  with the dissolve timestamp and note instead of constructing a Service.
  Already-closed records remain unchanged. This bulk operation is internal to
  the Team-owned Collection and is not a Dispatcher-facing capability.
- The Agent Runtime provider contract must converge on an absolute minimum
  necessary set.
- The live Agent Runtime execution base is `start`, flat text `submit`, and
  `stop`. Separate channel/plain-text input methods and their replacement
  discriminator are removed.
- `team.submit` is one content Command with optional target, attributes,
  reminder, intent, and source identity fields. Channel owns external-message
  interpretation and body formatting and supplies its attributes and reminder
  through this Command; those fields are part of the canonical boundary rather
  than a Stage 5 extension. `TeammateService` owns the paired source envelope
  and Agent Runtime receives only final text.
- Channel supplies `team_name` when it selects a TeamLeader and omits it when it
  selects the Dispatcher Agent; `admin.sock` follows the same target semantics.
  Channel presentation closes locally: the invoking session binds its visible
  anchor to the exact returned `turn_id` and matching submitted event, whether
  the recipient is Dispatcher or TeamLeader. Core carries no `ChannelOrigin`,
  opaque presentation correlation, or separate `turnOrigin`.
- Model-input source names remain open. Channel Command and `admin.sock` inputs
  use `channel`; Agent-facing MCP spawn/submit inputs default to `task`; model
  completion delivery defaults to `task-notification`; Dispatcher restart
  notification alone uses the Core-reserved `system` source.
- Model-input attributes use `Readonly<Record<string, string>>`. They carry no
  semantic ordering, cannot contain duplicate names, keep names open subject to
  start-tag safety validation, rely on TeammateService for attribute-value
  escaping, and default to the empty set when omitted.
- `source_id` and the public `duplicate` result are Core admission semantics.
  Agent Runtime `submit` receives no source id and its admission union contains
  no source-derived `duplicate` branch.
- Runtime status and checkpoint transitions are push-only into Core-owned
  state. The live handle does not duplicate them with pull queries.
- Structured output is mandatory for every Provider and is part of the neutral
  submission/start contract rather than a capability bit. The current
  structured-output `scope` field is removed.
- The neutral create context keeps `systemPrompt` as
  `{ replace?: string; append?: readonly string[] }`. Dispatcher construction
  supplies both forms so Codex can replace its base instructions and Claude
  Code can append only the focused role delta. TeamLeader construction supplies
  append only, and both built-in runtimes append it. Ordinary TeamMate and
  team-member identity prompts plus Workflow and other operation-owned prompt
  fragments also remain append-only in their existing owner-defined order:
  operation fragments first, persisted identity last. This behavior is selected
  inside the Provider adapter, never by a Core branch on Provider identity.
- Dreamux owns every durable or deterministic append-prompt source and
  re-supplies the ordered fragments on initial creation, close/reopen, process
  restart, Team rebuild, and runtime resume. Codex receives them again as
  `developerInstructions`; Claude Code receives them again through
  `--append-system-prompt`. Provider-native session history is not authority for
  whether the guidance survives.
- Provider-level `getCapabilities()` is retained for Provider enumeration and
  public discovery metadata, including tags. Live runtime
  `getCapabilities()` remains deleted.
- Activity reporting is optional. A Provider that emits no activity remains a
  valid Provider; Dreamux omits COT message/tool display for its turns without
  changing admission or settlement.
- Existing COT presentation is unchanged. Providers emit the current normalized
  real-time activity shape; Core applies the current projection, redaction, and
  truncation and publishes best-effort live `teammate.turn.message` /
  `teammate.turn.tool_call` events. No retry, replay, retention,
  acknowledgement, or delivery guarantee is added, and Channel observation
  remains fail-open.
- Provider `waitIdle` is removed without a replacement idle query or derived
  idle state. Scheduler submits every due fire immediately through normal
  admission and allows Provider-native folding into active work; it has no
  held-fire idle delay or independent queue guarantee. Team dissolve is
  immediate and destructive: it stops child work before further
  cleanup, does not wait for any active turn, and supports an explicit `force`
  flag for discarding local changes in the Team-owned managed worktree.
- TeamMate `last` is mandatory for Dispatcher and TeamLeader progress
  inspection, while native `readTranscript` is not accepted as its public
  abstraction. Every Provider instead implements a neutral record-oriented
  recent-activity reader that includes stable records from the currently active
  turn and returns unified Dreamux Activity Records containing assistant
  messages plus tool name/status, without tool input/output; Dreamux status
  remains a separate Core capability.
- Closed-TeamMate context continuity is mandatory for every Provider. `start`
  handles both fresh and existing-session launch, and a failed recovery never
  falls back silently to a fresh context.
- Channel is Dreamux Core's only external interaction path; its
  responsibilities may expand while its Interface contracts.
- External message processing and Core Command selection are Channel-internal
  responsibilities.
- Core capabilities and observable facts are designed first and independently
  of Channel differences. Channel ports are adapters to that Core-owned catalog;
  current Channel call sites do not define it.
- Channel and `admin.sock` invoke the same complete Core Command registry. No
  exposure policy or per-transport allowlist exists; transport identity is
  execution context rather than catalog filtering.
- Workflow, scheduler, TeamMate, Team, dispatcher, and server operations already
  represented as Commands are callable through that shared registry. This does
  not require corresponding Core events, and configuration/onboard/diagnostic
  control-plane operations that are not Commands stay outside it.
- The Feishu Channel work in this refactor calls exactly external `team.submit`
  plus restart-durable idempotent `team.create` for automatic provisioning. The
  initial event catalog is the Team aggregate state, unified TeamMate state, and
  namespaced TeamMate turn facts needed for binding invalidation and the frozen
  post-COT presentation. The generic ports are intentionally extensible, but no
  speculative Command or event is added.
- Channel uses one generic request/response Command invocation primitive toward
  Core; Core uses one event-delivery primitive toward Channel.
- Direct Provider control/lifecycle and optional Channel MCP
  registration/forwarding are separate mechanisms from those two primitives.
- External-route binding is Channel-owned rather than Core-owned. Channel owns
  provider-specific target matching, hierarchy, persistence, and migration,
  then submits the resolved Dreamux `team_name` to Core for TeamLeader delivery.
- Bindings may target TeamLeaders only; arbitrary TeamMate binding is excluded.
- Unmatched inbound is submitted to the Dispatcher Agent. Stale bindings may
  fall back to Dispatcher only after a proven pre-admission target rejection,
  never after an ambiguous admission.
- Dispatcher invokes Channel-owned `bind_channel`, `unbind_channel`, and
  `list_bindings` through Channel MCP. Team MCP/Core binding operations and the
  old `transfer_back` name are removed without an alias.
- Binding lists are read from their authoritative Channel. A view combining all
  Team state with bindings performs separate Team and Channel reads; Core does
  not query Channels or mirror their bindings to preserve a one-call join.
- Dreamux Core's binding-scoped TeamLeader Channel-tool outbound restriction is
  removed; it was not an operator requirement.
- The target design has no general Core-to-Channel query port.
- External target creation remains a supported input. Target closure remains a
  provider-neutral optional input even though Feishu cannot currently produce
  it.
- Core Collaboration Space is deleted. Channel composes the same external
  product effect by creating and binding ordinary Teams through generic Core
  Commands; all target provisioning state and recovery live in Channel. Feishu
  retains a dedicated Dispatcher-facing Collaboration Space MCP suite as the
  explicit entry point for registering and inspecting that Channel-owned
  provisioning policy.
- Automatic provisioning creates a normal Team and a removable default binding.
  Removing or closing the external target removes that binding without
  dissolving the Team; unbound Teams are ordinary supported state. Dissolving a
  Team invalidates all Channel bindings that reference its stable `team_name`.
- Core events are real-time only, without replay or subscribe-time snapshots.
  Only critical operational logs are retained; Core does not locally persist
  other message/tool event contents.
- Channel and Core are lifecycle-coupled in the same process. Channel restores
  its own authoritative local state on process start; Dreamux does not design an
  independent Channel reconnect, remote synchronization, or event-replay model.
- The full Provider/Channel rewrite is intentionally incompatible. No legacy
  contract adapter, forward-compatibility path, or old-name alias is designed.
- The refactor starts from the post-COT `next` baseline on a dedicated branch.
- Product code remains unchanged until the requirement and technical solution
  are finalized and the operator explicitly grants development approval.

### Feishu bot self-identity recovery

- Feishu resolves its own bot `open_id` before applying the inbound group
  mention gate. A successful result may be cached for the Channel process
  lifetime.
- A failed request or a response without `open_id` is not a resolved identity
  and must not become a negative cache entry. While identity remains unresolved,
  the next inbound chat message retries the lookup before that message reaches
  the mention gate; a successful retry applies to that same message and all
  later messages.
- Concurrent inbound messages share one in-flight lookup. A failed retry leaves
  identity unresolved so a later message can try again. The Channel remains
  fail-closed for the current message when identity is still unavailable.
- This is process-local transport state only. It adds no persisted state,
  configuration, replay queue, or independent Channel recovery protocol.

## Open technical design decisions

- The exact Provider-level `getCapabilities()` discovery schema, including tag
  vocabulary, which public configuration characteristics are safe to expose,
  and whether the result is Provider-static or resolved against parsed Provider
  config. Raw secrets and private environment values must never be exposed.
- After the minimum product-visible Activity Record content is fixed, the exact
  neutral method name and query/result/error/session-reference contract,
  pagination over an actively growing session, field schema, bounds, and
  migration from `readTranscript` remain technical choices. The decision to
  return unified Activity Records rather than Provider-native lines is final.
- The remaining minimum neutral role/tool launch context required for
  TeamLeader and TeamMate operation, including Dreamux tool injection, cwd, and
  recovery identity. System-prompt replace/append semantics are fixed above and
  are no longer an open design choice.
- Whether provider discovery, config parsing, onboarding, identity, and
  diagnostics remain on one facade or compose separately.
- The exact Channel lifecycle/control base members.
- The complete current `admin.sock` method inventory must be normalized into
  domain-owned Command names and schemas. The registry structure, typed
  invocation context, and adapter composition remain technical choices, but no
  second Channel catalog or exposure policy may be introduced.
- After the public event categories and visibility policy are fixed, their exact
  schemas remain a technical choice.
- The transport-independent Command/event catalog shape, versioning, validation,
  error envelope, authorization, idempotency, and in-process/admin adapters.
- The exact event subscription API, delivery guarantees, failure isolation, and
  shutdown fencing.
- The MCP catalog and handler types, caller context, and live/sessionless
  execution shape.
- Channel-owned binding state schemas, durability, concurrency, migration, and
  provider-specific tool contracts after the Core binding store is removed.
