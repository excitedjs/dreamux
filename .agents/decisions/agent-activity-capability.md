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

```ts
interface AgentRuntimeActivity {
  busy: boolean;               // a turn is in progress (or queued) right now
  activeTurnId: string | null;
}

interface AgentRuntime {
  getActivity(): AgentRuntimeActivity;           // synchronous snapshot (status/observability)
  waitIdle(signal?: AbortSignal): Promise<void>; // resolves immediately if idle, else on the next busy→idle edge
}

// capability gate:
capabilities.activity = { supported: boolean };
```

- `waitIdle()` is the control-flow primitive; the whole deferred injection is
  `await runtime.waitIdle(signal); await runtime.systemInput(...)`. The optional
  `AbortSignal` cancels a held wait (max-defer timeout, scheduler teardown).
- `getActivity()` is a snapshot for status reads and "inject now if idle, else
  enqueue" branching.
- A runtime with `activity.supported === false` has `waitIdle()` resolve
  immediately and `getActivity()` report `busy: false`; consumers then inject
  without deferring — never a silent core-side reconstruction. Both built-ins
  report `true`.

**Unify the existing ad-hoc busy-check onto this.** Today the only place core
reasons about "a turn is in progress" is the `systemInput` injection path
returning a `skipped` result when it races a live turn
(`dreamux-types/src/turn.ts` `NoticeInjectionResult`, the `skipped → stopped`
translation, and `injectRestartNoticeIfNeeded`). The restart-notice
"skip if busy" and the scheduler "defer until idle" are the same problem: build
one **deferred system-injection** mechanism in core on top of `waitIdle()` that
both use, and retire the `skipped` race-result.

**Sequencing** (per "Codex protocol bumps update the codex package first; core
stays behind the neutral interface"): land the neutral contract + capability →
Codex impl (state already present) → Claude Code impl (add `queuedTurnCount`) →
core deferred-injection consumer → scheduler.

## Consequences

- **Cross-process contract change** to `@excitedjs/dreamux-types`, independent of
  the cron feature — that is why it is its own record.
- **Not migrated (different axis):** `getRuntime() !== null` existence gates and
  `getStatus()` lifecycle reads stay; they are "does a runtime exist / what is
  its lifecycle", not "is it mid-turn".
- **Foot-gun (race):** after `await waitIdle()` resolves, a user turn can begin
  before the injection runs (unavoidable with any signal style). Acceptable for
  fire-and-forget scheduling; a caller that cares re-checks `getActivity().busy`
  and re-waits. No atomic "run-when-idle" primitive in the first cut.
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
