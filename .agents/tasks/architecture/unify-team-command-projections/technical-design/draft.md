# Draft technical solution

## 1. Outcome

Make `TeamSummary` the one Team read projection returned by `team.create`, each
item of `team.list`, and `team.status`. Remove `TeamCreateResult`, `TeamListRow`,
and `TeamView`; `team.history` keeps its purpose-built paginated recovery row.

The returned `status` always means the Team lifecycle
(`starting | running | closed`). Creation idempotency remains an input-side
protocol enforced by the Team record and no longer creates a second result-state
vocabulary.

## 2. Canonical contract

Declare the serializable `TeamStatus` and `TeamSummary` contracts in
`@excitedjs/dreamux-types`, which already owns the Channel-to-Core `team.create`
contract. Core imports that contract rather than maintaining a parallel internal
shape, and Feishu consumes the same declaration.

`TeamSummary` is one flat interface. It preserves every current `team.status`
fact while making record-owned TeamLeader and workspace identity available even
when no live runtime exists:

- Team identity and lifecycle: `team_name`, `status`, `intent`, timestamps,
  `close_note`;
- TeamLeader stable identity: `leader_name`, `leader_agent_runtime`,
  `runtime_cwd`;
- TeamLeader current state: nullable `leader_state`, `leader_session_id`,
  `leader_runtime_status`, `leader_intent`, `leader_last_error`,
  `leader_closed_at`, and `leader_close_note`;
- aggregate count: `member_count`;
- repository/workspace facts: `source_repo`, `worktree_mode`,
  `worktree_branch`, `worktree_base_ref`, `worktree_cleanup_mode`, and
  `worktree_cleanup`.

The Team record supplies every stable field. An aligned TeamLeader identity,
when readable, supplies the current TeamLeader fields; otherwise those fields
are `null`. This keeps a closed or interrupted `starting` Team readable without
materializing it and without discarding the record-owned runtime ID or cwd.

No wrapper such as `{ outcome, team }`, no `created` boolean, and no optional
compatibility branch is introduced. The MCP create entry already mints a fresh
request id per call, so after a successful prompt-bearing create it knows that
the first turn was submitted. Feishu provisioning uses lifecycle
`status === 'closed'` to recognize a replayed closed Team and otherwise consumes
the canonical stable fields.

## 3. One producer path

Replace `teamView()` with a pure `teamSummary(record, leader, memberCount)`
projection. `TeamCollectionReadModel.summary()` reads the aligned leader identity
and member count once, then calls that projector. `list()` calls `summary()` for
each stored Team instead of maintaining a compact row mapper.

For a live Team, `TeamService.status()` calls the same projector with the live
TeamLeader status and member count. The runtime registry returns the created
`TeamService`, not a create-specific data transfer object. Both direct internal
creation and request-based creation finish by asking that service for the same
summary. An accepted request replay uses the record-only read model, not
`team.status`, materialization, or a second conversion.

This removes the create-only member/status assembly and the list-only field
assembly. It does not add an extra Core command invocation.

## 4. Consumer migration

- `team.create` validates and returns `TeamSummary`. The Team MCP create reminder
  depends only on a non-null input prompt after success; its fresh generated
  request id makes a successful call a fresh creation.
- `team.list` returns `{ teams: TeamSummary[] }`; its description no longer calls
  the rows compact.
- `team.status` returns `TeamSummary` directly, not
  `{ team, leader, member_count }`.
- Feishu automatic provisioning uses top-level lifecycle status and the stable
  Team/TeamLeader/runtime fields. Manual binding consumes the exact same fields
  from `team.status`; it retains its one pre-bind existence/lifecycle read and
  performs no runtime materialization.

## 5. Same-pattern audit

Audit Core entity commands for three concrete smells: separate create/list/status
shapes for the same entity, one field name carrying operation and lifecycle
states, and follow-up reads whose only purpose is repairing a narrow result.

The bounded current-code audit finds no second in-scope instance:

- TeamMate `list()` and `status()` already share
  `AgentEntityRuntimeStatus`; create/send/close wrap that same entity status only
  to add their real operation-specific result.
- Workflow `status()` and each `list().runs` item already share
  `WorkflowRunRecord`; `run` and `stop` receipts carry distinct operation facts.
- Channel inventory has only a list surface. Dispatcher summary/runtime status
  answer different host-vs-runtime questions and are not create/list/status
  projections of one entity.

No unrelated surface changes are included.

## 6. Compatibility and knowledge

This intentionally changes the model/admin/Channel command response shape but not
persisted state. It supersedes the earlier decision that `team.list` remain
compact and that workspace mode appear only on `team.status`, because the operator
has now explicitly required create/list/status to share one interface.
`team.history` is not covered by that ruling and stays compact.

Update the product behavior catalog and Dispatcher orchestration domain to state
the canonical read contract. Add Rush change files for `@excitedjs/dreamux-types`,
`@excitedjs/dreamux`, and the Dreamux-internal Feishu Channel package.

## 7. Verification

- Projection tests cover live, lazy, missing-identity, and closed Teams.
- Command/MCP parity tests pin the same summary for create/list/status.
- Feishu tests pin automatic provisioning and manual binding against the same
  fixture and prove no follow-up status call after create.
- Run Rush build, lint, test, and `typecheck:tests`, with the documented live
  Codex skip only if the environment intentionally lacks it.
- Run task validation, `.agents/scripts/check.sh`, Rush change verification, and
  `git diff --check`.
