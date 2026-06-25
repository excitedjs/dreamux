# Reference: scheduled tasks

Dreamux has a per-dispatcher in-process scheduler for durable cron-style jobs.
The implemented milestone covers resident dispatcher-agent execution end to end:
contract/activity support, provider busy/idle reporting, durable storage,
`prompt-agent` scheduled injection, and the conversational management surface
(admin methods, the `dreamux cron` CLI, and the Cron MCP). `spawn-teammate` and
deliver/egress jobs remain follow-up work and are fail-loud rejected for now.

## Runtime Activity Contract

The neutral Agent Runtime contract exposes one optional method,
`waitIdle?(): Promise<void>`. Core feature-detects the method and treats a
runtime that omits it as always idle, instead of reconstructing busy state from
submit/settle events.

- Codex activity is owned by `TurnManager`; a claimed `activeTurnSlot` counts as
  busy even before the app-server returns a turn id.
- Claude Code activity is owned by `ClaudeCodeRuntime`; only real queue entries
  increment the count. Steer-folded channel input does not increment it.

Key source:

- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/agent-runtime/codex/src/turn-manager.ts`
- `/packages/agent-runtime/codex/src/runtime.ts`
- `/packages/agent-runtime/claude-code/src/runtime.ts`

## Persistence

Scheduled jobs live in
`~/.dreamux/state/<dispatcher-id>/cron-jobs.json`. The file is a single
versioned JSON document backed by `JsonDocumentStore<TDoc>` and `CronJobStore`.
Missing files mean "no jobs"; malformed or wrong-version files fail loud at
serve preflight.

The v1 row stores:

- `cron`, `tz`, `recurring`, `enabled`, `next_run_at`, `last_fired_at`.
- `action.kind`, currently executed only for `prompt-agent`.
- Optional neutral `deliver: { channel_id, target_key }`, parsed but not
  accepted for new jobs until the neutral egress injection contract exists.

Key source:

- `/packages/dreamux/src/platform/json-document-store.ts`
- `/packages/dreamux/src/service/scheduler/store.ts`
- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/server.ts`

## Execution

`SchedulerService` is owned by `DispatcherService`. It starts after the
dispatcher agent, channel sessions, and restart-notice injection have completed,
and it stops before channel sessions and the agent runtime are stopped.

For `prompt-agent` jobs the scheduler:

1. Collapses duplicate fires of the same job while one fire is held.
2. Waits for the dispatcher agent runtime to become idle, with scheduler-owned
   max-defer timeout/cancel guards.
3. Calls `systemInput({ kind: "system", reason: "scheduled", text })`.
4. Records a structured turn origin `{ kind: "scheduled", job_id }` in the
   dispatcher agent turn archive.
5. Updates `last_fired_at`, recomputes `next_run_at`, and disables one-shot jobs.

It does not observe terminal success or failure of the agent turn. `deliver`
jobs are not converted into prompt text; they are skipped until neutral egress
delivery is implemented.

The conversational management surface wraps the same `SchedulerService`:
`admin/methods.ts` exposes the `scheduler.cron.*` admin methods, the `dreamux
cron` CLI (`cli/commands/cron-mcp.ts`) drives them, and the Cron MCP
(`mcp/cron-mcp.ts`) mirrors the native scheduling tool surface; the Cron MCP is
injected into the dispatcher agent only (not team_leader/teammate).

Key source:

- `/packages/dreamux/src/service/scheduler/service.ts`
- `/packages/dreamux/src/service/scheduler/mcp-config.ts`
- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/teammate-service/index.ts`
- `/packages/dreamux/src/admin/methods.ts`
- `/packages/dreamux/src/mcp/cron-mcp.ts`

## Tests

The current regression coverage pins the load-bearing traps:

- Codex false-idle window and `waitIdle` waiter flushing.
- Claude steer-fold input not inflating the busy counter.
- `JsonDocumentStore` and `CronJobStore` round-trip/fail-loud + persisted-job
  preflight behavior.
- Scheduler `prompt-agent` defer-until-idle injection, held-fire collapse,
  stop-cancels-a-held-fire, the pre-submit stop race, and disabled/prompt-only
  update semantics.

Key source:

- `/packages/agent-runtime/codex/tests/turn-manager.test.ts`
- `/packages/dreamux/tests/claude-code-runtime.test.ts`
- `/packages/dreamux/tests/scheduler.test.ts`
