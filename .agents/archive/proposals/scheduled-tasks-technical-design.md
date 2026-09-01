# Scheduled tasks — implementation technical design

- **Status:** Archived implementation blueprint (synthesized from two independent
  heterogeneous technical reviews, 2026-06-24); current behavior is documented
  in [Scheduled tasks](/.agents/domains/scheduled-work.md)
- **Companion to:** [scheduled-tasks proposal](scheduled-tasks.md),
  [agent-activity-capability decision](/.agents/archive/decisions/agent-activity-capability.md),
  [json-document-store decision](/.agents/tasks/architecture/service-topology-foundations/requirement.md#json-document-store)
- **Verdict:** GO, subject to three mandatory prerequisites (§9)

> Input-surface note: the scheduled injection verb sections below were written
> before
> [AgentRuntime input surface cleanup](agent-runtime-input-surface-cleanup.md).
> Keep the wait-idle and scheduler-state design, but replace
> `systemInput(reason: "scheduled")` with plain text `completionInput` when
> implementing against the updated AgentRuntime contract.

This is the implementation-level design for the durable scheduled-tasks (cron)
feature. It is the synthesis of two independent dossiers (one Codex-runtime, one
Claude-runtime author), both grounded in `next` source. Where they diverged, the
chosen option is stated inline. All `file:line` references are against `next`.

## 1. Settled decisions (do not reopen)

| Decision | Content |
|---|---|
| Fire-and-forget | Only *trigger* a turn; never track terminal success/failure. State records `last_fired_at` only. |
| Defer-until-idle | If the agent is mid-turn, hold the fire and inject when it next goes idle; never interrupt an in-flight turn. |
| Primary execution | `prompt-agent` (inject the resident dispatcher/TeamLeader agent); `spawn-teammate` is an opt-in for heavy/isolated work. |
| Missed runs | skip-and-rearm, no backfill; next fire recomputed from `cron` + `last_fired_at`, not a trusted persisted `next_run_at`. |
| Schedule library | `croner` (MIT, zero-dep, tz/DST), added via rush. |
| Cron MCP scope | Injected on the dispatcher/owner path only, **not** team_leader. |
| Persistence base | `JsonDocumentStore<TDoc>` shared base; `CronJobStore` is its first adopter. |
| Activity signal | Optional neutral `AgentRuntime.waitIdle?()` (Promise-first). |

Non-goals: distributed multi-host scheduling, sub-second precision, long-outage replay.

## 2. Contract layer (`@excitedjs/dreamux-types`)

Current state: `AgentRuntime` (`agent-runtime.ts:308-345`) has **no** busy/idle
signal. `AgentRuntimeStatus` (`:202-208`) is a lifecycle enum, not turn-active.
`AgentRuntimeCapabilities` (`:90-113`) has no `activity`.
This draft still referred to `AgentRuntimeSystemInput.reason`, but that input
surface is superseded by the plain text `completionInput` contract.
`TurnSettledSignal` (`turn.ts:76-80`) is for completion routing and stays
unchanged.

Add **one optional method, nothing else** (minimal surface, decided 2026-06-24 —
no `getActivity`, no `AbortSignal`, no `capabilities.activity` flag):

```ts
export interface AgentRuntime {
  // ...existing...
  /** Resolve when no turn is in progress (immediately if already idle, else at
   *  the next turn-end). Optional: a runtime that cannot track turn activity
   *  omits it and is treated as always-idle (feature-detected by presence, like
   *  `completionInput`). */
  waitIdle?(): Promise<void>;
}

// scheduled injection now uses completionInput({ text, sourceId })
```

`waitIdle()` semantics:
1. **Already idle** ⇒ already-resolved promise.
2. **Busy** ⇒ push a resolver onto an internal waiter list; on the next
   busy→idle edge resolve **all** waiters and clear the list.
3. **No cancellation.** A caller that gives up (its timeout fired) just abandons
   the promise; it resolves harmlessly at the next idle, where all waiters are
   flushed — no leak, so no `AbortSignal` is needed.
4. **Timeout is the caller's job, as a race:**
   `await Promise.race([runtime.waitIdle?.() ?? Promise.resolve(), timeout])`.
   The runtime owns no timeout/turn-duration mechanism.
5. **Unsupported runtime** ⇒ omits `waitIdle`; core's `runtime.waitIdle?.()`
   yields `undefined` (treated as immediately idle). No capability flag, no
   forced contract change on external providers.

Race note (implementation comment): a user turn can begin between `waitIdle()`
resolving and the injection running. Acceptable for fire-and-forget; no atomic
"run-when-idle" primitive in v1.

Why not overload `TurnSettledSignal`: "a turn reached terminal state" ≠ "the
runtime is idle" (queued turns may remain); its consumer is `CompletionRouter`.
Keep them separate.

### 2.1 Provider implementations + correctness traps

**Codex (`agent-runtime/codex/src/turn-manager.ts`, `runtime.ts`)** — authoritative,
near-zero cost. Truth: `activeTurnId` (`:75`), `pendingTurnIds: Set` (`:82`),
`activeTurnSlot` (`:75`). Idle ⇔ `pendingTurnIds.size === 0 && activeTurnSlot === null`.
- **TRAP-1 (false-idle):** `activeTurnSlot !== null` MUST count as busy — it
  covers the window where `enqueue()` has claimed a slot but the app-server has
  not yet returned the turn id (`pendingSubmissions > 0`, `:122-123`). Omitting
  it reports idle in the instant right after submit.
- Expose `isBusy()` / `waitIdle()` on `TurnManager` (maintain simple resolver
  `idleWaiters`, drain on the completion/failure branches `:308-332` and on
  `recordTurnStartFailure`). `CodexRuntime.waitIdle` forwards; `turnManager ===
  null` ⇒ immediate resolve.
- Precision 100% (push events, `provider.ts:66`).

**Claude Code (`agent-runtime/claude-code/src/runtime.ts`)** — needs a counter.
`activeChannelTurn` (`:214`) covers channel turns only; plain text
`completionInput` turns run on the `queue` promise chain (`:209`) with no count. Add
`private queuedTurnCount = 0`.
- `++` at the real enqueue points: the **new-turn** branch of `channelInput`
  (`:353-360`, i.e. `activeChannelTurn === null`) and the plain text
  `completionInput` submit path.
- `--` in the settle callbacks `markTurnSucceeded` (`:470`) and `markTurnFailed`
  (`:476`) — the unique correct decrement points.
- Idle ⇔ `queuedTurnCount === 0`; `activeTurnId = activeChannelTurn?.turnId ?? null`.
- **TRAP-2 (waitIdle never resolves):** `channelInput` with `activeChannelTurn !== null`
  goes through `steerChannelTurn` (`:451`), folding into the existing turn and
  returning the **same** turnId (`:342-346`) — it adds **no** queue entry. That
  branch MUST NOT `++queuedTurnCount`, or the count inflates and `waitIdle` never
  resolves. Increment strictly in the new-turn branch only.
- Synthesized-events note (`provider.ts:51`): the busy count is same-source as the
  synthesized settle (same runtime/queue), so the *busy* judgment is precise;
  synthesized only weakens *terminal-status* semantics, which fire-and-forget
  does not use. This is why the capability is safe on both providers.

## 3. Persistence

### 3.1 `JsonDocumentStore<TDoc>` (`platform/json-document-store.ts`, new)

Lives in `platform/` beside `atomic-write.ts` / `fs-errors.ts` (neutral infra;
never names a path or provider field). Unifies the read/write the four current
stores hand-roll.

```ts
export interface JsonDocumentStoreOptions<TDoc> {
  version: number;
  parse(raw: unknown, ctx: { path: string }): TDoc; // validate; throw on bad shape
  empty(): TDoc;
  corruptPolicy?: 'fail-loud' | 'warn-rebuild';      // default 'fail-loud'
  warn?: (msg: string) => void;
}
export class JsonDocumentStore<TDoc> {
  constructor(opts: JsonDocumentStoreOptions<TDoc>);
  read(path: string): Promise<TDoc>;   // readFile → isNotFound⇒empty() → JSON.parse → version → parse()
  write(path: string, doc: TDoc): Promise<void>; // mkdir -p via writeFileAtomic, pretty+"\n", mode 0o600
  assertCurrent(path: string): Promise<void>;    // = read(); startup/doctor fail-loud probe
}
```

Path is caller-supplied (`platform/paths.ts` stays the sole path builder).
`read` mirrors `channel-binding/store.ts:155-201` (`isNotFound`⇒`empty()`;
version/shape mismatch ⇒ `LegacyStateError` from `service/legacy-state.ts` under
`fail-loud`, or warn+`empty()` under `warn-rebuild`). `write` mirrors
`store.ts:203-209` + `atomic-write.ts:14-29`. Does **not** cover the JSONL log
(`turns-store.ts`) or directory blind-scan listing (`identity-store.ts`).
Migrating the four existing stores onto it (and fixing the non-atomic
`DispatcherStore` write, `state/dispatcher-store.ts`) is a separate
behavior-preserving follow-up PR.

### 3.2 `CronJobStore` (`service/scheduler/store.ts`, new)

Thin wrapper over the base providing `version:1` + `parse` + `empty` and domain
verbs `list/get/create/update/delete/setFired`. `assertCurrent` forwards for
preflight.

### 3.3 `cron-jobs.json` schema (native-aligned; deliver = neutral reference)

```jsonc
{
  "version": 1,
  "jobs": [
    {
      "id": "job-7f3a",              // server-allocated, stable (randomUUID slice)
      "dispatcher_id": "<id>",
      "title": "Daily PR summary",   // optional human label

      "cron": "57 8 * * 1-5",        // standard 5-field local-time "M H DoM Mon DoW"
      "tz": "Asia/Shanghai",         // dreamux ext: resolved at create/update, persisted (never inherit ambient TZ)
      "recurring": true,             // default true; false = fire once at next match, then set enabled=false

      "action": {
        "kind": "prompt-agent",      // or "spawn-teammate"
        "prompt": "Summarize open PRs and post to the bound group.",
        "intent": "daily-pr-summary",
        "agent_runtime": "<agents[].id>" // spawn-teammate only; a config alias, NOT a provider ref (R5)
      },

      "deliver": {                   // optional; a NEUTRAL reference to an existing ChannelBinding
        "channel_id": "<dispatcher-local channel id>",
        "target_key": "<provider-owned stable key>"
      },

      "enabled": true,
      "created_at": 0,
      "updated_at": 0,
      "next_run_at": 0,              // derived cache; authority is cron + last_fired_at recompute
      "last_fired_at": null         // when the trigger was submitted; NOT success/failure
    }
  ]
}
```

Decisions baked in: schedule is `cron` + `recurring` + `tz` (no `kind:cron/once`
union); `deliver` stores **only** the neutral `(channel_id, target_key)` pointing
at a binding row — never `chat_id`/provider `meta` (G1/R3). `agent_runtime` is a
`config.agents[].id` alias (R5). No `last_status`/`last_error` (fire-and-forget,
G5). Version policy `fail-loud-on-unknown` (0.x no-migration; changelog needs
`Rebuild:`). New path builder `dispatcherCronJobsPath(id) = join(dispatcherDir(id),
'cron-jobs.json')` (cf. `paths.ts:416`), plus `cronMcpLogPath(id)` (cf.
`paths.ts:289`).

## 4. Execution flow

### 4.1 Defer-until-idle (the two-line core)

```ts
await (runtime.waitIdle?.() ?? Promise.resolve());
await runtime.completionInput({ text: job.prompt, sourceId });
```

- **Held-fire queue:** `SchedulerService` keeps `Map<jobId, symbol>` tokens for
  pending waits. If a job comes due while the same id is already held, do NOT
  enqueue another — same-job fires across one long busy stretch **collapse to one**
  (R2/OQ-5). After idle, the token is rechecked before injection.
- **Max-defer:** the caller owns timeout with `Promise.race` around
  `runtime.waitIdle?.() ?? Promise.resolve()`. The runtime receives no
  `AbortSignal` and has no watchdog. The scheduler clears the timeout handle
  when idle wins; on timeout, the held fire is recorded missed (a log line; no
  `last_status` under fire-and-forget).
- **Teardown:** `SchedulerService.stop()` invalidates held tokens, clears timers,
  and resolves stop waiters so in-flight held fires return skipped without
  injecting a scheduled turn.

### 4.2 Scheduled injection verb (superseded: now plain text completion input)

`agent.send` is rejected as primary: it enters as a channel-inbound turn
(`runtime.channelInput({sourceId:'teammate:...'})`, `teammate-service/index.ts:178,515`)
— disguising a non-channel event as channel inbound (G2) and folding into the
user's live turn on Codex (R2). The former conclusion to use
`systemInput({reason:'scheduled'})` is superseded. Use the plain text
`completionInput({ text, sourceId })` seam from
[AgentRuntime input surface cleanup](agent-runtime-input-surface-cleanup.md).
- Tag the scheduled turn's record with a structured `origin: { kind:'scheduled',
  job_id }` in `turn.jsonl` (cf. teammate `turnOrigin`,
  `teammate-service/index.ts:549`) — the structured turn↔job association (G3), never
  an `intent:'cron:<id>'` magic prefix.

### 4.3 Egress (deferred until a separate neutral egress contract)

Bindings are Team-scoped `ChannelBinding` (`channel-binding/store.ts:20-39`), keyed
`(channel_id, target_key)`, provider selectors in `meta`. This remains the right
state shape for a future egress feature, but the updated AgentRuntime input
surface is text-only for non-channel turns. Do not carry a resolved
`ChannelTarget`, channel attributes, or reply metadata through
`completionInput`.

Deferred design shape:
1. **State** — `deliver = {channel_id, target_key}` referencing an existing binding;
   validated at create/update via `DispatcherService.resolveChannelTarget(meta, channelId)`
   (`index.ts:610`) but only the neutral keys are stored.
2. **Resolve** — at fire, `ChannelBindingStore.resolve(...)` → neutral `ChannelTarget`
   (`dreamux-types/channel.ts:32-39`).
3. **Delivery** — out of scope for the text-only scheduled-turn slice. Jobs
   without `deliver` (internal turns) may ship first; jobs with `deliver` remain
   rejected or deferred until a separate neutral egress contract exists.

The scheduler must not concatenate `chat_id` into prompt text, must not send
channel messages itself, and must not pass channel target metadata through the
runtime input surface. A future egress contract may execute outside the runtime
input surface or add a dedicated neutral capability, but it is not part of this
proposal.

Note: `channel.ts`'s `message_id` is a legitimate **channel-layer** field; the
runtime contract (`turn.ts InboundTurnInput`) has none — keep it that way.

### 4.4 Restart-notice is NOT changed (corrected 2026-06-25)

An earlier draft proposed unifying restart-notice and cron into one shared
deferred-injection mechanism. That was wrong: `injectRestartNoticeIfNeeded`
(`index.ts:614-639`) runs at the end of `doStart`, the instant the runtime just
started / resumed — the process is fresh, there is no in-progress turn, the agent
is idle by definition, so `waitIdle` would be a no-op. The restart notice's
delivery seam is now governed by
[AgentRuntime input surface cleanup](agent-runtime-input-surface-cleanup.md),
but it still does not become a scheduler wait-idle consumer. The scheduler is
the **sole** consumer of `waitIdle`; it inlines
`await Promise.race([runtime.waitIdle?.() ?? Promise.resolve(), maxDefer])` —
there is no shared deferred-injection helper. (`getRuntime() !== null` existence
gates and `getStatus()` lifecycle reads are unrelated and untouched.)

## 5. Control surface (native-aligned)

### 5.1 Cron MCP (`mcp/cron-mcp.ts`, new) — dispatcher-only

stdio JSON-RPC shim shaped like `mcp/team-mcp.ts` (`tools/call` →
`sendAdminRequest('scheduler.cron.*')`); descriptor like `team-collection`'s
`teamMcpServerDescriptor`; CLI like `cli/commands/team-mcp.ts`. Added to
`dispatcherMcpServerDescriptors` (`mcp-descriptors.ts:18-40`) **only**, never to
`mcpServersForTeamMate` (`dispatcher-service/index.ts:162-181`) — so team_leader has
no cron tools (R4).

Tools (snake_case names; **params/descriptions aligned to the host's native
`CronCreate`/`CronList`/`CronDelete`**):

| Tool | Params | Notes |
|---|---|---|
| `cron_create` | `{ cron, prompt, recurring?, tz?, action?, deliver? }` | `cron` = 5-field local-time; `prompt` = enqueued text; `recurring` default `true` (one-shot = `false`, disables after firing). Returns job id. Description carries native guidance: prefer off-`:00`/`:30` minute for approximate times (thundering-herd); "remind me at X" → `recurring:false` with pinned fields. |
| `cron_list` | `{}` | lists this dispatcher's jobs |
| `cron_delete` | `{ id }` | by job id |
| `cron_update` | `{ id, ... }` | dreamux extension, same naming style |
| `cron_run_now` | `{ id }` | dreamux extension, fire once now |

Deliberate divergences (state in the descriptions): no `durable` param (dreamux jobs
are **always** server-persisted/restart-surviving — the whole point); adds `tz`
(resolved+stored) and execution/`deliver` target; no 7-day auto-expire.

### 5.2 Admin methods

`scheduler.cron.{list,create,delete,update,run_now}` in `admin/methods.ts` (thin
delegates to `server.getDispatcher(id).scheduler.*`; cf. existing MCP delegates
`:109,:231`). `action.agent_runtime` validated as a `config.agents[].id` alias via the
same `resolveAgent` path teammate spawn uses (R5).

## 6. Security & guardrails (OQ-8, v1 mandatory)

| Guardrail | Implementation point |
|---|---|
| Only owner-authorized dispatcher context creates/updates (no team_leader) | MCP injection gate (§5.1) + admin method checks |
| max jobs / dispatcher | `CronJobStore.create` count cap, fail-loud over limit |
| min interval (anti high-frequency) | at create, croner-compute the gap between two fires; reject below threshold |
| audit log | structured dispatcher log on every create/update/delete/fire |
| destructive/public/credential/persistent-config ops not bypassed | a scheduled turn runs through the same tool gates as a human turn; no pre-authorization |

(Auto-disable after N failures is OQ-7 and **not** in v1 — fire-and-forget has no
terminal observation.)

## 7. Lifecycle wiring

`SchedulerService` (`service/scheduler/`, one per dispatcher) is constructed in the
`DispatcherService` ctor (sibling to `CompletionRouter`/`ChannelSessions`/agent,
`index.ts:114,134,144`). Arm at the **end** of `doStart()` — after
`injectRestartNoticeIfNeeded()` (`:302/614`) so the same startup instant doesn't race
the thread (R6). Disarm in `stop()` (`:305`) FIRST — not only `shutdown()`, because
admin `dispatcher.stop` calls `stop()` (R6); `shutdown()` already calls `stop()`
(`:347/354`).

## 8. PR plan (codex-package-first; finer-grained of the two dossiers)

| PR | Content | Depends |
|---|---|---|
| PR1 | Neutral contract: optional `waitIdle?()` plus the plain text scheduled injection seam (`dreamux-types`); keep the contract lint gate neutral | — |
| PR2 | **codex** `waitIdle` (TurnManager busy + idleWaiters, TRAP-1); scheduled turns use plain text input (prereq #1) | PR1 |
| PR3 | **claude** `waitIdle` (+`queuedTurnCount`, TRAP-2); scheduled turns use plain text input | PR1 |
| PR4 | scheduler-only `waitIdle` consumer (inline `Promise.race`); restart notice remains outside scheduler wait-idle | PR2,PR3 |
| PR5 | `JsonDocumentStore` + `CronJobStore` + `dispatcherCronJobsPath`/`cronMcpLogPath` + `detectLegacyCronJobStore` into serve/doctor preflight; round-trip/fail-loud tests | — (parallel) |
| PR6 | `SchedulerService` (croner schedule, arm/disarm, next recompute, held-fire collapse + max-defer) + `prompt-agent` execution; lifecycle wiring (§7) | PR4,PR5 |
| PR7 | `spawn-teammate` execution path (teammate collection + CompletionRouter) | PR6 |
| PR8 | admin `scheduler.cron.*` + CLI | PR6 |
| PR9 | Cron MCP stdio shim + dispatcher-only injection + croner via rush | PR8 |
| PR10 | KB reference + decision close-out + rush change file (persisted format + new MCP/CLI + runtime contract) | all |

Separate behavior-preserving follow-up (not blocking): migrate the four existing
stores onto `JsonDocumentStore`, fixing the non-atomic `DispatcherStore` write.

## 9. Mandatory prerequisites (skipping any silently breaks the feature)

1. **Scheduled injection must use the plain text runtime input** — do not route
   scheduled work through channel input, and do not add a provider-facing
   `systemInput.reason` branch.
2. **Claude `queuedTurnCount` must exclude the steer-fold branch** (TRAP-2) or
   `waitIdle` never resolves.
3. **Egress is deferred from this text-only slice** — scheduled jobs that need
   `deliver` must be rejected or held until a separate neutral egress contract
   exists. Never pass `ChannelTarget` metadata through `completionInput`, and
   never fall back to prompt-string glue.

## 10. Test plan

- **Contract (per provider):** codex idle/busy/`waitIdle` resolve-all/no-leak +
  TRAP-1 (busy in the slot-claimed window); claude `++`/`--` parity + TRAP-2
  regression (steer fold adds no count, `waitIdle` still resolves after the
  original turn settles); omitted `waitIdle` means always idle.
- **Defer-until-idle (scheduler only):** already idle injects immediately; busy
  injects on idle; same-job collapse; max-defer timeout skips/re-arms; cancel or
  missing/disabled job before idle does not inject; non-submitted plain text
  input does not advance schedule.
- **Store:** round-trip; missing⇒`empty()`; version/shape mismatch ⇒ fail-loud;
  atomic no-torn-write; malformed `cron-jobs.json` caught at `Server.start()` + doctor
  (`detectLegacyCronJobStore`, cf. `channel-binding/store.ts:219`).
- **Scheduler:** >~24.8-day next fire is segmented (no immediate misfire); overlap →
  defer-collapse; missed run skip-and-rearm (recompute, don't trust `next_run_at`);
  `recurring:false` disables after firing.
- **Cron MCP / admin:** JSON-RPC list/call schema; admin forwarding; dispatcher-only
  injection (no cron tools on team_leader); guardrail caps.

## 11. Verdict

GO. Every load-bearing seam is confirmed in source (contract extension points, both
providers' busy truth, store/atomic-write/preflight patterns, injection/lifecycle/
role-MCP/egress-binding-resolution). The risk is not cron math but G1/G2: never use
`send()` to fake channel inbound, never pass `chat_id` as a prompt string. With the
three §9 prerequisites and the codex-first PR order, this drives implementation
directly without introducing new glue.
