# Existing-behavior decisions: 2026-10-02

## Authority and baseline

This is a continuation of the existing code-organization task, following the
operator's request to review changes to capabilities already present on `next`.
It introduces no new plugin capability. The operator answered the two pending
product questions on 2026-10-02 at 07:20 (UTC+08:00):

1. "不用保留"
2. "停止新建"

Their respective subjects and narrow scopes are recorded as R72 and R73 in
[the rulings ledger](../rulings.md#existing-behavior-follow-up-2026-10-02).
Source verification used `feat/plugin-system-mvp` after
[PR #460](https://github.com/excitedjs/dreamux/pull/460), the branch's latest
merged change at the time of this follow-up.

## R72: onboard may discard unknown wrapper fields

The question concerned fields unknown to Dreamux on the configuration wrapper,
including wrapper fields on entries an onboard run does not edit. The answer
accepts the current rewrite rather than requiring preservation.

Current behavior is implemented by
`packages/dreamux/src/onboard/config-files.ts` (`dreamuxConfigFromAnswers` and
`cloneDispatcherConfig`) and
`packages/dreamux/src/config/config.ts` (`stringifyConfig`): onboard reconstructs
the known wrapper fields. Provider-owned `config` contents on untouched entries
retain their `rawConfig` round trip. R72 does not authorize deleting those
contents or changing other writers such as `config.agents.replace`.

Status: **settled; current behavior accepted**. No raw-document preservation
mechanism is needed. Load-time unknown-field tolerance remains as ruled in R21.

## R73: closing owners refuse new Workflow TeamMate construction

The question concerned an already accepted Workflow reaching a later TeamMate
creation after its owning Team or Dispatcher starts closing. The answer requires
the same refusal in both scopes. It does not undo work already admitted before
the owner closed its admission.

Pre-implementation source evidence at the PR #460 baseline:

- `service/agent/index.ts`, `TeammateCollection.createLocked`, constructs without
  entering the collection's admission owner.
- `service/dispatcher-service/index.ts` supplies an outer Dispatcher admission
  wrapper to Workflow construction.
- `service/team/service.ts` supplies the Team's member collection directly to
  its Workflow service; that collection already holds the Team's admission
  owner, whose `admit` checks the Team before Dispatcher admission.
- `technical-design/data-flow/final.md`, section 1, deliberately preserved this
  asymmetry pending a product ruling. R73 settles that specific exception.

Acceptance boundaries:

- If the relevant owner is already closing when a Workflow requests its next
  TeamMate construction, refuse before allocating a workspace, creating a new
  identity, or running its launch hook.
- Apply this to Team and Dispatcher Workflow construction. Preserve the Team
  then Dispatcher refusal order and the existing error contracts.
- Construction admitted before close retains the existing materialization
  tracking, runtime stop, lock handoff/release, and Workflow finalization.
- Preserve queued completion delivery, stop-and-reclaim semantics, and R67
  dissolve order. Do not introduce a second close flag or cancellation model.

Status: **implemented; local gates and independent review complete**. The
[verification record](/.agents/tasks/architecture/code-organization-refactor/technical-design/workflow-close-admission/verification.md)
tracks delivery evidence and remaining coverage. PR #460 already fixed
lock release when late publication refuses a built entity; that repaired bug
must not be reported as still open. The remaining change concerns admission
before construction.

## Follow-up boundary

These answers settle product intent. Implementation and validation evidence
are owned by the linked verification record. The inherited
pairing-expiry and released-topic COT findings, architecture review findings,
and final PR #453 coverage obligations retain their separate dispositions;
neither answer decides their implementation.
