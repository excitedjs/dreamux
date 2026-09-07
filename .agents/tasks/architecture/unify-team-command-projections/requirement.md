# Requirement

## Initial request

- The operator asked: "反正状态都是一样的。你不能给他们合并成一个 interface
  吗？不管是 status、list、还是 createResult"
- This is a new follow-up task after the prior Feishu card work was merged.

## Current alignment

- Status: Converged.
- Confirmed current behavior and evidence:
  - Core currently maintains three Team read shapes: nested `TeamSummary` for
    `team.status`, compact `TeamListRow` for `team.list`, and a separate public
    `TeamCreateResult` receipt for `team.create`.
  - The create receipt's `status` is an operation result
    (`created | existing | closed`), whereas status/list use the Team lifecycle
    (`starting | running | closed`). The same field name therefore carries two
    different meanings.
  - Internal creation used to return the full summary plus the leader's first
    turn. That history explains the inheritance, but the current create
    consumers need Team facts, not a second Team shape.
  - Feishu automatic provisioning consumes the Team name, leader name, runtime
    id, runtime cwd, and lifecycle closure. Manual binding obtains the same
    facts through `team.status`.
  - The Dispatcher MCP create entry mints a fresh request id for each call. Its
    completion reminder is therefore determined by the presence of the input
    prompt after a successful create, not by a returned `created` discriminator.
  - `team.create` idempotency remains record-owned. A replay returns the
    canonical current Team summary; a missing request still throws and a closed
    Team remains a successful summary with lifecycle `status: closed`.
- Desired outcome: `team.create`, `team.list`, and `team.status` expose exactly
  one flat canonical `TeamSummary` interface.
- Desired behavior:
  - Every one of the three operations uses the same field names and meanings.
  - `status` always means Team lifecycle and never create-request outcome.
  - The summary directly carries the stable Team, TeamLeader, workspace, and
    member-count facts required by the current callers.
  - `team.create` returns the same current summary for a new request and an
    idempotent replay; it does not add a second result discriminator with no
    consumer.
- Scope:
  - Core Team projections and their read/create production paths.
  - Command and Team MCP schemas/descriptions.
  - Feishu provisioning and manual-binding consumers.
  - Directly affected tests, product/architecture knowledge, and Rush change
    files.
- Non-goals:
  - Persisted Team or Agent identity schema changes.
  - `team.history`, whose filtered recovery rows have pagination-only fields
    and remain a distinct search result.
  - Changing creation idempotency, Team lifecycle, routing, or dissolve behavior.
- Constraints and invariants:
  - No `team.status` call may be added after automatic provisioning's
    `team.create`; the create result already carries the canonical summary.
  - `TEAM_NOT_FOUND` remains an error. A closed Team is a normal summary.
  - The canonical projection must be constructible from the accepted Team
    record and its owned Agent stores without materializing a closed Team or
    starting a runtime.
  - The change deletes superseded projections and conversions; it must not add
    optional-field compatibility wrappers.

## Acceptance criteria

- `team.create`, every item from `team.list`, and `team.status` conform to one
  `TeamSummary` type and one field meaning for `status`.
- The old nested `team`/`leader` status shape, compact `TeamListRow`, public
  create receipt status, and internal create-only result are removed.
- Automatic Feishu provisioning renders the runtime id and cwd from the create
  summary without a follow-up status read.
- Manual Feishu binding renders the same facts from the status summary.
- A replay of a closed Team returns `status: closed`; an unknown Team still
  raises `TEAM_NOT_FOUND`.
- `team.history` behavior and persisted state remain unchanged.
- Build, lint, unit tests, test typechecking, task validation, knowledge checks,
  and diff checks pass.

## Decisions and unknowns

- Confirmed operator decisions:
  - "反正状态都是一样的。你不能给他们合并成一个 interface 吗？不管是
    status、list、还是 createResult"
  - Redundant status calls and result fields must be removed under the
    repository's entropy-reduction rule rather than retained as glue.
  - "OK，照着这个方式去改。你顺便扫一下，还有没有其他类似的模式"
    The same-pattern audit covers duplicate create/list/status entity shapes,
    overloaded result fields, and follow-up reads used only to repair a narrow
    result. Findings sharing this task's root cause are in scope; independent
    product changes are evidence-only follow-ups.
- Superseded decision: the earlier `team.list` compact projection and
  status-only workspace detail were appropriate while the operations were
  intentionally distinct. The operator's new request explicitly unifies list,
  status, and create, so list now carries the same canonical fields. History
  remains compact because it was not included in the new ruling.
- Assumptions: A successful fresh-request `team.create` with a prompt submitted
  that prompt; all failure paths still throw before a result exists.
- Blocking unknowns: None.
