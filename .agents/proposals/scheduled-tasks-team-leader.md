# Proposal: cron for team leaders (per-conversational-agent scheduler)

Status: draft for review. Extends the shipped per-dispatcher scheduler
(`.agents/proposals/scheduled-tasks.md`, PR #239).

## Problem

Today the cron scheduler is **per-dispatcher**: one `SchedulerService` owned by
`DispatcherService`, firing `defer-until-idle` into the dispatcher agent, with a
cron store at `~/.dreamux/state/<dispatcher-id>/cron-jobs.json` and a cron MCP
injected only into the dispatcher agent (`dispatcher-service/mcp-descriptors.ts`).

Requirement (user): **every agent the user can directly converse with must have
working cron** — at minimum the dispatcher AND each team leader. A team leader's
"remind me every morning" must fire into the **team leader's own runtime** and
reply in the team's chat, not the dispatcher's.

A team leader using the dispatcher's shared scheduler would fire into the
dispatcher (wrong chat) — so a shared scheduler does NOT satisfy "available to the
leader". The correct model is one scheduler per conversational agent.

## Key insight (why this is cheap)

The dispatcher agent and a team leader are **both `TeammateService` instances**
(dispatcher: `dispatcher-service/agent.ts`; leader: `team-service/index.ts:66`).
Both already expose the exact interface the scheduler needs:
`getRuntime(): AgentRuntime | null` and `scheduledInput({jobId, prompt})`. The
`SchedulerService` itself has no dispatcher-specific logic — only its *store path*,
*admin routing key*, and *MCP injection site* are dispatcher-bound today.

## Concept: a "cron host"

A **cron host** is a channel-bound, user-addressable agent that owns a scheduler.
There are exactly two kinds, both `TeammateService`:
- the **dispatcher agent** (keyed by `dispatcherId`), and
- each **team leader** (keyed by `dispatcherId` + `teamId`).

Regular team members are workers the user does not directly converse with — they
get NO cron (unchanged).

## Design

### 1. Generalize `SchedulerService` from "dispatcher" to "owner"

`SchedulerServiceOptions` changes:
- `dispatcherId: string` → `ownerId: string` (unique key, used for logging and the
  job `dispatcher_id` validation value — see store note below).
- add `store: CronJobStore` constructed with an explicit **resolved cron-jobs
  path** (today the store derives the path from `dispatcherId`).
- add `onAbsentRuntime: 'miss' | 'lazy-start'` (see §4).

`getRuntime` / `submitScheduled` already point at the host's `TeammateService` —
unchanged and uniform.

### 2. Generalize `CronJobStore` to a path, not a dispatcher id

`CronJobStore` is constructed with `{ cronJobsPath, dispatcherId }`:
- `cronJobsPath` — where the file lives (the only location source).
- `dispatcherId` — the value persisted in each job's existing `dispatcher_id`
  field and checked by `assertCronJobSemantics`. **Team isolation is by PATH**, so
  the job format does NOT change: a team leader's jobs still carry the owning
  dispatcher's id; the team dir isolates them. (No format churn; 0.x fail-loud
  unaffected.)

New path builder (`platform/paths.ts`):
`dispatcherTeamCronJobsPath(id, teamId) = join(dispatcherTeamScopeDir(id, teamId),
'cron-jobs.json')` — i.e. `~/.dreamux/state/<id>/team/<team-id>/cron-jobs.json`,
mirroring the existing per-team record/entity dirs.

### 3. Lifecycle

- **Dispatcher scheduler**: unchanged — built in `DispatcherService` ctor, armed
  inside the `doStart()` channel-start transaction, stopped in `stop()`.
- **Team leader scheduler**: built + `start()`ed when the `TeamService` is
  materialized (`TeamCollection.get`/team load), `stop()`ped on team evict /
  `dissolve`. `start()` only reads the store and arms timers (no runtime needed),
  so it is independent of the leader's lazy runtime start.

### 4. The lazy-start policy (the one real semantic difference)

`SchedulerService` currently has: `getRuntime() === null → armMissed + 'missed'`.
That is correct for the **dispatcher** (eagerly started in `doStart`; a null
runtime means a *failed/torn-down* dispatcher, and the accepted run_now decision
is "do not resurrect a half-wired failed dispatcher"). So dispatcher =
`onAbsentRuntime: 'miss'`.

A **team leader is lazily started** — `getRuntime() === null` is the NORMAL idle
state between conversations (and after every daemon restart until the leader is
next addressed). For its cron to fire reliably, a null runtime must be treated as
"idle, start it": call `submitScheduled` (→ `scheduledInput` → `ensureStarted`),
which lazily spins up the leader and injects the prompt. So team leader =
`onAbsentRuntime: 'lazy-start'`. This is exactly the intended mechanism, NOT the
forbidden "resurrect a failed dispatcher" case (different start model). The
existing defer-until-idle still applies when the leader's runtime IS up and busy.

### 5. Cron MCP descriptor + admin routing

- `cronMcpServerDescriptor` gains an optional `teamId`; when present the shim
  passes `--team <teamId>` alongside `--dispatcher <id>`.
- Added to the team leader's MCP set in the single existing site
  `DispatcherService.mcpServersForTeamMate` (where `identity.role === 'team_leader'`),
  with `teamId = identity.team_id`.
- The cron MCP shim (`mcp/cron-mcp.ts`) forwards `team_id` (when set) in the admin
  params.
- `admin/methods.ts` `scheduler.cron.*` accept an optional `team_id`: absent →
  `getDispatcher(id).scheduler` (today); present → the team leader's scheduler,
  reached via `getDispatcher(id)` → team(teamId) → leader scheduler. The exact
  accessor is a small addition on the dispatcher/team service surface.

### 6. Preflight

`server.ts` `assertNoLegacyDispatcherState` and `dreamux doctor` already preflight
the dispatcher cron store. Extend them to also preflight each existing team's cron
store (same `detectLegacyCronJobStore` + full semantic validation, per team path).

## Visibility (the actual ask)

After this change the cron MCP is visible to: **the dispatcher agent and every
team leader**. NOT regular team members. This satisfies "every agent I can
directly talk to has working cron".

## What is reused vs new

- Reused as-is: `SchedulerService` core (defer-until-idle, two-phase start,
  held-token stop-race fix, rearm), `JsonDocumentStore`, `CronJobStore` logic, the
  cron MCP tool surface, the `TeammateService` runtime/scheduledInput interface.
- New/changed: `SchedulerService` options (ownerId/path/policy), `CronJobStore`
  ctor (path), one new path builder, team-leader scheduler ownership + lifecycle
  in `TeamService`/`TeamCollection`, cron MCP `teamId` addressing, admin team
  routing, team-scope preflight, and the MCP injection line for team leaders.

## Open questions for review

1. Store location: `team/<team-id>/cron-jobs.json` at the team root — agreed? (vs.
   beside the leader entity dir.)
2. The `onAbsentRuntime` policy split (dispatcher `miss` vs leader `lazy-start`) —
   is encoding it as a per-host option the cleanest seam, or should the host's
   start model be expressed differently?
3. Admin routing: extend `scheduler.cron.*` with optional `team_id` (chosen) vs a
   parallel `team.scheduler.cron.*` method family.
4. Should a team leader's cron survive `dissolve`/restart the same way the
   dispatcher's does (persisted, re-armed on team load)? (Proposed: yes.)

## Review outcome (two heterogeneous reviewers) & revised plan

codex: FLAWED (`/tmp/dreamux-tldesign-codex.md`). claude: SOUND-WITH-CHANGES
(`/tmp/dreamux-tldesign-claude.md`). Both confirm the "cron host" generalization
and store/path/multi-instance seams are clean and correct; the concept stands.
The folded corrections:

- **(Blocker, both) Eager-arm at boot — the durability fix.** Teams are
  **lazily materialized** (`TeamCollection.get` rebuilds on demand; the boot path
  starts only dispatchers, `server.ts:214`). "Re-arm on team load" therefore does
  NOT fire after a daemon restart until someone next talks to the team — the whole
  durable-cron point fails for leaders. FIX: in `DispatcherService.doStart()`,
  AFTER `this.scheduler.start()`, enumerate non-closed teams and eager-arm each
  team's scheduler. This is cheap — building the leader `TeammateService` reads
  `identity.json` only and starts NO runtime; the `submit` policy (below) spins the
  runtime up only when a job actually fires. Stop every live team scheduler in
  `DispatcherService.stop()`, and `TeamService.dissolve` must `scheduler.stop()`
  BEFORE it evicts (else leaked armed timers). Ownership: a team-scheduler registry
  on `TeamCollection`. **Invariant change:** non-closed teams' *schedulers* (not
  runtimes) become resident at boot, superseding the "materialized on first
  conversational access" note — record it in a decision/KB.

- **(Resolved blocker, codex) Prerequisite seam fix: `scheduledInput` team scope.**
  The original risk was a per-call roster check that required callers to pass
  `teamId` into `ensureStarted()`, which made a cold TeamLeader scheduled fire
  fail as out-of-roster when the team scope was omitted. Current code resolves
  this by validating the service's own persisted identity scope instead of taking
  a per-call `teamId`, so `scheduledInput` needs no scope argument. Keep the cold
  and already-running leader coverage when touching this path.

- **(Major) Policy seam rename.** `onAbsentRuntime: 'miss' | 'lazy-start'` →
  `absentRuntimeStrategy: 'miss' | 'submit'`, where `'submit'` = "call the host's
  scheduled submit path, which may lazily start." `SchedulerService` must not learn
  team lifecycle; it only chooses miss-vs-submit on a null runtime.

- **(Major) Closed/dissolved team policy.** Do NOT arm schedulers for
  `status === 'closed'` teams. `dissolve` deletes (or disables) that team's cron
  jobs — chosen: **delete** the team's `cron-jobs.json` on dissolve (the team is
  gone; a same-id recreation gets a fresh leader identity, so stale jobs must not
  re-attach). Admin `scheduler.cron.*` with a `team_id` for a missing/closed team
  → `AdminError` (mirror `mustExistingDispatcher`).

- **(Major) Egress is agent-driven this milestone (no `deliver`).** A
  `prompt-agent` job injects a system prompt into the leader; the leader replies
  through its already-gated team channel tools (same model as the dispatcher
  replying in its own channel) — so "remind me in the team chat" works without the
  deferred `deliver`. Structured `deliver` stays rejected this milestone. This
  neutralizes the baseline R4/OQ-8 worry (a leader could only egress to its bound
  team channel, and `deliver` is unimplemented) — so reversing the baseline
  "no TeamLeader cron in v1" guardrail is safe; **record the superseding decision**
  and keep a test that a regular team member still gets NO cron MCP.

- **(Major) Preflight path-scoped + scan teams.** Generalize
  `detectLegacyCronJobStore` to take an explicit path/owner. serve
  (`assertNoLegacyDispatcherState`) and `dreamux doctor` enumerate teams via
  `TeamStore.list(dispatcherId)` (a pure blind disk scan, no materialization) and
  preflight each non-closed team's `dispatcherTeamCronJobsPath`. Note: malformed
  team `record.json` now surfaces at boot (fail-loud earlier — acceptable).

- **(Minor) cleanups.** `cronTargetFor(params)` admin helper (dispatcher-vs-team,
  validates state) instead of duplicating optional-team logic; a narrow public
  `teamScheduler(teamId)` accessor (don't expose the collection); cron MCP `teamId`
  is descriptor-bound (`--team`), NOT a model-supplied tool param; tool
  descriptions say "this agent"/"this TeamLeader", not "this dispatcher"; rename
  `MAX_JOBS_PER_DISPATCHER` → `MAX_JOBS_PER_OWNER` and dedupe `MIN_INTERVAL_MS`.

- **Test plan (new):** (1) restart-durability for an *unaddressed* team's leader
  cron (locks the eager-arm Blocker); (2) path isolation (dispatcher vs team store
  with same `dispatcher_id`); (3) policy split (null runtime: dispatcher→missed,
  leader→submit/lazy-start); (4) two live team schedulers — `stop()` on one leaves
  the other's timers/held-fires intact; (5) preflight over team cron stores
  (malformed leader file fails serve/doctor); (6) dissolve stops the leader
  scheduler + deletes its jobs (no leaked timer).

Open decision for the user: scope is v1 = **prompt-agent cron for dispatcher +
team leaders**, agent-driven egress, no structured `deliver`. Confirm before
implementation.
