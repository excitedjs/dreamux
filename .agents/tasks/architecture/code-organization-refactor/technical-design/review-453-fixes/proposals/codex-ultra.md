# Review fixes: explicit record lifetime and existing domain owners

Independent first-round proposal, 2026-10-03. Source baseline: the feature
branch after [PR #462](https://github.com/excitedjs/dreamux/pull/462).
The sole requirement is [review-fixes-20261003.md, revision 1](../../../artifacts/review-fixes-20261003.md).
The resulting-tree diagnosis is consultation evidence, not additional authority.
No peer proposal was read. This proposal records a design; it does not claim
implementation, gate execution, or external validation.

## Selected approach and ownership

Keep one serialized Team record owner while anyone can still use it, and stop
retaining fully retired records. Correct the other defects inside their current
owners: the event bus, Claude runtime dependency contract, uninstall operation,
public provider packages, Feishu Access, and Feishu routing/COT. Complete the
parent coverage obligations against current behavior, including real issue #63
evidence. Do not restore historical interfaces merely to revive old fixtures.

Revision 1 records the operator's selection as "退休后读盘 (Recommended)".
This is the only authority used to narrow daemon-lifetime Team memory authority. Other
accepted behavior, including R72, R73, closed-before-cleanup, and owner-close
read fences, stays as recorded. None of these repairs requires a new persisted
field, record version, config rewrite, provider-name exception, or retry system.

| Concern | Authoritative owner | Change and concrete removal |
| --- | --- | --- |
| Team record serialization and lifetime | `team/store.ts`, with lifetime holders in `team/index.ts` and `team/service.ts` | Retire the permanent historical map entries and the assumption that any earlier read initialized a later handle. Add explicit, local retention of real uses. |
| Event production | `DispatcherCoreEventBus` | Delete the frozen forwarding publisher object; implement its existing narrow type directly. |
| Claude dependencies | Provider constructs runtime deps | Delete two impossible omitted-field cases and the runtime's empty-list fallback. |
| Uninstall preview | `onboard/uninstall.ts` | Replace the unconditional root-removal prediction with the remaining-directory calculation. |
| npm provider/plugin entry points | Each public package and the existing builtin plugin catalog | Restore the established provider default and expose the plugin explicitly; remove the requirement to rewrite old provider refs. |
| Pairing commit | `FeishuAccess.recordPairingPrompt` | Stop treating expired entries as current same-sender owners. |
| COT retirement | Channel routing supplies the serving target; COT owns presentation | Remove the assumption that visible topic and serving binding are identical, and uncouple route retirement from notice delivery. |

Paths below are repository-relative. `D` means `packages/dreamux/src`, `F`
means `packages/channel/feishu-channel/src`, and `L` means
`.agents/tasks/architecture/code-organization-refactor/artifacts/deleted-tests.md`.

## 1. Team records: retain uses, not historical existence

### Evidence and boundary history

`D/service/team/store.ts:65-75,174-201` permanently retains every positive
lookup. `TeamCollection.recover`, `recoverWorktreeCleanup`, history, and request
replay all scan that same store; filtering closed rows happens after loading.
Service eviction at `team/index.ts:778-781` does not release its record store.
This grows with ordinary completed history, without requiring a speculative
failure or a memory threshold.

The owning store and bound `TeamRecordHandle` came from
[PR #455](https://github.com/excitedjs/dreamux/pull/455);
[PR #460](https://github.com/excitedjs/dreamux/pull/460) removed only missing-name retention. Retain their serialized
publication and narrow per-Team handle. Supersede permanent retention only
within revision 1's fully retired boundary. R67's service-owned dissolve order
remains: precheck, commit closed, destroy children, then physical cleanup.

There are two important current dependencies:

- `TeamService.rebuild` assumes an earlier collection read loaded the exact
  handle (`team/service.ts:458-462`); cleanup recovery assumes the same
  (`team/index.ts:369-382`). Both assumptions must disappear with history caching.
- `service.closed` follows child destruction, but precedes worktree cleanup
  (`team/service.ts:639-658`). Therefore neither durable `closed` nor service
  eviction is record retirement. `handle.update` also currently resolves the
  store again by id while `current` captures an instance (`store.ts:102-111`);
  that split is invalid once entries can be released.

### Store contract

Reshape the existing Team-only handle acquisition into
`acquire(teamId): Promise<TeamRecordHandle>`. It registers/finds the canonical
entry synchronously before its first await, retains it, loads it, and returns
an initialized handle. `current`, `create`, and `update` all use that captured
entry's `TransactionalStore`; `update` no longer looks up a potentially newer
store by id. Add explicit release and an operation hold on that same handle.
These are internal lifetime operations, not new public Team commands.

One count on the existing entry represents its actual outstanding holders:
construction/service handles, temporary reads, admitted operations that can
still reach the record, and queued writes. Each acquisition has one matching
release; operation holds use `try/finally`. Retention is not admission and adds
no queue or asynchronous fence. Do not introduce separate owner, pending-write,
retiring, and disposed state machines. The existing transactional queue remains
the only write serializer; leave `TransactionalStore` generic and unchanged.

On final release, remove the exact entry only if its committed value is absent,
or is `closed` with no `cleanup-pending` worktree fact. A nonclosed record or a
pending cleanup remains memory-authoritative even if materialization or cleanup
failed and no service currently holds it. This retention is derived from the
existing record, not a second cleanup registry. Check retention and remove
synchronously, without a drain-then-delete window in which another acquisition
could become detached. Every queued operation retains before enqueue and
releases on settlement, so zero holders cannot coexist with queued writes.

`get` becomes acquire/read/release; `list` continues to enumerate and call
`get`. A cold historical read therefore uses at most a temporary store and
does not populate a permanent historical cache. Concurrent reads and a newly
arriving constructor join the same registered entry, including its first load.
No stale disk result is installed over an owner that appeared during the read.
Keep the current invalid-id error and invalid/missing/unreadable-record `null`
policy. Temporary null entries are released; there is no negative cache.

The retained set is bounded by nonclosed Teams, unfinished cleanup, and real
in-flight uses, rather than all completed Team history. Listing still costs
O(history) IO and a temporary result array; this is the accepted disk-read
tradeoff, not a promise of bounded history-query output or constant scan cost.

### Ownership handoff and end-to-end paths

| Path | Required lifetime |
| --- | --- |
| Candidate creation | Acquire before workspace/construction work, within the existing `constructing` ownership. Hold through publication, leader construction, `starting`, initial admission, and publication into `live`. Transfer the successful handle to the service; a losing/failed construction releases in `finally`, after its existing abandonment and checkout handling. |
| Cold rebuild | Acquire first, inspect that handle's loaded record, refuse missing/closed records, then rebuild using that same handle. Release a failed reconstruction; a successful service holds it. Do not seed from an older `list` result. |
| Live service | Hold for the service's record-writing life. Host stop does not close the Team and must not drop this authority or remove it from the second runtime sweep. |
| Already admitted work | Take an operation hold at the existing Team admission point, before invoking/scheduling the operation; release after its complete continuation. In particular, a leader submission can enqueue `running` after an overlapping `closed` write. Preserve the existing Team-before-Dispatcher checks and Promise refusal semantics; add no second admission check. |
| Dissolve | A failed closed write retains the live owner and clears only the existing dissolve fence. After successful close, resolve `service.closed` at its current point, attempt cleanup, then release the service's record hold. Earlier admitted operations and queued writes can outlast that release and retain the same entry. |
| Abandoned creation | Keep the construction hold through the existing closed write, child destruction, and cleanup attempt. Release on every factory/start failure, including failure before first publication. A surviving nonclosed or pending record remains held by its durable fact. |
| Cleanup recovery | Acquire and inspect the current handle before calling `settleTeamWorktreeCleanup`; release in `finally`. Retain across Git IO and the resulting queued update. Keep background startup recovery; do not make slow cleanup block channel startup. |
| History, summary, replay, doctor | Read held authority when present; otherwise load and release a temporary handle. Preserve record-only projection and replay without materializing a service or resubmitting its prompt. |

Do not acquire handles invisibly in `depsBase`: pass the already acquired
handle explicitly so failure and handoff paths are reviewable. A Team operation
hold is kept across its await, not acquired only when its eventual write starts.
This covers child-close failure followed by a late admitted continuation without
assuming that child teardown drained every Team-level continuation. Stale closed
service references remain refused by existing admission; they must not reinsert
an old store or perform writes after their holds have retired.

Keep the per-request queue, concrete-name construction map, publish-inside-update
decision, terminal `closed` merge, and suppression of events for a dropped
status patch (`service.ts:977-990`). Preserve request replay while its valid
record exists. Once fully retired, editing/deleting/damaging that record affects
the next query, replay scan, and name check, exactly as authorized. Do not retain
a hidden idempotency tombstone to counteract that choice.

## 2. Event producer and Claude dependency corrections

Make `DispatcherCoreEventBus` implement `DispatcherCoreEventPublisher`, expose
its existing `publish` operation and `hasSources`, delete `publisher` and its
constructor object, and pass the bus at `D/service/dispatcher-service/index.ts`
lines 191, 200, and 270. Consumers keep the narrow type. Call methods through
the owner, not as unbound callbacks. Preserve sealing, ordering, listener-error
isolation, duplicate subscriptions, and independently revocable session leases
in `dispatcher-core-events/index.ts:69-161`. This follows #459's owner-direct
data flow without confusing the real lease objects with redundant forwarding.

In `packages/agent-runtime/claude-code/src/runtime-deps.ts:20-21`, make only
`skillSources` and `disableFeatures` required and remove `runtime.ts:130`'s
`?? []`. The sole production constructor supplies both (`provider.ts:75-90`),
from required neutral fields. Keep `args.ts:48,130`'s independently optional
builder input and its real omitted/empty-feature cases, plus logger/output
schema/RPC seams as they currently exist. No new defaults or runtime validation.

## 3. Uninstall predicts the remainder of its existing removals

The dry-run branch at `D/onboard/uninstall.ts:185-187` must inspect the root
with async filesystem APIs. Calculate remaining immediate entries after the
same invocation's already determined owned state/run/cache/log paths and two
config-file unlinks. Reuse those concrete paths or accumulated removal entries;
do not invent a second hard-coded list of owned directory names. Factor the
two config paths locally if needed so preview and execution use the same pair.

If foreign entries remain, report the same `skipped` status and reason as real
`rmdir`; otherwise predict `removed`. Keep missing-root behavior. Real uninstall
still unlinks only owned config files and uses nonrecursive `rmdir` as the
final authority. Preserve operator-provider-home checks, including the path
that obtains them through always-loaded plugins. This corrects #455's preview
without reversing its intentional foreign-content preservation.

The forecast assumes the inspected filesystem and ordinary successful owned
removals. Do not promise equivalence across later external file changes or IO
failures, and do not add a snapshot, lock, rollback, or root-symlink feature.
Config filenames are unlink targets, not recursively removable directories;
the preview calculation must not silently grant recursive deletion semantics.

## 4. Preserve npm provider defaults at the public package boundary

`D/config/load.ts:110-123` feeds configured refs to the generic provider loader,
which selects `module.default` when no export was specified
(`registry/provider-loader.ts:192-205`). All three official package barrels now
export plugins there. Direct inspection of the local `origin/next` tree shows
their previous defaults were provider factories. The Feishu change came from
plugin MVP [PR #453](https://github.com/excitedjs/dreamux/pull/453); the runtime
conversions came from [PR #455](https://github.com/excitedjs/dreamux/pull/455).

Restore each package-root default as a correctly typed provider factory using
its current named bare-provider constructor. Use the former small factory
adapter where necessary: provider-loader context is not the Codex constructor's
test/embedding options. Do not restore deleted options or older provider fields.
Keep current named provider exports. Export explicit named plugin factories:
`createCodexPlugin`, `createClaudeCodePlugin`, and existing `createFeishuPlugin`.

Change the existing builtin plugin catalog from package strings to explicit
package/export descriptors. `constructPlugin` selects the descriptor's export
for builtins; configured npm plugins continue to use their existing default or
`#export` selection. Bootstrap keeps its current default entry. This is ordinary
composition data in the existing catalog, not a special case in Core's provider
loader. Always-loaded providers still come from plugin contribution.

| Public entry | Result |
| --- | --- |
| `npm:@excitedjs/agent-runtime-codex` / `agent-runtime-claude-code` in provider config | The respective provider on package defaults, with the configured npm ref identity intact. |
| `npm:@excitedjs/feishu-channel` in channel provider config | The bare Feishu provider, as before; no substitution with the builtin singleton. |
| Existing named provider factories | Remain available. |
| Builtin Codex/Claude/Feishu plugin refs | Load named plugin entries, contribute providers, and retain hooks/API behavior. |
| Named npm plugin exports | Construct the plugin through the already supported `#export` contract. |
| Third-party default/named plugin refs | Unchanged. |

Feishu's plugin retains its shared extension registry between its contributed
provider and published API (`F/plugin.ts:24-38`). A bare provider has its own
empty registry (`F/provider.ts:38-40`); do not merge these legitimate identities.
Explicitly configuring an official plugin already always loaded can still fail
the existing duplicate-name rule. This repair does not introduce alias dedup or
decide new-only plugin configuration policy.

No contract conflict prevents retaining both capabilities. A plugin subpath
alone is less proportional: the current npm ref grammar accepts package names,
not subpaths, while named exports already work. No silent config migration and
no startup `Rebuild:` step is needed for these refs.

## 5. Pairing expiry and route retirement

### Commit the token that was successfully sent

`F/access/index.ts:132-136` deliberately postpones pair writes; the later
`recordPairingPrompt` transaction currently finds same-sender entries without
checking TTL (`:192-207`). Keep the owner established by
[PR #457](https://github.com/excitedjs/dreamux/pull/457).
After the send succeeds, use one `now` inside the latest store update, preserve
the concurrent-approval early return, and prune expired pending entries before
selecting a same-sender winner. Reuse the existing pure expiry operation in
`access/gate.ts:108-121` within this package rather than inventing a new policy.
Merge the sent token/card into that current pruned state, preserving unrelated
senders and the current valid-winner/resend behavior. Use the same `now` for
fresh timestamps. Merely filtering the lookup while copying all expired tokens
would leak obsolete entries on repeated expiry and resend.

Keep send-before-save, retry after failed send, approval/expiry validation, and
known-prompt refresh. Never persist the gate's stale pre-send `nextState`, reserve
a token before IO, or keep the store transaction open around network delivery.

### Carry the route already selected by routing into COT

`F/routing/index.ts:143-154` already produces `plan.matched`; the inbound router
drops it at submission (`inbound/router.ts:110-123`). The visible anchor remains
the topic, so release matching by `anchor.target` misses the parent binding
(`cot/recipients.ts:216-229`). Preserve recipient-owned presentation established
by [PR #357](https://github.com/excitedjs/dreamux/pull/357) and
[PR #364](https://github.com/excitedjs/dreamux/pull/364): one standing anchor/card
per recipient, not per route.

Keep raw `VisibleMessageAnchor` as the visible message/location. Add one nullable
`servingTarget` to the stored COT anchor, supplied explicitly at submission:

- Bound inbound and card-action forwarding pass `plan.matched` through the
  existing `session/submitter.ts` before its Core call.
- Provisioned and queued-after-provisioning submissions pass the exact target
  just bound/read (`feishu-provisioning.ts:163-196`).
- Binding-notice fallback uses the target whose current ownership was checked
  after send (`routing/operations.ts:107-118`).
- Dispatcher fallback passes null; document comments establish no chat anchor.

The submitter combines location and route for COT only. Copy the serving target
when preparing/storing the anchor. Do not mutate the original inbound submission
used for Dispatcher fallback, re-query routing inside COT, or send this fact
through neutral Core payloads. The current explicit submitter caller set makes
a required nullable route argument sufficient; no generic routing envelope is
needed.

On release, preserve the existing visible-target match and also interrupt a
same-Team anchor whose serving target exactly equals the removed route. Parent
release then retires a parent-served topic but leaves an independently bound
exact topic alone, including when both bindings name the same Team. Leave
`blocksAnchor`'s visible-target policy, matching claim restoration, and nonclosed
Team-state fence clearing unchanged. This does not assert permanent anchor loss.

Also move the committed removed-routes COT release loop from
`routing/operations.ts:279-283` into `forgetTeamRoutes`, before its notice branch
(`:353-370`). A real `TEAM_NOT_FOUND` currently selects silent removal and skips
that loop. Retirement belongs to route removal, not whether a card is announced.
Ordinary unbind and displaced rebind already perform this operation directly.

Reuse `advanceAnchor(null)` and existing generation/terminal handling
(`cot/adapter.ts:584-619`). In-flight create/append need not be cancelled; old
queued content may flush and an existing terminal intent must not be replaced.
Assert that later activity cannot join the retired presentation and that its
existing terminal path finishes. Do not add a route generation, subscription
registry, permanent tombstone, or stronger terminal policy.

## 6. Acceptance mapping and final-parent coverage

The implementation owner should build behavior tests beside each repaired owner,
then finish the complete ledger pass. Use temporary filesystem records, actual
owners, controlled provider/transport boundaries, and explicit async barriers
for the named overlaps. Do not inspect source text or count files as evidence.

| Revision 1 outcome | Required observable evidence |
| --- | --- |
| 1: retired ownership | Repeated cold history/startup leaves no retained owner for completed history; fully retired edit/delete/corruption is observed on the next read. While construction, an admitted operation, cleanup, or a queued write is held, a concurrent read/name probe still uses the committed owner despite disk edits. Overlapping holders cannot release each other's authority. Last release permits fresh disk observation. Cover losing/failed construction, failed rebuild, host stop, cleanup failure/recovery, concurrent same-name creation, same/different-payload replay, and closed-behind-running write/event ordering. |
| 2: producer | Observe immutable committed facts through real producers and independently revocable sources; duplicate subscriptions and one throwing/rejecting listener do not disrupt the others. Revoke one session without revoking another, then revoke all. |
| 3: Claude | Compile against required internal deps; observe skill materialization and launch/restart args through the provider/runtime. Keep real builder omitted/empty/combined-feature assertions. |
| 4: uninstall | On equivalent temporary roots, dry-run performs no filesystem/service writes and predicts real root status/reason for absent, owned-only, foreign-file, and foreign-directory cases. Real foreign content and protected provider homes survive. |
| 5: package entries | Resolve built public package entries through the real config/provider loader for all three old default npm refs; exercise named providers, builtin plugin contribution and named plugin factories. Verify Feishu extension API/provider sharing and third-party plugin selection. Private `src/provider.ts` imports alone do not prove compatibility. |
| 6: pairing | Expired token then successful fresh card produces an approvable new token; old token remains expired/absent. Failed send saves nothing new. Approval during send wins; different senders merge; valid same-sender winner, retries, and both resend forms survive. |
| 7: COT | Parent-served topic retirement; exact-topic independence; unbind, displacement, and silent committed removal; release during create/append; later activity isolation; unchanged restoration and future-anchor behavior. Preserve first-anchor post-send ownership recheck. |
| 8: documentation | Each current statement maps to current source and the limited ruling; no blanket claim that all Core validation or all shutdown reads disappeared. |
| 9: final parent | Every ledger obligation receives a disposition with named behavior evidence or an explicit superseding decision, plus real #63 evidence and all required gates. |

For retention, black-box disk-observation tests prove the authority transition;
one focused owner-level retained-entry assertion can additionally prove the
required lifetime bound without a GC timing test, heap benchmark, production
metric, or public debug endpoint. Pending work must be exercised before and
after service eviction, not only after all promises have settled.

The parent restoration inventory is broader than these repairs:

| Coverage family | Ledger locations and surviving obligations |
| --- | --- |
| Entities, Teams, durable state, worktrees | L 656-885, 3615-3688, 4318-4351, 4446-4491: creation/replay/naming, reopen and reconstruction, worktree refusal/force/cleanup, current closed-first dissolve and post-failure facts. |
| Admission, completion, events, leases | L 1157-1215, 2340-2384, 3561-3614, 3689-3731, 4364-4380, 4420-4445: immediate submission, at-most-once completion, owner-close suppression, committed identity/aggregate events, revocation and privacy boundaries. |
| Workflow and cron | L 1907-1922, 3140-3208, 3836-3890, 5158-5173: first-terminal arbitration, recovery without execution, late messages, lock handoff/release, stop convergence, R73 close/construction order, stale timers, disabled races, overlapping fires and no replay. |
| Runtime providers and activity | L 383-528, 1255-1429, 4060-4113, 4753-4948: Codex/Claude admission, recovery/lifecycle/background work, reasoning/schema handling, growing and cold activity, cursor/error contracts. |
| Feishu | L 195-281, 2195-2337, 2636-2996, 4170-4312: access/pairing, routing/provisioning, COT/tool/token rendering, ask-user settlement envelope, extensions, document comments, card authorization and message landing. |
| Commands, admin and MCP | L 3732-3835, 4335-4388, 4986-5097: canonical adapter equivalence, address validation/error precedence, lease revocation, transport negotiation and faithful model-facing outcomes/errors. |
| Configuration, plugins and operations | L 24-76, 894-1215, 1994-2165, 3218-3293, 4114-4138, 4384-4420, 5134-5157: config tolerance including R72, plugin hooks/config/contribution, onboarding, doctor, PATH/Node selection, daemon, uninstall and sockets. |
| Transport, utilities and public types | L 2590-2635, 4060-4088, 4139-4169: actual rendering, atomic publication, config reader and neutral type contracts; restore helpers only for real current callers. |

For every deleted case, record one of: restored under a named current-owner
test; already covered by a named surviving assertion; or superseded by a named
accepted decision. Map mixed cases assertion by assertion. Source/path/export
name pinning stays deleted; use compiler, import-graph/lint rules, and functional
package imports for genuine boundary obligations. Do not restore R35's removed
no-Dispatcher-fallback expectation, obsolete removal detectors, `team.hooks.created`,
old native events, or the deleted `onPersisted`, resolver, `execDirProbe`, and
`createRunner` seams. L's final R71 section supersedes earlier literal fixture
restoration recipes. `ServiceNodeProbe` and the actual filesystem PATH boundary
remain legitimate. No unresolved surviving obligation is silently deferred again.

### The real issue #63 gate

`packages/dreamux/tests/codex-live.test.ts` currently contains only version
classification; it does not establish non-blocking inbound. Restore the gate
specified in `.agents/domains/non-blocking-dispatcher-inbound.md:111-137` and
L 494-528, 2410-2440: start real Codex app-server, block a Dispatcher turn in a
short synchronous operation, inject a second Feishu inbound during that window,
and observe the second `turn/start` before the first turn completes. Prove it
folds into that same native turn and the marker is processed when execution
advances, with no automatic inbound reaction. Keep explicit model `react` usable.

Deterministic tests additionally cover this path through a controlled runtime,
but cannot replace the live gate. Short native RPC/admission serialization is
not itself the forbidden completion backlog: `AgentService` invokes submission
before queuing its result continuation (`service/agent/service.ts:320-344`). Do
not rewrite the gate to accept two later completed turns or a queued marker.
Missing required Codex fails loudly; `DREAMUX_SKIP_LIVE_CODEX=1` is only for an
intentionally provider-free environment and is not evidence that #63 passed.

## 7. Implementation order, documentation and evidence closeout

One developer can deliver sequentially: Team lifetime and overlap tests;
package/default and event/dependency corrections; uninstall and Feishu repairs;
then the remaining ledger coverage families and live gate. This is one bounded
repair effort, not a new architecture framework or another test-free child stage.
Review the complete resulting diff, including adapted assertions, against the
requirement rather than treating passing rewritten tests as their own authority.

The TeamLeader owns authoritative record/KB updates and independent review.
The developer supplies the exact source delta and behavioral evidence. Closeout
must update these owners, without editing historical rulings into new authority:

- Team lifetime: `.agents/domains/state-config-and-files.md` Team Records and
  Transactional Stores, `service-topology.md`, `dispatcher-orchestration.md`,
  `D/service/CLAUDE.md`, product catalog, and the Team-state section of
  `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/service-lifecycle.md`.
  Keep the maintenance root routing accurate. Records remain fully server-owned;
  observability of retired-file edits is not advice to edit them.
- Package entries: the three package READMEs/barrel comments; owning plugin,
  provider-runtime and channel references; applicable maintenance references.
  Correct the pending `refactor-code-org-8a-providers_2026-09-25-00-00.json`
  notes in both runtime packages and Feishu's
  `plugin-system-mvp_2026-09-24-02-30.json`. State default provider and named
  plugin behavior plainly; do not require config migration.
- Activity: narrow `packages/dreamux-types/src/agent-runtime.ts:440-445` to
  current page/record shape, requested record count, cursor form and public
  errors. `D/service/agent/activity.ts:199-263` still performs structural checks;
  remove only the stale text/page/cursor size claim.
- Product catalog: mirror accepted removal of `dispatcher.start`, the actual
  Team/TeamMate/Workflow/cron owner-close read fences, and signal success exit 0,
  shutdown failure exit 1, and the 15-second failure deadline in
  `D/cli/server.ts:97-124`. Do not generalize these fences to all status reads.
- Cron: correct the pending `refactor-code-org-s4b-03_2026-09-25-00-00.json`
  note. Former `action.prompt` could override top-level prompt; current requests
  use top-level prompt. Existing stored prompt jobs remain readable and results
  still expose `action` (`D/service/scheduler/requests.ts:18-38,61`). This is a
  documentation correction, not permission to restore removed raw input.
- Channel owners: update the existing access/COT ownership descriptions for
  expiry-at-commit and serving-route retirement; no new KB domain is needed.

Use Rush change files for the actual package changes; do not hand-edit generated
changelogs. These repairs keep existing files readable and require no manual
startup rebuild. Retired-memory authority and restored package entries need
ordinary explanatory notes, not invented `BREAKING:`/`Rebuild:` instructions.

After source and documentation closeout, run all four repository gates through
`node common/scripts/install-run-rush.js`: `build`, `lint`, `test`, and
`typecheck:tests`; also run `.agents/scripts/check.sh`. Report separately:
deterministic owner tests, built public-package loading, real Codex #63 evidence,
and any actual Claude/Feishu external checks. Fake Feishu transport proves local
routing and card calls, not real platform delivery. Historical green runs are
not evidence for this tree. Parent merge into `next` remains outside this design
seat's authority and subject to the operator's delivery decision.

## Rejected alternatives and unresolved facts

- Dropping a record on `closed` or collection eviction ignores cleanup and
  admitted continuations. A bare `WorkflowRunStore.release(id)` copy does not
  fit Team's overlapping holders. A timer/LRU/cap or durable tombstone changes
  history/authority and does not answer lifetime ownership.
- Reopening records, retaining all closed stores, or consulting disk for live
  owners defeats either terminality or the operator's explicit retired boundary.
  No global generic store manager is needed for this one domain's holders.
- A replacement publisher wrapper, provider-name switch, hybrid provider/plugin
  return value, or fallback startup migration adds a mechanism without removing
  the mistaken identity/contract. The direct owner and named entry already work.
- Pre-saving pairing, broad parent-chat COT invalidation, or route re-resolution
  during activity would move decisions away from their existing authoritative
  operations. Keeping visible and serving targets distinguishes two actual facts.
- Restoring every historical test literally would reinstate superseded product
  behavior and deleted architecture. Restoring only this batch's regressions would
  leave R43 and #63 incomplete.

There is no source-established product or package-contract blocker. The main
implementation review obligation is complete coverage of every record-handle
acquisition/transfer/release and pre-await operation hold; omitting any makes
the proposed retirement unsafe. Actual installed-package loading and live
provider/platform availability have not been exercised in this proposal turn.
If real #63 cannot run in the implementation environment, record the exact
external prerequisite and leave that acceptance item incomplete; do not replace
it with a fake test or invent an environmental blocker in advance.

## Single adversarial cross-review, 2026-10-03

Read the first-round [DeepSeek](deepseek.md) and [MiMo](mimo.md) proposals,
this proposal, and [source audit](../source-audit.md), including its final
queue-overlap paragraph. Rechecked the disputed paths against current source
and revision 1. The arguments below refer to those first-round positions;
concurrent peer amendments do not initiate another review round. Earlier
reasoning is preserved above, except that bare history hashes were replaced
with public PR links. This section supersedes the identified design details.
No implementation, tests, gates, live requests, or task-state edits were made.

### 1. Record ownership: narrow the holds and use the existing drain

**Withdrawal of my excessive first-round mechanism.** Withdraw counting every
admission and every queued write, and the concluding requirement for a
pre-await hold on every operation. The actual `submitInput` continuation
(`D/service/team/service.ts:826-837`) checks committed `starting` and calls
`updateRecord` synchronously in the same continuation. `updateRecord` immediately
enqueues through the handle. After closed commits, this path cannot enqueue
another running patch. Before that commit it can enqueue behind closed; the
existing queue drain covers that tail. No generic `TransactionalStore` change
or Team-wide admission accounting is justified by this caller.

The complete current handle boundary is small:

| Producer / consumer | Current assumption and required treatment |
| --- | --- |
| `team/index.ts:783-791`, `depsBase` | Produces handles only for `createTeam` and `rebuild`. Replace implicit minting with an explicitly acquired, initialized handle passed into these dependencies. |
| `TeamService.createNew` / `startCreated` | Create writes at `service.ts:276`; initialization later writes running at `:368` unconditionally. The construction owns its handle until all these steps settle and it hands ownership to the live service. |
| `TeamService.rebuild` | `:458-462` relies on a preceding `get`/`list` having initialized the same store. Read the acquired handle instead; do not pass a separately loaded disk snapshot into an uninitialized owner. |
| Live Team and detached dissolve | `submitInput`, `runDissolve`, and failed-create abandonment write through the same record. `closed` alone does not cover the background cleanup after it. |
| Startup cleanup, `team/index.ts:377-392` | The other handle producer. Acquire/load explicitly before `settleTeamWorktreeCleanup` reads `current`; release after this job and the queue settle. It constructs no service. |
| History, replay, name probes, recovery scans | `get`/`list` consumers, not additional mutation owners. A read must join an existing owner, including one registered during a cold load, and leave completed history unretained. |

Every write is accounted for by record publication, initial/ordinary running
transition, dissolve/abandonment closed transition, and the cleanup patch
(`service.ts:276,368,412,626,833,1114`). `current` and `create` already capture
the store, but `handle.update` re-resolves by id (`store.ts:102-111`): all three
must use the same captured entry before any release is introduced.

**Reject DeepSeek's terminal-write release.** For an unmanaged Team, or a
terminal managed-worktree assessment, the closed patch already has non-pending
cleanup before `destroyChildren` starts. A read during destruction would then
escape the live memory authority. A cleanup patch is not necessarily the last
queued Team write either. Changing update to capture its store fixes the stale
lookup, but does not make prematurely exposing disk correct.

**Reject MiMo's queue-order proof.** The source-audit's concrete schedule is:

1. A recovered starting Team has a leader submission awaiting admission.
2. Dissolve queues closed and waits for its atomic file write; committed
   `current` still says starting.
3. Submission resumes, sees starting, and enqueues running **behind** closed.
4. Closed commits. Child destruction can overlap that queued patch. Unmanaged
   cleanup returns without a trailing record update, so cleanup settlement
   cannot prove the patch settled.

`TransactionalStore.drain()` (`dreamux-utils/src/transactional-store.ts:151`)
is exactly the existing primitive for this case. It waits the tail captured at
the call, not operations issued afterward. Preserve the terminal merge and
event suppression when that late running patch meets a committed closed record.

There is also real construction overlap, not hypothetical multiple recovery:
the initial leader receives this `TeamService` directly through leader MCP
(`team/leader.ts:123-131`, `team/leader-mcp.ts:51-52`). It can dissolve while
`startCreated` is still completing; `constructing` does not serialize this
direct call. Its unconditional running write can occur later. Startup cleanup,
by contrast, scans closed/pending records during startup and cannot ordinarily
race a reopened live service for that same closed Team. Do not invent repeated
recovery jobs to justify a counter.

**Revised implementation choice: one construction-to-live handoff, with a hold
only for the actually detached dissolve.** Keep the initialized acquisition
and one local holder count on the existing entry, but narrow its use:

- The collection acquires once before construction work and transfers that
  same hold at successful `track`; construction and live ownership are not
  counted twice. Null/failed construction releases in `finally`, after its
  existing abandonment/discard handling. Cover hooks, name allocation, and
  publication failures occurring before `createNew`'s current inner `try`.
- The accepted dissolve branch retains once before publishing its detached
  `dissolveTask`, and releases in its final settlement, including a failed
  closed write. This covers cleanup after live eviction and self-dissolve
  during construction; abandonment remains covered by the construction hold.
  Joining an existing dissolve takes no extra hold.
- At the existing `closed` callback, evict the exact live service and release
  its transferred hold. Background dissolve keeps its own hold. If closed
  happened before `track`, the settled callback releases only after the
  construction has handed over. Host-stop alone does not release a nonclosed
  service. Ensure a `track` failure after publication does not double-release.
- Recovery jobs and temporary acquired reads release their own acquisitions.
  Each release **keeps its hold while awaiting the captured store's drain**,
  then decrements and checks/removes the exact map entry synchronously. An
  acquisition during the wait has its own remaining hold; it cannot be
  detached by this releaser. No per-write hold, extra queue, or retiring flag.

This also covers construction failure overlapping an already submitted dissolve:
construction may finish its own abandonment first, but the background task still
holds the same entry. The count represents real independently settling uses,
not a mirrored Team phase. The first-round absent/closed/non-pending eligibility
test remains an additional condition, never the release trigger.

**Comparison with a quiescent single-owner alternative.** A count is not
mathematically necessary. One owner could retain the entry across construction,
handoff and the entire detached task, join both construction settlement and
dissolve/abandonment completion, then drain and release the exact entry. That
would be correct without changing `closed`. The queue example alone demands
drain, not counts. However, the proposed `evict -> release` does not perform
that join; `closed` is not the missing completion signal. Making the collection
coordinate those service-internal completion paths requires exposing another
completion/callback and handling early self-close and throwing construction.
The selected narrowly scoped extra hold keeps detached work responsible for its
own lifetime and avoids that coordination protocol. No claim that all
admitted operations remain writers, or that single ownership is impossible,
survives this review.

### 2. Preserve the meaning and timing of `closed`

Reject moving `closeFromRecord` after physical cleanup. The signal currently
means durable closed plus child destruction **attempted**, successful or not
(`service.ts:173-182,639-658`; `TeamClosedFact` in `team/types.ts`). Its consumer
evicts the same live instance. During destruction the Team remains reachable
by the host-stop sweeps; afterward physical Git cleanup does not keep it in the
live collection. `TeamCollection.stopForHost` deliberately leaves nonclosed
services registered so the dispatcher's second sweep after admission drain can
reach restarted runtimes (`team/index.ts:526-538`, `dispatcher-service/lifecycle.ts:217-245`).
Moving the signal would also retain closed services in that sweep during slow
cleanup and change what awaiting closed promises. It is not needed for record
release. The current async cleanup frame already retains the service while it
runs; do not assert an unproven additional heap-size regression from the timing
change. The concrete difference is membership and lifecycle meaning.

A failed child close is not proof every admission drained: AgentService awaits
runtime stop **before** draining admissions (`agent/service.ts:764-772`). Our
record argument instead uses the audited Team write sites, the closed guard,
construction/dissolve ownership, and explicit queue drainage.

Likewise, a cleanup job that caught an error has settled; the persisted
`cleanup-pending` fact is unfinished durable work for the next startup, not a
running job or hidden retry. Release the job's hold on failure. Retaining the
small record entry at zero holders while that fact remains preserves revision
1's unfinished-cleanup memory boundary; it is not needed to protect a writer
that no longer exists. It retains no live Team, retry timer, or new registry.
Only fully retired completed history gains the new next-read disk behavior.

### 3. Provider defaults: separate the two public entry contracts

Accept MiMo's package boundary direction and retain my typed factory adapters;
reject direct aliases as equivalent public types. Both provider loaders pass
`{ ref }` (`D/agent-runtime/external-provider.ts:84`,
`D/channel/external-channel-provider.ts:86`), per
`dreamux-types/src/provider.ts:176-189`. Codex's named constructor instead
accepts restart-backoff options; the other named constructors take no arguments.
An exported default alias would not expose the former context-call signature
to TypeScript consumers. Restore the small explicitly typed provider adapters,
leaving named constructor options intact. Test the built declarations as well
as actual public imports; a loader cast cannot establish that compatibility.

Reject DeepSeek's claim that bare official npm entries in `plugins[]` currently
work. `D/plugin/loader.ts:152-173` loads the official builtins first and rejects
the configured factory's duplicate `plugin.name` before its contribution. This
applies to all three official packages. A named `#export` does not legalize
duplicate configuration either. Named plugin factories preserve the plugin
capability and give the builtin catalog explicit import entries; third-party
default/named selection remains unchanged. No config migration is necessary.

Reject a throwaway contribute host: it adds plugin recognition, lifecycle
execution and a new exactly-one-provider selection rule to the provider path.
No-I/O is not purity. Feishu's plugin shares a registry between provider and API
and initializes its directory in `server` (`F/plugin.ts:24-38`); normal plugin
hosting executes these phases (`D/plugin/host.ts:75-85,117-125`). This does not
prove that extracting today's three providers must immediately crash; it proves
that contribution is a different contract whose generic substitution has not
been justified. Explicit exports remove the startup conflict with fewer rules.

Retain the first-round documentation/change-note updates. Rewrite the whole
obsolete default-contract explanation, not just its last migration sentence.

### 4. COT needs the serving fact and the existing visible-target policy

Accept DeepSeek's observation that `plan.matched` is already authoritative;
reject replacing the visible `anchor.target` with it. Concrete regression:
`G -> A` and exact `T -> A` coexist. Unbinding T fences T. A later T message
falls back to G; current `blocksAnchor` still refuses visible T until its claim
or nonclosed Team event clears the fence. Replacing target with G bypasses that
existing policy (`F/cot/recipients.ts:180-205,234-242`). Separate delivery
`chatId/messageId` and successful normalization do not prove lifecycle parity.

Reject MiMo's release-time surviving-exact-row inference. Start with `G -> A`
and no exact T; A takes a T anchor served by G. Then add `T -> B`, and unbind G.
The new exact binding had no displaced exact Team, so it did not release A's
old parent-served presentation (`F/routing/index.ts:266-309`,
`routing/operations.ts:180-185`). T now has an exact row: re-resolution would
incorrectly preserve A's old card. B's independently served card must survive.
This sequential example requires neither a failure nor a race.

Keep visible target plus nullable `servingTarget` in the stored anchor, and
match release against visible **or** serving target for the named Team. Keep
the existing visible-target admission fence and claim/reset behavior. The
complete producer/normalization path is:

| Producer | Serving fact and propagation |
| --- | --- |
| Ordinary inbound; card-action forwarding through the same router | `routing.plan(...).matched` flows through `inbound/router.ts:110-134` to `session/submitter.ts:33-58`, then both public/private COT begin methods (`cot/adapter.ts:163,287`). Card actions build the normal submission (`session/card-actions.ts:82-110`). |
| Initial Dispatcher routing and rejected-Team fallback | Pass null; retain the original submission for fallback. No Team binding is inferred from its visible target. |
| Provisioning first and queued subsequent messages | Pass the exact target just bound, or obtained from `bindingFor`, respectively (`feishu-provisioning.ts:163-196`). |
| Binding notice as first anchor | Keep the post-send ownership recheck (`routing/operations.ts:107-118`); pass its checked bound target through `setFallbackAnchorIfAbsent`. |
| Document comments | Pass null at `feishu-document-comments.ts:308,318`; no chat anchor is established. |

Raw visible targets continue to come from `inbound/target.ts:110-129` and the
inbound/card submission builders, not new guesses from thread ids.
`prepareVisibleAnchor` (`cot/recipients.ts:342-358`) reconstructs known fields:
merely attaching a property to raw input loses it. Normalize the visible anchor,
then explicitly copy the serving target into the stored anchor in both inbound
and binding-fallback constructors before `advanceAnchor`. No neutral Core field
or persisted routing format changes. Normal plan-to-anchor execution has no
await; no route generation or second lookup is needed there.

Retain the silent-removal fix: release every committed removed row in
`forgetTeamRoutes`, before its optional notice branch; remove release from the
notice-only loop. `TEAM_NOT_FOUND` actually uses silent removal. Failed commits
release nothing; ordinary unbind and displaced rebind already release directly.

For release during create/append, keep `advanceAnchor(null)` and existing
generation/terminal handling (`cot/adapter.ts:584-619,731-800`). **Narrow my
first-round phrase "terminal path finishes":** already queued content may
flush; subsequent activity cannot append to the retired presentation; an
existing terminal intent is not overridden. No cancellation of issued IO or
guaranteed platform delivery under failure is promised. Restoration, future
anchors and existing display retry policy remain unchanged.

### 5. Pairing must prune at the successful-send commit

Reject MiMo's "next gate prunes it" argument: on every `pair`,
`F/access/index.ts:132-136` returns the original current state. Repeated
unapproved pairing after each TTL would keep all old tokens if only the winner
lookup changed. DeepSeek does explicitly remove the sender's expired entries;
accept that this fixes the same-sender example, rather than mislabeling it as
lookup-only. It still leaves other obsolete entries accumulated in that map.

Keep the existing expiry helper at the latest `recordPairingPrompt` transaction:
approval check first, one `now`, prune, select a live winner, then merge/refresh
using that pruned state. Even when keeping an existing live winner, return the
pruned state so obsolete entries are discarded. Preserve valid entries for other
senders, both resend forms, concurrent approval, and send-before-save. This is
one existing owner's expiry rule, not a second cleanup subsystem or a commit of
the gate's stale pre-send snapshot.

### 6. Acceptance, convergence and remaining evidence

The three first-round approaches converge on the direct event-bus producer,
the two required Claude internal dependencies, retaining foreign uninstall
content, and correcting the named docs. Provider exports converge with MiMo's
boundary but need the typed adapter correction. Pairing converges with
DeepSeek's latest-state expiry intent but uses full existing prune. The material
rejected arguments are terminal-write release, delayed closed as quiescence,
unnecessary per-operation counting in my first draft, throwaway contribution,
repurposed COT target, release-time exact-row inference, and unapproved coverage
gaps. None is decided by agreement counts.

For uninstall, retain the first-round actual-target remainder calculation and
add a concrete distinction: `config.json` or `config.toml` can be a directory.
Real uninstall uses `unlink` (`D/onboard/uninstall.ts:189-190`), so such an item
is not an owned recursive deletion. Preview must not predict removable root
merely by subtracting its name. Real execution then rejects at unlink; do not
describe that failure as a successful `skipped` result or change its policy.

The section 6 acceptance mapping and all eight ledger families remain required,
with Team cases revised to exercise the actual holds and drain rather than
requiring a hold for every admission. Add explicit barriers for the recovered
starting/closed-write/queued-running schedule, early self-dissolve before
construction handoff, and reads during destroy and post-closed cleanup. Assert
the old `closed` timing separately from eventual record release. COT evidence
must include the two sequential counterexamples above, all producer paths,
normalization, silent removal, and in-flight create/append. Pairing must prove
obsolete entries disappear even when a live winner is preserved.

Reject MiMo's ledger disposition "accepted gap": revision 1 gives this seat no
authority to accept one. Every surviving assertion-level obligation maps to a
named restored test, a named surviving assertion, or an already authorized
superseding contract. Mixed historical cases require mixed dispositions. The
eight families are an inventory guide, not proof that the ledger is complete.
Unavailable external prerequisites remain explicitly incomplete/unverified;
neither presumed Feishu CI impossibility nor broad provider categories replace
the actual ledger obligations.

The current `codex-live.test.ts:5-23` and L 2412-2430 disprove MiMo's surviving
live-shell claim: only classifier units remain; the shell and its gate constants
were deleted too. Restore a shell that always registers tests as well as the
behavioral case. Source-audit records installed Codex **0.159.0**; installation
does not prove authentication, a model call, or issue #63. The real gate must
observe the second `turn/start` before first-turn completion, folding into the
same native turn, subsequent marker processing and no automatic reaction, as
specified in `non-blocking-dispatcher-inbound.md:124-137`. Preserve the documented
model-gate/intentional-skip controls; do not confuse classifier success or binary
availability with that evidence. Other live obligations follow their concrete
ledger entries, not invented new E2E scope.

No new operator decision or source-established implementation blocker remains.
The chosen lifetime protocol, public declarations and end-to-end channel paths
still need implementation evidence; the complete ledger and real #63 remain
delivery obligations, not completed checks. This review exercised no external
system and therefore establishes no external-availability blocker either.
