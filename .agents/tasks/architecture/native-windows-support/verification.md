# Verification

## R7 test correction, 2026-11-13

After the operator selected "Correct and continue", the test retained the
exited outsider's exact object through its nonmembership assertions. It no
longer assumes that releasing this fixture's handles makes the numeric PID
unresolvable. A separate PID 0 assertion covers native error 87 to null, not
actual process deletion timing. Production code is unchanged. Independent
static review confirmed the preserved live-member wait, outsider rejection
and normal/error cleanup contracts.

The exact focused case passed: 1 passed, 12 filtered out, 38 ms case time and
316 ms Vitest duration. Unified build passed in 3.84 seconds, lint in 17.04
seconds and test typechecking in 6.84 seconds. The full suite passed **3,215
cases / 26 skipped**, 3,241 total, in 146.3 seconds; host took 123.8 seconds
(Vitest 123.55 seconds). Independent recount found one Tests summary in each
of the eight package logs: types 81/0, utils 240/5, host 1,367/21, transport
182/0, channel 822/0, Codex 243/0, Claude 269/0 and bootstrap 11/0. The complete
Job file ran all 13 cases without skips; its full-suite duration was 1.474
seconds. The focused filtered cases are not included in the suite's skips.

All five synthetic outer runs exited 0 with null signal, unchanged sentinels,
no temporary children and captured-root removal. Independent verification of
the full-suite outer log confirmed those observations. Scheduler/model gates
remained excluded. Ordinary-permission, real credential and cross-session
acceptance, R5 and actual Feishu terminal delivery are not established by this
correction. Fresh delivery CI must be evaluated separately from these local
results and the failed prior run below.

## Follow-up delivery CI, 2026-11-13

The [PR CI run](https://github.com/excitedjs/dreamux/actions/runs/43364709673),
attempt 1, finished with 10 successful jobs and one failed Windows Rush job.
The run's head, branch and pull-request event were checked; its checkout was
the PR merge with `next`, not an unrelated revision. All three full platform
logs were retained. No rerun was performed.

Windows passed update, build, CLI smoke, source/test typechecking and lint.
Its test operation failed in utils at the final post-release outsider lookup
in `windows-job.test.ts:331`. Types, transport and bootstrap passed; Codex,
Claude, host and Feishu channel were blocked by the utils failure, not passed
or skipped. The repeated Rush error output is the same single failing case.
macOS and Ubuntu passed all eight test packages, with the host's model-gate
warning. Their test operations took 138.1 and 131.6 seconds; Windows took
13.63 seconds before failure. These logs do not print complete Vitest numeric
summaries, so the local 3,215/26 count is not attributed to CI. Push CI is N/A
under the unchanged `fix/*` trigger exclusion.

The independent adjudication and approved test-only correction are recorded
as R7 in [review](review.md). Local success and prior review did not establish
the test's assumed global process-object deletion timing. This failed run
remains distinct from the subsequent corrected-test verification above.

## Knowledge closeout, 2026-11-13

The three independent follow-up reviews covered all 35 implementation-stage
changed/new files and found no new actionable blocking finding; [review](review.md)
records their actual coverage and limits. The operator then approved knowledge
closeout with native acceptance gaps and deferred validation retained.

Owner reconciliation synchronized the shared process-exit owner and command
admission in current architecture and service topology, and clarified older
implementation/KB checkpoints in task records. Other affected owners were
already aligned; the README records updated and N/A dispositions. These are
documentation-only changes after the executed build, lint, typecheck and test
gates below. No live service, credentials, deferred experiment or package
installation was touched.
Independent review of both architecture owners and the three task records
found no inconsistency, scope expansion or exaggerated verification claim.

Closeout checks used `init_task.py check-all --repo-root . --allow-in-flight`
with the available Python interpreter and `git diff HEAD --check`; both passed,
with 63 task records checked. `node .agents/scripts/check.mjs` was also run with
that interpreter selected through process-local `PYTHON`. It exited 1 with
exactly one issue: this task's `knowledge-closeout` state is in flight. This is
not a no-exception KB pass. After the operator approved `done` at 12:14
(UTC+08:00), the complete KB gate was rerun and passed without exceptions:
63 task records and 415 files reachable from root. The stage was changed only
after that approval, not to bypass the gate.
The ordinary-permission, real UI/Password, cross-session and R5 limitations
below remain unchanged.

## Cooperative Windows stop, 2026-11-13

The operator approved this implementation and isolated verification after the
CoT restart report. Read-only inspection found immediate Job termination in the
installed alpha and pre-correction source, bypassing application shutdown. The
running service was not restarted or modified to reproduce that report.

The existing synthetic-home driver kept real Scheduler/model gates disabled,
joined its test process, checked account sentinels and temporary children, and
removed only its captured root. Executed focused checks:

- Retained Job-member observation: 1 passed, 12 filtered out, 35 ms case time;
  309 ms Vitest duration. A real member timed out while alive and signaled after
  exit, an outsider was refused, and an already-gone PID returned no observation.
- Application commands and process owner: all 49 cases across three files
  passed in 4.94 seconds. Real admin IPC acknowledged shutdown while other
  admitted work was held; shutdown completed after that work was released.
  Direct process-owner tests intercepted process exit and used fake timers to
  verify signal/admin convergence, startup sequencing, failure and the deadline.
- Windows control: all 6 cases passed in 32.09 seconds. Real owned processes,
  Jobs and IPC verified delayed cooperative cleanup before Stop/Run, failure
  preventing Run, and refusal to stop unrelated foreground servers. Accepted
  but stalled shutdown and missing responses each consumed one 15-second
  request/wait budget before forced cleanup (15.244 / 15.250 seconds case time).
  Scheduler calls were intercepted; no actual Task operations were performed.
- CoT application chain: 1 passed, 5 filtered out, 1.565 seconds case time;
  3.69 seconds Vitest duration. Real Server/Team/channel/session owners produced
  the interrupted terminal through a fake Feishu transport. A blocked terminal
  append kept both transport close and Server.shutdown pending; release proved
  terminal completion, transport close, then shutdown completion. This is not
  proof that the real Feishu API received an update.

Every focused outer run exited 0 with unchanged sentinels, no temporary children
and its captured root removed. Unified build passed in 3.80 seconds. The first
test typecheck found only the new process-owner test's listener overload and
logger types; those test declarations were corrected without changing assertions.
Final test typechecking passed all eight applicable packages in 6.74 seconds;
final lint passed all nine packages in 6.74 seconds.

The full default suite passed **3,215 cases / 26 skipped**, 3,241 total across
eight packages. Independent recount used exactly one Tests summary per package:
types 81/0, utils 240/5, host 1,367/21, transport 182/0, channel 822/0,
Codex 243/0, Claude 269/0 and bootstrap 11/0 (passed/skipped). Host had 111
passing files and 4 skipped files. The suite completed in 146.3 seconds, with
the host operation at 123.4 seconds (Vitest 123.12 seconds). Its outer run exited 0,
preserved all sentinels, found no temporary children and removed the captured
root. These outer observations were independently checked from the outer log.
Real model, installed-Codex and Scheduler gates remained excluded.

At the pre-review checkpoint, the in-flight record checker passed all 63 task
records. The full KB checker reported exactly the task's `implementation`
state as in flight; that run did not pass the no-exception delivery gate. No
stage was changed merely to make that check pass. Formal complete-delta review
was pending then; its subsequent completion and actual coverage are recorded
in [review](review.md). Ordinary-user installation, real credential UI/Password
behavior, cross-session operation and R5 retain their previously recorded
acceptance gaps and deferrals.

## Installation follow-up, 2026-11-13

The published alpha `0.29.0-alpha.ge0477c515e92` came from the reviewed
[PR #488](https://github.com/excitedjs/dreamux/pull/488) head. Its PR workflow
[completed successfully](https://github.com/excitedjs/dreamux/actions/runs/43209216220),
and the branch [release completed](https://github.com/excitedjs/dreamux/actions/runs/43210501365).
The downloaded host tarball matched npm's SHA512 integrity. Provenance source,
run and subject payloads matched; the signatures were not cryptographically
verified. Package publication did not establish local service installation.

The automated local upgrade removed the old service and installed the exact
package, then `daemon install --no-start` failed in private-path owner checking.
Doctor and the notification restart were not reached. Subsequent recovery and
its nested-log ownership and account-alias observations were recorded separately;
they do not convert that failed automation into a successful upgrade. The later
Job access-denied report has no failure stack. No claim is made about its exact
call site, token cause, or relation to the separately deferred R5 test.

The follow-up runs below use the existing outer synthetic-home driver. It
replaces account/application homes, temporary directories and the Node compile
cache, excludes model and real Scheduler gates, waits for the test child to
close, checks four account sentinels and temporary children, and only then
removes its captured root. Operator files and Tasks are outside these fixtures.

- Job query/control regression: 1 passed, 12 filtered out; 13 ms case time,
  707 ms Vitest duration. A real UUID Job permits QUERY and denies
  SET_ATTRIBUTES/TERMINATE. Query observes its real member without stopping it;
  a control open returns error 5, and the original retained control handle
  still terminates and waits for the member. Outer exit 0, sentinels unchanged,
  no temporary children, captured root removed. This verifies the access split,
  not the historical installation error's cause.

- Credential script suite: 26 passed, 9.69 seconds. The unmodified production
  P/Invoke declaration compiled to a fixture assembly without loading or calling
  its UI; the executing prompt and external Scheduler interfaces were replaced.
  Fixed-account input, maximum-length UTF-16 password handling, cancellation,
  errors and existing registration branches passed. Outer exit 0, sentinels
  unchanged, no temporary children, captured root removed.
- Initial restricted-token fixture runs failed before reaching the owner
  contract. The first showed absent report files; moving the native exit-code
  assertion before the read exposed `0xc0000142` in all three child processes.
  The existing foreign-owner case passed. Both outer runs preserved sentinels,
  found no temporary children and removed their captured roots. These are
  fixture startup failures, not expected product-red evidence or passing
  adoption tests. No existing desktop or window-station permissions were changed.
- A private UUID window station and desktop did not remove the same three
  initialization failures. A subsequent single-case diagnostic read only the
  newly created restricted token and retained child process/thread descriptors:
  their full-access grants matched the deny-only Administrators SID or SYSTEM,
  while another enabled group had read/execute access. Both objects were owned
  by the current SID. This is not absence of all effective grants, and it does
  not identify the failing DLL operation. The diagnostic still exited before
  product code; sentinels and cleanup checks passed. It does not count as an
  ownership regression result.
- Supplying explicit current-SID full-access descriptors for those two new
  objects was confirmed by readback but still produced `0xc0000142`. This
  counterfactual did not establish a working launcher or an initialization
  diagnosis. A query of the checking Node process's own token reported
  `TokenElevationTypeDefault`, with no linked Limited-token route. The failed
  launcher and diagnostic code are retained only as ignored evidence, not as
  deliverable test infrastructure. The original non-administrator acceptance
  requirement remains open; direct native authorization tests do not replace it.
- A pre-build test typecheck found only the host's three new two-argument Job
  opens against the deliberately retained old utils declarations. Seven other
  packages passed. The complete check must be repeated after the unified build;
  this run is not an integrated gate pass.
- The retained direct ownership checks passed all four selected cases, with
  24 unrelated cases filtered out (22 ms case total, 263 ms Vitest duration).
  Explicit BA-owned files/directories with current-user FullControl were adopted
  with private ACLs and preserved contents. A read-only file was refused by the
  native setter with error 5 and its path, without changing permissions or
  contents; the caller's take-ownership/restore privileges were checked disabled.
  Foreign-owner refusal also passed. These are actual runner-token results,
  not non-administrator adoption evidence. Outer exit 0, sentinels unchanged,
  no temporary children, captured root removed.
- Unified build passed in 4.06 seconds (five rebuilt packages, four up to date).
  The post-build test typecheck passed all eight applicable packages in
  6.80 seconds; final lint passed all nine in 6.68 seconds.
- The complete default suite passed: **3,197 passed / 26 skipped**, eight
  packages, 3,223 cases total. The independent count used each package's unique
  Vitest summary, without Rush's repeated warning output. Utils had 240 passed /
  5 skipped; host had 1,349 passed / 21 skipped. Ownership tests were 25 passed /
  3 platform skips, Job tests 13 passed, and credential/Task tests 26 passed.
  Rush took 116.0 seconds, host 93.4 seconds. The executing TeamLeader observed
  outer exit 0, unchanged sentinels, no temporary children and captured-root
  removal; the independently counted package logs do not contain those outer
  observations. Model, installed-Codex and real Scheduler gates stayed excluded.
- `git diff HEAD --check` passed, and the in-flight task-record check passed
  for 63 tasks. At that implementation checkpoint the full no-exception
  KB/closeout gate was not claimed.

Non-administrator ownership acceptance remained pending at this checkpoint,
as did the formal complete-delta review subsequently recorded in [review](review.md).
On 2026-11-13 the operator selected "Verify later"
for the proposed ordinary-terminal, temporary-directory permission check. That
validation is deferred, not passed or waived. The real credential dialog and
Password registration are not exercised by intercepted-script tests. The
running installation is unchanged by this verification.

## Submission readiness

The operator approved `done` on 2026-11-12 after independent knowledge-closeout
review. The full `node .agents/scripts/check.mjs` gate then passed without any
in-flight exception: 63 task records checked and 414 KB files reachable from
the root. The approval preserves the recorded R5 deferral and native acceptance
limits. Mandatory commit hooks, reviewed-branch CI and publication remain
delivery checks; they are not inferred from the earlier local test results.

Mandatory staged lint, gitleaks and internal-content checks passed during the
delivery commit; Rush change verification passed afterward. The reviewed change
was pushed to the existing PR branch with an exact lease on its previous tip.
The [push CI run](https://github.com/excitedjs/dreamux/actions/runs/43207356712)
then failed commit metadata at revision-range resolution, before checking any
author email. Independent review confirmed R6's absent pre-force-push object.
The [matching PR run](https://github.com/excitedjs/dreamux/actions/runs/43207362580)
finished successfully. All six platform Rush jobs completed, and each complete
log showed eight successful packages (the host with model-exclusion warnings).
The push run still failed overall because of commit metadata; the PR success
does not remove that failure. These logs report package results, not the local
suite's individual test counts.

The operator answered the correction card by requesting a replacement PR.
The new branch `fix/pr-476-review-20261019` was created, PR #488 opened against
`next`, and PR #476 closed with a replacement link. No workflow correction or
new regression was executed; the original failure remains recorded. Fresh CI
is required for the replacement delivery head. No alpha was dispatched and the
local installation was not changed during this handoff.

## Knowledge closeout

The operator approved knowledge-closeout on 2026-11-12 while explicitly retaining
the deferred R5 early-entry stop gap. R1-R4 are resolved. The task requirement,
final entry decision, review and evidence were reconciled with the already
approved implementation; no production behavior or test assertion changed in
this stage. The task README lists each affected knowledge owner and the reason
for updates or N/A. Independent service/native and tooling audits checked those
owners against current source. Current checker names, the shell author-check
boundary, CI noreply exemption and shared test-setup/helper ownership were
corrected without changing historical test evidence.

Independent final closeout review found one stale present-tense statement in
the earlier R5 ruling; it now explicitly describes the state at that ruling.
The review confirmed the remaining task and owner records agree: R1-R4 are
resolved, R5 is deferred and unverified, and native acceptance limits remain
separate from the default test results. No further documentation correction
was identified in that review.

The initial full KB check found a missing route to the new review document and
two temporary commit citations, besides the intentional in-flight task state.
The README now links the review, and its target uses the delivery/upstream PR
references. The repeat full check reported only the `knowledge-closeout` state
guard: it is not yet a successful trunk KB check. The scoped task check passed
with `--allow-in-flight`; the all-task check with that flag passed all 63 records.
`git diff --check` passed across the complete tracked change. The final full KB
gate must run without exceptions after the operator approves `done`.

No build, test, Scheduler, GUI, credential, CI or installation operation ran
during this documentation closeout. The latest integrated code checks remain
the R4 results: build, lint and test-aware typechecking pass, with 3,193 passed
and 26 skipped default tests. The earlier Interactive/Limited lifecycle evidence
does not certify real Password storage/reuse, GUI behavior, cross-session
operation or preservation of an existing registered Task ACL. R5 was not run.

## Review correction R2: CI author-email documentation

The operator requested correction on 2026-11-12 and supplied the intended Git
identity. The CI table now explicitly refers to commit author email and states
that GitHub noreply addresses pass directly; other addresses pass the existing
format and optional denylist checks. The local hook's different treatment of
noreply remains accurately documented. CI, hook and email policy are unchanged.

Scoped `git diff --check` passed. Independent read-only review confirmed the
single corrected row against the actual workflow, local hook and owning
document. Repository-local Git identity was separately set to the operator's
specified values; effective author and committer identities were read back and
matched. No commit was created or rewritten. No tests, build, hooks, Scheduler,
GUI or installed-service operation was run for this documentation correction.

R2 is resolved. R1-R4 are now resolved; R5 remains deferred and unverified.
The operator subsequently approved knowledge-closeout with that limitation
retained; the deferred validation has not been performed.

## Review correction R1: current service documentation

The operator approved correcting the three obsolete current-service descriptions
on 2026-11-12. The package README, maintenance routing sentence and pending
feature change note now describe the packaged entry reading its launch command
and environment from Task Scheduler Data. Historical migration documentation,
the breaking-change rebuild instructions and production behavior are unchanged.

Scoped `git diff --check` passed. The changefile parses as JSON and retains its
package, single change entry and minor type. Independent read-only review checked
all three descriptions against `windows-task.ts`, `windows-entry.ts`, the approved
revision and breaking change note, and found no issue. No tests, build, Scheduler,
GUI or installed-service operation was repeated for this documentation-only
correction. The latest code-gate evidence remains the R4 results below.

R1 is resolved. The subsequent R2 correction and R5 deferral are recorded above.

## Deferred review validation R5

On 2026-11-12 the operator deferred the proposed early-entry stop validation.
No new experiment was prepared or executed. Entry exit and file release before
Job assignment remain an explicit coverage gap, not a failed or passed test.
The previous R4 evidence remains unchanged. The operator subsequently approved
knowledge-closeout with this deferral retained; it does not establish that the
deferred case passed.

## Review correction R4: installation handoff result

The operator approved correcting and verifying R4 on 2026-11-12. Windows
registration now returns the restart handoff fact to installation. A service-owned
installation reports `started: false, handedOff: true`; daemon install and onboard
output state that completion has not yet been confirmed. Unix results, no-start,
dry-run planned-start semantics and the restart control mechanism are unchanged.
Independent review found no blocker in the return chain, output, or fixture
lifecycle, and confirmed the two current product/maintenance descriptions.

Eight focused cases passed in 3.22 seconds. They cover no-start installation,
both dry-run start choices, self-install from a real owned entry/Job, and both
handoff and normal output through each real yargs command. The self-install
case passed in 913 ms. Its Scheduler and WMI runner operations are substituted;
the CLI output cases substitute installation results. These checks establish
result propagation and wording, not native WMI launch or controller completion.
The existing control regressions remain in the default suite.

Build passed in 1.74 seconds, lint in 6.89 seconds and all eight test-aware type
checks in 6.84 seconds. The full default Rush suite passed in 116.4 seconds
(host 93.6 seconds). Eight unique package summaries total 3,193 passed and
26 skipped cases; the host reports 1,349 passed and 21 skipped. The complete
daemon-windows file has 18 passed and one live skip; commands has 11 passed.
An independent recount confirmed these totals without adding Rush's repeated
output. Both focused and full-suite outer checks reported exit zero, unchanged
synthetic account contents, no temporary children and captured-root removal.
No real Scheduler, GUI, credential or live-model test was enabled.

R4 is resolved. Subsequent findings and operator rulings are recorded in the
[review](review.md); these results do not certify deferred or native opt-in cases.

## Review correction R3: Windows uninstall path comparison

The operator approved correcting and verifying R3 on 2026-11-12. Windows
uninstall protection now uses case-insensitive comparison keys for HOME/cwd
equality and provider-state equality or containment in either direction. Actual
filesystem targets, reported paths and Unix comparison behavior are unchanged.
The existing non-file Windows Task ledger behavior is also unchanged.

Eight new Windows cases cover HOME, cwd, and both provider-home variables with
equal, inside and containing aliases. Each checks preview and actual calls,
preserved synthetic sentinels, and no service runner call before rejection.
The focused eight passed in 8.00 seconds; the complete uninstall file then passed
35 cases with five platform-condition skips in 2.20 seconds. Independent review
confirmed the delta and both logs. Each outer run reported exit zero, unchanged
synthetic account contents, no temporary children and captured-root removal.

Integrated build passed in 4.48 seconds, lint in 30.12 seconds and all eight
test-aware type checks in 9.51 seconds. The default Rush suite passed in 117.3
seconds (host 94.3 seconds). Its eight unique package summaries total 3,187 passed
and 26 skipped cases; the host reports 1,343 passed and 21 skipped. The uninstall
file reports 35 passed and five skipped, including all eight new regressions.
Independent recount confirmed those totals without adding Rush's repeated
output. The outer suite again confirmed unchanged sentinels, no temporary
children and captured-root removal. No real Scheduler, GUI, credential or
live-model test was enabled for this correction.

R3 is resolved. The other findings received their separate operator rulings as
recorded in the [review](review.md); the R3 results alone did not close that gate.

## Historical implementation checks: approved published service entry

The operator approved removing the generated Windows launcher and accepting
the documented one-time old-version service uninstall/reinstall. Implementation
now stores the installation environment and business command in Task Data and
uses the registered WorkingDirectory to select the root. The running operator
installation has not been changed.

Independent review found that embedding the captured PATH in EncodedCommand
could exceed the Windows command-line limit. Registration now passes its
installation data through UTF-8 stdin; credentials remain inside PowerShell.
The first isolated query passed. The expanded run initially passed 26 cases and
failed two: PowerShell output encoding corrupted Unicode, and the COM XML
round-trip normalized the SID to an account name. The common PowerShell prefix
now specifies UTF-8 output, and the test compares the returned identity's actual
SID with the current account instead of requiring SID-shaped text. The subsequent
registration/input group passed 28 cases, with five unrelated cases filtered
out. This includes long Unicode PATH preservation in real in-memory COM XML.
Scheduler persistence and the native credential prompt remain substituted.

The new entry's three focused cases passed using real Node/CMD children:
Unicode arguments and paths, append logs, exit status, and a missing executable
whose error is recorded without an unhandled rejection. Review also caught an
early rejection when startup throws before awaiting its exit promise; the entry
now observes that promise immediately without suppressing the awaited error.
The two-file daemon/privacy group passed 18 cases with the live Scheduler case
skipped. The initial integrated build passed in 1.72 seconds, and all eight
test-aware type checks passed in 6.78 seconds.

Three separate control cases passed with real processes, Jobs and admin IPC,
and a substituted Scheduler. They verify that an observed old wrapper closes
before Run, an unresolved Stop blocks Run, new admin readiness gates completion,
a Stop error prevents Run and restores the prior enabled state, and an actual
standalone server PID outside the Job is rejected. These observations do not
turn a false membership result into an exit-handle proof; the existing native
utils tests cover the production held-handle tree waiting primitive.

Each completed focused run preserved synthetic account sentinels, left its
temporary directory empty, and removed its captured outer root. Review then
tightened failure cleanup: entry children are joined before directory removal;
unverified native cleanup retains its root, including in the outer driver.
The subsequent full Rush run passed in 115.8 seconds: eight packages reported
3,179 passed and 26 skipped tests. Independent review recomputed those totals
from the package JSONL logs. Synthetic sentinels were unchanged, the temporary
directory was empty, and the captured outer root was removed. Lint passed in
6.89 seconds. A later test-aware type check caught the concrete `reject: false`
Execa result being stored as the default generic result; the fixture now derives
its child collection type from the unchanged launch options. All eight
test-aware checks then passed in 6.77 seconds.

The separately enabled, UUID-scoped native Interactive lifecycle test initially
failed twice. Its first run completed two external restarts, then failed while
writing the self-restart notification before reaching the controller. The
fixture incorrectly placed that marker in its elevated-owned temporary root;
it now uses the production `restartIntentPath(root)` under the initialized run
directory. The second run reached the external self controller, where setting
the Task's `Enabled` property to false returned `E_ACCESSDENIED`, before Job
acquisition or termination. Neither task definition had an explicit Task DACL.
This locates the observed rejection but does not establish the original task's
owner/DACL or explain the operator's earlier restart failure.

Targeted follow-up checks found both UUID Tasks absent and their recorded server
and child PIDs absent. Both failed roots and copied logs are retained. Automatic
tool approval rejected deletion of the first captured root with only
`blocked by policy`; no alternate deletion was attempted.

New Task definitions now specify allow/full-access entries for SYSTEM,
Administrators and the current account SID through the XML registration security
descriptor. Existing definition branches do not actively reset their custom
descriptor. The isolated registration/input group again passed 28 cases in
9.74 seconds. Its real in-memory COM/XML assertions verify the three new entries
and preservation of an existing custom descriptor; these are not persisted Task
ACL assertions. Build passed in 1.73 seconds, lint in 6.86 seconds and all eight
test-aware type checks in 6.82 seconds.

With the same new-task descriptor, the real UUID Interactive/Limited lifecycle
case passed in 21.974 seconds (22.71 seconds for the run). It read back a current
SID allow entry from that registered Task, then completed two external restarts,
self restart, notification consumption exactly once, self stop, disabled-state
preservation followed by start, and uninstall. The recorded server and child
PIDs were unavailable after the relevant stops. This case does not independently
observe every Job member or every instant of tree-exit ordering. Its outer driver
reported exit zero, unchanged sentinels, an empty temporary directory and removal
of the captured root. The two saved logs describe one execution. Independent
review confirmed these evidence boundaries. The two prior failed roots remain
retained; successful cleanup of the third run does not supersede their records.

Existing registered Task ACL preservation, real GUI behavior, Password credential
storage/reuse and cross-session operation remain unverified. The native fixture
uses Interactive logon and does not claim those capabilities.

The final default Rush suite passed in 115.7 seconds after the Task-access
correction. Its eight package summaries again total 3,179 passed and 26 skipped
(3,205 cases); the host reports 1,335 passed and 21 skipped across 110 passed
and four skipped files. Host wall time is 93.1 seconds. Independent review
counted each package summary once, without adding Rush's repeated output or the
separate native lifecycle execution. The outer driver again verified unchanged
sentinels, no temporary children, successful exit and removal of its captured
root. Real model cases and the default native service opt-in remain excluded.

The KB check was run with an existing Python 3.13 interpreter selected explicitly
after the PATH alias returned exit 9009. At that checkpoint its sole remaining
failure was the task's intentional `implementation` state, which cannot land on
the trunk. The state was not changed merely to satisfy the check; the operator
subsequently approved review. No link or current-knowledge check failed then.

## Historical reopened implementation: 2026-11-12

The local branch was backed up and rebased onto the current `next`. The published
branch and running installation were not changed. Integration retained the
upstream unified runtime events, thread news and reasoning behavior, workflow
task reminders, split documentation and package versions. Stale Codex client
names and test contexts were corrected against those upstream contracts.

The rebased build passed in 8.86 seconds. Test-aware type checking initially
found obsolete result/activity fields in provider privacy fixtures; after those
fixtures adopted the upstream event sink, all eight package checks passed in
9.58 seconds. These are build/type checks, not runtime or full-gate acceptance.

Independent scope review removed two Ubuntu-only release script extractions
while preserving the inline release gates, restored 106 unrelated historical
records to the baseline, and moved the shared permission oracle and declarations
to `common/testing` with direct consumer imports. The one-line permission bridge
was removed. Repository tooling behavior was subsequently checked as recorded
below; full integrated gates had not yet run at that checkpoint.

Read-only inspection found the installed service predates this branch and runs
in Password mode. The observer belongs to that service's Job. Its self-control
path checks only the WMI creation result; ordinary startup checks only the
Scheduler command result. Neither establishes a replacement server responding.
The bounded stderr search found no matching control error. This establishes a
completion-reporting gap, not the cause of the operator's earlier restart.
No actual service control, credential prompt or task write was performed.

GUI credential input and lifecycle correction were still in progress at that
checkpoint. Their later integrated gates and independent review are recorded
above; intermediate checks did not verify that final revision.

The independent GUI review caught a test command exceeding the Windows command
line limit. The shadow fixture now runs a captured temporary PowerShell file and
removes it after child close. Its first execution passed six cases and failed
two: cancel/error codes were reported as 122 instead of the native return code.
The unsigned CredUI return selected the wrong PowerShell constructor overload;
an explicit Int32 conversion selects `Win32Exception(int)`. The unchanged eight
registration assertions then passed. The fixture replaces the native binding
class and Scheduler commands. It still executes native credential packing and
unpacking plus the production PowerShell buffer handling and owner validation,
but does not compile the production P/Invoke declarations or verify a real
dialog, credential storage or reuse of stored credentials.

Focused native membership queries passed one case (eleven filtered out), and
the rebased Codex event/reasoning/privacy group passed 84 cases; Claude privacy
passed three. Each ran inside a separate synthetic account/application/temp
root, with unchanged sentinels, empty temporary directories and completed root
cleanup. The repository tooling run initially passed four cases, including
actual Git hook behavior, but its KB case failed because Python resolved to an
unavailable Windows application alias (exit 9009). Selecting the already
installed Python interpreter through `PYTHON` made all five tooling cases pass;
sentinels remained unchanged, the temporary directory was empty and the captured
root was removed. No Python installation or machine configuration was changed.
The test-aware type check also caught an overly narrow Execa result type in the
new fixture. Inferring it from the actual options resolved that error; all eight
package checks passed in 6.79 seconds.

After withdrawing the unverified control draft, the four-file host regression
group passed 70 tests with one native Scheduler opt-in skipped (8.59 seconds).
Its synthetic sentinels were unchanged, the temporary directory was empty and
the captured root was removed. This verifies the retained GUI fixture and
existing lifecycle/notification coverage, not the proposed native restart.

The complete lint gate passed all nine operations in 13.33 seconds after
formatting two test files without changing their assertions. The KB checker
rejected the intentionally reopened `implementation` task state for trunk
delivery; that stage was not advanced merely to make the checker pass.

The baseline completion-body fixture now retains the exact `mkdtempSync` root
and removes that root in its existing cleanup, instead of leaving the parent
of the spill directory behind. All eight focused cases passed (503 ms), with
unchanged synthetic sentinels, an empty temporary directory and completed outer
root removal. This verified that fixture cleanup; the full integrated suite
had not yet been rerun on the final revision at that checkpoint.

An intermediate full-suite run then completed with seven package successes and
one host failure (Rush 112.0 seconds; host 89.1 seconds). The denied atomic-rename
case in `team-session-title.test.ts` observed no expected logger call. Source
review found that the unchanged upstream case rejects only one rename, whereas
this branch retries transient Windows rename failures. A later successful
attempt therefore bypasses the terminal-failure logger being asserted. The
trace itself does not record individual rename attempts. The outer
synthetic account was unchanged, its temporary directory was empty and the
captured root was removed. The failure was then under source review; it was not a
Scheduler or model result. The subsequent incremental build rebuilt the host
with the original control implementation restored (1.73 seconds; eight operations
already up to date), and all eight test-aware type checks passed in 6.88 seconds. Final
acceptance was still pending on the eventual integrated design.

The title persistence fixture now denies only the target record's rename until
the actual failure is logged, then releases that denial for recovery and
reenables it for shutdown. All original persistence, runtime and logger
assertions and the five-second test budget remain. The complete title test file
passed seven cases (4.24 seconds; the repaired case took 2,117 ms); sentinels
were unchanged, the temporary directory was empty and its root was removed.
The subsequent type check caught Vitest inferring only the logger's one-argument
overload for the observer callback. Explicitly handling both existing logger
signatures preserved the original calls without casts; all eight test-aware
checks then passed in 6.82 seconds.
The full suite with that repair passed all eight packages (Rush 111.8 seconds;
host 89.0 seconds). The host warnings report intentionally excluded live model
checks and the dual-output logger fixture. The outer synthetic account remained
unchanged, its temporary directory was empty and its captured root was removed.
This verified the rebased retained implementation; native control and the
packaged service entry were still separate, unimplemented work at that point.
The subsequent complete lint gate passed all nine operations in 6.91 seconds.

The operator subsequently questioned the generated `daemon.mjs` itself. Further
control changes around that file were paused while the installed entrypoint and
necessary launch information were reassessed. The completion-check draft was
unverified and had not been installed, committed or delivered. The draft was
saved outside tracked source and withdrawn from the implementation while the
native restart contract was reassessed; the verified credential changes remained.

The operator then questioned whether Task Scheduler already owns restart.
Microsoft documents `MultipleInstancesPolicy=StopExisting` as stopping the old
task instance before starting a new one. The current `IgnoreNew` policy is an
implementation choice, not a platform restriction. `RestartCount` and
`RestartInterval` separately configure failure recovery. These contracts do not
by themselves establish when every member of Dreamux's separate Job has exited.
An isolated native-task probe was independently reviewed and executed once.
It registered only a UUID-named S4U/Limited task with StopExisting, no trigger
and no automatic restart. The first Run reached fixture readiness with three
fixture processes and two supervised bootstraps. The second Run returned a new
instance GUID and Running state, but the replacement fixture failed at
`WindowsJob.create` because the same named Job still existed. No observer Job
handle was held across Run; the observer did retain query/synchronize handles
to the original process objects. The trace does not establish the original
process states at the instant of the creation failure or the cause of the
Job's continued existence. Self-Run and final Stop acceptance were not reached.

Failure cleanup terminated only the probe-owned Job, removed the exact UUID
task, observed exit of every retained process object, closed its PowerShell
helpers and removed the captured temporary root. This result exposes a conflict
between native replacement and the current same-name startup guard under these
probe conditions; it neither diagnoses the operator's historical failure nor
verifies Password credentials or Dreamux readiness. Native control redesign
and removal of the generated launcher remain unimplemented.

A second, independently reviewed control probe kept the same fixture and task
policy, but captured PID plus creation FILETIME and closed every observation
handle before Run. Its second Run again returned a new instance GUID and Running
state; the replacement root then failed at the same-name Job creation guard.
Before cleanup mutated anything, all five original identities still matched
and their process handles were not signaled. This establishes incomplete exit
at that observation, not CPU activity or continuing application work. Retaining
observer handles across Run is therefore not required for this observed
collision. The reason for Scheduler's behavior and the operator's historical
failure remain unknown; self-Run was again not reached.

The control probe removed its UUID task and waited for the known process
objects during failure cleanup. It initially retained the captured temporary
root because the failed replacement had no captured creation identity. A
separate, query-only OpenProcess call returned error 87 for that exact recorded
PID, establishing absence at the later query; only then was the captured root
removed. The original failure evidence was not rewritten. These are isolated
S4U fixture results, not Password-mode or production-service acceptance.

The next narrow candidate removes the Action root's additional service Job:
Scheduler owns that root, while its existing SupervisedChild still owns the
business subtree through an unnamed Job. This is a candidate for isolated
verification, not a finding that assignment caused the earlier behavior or an
implemented production change. Merely changing the outer Job's name to unnamed
would not prove that the old root exits before new business starts.

The Scheduler-owned-root candidate was independently reviewed and executed once.
It removed the extra root service Job, retained the two existing SupervisedChild
owners, and explicitly enabled and read back AllowHardTerminate. All three
generations reached fixture readiness: external replacement, one self-Run and
final Stop completed; each generation's five captured process identities
eventually disappeared. The helper was already absent when observed after the
self replacement. Sentinels remained unchanged, the exact task was deleted and
the captured root was removed. No failure-path termination was needed.

This candidate proves eventual replacement and cleanup for this S4U fixture,
but also demonstrates overlap. External replacement reached readiness at
1,613.535 ms while all five old identities remained unsignaled; their first
all-gone observation was 2,398.328 ms. Self replacement reached readiness at
3,024.894 ms with the same condition; its old identities were all gone at
3,775.616 ms. Final Stop reported Ready state and zero task instances at
4,138.757 ms, before the last generation was observed gone at 5,130.946 ms.
These are observation times, not exact exit times. Scheduler state is therefore
not a process-tree exit barrier in this experiment. The fixture does not run
serve or contend for its admin lock; this passing probe alone cannot justify
starting production work before the previous server releases its resources.

## Historical tarball fixture budget follow-up

The Password-default delivery passed [push CI](https://github.com/excitedjs/dreamux/actions/runs/39436934066)
on all three platforms. Its [PR CI](https://github.com/excitedjs/dreamux/actions/runs/39436943984)
passed on Ubuntu and macOS but failed on Windows: both tarball cases in
`internal-content-scan.test.ts` reached the default 5,000 ms timeout. The other
seven packages passed. The complete log has no phase marker, stack or EBUSY;
its later failure block is a Rush reprint, not another sample. It does not
identify whether packing, scanning or cleanup exceeded the budget, and the
same-head push success does not explain it.

The two cases assert scanner results and exit codes, not a performance
requirement. Their budget includes real tar and Node processes and scoped
cleanup. Earlier diagnostics recorded a completed 4,914.58 ms case, including
4,156.08 ms awaiting the packing subprocess and 2.87 ms cleanup. That completed
sample leaves little room under the implicit five-second limit. It does not
establish the underlying delay or prove the historical failures had that phase.

Only these two tarball cases now declare an explicit 30-second budget. This
supersedes retaining their implicit five-second limit in the earlier cleanup
correction. It is an engineering allowance for the real subprocess fixtures,
not a statistical guarantee or a diagnosed Windows fix. Assertions, commands,
fixtures, cleanup, the index-scan cases, suite default and retries are unchanged.

Focused verification passed both tarball cases with two filtered index cases;
the synthetic account was unchanged, temporary directory empty and captured
root removed. Local Rush build (1.68 s), lint (15.97 s), test typechecking
(6.19 s) and full tests (100.7 s) passed. The eight package logs again report
**2,925 passed / 25 skipped**; the complete scanner file passed four cases
in 624 ms. Production code did not change in this follow-up.

The full suite again preserved the synthetic account but failed the separate
empty-temp assertion on five baseline spill-parent directories. The outer
finally removed its captured root and all leftovers. Real Scheduler and model
gates remained disabled. Independent review confirmed that only the two
deadlines changed; hosted CI of the resulting revision is pending.

## Historical Password installation default

The operator clarified on 2026-10-20 that installation itself must select
Password logon. Preserving a manually selected mode was insufficient.
The new implementation uses the existing registration PowerShell process for
local masked credential input and keeps the credential out of JavaScript,
arguments, environment, generated launchers and Dreamux state. Existing task
definitions retain their settings while the current-user Password principal
and action are updated. The service Job uses the Global namespace for control
from another Windows session.

A read-only preflight protects the registered launcher's ownership record:
running or queued tasks must be stopped from outside the service before an
installation changes their Job identity, including Local-to-Global or a
different service root. No automatic
legacy migration or console-hiding helper is introduced. This does not establish
that the previous Local implementation could wait for a service in another
session.

A small Windows PowerShell probe created only in-memory ScheduledTasks CIM
objects with a synthetic identity. Replacing Actions and Principal preserved
the captured description, trigger, settings and Highest run level while
selecting Password. It never called Get-, Set- or Register-ScheduledTask.
All three executions passed those functional assertions. The extra whole-profile
snapshot did not pass: PowerShell created its roaming directory and subsequently
its `StartupProfileData-NonInteractive` cache under the synthetic profile.
Every captured outer root was removed. Further focused checks precreate the
cache directory and exclude only that exact cache file from the comparison;
all other account content and application-home sentinels remain protected.
This probe validates CIM assignment, not native task storage or credentials.

A real synthetic terminal check inherited stdio into PowerShell with
`windowsHide: true`, without `-NonInteractive` or `-WindowStyle`.
`Read-Host -AsSecureString` displayed ten masking characters for the synthetic
input and completed successfully. Account sentinels remained unchanged, the
temporary directory was empty and the captured root was removed. It did not
invoke Scheduler or use a real password.

A focused native Global Job case passed in 176 ms: a separately opened Job
terminated the nested fixture tree and observed the retained process handles
signalled before deleting its files. Its synthetic account was unchanged,
temporary directory empty and outer root removed. This was a single-session
native test of the Global name, not an experiment across login sessions.

The first focused registration run passed six cases, with 15 filtered skips.
Five cases executed the actual generated PowerShell against Scheduler function
shadows; the non-terminal case used the real `Read-Host` rejection. The full
daemon and privacy files then passed 22 cases with one live Scheduler skip.
They cover definition preservation, refusal before service-file writes when
the registered Job identity changes, unchanged dry-run permissions, and the
generated Node/cmd launchers. Both runs preserved the synthetic account and
application sentinels, left an empty temporary directory, and removed the
captured outer root. Real-PowerShell cases retain the explicit 30-second budget.

The live opt-in case now explicitly prepares an Interactive lifecycle fixture;
it tests control and self-restart without pretending to certify the new
Password installation flow. It was not run. Independent static review found
no blocking issue.

Local Windows gates passed: Rush build 7.60 s, lint 36.14 s, test typechecking
6.68 s, and full default tests 101.8 s. The eight package logs report **2,925
passed / 25 skipped**: host 1,212/20, utils 225/5, Codex 212/0, Claude 242/0,
types 79/0, channel 762/0, transport 182/0 and bootstrap 11/0. The host
daemon file passed 20 cases with its one live Scheduler skip.

Build, lint and test typechecking left the synthetic temporary directory empty.
The full suite returned zero, but its extra empty-temp assertion failed on the
same five baseline `dx-spill-*` fixture parents documented below. Their contents
were not inspected. The synthetic account and application sentinels remained
unchanged, and the outer finally removed its captured root, including those
five leftovers. The extra cleanup assertion is not a successful gate.

Hosted results for this delivery are recorded in the follow-up above.
No operator task, account password,
real Scheduler fixture or authenticated model has been used for this correction.

## Historical correction: existing Windows task registration

The operator reported a persistent console and manually changed the installed
task's login mode. Read-only inspection found Password, Limited, Running and a
logon trigger. Scheduler Running is not a service health check. Source review
identified an interactive task action that directly launches Node; the hidden
PowerShell arguments apply only to management commands, not to that action.
The old window's PID was not captured, so its specific process identity is not
an observed fact. No running task was modified or restarted during this review.

The installation correction updates only an existing task's action; missing
tasks retain the initial interactive registration. This addresses overwriting
operator settings, not first-install console visibility. Three focused Windows
cases passed using real PowerShell with every Scheduler command replaced by a
fixture function. They verify action-only update, unchanged first-install
defaults, and update failure without registration or restart. These initial
runs used the default five-second budgets; the scoped correction below assigns
an explicit budget to these three real-process fixtures. Password credential
reuse has not been exercised
with a real Scheduler task; parameter omission alone is not presented as native
credential validation.

Rush build (3.87 s), lint (39.81 s), test typechecking (8.89 s), built CLI smoke
(4.55 s), and the complete default suite (102.2 s) all returned zero on Windows.
The eight package logs total **2,917 passed and 25 skipped**. These are this run's
observed counts, not the previous limited-token run's counts. Authenticated
models and the real Scheduler lifecycle gate were not enabled. Independent
whole-diff review found no blocking issue.

Each command ran beneath an outer synthetic account/application environment;
its sentinel snapshot remained unchanged. The outer verification did not fully
pass: the build check initially counted Node's compile cache as a fixture
leftover, so subsequent commands placed that cache separately under the same
captured root. After the successful full test, the empty-temp assertion found
five `dx-spill-*` directories. The unchanged baseline `completion-body.test.ts`
creates five parent directories but removes only each `spill` child. Their
contents were not retained for inspection. The outer `finally` removed the
captured root, including these leftovers. This distinguishes successful Rush
gates from the failed extra cleanup assertion; no real account configuration
was used as a cleanup target.

References: [Set-ScheduledTask](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/set-scheduledtask),
[login types](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type),
and [the Hidden setting](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-hidden).

### Hosted Scheduler test diagnostics

For the delivered registration correction, the [PR run](https://github.com/excitedjs/dreamux/actions/runs/39285944422)
passed on Windows, macOS and Ubuntu. The same-head
[push run](https://github.com/excitedjs/dreamux/actions/runs/39285935243) failed
on Windows: the existing-task Action update test exceeded its default five-second
budget. The aggregate log has no internal stage evidence. Successful checks in
the other run do not negate this failure.

A separate [instrumented run](https://github.com/excitedjs/dreamux/actions/runs/39288179836)
retained the assertions, process options, Scheduler shadows, cleanup and original
five-second budgets. One of three Windows samples timed out in all three cases.
Each child had emitted its parent-observed spawn event, but the parent received
no stderr or PowerShell marker before timeout cleanup killed and joined it.
This bounds the observed failure window; it does not establish that PowerShell
never executed, or distinguish startup, parsing, delivery and scheduling delay.
The other two samples completed the original assertions.

The subsequent [bounded observation control](https://github.com/excitedjs/dreamux/actions/runs/39290230390)
changed only those three test deadlines to 30 seconds on the diagnostic branch.
All nine cases completed their original assertions and process joins. One
simulated Set failure took 8,771.53 ms. Its first PowerShell marker arrived
238.80 ms after the test began. Within that PowerShell process, the Set shadow
record point to the start of finally JSON output took 6,823.46 ms; JSON output
itself took 18.48 ms. The record point precedes the fixture's Write-Error, so
this interval does not isolate an internal error-handling operation. The other
eight cases took 318.77–4,705.60 ms.

This control proves that a case can continue after five seconds and complete
the expected rejection. It is not a pass under the original deadline, does not
identify the earlier failures' underlying cause. Timings use differences within
each process; marker delivery and logging add observation overhead. No real
Scheduler registration or operator
task was exercised by these fixture tests.

The resulting test correction assigns a 30-second deadline only to the three
real-PowerShell registration cases. Their contract covers command binding,
preserved registration settings and error propagation, not a five-second
performance target. The explicit deadline gives headroom above the observed
8.77-second completion while retaining a bounded failure for a hung fixture.
It is an engineering budget, not a statistical guarantee or a claim that a
shorter deadline could not work. Assertions, subprocess options and cleanup
remain unchanged; the suite default, retries and production behavior do not
change. Diagnostic instrumentation stays off the PR branch.

The non-instrumented change passed the three focused Windows cases first
(405, 416 and 451 ms); the synthetic account sentinels were unchanged, the
temporary directory was empty and the captured outer root was removed. Rush
build (2.81 s), lint (22.90 s), test typechecking (9.65 s), and the complete
default suite (127.5 s) then returned zero. Within the full run, the three
registration cases took 388, 402 and 421 ms. Model and real Scheduler gates
remained disabled. The full run again preserved the synthetic account but
failed the extra empty-temp assertion on the same five baseline spill-parent
fixtures described above; the outer finally removed its captured root.
Knowledge and change-declaration checks passed. Independent review found no
blocking issue. The resulting [PR CI](https://github.com/excitedjs/dreamux/actions/runs/39294884826)
and [push CI](https://github.com/excitedjs/dreamux/actions/runs/39294874965)
completed successfully on Windows, macOS and Ubuntu. All six complete platform
logs confirmed eight successful test packages; model gates remained excluded.
These results belong to the deadline revision, before the Password-default
correction above.

## Historical Vitest-native test isolation

The operator requested replacing the custom process launcher with Vitest's
native configuration and lifecycle, then required small-scope isolation checks
before broader test execution. The host, utils, Codex and Claude configs share
a global setup; the types, channel and bootstrap suites have no account-home
dependency and invoke Vitest without that setup. No dependency was added.

Static review confirmed that cleanup captures only the directory returned by
this setup's `mkdtemp`, including initialization failures. It never derives a
removal target from a home environment variable. Vitest's `setupFiles` hook
installs the provided environment before loading test modules. Watch reruns
reuse the setup directory; fixtures must join their child processes and close
handles before global teardown.

The initial config-environment design passed five real-Vitest cases but review
identified Vitest 2.1.9's caching of a failed global setup. A synthetic-account
probe made TEMP/TMP/TMPDIR point at a regular file, producing a real filesystem
error before tests imported. After repairing that path, the native watch
"rerun all" path executed the fixture against the original synthetic homes.
The existing nonzero exit code did not prevent that execution. Default rerun
with an empty collected-file list did not exercise the issue and is not counted
as its reproduction. All account sentinels remained unchanged in the probe.

The final design therefore provides the environment only after initialization
succeeds. The setup-file hook requires that injected value before importing
tests. It also removes the need to mutate or restore the runner's environment.

The final implementation passed the normal-run case first, then all six
real-Vitest regressions on Windows (3.55 seconds): successful and failed CLI
runs, configured and default synthetic auth opt-in, watch rerun/close, and
watch rerun after setup failure. The last case observes the missing-environment
error and absence of the test-import marker, not merely a nonzero exit code.
All nested and outer synthetic account sentinels were preserved, generated
homes were removed, and temporary directories were empty. The allocation
failure is exercised with the real filesystem; cleanup after later `mkdir`
or `provide` failures is source-reviewed, not separately fault-injected.
Watch coverage uses native rerun APIs and normal close, not filesystem-triggered
reruns or forced process termination.

The broader isolated run passed lint and test typechecking, but a Workflow
lifecycle case failed while awaiting its third controlled runtime. A diagnostic
copy retained its assertions and one-second wait. Its first attempt was stopped
earlier by a fixture ACL problem: the workspace inherited Modify access while
the system temporary directory inherited FullControl. Moving only that
diagnostic's synthetic root to the system temporary directory reproduced the
runtime assertion and captured the actual failed agent creation. Node had
created its identity temporary file, but the native security lookup rejected
the 279-character path with Windows error 123. The Workflow had already
terminated before the assertion timed out. This establishes the diagnostic
failure's immediate cause; the original aggregate log did not capture its
underlying path or journal. Neither the wait nor its assertion was relaxed.

An independent getter-only control opened and closed one real long file with
Node, then queried the same object through `GetNamedSecurityInfoW`: the raw
283-character path returned 123, while Node's namespaced form returned zero.
Descriptors and the captured temporary root were released. The native owner
now applies `toNamespacedPath` once to the input for both security lookup and
update; errors still identify the original path. Pipes and Job names are
unchanged. Six regressions cover directories and atomic file publication with
absolute, relative and already-namespaced paths. Before the correction the four
raw-path cases failed with 123 and both namespaced cases passed; afterward all
six passed (278 ms). They inspect real ownership/DACLs, preserved content and
absence of temporary publication files. Synthetic account snapshots were
unchanged, and all temporary roots were removed.

After rebuilding, the same diagnostic consumer passed with its original setup
snapshot, assertions, one-second wait and long temporary-root layout. The third
runtime was created about 51 ms after the Workflow receipt; deliberate dissolve
stopped the agent and run, and fixture teardown completed. The single case
passed in 1.686 seconds. Actual child environments, including the Workflow
runner, used only synthetic homes and temporary directories; the captured root
was removed afterward. Together with the getter control and regression tests,
this verifies the long-path correction without changing the test's timing
contract.

Final local gates passed on Windows: Rush build (4.35 s), lint (15.04 s), test
typechecking (6.64 s), built CLI smoke (1.04 s), and the complete default test
suite (98.73 s). The package logs total **2,901 passed and 38 existing platform,
privilege or opt-in skips**; the original Workflow lifecycle case is included.
Each gate's outer process used synthetic homes and temporary directories, with
sentinel preservation and captured-root cleanup verified afterward. No
authenticated model or real Task Scheduler lifecycle run was enabled.
Independent whole-diff review found no blocking issue. Cross-platform execution
of this revision remains subject to the PR's hosted CI matrix.

### Tarball fixture cleanup follow-up

The [push workflow](https://github.com/excitedjs/dreamux/actions/runs/39269169263)
passed all three platform suites, while the [PR workflow](https://github.com/excitedjs/dreamux/actions/runs/39269181743)
failed only its Windows host suite. The tarball content-scan rejection case
exceeded the default five-second deadline; its `afterEach` then failed to
unlink `leaky.tgz` with `EBUSY`. The full log has no await-stage timing or lock
owner, so it does not establish whether packing, scanning or an external delay
caused the timeout. Passing results from the same head do not answer that.

Source review identified a cleanup lifetime mismatch: Vitest's timeout does
not cancel the original async test body, but the global `afterEach` immediately
removed its registered fixture directories. Either the packing tar process or
the scanner's tar child could still be using the archive. Normal scanner
completion already waits for both output consumption and child close.

Each content-scan case now owns its directory through a scoped async fixture
callback. Its `finally` runs after the callback's awaited subprocess work
settles, instead of an independent `afterEach` removing the directory while
that work is still pending. The global directory registry is removed, and
packing receives the case's directory. Assertions, commands and the five-second
limit are unchanged. This corrects the cleanup overlap; it does not identify
the historical timeout's slow stage or promise cleanup after forced worker exit.
Cleanup now runs inside the original five-second test budget. Timeout still
does not cancel the body; its later settlement reaches the fixture's `finally`.
The four focused cases passed on Windows (873 ms) inside a synthetic outer
environment, with unchanged sentinels and complete captured-root cleanup.

After formatting the changed test, Rush build, lint and test typechecking
passed. The complete default suite passed again in 98.82 seconds with
2,901 tests passed and 38 existing skips; outer sentinels and temporary-root
cleanup checks passed. The scanner implementation and production build inputs
were unchanged. Independent review accepted the fixture lifetime correction;
its limited claim about the original CI timeout is retained.

### Hosted tarball and managed-reporting diagnostics

The next [PR run](https://github.com/excitedjs/dreamux/actions/runs/39272036480)
still timed out in two Windows tarball cases, without an `EBUSY` report or an
await-stage trace. A diagnostic branch retained the original assertions, time
budgets, subprocess arguments, streams and cleanup while adding phase markers.
Its [first three-sample run](https://github.com/excitedjs/dreamux/actions/runs/39274771416)
passed all tarball cases but timed out in one managed-reporting case. These
markers have observation overhead; repeated Rush log blocks are not additional
samples.

The [second diagnostic run](https://github.com/excitedjs/dreamux/actions/runs/39278900052)
completed all three Windows jobs successfully. One tarball case nevertheless
took 4,914.58 ms including cleanup: the packing subprocess await took 4,156.08 ms,
while directory removal took 2.87 ms. Within its parent PID, spawn to the exit
callback was 4,155.33 ms, exit to close was 0.14 ms, and close to await settlement
was 0.49 ms. This locates an observed slow interval before the exit callback;
it includes child execution and scheduling, not just tar CPU or filesystem time.
The requested executable remained the bare name `tar`, so its actual image was
not identified. The other five tarball cases took 177.84 to 396.60 ms.

All three managed-reporting bodies completed in 969.37 to 1,060.00 ms; each
observed await was below 100 ms, and all begin/end pairs completed. Cleanup had
no separate marker there and cannot be inferred by subtracting the body time
from Vitest's reported duration. These later results do not determine the
historical timeout causes. No assertion or timeout was relaxed, and diagnostic
instrumentation remains outside the PR branch.

## Historical intermittent Windows CI investigation

The initial Windows attempt in the [push run](https://github.com/excitedjs/dreamux/actions/runs/39223839571)
reported two Claude failures: a query-mismatched cursor returned
`provider_failure` instead of `cursor_invalid`, and the malformed skill-target
publication test exceeded its unchanged five-second deadline. The same-head PR
run and a failed-job rerun passed. Those successes do not establish either cause;
the original reporter omitted the complete activity error and skill await stage.

For the activity fixture, all five `scan_unsupported` paths were inspected.
Its six-line history excludes the four pagination/rewrite paths; discovery's
two-second wall-clock budget is the remaining source of `provider_failure`.
An isolated real-reader/filesystem/Git comparison returned the expected query
mismatch in 21.6 ms. Delaying delivery of the real Git completion callback by
2.2 seconds instead returned `scan_unsupported` after 2,227.9 ms, with a stack
through discovery's budget check before cursor decoding. Restoring normal
delivery returned the query mismatch in 23.6 ms. This establishes the ordering
mechanism, not whether the historical delay was in Git, filesystem work or
runner scheduling.

Two added real-history regressions first mint a nonempty cursor, then remove
the history or replace its session metadata. Both failed before the correction
and passed after moving pure cursor decoding before discovery. Malformed and
query-mismatched cursors now take precedence over unavailable history; valid
cursors still report unavailable history, and invalid limits remain first.
All 13 activity-reader tests passed locally without changing the existing
assertions or time budgets.

After rebuilding, the same delayed-completion probe rejected each mismatched
query in under 0.2 ms and observed no Git call for those requests; the delay
could no longer affect validation. Rush build and the complete Claude lint,
test typecheck and test gates passed (241 tests, one existing elevated-only
skip). Independent review found no blocking issue in the source and regression
changes.

The skill failure did not recur in 16 isolated baseline cases, 128 concurrent
cases, or the same 128-case comparison without async hooks. A separate
[three-runner diagnostic run](https://github.com/excitedjs/dreamux/actions/runs/39227974176)
retains the original warmup, full Rush test load, assertions and deadlines.
It records full activity errors and skill await stages/native async resources.
Async resource lifetimes are observations, not proof of kernel I/O latency.

All three hosted samples completed the full test workload. Each runner had four
CPUs and about 16 GiB RAM; Rush allowed three simultaneous packages. These are
capacity measurements, not resource-utilization traces. The old activity order
returned the expected query mismatch in 207.5, 164.1 and 198.6 ms. The skill
case completed its assertions in 49.4, 52.8 and 43.5 ms, and cleanup finished
at 168.2, 69.8 and 59.0 ms respectively. Every publication gate entered and
released; no stage approached five seconds. The diagnostic output's repeated
Rush summary/dump records were deduplicated rather than counted as more runs.

These observations do not recover the historical skill failure's missing
stage or establish an OS, scheduling, locking or Koffi cause. No speculative
production workaround, retry, concurrency reduction or timeout increase was
applied. The diagnostic branch and run preserve the capture procedure for a
future recurrence; the cursor correction does not claim to fix the unexplained
skill-publication timeout.

## Historical lazy native initialization

The [follow-up comment](https://github.com/excitedjs/dreamux/pull/476#discussion_r4311329746)
identified eager Koffi addon loading through static Windows-owner imports.
Fresh Node processes now observe actual `process.dlopen` calls before importing
the built utils barrel or the server, daemon control/install/status, workflow
runner and MCP shim modules. All eight new cases failed against the previous
build because import alone loaded Koffi; all eight passed after rebuilding the
two native owners. The Windows first-use case concurrently creates four real
Jobs and prepares four private directories, verifies open/acquire/close and
Job disappearance, and observes exactly one addon load after first use.

The focused run passed two utility tests and six host tests on native Windows.
The full workspace passed Rush build, lint, source and test typechecking, built
CLI smoke and 2,889 tests with 38 existing platform, privilege or opt-in skips
(99.6 seconds). This includes the actual native Job, ACL and pipe regressions.
Authenticated model execution and the opt-in real Task Scheduler lifecycle were
not enabled in this round. Unix execution is left to the hosted CI matrix.
Independent source/test review found no blocking issue and confirmed that
GetLastError ordering, synchronous close and native resource lifetimes remain
unchanged. No startup-time benchmark was performed; this verifies addon loading
behavior, not the reviewer's timing measurements. Runtime lazy loading does not
remove the installed dependency.

## Historical native failure-path regressions

The follow-up requested in the [PR review](https://github.com/excitedjs/dreamux/pull/476#pullrequestreview-5568105760)
adds four native Windows cases without changing production code. They interrupt
the real bootstrap after `openRoot`, send a mismatched challenge over real IPC,
and terminate a Job while its unassigned candidate is either alive or already
exited. Independent native handles check membership and completion; a target
file marker and the named Job's disappearance check execution and release.
The wrong-challenge case verifies that launch remains pending, then explicitly
ends the wrapper. It does not prove that production proactively terminates a
live wrapper after a mismatched response, or simulate actual PID reuse.

The focused child/Job run passed all 12 tests, including all four additions.
Isolated temporary copies verified test sensitivity: removing the membership
gate made the live-candidate test fail because termination waited on it;
accepting any string challenge made the mismatch test fail because launch
proceeded. Both mutation runs failed as intended and cleaned up their fixtures;
the shared production sources were not modified.

Rush build passed. The complete utility package passed lint, test typechecking
and 214 tests with seven existing platform/privilege skips across 15 test files.
Other packages' local tests were not repeated for this test-only follow-up;
the earlier full-workspace results below belong to the prior correction run.
Independent review of the complete test and documentation diff found no
remaining blocking issue. It checked that injection-hook assertions cannot be
mistaken for expected launch errors, that reply waits have a failure deadline,
and that fixture cleanup joins pending native waits before closing handles.

## Historical review corrections

The 2026-10-19 correction run used a limited-token native Windows process and
the disposable-home test wrapper. Rush build, lint, source typecheck, test
typecheck and built CLI smoke passed. The full suite passed 2,878 tests with
37 platform, privilege or model-opt-in skips and no failures. It enabled
`DREAMUX_RUN_WINDOWS_SERVICE_TEST=1`, including the isolated Scheduled Task's
external and internal restart/stop, descendant cleanup and uninstall. The task
was removed after the run. Model execution was not enabled in this correction run.

Regression evidence:

- Duplicate `Path`/`PATH` keys selected the ambient executable before the fix;
  afterward a real executable probe agrees with native Node and selects the
  configured override. Four native environment comparisons also exercise
  insertion order and undefined-value key selection at the lookup helper.
- A real Job with 256 members required 257 retained-handle waits and previously
  threw `Too many asynchronous calls are running`. Serial waiting passes, with
  every retained process handle signaled immediately when termination returns.
- Both real provider factories run a synthetic child which observes ownership
  and ACLs before writing inherited logs. Existing permissive logs failed the
  oracle before the fix; fresh and existing log cases now pass and retain
  contents across two starts. Focused provider runs passed two tests each.
- Each provider also has an elevated-Windows-only foreign-owner rejection test:
  it checks unchanged ACLs/content and uses a native sharing lock to prove an
  opened append handle was closed. These two cases were skipped locally because
  the token was limited. The subsequent [corrective CI run](https://github.com/excitedjs/dreamux/actions/runs/39205126641)
  passed both provider packages on Windows, Linux and macOS. Its aggregated Rush
  logs do not expose individual test or skip counts, so they do not independently
  confirm execution of the elevated-only cases.

The nine repository-tooling tests passed with a workspace-local Python
interpreter. The pinned gitleaks installer verified its archive and executable.
Independent review covered the complete corrective diff, native fixture
cleanup, cross-platform test paths and file-handle ownership; no blocking
in-scope finding remained. Review also observed that JSON bootstrap IPC drops
undefined environment values. Current callers provide string-valued overrides,
so no production producer of that generic API edge case was found; the patch
does not change serialization or claim complete supervised-env equivalence.

## Historical native-capability refactor

After the operator required Node/native capabilities outside platform-service
management, the final Windows run passed the following gates:

| Gate                                                          | Result                                                                                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rush update, build, source typecheck, lint and test typecheck | Passed across the workspace                                                                                                                               |
| Full default suite                                            | 2,867 passed, 36 platform/opt-in skips, zero failures; 93 seconds                                                                                         |
| Built CLI smoke                                               | Passed                                                                                                                                                    |
| Real Task Scheduler lifecycle                                 | Passed install, repeated restart, internal restart/resumed notice, internal stop, start, disabled-state preservation and uninstall using an isolated task |
| Generated Node and batch-target service launchers             | Passed Unicode paths, arguments, log output and target exit code                                                                                          |
| Explicit authenticated model gate                             | Six tests passed across three files in 90 seconds after operator authorization                                                                            |
| Node repository tooling                                       | Nine tests passed, including real commit hooks, content scans, author policy, KB checks and archive validation                                            |
| Native installer                                              | Pinned Windows gitleaks download, checksum verification, extraction and version check passed                                                              |
| Process-exit regression                                       | 100 native-handle/cwd probes passed; unchanged Claude session tests passed                                                                                |

The final process owner prohibits new Job members before collecting verified
member handles, terminates only the retained Job, and waits for the native
process objects to finish. The regression asserts that an outer service Job's
host, target and detached grandchild are all signaled before deleting their cwd,
without waiting for Node's close event or adding cleanup retries. A separate
backpressure regression preserves a 1.2 MB terminal IPC message before exit.

The native permission oracle checks owner-only access for both explicit and
inherited private ACLs. Explicit permission APIs still assert protected DACLs
and inheritance flags. The fixture that loosens a directory retains inheritable
owner access; it no longer removes permissions from existing child files.
Logger and attachment-cache tests additionally verify ownership before the
first content write or cache hit can hide a creation-time defect.

Koffi is the only new runtime dependency in the utility package. Independent
review checked the original layering rationale: utilities must not depend on
Dreamux packages, including type-only imports. The guard now tests that boundary
across dependencies, peerDependencies and optionalDependencies instead of
requiring an empty runtime dependency field.

The local token is not elevated. Administrator-owned adoption and foreign-owner
refusal require an elevated Windows runner; that coverage is delegated to the
Windows CI job rather than claimed from this machine.

The ownership and fixture fixes passed the complete Linux, macOS and Windows
[CI matrix](https://github.com/excitedjs/dreamux/actions/runs/39155120513),
including the elevated Windows log/cache assertions.
Independent review confirmed that the fixes retain strict ownership and
foreign-owner refusal. The later service-control change is checked separately.

Dispatcher self-upgrade is an existing real caller of notification restart.
The original Windows sequence could terminate that caller before completing
task restoration and start. An isolated WMI probe verified the controller has
the same SID and interactive session, is outside the target Job, and continues
after terminating it. The real Task Scheduler test then exercised compiled
service code from inside its own Job: a new generation received the existing
`Restart completed.` notice, consumed its marker, and left no old fixture
parent or child. All task names and roots were disposable; the operator's
running service was not used by this regression.
The final service suite also verifies an internal stop restores the task's
enabled state, alongside external repeated restarts, ordinary stop/start,
disabled-state preservation and uninstall. The combined daemon/privacy run
passed 47 tests, and the native Job suite passed seven tests. Independent
review checked that external callers retain their wait/error semantics and
the hidden controller captures native failure details into the existing log.

Installing the published alpha into a separate npm prefix exposed a CLI version
defect: yargs inferred a manifest from its dependency location, returning
`unknown` for a hoisted install and the workspace's `0.0.0` in the repository.
The CLI now reads its own packaged manifest explicitly. The built CLI smoke
compares against that manifest's exact version from a caller directory outside
the package; notification self-upgrade continues to use the existing version
and resumed-notice surfaces.
The strengthened smoke failed before the fix and passed afterward. Build,
lint, test typechecking and ten related CLI tests passed; two file-symlink
cases require privileges unavailable locally. Both packaged entry points also
reported the exact alpha version in the separate npm installation layout.

## Historical initial native Windows checks

The initial local run on 2026-10-19 used Node 22.23.3 and Rush 5.140.0.

| Gate                                                       | Result                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `rush update`                                              | Passed; workspace dependencies installed through Rush                            |
| `rush build`                                               | Passed for the complete dependency graph                                         |
| `rush typecheck`                                           | Passed in all eight applicable packages                                          |
| `rush lint`                                                | Passed in all nine packages                                                      |
| `rush typecheck:tests`                                     | Passed in all eight applicable packages                                          |
| `rush test`                                                | Passed: 2,848 tests, 32 platform/opt-in skips; zero failures                     |
| `rush smoke-built-cli`                                     | Passed                                                                           |
| Compiled foreground server and separate CLI status process | Passed in an isolated Windows home                                               |
| Real Task Scheduler lifecycle                              | Passed: install, start, restart, stop, disabled-state preservation and uninstall |
| Installed Codex protocol                                   | Passed: initialize and thread startup over stdio, then owned-process cleanup     |

The full test run took 6 minutes 42 seconds. Its warnings identify the explicit
live-model opt-in boundary and expected test logger output. After that run, only
the new 800-case native publication regression's execution budget was raised
from 15 to 60 seconds for its 1,600 native permission-process invocations; its
workload and assertions are unchanged. The later hosted-runner findings and their production fixes are recorded below.

## Historical hosted runner follow-up

The elevated Windows runner creates new filesystem objects with the token's
default Administrators owner, even below a user-owned private directory.
Synchronous Pino creation therefore left logs that a later limited server
could not adopt. The existing asynchronous server startup now prepares every
fixed log destination and its directory before constructing loggers. Cache
publication similarly establishes ownership before writing attachment bytes,
and cache hits verify ownership. Strict owner assertions remain in place;
tests also preserve existing log contents and verify cache misses immediately.

Git fixtures explicitly select LF after initialization, including when the
operator's global configuration enables `core.autocrlf`. The native launcher
fixture expands Windows short paths with `realpathSync.native`. The three
affected suites passed with an isolated global `core.autocrlf=true` config.

The final Node-tooling matrix exposed canonical temporary paths: Git expands
Windows runner short names and resolves macOS `/var` symlinks. The hook fixture
now resolves its temporary root before comparing the complete gitleaks argv.
Its synthetic KB paths also use path segments, so the real source-reference
checker does not mistake fixture strings for citations into this repository.
The actual knowledge and anti-leak gates are unchanged. The nine tooling tests
and complete KB check pass locally after these fixture corrections.

The first hosted run passed the complete Linux gate and exposed two test
infrastructure differences: Windows checkout converted source to CRLF, and
macOS resolved temporary parent symlinks in the launcher path. Root Git
attributes now retain LF under `core.autocrlf=true` (checked with a disposable
Git checkout), and the launcher test compares the canonical installed path.
Argument preservation and exit-code assertions are unchanged. The targeted
Windows launcher suite and its lint/test type checks pass.

The subsequent Windows runner reached the native suite and exposed inherited
PowerShell 7 module paths shadowing Windows PowerShell modules, plus a leaf-link
check relying on unavailable Windows O_NOFOLLOW. Native regressions reproduce
module shadowing and exercise linked leaves and file replacement at both open
boundaries without requiring file-symlink privileges. Production helpers now
reset only PSModulePath, and activity reads verify leaf and descriptor identity
before reading. Live-model fixtures also use native executable resolution and
PowerShell commands, with private credential-copy roots.

The published alpha was installed globally on the native Windows machine.
After a first scheduled instance exited with `0xC000013A`, the task was started
again and remained alive across independent process invocations; the admin
status command reported the same server PID and increasing uptime. The first
exit was not reproduced, so no speculative production workaround was added.

## Historical review and finding disposition

Independent reviews covered the provider transport and home changes, native
process execution and termination, daemon and IPC lifecycle, permission owners,
test isolation, and worktree cleanup. The final filesystem publication fix was
reviewed separately against both publication contracts; the final journal owner
change was reviewed against ordering, privacy and recovery behavior.

| Finding                                                                                                | Disposition and verification                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HOME-only fixtures can reach the native Windows account home                                           | Fixed in each affected fixture and in the package test launcher; success/failure isolation tests preserve an operator sentinel                                                                       |
| Unix socket, process, path and permission assumptions block Windows                                    | Fixed at their owning boundaries; native named-pipe, ACL, process-tree, argument and junction tests pass                                                                                             |
| Worktree removal can run with its own target as the Git subprocess cwd                                 | Run removal from the shared Git directory; real managed-worktree lifecycle tests pass                                                                                                                |
| Journal appends launched repeated native permission preparation                                        | Move preparation to the journal owner's creation/load boundary; ordered writes, existing-file tightening and missing-file refusal tests pass                                                         |
| Elevated provider sessions leave Administrators-owned log directories or files                         | Providers prepare their own directories and open append files before output; native child observations and content-preservation regressions pass locally, with elevated cases assigned to Windows CI |
| Case-insensitive PATH lookup disagrees with Node when duplicate key spellings exist                    | Apply Node's lexicographic key precedence; real executable and child-environment regressions pass                                                                                                    |
| A large Job queues more native waits than Koffi permits                                                | Wait for the existing retained handles sequentially; a 256-member native tree is fully signaled when termination returns                                                                             |
| Closing a temporary file before hardlink publication can leave the Windows target refusing replacement | Keep its handle through publication and temporary-link cleanup; 800 concurrent fresh create/replace cases and the unchanged lifecycle suite pass                                                     |
| Polling timeouts can race slower native I/O                                                            | Wait for actual submission, completion, settlement or error events; retain all behavioral assertions                                                                                                 |

No accepted blocking finding remains unresolved. Product behavior review is
recorded in the final design. Knowledge links and task records are checked with
`.agents/scripts/check.mjs` before submission.

## Historical authenticated native model checks

With usable Codex authentication restored, the explicit model gate passed all
six cases across the three live-model files on native Windows (102 seconds).
It exercised real model execution, ordinary/ultrathink effort and cold resume,
persisted session continuity, structured output, in-flight activity reads,
unbound native turn completion, and issue #63 mid-operation input folding with
MCP reply/reaction calls. Feishu platform IO was intercepted locally by the
fixture; these were not live platform sends. Operator authentication and
configuration were read into private disposable homes, not modified by tests.

## Coverage boundary

The final R4 default suite explicitly excluded installed-Codex/live protocol
and model-turn checks. Earlier installed-protocol and authenticated model results
above are historical evidence, not certification of this final revision.
Model-turn cases remain explicit opt-in and are not implied by the default suite.
Unix-only signal/mode/socket tests remain exercised on the Unix CI matrix;
Windows runs native ACL, named-pipe and process-tree counterparts. Cross-platform
CI results and published artifact status are owned by GitHub, not this task record.
Windows forced service termination does not guarantee Unix signal-based draining.
