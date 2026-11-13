# Requirement

## Confirmed behavior and desired outcome

The installed CLI required Bash and Unix process/IPC facilities and could not
start natively on Windows. The operator selected native Windows source support
rather than WSL, and authorized implementation, a PR to `next`, and an alpha
published from the PR branch, in that order.

Windows must run the same foreground server, local administrative commands,
provider sessions, workflow children, and managed user-service lifecycle.
Tests and CI must exercise native Windows behavior. Portable Node path APIs
should replace platform conditionals when they express the same contract.

## Scope and invariants

The 2026-11-13 follow-up asks for smoother installation after a real local
upgrade. A user who has the required Windows object permissions must not need
an extra administrator-membership condition to adopt Administrators-owned
Dreamux logs. The current-account password dialog must not require guessing
Microsoft-account aliases. Observing a service Job must request only the rights
used for that observation. These corrections must not bypass native access
checks, accept another user's private files, weaken stop's exit guarantee, or
turn unlocated historical Job error 5 into a claimed diagnosis. Validation in
this slice does not modify the running installation or reopen deferred R5.

The 2026-11-12 correction requires a native Windows credential dialog, not a
terminal password prompt. Installation still selects Password logon. Credentials
remain local to the registration process and are never requested through chat.
Windows restart must launch a responding replacement instance; acknowledging
an external controller or a Scheduler command is not that completion evidence.
When the caller belongs to the old service, it must distinguish handing off the
operation from observing the new service, including installation results and
daemon/onboard output. Reassessment also removes unrelated
release-only abstractions and changes to historical verification records.

The approved service-entry revision replaces generated launcher code with a
packaged entry. Task Scheduler Data owns the captured environment and business
command; the registered WorkingDirectory selects the root. A Windows Task path
is an identifier for display, not a file-ledger or filesystem target. The approved
old-alpha upgrade requires successful old-version service removal before the
package is replaced; the exact sequence is in the final design and public docs.

- Support native Windows without requiring Bash or WSL for normal CLI operation.
- Preserve Linux/macOS behavior and the existing logical admin path and lock.
- Importing shared utilities or host entry modules must not load the Windows capabilities' Koffi addon; load it only when a native capability is invoked.
- Keep provider-specific transport and home rules inside their provider packages.
- Enforce private native ACLs where Unix uses owner-only permissions.
- Accept long Windows file paths consistently at the Node filesystem and native ACL boundaries.
- Stop owned Windows descendants and release files before reporting completion.
- Isolate tests that resolve account/application homes through Vitest-native environment configuration and lifecycle hooks, including focused and watch invocations. Keep ordinary Vitest commands and avoid a separate test-process launcher; packages that do not use these homes need no isolation setup.
- Retain behavioral assertions; specialize only genuinely platform-specific OS contracts.
- Publish a PR before dispatching the branch alpha release. Do not merge the PR.

## Acceptance criteria

- The compiled launcher, foreground server and admin/MCP traffic work on Windows.
- A real installed Codex initializes over its Windows transport in a disposable home.
- Native process tests preserve literal arguments, including multiline prompts, and reap descendants.
- Windows executable lookup selects the same case-insensitive environment key as Node when a provider overrides `PATH` alongside an ambient `Path`.
- Terminating a Job with more than 256 wait handles completes without exhausting the native binding's asynchronous-call queue.
- Interrupted or mismatched bootstrap identity verification must not start target work; failed launch releases its owned native resources.
- Job termination remains safe when a held candidate exits before assignment or termination, and does not wait for or terminate a live candidate outside that Job.
- Provider log directories and files are current-user-owned before child output starts, including when created by an elevated Windows foreground server.
- Task Scheduler installation, status, start, stop and removal work for the current user.
- Windows installation uses Password logon for the current user so the service runs without an interactive desktop console. New installations, login-mode conversions and changed launch Data collect the required account credential in the native local dialog; Dreamux must not persist it in configuration, Task Data, command-line arguments or environment variables.
- Reinstalling an already-Password task with identical launch Data refreshes only its action without resetting its triggers or settings. Changed Data or a login-mode conversion uses the existing definition with credentials while preserving its other settings. Registration errors propagate without silently falling back to Interactive or S4U.
- Windows uninstall protection rejects case aliases of protected paths before service changes, without changing the filesystem paths used for I/O or Unix comparison behavior.
- Managed stop and restart retain owned-process termination and waiting across the interactive CLI and non-interactive service sessions.
- Windows managed stop/restart first requests application shutdown over the registered root's admin endpoint after verifying the server belongs to the service Job. Request acceptance is separate from completion; request and exit observation share a 15-second grace period before forced cleanup of remaining owned processes. Restart still waits for the old tree to exit before its single Run and new-server readiness check.
- Rush build, lint, test and test typechecking pass, with native Windows included in CI.
- Fresh-process imports of built utilities, server, daemon, workflow and MCP modules do not load Koffi; concurrent first Windows capability calls initialize successfully.
- Test homes are disposable; explicit live model runs may copy authentication into a fixture, never modify the original home.
- PR and branch alpha artifacts identify the reviewed implementation.

## Coverage limits

Real model completion requires separately opted-in, usable provider authentication.
Windows native forced termination cannot run application cleanup. The approved
cooperative stop path gives the host and CoT a bounded cleanup opportunity,
but cannot guarantee remote terminal delivery during network failure or a crash.
Real GUI behavior, Password credential storage/reuse, cross-session operation and
existing registered Task ACL preservation remain unverified. The operator
deferred the early-entry stop case before Job assignment and approved closeout
with that explicit coverage gap; existing ready-state tests do not cover it.
