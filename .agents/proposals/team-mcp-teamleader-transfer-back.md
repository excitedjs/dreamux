# Proposal: TeamLeader-scoped Team MCP transfer back

- **Status:** Active proposal (draft for review)
- **Date:** 2026-06-29
- **Affects:** `@excitedjs/dreamux` Team MCP surface, TeamLeader launch MCP
  descriptors, admin IPC routing, channel binding ownership, bundled dispatcher
  prompt/skill text
- **PR / Issue:** TBD
- **Implementation design:** [TeamLeader-scoped Team MCP transfer back technical design](team-mcp-teamleader-transfer-back-technical-design.md)

## Context

The Team MCP is currently dispatcher-scoped. It exposes Team lifecycle tools and
the channel-binding verbs:

- `create`, `list`, `status`, `history`, `dissolve`
- `bind_channel({ team_name, channel_id?, meta })`
- `transfer_back({ channel_id?, meta })`

The dispatcher receives that Team MCP descriptor from
`/packages/dreamux/src/service/dispatcher-service/mcp-descriptors.ts`, and the
tool implementation is in `/packages/dreamux/src/mcp/team-mcp.ts`.

Team leaders already receive caller-scoped MCP descriptors for other surfaces:
channel tools are scoped by `callerKind: 'team_leader'`, `team_id`, and
`leader_name`, and the TeamMate MCP already has a dispatcher-vs-team-leader
projection. This proposal records the next Team MCP slice: make
`transfer_back` available to TeamLeaders without exposing the dispatcher-only
Team lifecycle surface.

The current code also places channel-binding behavior across
`DispatcherService`, `TeamCollection`, and `TeamService`, while live channel
behavior sits in `ChannelSessions` and durable binding rows sit in
`ChannelBindingStore`. That split leaves channel binding without a clear service
boundary. This slice should introduce a core dispatcher-local Channel service
boundary that owns channel sessions plus binding rows. This is still Dreamux core
logic, not provider logic: Channel providers remain responsible only for platform
I/O and target normalization.

## Requirement

A TeamLeader must be able to proactively return one of its bound channel targets
to the dispatcher.

The user-visible intent is:

- The dispatcher can hand a channel target to a Team with the existing Team MCP
  `bind_channel`.
- While the channel target is bound to the Team, the TeamLeader can decide that
  the Team is done with that conversation.
- The TeamLeader can call a scoped Team MCP `transfer_back` tool with the same
  provider target selector shape used by dispatcher transfer-back today.
- Dreamux deactivates the Team binding and routes future inbound messages for
  that channel target back to the dispatcher.

The TeamLeader must not receive dispatcher-only Team read or lifecycle tools just
to perform this handoff.

## Caller scope

"Caller-aware" means the MCP shim and admin handler carry descriptor-bound caller
context. This is not a model-supplied free-text convention and it is not a new
per-tool security layer.

For this proposal, the relevant caller scopes are:

- `dispatcher`: the existing full Team MCP surface.
- `team_leader`: a TeamLeader-bound Team MCP surface, descriptor-bound to
  `dispatcher_id`, `team_id`, and `leader_name`.

The admin socket is local and trusted in the current architecture. Caller scope
is used to select the tool projection and to constrain the product semantics of
TeamLeader transfer-back; it should not grow into per-tool authorization logic.
If Dreamux later needs identity enforcement for admin IPC, that should be a
uniform RPC boundary concern, not bespoke checks in each Team MCP method.

## Required TeamLeader surface

For a `team_leader` caller, `tools/list` must expose only:

- `transfer_back`

The TeamLeader-scoped Team MCP must not expose:

- `create`
- `list`
- `status`
- `history`
- `dissolve`
- `bind_channel`

The dispatcher-scoped Team MCP remains unchanged unless a later proposal
explicitly changes it.

## Transfer target resolution

The dispatcher-scoped `transfer_back` keeps the existing contract:
`meta` is required, and `channel_id` remains optional when the dispatcher has a
single configured channel.

The TeamLeader-scoped `transfer_back` also keeps an explicit target selector:
`meta` is required, and `channel_id` remains optional when it can be resolved by
the dispatcher. This intentionally avoids a second "infer the only active
binding" path. The caller supplies the same provider target selector shape that
Dreamux already normalizes through the channel provider.

The execution path is:

- resolve `channel_id` in the dispatcher;
- ask the channel session to normalize `meta` into a `ChannelTarget`;
- use the provider-owned `target_key` to find the active binding row;
- trust the binding row as the source of truth for `team_name` and
  `leader_name`;
- transfer only when that row matches the TeamLeader caller scope.

This keeps target authority in the core-owned binding store and avoids smuggling
provider-specific chat identifiers through prompts or free-text fields.

## Channel service ownership direction

Channel binding should be organized around a dispatcher-local core
`ChannelService`:

- `ChannelService` owns live channel sessions, channel id/provider selection,
  provider target normalization, and the dispatcher-local `ChannelBindingStore`.
- `ChannelBindingStore` remains the durable binding row store, but it is consumed
  through `ChannelService`.
- `DispatcherService` orchestrates across `ChannelService`, Teams, and the
  dispatcher agent because it is the only object that owns the full
  per-dispatcher graph.
- `TeamCollection` owns Team records and can provide a small open-Team owner
  projection such as `{ kind: 'team', teamName, leaderName }`.
- `TeamService` owns the live Team runtime aggregate: TeamLeader
  `TeammateService`, team member collection, scheduler, shared workspace,
  leader delivery, and dissolve cleanup.

`TeamService` and `TeamMateService` should not own channel-binding methods or
import binding-store types. `TeamCollection` should not own binding mutation
either; it should only answer Team facts needed by orchestration, such as whether
a Team is open and what its current leader name is. Binding creation, lookup,
TeamLeader ownership checks, transfer-back, and binding summaries belong on
`ChannelService`.

`ChannelService` should not expose separate dispatcher-vs-TeamLeader transfer
methods. It should have one `transferBack` operation that resolves the target and
optionally checks a supplied expected route owner. Dispatcher calls omit
`expectedOwner`; TeamLeader calls include
`{ kind: 'team', teamName, leaderName }`.

The closed-Team inbound guard stays in `DispatcherService.routeChannelInput`
after ChannelService binding lookup and before `deliverToLeader`. `ChannelService`
should not call back into Team lifecycle state for this guard.

Tool-facing response assembly belongs in the admin methods layer, not inside
domain services or the stdio MCP shim. For example, Team status should be
composed by an admin method asking the Team services for Team facts and asking
`ChannelService` for binding facts, then returning the single response to the MCP
shim.

Lifecycle orchestration that must also work for non-MCP callers stays on
`DispatcherService`. In particular, dissolving a Team must first clear its
channel bindings through `ChannelService`, then dissolve the live Team runtime
through `TeamService`. The admin method should call that dispatcher orchestrator
and assemble the returned tool response; it should not be the only place that
performs cleanup ordering.

Implementation may be sequenced internally, but the operator-facing delivery is
one integrated PR targeting `next`.

## Follow-up: target selector model

The current channel target model uses caller-supplied `meta`, provider
normalization, and a provider-owned stable `target_key`. For Feishu this is
currently:

- caller passes `{ chat_id, chat_type }`;
- provider returns `target_key = chat_id`;
- core stores both normalized `meta` and `target_key`;
- routing uniqueness uses `(channel_id, target_key)`.

That is structurally sound as a provider/core seam, but the names are easy to
misread because `meta` is acting like a target selector. File a follow-up issue
to clarify or redesign this model. That issue must not block this transfer-back
slice.

Suggested issue title:

> Clarify channel target selectors and stable routing keys

## Future send requirement record

`team.send` is intentionally out of scope for this slice, but the requirement is
recorded here so the transfer-back work does not block the future shape.

A future Team MCP `send` capability should align with `teammate.send`:

- submit a turn to the addressed Team participant;
- preserve the runtime-native continuation semantics of the target;
- settle only after that target turn completes;
- deliver the completion back to the initiator through the existing reverse
  delivery mechanism;
- support Team peer communication without assuming the only sender is the
  dispatcher.

The current completion routing resolves the completion destination from the
producer identity. A TeamLeader producer currently routes back to the dispatcher.
Future peer TeamLeader send must record the caller/initiator at send time rather
than relying only on producer role.

## Acceptance

- Dispatcher `tools/list` for Team MCP is unchanged.
- TeamLeader `tools/list` for Team MCP contains `transfer_back` and no Team
  lifecycle or bind tools.
- TeamLeader `transfer_back({ channel_id?, meta })` requires explicit `meta`,
  resolves it through the channel provider, and transfers the matching active
  binding back only when the binding row belongs to the caller's TeamLeader
  scope.
- TeamLeader transfer-back trusts the active binding row for `team_name` and
  `leader_name`; it does not load a live `TeamService` just to prove the same
  facts again.
- Existing dispatcher `transfer_back({ channel_id?, meta })` behavior and tests
  continue to pass.
- `bind_channel` ownership is simplified so binding creation goes through
  `DispatcherService` orchestration and `ChannelService` target/binding writes,
  not `TeamService.bindChannel` or `TeamCollection` binding mutation.
- Dispatcher and TeamLeader transfer-back use one underlying
  `ChannelService.transferBack({ expectedOwner?, channel_id?, meta })`
  operation.
- Team MCP responses are assembled in the admin methods layer by composing Team
  facts and Channel binding facts, rather than requiring Team/Channel services to
  return model-facing aggregate views or requiring the stdio MCP shim to make
  multiple cross-process admin calls.
- Team dissolve clears active channel bindings through `ChannelService` before
  `TeamService.dissolve()` tears down the Team runtime; `TeamService` no longer
  reads or mutates channel bindings.
- `TeamMateLaunchPolicy`, `TeamService.leaderLaunchPolicy()`, and non-policy
  "Policy" type aliases are removed or flattened where they only wrap simple
  options/unions.
- ChannelService is introduced as a new service wrapper around the existing live
  `ChannelSessions` helper, with the service meaning "manage all Channel
  sessions under one Dispatcher."
- Bundled prompt/skill/reference text no longer states that the Team MCP is
  dispatcher-only; it describes the caller-scoped split.

## Out of scope

- Implementing `team.send`.
- Exposing Team `status` or `list` to TeamLeaders.
- Inferring a TeamLeader transfer target from "the only active binding".
- Passing Feishu `chat_id` through free-text prompts.
- Adding a provider-specific transfer tool.
- Changing the channel provider MCP tool surface.
- Changing the channel binding persisted file format.
- Redesigning the `meta` / `target_key` channel target model in this slice.

## Settled implementation choices

- Introduce a new `ChannelService` wrapper rather than renaming/expanding
  `ChannelSessions` directly.
- Keep the closed-Team inbound guard in `DispatcherService` before
  `deliverToLeader`.
- Remove `TeamChannelContext` if no other method needs it after binding creation
  moves out of `TeamService`.
- Internal development may be split into phases, but the final deliverable is one
  integrated PR to `next`.
