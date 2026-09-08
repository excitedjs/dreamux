# Verification

## Implementation review

The complete workspace diff was checked against the approved requirement and
final technical solution. As first pushed (9e66edd), the implementation had one
public `TeamSummary`, one pure projector, one TeamCollection live/store
source-selection rule, and one closed schema reused by create, list, and status
on both Command and MCP surfaces. The old create/list/view DTOs, conversions,
and exact-name collection creation entry point were absent. The operator's PR
review (below) reversed the closed schemas and the full-summary list rows. Persisted Team and Agent records and
`team.history` remain unchanged.

The Feishu consumers use the flat summary directly. Automatic provisioning
makes no status repair call; manual binding makes one status call and rejects a
closed Team or a null `leader_state`. The compact Card 2.0 correction changes
only the three approved route notifications and preserves their copy and
semantics.

The independent workflow was stopped after its broad 57-file finder stage took
too long. Its completed Seed and Claude finders still produced concrete
candidates, which the TeamLeader verified against the current source before any
correction was dispatched. The unfinished line, cross-file, and requirement
finders are recorded as residual coverage rather than represented as completed.

| Finding | Verdict | Reason | Operator-ruling conflict |
| --- | --- | --- | --- |
| A cached Team can lose its leader identity and make `team.list` fail through the live projection (as first pushed; list no longer consults a live service). | Reject | A Team enters the cache only after create/rebuild has installed `leader_`; creation is hidden behind the construction join until then. Host stop preserves that object, and dissolve clears it only while a readable, aligned closed identity remains until the Team publishes `closed` and is synchronously evicted. The proposed failure cannot be reached through the current owners. | None |
| The legacy-leader fail-loud assertion for the list surface was deleted with `TeamCollectionReadModel.list()` and not migrated to `TeamCollection.list()`. | Accept | The production behavior still fails loudly today, but the public list-path regression pin was removed while its test title still claims list coverage. | None |
| Current service guidance still names the deleted `team-view.ts`. | Accept | `packages/dreamux/src/service/CLAUDE.md` and `.agents/domains/service-topology.md` are current-state owners and must point at `team-summary.ts`. | None |
| The Dreamux and Dreamux Types Rush notes describe breaking command/type shape changes as ordinary minors. | Accept | Both packages are on the 0.x line and the root release rule requires a `BREAKING:` note with a `Review:` action and an explicit no-rebuild statement for this same-state-shape contract change. | None |
| `TeamServiceCreateOutput.leaderResult` remains after its last production consumer was removed. | Accept | Only two tests read it. Keeping a production result field solely for those assertions violates the approved projection cleanup and the operator's standing instruction to remove redundant chains without another approval round. | None; applies the operator's entropy-reduction ruling. |
| `leader_state === null` does not also reject an absent field in Feishu manual bind. | Reject | Every real producer crosses the closed Core command schema, where `leader_state` is required. An omitted-field producer would have to be fabricated outside the current command contract. | None |
| Automatic provisioning should remove its empty-Team-name guard. | Reject | The guard predates this diff and removing it is outside the approved projection/card correction; it is not a regression introduced here. | None |
| `team.list` needs a new dispatcher admission fence now that it can consult cached Team services. | Reject | A cached service already owns its leader object and the projection only reads `status()` plus directory occupancy. Host stop preserves both durable identity and the service object; the claimed rematerialization does not occur in the normal shutdown path. | None |
| The internal and public leader-state enums could diverge in a future change. | Reject | No current value crosses the schema incorrectly. This is future hardening without a reachable present producer. | None |
| A failed `stopForHost()` can leave a half-stopped cached service that later breaks projection. | Reject | This requires a runtime-stop failure, a later read during failed shutdown, and a specific surviving inconsistent state; it is the compound defensive scenario the engineering rules exclude. | None |

## TeamLeader pre-review

The TeamLeader independently inspected the final workspace diff after the
developer's last correction. The two earlier blockers are resolved: the change
files inherited from the merged predecessor PR are byte-identical to
`origin/next`, and a real fake `AgentRuntimeProvider` now publishes `ready`
through the leased runtime state sink. That test observes the same non-null
runtime status through create, status, list, and same-process replay, while the
provider submit count remains one (as first pushed; after the operator's
review the list assertion compares the compact row's fields instead).

The pre-review also confirmed that the new public summary removes the old
create/list/view DTO family rather than wrapping it, live and store-only reads
share one source-selection rule, and the Feishu automatic and manual paths keep
their approved zero-status-call and one-status-call behavior respectively.

After adjudication, the original writer completed every accepted correction.
The TeamLeader independently reviewed those edits: the public list surface now
pins fail-loud legacy identity handling through a real `TeamCollection`; the
test-only creation result field and its imports are gone; current-state service
guidance names `team-summary.ts`; and the two 0.x breaking notes now give the
consumer review action and state that persisted data needs no rebuild. No
accepted finding remains unresolved.

## Focused verification

- 109 focused Dreamux tests passed across Team read/create projections, schema
  parity, Command adapters, and MCP parity/failures.
- The affected-package typecheck passed. The later full-repository typecheck
  found an `unknown` SDK descriptor in the new schema-parity test; the test now
  names the descriptor boundary explicitly and the full gate passes.
- The first affected-package Rush test run exposed five stale Team projection
  fixtures. They were corrected and covered by the focused rerun.

## Final gates

- `rush build`: passed; the final TeamLeader rerun found every project current
  in the Rush incremental cache after the earlier full and targeted builds.
- `rush lint`: passed in the final TeamLeader rerun.
- `rush typecheck:tests`: passed in the final TeamLeader rerun.
- `rush test` with `DREAMUX_SKIP_LIVE_CODEX=1`: passed all deterministic
  repository suites. Codex live compatibility was explicitly skipped in this
  run and is not claimed by it.
- `rush test` with the real Codex 0.153.4 enabled: failed only in five external
  live-Codex checks. Fresh continuity, output-schema delivery, and an unbound
  native turn timed out; recent activity returned zero entries; and mid-turn
  Feishu marker injection timed out waiting for its marker. All deterministic
  packages, including Dreamux and Feishu Channel, passed in the same run.
- `.agents/scripts/check.sh`: passed in the final TeamLeader rerun (`187` files
  reachable from `root.md`).
- `rush change --verify --target-branch origin/next --no-fetch`: exited zero
  on the committed branch; the three required change files are present for
  `@excitedjs/dreamux-types`, `@excitedjs/dreamux`, and
  `@excitedjs/feishu-channel`.
- `git diff --check`: passed in the final TeamLeader rerun.

## PR #390 review adjudication (2026-09-09)

The operator reviewed the open PR with a Claude reviewer. The operator's words
are in the requirement; the findings and their outcomes:

| Finding | Verdict | Reason | Operator-ruling conflict |
| --- | --- | --- | --- |
| The three output schemas were closed (`additionalProperties: false`) with hand-listed enums, reversing the recorded `OPEN_OBJECT` rationale without naming it. | Accept | Operator ruling "改回开放的". Schemas are open again; `summary-schema.ts` and its test are deleted. | Resolved by the ruling. |
| Every `team.list` row returned the full 22-field summary, so a model calling list and status receives the same object twice. | Accept | Operator ruling on context redundancy; the 2026-09-06 "list stays compact" decision was stretched, not overturned. `TeamListRow` is back as an explicit interface with the summary's names and meanings. | Resolved by the ruling. |
| `TeamService.status(record)` let a caller substitute a foreign record for the service's own. | Accept | Its one caller was replay against a record closed behind the cached service's back. `TeamCollection` now answers a closed record from the read model before consulting the cache; the parameter is gone. | None |
| The `member_count` meaning changed on the live path (readable identities to directory occupancy) without a `Review:` clause. | Accept | Named in the Dreamux change note. | None |
| `Closes #383` linked the PR to an issue this change does not close. | Accept | Now `Refs #383`. | None |
| The manual bind failure text ("no complete TeamLeader runtime context") did not name what the guard checks. | Accept | Message names the unreadable TeamLeader identity; condition unchanged. | None |
| `TeamStateEvent.status` restated the lifecycle literal instead of `TeamStatus`. | Accept | Uses `TeamStatus`. | None |
| Task records said "implemented" / "uncommitted" / "supersedes the compact list decision" while the PR was open and the ruling stood. | Accept | Records corrected; the operator's original `Omit` challenge is recorded as unrecoverable rather than reconstructed. | None |
| The Card 2.0 layout correction is bundled with the projection change. | Note | Approved for the same PR in the development-approval boundary; left in place. | None |

## Post-review gates

- Focused Dreamux suites (Team read path, create idempotency, legacy state,
  MCP public failures, Command adapters) and the Feishu session-binding suite
  passed after the fix.
- `rush build`, `rush lint`, `rush typecheck:tests`, and `rush test` with
  `DREAMUX_SKIP_LIVE_CODEX=1` passed on the fix commit; live Codex is not
  claimed by that run. Task validation, `.agents/scripts/check.sh` (`190`
  files reachable from `root.md`), and `git diff --check` passed.
  `rush change --verify --target-branch origin/next --no-fetch` was run on
  the committed branch.

## Residual review coverage

The independent workflow's line-scan, cross-file, and requirement-fidelity
finders were stopped before returning results after the 57-file run exceeded
the review time budget. This is residual review coverage, not a claim that those
seats completed. The completed removed-behavior, language, adapter, and cleanup
finders produced the candidates adjudicated above; the TeamLeader then reviewed
the complete diff against the approved requirement and solution and reran every
repository gate.
