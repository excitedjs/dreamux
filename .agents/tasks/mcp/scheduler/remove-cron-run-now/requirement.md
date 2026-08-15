# Requirement

## Initial request

- Remove the broken cron immediate-run capability and its complete dependency chain without compatibility aliases or unused code.

## Current alignment

- Status: Confirmed by the operator on 2026-08-14.
- Confirmed current behavior and evidence: Invoking the model-facing
  `cron_run_now` tool for a temporary job timed out after 10 seconds because
  the active conversational turn waited for the same target runtime to become
  idle. The temporary job was deleted after reproduction.
- Desired outcome: Remove the broken cron immediate-run capability and its complete dependency chain without compatibility aliases or unused code.
- Desired behavior: Scheduled jobs fire only from their configured schedules;
  operators can change a future fire time with `cron_update`.
- Scope: Remove the model-facing `cron_run_now` tool, the direct admin method
  `scheduler.cron.run_now`, the scheduler command and service method, Team
  forwarding, manual-dispatch-only branches, related tests, and current
  documentation claims.
- Non-goals: Do not add a replacement immediate-fire path or change cron job
  formats, scheduler ownership, persistence, or normal timer scheduling.
- Constraints and invariants: Preserve timer-driven defer-until-idle,
  held-fire, dispatch-error rearm, lifecycle-generation stop-race protection,
  and current persisted state semantics. Do not retain compatibility aliases,
  unused code, or test-only production hooks.

## Acceptance criteria

- Cron MCP exposes exactly `cron_create`, `cron_list`, `cron_update`, and
  `cron_delete`.
- Production source under `packages/dreamux/src/` contains no
  `cron_run_now`, `scheduler.cron.run_now`, or scheduler `runNow` capability.
- MCP rejects `cron_run_now` as an unknown tool without forwarding an admin
  request; the admin socket rejects `scheduler.cron.run_now` with
  `UNKNOWN_METHOD`.
- Timer-driven scheduler behavior retains focused deterministic coverage
  without real minute waits or a test-only production entry point.
- Bundled skills, current documentation, and contract tests describe only the
  remaining four cron tools.
- The task record lives at
  `.agents/tasks/mcp/scheduler/remove-cron-run-now`; task discovery has no
  repository-name layer, and the initializer validates the full nested-domain
  index chain.
- Focused tests, MCP protocol conformance, Rush build/lint/test, KB validation,
  and diff checks pass, except for any explicitly evidenced unrelated live
  integration outage.

## Decisions and unknowns

- Confirmed operator decisions: Reproduce the failure directly; perform a pure
  deletion; remove dependent functions completely; leave no unused code. The
  operator authorized creation of this task record, then explicitly directed
  its capability-domain path and removal of the `.agents/tasks/dreamux` layer
  on 2026-08-14.
- Assumptions: None.
- Blocking unknowns: None.
