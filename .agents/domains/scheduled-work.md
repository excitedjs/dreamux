# Scheduled Work

This page is the stable contract for Dreamux scheduled prompt-agent work. It
consolidates the cron, agent-activity, and JSON-store decisions.

Read this before changing `SchedulerService`, `CronJobStore`, cron MCP,
`waitIdle`, or dispatcher/TeamLeader scheduler ownership.

## Ownership

Every directly conversational agent owns its own scheduler:

- the dispatcher agent owns
  `~/.dreamux/state/<dispatcher-id>/cron-jobs.json`;
- each non-closed TeamLeader owns
  `~/.dreamux/state/<dispatcher-id>/team/<team-id>/cron-jobs.json`;
- ordinary TeamMates and Team members do not get cron MCP or schedulers.

The store path scopes jobs. The job schema still carries `dispatcher_id`, which
is validated against the owning dispatcher; Team isolation comes from the path,
not from adding `team_id` to every job.

Source:

- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/team-service/index.ts`
- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/service/scheduler/store.ts`

## Store Contract

`CronJobStore` is a versioned JSON document store over `JsonDocumentStore`.
It writes atomically, serializes mutations through an internal queue, and fails
loud on legacy/incompatible schema.

Current persisted actions include `prompt-agent` and a reserved
`spawn-teammate` shape. Current scheduler dispatch implements `prompt-agent`;
non-`prompt-agent` actions are skipped with a warning until a later design lands
their delivery semantics.

Source:

- `/packages/dreamux/src/service/scheduler/store.ts`
- `/packages/dreamux/src/platform/json-document-store.ts`
- `/packages/dreamux/src/service/scheduler/service.ts`

## Runtime Activity

`AgentRuntime.waitIdle?()` is the neutral activity hook. It resolves when no
turn is in progress. For scheduler deferral, a runtime that omits it is treated
as already idle.

The scheduler is the current consumer. For each fire, it races:

- `runtime.waitIdle?.() ?? Promise.resolve()`;
- scheduler maximum defer window;
- scheduler stop signal.

This is intentionally caller-owned timeout logic. The runtime owns no
scheduler-specific timeout, cancellation, or subscription mechanism.

Durable Team dissolve is a separate strict consumer of the same neutral hook.
It rejects acceptance unless every process-live shared-worktree writer exposes
`waitIdle()`, then waits for the captured TeamLeader and members before its
second worktree assessment. That lifecycle rule does not change scheduler
fallback semantics.

Source:

- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/dreamux/src/service/scheduler/service.ts`
- `/packages/dreamux/src/service/team-collection/dissolve-runner.ts`
- `/packages/agent-runtime/codex/src/runtime.ts`
- `/packages/agent-runtime/claude-code/src/runtime.ts`

## Absent Runtime Policy

`SchedulerService` is generalized over an owner, but the missing-runtime policy
differs by owner:

- dispatcher scheduler: `absentRuntimeStrategy: 'miss'`. A missing dispatcher
  runtime means the start transaction failed or was torn down; cron must not
  resurrect it outside `DispatcherService.doStart()`.
- TeamLeader scheduler: `absentRuntimeStrategy: 'submit'`. A missing TeamLeader
  runtime is the normal lazy state after daemon restart or between
  conversations; scheduled input goes through the TeamLeader lazy-start path.

Source:

- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/team-service/index.ts`
- `/packages/dreamux/src/service/scheduler/service.ts`

## Startup And Teardown

Dispatcher startup arms the dispatcher scheduler. Team schedulers are resident
for non-closed Teams, but TeamLeader runtimes are not started just to arm cron.
Closed Teams are not armed. Dissolving a Team stops its TeamLeader scheduler and
deletes that Team's cron store file, so scheduled work cannot reattach to a
later same-name Team with a fresh leader identity.

Source:

- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/team-collection/index.ts`
- `/packages/dreamux/src/service/team-service/index.ts`
- `/packages/dreamux/src/service/scheduler/store.ts`

## MCP Surface

Cron tools are exposed through the `cron-mcp` shim to the agent roles that
receive scheduled-work capabilities. Runtime launches can disable a runtime's
native cron feature with the neutral `cron` feature name so Dreamux-owned cron
remains the source of truth.

Source:

- `/packages/dreamux/src/mcp/cron-mcp.ts`
- `/packages/dreamux/src/service/scheduler/mcp-config.ts`
- `/packages/dreamux/src/agent-runtime/host-context.ts`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/team-service/index.ts`

## Decision Trail

- [Cron per conversational agent](../decisions/cron-per-conversational-agent.md)
- [Agent activity capability](../decisions/agent-activity-capability.md)
- [Json document store](../decisions/json-document-store.md)
