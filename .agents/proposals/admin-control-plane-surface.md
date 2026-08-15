# Admin Control Plane Surface

- **Status:** Draft
- **Date:** 2026-07-14
- **Affects:** `/packages/dreamux/src/admin/`, `/packages/dreamux/src/mcp/`, agent identity/runtime creation, admin socket consumers
- **Issue:** [#295](https://github.com/excitedjs/dreamux/issues/295)

## Intent

Dreamux is becoming a component inside larger systems. The target external
control-plane entry point should be the local admin socket, not the stdio MCP
adapter surface. MCP remains a model-facing adapter that exposes a filtered
tool set, adapts model-friendly arguments, and may compose one or more admin
socket calls when that is the cleanest way to implement an MCP tool.

The admin socket should therefore use product/control-plane names and errors,
not MCP-specific names. The namespace slice removes the pre-stable `mcp.`
prefix from Team, TeamMate, and collaboration-space admin RPCs.

The same control plane must also support outbound events. A larger system
cannot integrate with Dreamux only by polling passive request/response methods;
it needs to observe state transitions such as submitted turns, settled turns,
Team/TeamMate lifecycle changes, channel route changes, scheduler fires, and
collaboration target lifecycle changes.

## Namespace Slice Status

The namespace-cleanup slice implements the canonical product method names,
removes the pre-stable `mcp.*` names and dispatcher mutation placeholders, and
keeps Dreamux-owned MCP shims on their existing model-facing surface. It also
adds admin-only custom skill roots to TeamMate and TeamLeader creation. The
event surface, protocol baseline, introspection, inventory, and authentication
work in this proposal remain future slices.

## Pre-Cleanup Admin Surface

Before the namespace slice, admin socket requests were one-line NDJSON RPC
envelopes with dotted lowercase
method names. The method registry lives in
[`/packages/dreamux/src/admin/methods.ts`](/packages/dreamux/src/admin/methods.ts),
and dispatch happens in
[`/packages/dreamux/src/admin/socket.ts`](/packages/dreamux/src/admin/socket.ts).
The current socket protocol is request/response only: protocol comments say
"one line in / one line out" in
[`/packages/dreamux/src/admin/protocol.ts`](/packages/dreamux/src/admin/protocol.ts),
and `processLine()` writes exactly one response for each request in
[`/packages/dreamux/src/admin/socket.ts`](/packages/dreamux/src/admin/socket.ts).

The non-MCP-prefixed methods were:

| Area | Methods | Notes |
|---|---|---|
| Server | `server.status` | Returns process status plus dispatcher summaries. |
| Dispatcher | `dispatcher.list`, `dispatcher.status`, `dispatcher.start`, `dispatcher.stop` | Dispatcher declarations are config-owned. The unsupported `dispatcher.add` and `dispatcher.remove` placeholders were deletion targets rather than product capabilities. |
| Scheduler | `scheduler.cron.list`, `scheduler.cron.create`, `scheduler.cron.update`, `scheduler.cron.delete` | Already scoped as a scheduler/admin capability rather than an MCP capability. |
| Channel tools | `channel.invoke_tool` | Generic provider-owned tool conduit. Provider tool metadata remains descriptor-owned; calls route through the live channel session and caller authorization. |

The pre-cleanup MCP-prefixed admin methods were:

| Area | Methods | Notes |
|---|---|---|
| TeamMate | `mcp.teammate.spawn`, `mcp.teammate.send`, `mcp.teammate.close`, `mcp.teammate.history`, `mcp.teammate.list`, `mcp.teammate.status`, `mcp.teammate.last`, `mcp.teammate.capabilities` | These can target dispatcher scope or TeamLeader scope via `caller_kind` and `team_id`. |
| Team | `mcp.team.create`, `mcp.team.send`, `mcp.team.list`, `mcp.team.status`, `mcp.team.history`, `mcp.team.bind_channel`, `mcp.team.transfer_back`, `mcp.team.dissolve` | Dispatcher MCP exposes the lifecycle/read tools; TeamLeader MCP only exposes `transfer_back`. |
| Collaboration space | `mcp.collaboration_space.bind`, `mcp.collaboration_space.dissolve`, `mcp.collaboration_space.status`, `mcp.collaboration_space.list` | This is already a control-plane capability in behavior, but the method names still carry MCP terminology. |

## Pre-Cleanup MCP Adapter Surface

The MCP shims are stdio JSON-RPC adapters. They expose model-facing tool schemas
and translate `tools/call` into admin socket calls.

| Adapter | Current filtering behavior | Current admin mapping |
|---|---|---|
| Team MCP | `teamTools('team_leader')` returns only `transfer_back`; dispatcher callers see Team lifecycle/read/bind tools. See [`team-mcp.ts`](/packages/dreamux/src/mcp/team-mcp.ts). | Maps tool calls to `mcp.team.*` methods in [`mapToolCall`](/packages/dreamux/src/mcp/team-mcp.ts). |
| TeamMate MCP | TeamLeader `spawn` omits `repo`; dispatcher `spawn` accepts `repo`. See [`teammateTools`](/packages/dreamux/src/mcp/teammate-mcp.ts). | Maps tool calls to `mcp.teammate.*` methods in [`mapToolCall`](/packages/dreamux/src/mcp/teammate-mcp.ts). |
| Cron MCP | The descriptor-bound dispatcher/team scope is applied after stripping model-supplied `dispatcher_id` and `team_id`. See [`cron-mcp.ts`](/packages/dreamux/src/mcp/cron-mcp.ts). | Already maps to `scheduler.cron.*`. |
| Channel MCP | Lists static provider descriptors and forwards raw provider tool calls to `channel.invoke_tool`. See [`channel-mcp.ts`](/packages/dreamux/src/mcp/channel-mcp.ts). | Already maps to `channel.invoke_tool`. |
| Collaboration-space MCP | Exposes `bind`, `dissolve`, `status`, `list`. | Maps to `mcp.collaboration_space.*` in [`collaboration-space-mcp.ts`](/packages/dreamux/src/mcp/collaboration-space-mcp.ts). |

Before cleanup, some filtering was still expressed with MCP wording in the
admin layer. For example, TeamLeader callers were rejected for `mcp.team.send`
in [`methods.ts`](/packages/dreamux/src/admin/methods.ts). TeamLeader TeamMate
spawn also rejects `repo`, but that message already describes the product rule:
Team TeamMates use the Team shared workspace, while dispatcher callers may pass
`repo`. The safety and ownership checks must remain enforceable by admin, but
the MCP visibility model and MCP-specific wording should live in the adapter.

## Missing First-Class Admin Capabilities

These gaps matter if admin.sock is the external system integration surface:

| Capability | Current state |
|---|---|
| Method and schema introspection | No admin method lists its supported params/result shape through the socket. Consumers must know method names out of band or read source/docs. |
| Adapter diagnostics | Admin can create runtime descriptors internally, but there is no diagnostic method to ask which MCP servers/tools a dispatcher or TeamLeader adapter would expose. This is not a domain control-plane capability unless an external consumer explicitly needs adapter diagnostics. |
| Channel inventory and binding inventory | Admin can invoke provider tools and bind/transfer Team routes, but there is no first-class `channel.list`, `channel.status`, `channel.binding.list`, or `channel.resolve_target`. |
| Dispatcher declaration mutation | This is not a control-plane capability. Config editing remains outside admin.sock, and the unsupported `dispatcher.add` / `dispatcher.remove` placeholders were removed in the namespace slice. |
| Dispatcher-root turn submission | Admin can send a TeamLeader turn and TeamMate turns; there is no direct dispatcher-agent submit method. |
| Collaboration target control | Admin can bind/list/status/dissolve spaces; target-level inspection, retry, detach, or close controls are not exposed as first-class methods. |
| Channel session lifecycle detail | `dispatcher.status` summarizes dispatcher runtime, not per-channel live session status. |
| Outbound events | No admin event stream, subscription method, event cursor, or durable event replay exists. Consumers must poll read APIs or infer from MCP completion delivery. |
| Versioned protocol contract | Request/response envelopes have no `protocol_version`, max-frame rule, public error taxonomy, idempotency key, or streaming client contract. See "Protocol Baseline". |

This proposal does not claim all gaps must be filled in the first slice. It
records them so the admin surface can grow as a coherent control plane rather
than a collection of MCP-derived entry points.

## Protocol Baseline

The admin protocol needs a stable baseline before it can be treated as an
external system contract. The namespace cleanup may stay mechanical, but the
control-plane design should reserve space for:

- `protocol_version` on request, response, and event frames;
- maximum frame size and buffer behavior;
- response ordering when one connection sends multiple requests;
- mutation idempotency keys for external retry;
- stable public error codes and safe error details;
- a separate streaming client API for event subscriptions;
- shutdown behavior for one-shot requests versus subscribed connections.

Unexpected exceptions should not become the long-term external error contract.
The current `INTERNAL` response exposes the raw exception message; later
externalization should define public-safe details separately from server logs.
Until this baseline is implemented, docs and release notes should describe
admin.sock as the target external control plane, not as a completed stable
external protocol.

## Target Admin Namespace

The minimal namespace cleanup is:

| Current method | Target method |
|---|---|
| `mcp.teammate.spawn` | `teammate.spawn` |
| `mcp.teammate.send` | `teammate.send` |
| `mcp.teammate.close` | `teammate.close` |
| `mcp.teammate.history` | `teammate.history` |
| `mcp.teammate.list` | `teammate.list` |
| `mcp.teammate.status` | `teammate.status` |
| `mcp.teammate.last` | `teammate.last` |
| `mcp.teammate.capabilities` | `teammate.capabilities` |
| `mcp.team.create` | `team.create` |
| `mcp.team.send` | `team.send` |
| `mcp.team.list` | `team.list` |
| `mcp.team.status` | `team.status` |
| `mcp.team.history` | `team.history` |
| `mcp.team.bind_channel` | `team.bind_channel` |
| `mcp.team.transfer_back` | `team.transfer_back` |
| `mcp.team.dissolve` | `team.dissolve` |
| `mcp.collaboration_space.bind` | `collaboration_space.bind` |
| `mcp.collaboration_space.dissolve` | `collaboration_space.dissolve` |
| `mcp.collaboration_space.status` | `collaboration_space.status` |
| `mcp.collaboration_space.list` | `collaboration_space.list` |

`scheduler.cron.*` and `channel.invoke_tool` already use control-plane names
and should stay as they are unless a broader naming decision changes the whole
admin namespace.

## Compatibility Boundary

The pre-cleanup `mcp.*` admin methods were pre-stable internal names. This was
the cleanup window before admin.sock is advertised as the external integration
contract, so the namespace change replaces the old methods rather than keeping
deprecated aliases.

The implemented slice updates Dreamux-owned MCP adapters and tests to the
canonical names, removes `mcp.*` admin registry entries, and lets old names fail
as unknown methods. After the stable external control-plane protocol is
published, future namespace or protocol changes must follow backward-compatible
migration rules.

## Target Event Surface

Admin events should represent facts committed by the same ownership layers that
mutate state, not facts scraped from logs, MCP tool results, or provider-specific
callbacks. The event transport can belong to admin control-plane
infrastructure, but domain services and coordinators remain the authority for
when a state transition exists. This keeps event emission provider-neutral and
avoids making MCP adapters or channel providers responsible for Dreamux
control-plane facts.

The minimum admin event surface should include:

| Method | Purpose |
|---|---|
| `event.subscribe` | Keep one admin socket connection open after an initial acknowledgement and stream future event frames that match filters. This is a transport/session feature, not a normal one-shot `AdminHandler`. |
| `event.history` | If durable replay is required by the integration contract, read recent event envelopes by cursor/time/type/dispatcher filter so an external system can recover after reconnect. |

Event frames should be distinct from request responses. A subscribed connection
can still use normal response frames for the subscription acknowledgement, then
receive push frames. Push frames are not tied to a request `id`, so the admin
transport needs an explicit subscribed-session path instead of treating
subscription delivery as another `processLine()` response.

For a durable feed, event frames can be shaped like:

```json
{
  "protocol_version": 1,
  "type": "event",
  "event": {
    "schema_version": 1,
    "event_id": "dispatcher-a:0000000000000001",
    "cursor": "dispatcher-a:0000000000000001",
    "timestamp": 1784020000000,
    "topic": "agent.turn.settled",
    "dispatcher_id": "dispatcher-a",
    "resource": {
      "kind": "teammate",
      "name": "reviewer-abc"
    },
    "payload": {}
  }
}
```

The exact payload fields should be topic-specific, but the envelope should keep
a stable base: timestamp, topic, dispatcher scope, resource identity, schema
version, and a public-safe payload. Durable replay adds `event_id` and `cursor`
once its ordering and retention semantics are defined. Full prompts, full
assistant text, provider secrets, local private paths, and raw provider
metadata should not be emitted by default. Events can carry previews or
identifiers that let a trusted local consumer call the existing read APIs for
details.

Initial event topics should cover control-plane transitions rather than every
internal implementation step:

| Topic family | Example events |
|---|---|
| Dispatcher lifecycle | `dispatcher.ready`, `dispatcher.stopped`, `dispatcher.failed`; `ready` means input sources, scheduler, channel sessions, and root runtime resume requirements are satisfied by the dispatcher start flow in [`dispatcher-service/index.ts`](/packages/dreamux/src/service/dispatcher-service/index.ts). |
| Team lifecycle | `team.created`, `team.started`, `team.dissolved` |
| TeamMate lifecycle | `teammate.spawned`, `teammate.closed`, `teammate.status.changed` |
| Turns | `agent.turn.submitted`, `agent.turn.settled`; resource role/team scope identifies dispatcher root, TeamLeader, or TeamMate. |
| Channel routing | `channel.binding.changed`; this is the authoritative route-change fact, including Team route changes. |
| Collaboration spaces | `collaboration_space.bound`, `collaboration_space.dissolved`, `collaboration_space.target.changed` |
| Scheduler | `scheduler.job.created`, `scheduler.job.updated`, `scheduler.job.deleted`, `scheduler.job.fired` |

`channel.tool.invoked` is intentionally not part of the default state event set.
It is an audit event, not a state transition, and should only exist behind a
separate audit surface with allowlisted payload fields that exclude raw
provider arguments and raw results.

Durability is a separate event-contract tier. A volatile subscription can
satisfy consumers that only need live notifications. A durable event feed is
required only when consumers need reconnect recovery or no-loss integration.
If durable replay is required, use the existing domain stores as the canonical
state source and treat the event log as an at-least-once change feed. The design
must then define a stable `event_id`, idempotent consumer behavior, retention,
cursor scope/order/inclusivity, `CURSOR_EXPIRED`, and reconciliation from domain
state after crash/retry. This proposal does not make the event log a canonical
journal unless a later decision record explicitly changes the state model.

Every topic must have a closed payload schema and schema version. Payloads
should be redacted at construction time by topic-specific helpers, not by a
generic `Record<string, unknown>` callback that trusts callers to remember which
fields are safe.

`event.subscribe(after_cursor)` needs an atomic replay-to-live handoff if
durable replay is present. A client must not have to call `event.history` and
then separately subscribe with a gap where events can be missed. The transport
also needs explicit slow-consumer, backpressure, disconnect, and shutdown
semantics.

The current one-shot client in
[`/packages/dreamux/src/admin/client.ts`](/packages/dreamux/src/admin/client.ts)
settles on the first response line and closes the socket. Event streaming
therefore requires a separate streaming client API; it should not overload
`sendAdminRequest()`.

## Adapter Boundary

Admin handlers own request framing, parameter validation, session/admission
coordination, and public error projection. Domain services and the existing
cross-domain coordinators own durable state mutation, runtime lifecycle
admission, cross-service ownership checks, provider-neutral authorization, and
the authoritative transition points that can produce typed domain transitions.
A control-plane projector should map those transitions into versioned,
public-safe admin event DTOs; transport and journal infrastructure should only
deliver or persist those DTOs. MCP adapters own model-facing projection.

The adapter layer should own:

- tool visibility by caller type;
- model-facing tool names and descriptions;
- model-facing argument schemas;
- stripping or overriding model-supplied scope fields such as `dispatcher_id`
  and `team_id` when the descriptor already binds that scope;
- translating one MCP tool into one or more admin socket calls when the model
  contract needs a composed result;
- MCP wording in errors returned to the model.

The admin layer should own:

- `dispatcher_id`, Team, TeamMate, channel, and collaboration-space validation;
- admin socket session state and shutdown/drain interaction;
- schema validation and stable public errors;
- dispatching to typed command/query capabilities owned by domain services;
- product/control-plane errors that are useful to non-MCP clients.

The domain layer should own:

- shutdown/admission gates for resource mutations;
- TeamLeader lease and generation checks;
- channel target resolution and route ownership authorization;
- worktree and shared-workspace authority;
- typed domain transition construction at the commit point of each state
  transition.

This boundary means admin may still reject unauthorized or incoherent requests,
including TeamLeader attempts to use a dispatcher-only capability. It should not
name those rules as MCP tool visibility.

The implementation should avoid a single God `ControlPlaneService`. Prefer
typed command/query capability objects per domain area, with admin acting as the
transport adapter over those capabilities.

## Parameter Scope Model

The existing `caller_kind` parameter is currently doing double duty: it models
the caller's authority and it leaks the fact that a particular request came from
an MCP adapter. A control-plane shape should keep authority explicit without
making MCP the namespace.

For the first slice, the least disruptive option is to keep `caller_kind`,
`team_id`, and `leader_name` as admin parameters while renaming methods and
removing MCP-specific wording. This must be treated as a v0 compatibility shape,
not the final stable identity contract. The current params are parsed in
[`/packages/dreamux/src/admin/params.ts`](/packages/dreamux/src/admin/params.ts)
and helper code in
[`/packages/dreamux/src/admin/methods.ts`](/packages/dreamux/src/admin/methods.ts).

A stable control-plane identity model should separate:

- `actor` or `principal`, derived from the connection boundary or an explicit
  future local credential rather than trusted only from free-form params;
- `scope`, such as dispatcher scope or a specific Team scope;
- generation fencing or an opaque scoped capability for TeamLeader operations,
  so an old TeamLeader-scoped caller cannot act on a replacement Team.

The owner-only socket mode remains the current coarse security boundary. Any
external system integration that needs multiple local principals must not treat
the flat `caller_kind/team_id/leader_name` tuple as sufficient authorization.

## Admin-Only Creation Skill Sources

`teammate.spawn` and `team.create` accept an optional `skill_sources` array on
the admin wire. Each entry must be an object with non-empty string `name`,
`path`, and `source` fields; malformed input returns `BAD_REQUEST`. The shape is
runtime-neutral and reuses `AgentRuntimeSkillSource`. Core canonicalizes custom
roots before persistence: paths must be existing readable absolute directories,
are stored as realpaths, duplicate roots collapse, and direct-child skill name
collisions are rejected.

The capability applies to dispatcher-scope TeamMates, TeamLeaders, and direct
admin calls that spawn a Team-scoped member. The service boundary already owns
member runtime context cleanly, so Team-scoped support does not alter shared
workspace or role policy. TeamLeader-scoped MCP calls still cannot supply the
parameter.

Only custom roots are persisted on the agent identity. At runtime the owning
service recomposes required built-in role roots with the stored additions; a
TeamLeader therefore always keeps the bundled Dreamux Team workflow root.
Custom roots cannot shadow the bundled `team-workflow` skill name, and they do
not reintroduce workspace skill installation or symlink behavior. Admin DTOs
and public model-facing views do not project the stored paths.

This is deliberately an admin-only capability. MCP tool schemas, descriptions,
argument parsing, and forwarded requests omit `skill_sources`, including when
an untrusted caller adds the field to raw MCP call arguments.

## Backward Compatibility

The current admin namespace is treated as pre-stable for this cleanup. Do not
add `mcp.*` compatibility aliases. The canonical namespace after this change is
the non-`mcp.` namespace, and old method names should return `UNKNOWN_METHOD`.

Once admin.sock is published as a stable external protocol, subsequent changes
must preserve backward compatibility or provide an explicit versioned migration.

## Acceptance

### Namespace Slice

- The canonical admin method names for Team, TeamMate, and collaboration space
  do not start with `mcp.`.
- `mcp.*` admin registry entries are removed rather than kept as aliases; old
  method names return `UNKNOWN_METHOD`.
- `dispatcher.add` and `dispatcher.remove` are removed from the admin registry;
  dispatcher declarations remain config-owned.
- Tests cover the admin registry namespace and assert that no canonical admin
  method starts with `mcp.`.
- Tests that encode admin method names are updated without weakening their
  load-bearing invariant. This includes MCP adapter tests, direct
  `adminMethods[...]` tests, default-workspace admin tests, and the architecture
  ownership gate that verifies Team read composition remains in
  `admin/methods.ts`.
- Admin-layer rejection messages do not refer to "MCP caller" or "MCP tool";
  the previously MCP-specific TeamLeader rejection now identifies the
  dispatcher-only `team.send` product rule.
- MCP adapter tests assert that Team, TeamMate, and collaboration-space tools
  call the renamed admin methods.
- MCP tool visibility remains unchanged for dispatcher and TeamLeader callers.
- Cron and channel MCP behavior remains unchanged.
- The change does not add provider-specific logic to core admin handlers.
- The KB records admin.sock as the target external control plane and MCP as an
  adapter surface, with source links to the method registry and adapters. It
  does not claim that the stable external protocol baseline is complete.

### Admin-Only Skill Injection

- Admin `teammate.spawn` forwards validated custom roots for dispatcher and
  Team-scoped TeamMate creation.
- Admin `team.create` forwards validated custom roots to TeamLeader runtime
  creation.
- Malformed `skill_sources` input returns `BAD_REQUEST` before domain mutation.
- Custom root paths are canonical absolute readable directories; relative or
  missing paths and direct-child skill-name conflicts are rejected before domain
  mutation.
- Custom roots survive runtime and process rebuild through agent identity state.
- Required bundled role roots remain present alongside custom roots.
- MCP schemas and descriptions do not expose `skill_sources`, and MCP adapters
  do not forward it even when it appears in raw call arguments.

### Future Event Slice

- The event design identifies the admin event envelope, the subscription/replay
  methods, initial topic families, transport/session changes, and whether the
  first event slice is volatile-only or durable replay.
- Event delivery is implemented as explicit transport/session state, not as a
  normal one-shot `AdminHandler` that keeps an admin request promise pending.
- Public event DTOs are produced through a control-plane projection boundary
  from owner-created typed domain transitions; domain services do not depend on
  admin transport DTOs or raw string-topic callbacks.
- Any durable event design states that domain stores remain canonical unless a
  later decision explicitly makes the event log a journal. It defines
  `event_id`, cursor semantics, retention, cursor-expired behavior,
  at-least-once delivery, idempotent consumption, replay-to-live handoff, and
  the commit-coupling mechanism that prevents committed transitions from being
  silently lost.
- Redaction sentinel tests exist before event payloads are emitted. They must
  cover prompts, assistant text, local paths, provider metadata, secrets, and
  raw error messages.

## Out Of Scope

- Adding HTTP or remote network control-plane transport.
- Implementing dispatcher add/remove through admin.sock.
- Adding full admin schema introspection.
- Adding channel inventory/binding inventory APIs.
- Adding dispatcher-root turn submission.
- Adding collaboration target-level admin controls.
- Implementing the event stream in the namespace-cleanup slice. The first slice
  may land the event contract as design only, but it must not make choices that
  block either volatile live events or a later durable replay tier.
- Defining a multi-principal authentication model for admin.sock. The current
  owner-only socket remains the coarse boundary until a separate design changes
  it.
- Changing provider-owned channel tool descriptors.
- Exposing custom creation skill roots through any MCP or model-facing surface.

## Review Focus

Reviewers should check whether this keeps ownership clean:

- Does the admin layer read as a product control plane rather than an MCP
  backend implementation detail?
- Are model-facing filters and model wording isolated in the MCP adapters?
- Are safety checks still enforceable when a non-MCP external system calls the
  same admin methods directly?
- Does the namespace leave room for future admin introspection and channel
  inventory without another rename?
- Does the event surface belong to the admin control plane rather than logs,
  MCP completion delivery, or provider-specific channel callbacks?
- Is the event envelope redacted and typed enough for a larger system to
  integrate without polling every read API?
- If durable replay is proposed, does it preserve a single canonical state
  source and define replay-to-live, idempotency, retention, and cursor-expiry
  semantics?
