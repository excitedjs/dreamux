# Remove Cron Run-Now

- **Status:** Implemented historical proposal; current behavior is documented in
  [Scheduled work](../../domains/scheduled-work.md),
  [Service topology](/.agents/domains/service-topology.md#schedulerservice--schedulercommands),
  and [Dispatcher skill](/.agents/domains/dispatcher-skill.md)
- **Date:** 2026-08-14
- **Affects:** `/packages/dreamux/src/service/scheduler/`,
  `/packages/dreamux/src/admin/methods.ts`,
  `/packages/dreamux/src/mcp/cron-mcp.ts`, bundled Dispatcher and TeamLeader
  workflow skills, scheduler/MCP contract tests, and current documentation

## Intent

Remove the manual run-now capability and its complete call chain. It currently
has two callable entries: the model-facing `cron_run_now` tool and the direct
admin control-plane method `scheduler.cron.run_now`. The MCP call is made from
the same conversational agent turn that owns the target scheduler: `run_now`
waits for that agent to become idle before injecting the scheduled prompt,
while the active turn waits for the MCP call to return. The observed result is
an admin socket timeout rather than a manual fire.

## Scope

- Remove `cron_run_now` from the cron MCP `tools/list` response and tool-call
  mapping.
- Remove the `scheduler.cron.run_now` admin method, `SchedulerCommands.runNow`,
  `SchedulerService.runNow`, and Team scheduler forwarding.
- Collapse timer dispatch to one path by removing the dispatch `manual` option
  and its two conditional branches: held-fire collapse and dispatch-error rearm
  become unconditional timer behavior. Preserve `dispatchAdmitted` and its
  lifecycle-generation guard; the timer path still needs that stop-race fence.
- Add a direct admin-socket contract test that the removed
  `scheduler.cron.run_now` method returns `UNKNOWN_METHOD`; do not retain a
  compatibility alias.
- Rewrite run-now-dependent tests in `scheduler.test.ts` and
  `team-scheduler.test.ts` with Vitest fake timers and deterministic async
  progress helpers. Preserve defer-until-idle, fresh source ids,
  held-fire/delete/stop races, lazy runtime start, dissolve/closing admission,
  and failure-rearm coverage without real minute-long waits or a test-only
  production entry point. Update `teammate-mcp-skills.test.ts` and
  `cron-mcp.test.ts` for the reduced tool surface and unknown-tool rejection.
- Update the bundled Dispatcher and TeamLeader workflow skills, current README
  and KB references, and contract tests to advertise exactly the remaining
  create/list/update/delete tool set.
- Add a breaking Rush change entry for removal of both the model-facing MCP
  tool and the direct admin control-plane method.

## Hard Constraints

- Do not change scheduler timing, defer-until-idle, persistence, state shape, or
  ownership.
- Do not replace the removed capability with a fire-and-forget variant, hidden
  alias, or test-only production method.
- Preserve timer-driven scheduler behavior and its load-bearing lifecycle,
  defer-until-idle, held-fire, and failure-rearm coverage.
- Do not remove or weaken the lifecycle-generation check in
  `dispatchAdmitted`; it remains load-bearing for timer callbacks racing owner
  stop.
- Do not use real-time minute waits in scheduler tests. Fake-timer test helpers
  must not depend on real `setTimeout` polling.

## Acceptance

- Cron MCP exposes exactly `cron_create`, `cron_list`, `cron_update`, and
  `cron_delete` to Dispatchers and TeamLeaders.
- Current production source under `/packages/dreamux/src/` contains no `cron_run_now`,
  `scheduler.cron.run_now`, or `runNow` scheduler capability.
- Calling `cron_run_now` through the cron MCP is rejected as an unknown tool.
- Calling `scheduler.cron.run_now` through the admin socket returns
  `UNKNOWN_METHOD` through the existing retired-method contract test.
- Bundled skills and current documentation contain no claim that
  manual cron execution is available.
- Timer-driven fires retain the same defer, lifecycle, persistence, and error
  behavior, with focused coverage that does not depend on removed production
  functions.
- Focused MCP/skill contract tests, repository KB validation, Rush build, test,
  and lint pass.

## Out of Scope

- Changing cron job formats, scheduler lifecycle, or agent activity contracts.
- Adding a replacement manual-execution path.
