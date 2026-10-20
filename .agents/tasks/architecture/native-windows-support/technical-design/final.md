# Native process and filesystem boundaries

## CLI and processes

The published executable is a plain Node ESM launcher that resolves its own
symlink and compiled entrypoint independently of the caller working directory.
Shared async process utilities own PATH/PATHEXT lookup, npm Node shim execution,
Windows argument preservation and descendant termination. Windows executable
lookup follows Node's lexicographic key selection for duplicate names, so a
provider's string-valued `PATH` override beside an ambient `Path` resolves the
same executable that Node selects. Unix process groups
retain their existing behavior. Windows uses native Job Object ownership from
before the target starts, including descendants whose ancestors already exited.
Termination first closes the Job to new members, holds and verifies its member
process handles, then waits for those objects to finish exiting one at a time.
Serial waits avoid filling Koffi's asynchronous-call queue on large process trees;
all retained handles remain owned until waiting completes. The Job's active
count alone can reach zero before Windows releases a process's working directory.
Numeric PID ancestry is not process ownership: Windows can reuse a parent's PID
while an older child still records it. The previous snapshot/taskkill traversal
is therefore replaced rather than filtered or retried.

Shared capabilities use Node APIs first. Where Node lacks the required Windows
kernel interface, the platform implementation uses the pinned Koffi native
binding with asynchronous calls for blocking work. Business paths do not spawn
PowerShell, icacls, whoami, or taskkill for filesystem, IPC, or process management.
Platform command lines remain confined to persistent-service management.

Each native owner dynamically imports Koffi on its first capability call and
caches the complete initialization Promise. ABI descriptions and DLL bindings
are created inside that initialization; ordinary utility and host imports do
not load the native addon, including on Unix. Each Job instance retains the
resolved API so handle release stays synchronous. Create/OpenJob and GetLastError
remain adjacent synchronous calls after initialization. Security helpers share
their initialized API without changing token, descriptor or pipe lifetimes.
This changes runtime loading, not dependency installation or JS module imports.

## IPC and providers

The logical `run/admin.sock` path and its filesystem lock remain the identity of
an admin endpoint. Windows maps its normalized absolute spelling to a hashed
named pipe; the server applies a current-user-only DACL before admitting work.
Unix continues to use a private filesystem socket with its length budget.
MCP launch definitions invoke the Node launcher through Node on Windows.

The Codex provider uses its supported stdio JSON-RPC transport on Windows and
retains the Unix websocket transport elsewhere. One RPC client owns request and
notification semantics across both transports. Claude skill directories use
Windows junctions and ordinary Unix symlinks. Existing provider home resolvers
own configuration overrides and OS home fallback.

Claude activity reads validate the record limit and decode the cursor's query
fingerprint before discovering history. A malformed or query-mismatched cursor
therefore returns `cursor_invalid` even when history is missing, has different
session metadata, or discovery would exhaust its time budget. This corrects the
previous discovery-first error precedence. File identity, session evidence,
rewrite evidence and byte-boundary checks still require the opened history.
The discovery budget and its behavior for valid queries are unchanged.

## Service and privacy

Windows registers a Password, limited-token Task Scheduler task for the current
user at logon. Password logon runs without the interactive desktop console;
the logon trigger remains separate from that login mode. The same registration
PowerShell process collects the account password with `Read-Host -AsSecureString`
only for a new task or a conversion from another mode. It passes a transient
credential directly to the Scheduler Object parameter set. Dreamux does not
receive the password in JavaScript or put it in arguments, environment, files
or logs. Task Scheduler stores the login credential. Registration can prompt
only in a terminal; without one, PowerShell's non-interactive mode rejects the
prompt. Dry runs do not prompt or launch registration.

An existing Password task receives an action-only update. Other existing tasks
keep their full definition, including triggers, settings, description and run
level, while installation updates the action and selects the current user's
Password principal. Errors propagate without fallback to Interactive or S4U.
Installation owns
`DREAMUX_ROOT/daemon.mjs`, including pinned executable,
arguments, environment and append-only log routing. The Node launcher owns a
named service Job in the `Global` namespace with a current-user-only DACL, so
the desktop CLI and non-interactive service refer to the same kernel object.
Ordinary supervised children retain their own nested Jobs.
Stop disables the task and acquires its named Job, reserving the name if startup
has not created it yet. It terminates and awaits the owned processes before
stopping the task action, then releases the Job. A late launcher cannot create
another Job during this interval. No process tree is reconstructed from PIDs. The
previous task-enabled state is preserved. Unix service managers remain unchanged.

Before service installation writes or registration changes, installation inspects
the actual registered launcher and refuses to change a running or queued task's
Job identity. This includes a previous alpha's Local Job or moving the service
to another root. The operator must stop that service from outside its process
tree first. This avoids
overwriting the only recorded old Job name or terminating an installer running
inside it. The old cross-session stop/wait limitation is not retroactively
repaired; the Global guarantee begins with the newly launched definition.
Normal Global reinstalls and self-upgrade retain the existing control path.

Dispatcher self-upgrade invokes the restart command from inside that same Job.
Before mutating the task, service control checks membership against its actual
registered launcher's Job. A member hands the operation to a short-lived
same-user WMI-created Node process, which survives the old Job and runs the same
control path against the registered task name. No extra scheduled task or
durable operation record is introduced. External callers still await control
directly; the existing resumed notification confirms an internal restart.
This uses the documented [WMI process creation behavior for Job membership](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
without enabling breakaway for ordinary supervised children.

Shared filesystem utilities enforce Windows ACLs and Unix modes. The Windows
owner converts filesystem paths with Node's `toNamespacedPath` before native
security lookup and update, matching Node's support for long paths. Pipe
addresses and Job names remain in their own native namespaces. Startup
privately prepares the configured log destinations and their directories before
synchronous file logging; DACL inheritance alone does not override an elevated
token's Administrators default owner. Each provider prepares its own log directory
and each opened append file with the same private ownership primitives before
passing descriptors to its child. Existing log content is preserved, and failed
preparation closes the opened descriptor. Attachment-cache files receive current-user
ownership before writing bytes, and cache hits verify the existing file. Atomic
writes secure new temporary files before content is written. The WorkflowJournal
owner prepares privacy at creation or recovery load, then appends only to the
existing file through its serialized queue. Path containment uses native path operations.
Activity file opens retain Unix O_NOFOLLOW; Windows checks leaf metadata before
and after each open against the held descriptor before any content is read.

## Tests and delivery

Package test commands invoke Vitest directly. The host, utils, Codex and Claude
packages reference `common/testing/isolated-home.mjs` from their Vitest configs.
This native global setup allocates a short disposable home and sets HOME,
USERPROFILE, CODEX_HOME, CLAUDE_CONFIG_DIR and DREAMUX_ROOT through Vitest's
`provide`/`inject` and `setupFiles` hooks before test modules load. An absent
injected environment blocks test imports if initialization failed, including
subsequent watch runs. Its returned teardown removes only the captured
generated directory; setup failure also releases that directory. Watch reruns
reuse the directory until Vitest closes. Tests must finish their own child
processes and close file descriptors before global teardown.
The types, channel and bootstrap tests do not resolve account/application homes
and need no such setup. Live model opt-in passes the original auth source
separately for fixture copies; ordinary runs remove the inherited auth-source
variable in workers without modifying the runner's environment. Config and
global-setup imports themselves run before the test environment is installed
and must not access application state.
Native ACL assertions use real Windows permissions instead of synthetic mode bits.
Bootstrap failure regressions interrupt the real child between retaining its
process handle and Job assignment, and send a mismatched challenge over its
actual IPC channel. Observations cover target execution, native membership,
process completion and Job release. Separate live and exited candidate cases
verify that retaining a handle alone does not grant termination or wait authority.
Fault scheduling stays in tests; production launch and native ownership APIs
retain their existing behavior.
Repository-owned file cleanup, content scanning, download verification, and
knowledge checks use Node rather than Bash/PowerShell orchestration. Git,
gitleaks, build tools, and mature archive tools remain direct executable calls.
CI runs Rush gates on Linux, macOS and Windows. Delivery creates the PR to `next`
first, then dispatches the existing alpha workflow on that branch.

## Product behavior review

The product catalog adds native Windows execution and qualifies managed stop:
Windows task termination cannot promise Unix signal-based draining. Existing
Unix shutdown behavior, local state ownership, uninstall containment, channel
routing and provider-neutral orchestration remain in force. The change removes
no existing user-visible capability.
