# Reference: scheduled tasks

Dreamux has an in-process scheduler for durable cron-style jobs owned by each
dispatcher and each non-closed Team. A job does exactly one thing: at its due
time it injects its prompt into the conversational agent that owns the schedule
— the dispatcher agent or that Team's TeamLeader. It spawns no agent, addresses
no Channel, and observes no outcome.

## Persistence

Dispatcher jobs live in `~/.dreamux/state/<dispatcher-id>/cron-jobs.json`; a
Team's jobs live in
`~/.dreamux/state/<dispatcher-id>/team/<team-id>/cron-jobs.json`. Each file is
one versioned JSON document backed by `JsonDocumentStore<TDoc>` and
`CronJobStore`. A missing file means "no jobs"; a malformed or wrong-version
file fails loud, and `dreamux doctor` reports it through
`detectLegacyCronJobStore`.

The v1 row stores `cron`, `tz`, `recurring`, `enabled`, `next_run_at`,
`last_fired_at`, an optional `title`, and one `action`. The action union has a
single member, `{ kind: 'prompt-agent', prompt, intent? }`.

`spawn-teammate` actions and a `deliver: { channel_id, target_key }` target were
once declared and parsed with no execution behind them. They are removed: the
raw-file parser refuses either one as `LegacyStateError` rather than accepting
it as a domain object that later branches would have to skip. A store carrying
one is not current state — the job must be deleted and recreated.

Key source:

- `/packages/dreamux/src/platform/json-document-store.ts`
- `/packages/dreamux/src/service/scheduler/store.ts`
- `/packages/dreamux/src/platform/paths.ts`

## Execution

`SchedulerService` is owned by the CONTAINER — `DispatcherService` owns the
dispatcher scheduler, each non-closed `TeamService` owns its Team scheduler —
and is constructed there with the container's own `CronJobStore`, its admission
gate, and its scheduled-submit callback. `TeammateService` carries no scheduler,
so "only the dispatcher and each TeamLeader have cron" is structural rather than
a per-instance capability policy.

`start()` reconciles every persisted job's durable state before arming any
timer, so a mid-reconcile IO failure leaves the scheduler fully un-started.
The dispatcher scheduler starts inside the dispatcher's input-source lifecycle,
after Workflows and before external admission opens. A Team's scheduler starts
with its `TeamService` and stops when the Team closes; the closed Team's store
file is deleted after its closed record is durable.

A due fire submits immediately through the owner's ordinary admission gate. No
cancellation and no idle question cross that call: whether the runtime folds the
input into a turn that is already running or starts a new one is the runtime's
decision, made where it is already made. The scheduler then records
`last_fired_at`, recomputes `next_run_at`, and disables a one-shot job. It never
observes whether the resulting turn succeeded.

`sourceId` is `scheduled:<job-id>:<fire-seq>` — stable for one fire, different
across recurring fires of the same job, so runtime-side dedupe cannot collapse
a later occurrence.

Key source:

- `/packages/dreamux/src/service/scheduler/service.ts`
- `/packages/dreamux/src/service/scheduler/types.ts`
- `/packages/dreamux/src/service/dispatcher-service/input-source-lifecycle.ts`
- `/packages/dreamux/src/service/team-service/index.ts`

## Management surface

`scheduler.cron.list` / `create` / `update` / `delete` are ordinary Core
Commands declared by the scheduler's own `commands.ts`, so `admin.sock` and an
in-process Channel `invoke` reach the same definitions. The scheduler's MCP
delegate publishes `cron_create`, `cron_list`, `cron_update`, and `cron_delete`
with descriptor-bound dispatcher or Team scope, and is injected into the
dispatcher agent and every TeamLeader but not into ordinary TeamMates or Team
members. The delegate owns no scheduling state and repeats no Command
validation; neither surface accepts `deliver`, and neither reports it.

Key source:

- `/packages/dreamux/src/service/scheduler/commands.ts`
- `/packages/dreamux/src/service/scheduler/mcp-delegate.ts`
- `/packages/dreamux/src/service/dispatcher-service/mcp-delegates.ts`
