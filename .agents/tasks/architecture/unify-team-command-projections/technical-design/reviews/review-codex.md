# Independent solution review

Verdict: **NEEDS REVISION**. One flat `TeamSummary` is feasible without a
follow-up Core command or compatibility fields. The proposed projector does
not yet make its inputs canonical: list/replay discard available runtime
state, and live/store paths count different things. Resolve findings 1 and 2
before treating create/list/status as interchangeable summaries. Finding 3
corrects the audit record; it does not authorize unrelated implementation.

Reviewed source: `fffc3bd337f8ce28070fb8658fc30893e71730bb`.

- Requirement SHA-256:
  `40ed7f03123c276f7776fedd2a3c0ba9f804b77522bb651be7b0416b13e0f70d`
- Draft SHA-256:
  `c125234a185bb08e0ff3ba78bf70ec9d880996c1436f5fa7827d33abdfa1ca3e`
- Review basis: the recorded requirement, current source and relevant history,
  and `.agents/skills/engineering-whitepaper/SKILL.md`. No product code or
  other task document was changed.

## Findings

### 1. P2 — List and accepted-request replay would hide a running leader

**Draft:** `technical-design/draft.md:37-40,51-61` gives list and replay the
store-only summary, while fresh creation and live status use the live leader.
Calling the same pure projector does not reconcile those different inputs.

**Evidence:**

- `packages/dreamux/src/service/team-collection/read-model.ts:77-82` explicitly
  constructs the leader status with `toStatus(leader, null)`.
- `packages/dreamux/src/service/team-collection/index.ts:295-298` currently
  chooses an already-held service for status; its comment at lines 289-293
  explains that this preserves the available runtime state without building an
  entity.
- `packages/dreamux/src/service/teammate-service/index.ts:430-436` includes the
  runtime owner's current status. It is not stored in the Agent identity;
  `packages/dreamux/src/service/agent-entity/read-helpers.ts:23-45` receives it
  separately.
- The existing lookup `TeamRuntimeRegistry.live()` is only a cache read
  (`packages/dreamux/src/service/team-collection/runtime-registry.ts:211-212`).

**Trigger and consequence:** Create with a prompt, keep that submitted turn
active, then list the Team or replay its accepted request in the same process.
The draft returns `leader_runtime_status: null` through those two operations,
even while `team.status` returns the available runtime status. No race or
failure is needed. The field would mean either "no current runtime state" or
"this operation deliberately did not consult it." That is fake absence in a
contract advertised as the same current summary.

**Smallest correction:** Keep live-versus-record selection in `TeamCollection`,
which already owns both the registry and the read model. Apply that selection
to status, list items, and accepted replays. Pass the already-read Team record
from list/accepted-request discovery into this selection instead of calling
the public status command or rereading the record by name. Fresh creation can
use the service it just obtained. Keep the store-only projector for Teams
without a held service; do not add a registry callback to the store read model,
materialize a Team, persist runtime status, or invent a provenance field.

This follows the live/store ownership established by commit `2ed5f5ea`
(YourWildDad, PR #350), whose TeamCollection change introduced this selection.
The new requirement extends that rule to the unified list/create surfaces.
The analogous TeamMate list/status implementation already follows it
(`packages/dreamux/src/service/teammate-collection/index.ts:263-272`).

**Verification:** Use one real collection with an admitted, held-open leader
turn. Compare fresh create, status, list, and replay while that state is stable;
assert that replay does not submit again. Separately cover promptless creation
and a collection without a live service, where runtime `null` is legitimate.
A shared fake summary fixture at command boundaries cannot detect this defect.

### 2. P2 — `member_count` still changes meaning with materialization

**Draft:** `technical-design/draft.md:51-57` retains the existing live member
count and the read model's count without choosing one membership rule.

**Evidence:**

- Store summaries count occupied member directories using `names().length`
  (`packages/dreamux/src/service/team-collection/read-model.ts:154-162`). The
  source explicitly says an unreadable member still counts.
- Live summaries use `TeamService.memberCount()` -> `members()` ->
  `TeammateCollection.list()`
  (`packages/dreamux/src/service/team-service/index.ts:617-622`).
- That list uses readable, scope-aligned identities
  (`packages/dreamux/src/service/teammate-collection/index.ts:263-267,636-654`).
  `AgentEntityCollectionStore.list()` skips unreadable identities, whereas
  `names()` reports directory occupancy
  (`packages/dreamux/src/service/agent-entity/identity-store.ts:288-304`).

**Trigger and consequence:** A member directory remains after its identity
becomes missing or malformed. The store summary counts it; the live summary
omits it. Consequently the same Team can change its reported member count
solely because a service is materialized or evicted, with no roster change.
Finding 1's source selection alone does not fix this live-versus-unmaterialized
disagreement. It is a pre-existing difference that the canonical contract must
resolve, not a new regression attributed to the draft.

**Smallest correction:** Specify exactly what the count includes, including
closed and unreadable members, and make both paths use that fact. Recommend
the existing directory-occupancy meaning: count member directories, exclude the
leader, and do not parse every member identity merely to obtain a count.
Use the existing Agent collection store authority through its owning
collection; no new count cache or persisted aggregate is needed. This also
avoids turning the expanded create result into a full member-status scan.

The occupancy rule was introduced in `read-model.ts` by `2ed5f5ea`
(YourWildDad, PR #350). Choosing readable identities instead is possible, but
would knowingly change the current store/list meaning and require documenting
that choice. Leave `team.history` behavior unchanged as the requirement states.

**Verification:** Keep identical member directories across live and store-only
reads, with one closed member and one missing/malformed identity. Assert equal
counts and exclusion of the leader. Pin the chosen rule rather than merely
changing old shape assertions.

### 3. P3 — The same-pattern audit overstates its exclusion evidence

**Draft:** `technical-design/draft.md:86-95` says TeamMate create/send/close
wrappers and Workflow run/stop receipts add real operation-specific facts.

**Evidence:** TeamMate spawn/send do carry submission facts, but
`AgentEntityCloseResult` contains only `teammate`
(`packages/dreamux/src/service/agent-entity/types.ts:165-175`).
`WorkflowRunAccepted` contains only `run_id`, and `WorkflowStopResult` contains
`run_id` and the same `WorkflowRunStatus` used in the full record
(`packages/dreamux/src/service/workflow-service/types.ts:34-41,60-75`).
The service returns precisely those projections
(`packages/dreamux/src/service/workflow-service/index.ts:185-186,203-211`).

**Consequence and smallest correction:** These may have valid asynchronous
operation reasons, but "extra operation facts" is not demonstrated for these
specific results. Correct the audit to record them as candidate subset/wrapper
patterns, distinguish spawn/send's actual admission facts, and state a concrete
consumer or timing reason for retaining each excluded surface. Otherwise record
an evidence-only follow-up under the requirement's scope rule. Do not expand
this Team change merely for symmetry. This is an audit accuracy finding, not a
claim that those other commands currently malfunction.

## Ownership and contract conclusions

The following parts of the draft are supported:

- `dreamux-types` is the appropriate declaration boundary: it already exports
  the Team create contract consumed by Core and Feishu
  (`packages/dreamux-types/src/team.ts:53-73`). Keep the implementation projector
  in Core and Channel rendering in Feishu.
- The Team record can always supply the accepted leader name, configured runtime
  ID, cwd, and workspace identity independently of a leader identity
  (`packages/dreamux/src/service/team-collection/types.ts:93-124`). These should
  be required fields, not optional properties or caller-specific fallbacks.
- Nullable leader facts have real scenarios: interrupted creation can commit
  the Team record before its leader identity exists
  (`packages/dreamux/src/service/team-service/index.ts:232-277`); promptless
  creation starts no runtime; closed records remain readable. Use nullable
  values for these cases, not absence caused by choosing the wrong reader.
  Preserve the store's distinction between an absent/malformed identity and
  legacy-state or I/O errors (`identity-store.ts:128-159`).
- The MCP reminder can use the input prompt after success. MCP generates a
  fresh request ID (`team-collection/mcp-delegate.ts:132-136`), and initial
  submission outcomes other than `submitted` throw before creation succeeds
  (`team-service/index.ts:279-305`). No replacement `created` flag is warranted.
- At this source baseline, automatic Feishu provisioning already consumes
  runtime ID and cwd directly from the create result, with no status call
  (`packages/channel/feishu-channel/src/feishu-provisioning.ts:145-181`). Manual
  binding reads status before writing the route
  (`packages/channel/feishu-channel/src/feishu-session-bindings.ts:74-95`).
  Preserve those call counts and migrate manual binding to the required flat
  fields. Do not retain the old nested-parser compatibility path.

The simpler complete design is the proposed shared projection plus one
collection-owned source-selection rule and one membership-count rule. It needs
no new service, registry, durable state, runtime startup, or follow-up command.
Necessary owner-store reads to produce current member facts are distinct from a
redundant command round trip; the design should state that boundary explicitly.

## Verification and limits

The draft's four Rush gates and knowledge/change checks are appropriate once an
implementation exists. Add the source-backed cases above to its parity plan,
along with closed accepted replay, unknown Team, missing leader identity, and
unchanged history. For Feishu, assert that route publication and notification
remain downstream of the one successful create/manual-status result and that
both cards use its exact stable fields.

Review performed: read-only source, caller, contract, test, and history tracing.
No build, lint, unit test, runtime, or live Feishu gate was run. This verdict is
a solution review, not implementation verification. The two semantic findings
can be resolved within the clarified requirement. The recommended corrections
need no new product decision and add neither compatibility machinery nor
persisted state.
