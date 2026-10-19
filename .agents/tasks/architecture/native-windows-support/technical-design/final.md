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

## Service and privacy

Windows uses an interactive, limited-token Task Scheduler task for the current
user. Installation owns `DREAMUX_ROOT/daemon.mjs`, including pinned executable,
arguments, environment and append-only log routing. The Node launcher owns a
named service Job, and ordinary supervised children retain their own nested Jobs.
Stop disables the task and acquires its named Job, reserving the name if startup
has not created it yet. It terminates and awaits the owned processes before
stopping the task action, then releases the Job. A late launcher cannot create
another Job during this interval. No process tree is reconstructed from PIDs. The
previous task-enabled state is preserved. Unix service managers remain unchanged.

Dispatcher self-upgrade invokes the restart command from inside that same Job.
Before mutating the task, service control checks membership against its actual
registered launcher's Job. A member hands the operation to a short-lived
same-user WMI-created Node process, which survives the old Job and runs the same
control path against the registered task name. No extra scheduled task or
durable operation record is introduced. External callers still await control
directly; the existing resumed notification confirms an internal restart.
This uses the documented [WMI process creation behavior for Job membership](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
without enabling breakaway for ordinary supervised children.

Shared filesystem utilities enforce Windows ACLs and Unix modes. Startup
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

Every package test command launches Vitest through `common/scripts/run-tests.mjs`.
The wrapper allocates a short disposable home, sets HOME, USERPROFILE, CODEX_HOME,
CLAUDE_CONFIG_DIR and DREAMUX_ROOT, and removes only that generated directory.
Live model opt-in passes the original auth source separately for fixture copies.
Native ACL assertions use real Windows permissions instead of synthetic mode bits.
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
