# PR #453 review fixes and final coverage

Revision: 2, 2026-10-08. This is the active continuation of the existing task.
Revision 2 changes only the discussed uninstall outcome under R75; all other
repair and final-parent coverage obligations remain.
The resulting-tree review covered PR #453 relative to `next`, after PR #462.
Its three independent passes and one adversarial round identified the issues
below; consensus is not a substitute for source verification.

## Operator authority and scope

The operator requested “把这些问题修了” after receiving the completed review,
then asked “有需要我确认的阻断性问题吗”. These instructions authorize fixing
the identified defects and delivery obligations. The initial newly exposed
product choice was retired Team record authority. The question was
“完全退休的 Team 记录，是否改为按磁盘读取？”; the operator selected
“退休后读盘 (Recommended)”. The presented consequences were:

- Online, constructing, pending-write, or cleanup-owning Teams retain their
  authoritative store. Fully retired Team history stays on disk and is read
  on demand without a permanently retained historical store.
- Editing, deleting, or damaging a fully retired record becomes observable on
  its next read. Name availability again follows a valid record. Active
  ownership and pending operations keep their existing memory authority.

This expressly narrows the prior daemon-lifetime snapshot semantics for fully
retired history only. It does not authorize deleting history or bypassing
pending cleanup. R72 and R73 remain settled. Accepted product changes elsewhere
in PR #453 must not be reverted merely because they differ from `next`.
New-only plugin configuration questions are outside this old-capability pass.

This continuation uses the operator's direct repair instruction as development
authorization, followed by the explicit R74 and later R75 answers for the exposed product
choices. No new development-approval card was sent or answered for this batch.
The earlier R73 approval remains a separate historical authorization.

## R75 uninstall decision (2026-10-08)

After asking what triggers unreadable-root preview and how next handles it,
the operator was shown the two paths: next reports planned removal after an
existence check and recursively removes the entire root; the repair tree
predicts foreign-content retention and deletes only owned config paths before
nonrecursive root removal. The operator then said “先和 next 保持一致吧”.
R75 selects next behavior for this discussed uninstall path. It supersedes
revision 1 outcome 4's foreign-retention and exact-prediction requirement;
other accepted refactor decisions, particularly provider-derived protection
(R34), root addressing (R26) and R74 record ownership, are unchanged.
The baseline is the remotely verified next source referenced in the
[decision record](../technical-design/review-453-fixes/unreadable-root-preview.md).
This is an explicit instruction to implement that choice within the existing
repair authorization, not an unanswered or newly sent approval card.

R76 subsequently settled the provider-home alias finding with “这个问题不修复，
之前我记得决策过。” after the same consequence on next was explained. Keep
normalized-path provider protection; do not resolve physical aliases or add
a symlink-removal branch to address that scenario. This narrows outcome 4's
protection guarantee and leaves the other outcomes unchanged.

## Required outcomes

1. **Retired Team ownership.** Ordinary startup and history reads must not root
   one store for every historical Team. Construction, live owners, queued
   writes, recovery, and unfinished cleanup must still share the correct
   serialized owner. Release only after the last real owner and pending work
   retire. Preserve concurrent name allocation, terminal `closed` writes,
   replay, worktree cleanup, and historical queries. Do not add a history cap,
   delete records, or invent another durable ledger or mirrored phase.
2. **Event producer ownership.** Remove the frozen publisher's pure forwarding
   identity. Retain its narrow producer contract on the authoritative bus and
   preserve the independently revocable session source leases. No behavior or
   external capability is to be removed.
3. **Claude dependency shape.** Remove dead optionality/fallbacks only for the
   internal runtime dependencies `skillSources` and `disableFeatures`, whose
   sole production supplier always supplies them. Preserve real optional
   argument-builder and test seams.
4. **Uninstall follows next (R75).** Restore the discussed root-uninstall
   behavior from next: dry-run checks path existence and reports planned
   removal without enumerating root content; actual uninstall recursively
   removes the Dreamux root, including other files inside it. Preserve no-write
   preview, removal order, missing-path handling and provider-derived protected
   operator-state locations under the current normalized-path checks. Physical
   provider-home aliases are not resolved or newly protected (R76). Preview is
   not a promise that later removal
   succeeds: actual permission/syscall failures propagate as in next. Delete
   the foreign-retention predictor, its transient removal ledger and the
   unselected unknown-result policy. No permission oracle or fallback is added.
5. **Configured official npm providers.** Existing default npm provider refs
   for Codex, Claude Code, and Feishu must remain loadable after upgrading.
   Preserve the new plugin entry capability as well. Prefer the correct public
   package boundary over Core-specific package-name cases or silent config
   migration. Update misleading upgrade notes and current references. If
   preserving both is impossible, report the actual contract conflict before
   substituting a startup migration.
6. **Pairing after expiry.** An expired same-sender pending entry must not
   discard a newly sent pairing token. Preserve send-before-save, retry,
   expiry, approval, and concurrent state merging in the existing owner.
7. **COT route retirement.** When a topic is served by its parent-group
   binding, releasing that serving route must retire its ongoing presentation.
   Independently bound exact topics must survive unrelated parent releases.
   Preserve restoration and future-anchor behavior; do not assert permanent
   anchor loss or force terminal semantics beyond the existing policy.
8. **Accurate documentation.** Narrow the stale Core activity-validation
   comment to the checks Core still performs. Mirror the already accepted
   removal of `dispatcher.start`, owner-close read fences, and signal exit
   semantics in the product catalog. Correct the cron note's false claim that
   former `action.prompt` was never consumed. Update Team maintenance and
   knowledge owners for the changed retired-record boundary.
9. **Final-parent coverage.** Complete R43's final PR #453 coverage stage, with
   meaningful behavioral evidence for the changed owners and locked contracts.
   R43 says “只有最后453合入next的时候才要求单测覆盖。” and the #63
   non-blocking-inbound live gate was explicitly deferred for final restoration.
   This is that final-parent restoration work, not another test-free refactor
   child stage. Use the deleted-tests ledger to account for obligations; do not
   recreate source-text/path assertions or claim file/test counts prove coverage.

## Acceptance and delivery

Use existing owner facts and neutral boundaries. Each added mechanism must name
its reachable scenario, and each removal must state what concept disappeared.
Validate cold history, overlapping owners and writes, close/construction order,
locks, expiry/concurrent approval, parent versus exact-topic routes, next-compatible preview/removal behavior, and both provider/plugin imports. Verify the final-parent ledger and
real #63 behavior; distinguish deterministic internal tests, live provider
evidence, and unavailable external systems.

All four Rush gates and `.agents/scripts/check.sh` must pass after closeout.
Do not weaken locked assertions. No green historical run establishes coverage.
One developer owns implementation; the TeamLeader owns authoritative task/KB
updates, source adjudication, independent review, and delivery records. Existing
child delivery authority targets PR #453's branch; merging PR #453 into `next`
still requires the operator's authority.


## Execution boundary selected on 2026-10-08

R77 records the operator's “停掉最后这次复审”. The last corrected-tree
workflow stopped at scope confirmation before reporting findings; it is not a
review pass and is not restarted. The required repair and R43 behavior/coverage
contracts remain unchanged. Completed prior reviews, source-based adjudication,
TeamLeader pre-review and current local gates are separate evidence for this
child delivery. Existing feature-base child and alpha authority remain; parent
PR #453 integration into next and external-platform acceptance are not claimed.
