# Final technical solution

## Outcome and boundary

Make `TeamSummary` the single flat Team read projection returned by
`team.create`, each item of `team.list`, and `team.status`. `status` always means
the Team lifecycle (`starting | running | closed`). Remove the public and
internal `TeamCreateResult`, `TeamListRow`, `TeamView`, their conversion paths,
and the uncalled exact-name `TeamCollection.create()` entry point.

Keep `team.history` as its purpose-built paginated recovery row. Do not change
persisted Team or Agent state, creation idempotency, Team lifecycle, routing,
dissolution, or the manual bind's existing requirement that the TeamLeader
identity be readable.

## 1. One canonical contract

Declare `TeamStatus` and `TeamSummary` in `@excitedjs/dreamux-types`, the neutral
contract package already consumed by Core and Feishu. Core imports this contract
instead of defining parallel internal views. `TeamSummary` contains one flat,
serializable set of facts:

- Team identity and lifecycle: `team_name`, `status`, `intent`, `created_at`,
  `updated_at`, `closed_at`, and `close_note`;
- stable TeamLeader identity: `leader_name`, `leader_agent_runtime`, and
  `runtime_cwd`;
- current TeamLeader state: nullable `leader_state` (the existing
  `TeammateStatus` vocabulary), `leader_session_id`, `leader_runtime_status`,
  `leader_intent`, `leader_last_error`, `leader_closed_at`, and
  `leader_close_note`;
- member aggregate: `member_count`;
- record-owned workspace facts: `source_repo`, `worktree_mode`,
  `worktree_cleanup_mode`, and `worktree_cleanup`.

The Team record supplies every stable and workspace field. A readable, aligned
TeamLeader identity supplies durable leader state, and a held live service may
also supply its current runtime status. Leader-state fields are nullable for the
real interrupted-creation and promptless/lazy-runtime cases; stable record facts
remain required. A closed Team is a successful summary with `status: 'closed'`;
an unknown name still raises `TEAM_NOT_FOUND`.

There is no `{ outcome, team }` wrapper, `created` boolean, operation-status
overload, optional compatibility branch, or provenance flag. Idempotency stays
an input-side protocol owned by the accepted Team record.

The old nested leader projection exposed `repo.branch` and `repo.base_ref`, but
no create, list, status, Channel, or orchestration consumer reads those values.
They do not enter the canonical contract: promoting them to required top-level
fields would preserve an unconsumed surface rather than a required Team fact.
Their authoritative values remain in the persisted Team and Agent identities
for the worktree owners that actually use them.

## 2. One projector and one source-selection rule

Replace `teamView()` and all create/list-specific mappers with one pure
`teamSummary(record, leader, memberCount)` projector. It owns field naming,
nullability, and the record-versus-leader choice; it performs no I/O.

`TeamCollection` owns the one live-versus-store source-selection rule because it
already owns both the runtime registry and the store read model:

1. if the registry already holds a `TeamService`, obtain the current leader
   status from that service;
2. otherwise read the aligned leader identity from storage and use a null
   runtime status;
3. never materialize a Team, start a runtime, invoke the public `team.status`
   command, or add a second conversion to answer create/list/status.

Apply that same selection to status, every list item, and accepted-request
replay. List and replay pass the Team record they already found into the
selection rather than looking it up again. Thus a running leader already held by
this process does not appear runtime-less merely because the caller used list or
replayed create.

An accepted replay performs one aligned leader-identity read and one bounded
member-directory scan when no live service exists. This is the necessary owner
read that constructs the canonical current projection, not a redundant command
round trip, and it neither materializes the Team nor resubmits the prompt.

## 3. One member-count meaning

`member_count` means occupancy of the Team's member directory, excluding the
TeamLeader. Closed and unreadable member identities still occupy roster slots
and count. Both live and store-only summaries use this existing store-owned
fact, so the count cannot change merely because a `TeamService` is materialized
or evicted.

Expose that count through the owning Team/TeamMate collection boundary. Do not
parse every identity, add a persisted aggregate, cache the count, or preserve
the current live-path `members().length` divergence.

## 4. Collapse creation to the canonical producer

`TeamRuntimeRegistry.create()` keeps its existing `null` = candidate-taken
protocol but returns the created `TeamService`, not a create-specific DTO.
Request-based creation asks that service for the canonical summary. Accepted
request replay passes the accepted record through the collection source
selection described above.

Delete `TeamCollection.create()`: it has no production caller, and its only test
caller can use `createFromRequest` with a fixed request id. Delete the internal
`TeamCreateResult` that existed only for that path. This leaves one creation
producer rather than rewiring a dead entry point to the new type.

The Team MCP adapter generates a fresh request id for every call. Therefore,
after a successful prompt-bearing MCP create, prompt submission is known to have
succeeded; its reminder depends on the input prompt rather than a returned
`created` discriminator.

## 5. Command and Channel consumers

Define one closed `TeamSummary` output schema and reuse it for `team.create`,
`team.status`, and every `team.list.teams` item in both canonical commands and
the model-facing MCP catalog. The model should see the same named fields rather
than open object blobs. `team.list` no longer describes its rows as compact.

Feishu automatic provisioning consumes top-level lifecycle status and the
stable Team, leader, runtime-ID, and cwd fields returned by `team.create`. It
does not call `team.status` afterwards.

Manual binding keeps exactly one `team.status` call because it targets an
existing Team. It rejects `status === 'closed'` and preserves the existing
incomplete-TeamLeader refusal by requiring `leader_state !== null` before route
persistence. It then consumes the required top-level stable fields, including
`runtime_cwd`. This is a shape migration, not a relaxation of the binding
guard. `TEAM_NOT_FOUND` remains the Core-authored thrown failure.

## 6. Same-pattern audit

The bounded audit covers separate create/list/status shapes for the same entity,
one field name carrying operation and lifecycle states, and follow-up reads used
only to repair a narrow result. It finds no second in-scope implementation:

- TeamMate list/status already share `AgentEntityRuntimeStatus`. Spawn/send add
  genuine admission outcomes. Close is a wrapper-only candidate, but keeping its
  command-specific envelope is independent of this Team contract and has no
  overloaded status or repair read.
- Workflow list/status share `WorkflowRunRecord`. Run/stop are asynchronous
  receipt subsets; they do not overload an operation outcome onto the record's
  lifecycle status and have no repair read. Their possible wrapper simplification
  is evidence-only, not part of this change.
- Scheduler cron create/update/list already share `cronJobResult`, and there is
  no cron status verb.
- Channel inventory has only list. Dispatcher list and status answer host-level
  inventory and calling-runtime questions, respectively, and have no create
  projection to unify.

No unrelated surface changes are included.

## 7. Compatibility, knowledge, and change records

This intentionally changes the model/admin/Channel command response shape but
does not change persisted state. It supersedes the earlier decision that
`team.list` remain compact and workspace mode appear only on `team.status`,
because the operator has now explicitly required create/list/status to share one
interface. `team.history` remains compact because it is outside that ruling.

Update the product behavior catalog, Dispatcher orchestration domain, and
Channel domain to describe the canonical response and the unchanged automatic
create/manual-status call counts. Add Rush change files for
`@excitedjs/dreamux-types`, `@excitedjs/dreamux`, and the Dreamux-internal
Feishu Channel package. No rebuild or state migration is required.

## 8. Verification

- Projection tests cover fresh create, accepted replay, live and store-only
  Teams, promptless Teams, missing leader identity, closed Teams, and unknown
  Team failure. A held-open leader proves create/status/list/replay expose the
  same available runtime status without resubmission.
- Member-count tests keep the same member directories across live/store reads,
  including a closed identity and a missing or malformed identity, and assert
  equal occupancy counts with the leader excluded.
- Command and MCP tests pin the same closed `TeamSummary` schema and field
  meanings for create/list/status, plus unchanged compact history.
- Remove the obsolete `TeamCreateResult['status']` type assertion; update the
  package boundary export-name guard for `TeamStatus` and `TeamSummary`. Review
  those test changes against this contract rather than treating a green run as
  evidence by itself.
- Feishu tests use one canonical summary fixture for automatic provisioning and
  manual binding, prove no status call follows create, preserve one status call
  for manual binding, and pin the `leader_state !== null` pre-bind guard.
- Probe the three model-facing tool definitions to confirm the advertised output
  schemas are closed and identical at the Team item level.
- Run Rush build, lint, test, and `typecheck:tests`; run task validation,
  `.agents/scripts/check.sh`, Rush change verification, and `git diff --check`.

## Review adjudication

The Codex review's two semantic blockers are accepted: TeamCollection applies a
single live/store selection rule, and member count receives one occupancy
meaning. Its audit-accuracy note is accepted by naming wrapper/subset candidates
without claiming they all carry extra operation facts.

The Seed review's cleanup and completeness findings are accepted: delete the
uncalled internal create path, close all three output schemas, update the named
contract tests and Channel knowledge, and state the replay read cost. Its
suggestion to drop the manual binding's leader-readability guard is rejected for
this change: the operator requested projection unification, not a change from
refusing an interrupted-creation Team to binding it. Re-anchoring the same guard
to `leader_state` preserves current user-visible behavior without compatibility
machinery.

The Trae-Claude review independently confirmed the live/store runtime-status,
member-count, manual-bind, audit-accuracy, and dead-create-path findings; those
are resolved by the same decisions above. Its workspace-field audit is also
accepted: `worktree_branch` and `worktree_base_ref` have no projection consumer,
so the canonical summary does not promote them. The stored identities and the
worktree subsystem remain unchanged.

## Rejected alternatives

- Do not return `{ outcome, team }`, a `created` flag, or the old operation-status
  vocabulary; no current consumer needs it.
- Do not call `team.status` after create, materialize Teams for reads, persist
  runtime status, add provenance fields, or maintain live/store projection
  variants.
- Do not retain dead exact-name creation merely because a test calls it.
- Do not flatten `team.history`; it is a recovery search row with pagination-only
  facts, not the Team read projection named by the operator.
- Do not use this type refactor to relax the manual binding guard or to simplify
  independent TeamMate/Workflow receipt APIs without their own requirement.
