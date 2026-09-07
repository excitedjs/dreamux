# Independent review — Seed-runtime seat

Reviewed: `technical-design/draft.md` (2026-09-07, TeamLeader).
Authority: `../requirement.md`, the operator's two rulings quoted there
verbatim.
Baseline: working tree on `dreamux/unify-team-projections` at `fffc3bd3`
(`next`). No code exists yet; §7 is reviewed as a plan.

Method: read the requirement and draft in full; read every source file the
draft names and every consumer of the three projections it unifies
(`team-collection/{types,commands,mcp-delegate,read-model,runtime-registry,
index,create-request}.ts`, `team-service/{index,team-view}.ts`,
`agent-entity/{types,read-helpers}.ts`, `dispatcher-service/index.ts`,
`dispatchers/commands.ts`, `teammate-collection/commands.ts`,
`workflow-service/{commands,types,index}.ts`, `scheduler/commands.ts`,
`channel-service/commands.ts`, `feishu-channel/src/{feishu-provisioning,
feishu-session-bindings}.ts`); grepped the full Command inventory and every
test referencing the deleted types. I did not run the suites.

## Verdict

The core design is sound and is the right shape: one flat, record-owned
`TeamSummary`, one pure projector, idempotency kept input-side, no wrapper,
no compatibility branch. Field selection survives the four-questions test
(see Verified clean). Four findings need reconciliation before the final
solution; F1 is a user-visible behavior change the draft must make knowingly,
F2–F4 are completeness gaps in the draft's own plan.

## Findings (ordered by outcome impact)

### F1 — The manual-binding guard changes meaning; the draft must say what it becomes

Evidence: `feishu-session-bindings.ts:74-94` does not merely "consume the
same fields" (draft §4). It enforces a refusal — "Team X has no complete
TeamLeader runtime context" — that requires `answer.leader` to be a non-null
object with a non-empty `leader.repo.path`, alongside the `team.status`
nested-object checks and the closed-Team refusal. In the flat summary there
is no `leader` object and no `leader.repo`; `runtime_cwd` is record-owned and
present by construction, as are `team_name` / `leader_name` /
`leader_agent_runtime`. The guard as written cannot survive, and the draft is
silent on its replacement.

The two options are not equivalent, and one is a user-visible behavior
change:

- (a) Drop the leader-readability requirement; bind any open Team. An open
  Team whose leader identity is missing — reachable only in the
  hard-process-loss window of creation (record published, leader identity not
  yet durable; the Team is `starting`) — self-heals on first inbound through
  the ordinary rebuild path (`TeamService.rebuild` creates the leader). Binds
  that previously failed with "no complete TeamLeader runtime context" would
  succeed.
- (b) Re-anchor the guard to `leader_state !== null`, preserving today's
  refusal for that window.

The draft's "consumes the exact same fields" is wrong twice: the fields move
(`leader.repo.path` → `runtime_cwd`), and the guard's failure mode changes.
Per "Change anything — knowingly", the final solution must enumerate this
behavior change and pick (a) or (b). My recommendation is (a): the guard's
original question — can this Team answer? — is already answered "yes" for any
open Team by lazy rebuild, and a refusal for a state that self-heals on the
first routed message is exactly the kind of narrow-result repair this task is
removing. But it is the operator's call, because it is user-visible.

### F2 — §7 misses the two tests that pin the old contract by name

Evidence:

1. `packages/dreamux-types/tests/team-teammate-contract.test.ts:140-144`
   asserts `TeamCreateResult['status']` is exactly
   `'created' | 'existing' | 'closed'` — a type-level lock on the type this
   task deletes.
2. `packages/dreamux/tests/package-boundary-guards.test.ts:419` pins the
   `@excitedjs/dreamux-types` export-name set, which includes
   `'TeamCreateResult'`. Removing that export and adding `TeamSummary` /
   `TeamStatus` breaks the guard unless it is updated in the same change.

§7 lists projection, parity, and Feishu tests and the Rush gates, but names
neither. Per the repo's load-bearing-test rule, the `TeamCreateResult`
assertion must be deleted (not bent) and its deletion reviewed as a contract
change; the boundary guard's name set must be updated knowingly. Add both
files to §7 explicitly.

### F3 — §6's knowledge-update list misses `.agents/domains/channel.md`

Evidence:

- `channel.md:491-503` documents the manual bind's `team.status` pre-check in
  the old shape: "a closed Team is a successful status response whose
  `team.status` is `closed`" — referring to the nested `team.status` field.
  After this change the closed check reads the top-level lifecycle `status`,
  and the "no complete TeamLeader runtime context" guard changes per F1. The
  paragraph becomes misleading on delivery day.
- `channel.md:553` documents the no-follow-up-read invariant in terms of the
  create receipt: "The `team.create` receipt carries the created Team's
  leader name, configured runtime ID, and runtime cwd, so the Channel can
  render the route card without an immediate `team.status` round trip." The
  invariant survives; the receipt it names is now the canonical summary.

§6 names only the product catalog and `dispatcher-orchestration.md`. Add
`channel.md`. (The R35 reference at `dispatcher-orchestration.md:298` —
`worktree_mode` / `worktree_cleanup_mode` read from `team.status` — stays
valid because the draft preserves those field names; that doc needs only the
canonical-contract statement §6 already plans.)

### F4 — "Direct internal creation" has no production caller; delete it knowingly, don't rewire it

Evidence: `TeamCollection.create()` (`team-collection/index.ts:218-226`) is
the only "direct internal creation" entry §3 preserves ("Both direct internal
creation and request-based creation finish by asking that service for the
same summary"). It has zero production callers: `DispatcherService.createTeam`
goes through `createFromRequest`, and a grep for every `.create(` on a Team
collection finds only its own definition. Its sole caller is
`tests/team-collection-read-path.test.ts:193`, which uses it as setup to
exercise the shared create/open construction — behavior that lives in
`runtime-registry.create`/`get` and is equally reachable through
`createFromRequest` with a fixed request id. The internal `TeamCreateResult`
type (`types.ts:328-333`) exists only to serve this method.

Preserving an uncalled method that returns the new summary keeps a path with
no consumer — the entropy this task exists to remove. The final solution
should delete `TeamCollection.create()` and the internal `TeamCreateResult`,
route that one test through `createFromRequest` (or seed the record
directly), and let `TeamRuntimeRegistry.create()` return the `TeamService`
(keeping its `null` = candidate-taken protocol) as the single creation
producer. If the operator wants the exact-name entry kept as internal API,
the draft must name its caller — there is none today.

### F5 — Pin the closed `TeamSummary` schema on all three model-facing tools

Evidence: the MCP `list` output schema is `{ teams: arrayOf(OPEN_OBJECT) }`
and `status` is `{ team: OPEN_OBJECT, leader: object|null, member_count }`
(`mcp-delegate.ts:386,404-411`); only `create` carries a closed schema today.
§4 says the list description "no longer calls the rows compact" but is silent
on the output schemas. This task is the moment to give the model the
canonical shape in the catalog itself: a closed `TeamSummary` output schema on
`create`, on `status`, and on each `list` item costs nothing and is the
consumer-ergonomics payoff of unification — the model sees one shape instead
of three open blobs. Recommendation, not a blocker: if the draft keeps open
schemas, it should say why.

## Verified clean

- **Field selection passes the four-questions test.** Every current
  `team.status` fact survives. The dropped `leader.repo.*` fields are
  promoted, not lost: `leader.repo.{mode,source_repo,branch,base_ref,cleanup,
  cleanup_state}` become the record-owned `worktree_*` fields (the leader
  identity is created from the Team's own workspace, so they are the same
  facts at the authoritative owner), and `leader.name` /
  `leader.agent_runtime` duplicate `leader_name` / `leader_agent_runtime`.
  `intent` and `leader_intent` are both honest: the Team record's `intent` is
  written once at creation and never updated (`store.update` accepts an
  `intent` patch no caller passes), while the leader identity's intent is
  replaced by `team.submit` / Team MCP `send` (`teammate-service/index.ts:296-
  297`) — they can diverge, so neither is derivable from the other.
- **The reminder simplification is correct.** The Team MCP create entry mints
  `randomUUID()` per call (`mcp-delegate.ts:136`), so a successful call is
  always a fresh creation and `result.status === 'created'` is tautological
  on that path; the reminder condition reduces to prompt presence exactly as
  §4 says. Independently, `'existing'` has no consumer anywhere: Feishu
  provisioning branches only on `'closed'` (`feishu-provisioning.ts:147`),
  and no other caller reads the outcome vocabulary.
- **The replay path needs no materialization.** `createFromRequest`'s replay
  branch (`team-collection/index.ts:144-150`) already answers from the record
  alone; pointing it at `reads.summary(accepted)` adds a leader-identity read
  and a member-count directory scan per replay (bounded; Feishu redelivery is
  the only replay caller) and starts no runtime. State that cost once in §3.
- **Same-pattern audit: I concur, having re-run it over the full Command
  inventory.** The complete surface is team / teammate / workflow / channel /
  dispatcher / scheduler.cron. TeamMate `list` and `status` already share
  `AgentEntityRuntimeStatus`; `spawn`/`submit`/`close` wrap it only to add
  their real operation result. Workflow `status` and `list().runs` share
  `WorkflowRunRecord` (through the `workflowRunResult` projector); `run`
  returns `{run_id}` and `stop` returns `{run_id, status}` where `status` is
  the run's lifecycle status — the same vocabulary as the record, not an
  operation-outcome overload. Channel has list only. `dispatcher.list`
  (host-level `DispatcherSummary` rows) and `dispatcher.status` (the calling
  dispatcher's runtime session/error) answer different questions and have no
  create verb. `scheduler.cron` create/update/list all return `cronJobResult`
  and there is no `cron.status`, so it falls outside the audit's own smell
  set (a create/list/status triple) — worth one sentence in §5 so the next
  reader doesn't re-audit it.
- **The `leader_state` vocabulary already exists in the types package.**
  `TeammateStatus` (`dreamux-types/src/teammate.ts:29`) is exactly
  `'starting' | 'running' | 'degraded' | 'stopped' | 'closed'`, identical to
  core's `AgentEntityIdentityStatus`; the draft should name it as the field's
  type rather than re-declaring the union.
- **Closed-Team `worktree_cleanup` becomes more correct, not less.** Today a
  closed Team's `team.status` can report the leader identity's stale
  `repo.cleanup_state` (`managed-active`) after the Team record's own
  `cleanup_state` has settled to `deleted`/`kept`; taking workspace facts
  from the record fixes that as a side effect. No consumer reads the stale
  value today (manual bind refuses closed Teams outright), so no behavior
  depends on it.
- **`team.history` is correctly untouched.** Its row carries
  `close_note_preview` and pagination-only fields and is a search result, not
  a read projection — the non-goal holds.
- **Ownership of the new contract is right.** `@excitedjs/dreamux-types`
  already owns the Channel-to-Core `team.create` contract
  (`team.ts:53-73`); declaring `TeamStatus` / `TeamSummary` there lets Core
  import rather than parallel-maintain, and Feishu consumes the same
  declaration. No provider-specific concept crosses the seam.

## Could not verify

- The suites. No code exists yet; §7's gate list is complete as a plan once
  F2's two files are added (including `typecheck:tests`, which is load-bearing
  here because the deleted types are referenced from test files esbuild
  erases).
- Whether a closed output schema on the model-facing tools changes model
  behavior (F5). The shape is in the catalog either way; the effect is
  empirical and the acceptance plan should include a live probe of the three
  tools' advertised output schemas.
