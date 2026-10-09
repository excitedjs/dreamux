# R73 construction admission: source audit

## Baseline and history

Fetched `feat/plugin-system-mvp` and `next` on 2026-10-02. The feature branch's
latest merged change remains [PR #460](https://github.com/excitedjs/dreamux/pull/460).
This is the pre-implementation consultation snapshot; no R73 implementation
edits had been made at the time of this audit. Current delivery evidence is
owned by [verification](verification.md).

The R71 [final design](../data-flow/final.md#1-closing-fences-and-construction-order)
explicitly retained the Dispatcher wrapper and Team raw-collection path rather
than deciding their product asymmetry. R73 now settles only that exception.
PR #460 repaired failed-publication lock release; it did not add collection
admission to `createLocked`.

## Current owners and callers

| Fact or operation | Source evidence | Consequence |
| --- | --- | --- |
| Owner admission | `platform/work-fence.ts:29-32`; `service/team/service.ts:552-555` | Dispatcher checks its permanent close fence; Team checks its dissolve/closed fact before entering Dispatcher admission. |
| Locked construction | `service/agent/index.ts:212-235` | The collection holds that owner already, but this public verb currently skips it. |
| Dispatcher Workflow factory | `service/dispatcher-service/index.ts:284-290` | An outer closure currently supplies the missing Dispatcher gate. |
| Team Workflow factory | `service/team/service.ts:225-233` | The actual member collection is passed directly, exposing the missing early Team check. |
| Workflow caller | `service/workflow-service/run.ts:481-507` | The run requests construction, records its promise as a materialization, then takes ownership of the returned locked handle. |
| Pre-publication side effects | `service/agent/index.ts:647-748` | Name allocation, workspace resolution, identity creation, launch options, and lock acquisition occur before publication checks the owner. |
| Late-publication refusal | `service/agent/index.ts:740-747,772-780` | An admitted build that observes close releases its unhanded lock and requests host stop before rejecting. |
| Already-entered construction tracking | `service/agent/index.ts:160-173,606-626` | The existing narrow allocation tracker and materialization map allow stop to find builds without waiting for a submitted native turn. |
| Workflow finalization | `service/workflow-service/run.ts:696-726` | Finalization joins construction promises and closes returned handles before joining agent tasks. |
| Host close | `service/dispatcher-service/lifecycle.ts:89-108,225-240` | The owner raises admission first, requests Workflow stop, sweeps runtimes, joins admitted work, then repeats the idempotent sweep. |

## Named failure scenario

An accepted Team Workflow is awaiting an earlier step or concurrency slot.
Dissolve passes its worktree precheck and raises the Team fence, then awaits
the durable closed write before `destroyChildren` requests Workflow stop
(`service/team/service.ts:591-653,752-757`). The Workflow reaches its next
`createLocked` request during that ordinary asynchronous window. The raw
collection path can still allocate a name,
create an identity, and run launch construction before its late-publication
check refuses the work. R73 requires refusal before starting that construction.
No simulated runtime crash, new timeout, recovery state, or durable schema is
needed to explain the scenario.

## Boundaries to preserve

- R73 concerns admission of each new construction request, not cancellation of
  every construction that entered before close.
- Keep the Team-then-Dispatcher owner ordering and the owner's existing refusal
  errors for a newly refused request. Preserve the separate late-publication
  refusal path for an already-admitted build.
- The newly introduced early Team refusal will use `TeamClosedError` from its
  existing owner rather than the current late-publication
  `ServerShuttingDownError`, which names the Dispatcher even for Team close.
  This is part of applying the existing owner contract at the newly selected
  earlier boundary; do not conceal that observed error change as identical
  behavior. The old late-publication error remains for admitted builds.
- Construction tracking must end at handle creation. It must not include a
  native turn's submission or completion; a host sweep must be able to stop
  the runtime that would otherwise block such a wait.
- Keep the existing lock ownership transfer and PR #460's failed-publication
  undo. A successful handle belongs to its Workflow run until finalization.
- Keep Workflow result classification, completion suppression and queued
  delivery, R67 dissolve order, and Team-member workspace policy unchanged.

This file records source facts for adjudication. It is not an additional
requirement, selected solution, or implementation authorization.
