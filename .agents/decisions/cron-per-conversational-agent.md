# Cron per conversational agent

- **Status:** Accepted
- **Date:** 2026-06-25
- **Affects:** `SchedulerService`, `CronJobStore`, `TeamCollection`,
  `TeamService`, cron MCP/admin routing, startup preflight
- **Supersedes:** scheduled-tasks baseline R4/OQ-8 "no TeamLeader cron in v1"

## Context

The first shipped scheduled-tasks slice made cron per dispatcher. That gave the
dispatcher agent a durable scheduler, but it did not satisfy the user-facing
model for Team Mode: a TeamLeader is also a directly conversational agent, and a
reminder created while talking to that TeamLeader must fire into the TeamLeader's
own runtime, not the dispatcher's runtime.

The dispatcher agent and each TeamLeader are both `TeammateService` instances.
They already expose the scheduler's required host seam:
`getRuntime(): AgentRuntime | null` and `scheduledInput({ jobId, prompt })`.
The scheduler therefore does not need to know about Team lifecycle; it only needs
an owner id for logs, a path-scoped `CronJobStore`, and an absent-runtime policy.

## Decision

Every directly conversational agent owns its own cron scheduler:

- The dispatcher agent owns the dispatcher scheduler at
  `~/.dreamux/state/<dispatcher-id>/cron-jobs.json`.
- Each non-closed TeamLeader owns a Team scheduler at
  `~/.dreamux/state/<dispatcher-id>/team/<team-id>/cron-jobs.json`.
- Regular Team members do not get cron MCP or a scheduler.

`CronJobStore` is path-scoped. The persisted job format is unchanged: every job
still carries the existing `dispatcher_id` field, validated against the owning
dispatcher id. Team isolation is by the cron-jobs file path, not by adding a
team id to the job schema.

`SchedulerService` is generalized from dispatcher to owner. The dispatcher uses
`absentRuntimeStrategy: 'miss'`: a missing dispatcher runtime means the start
transaction failed or was torn down, so cron must not resurrect it outside
`DispatcherService.doStart()`. TeamLeader schedulers use
`absentRuntimeStrategy: 'submit'`: a missing TeamLeader runtime is the normal
lazy state after daemon restart or between conversations, and `scheduledInput`
is the correct host-owned lazy-start path.

## Startup invariant

Non-closed Team schedulers, not TeamLeader runtimes, are resident at dispatcher
boot. `DispatcherService.doStart()` starts the dispatcher scheduler, then asks
`TeamCollection` to enumerate the dispatcher's non-closed teams and start each
TeamLeader scheduler. Building that `TeamService` reads the Team record and
leader identity, but starts no runtime unless a scheduled fire actually submits.

This supersedes the earlier Team lifecycle note that Teams are materialized only
on first conversational access. That remains true for TeamLeader runtimes, but
not for TeamLeader schedulers. The eager scheduler arm is required for durable
cron to survive daemon restarts when nobody addresses the Team first.

Closed Teams are not armed. TeamCollection's durable dissolve closes scheduler
admission and stops the Team scheduler at acceptance; the accepted logical
resource close in `TeamService` deletes that Team's `cron-jobs.json`, so
scheduled work cannot reattach to a later same-name Team with a fresh leader
identity.

## TeamLeader cron safety

The scheduled-tasks baseline rejected TeamLeader cron in v1 because scheduled
egress and guardrails were not settled. This decision supersedes that guardrail
for prompt-agent cron only:

- Structured `deliver` remains unimplemented and rejected.
- A scheduled prompt is injected into the TeamLeader runtime; the TeamLeader's
  normal channel tools still gate egress to the Team's bound channel.
- Regular Team members still receive no cron MCP surface.

The risk is therefore bounded to the same capability the user already has when
talking to the TeamLeader directly, with the existing Team channel authorization
still enforced.

## References

- Originating proposal:
  [archived cron-for-TeamLeaders proposal](../archive/proposals/scheduled-tasks-team-leader.md).
- Baseline it extends:
  [archived scheduled-tasks proposal](../archive/proposals/scheduled-tasks.md),
  [agent activity capability](agent-activity-capability.md).
