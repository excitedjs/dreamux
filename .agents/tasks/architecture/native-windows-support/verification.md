# Verification

## Native Windows checks

The completed local run on 2026-10-19 used Node 22.23.3 and Rush 5.140.0.

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
workload and assertions are unchanged. No production code changed after the run.

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
| Closing a temporary file before hardlink publication can leave the Windows target refusing replacement | Keep its handle through publication and temporary-link cleanup; 800 concurrent fresh create/replace cases and the unchanged lifecycle suite pass |
| Polling timeouts can race slower native I/O | Wait for actual submission, completion, settlement or error events; retain all behavioral assertions |

No accepted blocking finding remains unresolved. Product behavior review is
recorded in the final design. Knowledge links and task records are checked with
`.agents/scripts/check.sh` before submission.

## Coverage boundary

Default installed-Codex checks initialize the real protocol without model auth.
Model-turn cases remain explicit opt-in and are not certified by these checks.
Unix-only signal/mode/socket tests remain exercised on the Unix CI matrix;
Windows runs native ACL, named-pipe and process-tree counterparts. Cross-platform
CI results and published artifact status are owned by GitHub, not this task record.
Windows forced service termination does not guarantee Unix signal-based draining.
