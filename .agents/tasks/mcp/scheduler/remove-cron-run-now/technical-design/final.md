# Remove Cron Run-Now

## Outcome

Retire the broken manual cron fire capability completely. Scheduled jobs continue
to fire only from their configured schedules.

## Change

- Remove `cron_run_now` from the cron MCP tool catalog and call mapping.
- Remove `scheduler.cron.run_now` from the admin method registry.
- Remove `SchedulerCommands.runNow`, `SchedulerService.runNow`, and Team scheduler
  forwarding. Leave no alias, replacement endpoint, test-only hook, or unused
  helper.
- Remove the manual-dispatch option and keep the existing timer behavior as the
  only dispatch path. Preserve `dispatchAdmitted` and its lifecycle-generation
  shutdown guard.
- Make the timer-only dispatch orchestration return `Promise<void>` so no
  manual-run status contract remains; keep submission outcomes internal to the
  scheduler's persistence and rearm decisions.
- Replace tests that invoked `runNow` with deterministic timer-driven tests.
  Retain coverage for defer-until-idle, held fires, delete/stop races, lazy runtime
  start, dispatch-error rearm, the queued-admission generation race, and
  same-job held-fire collapse after an update rearms the timer.
- Add retirement contracts: MCP rejects `cron_run_now` without forwarding an
  admin request, and the admin socket returns `UNKNOWN_METHOD` for
  `scheduler.cron.run_now`. Keep registration coverage for the four retained
  scheduler admin methods.
- Update current bundled skills, documentation, and the Rush breaking change note
  to expose only create/list/update/delete.

## Unchanged

- Cron job schema, persistence, timing, scheduler ownership, and normal timer
  semantics.
- The official-SDK MCP server architecture on `next`.

## Task-record organization

- Root task discovery at `.agents/tasks/README.md` and route this lineage through
  `mcp/scheduler/remove-cron-run-now`, with no repository-name layer.
- Keep a README index at each domain level. Accept slash-separated domain paths
  in the task initializer and reject a broken root-to-leaf index chain.
- Record the routing rule in its own current decision instead of rewriting the
  provenance of the earlier lean-task decision.

## Verification

- Focused scheduler, Team scheduler, cron MCP, skill, admin namespace, MCP
  whitelist, and protocol-conformance tests.
- Rush build, lint, and package tests; KB validation and `git diff --check`.
- A production-source scan confirming the removed symbols are absent.
