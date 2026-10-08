# PR #453 repair implementation review

## CI fixture TeamLeader pre-review (2026-10-08)

The corrected inventory test runs ledger and LeDgEr in separate real temporary
roots instead of weakening assertions, skipping a filesystem branch or
coalescing mkdir. Existing foreign names and all valid/malformed/inert/direct
query assertions remain in both parameterized cases. Other test bodies are
unchanged. The TeamLeader verified the single changed package path, all 199
tested hashes, all 351 production/guidance hashes and actual current package
results: 2,649 default passes with six exclusions. The original fixture failed
during directory preparation on macOS; no runtime defect is inferred.

Current repository gates pass locally. Enabled native evidence remains the
preceding unchanged-source run, distinct from current default execution. The
normal child CI supplies macOS acceptance separately. R77 still stops the
final independent workflow; this source/assertion check is not a restarted
review or independent pass. R74/R75/R76 and the published alpha production
source remain unchanged.

## Final review stopped by the operator (2026-10-08)

The operator said “停掉最后这次复审” (R77). The stop returned a terminal
stopped state. At the operator's subsequent request, the TeamLeader read that
terminal result once: scope confirmation was the only started seat, and its
result and the synthesized workflow result were absent. No findings were
produced. This is neither a complete independent review nor a pass; it will
not restart. The earlier complete reviews and their adjudications remain
historical evidence, and all accepted corrections are complete.

Before knowledge closeout, all 230 frozen inputs, 227 changed paths, HEAD,
refs and index matched the review snapshot. All 199 writer-tested file hashes
matched the current source, tests, package guidance and ordinary change notes.
The TeamLeader source/assertion pre-review below and current 2,648 default /
2,654 enabled gate evidence remain distinct from the stopped review. R74,
R75, R76, the record hold/drain behavior and strengthened #63 assertions remain.
Closeout does not invent a final-review pass or alter product scope. The normal
child-PR CI and subsequent alpha/tester handoff follow existing delivery authority.
Cron jobs remain cancelled, and parent-next merge remains unauthorized.

## Historical knowledge-and-diagnostic TeamLeader pre-review (2026-10-08)

Both accepted corrections are complete. The MCP knowledge page now describes
the returned concrete Team name and its valid-record occupation under R74,
linking the existing lifetime owner. The distinct TeamMate name contract is
unchanged. KB checks resolve the new owner link and report only the intentional
review state; they do not replace this source/fact check.

The source writer changes exactly one log string and its existing test
expectation: Team dissolve failed to prepare or commit its closed record.
Reversing those strings matches the preceding two file hashes. The enclosing
catch still preserves the error payload, clears the task and throws before
child destruction or cleanup. No receipt, state, error code, hold/drain or
cleanup policy changes. The actual record-as-directory failure test retains
no-stop, running, cron, repair/retry, durable-closed and exactly-once-stop
assertions. Forced assessment failure is source-traced, not newly probed.

The TeamLeader checked all 199 tested hashes, all eight actual package outputs
and all six enabled Codex cases. Build, lint, typecheck, typecheck:tests, change
verification and complete diff checks pass. Default tests pass 2,648 with six
model exclusions; enabled tests pass 2,654 with zero skips. All 1,965 historical
identities and their contract/target columns remain. R76 and all earlier fixes
remain. Complete corrected-tree independent review, final KB, the actual commit
hook and authorized child/alpha delivery are pending. No cron job is created.

## Historical complete knowledge-and-diagnostic review disposition (2026-10-08)

The normal xhigh run completed all coverage seats. The TeamLeader matched all
229 frozen inputs, complete diff/index, HEAD/refs and the nonignored new-file
set before unfreezing. Two independent findings survive. Complete coverage is
not a pass. Each was checked against current source and the active rulings.

| Finding | Disposition | Source reason and correction boundary | Operator conflict |
| --- | --- | --- | --- |
| MCP knowledge still promises never-reused Team names | Accept as TeamLeader knowledge correction | The current page still states permanent identity, while R74 makes fully retired name occupation follow the valid disk record. Preserve use of the returned concrete name for subsequent calls, narrow occupation to valid records and link the existing record-lifetime owner. Active/pending ownership is unchanged. | None; this synchronizes the existing R74 decision rather than creating a new reuse policy. |
| Pre-commit dissolve log attributes assessment failure to record writing | Accept as a narrow diagnostic correction | runDissolve's catch covers both dissolveRecordPatch/assessment and updateRecord. Forced managed-worktree assessment can fail before any write, yet the summary says writing failed. Keep the underlying error payload, open/retryable state, cleared task and accepted-receipt semantics; correct only the summary to describe the common pre-commit boundary. Preserve meaningful existing failure assertions. | None; no lifecycle, error code, cleanup, ownership or protection policy change is authorized. |

The TeamLeader owns the current knowledge page and authoritative records. The
same source writer owns the diagnostic correction and its exact evidence rows.
The prior global-home correction remains complete. All 1,965 historical
identities, R76, precheck retain/drain and native #63 assertions remain. No new
decision card or cron job is needed within the authorized synchronization and
repair scope. The workflow refuted inventory extraction, duplicate uninstall
checks, serving-anchor reshaping, plugin-shape uniformity, root reason wording
and checkout occupancy re-query. None expands implementation authority.

The preceding 2,648/2,654 gates certify preceding bytes. Current correction
checks, complete independent review, final KB, the actual commit hook and
authorized child/alpha delivery remain pending.

## Global-home TeamLeader pre-review (2026-10-08)

The one accepted coverage correction is complete. The TeamLeader checked the
whole one-file diff, the actual context/diagnostic caller, default and explicit
home assertions for three identities, unchanged remaining behavior assertions
and credential isolation. The id-erasing helper, redundant forwarding helper
and fake dispatcher fixture argument are removed. No production or public API
behavior changes. The production owner matches HEAD byte-for-byte.

All 199 tested hashes match; only codex-home.test.ts differs from the preceding
manifest. Actual owner mutation rejects the named global-home assertion; the
restored owner passes the 177-case package control. This is regression
sensitivity evidence, not a current runtime failure. The TeamLeader promoted
only historical L63; all 1,965 identities and other rows remain.

Build, lint, typecheck, typecheck:tests, change verification and complete diff
checks pass. Actual eight-package outputs sum to 2,648 default passes and six
model exclusions, or 2,654 enabled passes and zero skips. All six actual Codex
cases and strengthened #63 assertions remain. Complete corrected-tree review,
final KB, the real commit hook and authorized child/alpha delivery remain.
R76 and all external execution limits are unchanged. Cron jobs stay cancelled.

## Historical complete global-home coverage review disposition (2026-10-08)

The normal xhigh review completed every seat with no coverage failure. Before
unfreezing, the TeamLeader matched all 228 frozen inputs, HEAD/refs, complete
diff, index and new-file set. Four reports share one root cause and are treated
as one finding. Full coverage is not a pass. The TeamLeader independently read
the restored test helper, the actual doctor-context owner and its diagnostic
caller, and the exact historical coverage row.

| Finding | Disposition | Source reason and correction boundary | Operator conflict |
| --- | --- | --- | --- |
| Global-home comparison discards dispatcher identity | Accept as an R43 coverage correction | The test-local dispatcherCodexHome ignores its id, so the two equality assertions cannot detect a regression in the production entry receiving runtime identity. dispatcherCodexHomeDoctorContext actually receives that identity, and runDiagnostic passes runtime_id to it. Exercise the existing production identity-bearing path under a shared environment and map the historical global-home obligation to those named assertions. Remove misleading test-only indirection and commentary as appropriate. Keep credential isolation, explicit environment overrides and production behavior unchanged. | None. This corrects coverage evidence; it does not establish a current runtime failure or change the global-home contract. |

The same source writer owns this correction and the ignored evidence matrix;
the TeamLeader will promote its precise historical-row disposition. Retain all
1,965 historical identities. The workflow refuted orphaned retain, the gate ABI
fixture, repeated uninstall checks, inventory-filter extraction, serving-anchor
reshaping and plugin export-shape uniformity. None supplies new implementation
authority. R76 remains explicit, and no physical alias correction is dispatched.

The preceding 2,648/2,654 gates certify preceding bytes. Current corrected-tree
gates, independent review, KB closeout, the real commit hook and authorized
child/alpha delivery remain pending. No new card or cron job is required.

## Authentication-fixture TeamLeader pre-review (2026-10-08)

The one accepted correction is complete. The TeamLeader checked the complete
fixture diff, unchanged eight test bodies and assertions, actual before/after
package output, the same-worker restoration marker, all eight current package
summaries in both modes, and all 199 tested hashes. Only codex-home.test.ts
differs from the preceding manifest. The fixture now isolates HOME/CODEX_HOME
and the three supported ambient credential variables through existing Vitest
stubs, restoring them in finally after fixture cleanup. Production environment
merging, authentication support and native-model selectors are unchanged.

The synthetic inherited-credential run fails the two expected old assertions
before correction (175 passed, two failed), then the disposable imported-suite
probe passes after correction (185 passed, including its repeated eight real
cases). Its afterAll marker verifies restoration in the same worker. This
temporary probe is removed before final gates; its repeated cases are not
additional historical coverage. The earlier exit observer emitted no worker
marker and is not restoration evidence. Real secret values were not inspected
or printed.

Current build, lint, typecheck, test-typecheck, change verification and complete
diff checks pass. Default tests pass 2,648 with six model exclusions; enabled
tests pass 2,654 with zero skips and all six actual Codex contracts. Both #63
ACK-before-completion assertions remain. The historical matrix retains all
1,965 unique identities, changing only the two exact authentication rows.
Complete corrected-tree independent review, final KB, the real commit hook,
feature-base child delivery and alpha handoff remain. R76, other settled owners
and external acceptance limits are unchanged. No cron job is created.

## Complete authentication-fixture review disposition (2026-10-08)

All normal xhigh coverage seats completed. Before unfreezing, the TeamLeader
verified all 228 frozen file hashes, complete diff and index, HEAD/refs and the
new-file set. One independently verified finding survived. Complete coverage
is not a pass. The TeamLeader read the actual helper, missing-auth assertions,
provider environment merger and authentication predicate before adjudication.

| Finding | Disposition | Source reason and correction boundary | Operator conflict |
| --- | --- | --- | --- |
| Codex home tests inherit host credentials | Accept as a test-fixture correction | The restored helper merges process.env into the selected test env. HOME/CODEX_HOME are isolated but the three supported auth variables are not, so a legitimate host credential changes the expected missing-auth result. Isolate and restore this fixture's ambient authentication inputs while retaining explicit nonempty/empty credential assertions and production environment merging. Reproduce with synthetic inherited credentials, never print or overwrite real secrets or change native-model selectors. | None. This restores deterministic behavior evidence under R43; production credential support and R76 stay unchanged. |

The workflow refuted serving-anchor reshaping, repeated uninstall path checks,
pairing-helper extraction and dissolve-release rewriting. None of these
refutations expands implementation scope or changes the settled owner model.
No new product decision is needed for fixture isolation. The same source writer
handles the one accepted correction; the TeamLeader owns records and delivery.
Current 2,648/2,654 test results remain evidence for preceding bytes until the
fixture correction is tested. No independent pass, KB done, child delivery or
alpha publication is claimed. Cron jobs remain cancelled.

## R76 correction TeamLeader pre-review (2026-10-08)

The four accepted writer corrections are complete. The TeamLeader inspected
all eight changed writer paths, compared the 199 tested hashes with the
preceding manifest and current files, checked the actual eight-package logs
for both test modes, and preserved every one of the 1,965 historical identities.
Only the default-home row changes in the historical matrix. R76's rejected
alias correction is absent; normalized-path protection and recursive removal
remain. The earlier staged README scan was synchronized to the reviewed
worktree by the TeamLeader. Final index-wide synchronization remains a delivery
step rather than a claim that the existing index is the tested tree.

| Accepted correction | Source and observed evidence |
| --- | --- |
| Inherited native-home fixture | Vitest stubs HOME/DREAMUX_ROOT, clears CODEX_HOME/CLAUDE_CONFIG_DIR, and restores the stubs in finally after cleanup. A disposable inherited-home run fails the unchanged default-home refusal before the fixture correction and passes after it. Actual package output is 1,102 passed with six model exclusions; markers survive and the parent environment is unchanged. Explicit custom-home assertions and native selectors remain. |
| Unproduced uninstall status | Only the skipped type alternative is deleted. Existing producers return removed/missing; errors still propagate. Current compiler checks and preview/removal/missing/error assertions pass. |
| Recovery ownership comment | The comment now describes the acquired handle held through cleanup/update/release without constructing TeamService. Merge, terminality, retain/release/drain code is unchanged. |
| Repeated pending release facts | Existing Dreamux and Feishu minor notes own the duplicated uninstall and provider-entry facts. The two patch notes retain their distinct repairs. Highest minor bumps remain; no generated changelog or version edit occurs. |

Build, lint, typecheck, test-typecheck, change verification and complete diff
checks passed. Default tests pass 2,648 with six explicit model exclusions;
enabled tests pass 2,654 with zero skips and all six actual Codex contracts,
including strengthened #63. Real Feishu/Claude, service-manager mutations,
case-insensitive volumes and hosted CI are not certified. Complete resulting-tree
independent review and final knowledge closeout still remain. No cron job is
created, and no child delivery or alpha publication has occurred.

## Complete alias-and-delivery review disposition (2026-10-08)

The corrected-tree xhigh run completed every finder and verifier with no
coverage failure. Before unfreezing, the TeamLeader matched all 228 file hashes,
HEAD, complete diff, refs and the nonignored new-file set. The six retained
findings below were checked independently against source. Complete coverage
is not a pass. The operator subsequently rejected the provider-home alias
correction in R76. The same writer owns the four remaining implementation
corrections; the TeamLeader owns the index/delivery correction.

| Finding | Disposition | Source reason and correction boundary | Operator conflict |
| --- | --- | --- | --- |
| Provider-home alias bypasses protection | Reject correction under R76 | The source consequence is real for the named layout, but next has the same recursive deletion consequence. After that explanation the operator explicitly said not to fix it. Preserve normalized-path checks; no physical-alias resolution, predictor or symlink-removal branch is authorized. The earlier TeamLeader acceptance is superseded before dispatch. | R76: “这个问题不修复，之前我记得决策过。” R59 and R75 remain. A reviewer verdict cannot override this decision. |
| Default-home test inherits native overrides | Accept | The fixture changes HOME but retains CODEX_HOME/CLAUDE_CONFIG_DIR, while its default-home assertion assumes no override. Isolate and restore inherited fixture environment; keep explicit custom-home cases and real native-model selectors unchanged. Demonstrate the regression under nondefault inherited native-home variables using disposable fixture paths. | None; do not erase the caller's environment outside the fixture. |
| Index still contains removed README scan | Accept as TeamLeader index/delivery correction | The current worktree is correct and its file matches HEAD, but the index retains the newly restored prose scan. Synchronize the affected index path now and every delivered path before commit, then prove staged content equals reviewed/tested bytes. No source or assertion rewrite is needed. | None; never commit an obsolete index or skip the real pre-commit hook. |
| UninstallStatus retains unproduced skipped | Accept | All current producers emit removed/missing or throw. R75 deleted the only skipped producer. Remove the unreachable type alternative and keep missing/planned-removed/actual-error behavior and existing compiler consumers. | None; this follows the selected R75 behavior. |
| Reclamation merge comment says no handle held | Accept | Startup recovery acquires a real handle and releases after cleanup/update/drain without constructing TeamService. Correct this ownership comment; record lifetime and terminal merge do not change. | None. |
| Pending notes repeat the same release behavior | Accept the narrow consolidation | Rush emits each pending comment separately; the two cited pairs repeat uninstall semantics and provider/default-vs-plugin entry behavior. Consolidate only those repeated facts into their existing owning pending entries, preserve distinct repair facts and the existing highest required bump. No dedicated single-note convention or duplicate version-bump bug is claimed. | None; generated changelogs and versions remain Rush/Actions-owned. |

The independently refuted inventory-predicate, public-barrel negative checks,
untracked linked decision record and repeated path-check findings do not
expand this correction scope. Existing R74 owner/drain, R73 admission, direct
precheck hold, pairing/COT and strengthened native #63 assertions remain.
Current 2,648 default / six exclusions and 2,654 enabled / zero skips are
historical until these corrections pass new gates. Final independent review,
KB and delivery still remain. The operator additionally authorized an alpha
and designated tester handoff after completion; release actions are deferred
until reviewed feature-base delivery and use the existing Actions pipeline.

## Corrected R75 TeamLeader pre-review (2026-10-08)

All four accepted corrections are implemented. The plausible precheck schedule
is now confirmed by an actual-owner reproduction, rather than a holder-count
inference: the production-minted leader MCP call remains pending while initial
submission acknowledgement becomes ambiguous, construction commits closed,
real managed Git cleanup completes and construction releases. Before correction,
a cold acquisition created a different record owner; a late accepted dissolve
changed the disk note while the held owner and public summary retained the old
note. The actual assessment returned terminal/deleted. The same regression now
shares one owner, performs no cold reload, and observes the same note on disk,
through the held handle and through public summary. Native admission is a
controlled provider fixture; this is not a claim of real-model concurrency.

| Accepted item | Current source and observed assertion |
| --- | --- |
| Protected provider containment | The existing pre-service path check rejects either containment direction. Both native provider-home variables nested under root/state/run/cache/log refuse preview and actual removal; provider, config and service bytes stay unchanged and no service command is called. Other R75 recursive deletion remains. |
| Direct leader precheck | The existing captured-record hold begins before precheck. Dirty-checkout refusal releases once and raises no accepted task; concurrent prechecks join one task and release each hold once; acceptance hands the same hold to detached cleanup. The already-published-task fast path retains nothing. TeamStore drain, retirement, exact-entry guard, lease revocation and closed terminality are unchanged. |
| Transport boundary | Public package imports execute inbound/callback decoding, send/app-owner lookup and COT wire, batch and platform-error behavior with compiler-checked inputs. SDK IO is fake. Removed-name decisions remain narrowly mapped; no exact barrel inventory or new production export is introduced. |
| Codex Provider representation | Actual factory capabilities, config, operatorStateRoot, typed runtime creation and disk activity remain named observations. Only the own-enumerable-key requirement is removed; neutral consumer typing does not prove absence of all extra runtime properties. |
| ChannelProvider fixture | Only the fixture's self-enumeration is deleted. Its compiler contract and actual createSession identity assertion remain. |

The TeamLeader checked the complete correction source and assertion bodies,
all 199 tested writer-owned hashes, actual eight-package logs and the precise
commands. Build, lint, typecheck, typecheck:tests, change verification and diff
check passed. Default tests passed 2,648 with six model exclusions; enabled tests
passed 2,654 with zero skips and all six actual Codex contracts. All 1,965
historical identities retain a disposition in [coverage accounting](coverage.md).
The corrected whole tree still needs independent review. Earlier complete
finding-bearing or partial rounds are not passes. Cron jobs remain cancelled;
no final KB or child-delivery claim is made.

## Current R75 continuation (2026-10-08)

The operator selected next-compatible uninstall with “先和 next 保持一致吧”
after the concrete preview/removal comparison. Revision 2 retires the
foreign-retention predictor and its unresolved unreadable-root policy.
Historical findings below remain facts about their reviewed trees; they do
not require restoring a mechanism that R75 now supersedes. The same writer
completed the root-removal owner, behavioral assertions, package guidance and
coverage dispositions. The TeamLeader checked the current source, actual owner
assertions, repository logs, all eight package summaries and 199 tested hashes.
Default tests passed 2,642 cases with six model exclusions; enabled tests passed
2,648 with zero skips, including all six actual Codex contracts. Build, lint,
typecheck, test-typecheck, change verification and complete diff checks passed.
Other repair outcomes remain. Complete resulting-tree independent acceptance
and final knowledge closeout are pending; earlier partial or finding-bearing
rounds are not passes. No accepted implementation finding remains unresolved
before this new full review.
All scheduled jobs were cancelled at the operator's request and stay cancelled.

## Complete R75 review disposition (2026-10-08)

The normal xhigh workflow completed every finder and verifier with no coverage
failure. All 228 input hashes, HEAD and the complete diff matched at terminal
handling. Five independent findings survived. Complete coverage is not a pass.
The TeamLeader read the current owners and assertions before this disposition.
The R75 gate counts above now describe the pre-correction tree, not acceptance
of the next corrected tree. The same writer handles accepted implementation
and test corrections; the TeamLeader owns authoritative records. No new cron
job or product-policy choice is introduced.

| Finding | TeamLeader disposition | Source reason and bounded action | Operator conflict |
| --- | --- | --- | --- |
| Recursive root deletion can contain a protected provider home | Accept | The existing safety predicate tests only whether the removal path lies inside the protected root. A custom CODEX_HOME or CLAUDE_CONFIG_DIR beneath DREAMUX_ROOT is therefore deleted with the root. Preserve provider protection by refusing destructive containment in the same pre-service owner checks, with actual private provider-home bytes and zero service calls. Keep R75 recursive removal elsewhere. | None; R75 explicitly preserves R34 protection. |
| Direct leader dissolve retains its record only after asynchronous precheck | Investigate before claiming a runtime defect; conditionally correct only if the actual owner schedule is proved | The admitted call can wait while failed initial construction writes closed, cleans up and releases the construction owner. Existing lease revocation does not cancel that already running call; late retain increments the old entry without registering it. requireReclaimableWorktree accepts a terminal assessment, so cleanup does not by itself prove that the call must fail. Use a real managed-worktree/precheck barrier and a reachable construction failure to determine whether cold acquisition and stale publication overlap. If proved, cover the actual asynchronous use with the existing captured record lifetime; do not add a second fence, registry repair or broad admission counter. | No new policy is selected; R74 requires in-flight uses to share the authoritative owner. |
| Transport public API test mirrors an exact export inventory | Accept the test redesign | The 18-name equality does not call the exported API and breaks on a compatible new export. Preserve compiler imports and meaningful calls through the actual public entry, and map each surviving historical ABI fact to its proper assertion. Do not replace the inventory with another source/name mirror or retire the whole case. | None; approved coverage requires behavior and the whitepaper rejects structural mirrors. |
| Provider instance test requires all capabilities to be own enumerable properties | Accept the assertion redesign; reject the candidate's compile-time excess-member rationale | AgentRuntimeProvider specifies capabilities, not enumerability. A prototype implementation can satisfy it while failing the exact-key equality; structural typing also does not prohibit all extra runtime members. Keep actual Provider capability observations and neutral type/consumer boundaries, without pinning incidental object representation. The deleted ledger already asks to redesign this allowlist. | None; preserve actual neutral capabilities, including R34, rather than inventing a physical key-set contract. |
| ChannelProvider fixture immediately enumerates its own literal | Accept deletion of that redundant assertion | No production operation occurs between defining the fixture and checking Object.keys. The compiler contract and createSession invocation establish the minimal provider behavior and remain. | None; no production or retained capability is removed. |

The three refuted barrel candidates are not generalized into an authorization to
rewrite all public-entry tests. The transport finding is supported by its own
body and absence of meaningful calls; other modules have separate compatibility
and import boundaries. Any additional discovered gap must be justified per fact.
The plausible precheck schedule remains a verification task, not a confirmed
production failure or a reason to remove the exact-entry release guard.

## Historical round 1 (2026-10-03)

The independent xhigh workflow reviewed the complete staged repair against its parent, including new tests, knowledge records and case accounting. Seven finder seats were requested. The removed-behavior finder returned no usable result; the other seats and independent candidate verification completed. Eleven candidates were verified, four refuted, and six reported. **Coverage was partial; this round did not pass.** A complete review after the same writer's corrections must include the missing angle. No old green run closes that gap.

The TeamLeader checked the six reported premises against current source before dispatching corrections. The direct repair instruction and R74 authorize in-scope defect and coverage corrections; none of the accepted items selects a new product contract. No additional ratification card is claimed.

| Finding | TeamLeader disposition | Source reason and action | Operator conflict |
| --- | --- | --- | --- |
| Uninstall previews count dangling config links as removed although real access-based deletion skips them | Accept | Dry-run must use the same actual config-file existence predicate as the real path. Preserve nonrecursive deletion and foreign-content protection; add dangling-link parity evidence. | None; implements outcome 4. |
| Last-holder queue-drain test never observes committed closed with a blocked late write | Accept | The reader added too early and initial running value can hide removal of drain. Use an explicit filesystem/queue barrier and assert release remains pending and another acquisition shares the original owner. Current runtime already drains correctly. | None; implements R74 and outcome 9. |
| Claude append order accepts an absent first fragment because indexOf returns -1 | Accept | Both fragments must be present before comparing positions in fresh/resumed runtime assertions. Do not weaken expected content or repair by changing runtime behavior. | None; restores the retained append contract. |
| Pairing KB and Feishu CLAUDE still call restored gate/introduce/card tests missing | Accept | Link actual current tests and retained behaviors. TeamLeader owns KB; writer owns source-adjacent guidance. | None; outcome 8. |
| Three startup scans re-read fully retired records | Reject as a required implementation correction; retain cost as a limit | Extra IO is real, with no demonstrated startup failure. The passes span cleanup/rebuild and post-channel-start admission; a cross-phase history snapshot is another lifetime/cache mechanism and has not been shown equivalent for changed/new records. R74 explicitly chose cold history and preserves no permanent historical root. Keep fresh owner reads and document O(history) scan cost. | A cached retired authority or missed new admission would conflict with R74/current startup behavior. |
| No-source identity publisher still constructs/seals a DTO | Accept the narrow existing-capability optimization | The disabled Dispatcher/admin creation path can commit identities before any source exists. Reuse hasSources at this producer; preserve identity observations, later real publication and no replay. No new publisher or policy entity. | None; aligns the retained no-audience display boundary. |

The TeamLeader also identified a delivery-boundary omission: hosted CI installs Codex but supplies no model authentication, whereas the restored native cases presently run unless Codex itself is explicitly skipped. Historical native tests had a separate model-gate opt-in. Restore that explicit execution boundary without weakening native assertions or interpreting an excluded run as proof. Keep auth-free installed-version/real protocol compatibility checks, fail loudly for missing Codex unless intentionally excluded, and rerun all six actual model cases with the gate enabled. This is restoration of the historical test execution contract, not authorization to configure secrets or claim hosted native acceptance.

Other source-checked closeout corrections: Feishu extension docs must name createFeishuPlugin; Team-name occupation depends on a valid record still existing; the historical ownership artifact and unit-testing guidance must point to the restored contracts while keeping the old pass's authorization distinct. These are TeamLeader knowledge writes after accepted implementation corrections and full independent review.

The four refuted candidates remain rejected: same-sender lookup does not require exporting another helper; duplicate import aliases have actual callers and no functional defect; pending release notes describe both the original change and its correction without an upgrade blocker; compile-only contract examples are not proof of live provider behavior and are not used as such in this accounting.

## TeamLeader correction source check (2026-10-03)

The evolving uninstall preview still misses deletion order between the two
owned config paths. With a valid config.json and config.toml linked to it,
the real loop unlinks JSON first; access on TOML then fails, leaving its
dangling link and the root. The preview computes removedTargets before its
config-file loop and resolves TOML while JSON still exists, so it predicts an
empty root. This is a concrete parity defect within accepted outcome 4, not a
new deletion policy. The same writer must preserve real deletion and predict
the ordered plan, with a behavior assertion for this case, before final gates.
There is no operator-ruling conflict. Avoid a new generic filesystem simulator;
report a design conflict if matching the existing two-path plan requires one.

## Corrected-tree TeamLeader pre-review (2026-10-03)

The same writer completed the accepted corrections and ordered-config check.
The TeamLeader inspected the complete correction diff, actual final logs,
current owning code and named assertions before requesting another complete
independent review. No accepted correction remains unresolved in this pass.

| Accepted item | Current evidence |
| --- | --- |
| Dangling and ordered config links | Preview accumulates the existing ordered removal plan and follows config links without removing foreign targets. Actual deletion is unchanged. Tests compare exact preview/real entries for absent targets, owned-directory targets, regular JSON followed by a TOML link, a link through externally backed JSON, and independent links sharing an external target. |
| Last-holder drain | The explicit queue barrier observes closed already committed while the late write is blocked. Removing only drain made the release-pending assertion fail before another holder could mask retirement; the exact source was restored and both final runs passed. |
| Claude append coverage | Both fresh and resumed runtime assertions require the Workflow and identity fragments before comparing their order; resume also requires the append flag. |
| Pairing guidance | Current KB and source-adjacent guidance point to restored gate, introduce, pairing-card and pairing-commit assertions. Historical deletion evidence remains with a current correction pointer. |
| No-source identity events | The existing factory listener skips DTO production only; actual owner tests prove committed identity, retained roster observations, no replay and later ordered publication. |
| Model execution boundary | Default Rush tests execute real auth-free version/initialize/thread checks and explicitly exclude six model cases. The separate enabled run executed all six, including second acknowledgement before command completion in #63. No authentication inference or CI secret policy was added. |

The three-pass retired-history scan cost is documented in the owning Team
record page; no startup snapshot was added. This pre-review and local checks
do not replace the complete independent review still required after partial
round 1.

## Historical round 2 and source adjudication (2026-10-03)

The corrected-tree xhigh workflow completed the previously missing
removed-behavior angle, but its requirement-fidelity finder returned no usable
result. Eleven candidates were verified; four were refuted and five findings
survived consolidation. **Coverage remains partial; this round did not pass.**
The reviewed input remained byte-identical throughout the run. The next normal
review must cover the entire corrected tree and recover requirement fidelity;
a runtime fallback is allowed without weakening that seat's identity or scope.

The TeamLeader verified the three uninstall mechanisms in current source. A
disposable filesystem probe confirmed that a valid directory-link/parent-link
configuration repeats the same link under the lexical calculation, and that
removing state makes its later run link inaccessible. Case-insensitive parity
follows the current exact string comparison versus filesystem lookup; local
Linux evidence does not claim a case-insensitive platform execution.

The [Node.js fs.realpath contract](https://nodejs.org/docs/latest-v22.x/api/fs.html#fsrealpathpath-options-callback)
explicitly excludes case conversion on case-insensitive filesystems. A resolved
path string alone therefore cannot substitute for actual directory-entry
lookup when predicting removal.

| Finding | Disposition | Reason and correction | Ruling conflict |
| --- | --- | --- | --- |
| Config target with directory symlink followed by .. loops forever | Accept | Preserve filesystem resolution order instead of lexically collapsing the readlink target. Do not hide wrong path resolution behind a visited-set, cap or fallback. Add the valid layout as an observable uninstall case. | None; outcome 4 requires a terminating truthful preview. |
| Earlier owned-directory removal leaves a later directory link dangling | Accept | The prediction must apply the same ordered plan to owned directories as to config paths. Real access-based deletion and foreign-target protection remain unchanged; compare exact preview/real entries for state followed by a run link into state. Keep this logic within the existing uninstall owner. | None; same preview-parity requirement. |
| Case-insensitive filesystem entry names differ from plan strings | Accept | Use the actual filesystem's entry/lookup semantics, without assuming all macOS volumes are insensitive or lowercasing all paths. Preserve separate foreign entries on a sensitive filesystem. Add current-filesystem parity evidence and report which platform branch actually ran. | None; preserves real deletion and foreign content. |
| Scheduled-work Team record anchor is absent | Accept | The target heading is Team Records; correct the fragment to #team-records. | None; knowledge-only correction. |
| Five live-test files import sibling dist internals | Accept the available public imports; reject forced removal of indispensable instrumentation | Provider factories and default config already have public entries and should use them. Native RPC/terminal/version observations and Feishu fake-IO interception have no equivalent public entry and serve locked behavioral evidence. Do not weaken that evidence or add a production API solely for test plumbing; retain and explicitly name the residual test-only internal coupling. | Restoring a lower-evidence gate would violate R43/#63. |

The minimum shared home for ordered prediction may be one private operation in
the existing uninstall owner, paid for by the concrete directory/config link
cases above. Do not add a generic filesystem simulator, a second persisted
deletion plan, a new policy list, retries or caps. If the unchanged deletion
policy cannot be predicted coherently within that boundary, report the actual
contract conflict before changing it.

The four refuted candidates remain rejected: authenticated versus auth-free
home setup has different contracts; pairing does not need another exported
helper; warning text already distinguishes the gates; missing-Team wording
does not prove a new functional or architectural defect.

## Round-2 correction pre-review: ancestor permissions

The unified predictor resolves the named symlink/order cases, but at that pre-review
called uninstallEntryKey for every path component. That operation enumerates
each parent, imposing read permission on unrelated ancestors that real
deletion does not need. A parent with mode 0333 permits lookup and removal of
a known child but rejects readdir; a disposable non-root filesystem probe
confirmed access/stat and direct config unlink/root rmdir succeed while the
ancestor enumeration returns EACCES. A readable Dreamux root beneath that
parent is therefore a concrete new dry-run failure.

Accept this correction under outcome 4: avoid enumerating unrelated ancestors
merely to compare them with this invocation's known removal entries. Preserve
filesystem case/link semantics for actual candidate entries. Remove the
unnecessary precondition rather than add a permission fallback, OS guess or
swallowed error. The same writer adds full preview/real parity for this layout
and completes current validation before independent review. No product-policy
or operator-ruling conflict is introduced.

## Corrected-tree pre-review after ancestor-permission repair (2026-10-03)

The same writer completed the accepted corrections. The TeamLeader inspected
the resulting uninstall operation and assertion: a visited parent is compared
with the identities of this invocation's known removed entries before any
entry-name enumeration. Unrelated searchable ancestors are not enumerated.
Candidate entries retain actual lookup/case identity and distinguish foreign
hardlinks; raw symlink targets are expanded before parent traversal. The real
access/rm/unlink/rmdir order and foreign/provider-home protection are unchanged.
The uid-1001 fixture asserts an actual EACCES for parent enumeration, exact
preview/real entries and unchanged preview bytes/permissions, and restores the
original mode in finally. It passed in both current full test runs. No error
fallback, permission override, loop cap or new production API was added.

The public factory/default imports in the five native tests use the existing
package entries. Necessary RPC, terminal/version and fake Feishu IO probes
remain explicit test-only internal coupling, as adjudicated above. The
case-sensitive branch executed locally; no case-insensitive volume run,
actual Feishu platform, actual Claude model or hosted CI acceptance is claimed.

The [refreshed matrix](coverage.md) accounts for 1,965 historical identities
with no unmapped obligation. Repository and archived per-package logs agree:
2,608 default tests passed with six explicit model exclusions; 2,614 enabled
tests passed with zero exclusions, including all six actual Codex contracts.
Build, lint, typecheck, typecheck:tests, change verification and full diff
checks passed. All 186 writer-owned file hashes still match the tested bytes.
These checks and TeamLeader pre-review do not replace complete independent
review; both earlier partial reviews remain historical, unpassed evidence.

## Complete round 3 and source adjudication (2026-10-03)

The normal xhigh review completed every finder, including removed behavior
and requirement fidelity: coverage is complete, with no failed seat. Seventeen
candidates were independently verified, three refuted, and seven findings
reported after consolidation. The 213-file input and complete diff hash
remained unchanged through the terminal result. **Complete coverage is not a
pass: accepted source and coverage corrections remain.**

The TeamLeader checked the current requirement, selected solution, original
pre-repair uninstall implementation and current source. Outcome 4 expressly
requires matching root retention with foreign content, no writes in preview,
provider-home protection and preserving the existing removal policy. It does
not require predicting every error from an OS removal syscall. The distinction
below accepts source facts without silently expanding that requirement.

| Finding | Disposition | Source and authorized correction |
| --- | --- | --- |
| Root is a symlink: real rmdir can fail ENOTDIR after removing owned contents | Confirm the operational limitation; outside this bounded preview repair | The pre-repair branch already uses nonrecursive rmdir and propagates every error other than ENOTEMPTY. Its preview already reports planned removal without certifying syscall success. Changing the root-link removal policy or adding a separate error forecast is not required by outcome 4. Retain and document the limitation rather than label it fixed or newly introduced by this repair. |
| Root is a Linux mountpoint: real rmdir can fail EBUSY | Confirm the operational limitation; outside this bounded preview repair | The unchanged rmdir branch propagates EBUSY. A mount detector or portable syscall-error oracle adds a mechanism unrelated to foreign-entry accounting and absent from the authorized solution. No mountpoint execution was performed; the report supplies the syscall trigger. Do not suppress the actual error or invent a product ruling. |
| Config path is a directory: real unlink fails EISDIR/EPERM | Confirm the operational limitation; outside this bounded preview repair | Pre-repair uninstall already warns on config load errors, then calls unlink on accessible config paths. The real failure and planned preview are inherited within the feature branch. Do not change invalid-config deletion policy or represent planned removal as guaranteed successful execution. |
| Relative DREAMUX_ROOT reaches stat('') in config prediction | Accept | The configured root permits relative paths; config-file paths retain that form while directory paths are normalized. Make the private predictor honor the existing path contract, preserving raw link-before-parent traversal. Compare full preview/real entries with foreign content and no preview writes. |
| Direct service-unit parent has write/search permission but no read permission | Accept | removeUserService uses access and rm on the known unit; the predictor adds readdir of its parent. Remove that new precondition within the existing owner. Test the actual unprivileged permission layout with full entries/bytes/permission assertions and finally restore the mode. |
| Surviving hard-error max-lines behavior was wrongly marked superseded | Accept | deleted-tests.md Stage 1 expressly retains the 701-code-line source fixture. ESLint.lintText is behavioral execution, not a source-text scan. Restore the positive hard-error assertion and audit every row of this family against existing named behavioral tests, not generic R46/R55 authority. The old zero-unmapped count was insufficient and does not close this obligation. |
| Duplicate parent stat and repeated final entry-name enumeration | Accept with the predictor correction | Reuse facts already observed by that operation rather than add a cache framework. Parent/root content reads that establish foreign-entry identity remain necessary; redundant IO and unrelated-parent read prerequisites do not. |

The three refuted candidates remain rejected on source evidence: genuine
optional argument-builder callers survive the internal Claude dependency
change; a new string-key helper alone removes no concept; naming the repeated
submission-anchor type does not establish a behavioral or architectural defect.

The same writer owns accepted source/test corrections and the ignored matrix.
The TeamLeader owns the authoritative accounting and knowledge. No accepted
gap, mount detector, permission fallback, new deletion policy or additional
operator decision is introduced. A complete review of the resulting corrected
tree follows current validation.

## Round-3 correction pre-review (2026-10-03)

The same writer completed the accepted corrections. The TeamLeader inspected
the resulting predictor and actual permission/relative-root assertions.
Relative lookup begins at cwd and consumes raw components, preserving the
existing path contract and link-before-parent resolution. Each known deletion
now records its already observed original parent/name/inode once, before
following a final link. This replaces repeated canonical-name enumeration;
ordinary recording needs no direct service-parent read permission. Comparisons
reuse observed identity. Only a genuine ambiguous same-inode name needs actual
directory names to distinguish a case alias from separate hardlinks. Root
content is still enumerated for foreign-entry retention. No cache framework,
mount detector, permission fallback, syscall-success oracle or removal-policy
change was added. Mode-0300 unit-parent and mode-0333 ancestor cases both
executed as uid 1001, compare complete preview/real entries and restore modes.

The real ESLint fixtures now prove the source hard error at 701 code lines,
allow 700 code lines plus blanks/comments, and exempt 701 test code lines.
Runtime namespaces, builtin resolution, wrong-kind-before-import behavior and
lost record-publication construction are exercised rather than classified as
source scans. The writer re-audited all 227 prior decision-bearing mappings;
the TeamLeader checked the corrected families against current source and
named assertions before adopting the [durable matrix](coverage.md). Mixed
behavior/structure obligations retain their behavioral half; R55 is limited
to its actual five removed type directives. No new production export or API
was added to support these tests.

Repository and archived package summaries agree: 2,620 default tests passed
with six model exclusions and the actual auth-free Codex protocol; 2,626
explicitly enabled tests passed with zero skips and all six actual Codex model
contracts, including the strengthened #63. Build, lint, typecheck,
typecheck:tests, change and full diff checks passed. The 189 writer-owned
hashes match the tested bytes. Local filesystem evidence is Linux uid 1001
and the case-sensitive branch, not an insensitive-volume execution. Feishu IO
is fake and Claude protocols are synthetic. All earlier review/check results
remain historical; a whole-tree independent review is pending.

## Complete round 4 and source adjudication (2026-10-04)

The full normal xhigh review completed all seven finders with no coverage
failure. Nine candidates were independently verified; three were refuted
and six findings retained. Complete coverage does not mean acceptance: all
six require in-scope corrections. The same writer owns source/tests and the
ignored evidence matrix; the TeamLeader owns authoritative task/knowledge.

| Finding | Disposition | Source-based correction and scope |
| --- | --- | --- |
| Provisioning overwrites a concurrent route but drops previousTeamName | Accept | routing.bind returns the committed displaced Team. Carry that fact into the existing binding operation and release the displaced presentation before the new claim/announcement, as manual binding already does. Preserve same-Team and failed-commit behavior; do not re-read an already replaced row or add a routing mutex/phase. Cover deferred Team creation, concurrent binding and old COT retirement through actual owners. This directly closes the serving-route retirement outcome. |
| Provider boundary maps to the runtime handle and cites R50 for facade removal | Accept | The four-method AgentRuntime handle is not AgentRuntimeProvider. R50 is per-plugin state directory and authorizes no facade removal. The deleted ledger retains or redesigns actual Provider boundary evidence after a new neutral capability. Exercise the real Provider surface, allow the current neutral capability and correct the map/authority; introduce no frozen wrapper merely to recreate an old fixture. |
| Custom-identity TeamLeader ordering can pass with missing base guidance | Accept | indexOf returns -1 for a missing base fragment. Assert both fragments exist before comparing order in the identity-bearing branch, retaining unique guidance and appended identity. Current production composition is correct. Nearby order assertions need the same source-contract check. |
| Feishu plugin default forwarding wrapper has no caller after entry change | Accept | Root exports createFeishuPlugin and the builtin selects that named export. The package exposes no plugin subpath; the test variable is an alias of the named factory. Remove only the dead internal default wrapper and obsolete loader comment; public provider and named plugin capability stay. |
| Blind Team inventory sends foreign/reserved directory names to entity validation | Accept | Direct get/acquire still rejects invalid caller ids. Filesystem inventory is not such a caller: filter names by the existing Team-id/reserved contract before record reads, without a legacy-path case or detector. ledger, .tmp and backup old must remain inert. Preserve valid/malformed record and actual list-IO semantics. The earliest affected startup is cleanup recovery; one Dispatcher fails while the host continues others, not a whole-daemon refusal. |
| Empty name probe releases its owner before construction reacquires it | Accept | Acquire once for construction and inspect that captured current record before workspace preparation. Preserve synchronous construction arbitration, canonical publication, exactly-once transfer/release, late queue drain and failed checkout cleanup. This removes duplicate temporary store/load/drain lifecycles; occupied names already return early and the held cleanup probe is not a third disk read. |

The refutations remain source-based: narrow audience guards preserve durable
observations and avoid display materialization; actual case/link identity
comparison answers named filesystem cases; a repeated Omit spelling alone
proves no unnecessary concept. No additional product ruling, reservation,
public API, cross-process exclusivity promise or legacy-state policy is added.

A related knowledge-only correction removes the glossary's stale claim of
exclusive filesystem publication. Actual TeamStore.publishRecord uses the
canonical TransactionalStore.update queue; the state owner already describes
serialized publication. The valid record remains the name claim, with no
separate claim file. This correction records current source, not a new
acceptance protocol. Current validation and a whole-tree independent review
follow the six accepted corrections before final closeout or child delivery.

## Round-4 correction pre-review (2026-10-04)

The same writer completed the six accepted corrections. The TeamLeader read
all changed owner paths and their concrete assertions, checked the archived
repository/package logs and verified that all 191 writer-owned hashes still
match the tested tree. No new product choice or implementation blocker was
found in this pre-review. This is not an independent-review pass.

| Accepted finding | Current source and assertion evidence |
| --- | --- |
| Provisioning displacement | The committed bind result carries previousTeamName and rootMessageId into announceProvisioned. A different previous Team is released before claim/receipt; no release for a same-Team bind. The actual router/routing/COT test holds creation behind a barrier, installs B, observes B's live card, then commits A. B receives one interrupted terminal, later B output is absent and A displays. A real atomic-write failure leaves B active and causes no claim/release/receipt; its finally restores fixture IO. |
| Provider evidence | The real Codex factory instance is checked against all seven current neutral Provider keys. Capabilities, config.read and operatorStateRoot execute; optional onboard/diagnostic methods are checked. The adjacent handle test actually awaits createRuntime and checks its four methods. The durable case row distinguishes those contracts and replaces the unrelated R50 attribution with R34's neutral capability. No frozen facade was introduced. |
| Prompt presence | The identity-bearing TeamLeader restore test positively checks both base teammate guidance and composed identity before comparing positions; existing append identity and unique-guidance assertions remain. No production prompt change. |
| Plugin wrapper | Only the unreferenced internal Feishu default forwarding function and stale loader comment are deleted. Named plugin selection, package default Provider and extension contracts remain. |
| Inert inventory | list filters with the existing Team ID pattern and reserved segments before get. Call-through readFile assertions exclude inert paths and preserve their bytes; direct invalid get/acquire still reject. Actual Dispatcher startup completes with ledger, .tmp and backup old residue while valid closed history remains available. Valid-name malformed records and actual inventory IO failures retain their existing contracts. |
| Construction owner | createTeam acquires once, checks the captured current record before workspace work, then publishes and transfers that same handle or releases it in finally. An explicit workspace barrier observes one read of an absent candidate while a second create chooses another name. Occupied-name, canonical competing publication, failure cleanup, detached dissolve and last-holder drain assertions remain. The constructing map supplies only its existing process-local arbitration, not a new filesystem reservation. |

The current coverage matrix preserves distinct Provider, handle, compiler and
namespace assertions. Historical case counts and green tests are not used to
ratify a rewritten test. The glossary now names the canonical publication
queue rather than exclusive filesystem creation. Channel and state owners
record the committed provisioning result and ordinary inventory/construction
boundaries. Full normal xhigh review of the entire resulting tree follows.

## Complete round 5 and source adjudication (2026-10-04)

The normal xhigh workflow completed all finder and verification seats, with
no coverage failure. It returned six findings after root-cause merging and
refuted two candidates. All 219 reviewed input hashes and the complete diff
still match the frozen review input at terminal handling. Complete coverage
is not a pass: five in-scope corrections follow through the same writer.

| Finding | Disposition | Source-based reason and boundary | Operator conflict |
| --- | --- | --- | --- |
| Reentrant Dispatcher assertion inside an isolated hook | Accept | The hook records observed before its only identity assertion, and isolatedTaps swallows hook errors. Capture the reentrant result/error and assert outside isolation, so a hook-only failure cannot pass R43. Current production publishes the service before the hook; this is a coverage defect, not proof of an existing runtime failure. | None; outcome 9. |
| Claude result fixture discards its folded-command argument | Accept as test cleanup | The adapter returns only kind/uuid/outcome, so empty or three-command arrays create no different event. Remove the dead argument and false grouping description while preserving result projections and the separate real multi-submit fold assertion. | None; outcome 9 does not authorize weakening actual folding. |
| Pure retained-record reads await unrelated queued writes | Accept the cost; independently choose a safe owner-level correction | get captures committed current and then waits for temporary-handle release's drain, even while a real owner keeps the record alive. A pure read should return that committed snapshot without adding a write-lifetime barrier. Preserve captured write-handle ownership and last-holder drain. Blindly decrementing a nonlast writer before drain is not proven equivalent: a new acquisition can queue a write after an older drain captured its tail, release early, and let that older release delete the owner while the new write remains pending. Reading an already-held initialized store directly is one lower-concept candidate; the writer must verify current paths and choose the simplest safe shape. | None; same active committed-memory and retired cold-read authority. |
| Three startup history scans | Reject as a required implementation correction; preserve confirmed analytic cost | The 3N read cost is already explicit. Holding every retired record across recovery and Channel.start would give a pure historical scan a new cross-phase lifetime and prevent later cold reads from observing edits/removal. New-record discovery and current-value equivalence remain unproven. A startup-scoped owner/snapshot adds a mechanism without a named startup failure; it does not become paid merely because the cache is temporary. Preserve fresh phase reads and the documented cost. | R74 cold retired reads and existing phase freshness constrain equivalence. |
| Dead test-local Codex detection mirror | Accept | Live compatibility uses the real provider version gate; the local parser/comparator is called only by its own self-tests. Remove the mirror and map surviving malformed-input, floor-boundary and numeric-version behavior to the actual provider-owned functions. Auth-free CLI/protocol and all six real model assertions remain independent and load-bearing. | None; outcome 9 removes false coverage, not native evidence. |
| Duplicate committed-bind presentation protocol | Accept within BindingOperations | Manual and provisioning paths separately implement displaced release, claim, bound card and first-anchor offer. Put the shared post-commit protocol in its existing owner and remove both duplicate bodies; preserve manual alternate receipt target/root fallback and provisioning's committed root, same-Team behavior and failed-commit silence. Do not add a routing owner, public seam, durable fact or generic receipt mechanism. | None; outcomes 7 and 8. |

The two refuted candidates remain refuted on current source. acquire's loader
returns null for malformed/unreadable records, so its alleged uncaught load
failure is not a reachable holder leak in the reviewed path. servingTarget
is Channel-owned provenance captured from the actual route; it does not put
Feishu policy in Core or require another authoritative target model.

Prior local checks remain historical once these source/test corrections begin.
Current named assertions, gate results, matrix mappings and a new whole-tree
normal review are required before final knowledge closeout or child delivery.
No new product ruling is requested or claimed.

## Round-5 correction pre-review (2026-10-04)

The same writer completed the five accepted corrections. The TeamLeader read
all changed owner paths and concrete assertions, checked repository and
archived package summaries and matched all 192 writer-owned hashes to the
tested bytes. No new requirement conflict or implementation blocker was found
in this pre-review. Full corrected-tree independent review still follows.

| Correction | Current evidence |
| --- | --- |
| Dispatcher observation | The isolated callback records the actual reentrant get return or error; test-body assertions require no errors, one matching observation and exact object identity. Those assertions cannot be swallowed by hook isolation. Existing cwd, frozen hook table and no-runtime checks remain. |
| Claude result fixture | resultEvent now accepts only actual outcome/uuid fields. One native-result projection names that event honestly; custom UUID, usage and exact terminal projection assertions remain. Separate runtime tests actually submit and fold inputs and exercise background behavior. |
| Retained reads and drain | get validates the ID and joins an existing entry's load promise without another hold or write-tail wait. Cold reads still acquire/release, and every write-handle release retains its hold through drain. Explicit barriers prove get/list return the same committed running or held-closed snapshot while the write is blocked. A second barrier case proves a later writer remains counted after an earlier release captured an older tail and prevents a competing disk record from replacing its owner. The developer's early-decrement mutation failed that pending-release assertion; source was restored before final gates. |
| Codex version owner | The local Detection/parser/comparator is deleted. Co-located tests execute parseCodexVersion and codexVersionSatisfies for actual historical examples, malformed/empty/incomplete strings and numeric supported-floor boundaries. Matrix rows separate parsing from supported-version policy; the null test-only sentinel is retired without a cast or new production API. Real CLI/protocol and all six model cases remain separate. |
| Committed bind presentation | Both manual binding and provisioning call one existing BindingOperations presentation method. It releases a different previous owner, claims the new one, computes receipt landing/root, builds the card and conditionally offers the first anchor. Same-target notices use the captured committed root even after later routing changes. Alternate notices use their own root then invoking message and cannot anchor the bound Team. Same-Team and failed-commit behavior plus observable displaced-card retirement remain. |

The current matrix contains 1,965 unique historical identities with no unmapped
or pending-run entry; this is accounting, not proof by count. The three startup
history scans and documented syscall limits remain unchanged. Current state
knowledge and the selected solution now distinguish pure retained reads from
write-lifetime holds without adding a cache or weakening retirement. Prior
review reports and gate logs remain historical.

## Complete round 6 and source adjudication (2026-10-04)

The normal xhigh workflow completed every finder and verification seat with
no coverage failure. It returned five confirmed findings and one plausible
cleanup candidate, and refuted five candidates. All 220 tracked review-input
hashes still matched the frozen tree at terminal handling. Complete coverage
is not acceptance: the same source writer now applies five narrow corrections.

| Finding | Disposition | Source-based reason and boundary | Operator conflict |
| --- | --- | --- | --- |
| Close-race completion test checks only the refused delivery | Accept | The pre-close request is queued before the synchronous fence change, but awaiting its resolved promise does not prove preparation or submission. Record both actual calls and the completion payload, then assert in the test body. Keep production admission at request time and the late request's zero-call assertions. | None; outcome 9 restores the surviving queued-delivery contract. |
| Request identity comments promise permanent replay and name ownership | Accept as documentation | acceptedRequest scans valid Team records; R74 makes deletion or damage of fully retired ownerless history visible. Narrow create-request and provisioning comments to replay while the valid record exists. The selected solution and Channel owner already state that boundary. No runtime or persistence change follows. | None; synchronizes the existing R74 choice. |
| Exact binding lookups decode their target again | Accept | bindingFor matches targetKey exactly, and sameTarget uses that key. The binding-card offer and provisioning's waiting-message path can use their in-scope target after the same ownership checks. Remove their redundant decoder imports and restore the decoder's private scope. Actual parent fallback still uses plan.matched; servingTarget remains. | None; outcome 7's provenance is preserved. |
| Event fixture maintains a second unused log-capture shape | Accept within existing test helpers | The event helper's warnCalls/errorCalls arrays have no assertion consumer. Its callers need only DreamuxLogger, which command-harness already supplies through capturingLogger. Reuse that helper and delete the duplicate interface/method table, without another wrapper. The separate actual-pino event-catalog fixture has real warning consumers and stays. | None; outcome 9 removes test-only maintenance cost. |
| Maintenance description says every builtin uses a named factory | Accept as documentation | The runtime/channel builtins select named plugin factories, while bootstrap selects default from the catalog. Narrow the description to those actual entries; do not alter loader dispatch or exports. | None; outcome 8 requires accurate current maintenance guidance. |
| release map-identity check is claimed unreachable | Reject as a required deletion; retain the unproven candidate | The claim depends on retain occurring only before a handle's release. Direct leader MCP admits TeamService.dissolve, which awaits worktree assessment before retain; initial-prompt failure can independently close and release construction, and lease revocation does not cancel admitted calls. That span has not been excluded. Ordinary paired-holder paths alone do not establish safe removal of the exact-entry retirement check. No extra state, fence, defense or runtime guarantee is introduced, and this is not a confirmed runtime defect. | No product choice is required; capability-neutral deletion has not been proved. |

The refuted candidates remain refuted on current source: released-route
interrupt matching and future-anchor admission intentionally answer different
policy questions; inventory shape filtering is not a second entity-validation
boundary; the provisioning decoder duplicate is included in the accepted
two-site correction; explicit builtin export selection is required by the
public provider/plugin split; and the anchor seam carries Channel-owned
serving-route provenance. Prior green gates remain historical until the
correction tree is tested and independently reviewed again.

## Round-6 correction pre-review (2026-10-04)

The same writer completed all five accepted corrections. The TeamLeader read
current producer/consumer paths and changed assertions, parsed the eight actual
package logs, checked the Linux permission evidence and matched all 192 tested
file hashes. No requirement conflict or implementation blocker was found in
this pre-review; complete independent resulting-tree review still follows.

| Correction | Current evidence |
| --- | --- |
| Completion close race | The test observes an empty call list before queued execution, then closes admission. Test-body assertions require actual prepare then submit, the exact completion object at both stages, and zero calls for the late request. No assertion is hidden inside production catches; the production delivery policy is unchanged. |
| Replay comments | Core request identity and both provisioning explanations now scope replay/name claims to the valid record. Fully retired deletion/damage can remove the claim; no runtime or acceptance-point change was made. |
| Exact serving route | The binding-card offer uses target after binding ownership checking, and the waiting provisioning message uses input.target after exact bindingFor lookup. The decoder is private again, matching HEAD. Actual parent-fallback provenance remains carried by the matched route elsewhere; fallback and waiting-message tests assert the target values. |
| Logger fixture | The unused CapturingLogger interface, arrays and method table are deleted. Event and privacy callers reuse command-harness capturingLogger with their existing owner assertions. The actual-pino warning/error observer has distinct consumers and remains unchanged. |
| Builtin guidance | The maintenance reference names the actual runtime/channel factories and bootstrap default selection. Loader dispatch, catalog exports and third-party behavior are unchanged. |

The plausible map-identity candidate caused no retain/release/drain or new
lifecycle change. All 1,965 historical identities retain named dispositions,
including the strengthened queued-completion row. Default 2,634 passes with six
model exclusions and enabled 2,640 passes with zero skips are backed by actual
package summaries; all six native Codex cases ran. Counts remain accounting,
not independent acceptance. Filesystem evidence remains Linux uid 1001 and the
case-sensitive branch; real Feishu, actual Claude, an insensitive volume and
hosted CI are not claimed.

## Complete round 7 and source adjudication (2026-10-04)

The normal xhigh workflow completed every finder and verifier without coverage
failure. Four independent confirmed findings survived; two candidates were
refuted. All 220 frozen input hashes matched at terminal handling. The same
source writer corrects the three independently implementable items and verifies
the unreadable-root contract conflict before changing its policy.

| Finding | Disposition | Source and authorized boundary |
| --- | --- | --- |
| Unreadable root adds a preview-only read-permission premise | Confirm and investigate the contract boundary | A mode-0300 root allows known-file unlink and rmdir but refuses readdir. Source and an actual uid-1001 private fixture prove the new EACCES preview failure while real foreign-content retention succeeds. Empty and nonempty unreadable roots are indistinguishable to enumeration, yet real root removal differs. The [concrete decision preparation](unreadable-root-preview.md) separates truthful partial unknown output from an explicit fail-loud observation boundary; no option is an operator ruling yet. Do not invent a filesystem oracle, mutate during preview, or mislabel unknown as retained. |
| Pending Feishu note claims the reminder was removed | Accept | leaderIdentity still appends the initial message address and mandatory reply guidance; actual provisioning tests observe it. R41 explicitly superseded the deletion inference. Correct the pending note, preserving source prompt/guard behavior. |
| Team create entry promises unconditional permanent replay | Accept | acceptedRequest uses valid records, and R74 exposes deletion/damage after full retirement. Narrow the entry comment and same-owner descriptions to that valid-record boundary, without changing runtime replay or name claims. |
| Recreated secure-default README prose scan | Accept as a coverage correction | The restored case locks Markdown phrases and short regex distances; harmless reflow fails it. Outcome 9 forbids recreating source/path assertions. Remove the new scan and map every executable surviving fact to actual default/gate, filesystem, config or doctor owners. Keep current documentation instructions and unrelated unchanged lexical checks; no blanket retirement replaces missing behavioral evidence. |

The public ABI candidate remains refuted: compiler directives carry an actual
negative contract rather than proof by literal-object runtime assertions. The
missing-record wording candidate remains a nonfunctional wording difference,
with no paid reason for another normalization mechanism. Current gates are
historical until the accepted correction tree and its boundary are resolved.

## Round-7 independent correction pre-review (2026-10-04)

The same writer completed the three independent corrections. The TeamLeader
read their current source and actual owner assertions, checked the two archived
package summaries and matched all six correction-file hashes. Comparing the
preceding 192-file manifest found only the five expected changed files; the
sixth correction is the same-owner Team MCP description. No other writer file
changed. This is a pre-review and selected-package verification checkpoint,
not final resulting-tree acceptance.

| Correction | Current evidence |
| --- | --- |
| Feishu release note | The pending stage-8b note now describes the retained configured identity, triggering message address and reply guidance. Production leaderIdentity and its restored provisioning assertions are unchanged. The superseded deletion inference is no longer published as current behavior. |
| Valid-record replay | The Team create entry and acceptedRequest comments scope replay to the valid acceptance record. The Team MCP description drops its unconditional never-reused-name promise. R74 retirement, name arbitration and replay implementation are unchanged. |
| README scan replacement | Only the newly restored secure-default prose scan is removed. Its historical identity remains mapped per surviving fact: actual FeishuAccess decisions and commits, version rejection, expired/concurrent pairing, policy-preserving approval, actual config command output and configured doctor behavior. New owner assertions stat the absent-directory commit at 0700 and first file at 0600, assert the complete persisted V3 policy, and compare doctor output before and after access-file damage. Unrelated unchanged lexical checks remain outside this correction. |

The actual unchanged runUninstall owner independently confirmed the unreadable
root conflict on Linux uid 1001. Both previews fail with EACCES; actual removal
returns removed for the otherwise-empty root and skipped for the root containing
foreign bytes. Preview preserves bytes and permissions; finally cleanup removed
both fixtures. Source and executed-artifact hashes match current files. Service
commands are intercepted, so this is owner/filesystem evidence rather than real
systemd or CLI acceptance.

The [preview choice](unreadable-root-preview.md) remains pending. Existing
warnings and omission of an indeterminate root row could expose a truthful
partial preview without a new public status enum; that is a proposal, not
authorization. No policy change, guessed root status or preview mutation has
been implemented. Full gates, six current native-model cases, complete
independent review and final KB closeout wait for that decision and its source.
