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

## Data-flow continuation: implementation and TeamLeader pre-review

The R71 implementation follows the [final solution](technical-design/data-flow/final.md)
and supersedes the earlier callback topology. Its pre-review executable revision
passed the four Rush commands above: build (2.39 s), lint (4.95 s), test
(9.82 s; 64 files and 710 cases), and typecheck:tests (3.79 s). The TeamLeader
read the final logs and checked the complete change inventory, construction
and observation paths, new operation owners, and preserved failure boundaries.
The test diff is empty; no tests were added, repaired, removed, or skipped.
No live Feishu/Codex validation was performed. Existing test warnings remain
non-fatal and do not represent a skipped new check.

| Pre-review item | Disposition | Evidence / correction | Ruling conflict |
| --- | --- | --- | --- |
| Address lookup stays on Server instead of moving to Dispatchers | Accept placement adjustment | Server validates id and current configuration before accessing the collection created by start; moving the lookup behind that accessor changes public embedding error precedence. Actual owner methods replace the former callback bag. Final solution section 5 records this. | None; preserves behavior. |
| TeamService.submitInput only forwards to submitToLeader | Fixed before independent review | The implementation now lives directly in submitInput, preserving initiator and Team-only admission. TeamCollection keeps its distinct addressed API. | R58 and the selected solution prohibit the redundant surface. |
| Removed chmod override left an orphaned JSDoc | Fixed before independent review | Deleted the comment; the actual chmod operation and isPidAlive test seam remain. | None. |

The complete old onPersisted chain, recipient/delivery suppliers, Team lookup
suppliers, catalog resolver bags, and session operation forwarding are removed.
The new WorkFence carries the existing dispatcher close/drain state;
UnbuiltAgent privately owns the prepared identity/store until build or
record-only close. Feishu's submitter and router own moved operation bodies;
the old session copies are deleted. Actual protocol, transactional, plugin,
and CLI extension callbacks remain with named suppliers and consumers.

The developer's first test run exposed unstructured restart-intent logging.
Source was corrected to constant messages with structured fields; the existing
log-hygiene assertion was not changed. All four final gates ran after the two
TeamLeader pre-review corrections.

The preliminary KB check caught stale deleted-module links and task commit
citations; those were corrected. Its in-flight task-state refusal is expected
until delivery closeout.

## Data-flow continuation: independent review

Claude, MiMo, and DeepSeek completed seven finder angles, source-location
verification, and one bounded sweep. The initial workflow's partial result
was not treated as a pass: three failed verifier outputs, three missing
verdict fields, and the sweep output were recovered. The new shared-clock
accounting candidate also received independent verification. The
[adjudication](artifacts/data-flow-review.md) records every retained finding,
its disposition, the rejected premises, and the correction boundary.

One actual behavior difference was confirmed: early channel logger creation
allocates a channel log when a disabled dispatcher is only materialized by an
addressed Command. Workflow logging was already eager and is not a regression.
The correction preserves the channel-build allocation boundary. Other accepted
items remove residual log transports, unused entrances and variability,
duplicate contracts, and stale documentation. Internal alias and role-assembly
cleanup is accepted for its current maintenance cost, not as a claim that an
imagined future caller already loses notifications.

The original source developer applied the accepted corrections. The final
executable revision passed the four Rush gates: build (1.45 s), lint (6.95 s),
test (11.03 s), and typecheck:tests (6.53 s). The TeamLeader inspected their
successful logs and the empty test diff. The test inventory remains 64 files
and 710 tests; no test was added, repaired, deleted, renamed, or skipped.
`git diff --check` passed. No live Feishu/Codex acceptance is claimed.

The correction also resolved an omission exposed by the old cron lookup:
all leader tools must retain Dispatcher admission followed by the committed
Team-closed check. Child adapters admit only the lookup; dissolve and channel
calls retain admission over their full request. Channel then checks closing,
and dissolve joins an existing task only after access has succeeded.
A live leader MCP lease can survive both boundaries while earlier teardown
waits. The actual Team supplies one call-scoped admitted-operation method;
no stored lookup supplier, wrapper owner, or new gate state was introduced.
Leader launch hooks again finish before delegate construction, and the Team
MCP header describes its actual Dispatcher-only catalog. The
[review adjudication](artifacts/data-flow-review.md)
records the reachable source paths and the focused independent correction
verification boundary. MiMo completed that final bounded verification with no
remaining behavior finding; the complete initial review and recovered coverage
remain the evidence for the unchanged remainder of the diff.

## Data-flow continuation: structure and remaining coverage

The final change removes the full persistence callback chain, completion
suppliers, delayed Team lookup suppliers, command resolver bags, provider
logger callback transports, dormant construction overrides, duplicate dissolve
schema, dead Team admission method, and Team recipient alias. It introduces
four named owners: WorkFence contains the existing dispatcher admission state;
UnbuiltAgent privately holds prepared identity construction; FeishuTeamSubmitter
and FeishuInboundRouter contain operations moved out of Session. Existing
operation bodies were removed from their former owners. No persisted fact,
global event router, proxy logger, or generic gate combinator was added.

Files with at least 600 lines under the existing ESLint rule (blank lines and
comments excluded):

| Source file | Code / physical lines | Ownership finding |
| --- | ---: | --- |
| `service/workflow-service/run.ts` | 694 / 822 | One run's IPC, locks, terminal record, and owed delivery. Closest to the cap; a pressure point for future run-protocol changes, not evidence for an arbitrary helper extraction. |
| `service/team/service.ts` | 675 / 1118 | Team aggregate composition, roster, admission, completion, and teardown. Split leader-role assembly was corrected in the existing leader module. |
| `service/agent/index.ts` | 651 / 958 | Member collection naming, materialization/reopen, live queries, Workflow locks, and shutdown. |
| `service/team/index.ts` | 614 / 966 | Team collection creation, workspace publication, dedupe, materialization, queries, and recovery. |
| `channel/feishu-channel/src/cot/adapter.ts` | 667 / 823 | One presentation state machine with anchor/route fences and card retirement. |

The first four paths are under `packages/dreamux/src`; the fifth is under
`packages`. No limit was weakened or comments removed to reduce the count.
These are review candidates when their responsibilities grow; being below
700 is not an architectural acceptance proof.

Public runtime construction overrides and Feishu bot overrides are explicitly
contracted. Claude session/RPC diagnostic inputs now take optional logger
objects instead of positional logging callbacks. Configuration and persisted
formats remain readable without migration. Rush generated ordinary minor
change notes for dreamux, Codex, Claude, and Feishu. The parent deleted-test ledger records fixture
adaptations and retains its full behavioral coverage obligations under R43.
