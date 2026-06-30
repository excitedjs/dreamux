# Dispatcher Team MCP send to TeamLeader technical design

- **Status:** Draft design for review
- **Companion to:** [Dispatcher Team MCP send to TeamLeader](team-mcp-dispatcher-send.md)
- **Source baseline:** `origin/next` at `c88ec2e`

## Settled choices

| Choice | Decision |
|---|---|
| Product scope | Dispatcher sends to a Team's TeamLeader only. |
| Tool visibility | Dispatcher Team MCP exposes `send`; TeamLeader Team MCP does not. |
| Input shape | `send({ team_name, prompt, intent? })`, aligned with `teammate.send`. |
| Channel data | No `channel_id`, `meta`, target selectors, or channel binding lookup. |
| Completion initiator | Registered from the send caller at send time. |
| Current initiator | Dispatcher agent. |
| Future peer send | Preserve a reusable initiator seam, but do not expose peer send here. |

## Current source facts

- `packages/dreamux/src/mcp/team-mcp.ts` defines a caller kind split:
  `dispatcher` sees the full Team MCP surface and `team_leader` sees only
  `transfer_back`.
- `packages/dreamux/src/mcp/team-mcp.ts` has no `send` tool mapping today.
- `packages/dreamux/src/admin/methods.ts` has `mcp.teammate.send`, but no
  `mcp.team.send`.
- `mcp.teammate.send` targets a `TeammateCollection`. For TeamLeader callers,
  that collection is the Team's member collection, so it does not address the
  TeamLeader itself.
- `packages/dreamux/src/service/team-service/index.ts` owns the TeamLeader
  `TeammateService` and already has `deliverToLeader` for channel inbound.
- `TeamService.registerLeaderCompletion` currently derives completion delivery
  through `deps.initiatorFor(leader.current())`.
- `DispatcherService.initiatorFor` currently routes a `team_member` completion
  to its TeamLeader and routes a `team_leader` completion back to the dispatcher.
- `CompletionRouter` already supports arbitrary initiators as long as the
  caller registers `completionKey -> initiator` before the producer settles.

## MCP shim

Add a dispatcher-only `send` tool in `teamTools('dispatcher')`:

```ts
tool('send', 'Submit a turn to a TeamLeader by team_name.', {
  team_name: { type: 'string', minLength: 1, maxLength: 64 },
  prompt: { type: 'string', minLength: 1, maxLength: 20000 },
  intent: { type: 'string', minLength: 1, maxLength: 2000 },
}, ['team_name', 'prompt'])
```

The description should make the target explicit: this sends to the TeamLeader,
not to a Team member and not to a bound channel.

`mapToolCall` should forward dispatcher calls to `mcp.team.send`. The existing
TeamLeader hidden-tool guard should keep rejecting every TeamLeader-scoped call
whose name is not `transfer_back`; no separate TeamLeader send guard is needed
in the shim.

`create` wording that says an idle leader can wait for "a later send" should now
refer to Team MCP `send`.

## Admin method

Add `mcp.team.send` to `packages/dreamux/src/admin/methods.ts`.

The method should:

- require `dispatcher_id`;
- accept only dispatcher caller scope for this slice;
- require `team_name` and `prompt`;
- accept optional `intent`;
- call one dispatcher orchestrator method;
- catch failures as `TEAM_SEND_FAILED`;
- return model-facing structured content assembled in the admin layer.

The structured response should stay close to `teammate.send`, for example:

```ts
{
  team: <public team status or compact team identity>,
  leader: <TeamLeader runtime status>,
  turn: <submitted turn result>
}
```

The exact field names may follow existing Team status/read helper shapes, but
the response should not require the MCP shim to make multiple admin calls.

## Dispatcher orchestration

Add a dispatcher-level operation such as:

```ts
sendTeamLeader(input: {
  teamId: string;
  prompt: string;
  intent?: string;
}): Promise<TeamLeaderSendResult>
```

`DispatcherService` should:

- reject sends while the dispatcher is shutting down, following existing agent
  send behavior;
- locate the Team through `TeamCollection`;
- reject missing or closed Teams before submitting the prompt;
- pass the dispatcher agent as the explicit completion initiator;
- return the TeamLeader send result plus enough Team identity for the admin
  response.

This keeps dispatcher graph orchestration in `DispatcherService` without making
`TeamService` call back into the dispatcher.

## Team runtime operation

Add a narrow Team runtime operation such as:

```ts
sendToLeader(input: {
  prompt: string;
  intent?: string;
  initiator: CompletionInitiator;
}): Promise<TeamLeaderSendResult>
```

`TeamService` should:

- fail if the Team record is closed;
- call `this.leader.send({ prompt, intent, teamId: this.id })`;
- register the returned leader turn id with the supplied initiator;
- reuse the existing `CompletionRouter` key shape;
- not know whether the initiator is a dispatcher or a future peer TeamLeader.

`registerLeaderCompletion` can be refactored to accept an explicit initiator.
The existing initial-prompt path can continue to derive the initiator from
`deps.initiatorFor(leader.current())` unless the implementation finds a cleaner
shared helper.

## Completion routing

Do not add Team MCP branching inside `CompletionRouter`.

The router already takes an abstract `CompletionInitiator`. The important
change is where that initiator is chosen:

- current initial TeamLeader prompt: still derived from producer identity;
- new dispatcher `team.send`: explicitly dispatcher agent;
- future peer send: explicit caller-side initiator.

This keeps producer identity available for the completion envelope while avoiding
producer identity as the only delivery-target decision.

## Documentation and prompts

Update repo-local user-facing references that currently say `team.send` is
future-only:

- `.agents/reference/current-architecture.md`
- `.agents/reference/channel-runtime.md`
- `.agents/reference/dispatcher-skill.md`
- bundled dispatcher skill text if it mirrors the same Team MCP tool list;
- dispatcher base prompt if it describes the Team MCP surface.

Those docs should say dispatcher Team MCP supports `send` to the TeamLeader.
They should still say Team peer send is future work.

## Verification contract

Focused tests should cover:

- dispatcher `teamTools()` includes `send`;
- TeamLeader `teamTools('team_leader')` excludes `send`;
- hidden TeamLeader `send` calls are rejected;
- `mcp.team.send` forwards `team_name`, `prompt`, and optional `intent`;
- dispatcher `sendTeamLeader` submits to the TeamLeader and registers completion
  delivery to the dispatcher;
- closed or missing Team failures are loud;
- existing `team.transfer_back` and `teammate.send` coverage remains intact.

Run the relevant focused tests first, then the repo's standard Rush validation
appropriate for the final PR gate.

## Non-goals

This design does not introduce a general Team peer messaging API. It also does
not make Team MCP a replacement for TeamLeader-scoped TeamMate MCP member sends.
The only new model-facing capability is dispatcher send to TeamLeader.
