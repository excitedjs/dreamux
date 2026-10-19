# Verification

## Existing Windows task registration

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
blocking issue; hosted checks of the resulting delivery remain pending.

## Vitest-native test isolation

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

## Intermittent Windows CI investigation

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

## Lazy native initialization

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

## Native failure-path regressions

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

## Review corrections

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

| Gate | Result |
| --- | --- |
| Rush update, build, source typecheck, lint and test typecheck | Passed across the workspace |
| Full default suite | 2,867 passed, 36 platform/opt-in skips, zero failures; 93 seconds |
| Built CLI smoke | Passed |
| Real Task Scheduler lifecycle | Passed install, repeated restart, internal restart/resumed notice, internal stop, start, disabled-state preservation and uninstall using an isolated task |
| Generated Node and batch-target service launchers | Passed Unicode paths, arguments, log output and target exit code |
| Explicit authenticated model gate | Six tests passed across three files in 90 seconds after operator authorization |
| Node repository tooling | Nine tests passed, including real commit hooks, content scans, author policy, KB checks and archive validation |
| Native installer | Pinned Windows gitleaks download, checksum verification, extraction and version check passed |
| Process-exit regression | 100 native-handle/cwd probes passed; unchanged Claude session tests passed |

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

## Initial native Windows checks

The initial local run on 2026-10-19 used Node 22.23.3 and Rush 5.140.0.

| Gate | Result |
| --- | --- |
| `rush update` | Passed; workspace dependencies installed through Rush |
| `rush build` | Passed for the complete dependency graph |
| `rush typecheck` | Passed in all eight applicable packages |
| `rush lint` | Passed in all nine packages |
| `rush typecheck:tests` | Passed in all eight applicable packages |
| `rush test` | Passed: 2,848 tests, 32 platform/opt-in skips; zero failures |
| `rush smoke-built-cli` | Passed |
| Compiled foreground server and separate CLI status process | Passed in an isolated Windows home |
| Real Task Scheduler lifecycle | Passed: install, start, restart, stop, disabled-state preservation and uninstall |
| Installed Codex protocol | Passed: initialize and thread startup over stdio, then owned-process cleanup |

The full test run took 6 minutes 42 seconds. Its warnings identify the explicit
live-model opt-in boundary and expected test logger output. After that run, only
the new 800-case native publication regression's execution budget was raised
from 15 to 60 seconds for its 1,600 native permission-process invocations; its
workload and assertions are unchanged. The later hosted-runner findings and their production fixes are recorded below.

## Hosted runner follow-up

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

## Review and finding disposition

Independent reviews covered the provider transport and home changes, native
process execution and termination, daemon and IPC lifecycle, permission owners,
test isolation, and worktree cleanup. The final filesystem publication fix was
reviewed separately against both publication contracts; the final journal owner
change was reviewed against ordering, privacy and recovery behavior.

| Finding | Disposition and verification |
| --- | --- |
| HOME-only fixtures can reach the native Windows account home | Fixed in each affected fixture and in the package test launcher; success/failure isolation tests preserve an operator sentinel |
| Unix socket, process, path and permission assumptions block Windows | Fixed at their owning boundaries; native named-pipe, ACL, process-tree, argument and junction tests pass |
| Worktree removal can run with its own target as the Git subprocess cwd | Run removal from the shared Git directory; real managed-worktree lifecycle tests pass |
| Journal appends launched repeated native permission preparation | Move preparation to the journal owner's creation/load boundary; ordered writes, existing-file tightening and missing-file refusal tests pass |
| Elevated provider sessions leave Administrators-owned log directories or files | Providers prepare their own directories and open append files before output; native child observations and content-preservation regressions pass locally, with elevated cases assigned to Windows CI |
| Case-insensitive PATH lookup disagrees with Node when duplicate key spellings exist | Apply Node's lexicographic key precedence; real executable and child-environment regressions pass |
| A large Job queues more native waits than Koffi permits | Wait for the existing retained handles sequentially; a 256-member native tree is fully signaled when termination returns |
| Closing a temporary file before hardlink publication can leave the Windows target refusing replacement | Keep its handle through publication and temporary-link cleanup; 800 concurrent fresh create/replace cases and the unchanged lifecycle suite pass |
| Polling timeouts can race slower native I/O | Wait for actual submission, completion, settlement or error events; retain all behavioral assertions |

No accepted blocking finding remains unresolved. Product behavior review is
recorded in the final design. Knowledge links and task records are checked with
`.agents/scripts/check.mjs` before submission.

## Authenticated native model checks

With usable Codex authentication restored, the explicit model gate passed all
six cases across the three live-model files on native Windows (102 seconds).
It exercised real model execution, ordinary/ultrathink effort and cold resume,
persisted session continuity, structured output, in-flight activity reads,
unbound native turn completion, and issue #63 mid-operation input folding with
MCP reply/reaction calls. Feishu platform IO was intercepted locally by the
fixture; these were not live platform sends. Operator authentication and
configuration were read into private disposable homes, not modified by tests.

## Coverage boundary

Default installed-Codex checks initialize the real protocol without model auth.
Model-turn cases remain explicit opt-in; their separate authenticated result is
recorded above and is not implied by the default suite.
Unix-only signal/mode/socket tests remain exercised on the Unix CI matrix;
Windows runs native ACL, named-pipe and process-tree counterparts. Cross-platform
CI results and published artifact status are owned by GitHub, not this task record.
Windows forced service termination does not guarantee Unix signal-based draining.
