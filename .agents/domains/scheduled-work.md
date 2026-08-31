# Scheduled Work

This page is the stable contract for Dreamux scheduled prompt-agent work. It
consolidates the cron, agent-activity, and JSON-store decisions.

Read this before changing `SchedulerService`, `CronJobStore`, the cron MCP
delegate, or dispatcher/TeamLeader scheduler ownership.

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

A job's action union has one member: `{ kind: 'prompt-agent', prompt, intent? }`.
The reserved `spawn-teammate` shape and the `deliver: { channel_id, target_key }`
target were declared and parsed with nothing behind them, and are removed. The
raw-file parser now refuses either as `LegacyStateError` rather than admitting a
domain object that dispatch would have to skip, so there is no
"accepted but not implemented" state and no skip branch. `dreamux doctor`
reports such a store through `detectLegacyCronJobStore`; the fix is to delete
the job or the store file and recreate the schedule.

Source:

- `/packages/dreamux/src/service/scheduler/store.ts`
- `/packages/dreamux/src/platform/json-document-store.ts`
- `/packages/dreamux/src/service/scheduler/service.ts`

## Fire Semantics

A due fire is submitted immediately through the owner's ordinary admission gate.
No cancellation and no idle question cross that call: whether the runtime folds
the input into a turn that is already running or starts a new one is the
runtime's own decision, made where it is already made. There is no neutral
activity hook, no defer-until-idle race, and no scheduler-owned defer window.

`sourceId` is `scheduled:<job-id>:<fire-seq>` — stable for one fire, different
across recurring fires of the same job, so runtime-side dedupe cannot collapse a
later occurrence. The scheduler then records `last_fired_at`, recomputes
`next_run_at`, and disables a one-shot job. It never observes whether the
resulting turn succeeded.

Source:

- `/packages/dreamux/src/service/scheduler/service.ts`
- `/packages/dreamux/src/service/scheduler/types.ts`

## Owner Admission

`SchedulerService` is generalized over an owner and takes that owner's
admission gate plus its scheduled-submit callback. The dispatcher scheduler
submits into the dispatcher agent; a Team's scheduler submits into its
TeamLeader, whose lazy-start path is the normal state after a restart or between
conversations. The scheduler holds no runtime and applies no per-owner
missing-runtime policy of its own.

Source:

- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/team-service/index.ts`
- `/packages/dreamux/src/service/scheduler/service.ts`

## Startup And Teardown

The dispatcher scheduler is armed inside the dispatcher's input-source
lifecycle, after Workflows and before external admission opens. `start()`
reconciles every persisted job's durable state before arming any timer, so a
mid-reconcile IO failure leaves the scheduler fully un-started. Team schedulers
are resident for non-closed Teams, but TeamLeader runtimes are not started just
to arm cron, and closed Teams are not armed.

Dissolving a Team stops its scheduler with the rest of its resources and deletes
that Team's cron store file **after** the closed record is durable, so a failed
close leaves the still-open Team its jobs, and a successful one cannot let
scheduled work reattach to a later same-name Team with a fresh leader identity.

Source:

- `/packages/dreamux/src/service/dispatcher-service/input-source-lifecycle.ts`
- `/packages/dreamux/src/service/team-service/index.ts`
- `/packages/dreamux/src/service/team-service/closing.ts`
- `/packages/dreamux/src/service/scheduler/store.ts`

## MCP Surface

`scheduler.cron.list` / `create` / `update` / `delete` are ordinary Core
Commands declared by the scheduler's own `commands.ts`. The scheduler's MCP
delegate publishes `cron_create`, `cron_list`, `cron_update`, and `cron_delete`
with descriptor-bound dispatcher or Team scope, and the role→delegate decision
gives it to the dispatcher agent and every TeamLeader but not to ordinary
TeamMates or Team members. Neither surface accepts `deliver`, and neither
reports it. Runtime launches can disable a runtime's native cron feature with
the neutral `cron` feature name so Dreamux-owned cron remains the source of
truth.

Source:

- `/packages/dreamux/src/service/scheduler/commands.ts`
- `/packages/dreamux/src/service/scheduler/mcp-delegate.ts`
- `/packages/dreamux/src/service/dispatcher-service/mcp-delegates.ts`
- `/packages/dreamux/src/agent-runtime/host-context.ts`

## Decision Trail

- [Cron per conversational agent](../decisions/cron-per-conversational-agent.md)
- [Agent activity capability](../decisions/agent-activity-capability.md)
- [Json document store](../decisions/json-document-store.md)
