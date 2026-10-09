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

The store path scopes jobs: Team isolation comes from the path, not from a
`team_id` on every job. A freshly written job carries no `dispatcher_id`
field at all; an old file's leftover one loads as an ordinary unknown field
under the persisted-shape policy (tolerate unknown fields, reject only wrong
types and missing fields) and is never cross-checked against the owning
dispatcher.

Source:

- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/team/service.ts`
- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/service/scheduler/store.ts`

## Store Contract

`CronJobStore` holds one `TransactionalStore<CronJobFile>`
(`@excitedjs/dreamux-utils`) over `cron-jobs.json`. Every read serves the
loaded value; every mutation goes through the store's own `update`/`remove`,
so a read-modify-write is atomic without a second queue. Its loader inlines
the version-mismatch and missing-file-default check every persisted-document
owner applies, then parses and validates the file; a version mismatch or a
malformed document fails loud as `LegacyStateError`, and a missing file is the
empty default (`{version: 1, jobs: []}`).

The v1 row stores `cron`, `tz`, `recurring`, `enabled`, `next_run_at`,
`last_fired_at`, an optional `title`, and one `action`. The action union has one
member: `{ kind: 'prompt-agent', prompt }`. A freshly created row writes neither
`dispatcher_id` (see Ownership above for what an old file's leftover one still
does on read) nor `action.intent`, a write-only diagnostic no code ever read
back; an old file's leftover `intent` key loads the same way, as an ordinary
unknown field under the persisted-shape policy.
The reserved `spawn-teammate` shape and the `deliver: { channel_id, target_key }`
target were declared and parsed with nothing behind them, and are removed. The
raw-file parser now refuses either as `LegacyStateError` rather than admitting a
domain object that dispatch would have to skip, so there is no
"accepted but not implemented" state and no skip branch. `dreamux doctor`
reports such a store through `detectLegacyCronJobStore`; the fix is to delete
the job or the store file and recreate the schedule.

Source:

- `/packages/dreamux/src/service/scheduler/store.ts`
- `/packages/dreamux-utils/src/transactional-store.ts`
- `/packages/dreamux/src/service/scheduler/index.ts`

## Fire Semantics

A due fire is submitted immediately through the owner's ordinary admission gate.
No cancellation and no idle question cross that call: whether the runtime folds
the input into a turn that is already running or starts a new one is the
runtime's own decision, made where it is already made. There is no neutral
activity hook, no defer-until-idle race, and no scheduler-owned defer window.

`sourceId` is `scheduled:<job-id>:<fire-seq>` — stable for one fire, different
across recurring fires of the same job, so runtime-side dedupe cannot collapse a
later occurrence. On an accepted or ambiguous submission the scheduler records
`last_fired_at` in the same store transaction that reads the current row. A pause
or replacement `next_run_at` made while admission was pending is preserved. Only
the submitted occurrence advances the current recurrence or disables its one-shot.
That advance earns a new timer. A preserved replacement retains its writer's
timer ownership; re-arming it from an older settlement could dispatch it again
after its own timer has already fired.
The scheduler never observes whether the resulting turn succeeded.

Sparse updates are normalized against the current row inside that store's
serialized transaction. Concurrent edits therefore preserve omitted fields and
derive the next occurrence from the current schedule and enabled state; they do
not merge independently read snapshots. Provider submission stays outside the
store transaction.

A fire whose submission is not accepted, or whose dispatch itself throws, is
rearmed as a miss through the same `next_run_at` recompute but without writing
`last_fired_at`: a recurring job advances to its next occurrence, and a
one-shot is disabled immediately — including a one-shot whose dispatch threw,
which used to stay enabled with a stale `next_run_at` until the next
`start()`'s reconcile.

Source:

- `/packages/dreamux/src/service/scheduler/index.ts`
- `/packages/dreamux/src/service/scheduler/types.ts`

## Owner Admission

`SchedulerService implements SchedulerCommands` directly — there is no
`.commands` adapter object standing between the class and its `list`/`create`/
`update`/`delete` methods. It is generalized over an owner and takes that
owner's actual work fence and input recipient. It constructs `SCHEDULED_SOURCE`
input itself and invokes the recipient's `submitInput`. `AgentService`
carries no scheduler, so "only the dispatcher and each TeamLeader have cron"
is structural rather than a per-instance capability policy. The dispatcher
scheduler submits into the dispatcher agent; a Team's scheduler submits into
its TeamLeader, whose lazy-start path is the normal state after a restart or
between conversations. The scheduler holds no runtime and applies no
per-owner missing-runtime policy of its own.

A Team's scheduler holds the actual TeamService as its fence. For every
operation — `create`/`update`/`delete`/`list` and a due fire alike —
`TeamService.admit` checks the Team and then enters the dispatcher's WorkFence.
There is no second SchedulerCommands wrapper or admission closure.
A mutation racing an in-flight Team dissolve is
therefore refused by the Team's own closing fence — up from the moment
dissolve is submitted, not from when the `closed` record lands — before it
ever reaches the store. That ordering matters because the scheduler's own
store deletion (`SchedulerService.destroy()`) runs only after the `closed`
record commits (R62): nothing can recreate a cron store file `destroy()` is
about to delete, and there is no window where the store is already gone but
the commit that authorized deleting it might still fail. A fire crosses
the Team-only check again inside `submitInput`, which fences every leader
submission and is not special-cased for cron. It does not enter dispatcher
admission again; this same Team-only boundary preserves queued completion
delivery when the dispatcher starts closing.

Source:

- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/team/service.ts`
- `/packages/dreamux/src/service/scheduler/index.ts`

## Startup And Teardown

The dispatcher scheduler is armed inside the dispatcher's input-source
lifecycle, after Workflows and before external admission opens. `start()`
reconciles every persisted job's durable state before arming any timer, so a
mid-reconcile IO failure leaves the scheduler fully un-started. Team schedulers
are resident for non-closed Teams, but TeamLeader runtimes are not started just
to arm cron, and closed Teams are not armed.

Dissolving a Team writes the record `closed` first (R62); a dissolve that
fails before that write lands leaves the scheduler exactly as it was, still
armed — the write is the operation's one reversible step. Only once `closed`
commits does the Team destroy its children in turn, including the scheduler's
own `destroy()` (`stop()` plus deleting its own cron store file), alongside
every other child service; a `destroy()` failure there is logged, never
retried, and never reopens the Team, the same as any other post-`closed`
cleanup step. A successful dissolve cannot let scheduled work reattach to a
later same-name Team with a fresh leader identity while its valid Team record
still exists: `record.json` occupies the concrete name and a closed Team is
never rebuilt, so no `SchedulerService` is constructed for that closed record
again — regardless of whether
`destroy()`'s own store-file deletion succeeded. Deleting the store file
loads it first, so a cron store that fails its own version/shape check at
that exact moment fails the delete too — one of the dissolve's ordinary
collected cleanup-step failures, handled the same way as any other resource
that would not close.

A fully retired record is read from disk on the next lookup. Missing or damaged
records no longer occupy a name; active and unfinished-cleanup records retain
their memory authority. That boundary belongs to
[Team Records](state-config-and-files.md#team-records), not a scheduler tombstone.

Source:

- `/packages/dreamux/src/service/dispatcher-service/lifecycle.ts`
- `/packages/dreamux/src/service/team/service.ts`
- `/packages/dreamux/src/service/scheduler/store.ts`

## MCP Surface

`scheduler.cron.list` / `create` / `update` / `delete` are ordinary Core
Commands declared by the scheduler's own `commands.ts`. The scheduler's MCP
delegate (`mcp.ts`) publishes `cron_create`, `cron_list`, `cron_update`, and
`cron_delete` with descriptor-bound dispatcher or Team scope, and the
role→delegate decision gives it to the dispatcher agent and every TeamLeader
but not to ordinary TeamMates or Team members. Both adapters read the payload
through the same `requests.ts` (`cronCreateRequest`, `cronUpdateRequest`,
`cronJobIdParam`) and project the same result shape back through it
(`cronJobResult`, `cronListResult`) — the scheduler's `types.ts` holds only the
domain and option types, not the codecs. Neither surface accepts `deliver`,
and neither reports it. Runtime launches can disable a runtime's native cron
feature with the neutral `cron` feature name so Dreamux-owned cron remains the
source of truth.

Source:

- `/packages/dreamux/src/service/scheduler/commands.ts`
- `/packages/dreamux/src/service/scheduler/mcp.ts`
- `/packages/dreamux/src/service/scheduler/requests.ts`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/team/service.ts`
- `/packages/dreamux/src/agent-runtime/host-context.ts`

History: [/.agents/tasks/mcp/README.md](/.agents/tasks/mcp/README.md) — the
cron rulings live in the scheduler task records.
