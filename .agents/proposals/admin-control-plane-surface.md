# Admin Control Plane Surface

- **Status:** Draft
- **Date:** 2026-07-14
- **Affects:** `/packages/dreamux/src/admin/`, `/packages/dreamux/src/command/`, `/packages/dreamux/src/mcp/`, agent identity/runtime creation, admin socket consumers
- **Issue:** [#295](https://github.com/excitedjs/dreamux/issues/295)

## Intent

Dreamux is becoming a component inside larger systems. The target external
control-plane entry point should be the local admin socket, not the stdio MCP
adapter surface. MCP remains a model-facing adapter that exposes a filtered
tool set, adapts model-friendly arguments, and may compose one or more admin
socket calls when that is the cleanest way to implement an MCP tool.

The admin socket should therefore use product/control-plane names and errors,
not MCP-specific names.

The same control plane must also support outbound events. A larger system
cannot integrate with Dreamux only by polling passive request/response methods;
it needs to observe state transitions such as Team and TeamMate lifecycle
changes and scheduler fires.

## Status Of The Namespace Slice

The namespace-cleanup slice landed and has since been superseded by a larger
change. It replaced the pre-stable `mcp.*` admin RPC names with product names,
removed the dispatcher mutation placeholders, and added admin-only custom skill
roots to TeamMate and TeamLeader creation. The event surface, protocol baseline,
introspection, inventory, and authentication work in this proposal remain future
slices, and the sections below are still the live target.

The historical pre-cleanup surface this proposal opens against — the
`admin/methods.ts` registry, the `mcp.*` method names, the five scoped MCP
adapter files under `src/mcp/`, `channel.invoke_tool`, and the Core
collaboration-space methods — no longer exists in any form. It is not restated
here; read the superseded revisions in git history if the old shape matters.

## Current Baseline

The admin socket is now one of two adapters over a single Command registry
rather than a method registry of its own:

- Domain modules declare their own `CoreCommandDefinition` objects in their own
  `commands.ts`, and one registry owns bounding, validation, resolution,
  execution, and output validation:
  [`/packages/dreamux/src/command/registry.ts`](/packages/dreamux/src/command/registry.ts).
- The admin socket is a transport: one-line NDJSON in, one line out, naming a
  Command and attaching its factual caller context.
  [`/packages/dreamux/src/admin/socket.ts`](/packages/dreamux/src/admin/socket.ts)
  and [`/packages/dreamux/src/admin/protocol.ts`](/packages/dreamux/src/admin/protocol.ts).
- A Channel reaches the same registry in-process through its `invoke` port
  ([`/packages/dreamux/src/channel/core-port.ts`](/packages/dreamux/src/channel/core-port.ts)),
  so no capability is admin-only and there is no second handler table.
- Agent MCP is no longer a Command adapter. One generic stdio shim
  ([`/packages/dreamux/src/mcp/shim.ts`](/packages/dreamux/src/mcp/shim.ts))
  asks `mcp.describe` what to advertise and forwards every call to
  `mcp.toolcall`; a runtime-bound delegate owned by each domain supplies the
  catalog, caller context, and model-facing errors, and calls its domain objects
  directly.
- Routing and its tools are Channel-owned. Core holds no binding table and no
  Collaboration Space container, so there is nothing left for admin to name
  there.

This changes what the rest of this proposal asks for: the "adapter owns
model-facing projection, the owner owns the rule" boundary below is now realized
by the delegate/Command split rather than by admin-versus-MCP.

## Missing First-Class Admin Capabilities

These gaps matter if admin.sock is the external system integration surface:

| Capability | Current state |
|---|---|
| Method and schema introspection | No admin method lists its supported params/result shape through the socket. Consumers must know method names out of band or read source/docs. |
| Adapter diagnostics | Admin can create runtime descriptors internally, but there is no diagnostic method to ask which MCP servers/tools a dispatcher or TeamLeader adapter would expose. This is not a domain control-plane capability unless an external consumer explicitly needs adapter diagnostics. |
| Channel inventory | There is no first-class `channel.list` or `channel.status` Command. Bindings themselves are Channel-owned and are not a Core inventory to publish. |
| Dispatcher declaration mutation | This is not a control-plane capability. Config editing remains outside admin.sock, and the unsupported `dispatcher.add` / `dispatcher.remove` placeholders were removed. |
| Dispatcher-root turn submission | Admin can send a TeamLeader turn and TeamMate turns; there is no direct dispatcher-agent submit method. |
| Channel session lifecycle detail | `dispatcher.status` summarizes dispatcher runtime, not per-channel live session status. |
| Outbound events | No admin event stream, subscription method, event cursor, or durable event replay exists. The in-process core event bus feeds Channel providers only; an external consumer must poll read Commands. |
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

The transport owns framing, the caller context it can prove, and public error
projection. The Command owns its own schema, validation, and execution. Domain
owners own durable state mutation, runtime lifecycle admission, and the
authoritative transition points that can produce typed domain transitions. A
control-plane projector should map those transitions into versioned,
public-safe admin event DTOs; transport and journal infrastructure should only
deliver or persist those DTOs.

The model-facing adapter — a domain's MCP delegate — should own:

- tool visibility by caller kind;
- model-facing tool names, descriptions, and argument schemas;
- the descriptor-bound scope, so a model-supplied `dispatcher_id` or `team_id`
  cannot widen it;
- model-facing wording in errors returned to the model.

The transport layer should own:

- admin socket session state and shutdown/drain interaction;
- the caller context it can actually prove, never a claim it merely relays;
- stable public errors that are useful to non-MCP clients.

The domain layer should own:

- its Command definitions, input schemas, and typed errors;
- shutdown/admission gates for resource mutations;
- worktree and shared-workspace authority;
- typed domain transition construction at the commit point of each transition.

This boundary means a request may still be rejected as unauthorized or
incoherent — a TeamLeader reaching for a dispatcher-only capability, say — but
the rule belongs to the domain that owns the capability, not to tool visibility.

The implementation should avoid a single God `ControlPlaneService`; the current
domain-owned Command registry is the shape to keep.

## Parameter Scope Model

A Command now receives a `CoreCommandContext` carrying only what its adapter
can actually prove — the request `source` plus, where the adapter is bound to
one, `dispatcher_id` and `channel_id`
([`/packages/dreamux-types/src/command.ts`](/packages/dreamux-types/src/command.ts)).
Scope a caller merely asserts still travels in the payload, which is a v0 shape
rather than a stable identity contract.

A stable control-plane identity model should separate:

- `actor` or `principal`, derived from the connection boundary or an explicit
  future local credential rather than trusted only from free-form params;
- `scope`, such as dispatcher scope or a specific Team scope;
- generation fencing or an opaque scoped capability for TeamLeader operations,
  so an old TeamLeader-scoped caller cannot act on a replacement Team.

The owner-only socket mode remains the current coarse security boundary. Any
external system integration that needs multiple local principals must not treat
a payload-asserted scope as sufficient authorization.

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

Delivered, then superseded. The acceptance criteria it was checked against
described a registry and adapter files that no longer exist; the criterion that
outlived it is that no Command, and no model-facing tool, is named after the
transport that happens to carry it.

### Admin-Only Skill Injection

- `teammate.spawn` forwards validated custom roots for dispatcher and
  Team-scoped TeamMate creation.
- `team.create` forwards validated custom roots to TeamLeader runtime creation.
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
  normal one-shot Command that keeps a request promise pending.
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
- Adding channel inventory APIs.
- Adding dispatcher-root turn submission.
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
- Are model-facing filters and model wording isolated in the MCP delegates?
- Are safety checks still enforceable when a non-MCP external system invokes the
  same Commands directly?
- Does the Command catalog leave room for future introspection and channel
  inventory without another rename?
- Does the event surface belong to the admin control plane rather than logs,
  MCP completion delivery, or provider-specific channel callbacks?
- Is the event envelope redacted and typed enough for a larger system to
  integrate without polling every read API?
- If durable replay is proposed, does it preserve a single canonical state
  source and define replay-to-live, idempotency, retention, and cursor-expiry
  semantics?
