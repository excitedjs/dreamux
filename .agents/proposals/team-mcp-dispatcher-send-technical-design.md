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
| Turn origin | Dispatcher-initiated TeamLeader sends record `turn_origin: 'dispatcher'`. |
| Response shape | `{ team: TeamView, leader: TeamMateRuntimeStatus, turn: TeamMateTurnResult }`. |
| Missing or closed Team | Fail before leader submission; map to `TEAM_NOT_FOUND` in admin. |
| TeamLeader caller | Reject `mcp.team.send` with `BAD_REQUEST`; peer send stays future. |
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
- `TeammateService.send({ teamId })` currently records `turn_origin` as
  `team_leader`, while `TeamService.createNew` overrides the TeamLeader initial
  prompt to `turn_origin: 'dispatcher'`.
- `TeamCollection` already has an open-Team guard that throws
  `TeamUnavailableError` for missing or closed Teams, and the cron admin path
  maps that error family to `TEAM_NOT_FOUND`.
- `prompt-registry-parity.test.ts` only checks whole-word tool-name presence
  across the dispatcher prompt, so adding a Team MCP `send` tool must be paired
  with explicit Team MCP prompt text rather than relying on the existing
  TeamMate MCP `send` wording.

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
in the shim. The admin layer still rejects `caller_kind: 'team_leader'` for
`mcp.team.send`, because admin methods are directly callable over the local
trusted socket.

`create` wording that says an idle leader can wait for "a later send" should now
refer to Team MCP `send`.

## Admin method

Add `mcp.team.send` to `packages/dreamux/src/admin/methods.ts`.

The method should:

- require `dispatcher_id`;
- accept only dispatcher caller scope for this slice, rejecting
  `caller_kind: 'team_leader'` with `BAD_REQUEST`;
- require `team_name`;
- require a non-empty `prompt`;
- accept optional `intent`;
- call one dispatcher orchestrator method;
- map `TeamUnavailableError` to `TEAM_NOT_FOUND`, matching the cron team-target
  path for both missing and closed Teams;
- catch other failures as `TEAM_SEND_FAILED`;
- return model-facing structured content assembled in the admin layer.

The structured response is fixed:

```ts
{
  team: TeamView;
  leader: TeamMateRuntimeStatus;
  turn: TeamMateTurnResult;
}
```

`team` must be the public `TeamView` shape returned by `TeamService.view()`,
not a Team record with `repo_cwd`, `runtime_cwd`, or worktree details. `leader`
and `turn` reuse the existing `teammate.send` sub-structures. Non-submitted
turn results (`duplicate`, `stopped`, or `failed`) do not carry a `turn_id`.
The response must not include channel binding summaries; send is not a Team
status/read composition path.

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

- reject sends while the dispatcher is shutting down, following `createTeam`;
- locate the Team through an open-Team query on `TeamCollection`;
- reject missing or closed Teams before submitting the prompt, without reviving a
  closed Team through its leader identity;
- pass the dispatcher agent as the explicit completion initiator;
- return the TeamLeader send result plus enough Team identity for the admin
  response.

This keeps dispatcher graph orchestration in `DispatcherService` without making
`TeamService` call back into the dispatcher.

The dispatcher should pass `this.agent` directly as the
`CompletionInitiator`. It should not call `initiatorFor(leader.current())` for
this path; producer-derived routing is exactly what this proposal is moving away
from for future peer send.

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
- submit through the leader `TeammateService` with `teamId: this.id`,
  `turnOrigin: 'dispatcher'`, and a synchronous submitted-turn hook;
- register the submitted leader turn id with the supplied initiator from that
  hook, before any awaited submitted-turn recording or response assembly;
- reuse the existing `CompletionRouter` key shape;
- not know whether the initiator is a dispatcher or a future peer TeamLeader.

Extend `TeammateService.send` with optional internal parameters rather than
adding a router policy class:

```ts
async send(input: {
  prompt: string;
  intent?: string;
  teamId?: string;
  turnOrigin?: TeamMateTurnOrigin;
  onSubmittedTurn?: (turnId: string) => void;
}): Promise<TeamMateSendResult>
```

The hook is called only when `channelInput` returns `submitted`, and it is called
synchronously with the accepted `turnId` before `recordSubmittedTurn(...)` or any
other awaited side effect. `TeamService.sendToLeader` uses the hook to call a
private helper such as `registerLeaderCompletionFor(leader, turnId, initiator)`.
The existing initial-prompt path can keep the current helper that derives the
initiator from `deps.initiatorFor(leader.current())`.

Do not add a pending-latch, unmatched-settle cache, or Team-specific branch to
`CompletionRouter` for this slice. The focused implementation contract is:
once an `AgentRuntime` returns a submitted `turnId`, Dreamux registers the
completion key before any local awaited recording work that could allow an
immediate settlement to win the race.

## Completion routing

Do not add Team MCP branching inside `CompletionRouter`.

The router already takes an abstract `CompletionInitiator`. The important
change is where that initiator is chosen:

- current initial TeamLeader prompt: still derived from producer identity;
- new dispatcher `team.send`: explicitly dispatcher agent, registered through
  the submitted-turn hook;
- future peer send: explicit caller-side initiator.

This keeps producer identity available for the completion envelope while avoiding
producer identity as the only delivery-target decision.

## Documentation and prompts

Update repo-local user-facing references that currently say `team.send` is
future-only:

- `.agents/reference/current-architecture.md`
- `.agents/reference/channel-runtime.md`
- `.agents/reference/dispatcher-skill.md`
- `packages/dreamux/skills/.claude/skills/dispatcher/SKILL.md`
- `packages/dreamux/src/service/dispatcher-service/base-prompt.ts`

Those docs should say dispatcher Team MCP supports `send` to the TeamLeader.
They should still say Team peer send is future work.

The dispatcher base prompt must explicitly enumerate the Team MCP tool list,
including `send`. It must not rely on the TeamMate MCP section's existing
`send` word to satisfy prompt parity by coincidence.

## Verification contract

Focused tests should cover:

- dispatcher `teamTools()` includes `send`;
- TeamLeader `teamTools('team_leader')` excludes `send`;
- hidden TeamLeader `send` calls are rejected;
- the admin `mcp.team.send` method rejects `caller_kind: 'team_leader'` with
  `BAD_REQUEST`;
- `mcp.team.send` forwards `team_name`, `prompt`, and optional `intent`;
- dispatcher `sendTeamLeader` submits to the TeamLeader and registers completion
  delivery to the dispatcher;
- a focused immediate-settle test proves completion registration occurs before
  awaited submitted-turn recording can let the settle path drop the completion;
- the submitted TeamLeader turn is recorded with `turn_origin: 'dispatcher'`;
- `mcp.team.send` returns `{ team, leader, turn }` with public `team` data and
  no binding summary;
- closed or missing Team failures are loud and map to `TEAM_NOT_FOUND`;
- shutdown rejection happens in `DispatcherService.sendTeamLeader`;
- dispatcher prompt parity passes because the Team MCP tool list explicitly
  mentions `send`, not because another MCP section already contains that word;
- existing `team.transfer_back` and `teammate.send` coverage remains intact.

The final implementation also needs a Rush change file because this adds a
model-facing MCP capability.

Run the relevant focused tests first, then the repo's standard Rush validation
appropriate for the final PR gate.

## Non-goals

This design does not introduce a general Team peer messaging API. It also does
not make Team MCP a replacement for TeamLeader-scoped TeamMate MCP member sends.
The only new model-facing capability is dispatcher send to TeamLeader.
