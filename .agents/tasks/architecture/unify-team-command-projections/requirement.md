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
- Desired outcome: `team.create` and `team.status` expose one flat canonical
  `TeamSummary` interface; `team.list` keeps a compact row whose fields use the
  same names and meanings.
- Desired behavior:
  - Every one of the three operations uses the same field names and meanings;
    list carries the subset a scan needs.
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

- `team.create` and `team.status` conform to one `TeamSummary` type; each
  `team.list` item conforms to `TeamListRow`, an explicit interface (not an
  `Omit`/`Pick` derivation) whose fields are a same-named, same-meaning subset;
  `status` has one meaning on all three.
- The old nested `team`/`leader` status shape, public create receipt status,
  and internal create-only result are removed.
- The three output schemas are open objects, as every other entity DTO's.
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
- Standing decision kept: the earlier ruling that `team.list` stays compact
  ([refine-model-facing-surfaces final solution](/.agents/tasks/mcp/refine-model-facing-surfaces/technical-design/final.md):
  "`list` and `history` stay compact") is not overturned. The 2026-09-07
  request unifies the vocabulary — one `status` meaning, one set of field
  names, no third create shape — and does not say that list returns every
  field. The first push of PR #390 (9e66edd) read it as "list returns the full
  summary"; the operator's review below reversed that.
- Operator review of PR #390 (2026-09-09, verbatim):
  - On the closed (`additionalProperties: false`) output schemas, after the
    reviewer explained what "closed" means: "改回开放的。我感觉这只是一个小问题。大问题是TeamSummary有多少个场景是通过MCP吐回给模型的？假设啊，就是好几个MCP都返回同一个类型，并且是全量返回的话，模型去调用Status和List都拿到这个对象，那上下文会比较冗余"
  - On the shape relationship between the projections:
    "其实从软件工程的设计哲学来说，继承是没有问题的、但是他之前的写法是继承了一个Omit。这种就很奇怪了 所以我理解他应该有一个类似于Team Info Base。然后Status和List来扩充这个信息"
    then, qualifying it: "我只是打个比方啊，再简单来说，List和Status有两个单独的Interface。其实也是合理的"
  - On what the original challenge was: "我最初挑战的就是他在前几个commit里面那个Omit的继承"
  - Note on the original challenge: it was raised against an `Omit`-derived
    Team projection in early commits of the PR branch. Those commits were
    squashed into 9e66edd by a force-push; neither the operator's wording at
    the time nor the code it addressed is preserved anywhere, and this record
    does not reconstruct either. The sentence above is the operator's own
    later restatement.
  - Implementation reading (an inference, confirmed by the operator's
    instruction to fix the PR this way: "那你给修一修吧"): the output schemas go
    back to open objects; `team.create` and `team.status` share `TeamSummary`;
    `team.list` goes back to a compact row with the same field names and
    meanings; the two are separate explicit interfaces, neither derived from
    the other; the "Team Info Base" idea is the operator's analogy, not a
    ruling to introduce a base type.
  - History remains compact because no ruling included it.
- Assumptions: A successful fresh-request `team.create` with a prompt submitted
  that prompt; all failure paths still throw before a result exists.
- Blocking unknowns: None.
