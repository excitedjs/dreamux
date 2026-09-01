# Proposal: Durable scheduled tasks (cron) for Dreamux

- **Status:** Archived historical proposal; current behavior is documented in
  [Scheduled tasks](/.agents/domains/scheduled-work.md)
- **Date:** 2026-06-23
- **Affects:** `@excitedjs/dreamux` server lifecycle, `service/` layer, state
  format, admin IPC, MCP surface, bundled skills; new runtime dependency
- **PR / Issue:** TBD
- **Implementation blueprint:** [scheduled-tasks technical design](scheduled-tasks-technical-design.md)

> Input-surface note: scheduled prompt injection references to `systemInput` are
> superseded by
> [AgentRuntime input surface cleanup](agent-runtime-input-surface-cleanup.md).
> The scheduler still waits for idle before injecting, but the target injection
> seam is plain text `completionInput`, not channel input or
> `systemInput(reason: "scheduled")`.

## Context

We want a scheduled-task ("cron") mechanism for Dreamux: at a wall-clock time
(or on a recurring schedule) the server should autonomously run an agent turn —
for example "every weekday 09:00, summarize open PRs and post to the bound
Feishu group".

Claude Code's own scheduling is **session-scoped**: the schedule lives inside a
running CLI session and disappears when that process exits. Restart loses it,
and prior tests of it were unreliable. Dreamux does not have that limitation:
`dreamux serve` is a long-running daemon under systemd/launchd, it already
persists durable state to `~/.dreamux/state/`, and it already has an in-process
path to inject a turn into a resident agent. A scheduler that persists its job
definitions to disk and rebuilds its timers on startup gives us a cron that
survives restarts — the capability Claude Code cannot offer.

This proposal is the design to be reviewed before implementation. It is written
against the current architecture (see
[current-architecture](/.agents/domains/current-architecture.md),
[repo-structure](/.agents/domains/current-architecture.md), and the `service/`
package docs).

## Goals

- Durable: job definitions survive `dreamux serve` restart, crash, and machine
  reboot. On startup the scheduler reconstructs its timers from disk.
- In-process: no external cron daemon; the scheduler is a resident component of
  the running server, co-located with the dispatcher it serves.
- Conversational: a user talking to the dispatcher/TeamLeader in Feishu can
  create, list, and delete scheduled tasks by asking — no CLI required.
- Neutral: the scheduler drives the agent through the existing neutral
  `AgentRuntime` / `TeammateService` seams and never names a concrete runtime
  or channel provider.
- Observable: each job records `last_run_at`, `next_run_at`, and `last_error`;
  admin/CLI can list and inspect.

## Non-goals

- Distributed scheduling across multiple hosts. A Dreamux install is one daemon
  on one machine.
- Sub-second precision. Minute-granularity cron is the target.
- Backfilling a long outage by replaying every missed fire (see "Missed runs").

## Existing building blocks this reuses

The research that motivated this design confirmed three load-bearing facts in
the current code:

1. **Turn injection already exists.** Earlier drafts used
   `systemInput(notice: AgentRuntimeSystemInput)` (used at the time for the
   restart notice) or the resident dispatcher's `TeammateService.send({
   prompt, intent })`
   (`/packages/dreamux/src/service/teammate-service/index.ts`). Neither path
   requires fabricating a channel message.
2. **Durable state has a clear pattern to copy.** `ChannelBindingStore`
   (`/packages/dreamux/src/service/channel-binding/`) is a single
   dispatcher-scoped JSON file with a `version` field, atomic write
   (`platform/atomic-write.ts`), and a startup `list()` that rebuilds in-memory
   state. Path builders live in `/packages/dreamux/src/platform/paths.ts`.
3. **Lifecycle hooks exist.** `DispatcherService.start()` / `shutdown()` is the
   natural place to start and stop the scheduler; it already starts the agent
   runtime before channel sessions and owns the `CompletionRouter` as a
   resident per-dispatcher component.

## Scope decisions

- **Fire-and-forget (2026-06-23).** The scheduler's job is only to *trigger* a
  turn at the scheduled time. It does **not** track or report whether the
  triggered work succeeded or failed. This deliberately sidesteps reviewer
  finding R1 (terminal status is asynchronous and not available to a non-
  initiator): since we never want terminal status, the scheduler never has to
  become a completion initiator or subscribe to settled turns. Persisted state
  records only `last_fired_at`. If success/failure tracking or alerting is
  wanted later, it is an additive extension, not a first-cut requirement.

- **Defer-until-idle (2026-06-23).** A scheduled fire must never interrupt or
  fold into an in-progress turn. When a job comes due:
  - if the target agent is idle (no unsettled turn), inject immediately;
  - if the agent is mid-turn, **hold the fire** and inject when the agent next
    becomes idle.

  This is the chosen resolution to reviewer finding R2 (Codex `steer.supported`
  means a mid-turn `send` is absorbed into the user's active turn, which would
  hijack it). It also makes the resident-agent (`prompt-agent`) execution model
  the natural primary path — the user wants the *same* resident dispatcher /
  TeamLeader agent to handle scheduled work when it is free, rather than always
  spawning an isolated teammate (this revises reviewer OQ-1).

  Implementation note — the signals this needs:
  - The wake mechanism is a Promise: `runtime.waitIdle()` (see "Agent activity
    capability"). The scheduler does
    `await (runtime.waitIdle?.() ?? Promise.resolve())` then injects — no
    subscribe/unsubscribe. (`onTurnSettled` stays for completion
    routing, not for idle-waiting.)
  - "is the agent busy right now" does **not** exist as a neutral signal yet:
    `AgentRuntimeStatus` (`agent-runtime.ts:202`) is a lifecycle enum
    (`ready/starting/stopping/...`), not a turn-active flag. This is **not** to
    be reconstructed in core by counting submit/settle (decided 2026-06-23 — a
    core-side counter is a fragile re-derivation of state the runtime already
    owns authoritatively). Instead it becomes a first-class neutral
    **Agent activity capability** on the `AgentRuntime` contract — see "Agent
    activity capability" below.
  - Held-fire queue: while busy, due jobs are appended to a per-agent pending
    queue and drained in order on the next idle transition. Open detail: if
    multiple fires of the *same* job pile up while busy (a long turn spanning
    several scheduled instants), collapse them to a single fire — a job should
    not fire N times back-to-back just because the agent was busy across N of
    its scheduled instants.
  - A stuck/never-settling turn would hold a fire indefinitely; a bounded
    max-defer (drop the held fire after a timeout, recorded as missed) is a
    secondary safeguard to decide during implementation.

## Agent activity capability (foundational; decided 2026-06-23)

The busy/idle ("is a turn in progress") signal must **not** be a private helper
inside the scheduler or a submit/settle counter inside core. It is a foundational
capability the whole core can depend on, owned authoritatively by the runtime.

### Which layer

Start at the **neutral `AgentRuntime` contract in `@excitedjs/dreamux-types`**,
implement it in each provider package, and consume it from core. This is forced
by where the truth lives and by the repo invariants ("Core must stay behind the
neutral `AgentRuntimeProvider` interface"; "runtime-specific concepts never leak
into shared/core layers", `dreamux/CLAUDE.md`):

- **Authoritative source = the provider runtime.** Investigation confirmed both
  built-ins already track turn-active state internally and accurately:
  - Codex: `TurnManager.activeTurnId` + `pendingTurnIds`
    (`agent-runtime/codex/src/turn-manager.ts:75-82`) — fully sufficient,
    100% accurate (driven by app-server `turn/completed` notifications). Idle ⇔
    `activeTurnId === null && pendingTurnIds.size === 0`.
  - Claude Code: `activeChannelTurn` (`agent-runtime/claude-code/src/runtime.ts:214`)
    covers channel turns; system/completion turns run on a `queue` promise chain
    with no explicit count — needs a small `queuedTurnCount` counter to report
    busy accurately. Low cost.
  - Reporting cost for both is ~zero (in-memory, no extra RPC).
- **Core is a consumer, not the owner.** A core counter would re-derive this
  from `submitted`/`onTurnSettled` and drift from the runtime's real state
  (e.g. Codex input folding, Claude steer absorption). Rejected.

### Proposed contract

In `@excitedjs/dreamux-types` (`agent-runtime.ts`). **Promise-first interface**
(project preference, 2026-06-23): expose a `waitIdle(): Promise<void>` rather
than a publish/subscribe / observer callback. Consumers `await` it; no listener
registration, no unsubscribe bookkeeping.

```ts
interface AgentRuntime {
  // ...existing...
  waitIdle?(): Promise<void>; // resolves when (next) idle; omitted means always idle
}
```

`waitIdle()` semantics:
- If the runtime is already idle, the promise resolves immediately
  (already-resolved fast path).
- If busy, it resolves on the next busy→idle transition.
- No parameters and no cancellation. A caller that gives up abandons the promise;
  the runtime resolves all pending waiters and clears them at the next idle edge.
- Timeout and teardown are caller-owned `Promise.race` concerns plus local submit
  guards before the plain text runtime input.

Consumer shape — the whole defer-until-idle becomes two lines:

```ts
await (runtime.waitIdle?.() ?? Promise.resolve());
await runtime.completionInput({ text: prompt, sourceId });
```

Why Promise over observer: a `waitIdle` promise models "I want to act once, when
free" directly and disposes itself on resolve; an `onActivityChanged` listener
would force every consumer to register, filter for the idle edge, and
unregister, and would re-introduce the subscription bookkeeping we are avoiding.
"A turn reached a terminal state" (`onTurnSettled`, kept for completion routing)
and "the runtime is idle now" (`waitIdle`) stay separate facts.

Small race note: after `await waitIdle()` resolves, a user turn could begin
before the injection runs (an unavoidable window with any signal style). For
fire-and-forget scheduling this window is tiny and acceptable; if it ever
matters, the consumer uses a local submit guard and re-waits. We do **not** need
an atomic "run-when-idle" primitive in the first cut.

Capability fallback: a runtime that omits `waitIdle` is treated as always idle —
core consumers then inject without deferring, never falling back to a silent
core-side reconstruction. Both built-ins implement `waitIdle`.

### Migration: scheduler-only wait-idle consumer

Today the scheduler is the only core feature that must reason about "a turn is
in progress" before submitting work. It consumes `waitIdle?()` directly and owns
its timeout/retry policy.

Restart-notice is deliberately **not** migrated to defer-until-idle. It runs at
the end of dispatcher startup, immediately after the runtime starts/resumes, so
the process is fresh and the agent is idle by construction. Its existing
`restart-notice`/`injectNotice` skip behavior covers a different startup race:
real inbound can arrive first and should avoid a duplicate wake. The scheduler
therefore inlines the only wait-idle consumer path:
`await Promise.race([runtime.waitIdle?.() ?? Promise.resolve(), maxDefer])`,
then re-checks that the held fire is still current before the plain text runtime
input.

Explicitly *not* migrated (different axis — keep as is): `getRuntime() !== null`
runtime-existence gates and `getStatus()` lifecycle reads. Those are
"does a runtime exist / what is its lifecycle", not "is it mid-turn".

### Sequencing

Per the repo rule "Codex protocol bumps: update `@excitedjs/agent-runtime-codex`
first; core must stay behind the neutral interface": land the neutral contract +
capability, implement Codex (already has the state), implement Claude Code (add
`queuedTurnCount`), then the scheduler-only consumer on top. This capability
deserves its own `decisions/` record since it
changes a cross-process runtime contract independent of the cron feature.

## Proposed architecture

### Component: `SchedulerService` (per dispatcher)

A new `service/scheduler/` module, one `SchedulerService` per dispatcher, owned
and constructed by `DispatcherService` (sibling to `CompletionRouter`).
Responsibilities:

- Load persisted jobs on `DispatcherService.start()` and arm timers.
- Compute next fire time per job (cron expression or one-shot timestamp).
- On fire, dispatch the job's action (see "Execution models") **fire-and-forget**
  and persist `last_fired_at` + the recomputed `next_run_at`. The scheduler does
  **not** observe whether the triggered turn succeeds or fails (decided
  2026-06-23, see "Scope decisions").
- Clear all timers on `DispatcherService.stop()` / `shutdown()`. Because the
  scheduler only *fires* and does not await terminal status, there is no
  per-dispatch settle to drain — stopping it just disarms timers.

Timer management follows the existing convention: `setTimeout(...).unref()` so a
pending job never blocks process exit, tracked in a `Map<jobId, Timeout>` and
fully cleared on stop. The scheduler arms a timer only for the **next** fire of
each job; on fire it re-arms for the subsequent fire. (Open question OQ-3 covers
single-nearest-timer vs per-job-timer.)

Process-level alternative considered: a single `Server`-level scheduler that
dispatches to dispatchers by id. Rejected for the first cut because jobs are
inherently dispatcher-scoped (they target one dispatcher's agent and one bound
channel) and the per-dispatcher aggregate already owns the agent handle and
router. A process-level scheduler would have to reach back into each dispatcher
anyway.

### Persistence: `CronJobStore`

Modeled on `ChannelBindingStore`.

- File: `~/.dreamux/state/<dispatcher-id>/cron-jobs.json`
- New path builder `dispatcherCronJobsPath(id)` in `platform/paths.ts`.
- Atomic write via `writeFileAtomic`; missing file ⇒ empty list (`isNotFound`);
  malformed ⇒ fail loud with rebuild guidance (matching the 0.x no-migration
  policy — see `legacy-state.ts` precedent).
- **Built on a shared base store, not a copy of the pattern** — see below.

### Base store abstraction (decided 2026-06-23)

The repo currently re-implements the same versioned-JSON-document persistence in
every store, with no shared base:

| Store | File | Write | Corrupt/version policy |
|---|---|---|---|
| `DispatcherStore` | `state/dispatcher-store.ts` | `writeFile` (**non-atomic**) | warn + rebuild |
| `ChannelBindingStore` | `service/channel-binding/store.ts` | `writeFileAtomic` | `LegacyStateError` fail-loud |
| `TeamStore` | `service/team-collection/store.ts` | `writeFileAtomic` | reader validation |
| `TeamMateIdentityStore` | `service/teammate-collection/identity-store.ts` | `writeFileAtomic` | reader validation |

Each independently re-codes: `readFile` → `isNotFound ⇒ default` → `JSON.parse`
→ `version` envelope check → field validation → write = `mkdir -p` +
serialize + (atomic) write + trailing newline. This duplication is exactly why
adding `CronJobStore` as another hand-rolled copy is the wrong move, and it has
already produced a latent inconsistency: `DispatcherStore` writes
**non-atomically** (`state/dispatcher-store.ts:214` uses plain `writeFile`),
leaving a torn-write window the other three avoid.

Proposal: extract a neutral base in `platform/` (next to `atomic-write.ts` and
`fs-errors.ts`, the existing infra home), e.g. `platform/json-document-store.ts`:

```ts
class JsonDocumentStore<TDoc> {
  constructor(opts: {
    version: number;
    parse(raw: unknown, ctx: { path: string }): TDoc; // validate; throw on bad shape
    empty(): TDoc;                                     // value when file is absent
    corruptPolicy?: 'fail-loud' | 'warn-rebuild';      // default 'fail-loud'
  });
  read(path: string): Promise<TDoc>;   // readFile → isNotFound⇒empty → JSON.parse → version → parse()
  write(path: string, doc: TDoc): Promise<void>; // mkdir -p → writeFileAtomic → pretty JSON + "\n" + mode 0600
  assertCurrent(path: string): Promise<void>;    // read() for startup/doctor fail-loud probe
}
```

The path stays caller-supplied (callback / argument), so `paths.ts` remains the
sole path builder and the base never names a path or a provider field — it is
pure runtime-neutral infrastructure. Each concrete store keeps its domain
methods (`bind`/`resolve`/`list`/…) and supplies `version` + `parse` + `empty`;
`CronJobStore` is then a thin store over this base, not a fourth copy.

**Scope boundaries of the base:**
- Covers the **single versioned JSON document** case (the four stores above +
  `cron-jobs.json`).
- Does **not** cover the append-only JSONL log (`turns-store.ts`) — different
  access pattern (append, skip-corrupt-line, streaming read); leave it, or give
  it its own `JsonlLogStore` base later.
- Does **not** cover directory-of-entities blind-scan *listing*
  (`identity-store.ts` enumerating subdirs) — only the per-document read/write
  is unified; the dir-scan stays in the concrete store.

**Sequencing — two options for review:**
- **(A) Base-first refactor.** Build `JsonDocumentStore`, migrate all four
  existing stores onto it (behavior-preserving; also fixes the non-atomic
  `DispatcherStore` write), then build `CronJobStore` on it. Cleanest end state;
  larger blast radius, touches settled code, needs regression tests on each
  migrated store.
- **(B) Base-with-cron, migrate incrementally.** Introduce `JsonDocumentStore`
  now and build only `CronJobStore` on it; migrate the existing four in a
  follow-up. Lower risk, ships cron sooner; the four keep their copies until the
  follow-up.

Recommendation: **(B)** — design the base to fit all five, ship it carrying
`CronJobStore`, and migrate the settled stores in a separate behavior-preserving
PR so the cron feature and the cross-cutting store refactor are reviewed apart.
This touches a cross-process state invariant + a shared infra boundary, so per
the knowledge-delta protocol it needs a `decisions/` record and a KB update
regardless of which option is chosen.

Proposed schema (v1):

```jsonc
{
  "version": 1,
  "jobs": [
    {
      "id": "job-7f3a",                 // stable, server-allocated
      "dispatcher_id": "<id>",
      "title": "Daily PR summary",       // human label
      // Schedule mirrors the native CronCreate surface: a 5-field cron string +
      // a `recurring` flag (one-shot = recurring:false, fires once then disables).
      // `tz` is resolved at create time and persisted explicitly (a long-running
      // server must not silently inherit a changed ambient TZ); it defaults to
      // the dispatcher's local zone.
      "cron": "3 9 * * 1-5",            // 5-field, local-time (note: off-:00 minute)
      "recurring": true,                 // false = fire once at next match, then disable
      "tz": "Asia/Shanghai",
      "action": {
        "kind": "prompt-agent",          // or "spawn-teammate"
        "prompt": "Summarize open PRs and post to the bound group.",
        "intent": "daily-pr-summary",    // recovery subject / spawn intent
        "agent_runtime": "codex"         // spawn-teammate only
      },
      "deliver": {                       // optional explicit egress target
        "channel_id": "<dispatcher-local channel id>",
        "meta": { "chat_id": "<chat>" }
      },
      "enabled": true,
      "created_at": 0,
      "updated_at": 0,
      "next_run_at": 0,
      "last_fired_at": null              // when the trigger was last submitted
    }
  ]
}
```

Note the schema is intentionally **fire-and-forget**: it records only when a job
was last *triggered* (`last_fired_at`), not whether the resulting turn
succeeded. No `last_status` / `last_error` terminal fields (see "Scope
decisions").

### Execution models (per-job `action.kind`)

- **`prompt-agent`** — inject the prompt into the resident dispatcher /
  TeamLeader agent via `agent.send({ prompt, intent: 'cron:<id>' })`. Cheap,
  reuses the live agent and its context. Best for lightweight "check and report"
  jobs. Cost: it accumulates onto the resident agent's long-running thread.
- **`spawn-teammate`** — spawn a one-shot TeamMate (`agent_runtime` from the
  job) with the prompt, let it run isolated, and route its completion back
  through the existing `CompletionRouter` so the leader/dispatcher can relay the
  result. Clean context isolation; better for heavy or long jobs. Cost: a fresh
  runtime per fire.

Default guidance: notifications use `prompt-agent`; real work uses
`spawn-teammate`. Both are supported from day one.

### Egress

A scheduled turn has no inbound channel message to reply to, so the target chat
is not implicit. Reply targeting stays in the channel layer (the Feishu `reply`
tool takes an explicit `chat_id`). The job carries an optional `deliver` block;
when present the scheduler injects the target into the prompt context (or the
spawned teammate's prompt) so the agent calls `reply` with the right
`chat_id`. When absent, the agent is told to use the dispatcher's bound channel.
The scheduler itself never sends channel messages — it only triggers a turn and
the agent owns egress, preserving the "no channel routing in the runtime/core
trigger path" boundary.

### Control surface

1. **Cron MCP** (primary, conversational). A new `mcp/cron-mcp` stdio shim plus
   a Team/dispatcher MCP capability, shaped like the existing
   `team-mcp` / `teammate-mcp`, exposing `cron_create` / `cron_list` /
   `cron_update` / `cron_delete` / `cron_run_now`. This lets the user say "every
   weekday 9am summarize PRs" in Feishu and have the agent create the job
   directly. Injected by role into the dispatcher / TeamLeader agent (not into
   ordinary teammates), matching the existing role-based MCP descriptor
   assembly in `dispatcher-service/mcp-descriptors.ts`.

   **Align the tool descriptions and parameters with the host's native
   scheduling tools** (`CronCreate` / `CronList` / `CronDelete`), so an agent
   that already knows the native surface uses these identically (decided
   2026-06-24):
   - `cron_create({ cron, prompt, recurring? })` — `cron` is a **standard
     5-field local-time expression** (`"M H DoM Mon DoW"`), `prompt` is the text
     enqueued at each fire, `recurring` defaults to `true` (one-shot =
     `recurring: false`, fires once then disables). Returns a job id. The
     description carries the same guidance the native tool gives: prefer an
     off-`:00`/`:30` minute for approximate times to avoid fleet-wide
     thundering-herd, and use `recurring: false` for "remind me at X" one-shots.
   - `cron_list()` — no params; lists this dispatcher's jobs.
   - `cron_delete({ id })` — by job id.
   - `cron_update({ id, ... })` / `cron_run_now({ id })` — dreamux extensions
     beyond the native trio; keep their params in the same naming style.
   - **Deliberate divergences from the native tool** (call these out in the
     descriptions so behavior is not surprising): the native tools have a
     `durable` flag defaulting to session-only — dreamux jobs are **always
     durable** (server-persisted, survive restart; that is the whole point), so
     there is no `durable` param. dreamux adds optional `tz` (resolved + stored)
     and the execution/`deliver` target fields. dreamux jobs do not auto-expire
     after 7 days. Everything else (param names, description tone) mirrors the
     native surface.
2. **Admin methods** (`scheduler.cron.list` / `.create` / `.delete` /
   `.update` / `.run_now`) in `admin/methods.ts`, thin delegates to the
   dispatcher's `SchedulerService`, reachable from the CLI for inspection and
   ops.

### Dependency

Cron-expression parsing and next-fire computation (with timezone/DST handling)
should use a small, well-maintained, zero-dependency library rather than a
hand-rolled parser. Candidate: **`croner`** (zero deps, supports timezones and
DST, actively maintained, pure JS). Added via the rush path
(`node common/scripts/install-run-rush.js update`). This is a runtime
dependency of `@excitedjs/dreamux` core, not a dev tool, so it does not violate
the "no runtime deps on dev tools" rule. Reviewers: please sanity-check the
library choice and its license/footprint.

## Missed runs (restart / outage policy)

When the daemon was down across a scheduled fire, the default is **skip the
missed fire and arm the next one** — no backfill. Rationale: backfilling a
"daily summary" after a two-day outage would fire two stale summaries at once.
The next fire is recomputed from the cron expression + `last_fired_at` on
startup (do not trust a persisted `next_run_at` as the sole source of truth). A
missed fire is simply not run — consistent with the fire-and-forget schema,
there is **no** `last_status` field to record "skipped". A per-job
`catch_up: true` opt-in (run once immediately on startup if the last fire was
missed) is a possible extension but is **not** in the first cut unless review
says otherwise (OQ-2).

## State / upgrade impact

- New durable state file `cron-jobs.json`. Introducing it is additive (absent
  file ⇒ no jobs), so no upgrade blocker on first ship.
- Per the changelog rules, the feature still warrants a rush change file
  because it adds a persisted file format and a new MCP/CLI surface.
- This touches a state format and an MCP contract, so per the knowledge-delta
  protocol the KB must be updated in the same PR: a `reference/` page for the
  scheduler and, once settled, a `decisions/` record; this proposal then moves
  to `archive/` or is promoted.

## Open questions for reviewers (OQ)

- **OQ-1 Execution default.** Is "prompt-agent for notifications, spawn-teammate
  for work" the right default split, or should every scheduled run be isolated
  (always spawn) to protect the resident agent's context from unbounded growth?
- **OQ-2 Missed-run policy.** Is skip-and-rearm correct as the only first-cut
  behavior, or is a `catch_up` opt-in needed immediately?
- **OQ-3 Timer strategy.** Per-job `setTimeout` vs a single timer to the nearest
  fire that re-computes on each wake. Per-job is simpler; single-timer scales
  better with many jobs. How many jobs do we realistically expect?
- **OQ-4 Scope of scheduler.** Per-dispatcher `SchedulerService` (proposed) vs a
  process-level scheduler. Any reason the process-level option is actually
  better given future multi-dispatcher installs?
- **OQ-5 Concurrency / overlap.** If a job is still running when its next fire
  arrives, skip the new fire, queue it, or rely on the runtime's input
  aggregation? Proposed: skip with a logged `overlap` note.
- **OQ-6 Dependency.** Is `croner` an acceptable runtime dependency, or do we
  prefer `cron-parser`, or a minimal in-house parser for a restricted cron
  subset?
- **OQ-7 Failure handling.** On `action` failure, retry with backoff, or just
  record `last_error` and wait for the next scheduled fire? Proposed: record and
  wait; no automatic retry in the first cut.
- **OQ-8 Security / safety.** A scheduled prompt runs autonomously with the
  agent's full tool set and no human in the loop at fire time. Do we need a
  guardrail (e.g. scheduled turns get a restricted tool set, or require an
  explicit confirmation gate for destructive operations)?

## Glue-code self-audit (2026-06-23)

A pass over this proposal for the same smell that the activity capability fixed:
**core stitching logic together with ad-hoc glue instead of leaning on a proper
capability/abstraction.** Found five; G1–G3 are real design glue, G4 is
"reimplementing a library's job", G5 was a doc contradiction (now fixed).

- **G1 — Egress by string-injecting `chat_id` into the prompt.** The "Egress"
  section has the scheduler put the target chat into the prompt text so the
  agent calls `reply` with the right `chat_id`, and "when absent, the agent is
  told to use the dispatcher's bound channel". This is glue on two counts: it
  threads a routing target through free-text prompt assembly in core, and it
  invents a "dispatcher bound channel" that does not exist (binding is
  Team-scoped). Proper shape: a job references a neutral channel target
  (resolved/validated once via the channel provider's `resolveTarget`, or by
  pointing at an existing `ChannelBinding`), and egress goes through the
  channel seam — not a `chat_id` smuggled inside a prompt string. (Overlaps
  reviewer R3, which only fixed the *state field*; the *mechanism* is still
  glue and must change too.)
- **G2 — The scheduled trigger must not overload channel input.** Earlier drafts
  would call `agent.send` (which enters as a channel-inbound turn,
  `runtime.channelInput({ sourceId: 'teammate:…' })`) or `systemInput` with a
  generic control reason. The first misuses the channel-input path for a
  non-channel event; the second has since been superseded by the plain text
  runtime input in
  [AgentRuntime input surface cleanup](agent-runtime-input-surface-cleanup.md).
  Proper shape: a scheduled trigger is a non-channel plain text turn with
  structured turn-origin metadata in Dreamux records, not channel XML and not a
  provider-facing reason discriminator.
- **G3 — `intent: 'cron:<id>'` magic-prefix correlation.** Encoding the job id
  into the free-text `intent` with a `cron:` prefix and parsing it back is
  string glue. If core needs to correlate a turn to a cron job, carry a
  structured field, not a prefixed string in a human-readable field.
- **G4 — Hand-rolled `setTimeout` arm/re-arm/overflow glue duplicates what the
  cron library already does.** The "Component" section hand-rolls
  `setTimeout(...).unref()` + a `Map<jobId, Timeout>` + manual re-arm + a
  24.8-day overflow workaround. `croner` already owns scheduling (it computes
  next fire, handles tz/DST, and can drive its own callback with an `unref`
  option). Prefer leaning on the library's scheduler over re-implementing timer
  glue in core; core keeps only the fire action and persistence.
- **G5 — (fixed) `last_status: "skipped"`** in "Missed runs" contradicted the
  fire-and-forget schema that has no `last_status`. Corrected to "a missed fire
  is simply not run".

These do not change the architecture; they change *mechanism* details that
should be designed as capabilities/contracts, not core glue. G1 and G2 in
particular should be settled before implementation since they touch the channel
seam and the runtime injection contract.

## Review outcome (2026-06-23, two heterogeneous reviewers)

Two independent reviewers — one Codex runtime, one Claude Code runtime — read
this file and verified its load-bearing claims against source. Both reached the
same verdict: **direction sound, foundations confirmed, but revise before
implementation.** Their findings converged strongly.

### Confirmed against source

`AgentRuntime.systemInput` (`dreamux-types/src/agent-runtime.ts:319`),
`TeammateService.send` (`teammate-service/index.ts:178`), the
`ChannelBindingStore` single-file/atomic-write/fail-loud pattern
(`service/channel-binding/store.ts`), atomic write
(`platform/atomic-write.ts`), the `start()/shutdown()` lifecycle, and
role-based MCP assembly (`dispatcher-service/mcp-descriptors.ts`) all exist as
described. `croner` is **not** yet a dependency (must be added via rush).

### Must-fix before implementation (consensus)

- **R1 — `send` ≠ `systemInput`, and neither returns terminal status.**
  `send` enters as a channel-inbound turn (`runtime.channelInput`,
  `teammate-service/index.ts:515`) and resolves at *submit* time; the terminal
  result arrives asynchronously via `onTurnSettled` + `CompletionRouter`, which
  only delivers to a send/spawn initiator — it is not a scheduler state machine
  (`completion-router/index.ts`, `turn.ts:48`). The schema's
  `last_status: completed/failed` therefore had no implementation basis as
  drafted. **Resolved 2026-06-23 by descoping**: the scheduler is now
  fire-and-forget (see "Scope decisions") and records only `last_fired_at`, so
  it never needs terminal status. The old `send`-vs-`systemInput` injection
  choice is superseded by the plain text runtime input in
  [AgentRuntime input surface cleanup](agent-runtime-input-surface-cleanup.md);
  it no longer carries a status-tracking requirement.
- **R2 — `prompt-agent` injection can hijack an active user turn.** Codex
  `steer.supported = true` means a `send` mid-turn is absorbed into the user's
  live turn (`agent-runtime.ts:96`). This is a correctness risk, not just
  context growth. Fix: gate prompt-agent injection on agent-idle, or default to
  isolated spawn.
- **R3 — egress must be neutral, not `chat_id` in core state.** Writing
  `meta:{ chat_id }` into a core-owned file names a Feishu field and violates
  the channel-neutrality invariant (`dreamux/CLAUDE.md` boundaries). There is
  also no dispatcher-level "bound channel" concept to default to (binding is
  Team-scoped). Fix: reference an existing neutral `ChannelBinding`
  `(channel_id, target_key, meta)` rather than storing a duplicate target;
  jobs without a resolvable target are no-egress/internal only.
- **R4 — team_leader scheduled egress is gated; dispatcher is not.** A
  TeamLeader can only egress to its bound team channel
  (`channel-tool-auth.ts`), so a scheduled `deliver` for a leader must resolve
  to that channel; a dispatcher agent has no such gate. The two roles are
  asymmetric and must be specified separately. First cut: inject the Cron MCP
  only on the dispatcher/owner path, **not** the TeamLeader.
- **R5 — `action.agent_runtime` is an `agents[].id` alias, not a provider
  ref.** The example value `"codex"` is misleading; it must match config
  `agents[].id` (as teammate spawn does, `teammate-collection/index.ts:245`).
- **R6 — lifecycle details.** Arm the scheduler at the *end* of `doStart()`
  (after `session.start()`), stop it in `stop()` (not only `shutdown()`, since
  admin `dispatcher.stop` calls `stop()`), and order it after restart-notice
  injection to avoid a same-startup thread race. "Like CompletionRouter" means
  constructed in the ctor but explicitly armed/disarmed.
- **R7 — startup fail-loud belongs in server preflight.** A malformed
  `cron-jobs.json` discovered only in lazy `DispatcherService.start()` is
  swallowed per-dispatcher; add a `detectLegacyCronJobStore` / assert into the
  `Server.start()` preflight + `dreamux doctor` like the channel-binding store.

### Secondary (resolve during implementation)

- `setTimeout` overflows at ~24.8 days → far-future `once` / sparse cron fires
  immediately; long timers must be segmented and re-armed.
- Single-instance safety: restart overlap or a double `serve` double-arms
  timers; add a process lock or fire-time instance check (fail loud).
- `tz` should be mandatory (or defaulted-and-persisted), never inherited from
  the runtime environment's `TZ`.
- Drain semantics: `prompt-agent` can only be drained to "submitted", not
  "turn complete"; only spawn-teammate has a real settle to await.
- Runaway guardrails: max jobs/dispatcher, min interval, audit log; consider
  disabling a job after N consecutive failures.
- Version policy: decide fail-loud-on-unknown-field (matches 0.x no-migration,
  needs `Rebuild:` in changelog) vs ignore-unknown, and state it.

### Open-question resolutions (reviewer consensus, updating the OQ section)

- **OQ-1 → revised by the user (2026-06-23): primary model is `prompt-agent`
  (resident agent) gated by Defer-until-idle.** The reviewers preferred
  default-isolated-`spawn` to avoid context pollution, but the user wants the
  same resident dispatcher / TeamLeader agent to handle scheduled work when
  free. The idle gate removes the correctness hazard the reviewers were
  guarding against; the context-growth cost remains and is accepted.
  `spawn-teammate` stays available as an opt-in for heavy/isolated jobs.
- **OQ-2 → skip-and-rearm only; no `catch_up` first cut.** Recompute the next
  fire from the cron expr + `last_run_at`, do not trust a persisted
  `next_run_at` as the sole source of truth.
- **OQ-3 → divergent.** Codex prefers a single nearest-fire timer (scales,
  unifies long-timer capping); Claude prefers per-job for simplicity but
  *requires* the overflow fix. Decide at implementation; either way cap and
  re-read the clock on wake.
- **OQ-4 → per-dispatcher `SchedulerService`** (both; unchanged).
- **OQ-5 → superseded by the Defer-until-idle decision (2026-06-23).** Rather
  than skipping an overlapping fire, the scheduler *holds* the fire and injects
  when the agent next goes idle (see "Scope decisions"). Same-job fires that
  pile up across one long busy stretch collapse to a single fire. This is the
  direct fix for the R2 aggregation hazard — we never inject mid-turn.
- **OQ-6 → `croner` acceptable** (MIT, zero-dep, pure JS, tz/DST); pin the
  version and verify no transitive deps. `cron-parser` is the fallback; do not
  hand-roll.
- **OQ-7 → record `last_error` and wait, no auto-retry**; note that a failed
  `once` job is permanently lost; consider auto-disable after N failures.
- **OQ-8 → guardrails are mandatory in v1, not optional.** Minimum: cron
  create/update only from an owner-authorized dispatcher context (no
  TeamLeader), max jobs + min interval + audit log, and destructive/public/
  credential/persistent-config operations still obey the existing confirmation
  rules — a scheduled prompt does not bypass them.

## Rollout sketch (if accepted)

1. `CronJobStore` + `dispatcherCronJobsPath` + schema types + atomic
   write/read with fail-loud parsing. Unit tests for round-trip and malformed
   handling.
2. `SchedulerService` with timer arm/disarm, next-fire computation (`croner`),
   and `prompt-agent` execution wired through `agent.send`. Lifecycle hooks in
   `DispatcherService.start()/shutdown()`.
3. `spawn-teammate` execution path through the teammate collection +
   `CompletionRouter`.
4. Admin methods + CLI.
5. Cron MCP shim + role-based injection so the agent can self-manage jobs.
6. KB reference page + decision record + rush change file.
