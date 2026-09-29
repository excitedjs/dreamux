# Architecture continuation verification

Scope: [ownership follow-up](artifacts/ownership-follow-up.md), delivered into
PR #453 after PR #455. This evidence covers that continuation, not final test
completion or product acceptance of all changes relative to `next`.

## Source inspection

The TeamLeader and independent baseline readers traced all eight ownership
areas against the source and the product catalog. The preservation ledger in
the follow-up names the relevant consumers and failure modes. The resulting
change keeps the config reader live, binds workspace loans without transferring
cleanup authority, preserves the closed-first serial dissolve order and
record-only recovery, and leaves Feishu IO outside access transactions.

No source files or service classes were added to satisfy the line cap. The
Team's workspace injection methods and cleanup callback into the collection
are removed. Agent factory callers no longer reassemble fixed dependencies.
The existing Routing and Access owners now hold their own persistence work;
the existing extension registry owns its plugin directory. Codex construction
and command validation remove already-proven internal optionality/shape checks.

## Scope adjudication

| Candidate | Disposition | Reason | Ruling conflict |
| --- | --- | --- | --- |
| COT presentation and TurnManager projection must be split | Reject as a required fix | A large file alone does not prove multiple owners; the current state machines can remain coherent in one owner. | No; preserves R57's rejection of cap-driven splits. |
| Raw, normalized, and loaded plugin values are duplicate authorities | Reject that premise | Each has a consumer and only `readPluginEntries` normalizes entries. A raw-document onboard rewrite changes round-trip semantics. | No; product decisions remain deferred under R69. |
| Restore all old dissolve tests verbatim | Reject | Several assertions predate the closed-first order; restore their underlying protections against the current contract. | Conflicts with R62/R67. |
| Deferred activity, Workflow lock, first-bind COT, pairing expiry, and config error changes | Defer | They require a separate behavior pass; this change preserves the baseline behavior. | R69. |

## Local gates and independent implementation review

On 2026-09-29 the complete executable change passed all four monorepo gates:

- `node common/scripts/install-run-rush.js build` — 9 operations passed.
- `node common/scripts/install-run-rush.js lint` — 9 operations passed;
  dependency analysis reported no violations across 222 modules.
- `node common/scripts/install-run-rush.js test` — 64 files, 710 tests passed.
- `node common/scripts/install-run-rush.js typecheck:tests` — 8 operations passed.

Rush update restored local dependency links without changing tracked dependency
files. No test was added, edited, or deleted. Existing advisory unused-export
output and the expected test stderr remain non-fatal. The TeamLeader checked
the full diff and gate logs; `git diff --check` passed.

The package change modifies 36 files, adds 700 lines and removes 1,038 (net
-338), with no added or deleted source file. This includes required formatting
and colocated documentation; the ownership account, not that count, is the
acceptance evidence. Five factory call sites shed fixed dependencies. The
record-based Team cleanup has three callers in two modules. Routing's two
lifecycle verbs each have one session caller; Access's four new domain verbs
each have one inbound caller. The registry's directory binding and path
derivation each have one caller. No new service class is introduced.

Using the repository's ESLint code-line rule (excluding blank/comment lines),
TeamService moves from 672 to 666, TeammateCollection from 669 to 660,
TeamCollection from 651 to 631, and inbound pipeline from 559 to 477. Remaining
large-file size alone is not treated as evidence for another owner.

DeepSeek independently traced all eight changes and found no current defect.
Its boundary note about `settleTeamWorktreeCleanup` requiring a loaded record
is already stated by the function contract and satisfied by all three callers:
live dissolve, abandoned creation, and startup recovery. The TeamLeader
confirmed those call paths. No extra guard, load, or record type is justified
by a hypothetical future caller. This review is static evidence of behavior
preservation, not live runtime acceptance.

The independent Codex/Claude review completed all assigned coverage: seven
finders, eight candidates, two verifier groups, and synthesis. Six candidates
identified the same documentation omission; the TeamLeader accepted the
merged finding. The `TeamLeaderHandle` topology entry now describes direct
`teammates.spawn` and construction-bound workspace ownership. The Access
invariants now assign the private store and serialized transitions to
`FeishuAccess`, and the dependency rule's explanatory comment drops its
deleted type reference. These corrections do not change executable code.

Two candidates concerned extra runtime fields on the newly created Team's
workspace loan. The TeamLeader agrees with the verifier's refutation as a
current defect: both ordinary and Workflow creation overwrite the member
worktree with a reuse-cwd identity, then explicitly construct the persisted
creation fields. Closing a member cannot acquire Team checkout cleanup
authority. No additional defensive construction path is introduced.

MiMo independently reviewed the full diff for ownership and entropy and found
no blocker. It confirmed that all eight changes remove misplaced wiring, with
no new class or shared layer that leaves the old mechanisms alive. Its optional
workspace-shape suggestion is the same already-adjudicated non-defect above;
the existing typed loan and explicit reuse-cwd derivation remain. Its second
note is accepted: ignoring a plugin config block without a reader is current
implementation, not a settled operator decision. The product catalog now
labels that distinction and the deferred discussion explicitly includes it.

The TeamLeader verified the accepted documentation corrections against current
source. Review closeout changed only documentation and one explanatory comment,
so the four passing source gates were not rerun. All accepted review findings
are resolved; final parent-PR product decisions and test restoration remain open.

Knowledge closeout passed `.agents/scripts/check.sh` (51 task records and 310
reachable knowledge files) and `git diff --check`.

## Coverage limit

R43 keeps new unit tests and restoration of the deleted-test ledger for the
final PR #453 completion. This child change must not be presented as satisfying
that gate. A source-preservation review and passing surviving tests do not
establish live Codex or Feishu acceptance.
