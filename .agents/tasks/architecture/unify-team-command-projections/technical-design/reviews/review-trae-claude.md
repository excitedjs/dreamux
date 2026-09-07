# Independent solution review — Trae/Claude seat

Verdict: **NEEDS REVISION**. The chosen shape is right — one flat, record-owned
`TeamSummary`, one pure projector, idempotency kept input-side, no wrapper and
no compatibility branch — and it can be built with no new Core command, no
durable state, and no runtime startup. But two of the draft's own claims are not
true of the current source, and the design leaves one consumer-less mechanism
standing. The blocking issues are contract-semantic, not stylistic: as written,
the "one summary" would carry a field whose meaning silently changes with the
operation that produced it, which is the exact defect the requirement forbids
("Every one of the three operations uses the same field names and meanings").
Resolve F1–F3 before treating create/list/status as interchangeable. F4 is an
audit-accuracy correction; F5 removes entropy the task exists to remove.

Reviewed source: `fffc3bd337f8ce28070fb8658fc30893e71730bb` (working tree on
`dreamux/unify-team-projections`). No code exists yet; §7 is reviewed as a plan.

- Requirement SHA-256:
  `40ed7f03123c276f7776fedd2a3c0ba9f804b77522bb651be7b0416b13e0f70d`
- Draft SHA-256:
  `c125234a185bb08e0ff3ba78bf70ec9d880996c1436f5fa7827d33abdfa1ca3e`
- Basis: the recorded (frozen) requirement, current source and its consumers,
  and `.agents/skills/engineering-whitepaper/SKILL.md`. I traced the three
  projections and every consumer; I did not run build/lint/test and this is a
  solution review, not implementation verification. I reviewed the frozen draft
  only and disregarded any later `final.md` ruling, as instructed.

## Findings (ordered by outcome impact)

### F1 — P1, contract semantics: `list` and accepted-request replay would report `leader_runtime_status: null` while `status` reports the live value

**Draft:** §3 (`technical-design/draft.md:49-64`) has `list()` and the accepted
request replay call the store-only read model, while fresh creation and
`team.status` use the live TeamLeader status. Calling one pure projector does
not reconcile those different inputs — the projector is only as canonical as
what is passed to it.

**Evidence (independently confirmed):**

- The store-only projection hard-codes the runtime status to `null`:
  `packages/dreamux/src/service/team-collection/read-model.ts:77-82` builds the
  leader with `toStatus(leader, null)`, and `read-helpers.ts:23-48` shows
  `runtime_status` is exactly that separate argument.
- `team.status` does **not** take that path: `TeamCollection.summary()`
  (`packages/dreamux/src/service/team-collection/index.ts:295-298`) returns
  `live.status()` when the process holds the service, and only falls back to
  `reads.summary(record)` otherwise. `TeamService.status()`
  (`team-service/index.ts:418-424`) carries the live runtime status through
  `leaderService().status()`.
- `team.list` always uses the store-only path:
  `DispatcherService.listTeams()` → `teams.list()`
  (`dispatcher-service/index.ts:516-518`, `team-collection/index.ts:240-242`) →
  `reads.list()` → `listRow()`. The draft replaces `listRow()` with `summary()`,
  which still passes `null`.
- The accepted-request replay answers from the record alone:
  `createFromRequest` (`team-collection/index.ts:144-150`) returns from
  `accepted`, and the draft points it at the record-only read model (§3
  `draft.md:60-61`).
- `TeamRuntimeRegistry.live()` is a cache read only
  (`runtime-registry.ts:210-213`), so a "live" input is available exactly where
  `team.status` already uses it.

**Concrete trigger and wrong outcome:** In one dispatcher process, call
`team.create` with a prompt for Team `alpha` and keep that first turn running
(runtime materialized, cached). Then call `team.list`, or replay the same
`team.create` request id. The draft returns `leader_runtime_status: null` for
`alpha` through both operations, while `team.status alpha` returns the live
`runtime_status` (e.g. `working`). No race or failure is needed. One field name
now means either "the leader has no live runtime state" or "this operation chose
not to consult it" — that is fake absence in a contract the requirement demands
be identical across the three operations
(`requirement.md:34-36,64-66`).

**Smallest correction:** Keep the live-versus-record selection in
`TeamCollection`, which already owns both the registry and the read model, and
apply it to `status`, each `list` item, and the accepted replay. Pass the
already-read `TeamRecord` from list/replay discovery into that selection so no
second `team.status` round trip or re-read by name is added; fresh creation uses
the service it just obtained. Keep the store-only projector for Teams with no
held service, where `runtime_status: null` is the honest answer. This is the
rule `teammate-collection/index.ts:263-273` (`list()`/`status()`) already
follows: `liveEntity(...)?.status() ?? toStatus(identity, null)`. No registry
callback into the store read model, no materialization, no persisted runtime
status, no provenance field.

### F2 — P2, contract semantics: `member_count` still changes meaning with materialization

**Draft:** §3 (`draft.md:51-57`) keeps both the live member count and the read
model's count without choosing one membership rule.

**Evidence (independently confirmed):**

- Store path counts directory occupancy, unreadable members included:
  `read-model.ts:154-162` uses `AgentEntityCollectionStore(...).names()` with the
  explicit comment "an unreadable member still counts."
- Live path counts readable identities:
  `team-service/index.ts:617-622` → `members()` → `TeammateCollection.list()`,
  which is `liveEntity(...)?.status() ?? toStatus(identity, null)` over the
  roster (`teammate-collection/index.ts:263-268`) built from
  `AgentEntityCollectionStore.list()`, which skips identities it cannot read
  (`agent-entity/identity-store.ts` `names()` vs `list()`).

**Concrete trigger and wrong outcome:** A member directory survives after its
identity file becomes missing or malformed. The store summary counts it; the
live summary omits it. The same Team therefore reports, say, `member_count: 3`
from `team.list` and `member_count: 2` from `team.status` in the same instant,
flipping purely on whether a service is materialized or evicted — no roster
change. F1's source selection does not fix this: it selects *which reader*, but
the two readers count different sets.

**Provenance:** This divergence is pre-existing (`names()` vs `list()` predates
this task), so it is not a defect the draft introduces — but the requirement's
"one field meaning" makes resolving it part of *this* contract, not a follow-up.

**Smallest correction:** State exactly what `member_count` includes (closed and
unreadable members, leader excluded) and make both paths use that fact. I
recommend the existing occupancy rule — count member directories through the
owning collection store — because it needs no per-member identity parse and
keeps the expanded create result from turning into a full member-status scan. If
readable-only is chosen instead, that knowingly changes today's store/list
meaning and must be recorded. `team.history` stays untouched per the non-goal.

### F3 — P2, behavior change stated as a no-op: the manual-binding guard cannot "consume the exact same fields"

**Draft:** §4 (`draft.md:75-78`) says manual binding "consumes the exact same
fields from `team.status`" and "retains its one pre-bind existence/lifecycle
read." Both halves of "exact same fields" are inaccurate against the source, and
the guard's failure mode changes.

**Evidence:** `feishu-channel/src/feishu-session-bindings.ts:74-94` reads the
*nested* answer today: `answer['team']` for the closed check and `team_name` /
`leader_name` / `leader_agent_runtime`, and `answer['leader']['repo']['path']`
for the runtime cwd. It then enforces a refusal — "has no complete TeamLeader
runtime context" — that requires `leader` to be a non-null object with a
non-empty `leader.repo.path`. In the flat `TeamSummary` there is no `leader`
object and no `leader.repo`; the cwd becomes the record-owned `runtime_cwd`,
present by construction, and the closed check moves to the top-level lifecycle
`status`.

**Concrete trigger and wrong outcome:** Bind a manual route to Team `beta`
during the hard-process-loss window of creation — record published, leader
identity not yet durable, Team `starting`. Today the guard reads
`leader === null` (or `leader.repo.path` empty) and refuses with "no complete
TeamLeader runtime context." Under the flat summary, `runtime_cwd` is
record-owned and non-empty, so the same bind *succeeds*. The draft presents this
as a field rename ("exact same fields") when it is a user-visible refusal→accept
change. Two honest options exist — (a) drop the leader-readability requirement
and bind any open Team (it self-heals on first inbound via
`TeamService.rebuild`), or (b) re-anchor the guard to a nullable
`leader_state !== null` to preserve today's refusal — and per AGENTS.md "Change
anything — knowingly" the solution must name which it takes; it is user-visible,
so it is the operator's decision. (I concur here with the Seed seat's F1, on
independently traced evidence; the draft's silence is the defect.)

**Smallest correction:** State the field migration
(`leader.repo.path` → `runtime_cwd`, nested closed check → top-level `status`)
and enumerate the guard's new behavior, picking (a) or (b) explicitly. Do not
keep the old nested-object parser as a compatibility path — the requirement
bans optional-field compatibility wrappers (`requirement.md:60-61`).

### F4 — P3, audit accuracy: §5 overstates the exclusion evidence for `close` and Workflow receipts

**Draft:** §5 (`draft.md:88-92`) states TeamMate create/send/close "wrap that
same entity status only to add their real operation-specific result," and that
Workflow `run`/`stop` receipts "carry distinct operation facts."

**Evidence:** Spawn and send do add a submission fact — both extend
`AgentEntitySubmissionResult` (`agent-entity/types.ts:160-171`), carrying
`status: submitted|duplicate|stopped|failed|ambiguous` and `error`. But
`AgentEntityCloseResult` (`agent-entity/types.ts:173-175`) contains **only**
`{ teammate }` — it adds no operation-specific field over the shared entity
status. On the Workflow side, `WorkflowRunAccepted` is `{ run_id }` and
`WorkflowStopResult` is `{ run_id, status }` where `status` is the same
`WorkflowRunStatus` the full record already carries
(`workflow-service/types.ts:33-51,60-75`; produced verbatim at
`workflow-service/index.ts:186,203-211`). Those are subset/wrapper projections,
not "distinct operation facts."

**Consequence and smallest correction:** The audit's *conclusion* (no second
in-scope create/list/status triple to unify) is still correct — none of these is
a create/list/status shape of one entity — but its stated evidence is wrong for
`close` and for the Workflow receipts. Correct §5 to record them as candidate
subset/wrapper patterns, distinguish spawn/send's genuine admission facts, and
either give a concrete consumer/timing reason for each retained receipt or log
an evidence-only follow-up under the requirement's scope rule
(`requirement.md:85-89`). Do not expand this Team change for symmetry; this is
an accuracy fix, not a claim those commands malfunction.

### F5 — P3, unnecessary mechanism: §3 preserves the uncalled `TeamCollection.create()` path

**Draft:** §3 (`draft.md:56-61`) keeps two producers: "Both direct internal
creation and request-based creation finish by asking that service for the same
summary."

**Evidence:** `TeamCollection.create()` (`team-collection/index.ts:218-226`) is
the only "direct internal creation" entry, and it has **zero** production
callers. The single production create path is
`DispatcherService.createTeam` → `teams.createFromRequest`
(`dispatcher-service/index.ts:484`); a repo-wide search for `teams.create(` /
`collection.create(` in `packages/dreamux/src` returns nothing. Its lone caller
is the test at `tests/team-collection-read-path.test.ts:193`. The internal
`TeamCreateResult` type (`team-collection/types.ts:327-333`) exists only to
serve this method and the registry's `create()`
(`runtime-registry.ts:59-84`).

**Consequence and smallest correction:** Reshaping an uncalled method to return
the new summary keeps a second producer alive with no consumer — the entropy
this task is meant to remove, and a mechanism with no named failure scenario
(engineering-whitepaper). Delete `TeamCollection.create()` and the internal
`TeamCreateResult`, route the one test through `createFromRequest` (or seed the
record directly), and let `TeamRuntimeRegistry.create()` remain the single
creation producer (keeping its `null` = candidate-taken protocol). If the
operator wants an exact-name internal entry retained, the draft must name its
caller — there is none today. (Concurs with the Seed seat's F4 on independent
evidence.)

## Verified clean (challenged and found sound)

- **Removing the `created|existing|closed` create discriminator is correct and
  safe for its one consumer.** The only reader of that vocabulary is Feishu
  automatic provisioning, which branches solely on `'closed'`
  (`feishu-provisioning.ts:147`). Under the flat summary that becomes the
  top-level lifecycle `status === 'closed'`: a fresh Team is `starting`
  (proceeds to bind/announce/submit), a replayed still-open Team is
  `running`/`starting` (proceeds, as today's `existing` did), and a replayed
  closed Team is `closed` (unsubmitted, as today). No consumer reads
  `'existing'` anywhere. Requirement satisfied (`requirement.md:26-31,39-41`).
- **The MCP reminder simplification is correct.** The Team MCP create entry
  mints `randomUUID()` per call (`mcp-delegate.ts:132-136`), so a successful MCP
  create is always a fresh creation and `result.status === 'created'`
  (`mcp-delegate.ts:166`) is tautological on that path; reducing the reminder to
  prompt-presence changes nothing. (The Command path takes a caller-supplied
  `request_id` and can replay, but the reminder lives only on the MCP path.)
- **`dreamux-types` is the right declaration boundary.** It already owns the
  Channel-to-Core `team.create` contract (`packages/dreamux-types/src/team.ts:53-73`),
  so declaring `TeamStatus`/`TeamSummary` there lets Core import rather than
  parallel-maintain, and Feishu consumes the same declaration. No
  provider-specific concept crosses the seam.
- **Nullable leader facts have real scenarios**, so they are honest `null`s, not
  the wrong-reader absence of F1: interrupted creation commits the record before
  the leader identity is durable (`team-service/index.ts:232-253`), promptless
  creation starts no runtime, and closed records stay readable.
- **Record-owned stable fields are always constructible** from the accepted
  `TeamRecord` without materializing a closed Team (`team-collection/types.ts:93-144`),
  matching the requirement invariant (`requirement.md:57-59`).

## Minor note (not blocking)

- The proposed flat field set adds always-present `worktree_branch` and
  `worktree_base_ref`. These exist today only inside the nullable
  `leader.repo.{branch,base_ref}` projection (`agent-entity/read-helpers.ts:32-40`),
  and no consumer reads them from a team summary/status/create answer (grep of
  `feishu-channel/src` finds only `space.repo.base_ref` on the *bind input*, never
  on a status/create result). Promoting them to always-present record-owned
  fields is defensible as preserving a current `team.status` fact, but since they
  have no reader, the solution should either confirm they belong at top level or
  drop them — an added field with no consumer is the same "unrequested surface"
  smell as F5, at lower cost.

## Verification additions to §7

The four Rush gates and knowledge/change checks are appropriate. Add, against
source-backed cases:

- One real collection with an admitted, held-open leader turn; assert
  `team.create`, `team.status`, `team.list`, and accepted-request replay return
  the identical `leader_runtime_status` while that state is stable, and that
  replay submits nothing (covers F1). A shared fake summary fixture at the
  command boundary cannot detect this — the inputs must be real.
- Identical member directories across live and store-only reads, with one closed
  and one missing/malformed member; assert equal `member_count` and leader
  exclusion (covers F2). Pin the chosen rule, do not merely edit old assertions.
- Feishu manual bind in the `starting`/leader-not-durable window; assert the
  chosen F3 behavior (refuse vs bind) explicitly.
- `typecheck:tests` is load-bearing here: the deleted `TeamCreateResult`,
  `TeamListRow`, and `TeamView` are referenced from test files that esbuild
  erases at runtime, so only that gate catches a stale type reference. Any test
  that pins the old shapes by name (e.g. a `dreamux-types` export-name guard or a
  `TeamCreateResult['status']` type assertion) must be updated as a knowing
  contract change, not bent to stay green.
