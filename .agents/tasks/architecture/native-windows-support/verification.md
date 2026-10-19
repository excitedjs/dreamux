# Verification

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
  the token was limited. Elevated first-create ownership and these failure paths
  require the current Windows CI run; Unix log behavior requires its Unix matrix.

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
