# PR #453 review-repair verification

Recorded 2026-10-03. This continuation implements the [active requirement](../../artifacts/review-fixes-20261003.md), revision 2 with R76's alias boundary, and [selected solution](final.md). The operator's direct repair instruction and R74/R75 authorize the work; no additional development card is claimed. Parent PR #453 merging into `next` remains outside this delivery authority.

## Final local acceptance and operator-stopped review (2026-10-08)

R77 records “停掉最后这次复审”. The final corrected-tree workflow was
stopped at scope confirmation before any findings or synthesized result. It
will not restart and is not a complete independent review or pass. Completed
preceding reviews and accepted corrections are preserved in
[implementation review](implementation-review.md#final-review-stopped-by-the-operator-2026-10-08).
The TeamLeader verified the current owner/assertions, all 199 tested hashes,
actual eight-package outputs and all 1,965 historical mappings before closeout.

| Current local verification | Recorded result |
| --- | --- |
| Repository Rush build, lint, typecheck, typecheck:tests | Passed |
| Default Rush test with both live selectors unset | 2,648 passed; six explicit model exclusions; actual auth-free protocol ran |
| Rush test with DREAMUX_RUN_LIVE_MODEL_GATE=1 and Codex exclusion unset | 2,654 passed; zero skips; all six actual Codex contracts ran |
| Rush change verification against origin/next without fetch | Passed |
| Complete diff check against HEAD | Passed |

Actual Codex coverage includes effort/reset/cold resume, persisted continuity,
portable structured output, growing activity, unbound-turn termination and
#63. Both #63 ACK-before-blocking-completion assertions remain. Source/test
bytes are unchanged by knowledge closeout. Model exclusions do not count as
native evidence. Feishu/service IO is fake; Claude fixtures are synthetic.
Filesystem evidence is Linux uid1001 and case-sensitive mode0300/0333 paths.
No real Feishu/Claude/service-manager or insensitive-volume acceptance is claimed.
Normal hosted CI remains a separate delivery gate. Startup retains its recorded
3N cold-history scan cost; R76 leaves physical provider aliases unprotected.

## Knowledge owners reconciled for child delivery

| Owner | Closeout fact |
| --- | --- |
| [Product catalog](/.agents/product/README.md) | R74 retired history, accepted CLI/read/shutdown deltas, R75 root removal and R76 normalized-path boundary |
| [State/config](/.agents/domains/state-config-and-files.md), [orchestration](/.agents/domains/dispatcher-orchestration.md), [scheduling](/.agents/domains/scheduled-work.md) | Captured serialized record owner, last-writer drain, precheck/recovery holds, valid-record name/replay boundary and retained 3N scan cost |
| [Service topology](/.agents/domains/service-topology.md), [channel](/.agents/domains/channel.md) | Direct core event bus, source leases, no-source DTO production guard; durable observation and no historical replay remain |
| [MCP guidance](/.agents/domains/dispatcher-skill.md), [glossary](/.agents/glossary.md) | Returned concrete Team names, valid-record occupation and canonical serialized name publication; no exclusive cross-process filesystem claim |
| [Plugins](/.agents/domains/plugins.md), [providers](/.agents/domains/provider-runtime.md) | Neutral provider defaults, plugin exports selected by registry, bootstrap default exception and required internal Claude dependencies |
| [Feishu access](/.agents/domains/feishu-pairing-access.md), [channel](/.agents/domains/channel.md) | Commit-time expiry pruning, serving-route provenance, committed/silent route release and provisioning displacement; restored test references |
| [Inbound](/.agents/domains/non-blocking-dispatcher-inbound.md), [unit tests](/.agents/domains/unit-testing.md) | Real #63 ACK before blocking completion, six explicit native contracts and behavior-owner coverage rather than source mirrors |
| [Maintenance](/packages/dreamux/skills/dispatcher/dreamux-maintenance/SKILL.md), package guidance and READMEs | Current-only config/state references, server-owned files and normalized-path uninstall limits; same tested bytes |
| [Task requirement](../../artifacts/review-fixes-20261003.md), [solution](final.md), [rulings](../../rulings.md), [coverage](coverage.md) | Actual authorized scope, every accepted finding disposition, all 1,965 historical identities and R77 stopped-not-pass boundary |
| [Earlier evidence](../../verification.md), [ownership artifact](../../artifacts/ownership-follow-up.md), [deleted-test ledger](../../artifacts/deleted-tests.md) | Historical scope preserved and current repair/coverage pointers supplied |
| [KB routing](/.agents/root.md) | N/A: no new domain or discovery path; existing owner routes remain accurate |

Knowledge closeout changes only authoritative records. The current tested
source, tests, package guidance and change-note hashes remain unchanged.
The actual commit must run the mandatory anti-leak hook, and normal child-PR CI
must pass before the authorized child merge. The feature-branch Actions alpha
and designated tester handoff use existing authority after that delivery.
No parent-next merge, stable/beta publication or Team dissolution is authorized.

## Historical knowledge-and-diagnostic verification (2026-10-08)

Both accepted residuals are corrected and pass [TeamLeader pre-review](implementation-review.md#historical-knowledge-and-diagnostic-teamleader-pre-review-2026-10-08).
The current MCP page now limits Team name occupation to valid records under
R74 and links its owner. The only source/test change is the common pre-commit
log summary and its existing expectation; reversing those strings matches the
preceding file hashes. Receipt, error, running/retry, cron/runtime, hold/drain
and cleanup assertions/behavior remain. The assessment-failure path is
source-traced; no new real-platform failure probe is claimed.

All 199 tested hashes and actual eight-package summaries match. Current Rush
build, lint, typecheck, typecheck:tests, change verification and diff check pass.
Default tests pass 2,648 with six explicit model exclusions and actual auth-free
protocol. Enabled tests pass 2,654 with zero skips and all six actual Codex
contracts, including both strengthened #63 assertions. All 1,965 historical
identity and contract/target mappings remain. KB has only the intentional
review-state issue; final done closeout is pending. Complete corrected-tree
independent review, actual commit and authorized child/alpha delivery remain.
R76 and external acceptance limits remain. Cron jobs stay cancelled.

## Historical production-entry global-home verification (2026-10-08)

The one complete-review coverage finding is corrected and passes TeamLeader
pre-review. The test directly exercises the production identity-bearing doctor
context for three identities under default and explicit home environments,
asserting identity and exact home/config paths. The production owner remains
identical to HEAD. An actual owner mutation rejects the named assertion; the
restored control passes 177 provider tests. [Pre-review](implementation-review.md#global-home-teamleader-pre-review-2026-10-08)
records the one-file diff, current 199 hashes and actual package outputs.

Current Rush build, lint, typecheck, typecheck:tests, change verification and
diff check pass. Default tests pass 2,648 with six explicit model exclusions
and actual auth-free protocol. Enabled tests pass 2,654 with zero skips and
all six actual Codex contracts, including both strengthened #63 assertions.
Only historical L63 changes; all 1,965 identities remain. This coverage probe
is distinct from native-model evidence. R76 and existing owner boundaries
remain. Complete corrected-tree independent review, KB closeout and actual
commit/child/alpha delivery are still pending. Cron jobs remain cancelled.

## Historical authentication-fixture verification (2026-10-08)

The TeamLeader verified the only changed writer path, unchanged eight original
assertion bodies, all 199 tested hashes and the actual package summaries. A
synthetic inherited-credential run reproduces two old failures. The corrected
suite passes under the same inputs, and a temporary imported-suite afterAll
assertion confirms all three credentials restore in that worker. The probe is
removed before normal gates; no real credentials were read or printed. The
[current pre-review](implementation-review.md#authentication-fixture-teamleader-pre-review-2026-10-08)
records the distinction between regression/restoration proof and full gates.

Build, lint, typecheck, typecheck:tests, change verification and diff check pass.
Default tests pass 2,648 with six explicit model exclusions and actual auth-free
protocol execution. Enabled tests pass 2,654 with zero skips and all six actual
Codex contracts, including both strengthened #63 order assertions. Only two
historical authentication rows change; all 1,965 identity keys remain. No
production authentication, R76, ownership, pairing or COT behavior changes.
Complete corrected-tree independent review and final delivery gates remain;
the external acceptance limits below still apply. Cron jobs remain cancelled.

## Historical complete-review correction boundary (2026-10-08)

The complete normal xhigh review found one authentication-fixture defect.
The TeamLeader matched the frozen files/diff/index/refs and read the current
owner and assertions. [Adjudication](implementation-review.md#complete-authentication-fixture-review-disposition-2026-10-08)
accepts test-only isolation of inherited credentials, preserving actual provider
authentication support and the explicit R76 boundary. The preceding full gates
below do not certify the next changed fixture. Final review, knowledge closeout
and authorized child/alpha delivery remain pending; no cron job is created.

## Historical R76 correction verification (2026-10-08)

The TeamLeader verified all 199 current writer hashes, all eight changed
writer paths, the actual package logs and the inherited-native-home before/after
regression. Four accepted corrections are complete, and R76's alias scenario
remains uncorrected as selected. The [current source and assertion pre-review](implementation-review.md#r76-correction-teamleader-pre-review-2026-10-08)
records each correction and the index-synchronization boundary.

| Current repository command | Result |
| --- | --- |
| Rush build, lint, typecheck and typecheck:tests | All passed |
| Default Rush test with both selectors unset | 2,648 passed; six explicit model exclusions; actual auth-free protocol ran |
| Rush test with DREAMUX_RUN_LIVE_MODEL_GATE=1 and Codex exclusion unset | 2,654 passed; zero skips; all six actual Codex contracts ran |
| Rush change verification against origin/next without fetch | Passed |
| Complete diff check against HEAD | Passed |

The six native cases and both #63 acknowledgement-before-completion assertions
remain. The fixture probe uses actual filesystem/owner calls with fake service
IO; it is distinct from enabled Codex model evidence. Other platform and external
acceptance limits below remain. Complete corrected-tree independent review,
KB closeout and the real commit hook are pending. Alpha and tester handoff occur
after authorized feature-base delivery; parent-next merge is not authorized.

## Historical full-review correction boundary (2026-10-08)

The corrected-tree review completed all coverage seats and returned six
independent findings. All frozen file/diff/ref identities matched at terminal
handling. [Per-finding adjudication](implementation-review.md#complete-alias-and-delivery-review-disposition-2026-10-08)
accepts four same-writer implementation corrections and one TeamLeader index
synchronization. R76 explicitly rejects correction of the provider-home alias
scenario after its same consequence on next was explained. No alias mechanism
was dispatched. Current worktree assertions and native gate evidence remain
valid for the preceding tested bytes only; new source fixes need new gates and
whole-tree independent review. No review pass or alpha publication is claimed.
Cron jobs remain cancelled.

## Historical corrected R75 TeamLeader pre-review (2026-10-08)

The TeamLeader checked the full correction source and assertion bodies, ordinary
notes, owning maintenance guidance, all 199 tested file hashes and all eight
archived package summaries. Root removal retains R75 existence-only preview and
recursive deletion; the existing pre-service check now rejects a removal path
containing a protected provider home as well as one inside it. Both native
provider-home variables and root/state/run/cache/log containment are tested with
unchanged marker/config/service bytes and zero service calls.

The previously plausible direct-leader precheck schedule is confirmed by the
production-minted MCP lease and real managed-worktree cleanup, with ambiguous
native admission supplied by a controlled provider fixture. Before correction,
late accepted publication changed disk while a cold-acquired owner and public
summary retained the old note. The existing hold now begins before precheck and
transfers to accepted cleanup, or releases on refusal/concurrent join. The fixed
regression observes one owner, zero cold reloads and equal disk/held/public state;
after final release it again observes retired edits from disk. Dirty precheck
refusal and concurrent joins pin exactly-once release. The
[pre-review disposition](implementation-review.md#corrected-r75-teamleader-pre-review-2026-10-08)
records the evidence and preserved boundaries.

| Current repository command | Result |
| --- | --- |
| Rush build | Passed; one operation rebuilt, eight already up to date |
| Rush lint, typecheck and typecheck:tests | All passed |
| Default Rush test, both live-gate selectors unset | 2,648 passed; six explicit model exclusions; actual auth-free protocol ran |
| Rush test with DREAMUX_RUN_LIVE_MODEL_GATE=1 and Codex exclusion unset | 2,654 passed; zero skips; all six actual Codex cases ran |
| Rush change verification against origin/next, no fetch | Passed |
| Complete diff check against HEAD | Passed |

The six enabled contracts include #63 acknowledgement before both blocking
item/completed and native turn/completed, effort/reset, persisted resume,
structured output, running activity and an unbound terminal. Feishu IO and service
commands are fake; Claude protocols are synthetic. Actual filesystem evidence
is Linux uid 1001 on the case-sensitive branch, including restricted roots,
unit parents and ancestors. No real Feishu/Claude, service-manager,
insensitive-volume or hosted CI acceptance is claimed. Counts and the 1,965
historical dispositions are accounting, not coverage proof. Complete
corrected-tree independent review and final KB closeout remain pending. The
operator cancelled scheduled jobs; no reminder is created.

## Historical R75 full-review result and correction boundary (2026-10-08)

All finder and verification seats completed. The TeamLeader matched every frozen
input hash and the complete diff before adjudicating five findings. The
[per-finding disposition](implementation-review.md#complete-r75-review-disposition-2026-10-08)
accepted provider containment and three narrow test corrections, and required
actual proof of the asynchronous precheck schedule. The same writer completed
those corrections and the proof as recorded above. This finding-bearing full
round was not a pass. No independent pass, final KB or child delivery is claimed.

## Historical initial TeamLeader pre-review

The single writer completed all nine outcomes. The TeamLeader inspected the complete production diff, source-adjacent guidance, change notes, current knowledge owners, named repair assertions and the final repository logs. No unresolved implementation defect was found in this pass. The following boundaries were specifically traced:

- Team records share one initialized owner and captured queue. Actual construction, tracked service, detached dissolve and recovery holds release after drain; only absent or fully retired records are removed. Direct initial-leader MCP self-dissolve, late queued running writes, failed construction, tracking transfer and physical cleanup have observable owner-level assertions. The existing closed signal, closed terminality and pending-cleanup recovery remain.
- Official package roots restore correctly typed provider defaults. The builtin catalog selects named runtime/channel plugin factories and bootstrap's default plugin factory. Existing configured npm refs load without rewriting configuration. Third-party entry selection and official duplicate-plugin refusal remain.
- Core consumers receive the actual event bus through the existing narrow publisher interface; source leases remain revocable. The additional no-audience guard restores the retained historical aggregate contract, independently of the facade removal, without skipping committed roster observations or introducing replay.
- Successful-send pairing commits prune expired pending entries against the latest state after concurrent approval checking. COT keeps visible target policy and captures the actual serving route; parent release retires inherited topics, exact independent routes remain, and silent committed removals retire while failed commits do not.
- Uninstall previews match nonrecursive removal and foreign-content retention. Claude's two mandatory internal dependencies and activity-validation comments were narrowed without changing valid builder seams or validation behavior.

All restored/adapted assertions were judged against current ownership and the retained contracts, rather than using a green run to ratify rewritten expectations. The [case accounting](coverage.md) links surviving obligations to current named assertions or precise superseding decisions. Historical counts are a discovery aid, not an independent proof.

The initial historical census missed conditional Vitest selectors, including five native-provider cases beside #63. Direct source inspection exposed the omission; the developer corrected discovery and restored all six actual Codex contracts. The strengthened #63 test requires second turn/start acknowledgement before the blocking command's item/completed, as well as native turn/completed. It also proves same-turn folding, marker processing after the command, actual MCP tool exposure, absent automatic reactions and usable explicit react.

## Historical initial local validation

The TeamLeader checked these initial single-writer logs against the round-1 implementation. No source/test change followed this run before the first independent review. Accepted corrections after that review require new validation; the results below do not certify the corrected tree. The build uses normal Rush dependency and incremental behavior.

| Repository command | Result |
| --- | --- |
| `node common/scripts/install-run-rush.js build` | Passed, 2.73s |
| `node common/scripts/install-run-rush.js lint` | Passed, 9.24s |
| `node common/scripts/install-run-rush.js test` | Passed, 177 files / 2,598 tests, no skipped live case, 2m 50.8s |
| `node common/scripts/install-run-rush.js typecheck:tests` | Passed, 10.23s |
| Rush change verification against the recorded historical parent baseline | Passed |
| `git diff --check` | Passed |

Actual Codex 0.159.0 app-server/model checks cover native effort persistence/reset, actual thread persistence/resume, portable structured JSON, provider disk activity reads during a live turn, an unbound native terminal and #63 through Server/Dispatcher/MCP. Feishu platform IO is fake. Claude session/RPC tests use real Node subprocesses with synthetic protocol; no actual Claude CLI or real Feishu network acceptance is claimed. CI evidence belongs to the GitHub run, not these local checks.

## Independent review and knowledge closeout

The first xhigh workflow returned six findings with partial coverage: the removed-behavior finder did not return a usable result. The [TeamLeader adjudication](implementation-review.md) records accepted in-scope corrections, the startup scan tradeoff and the historical model-gate execution boundary. The same writer applies corrections before another complete independent review. No independent-review pass or final knowledge gate is claimed. The task README owns the in-flight state and must be reconciled before delivery.

## Historical round-2 corrected-tree validation (2026-10-03)

The same writer completed the accepted corrections, including the TeamLeader's
ordered-config source check. The TeamLeader inspected the full correction diff
and checked the final repository and per-package logs. The
[source adjudication](implementation-review.md#corrected-tree-teamleader-pre-review-2026-10-03)
records each accepted item and its concrete assertion. The corrected
[case matrix](coverage.md) retains all 1,965 discovered historical identities
with no unmapped obligation; counts are accounting, not a replacement for
the named assertions and precise superseding decisions.

| Repository validation | Current result |
| --- | --- |
| Rush build | Passed, 2.70s |
| Rush lint | Passed, 9.10s |
| Default Rush test, both live-gate variables unset | Passed: 174 files / 2,601 tests; six model cases explicitly excluded; real auth-free protocol check passed, 1m 7.7s |
| Rush test with DREAMUX_RUN_LIVE_MODEL_GATE=1 and Codex exclusion unset | Passed: 177 files / 2,607 tests; no skips; all six real Codex cases ran, 3m 0.5s |
| Rush typecheck:tests | Passed, 10.32s |
| Rush change verification against the recorded historical baseline | Passed |
| Complete diff whitespace check against HEAD | Passed |

The enabled #63 case passed in 31.895s; the three effort/resume/schema cases
passed in 57.934s and the two activity/native-terminal cases in 23.392s.
The sole-holder drain mutation intentionally failed its release-pending
assertion, then the original source was restored before final gates. These
results preserve the distinction between default protocol compatibility and
actual authenticated model evidence. Feishu platform IO remains fake, Claude
subprocess protocols remain synthetic, and hosted CI has not yet run on this
uncommitted repair. The initial partial independent round is not a pass;
complete independent review and final knowledge closeout are pending.

## Round-2 review disposition

Round 2 covered removed behavior but returned partial coverage because
requirement fidelity failed to return a usable result. The
[per-finding adjudication](implementation-review.md#historical-round-2-and-source-adjudication-2026-10-03)
accepts three concrete uninstall prediction defects, one knowledge anchor
correction and the already-public portion of the live-test import cleanup.
The same writer corrects source and assertions before another complete review;
the TeamLeader fixes knowledge. No accepted runtime finding is dismissed using
the previous green tests. The partial review and its failed seat are not a
merge certificate. Updated tests and imports require current gate evidence.

## Historical round-4 corrected-tree validation

The same writer completed the accepted round-2 source/test corrections and
the TeamLeader's ancestor-permission correction. The TeamLeader checked the
full correction diff, current repository and archived package logs, actual
uid-1001 filesystem output and all 186 writer-owned file hashes. The checked
files match the final tested bytes. [Source adjudication](implementation-review.md)
and the refreshed [case matrix](coverage.md) record the named assertions and
account for all 1,965 discovered historical identities with no unmapped item.

| Repository validation | Result for the current corrected tree |
| --- | --- |
| Rush build | Passed, 2.71s |
| Rush lint | Passed, 9.20s |
| Default Rush test, both live-gate variables unset | 2,608 passed; six model cases explicitly excluded; actual auth-free protocol and non-root permission assertion executed, 1m 7.7s |
| Rush test with DREAMUX_RUN_LIVE_MODEL_GATE=1 and Codex exclusion unset | 2,614 passed, zero skipped; all six actual Codex model cases executed, 2m 54.7s |
| Rush typecheck | Passed, 6.37s |
| Rush typecheck:tests | Passed, 10.38s |
| Rush change verification against the recorded historical baseline | Passed |
| Complete diff whitespace check against HEAD | Passed |

Actual execution was Linux uid 1001 on a case-sensitive filesystem. The
case-insensitive branch is an encoded assertion, not a locally executed
platform result. Feishu IO remains fake; Claude subprocess protocols remain
synthetic. Complete independent review and final KB closeout are pending;
no hosted CI or parent-PR merge acceptance is claimed by these local checks.

## Complete round-3 review: accepted corrections pending

All seven finders returned usable results, including the previously missing
removed-behavior and requirement-fidelity seats. Coverage is complete; this is
not a pass because accepted relative-path/unit-parent prediction and ESLint
coverage corrections remain. The [per-finding source adjudication](implementation-review.md#complete-round-3-and-source-adjudication-2026-10-03)
records all seven findings and the three refutations, separates existing OS
removal-error limitations from the bounded foreign-content preview requirement,
and gives the same writer the in-scope corrections. The corrected matrix must
replace its false generic retirement of real ESLint behavior before final
coverage is claimed. Current validation and another whole-tree review are
required after the source/test changes.

## Historical round-5 corrected-tree validation

The accepted complete-review corrections and family-level accounting audit
are implemented. The [TeamLeader pre-review](implementation-review.md#round-3-correction-pre-review-2026-10-03)
checked source, named assertions, current logs, filesystem execution conditions
and all 189 writer-owned hashes. The [corrected matrix](coverage.md) retains
1,965 historical identities with named evidence or precise superseding
contracts; count completeness alone does not establish behavioral coverage.

| Repository validation | Result for the current corrected tree |
| --- | --- |
| Rush build | Passed, 7.06s |
| Rush lint | Passed, 9.29s |
| Default Rush test, both live-gate variables unset | 2,620 passed; six model exclusions; real auth-free protocol and both non-root permission fixtures executed, 1m 7.7s |
| Rush test with DREAMUX_RUN_LIVE_MODEL_GATE=1 and Codex exclusion unset | 2,626 passed, zero skipped; all six actual Codex model cases executed, 2m 52.2s |
| Rush typecheck | Passed, 6.35s |
| Rush typecheck:tests | Passed, 10.32s |
| Rush change verification against the recorded historical baseline | Passed |
| Complete diff whitespace check against HEAD, including new-file diagnostics | Passed |

The private lookup now records the already observed directory entry and avoids
unnecessary parent enumeration. Actual Linux uid-1001 mode-0300 unit-parent
and mode-0333 ancestor tests passed; only the case-sensitive branch executed.
No real Feishu, actual Claude CLI/model or hosted CI evidence is claimed.
The unchanged syscall limitations remain explicitly documented. The first
complete independent review did not pass; the resulting corrected tree still
requires complete independent review and final KB closeout before delivery.

## Complete round-4 review: accepted corrections pending

All finder/verification coverage completed, but six accepted defects remain.
[Source adjudication](implementation-review.md#complete-round-4-and-source-adjudication-2026-10-04)
records provisioning displacement, actual Provider evidence, prompt fragment
presence, the dead internal plugin wrapper and Team inventory/construction
costs. The corrected Provider map must not cite the runtime handle or R50
facade authority. The writer supplies actual owner assertions and current
validation; another full independent review follows. Earlier default/model
runs are historical checks, not proof that these omissions are closed.

## Historical round-6 corrected-tree validation (2026-10-04)

All six accepted complete-round-4 findings are implemented. The
[TeamLeader pre-review](implementation-review.md#round-4-correction-pre-review-2026-10-04)
traces their actual owner paths and named assertions. The TeamLeader checked
repository and archived per-package logs, real filesystem execution output
and all 191 writer-owned file hashes against the current bytes. The refreshed
[case matrix](coverage.md) removes the false Provider mapping and ruling
attribution; 1,965 historical identities have current dispositions, with no
unmapped or pending-run entry. Accounting does not prove behavior by itself.

| Repository validation | Current corrected-tree result |
| --- | --- |
| Rush build | Passed, 5.35s |
| Rush lint | Passed, 9.39s |
| Rush typecheck | Passed, 6.37s |
| Rush typecheck:tests | Passed, 10.37s |
| Default Rush test, model gate and all-live exclusion unset | 2,628 passed; six model cases explicitly excluded; actual auth-free Codex protocol executed, 1m 8.0s |
| Rush test with DREAMUX_RUN_LIVE_MODEL_GATE=1 and all-live exclusion unset | 2,634 passed, zero skipped; all six actual Codex contracts executed, 2m 48.5s |
| Rush change verification against the recorded historical baseline | Passed |
| Complete diff whitespace check against HEAD | Passed |

The enabled #63 assertion still requires the second native turn/start
acknowledgement before the blocking item completes and before native terminal.
Its actual Codex/MCP evidence remains separate from fake Feishu IO. Permission
fixtures executed as uid 1001 on Linux, including mode-0333 ancestors and the
mode-0300 unit parent; this is the case-sensitive branch. No insensitive-volume,
real Feishu, actual Claude model or hosted CI acceptance is claimed.

The three inherited syscall limits remain documented: root symlink rmdir,
mountpoint rmdir and directory-valued configuration unlink. No general syscall
error predictor or new deletion policy was authorized. The existing startup
scan cost and indispensable test-only private probes are also explicit.
Complete corrected-tree independent review and final task/KB closeout remain
pending. The previous two partial rounds and two complete finding-bearing
rounds are historical evidence, not review passes.

## Complete round-5 review: accepted corrections pending

All review seats completed. [Source adjudication](implementation-review.md#complete-round-5-and-source-adjudication-2026-10-04)
accepts five corrections and retains the explicit three-phase startup IO cost.
The isolated-hook assertion and local version mirror are coverage defects;
no current runtime failure is inferred from them. Pure reads must not wait on
unrelated write queues, but write ownership and the drain race stay protected.
The same writer corrects the current source/tests and named matrix mappings;
round-six green logs do not certify the subsequent tree. No independent-review
pass, final KB completion or child publication is claimed.

## Historical round-7 corrected-tree validation (2026-10-04)

All five accepted complete-round-5 corrections are implemented. The
[TeamLeader pre-review](implementation-review.md#round-5-correction-pre-review-2026-10-04)
checks the actual owner paths, changed assertions and truthful matrix mappings.
Repository and archived per-package logs agree with the current results;
all 192 writer-owned file hashes match the tested tree. The
[case matrix](coverage.md) has 1,965 unique historical identities and no
unmapped or pending-run entry; named assertions supply the evidence.

| Repository validation | Current corrected-tree result |
| --- | --- |
| Rush build | Passed, 4.43s |
| Rush lint | Passed, 9.99s |
| Rush typecheck | Passed, 6.98s |
| Rush typecheck:tests | Passed, 10.92s |
| Default Rush test, model gate and all-live exclusion unset | 2,634 passed; six explicit model exclusions and actual auth-free Codex protocol, 1m 7.95s |
| Rush test with DREAMUX_RUN_LIVE_MODEL_GATE=1 and all-live exclusion unset | 2,640 passed, zero skipped; all six actual Codex contracts, 3m 17.38s |
| Rush change verification against the recorded historical baseline | Passed |
| Complete diff whitespace check against HEAD | Passed |

Actual model evidence includes the strengthened #63 acknowledgement before
the blocking item completes and before native terminal. Default exclusions
supply no model proof. The early nonlast decrement experiment failed one
named drain-race assertion; the exact source was restored before current
validation. Linux uid-1001 permission and sensitive-volume branches are the
executed filesystem evidence. No actual Feishu, Claude model, insensitive
volume or hosted CI acceptance is claimed. Fake IO and synthetic protocol
remain distinct from actual Codex execution.

The documented 3N startup history cost and inherited syscall limits remain.
Current corrected-tree whole-tree independent review and final KB closeout
are pending. Complete finding-bearing reviews are not passes.

## Complete round-6 review disposition (2026-10-04)

The normal xhigh review covered every finder and verifier with no coverage failure. The TeamLeader verified its five confirmed findings against the current source: queued completion delivery needs positive assertions; request-replay comments need the valid-record boundary; two exact route lookups need no decoder round-trip; the event fixture duplicates an unused logger capture shape; and builtin maintenance guidance must distinguish bootstrap default from named runtime/channel factories. The same writer owns these narrow corrections. The sixth, plausible exact-entry guard deletion is not established as safe and does not authorize changing record lifetimes. [Per-finding adjudication](implementation-review.md#complete-round-6-and-source-adjudication-2026-10-04) records the source and scope.

The preceding 2,634-default/2,640-enabled results remain historical evidence for the reviewed tree. Correction-tree gates, full independent re-review and final knowledge closeout remain pending. No hosted CI or additional external platform acceptance is claimed.

## Historical round-8 corrected-tree validation (2026-10-04)

The same writer completed the five accepted complete-round-6 corrections.
TeamLeader pre-review inspected the changed paths and assertions, checked all
eight archived package summaries, actual filesystem output and all 192 tested
writer-owned hashes. The current files match the tested bytes, including the
routing decoder module restored to HEAD. The [source adjudication](implementation-review.md#round-6-correction-pre-review-2026-10-04)
and [coverage matrix](coverage.md) preserve all 1,965 historical dispositions;
those counts do not certify behavioral completeness.

| Repository command | Result |
| --- | --- |
| Rush build | Passed, 5.80s |
| Rush lint | Passed, 9.81s |
| Rush typecheck | Passed, 7.00s |
| Rush typecheck:tests | Passed, 11.03s |
| Default Rush test, both live selectors unset | 2,634 passed; six explicit model exclusions; actual installed/auth-free protocol check, 68.89s |
| Rush test with DREAMUX_RUN_LIVE_MODEL_GATE=1 and Codex exclusion unset | 2,640 passed; zero skipped; all six actual Codex contracts, 162.56s |
| Rush change verification against the recorded historical parent baseline | Passed |
| Complete diff whitespace check against HEAD | Passed |

The six enabled native cases cover effort/reset, actual persisted resume,
portable schema output, growing activity, unbound native terminal and #63.
#63 retains both positive second-acknowledgement-before-block-completion checks,
same-turn folding and actual MCP exposure. Default model exclusions are not
model evidence. Linux uid-1001 mode-0333 ancestor and mode-0300 unit-parent
assertions executed, as did the case-sensitive distinct-entry branch. No
insensitive-volume, actual Feishu, actual Claude or hosted-CI acceptance is
claimed. Full independent corrected-tree review and final knowledge closeout
remain pending; earlier finding-bearing reviews are not passes.

## Complete round-7 review disposition (2026-10-04)

The normal full review covered every finder and verifier and returned four
confirmed findings. TeamLeader source checks accept the pending Feishu reminder
note correction, the valid-record boundary in the create entry comment and
replacement of the recreated README prose scan by actual owner evidence. The
unreadable-root preview premise is also confirmed; an independent Linux uid-1001
private syscall fixture proved both otherwise-empty and foreign-content mode-0300
roots refuse enumeration while known-config unlink succeeds and real root
removal differs. That observability conflict is [prepared for decision](unreadable-root-preview.md),
not silently resolved by guessing retained or removed. The source writer
continues the independent authorized repairs and verifies the owning path.

Preceding 2,634-default/2,640-enabled gate results certify their historical tree;
they do not dispose of these findings or establish final independent acceptance.
Corrected source, exact preview policy, new gates, full re-review and final KB
remain outstanding. No actual platform acceptance has been broadened.

## Round-9 independent correction checkpoint (2026-10-04)

The three independent note/comment/coverage corrections are implemented and
TeamLeader pre-reviewed. All six correction-file hashes match the verified
bytes. Archived package logs show 693 Feishu-channel and 1,092 Dreamux tests
passed, with six explicit Dreamux model exclusions. The two packages' Rush
lint and typecheck:tests, change verification and full diff check passed.
These selected checks total 1,785 passes; they are not the required full build,
lint, test and test-types acceptance and provide no current native-model proof.
Previous full round-eight results remain historical.

The unchanged built uninstall owner and actual Linux uid-1001 filesystem
reproduce EACCES in both unreadable-root previews, followed by real removed
versus skipped root outcomes. The TeamLeader checked source/artifact hashes,
unchanged preview bytes/permissions, preserved foreign bytes and fixture
cleanup. Service commands were fake; actual CLI, systemd and hosted CI were
not exercised.

The preview contract question is pending. The writer has proposed existing
warnings plus omission of an indeterminate root status, retaining definite
entries and known configuration unlink plans. This has not been selected or
implemented. Whole-repository checks, the six explicitly enabled actual Codex
cases, complete independent corrected-tree review and final KB closeout remain
outstanding. All 1,965 historical identities keep their dispositions, including
the replaced README scan's per-fact actual-owner evidence.
