# Agent activity capability (busy/idle) on the neutral runtime contract

- **Status:** Accepted (design); implementation pending
- **Date:** 2026-06-24
- **Affects:** `@excitedjs/dreamux-types` (`agent-runtime.ts`),
  `@excitedjs/agent-runtime-codex`, `@excitedjs/agent-runtime-claude-code`,
  `/packages/dreamux/src/service/dispatcher-service/` (restart-notice injection),
  any core consumer that must act only when an agent is idle
- **PR / Issue:** surfaced by the scheduled-tasks design
  ([`.agents/proposals/scheduled-tasks.md`](../proposals/scheduled-tasks.md))

## Context

The scheduled-tasks "defer-until-idle" rule needs to know whether an agent is
mid-turn before injecting a trigger (a mid-turn inject would be folded into the
user's active turn — Codex `steer.supported` — and hijack it). The naive fix is
a core-side counter that increments on `submitted` and decrements on
`onTurnSettled`. That is a fragile re-derivation of state the runtime already
owns authoritatively, and it drifts from reality under Codex input folding and
Claude steer absorption. It also violates the repo invariant "core stays behind
the neutral interface; runtime specifics do not leak into core".

`AgentRuntimeStatus` (`ready/starting/stopping/…`) is a lifecycle enum, not a
turn-active signal, so the busy/idle fact does not yet exist on the contract.

Investigation confirmed both built-ins already track turn-active state
internally and accurately: Codex `TurnManager.activeTurnId` + `pendingTurnIds`
(authoritative, app-server backed); Claude Code `activeChannelTurn` plus a small
`queuedTurnCount` to be added for non-channel turns. Reporting cost is ~zero.

## Decision

Add a first-class **agent activity capability** to the neutral `AgentRuntime`
contract in `@excitedjs/dreamux-types`, reported authoritatively by each
provider and consumed by core. Promise-first interface (project preference — no
publish/subscribe, no observer bookkeeping):

**The whole capability is ONE optional method — nothing else** (revised
2026-06-24 to the minimal surface; the earlier draft's `getActivity()` snapshot,
`AbortSignal` parameter, and `capabilities.activity` flag were unnecessary and
are dropped):

```ts
interface AgentRuntime {
  // ...existing...
  /** Resolve when no turn is in progress (immediately if already idle, else at
   *  the next turn-end). Optional: a runtime that cannot track turn activity
   *  omits it entirely and is treated as always-idle (feature-detected by
   *  presence, the repo's convention for optional runtime methods — cf.
   *  `completionInput`). */
  waitIdle?(): Promise<void>;
}
```

- **No parameters, no cancellation.** `waitIdle()` is just "wait for the next
  turn to end." A caller that gives up on one wait (its timeout fired) simply
  abandons that promise; it resolves harmlessly at the next idle edge, where the
  runtime resolves **all** pending waiters and clears them — so abandoned waiters
  self-flush and there is no leak and no need for an `AbortSignal`.
- **Timeout is the caller's concern, expressed as a race:**
  `await Promise.race([runtime.waitIdle?.() ?? Promise.resolve(), timeout])`. The
  runtime owns no timeout/turn-duration mechanism (a turn-duration watchdog was
  tried and removed — it produced a false-idle bug and the consumers already
  bound their own waits).
- **No `getActivity()` and no `capabilities.activity` flag.** A consumer that is
  idle just gets an immediately-resolved `waitIdle()`, so the snapshot was
  unused; feature-detection by method presence replaces the capability flag and
  keeps external providers non-breaking (a provider that omits `waitIdle` is
  treated as always-idle, no contract change forced on it).

**The scheduler is the only consumer of `waitIdle()`.** An earlier draft claimed
the restart-notice's "skip if busy" and the scheduler's "defer until idle" were
the same problem and should share one deferred-injection mechanism. That was
wrong (corrected 2026-06-25): the restart-notice is injected at the end of
`doStart`, the instant the runtime has just started / resumed its thread — the
process is fresh, so there is no in-progress turn to defer around; the agent is
idle by definition. Its existing `inboundSubmitted` skip latch is a *different*
concern — "a real Feishu inbound raced in during startup, so don't double-wake
the thread" — not "wait for the active turn to end". So **restart-notice keeps
its original direct injection unchanged**, does NOT use `waitIdle`, and there is
no shared "deferred system-injection" helper. `waitIdle()` exists solely for the
scheduler's defer-until-idle; the scheduler inlines
`await Promise.race([runtime.waitIdle?.() ?? Promise.resolve(), maxDefer])`.

**Sequencing** (per "Codex protocol bumps update the codex package first; core
stays behind the neutral interface"): land the neutral `waitIdle?()` contract →
Codex impl (state already present) → Claude Code impl (add `queuedTurnCount`) →
scheduler consumes it.

## Consequences

- **Cross-process contract change** to `@excitedjs/dreamux-types`, independent of
  the cron feature — that is why it is its own record.
- **Not migrated (different axis):** `getRuntime() !== null` existence gates and
  `getStatus()` lifecycle reads stay; they are "does a runtime exist / what is
  its lifecycle", not "is it mid-turn".
- **Foot-gun (race):** after `await waitIdle()` resolves, a user turn can begin
  before the injection runs (unavoidable with any signal style). Acceptable for
  fire-and-forget scheduling; a caller that cares uses its own local submit
  guard and re-waits. No atomic "run-when-idle" primitive in the first cut.
- **Enforcement:** the neutral-contract field guard (the dreamux-types lint gate)
  keeps the new types neutral; provider implementations are covered by each
  provider's own tests. A core consumer test should pin "inject is deferred while
  busy, fires on idle".

## Alternatives considered

- **Core-side submit/settle counter.** Rejected — fragile re-derivation that
  drifts from the runtime's real state and leaks runtime concerns into core.
- **`onActivityChanged` observer / event.** Rejected — forces every consumer to
  register/filter/unregister and re-introduces subscription bookkeeping; a
  `waitIdle` promise models "act once when free" and disposes itself.
- **Overload `TurnSettledSignal` with a `busy` field.** Rejected — "a turn
  reached a terminal state" and "the runtime's idle edge moved" are different
  facts; keep them separate. `onTurnSettled` stays for completion routing only.
