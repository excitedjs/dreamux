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
PowerShell process opens a native Windows credential dialog for a new task,
a conversion from another mode, or changed installation Data. The dialog requests
the current Windows account password, not a Windows Hello PIN. It passes a transient
credential directly to credentialed Scheduler XML registration. Dreamux does not
receive the password in JavaScript or put it in arguments, environment, files
or logs. Task Scheduler stores the login credential. The dialog does not depend
on a TTY branch. Cancellation or a native error aborts registration; credential
buffers are cleared and freed in the same PowerShell process. Dry runs do not
open the dialog or launch registration.

Only an existing Password task with ordinal-equal Data receives an action-only
update without another prompt. Other registrations update Action and Data from
one COM TaskDefinition through credentialed XML registration in that same
PowerShell process. Existing triggers, settings, description and run level are
preserved; a new task uses `IgnoreNew`. Errors propagate without falling back to
Interactive or S4U. Installation data enters PowerShell over UTF-8 stdin rather
than increasing the encoded command arguments. Preserving definition XML does
not by itself prove preservation of the task object's ACL or stored credentials.
New-task XML sets `RegistrationInfo.SecurityDescriptor` to grant the current SID,
SYSTEM and Administrators full access for the Limited self-controller; updates
do not explicitly reset an existing task's custom descriptor.

The Action invokes the selected Node executable and published
`dist/daemon/windows-entry.js` with the registered task name. Its absolute
WorkingDirectory is `<DREAMUX_ROOT>/state`; the parent supplies the root for
startup, logs, status and control. TaskDefinition.Data is JSON containing only
`{ environment: Record<string, string>; execStart: string[] }`. It retains the
installation PATH, selected Node and custom Dreamux command. `environment`
excludes `DREAMUX_ROOT`; startup derives that value from WorkingDirectory.
Doctor receives this business command and environment, not the bootstrap Action.
Windows returns the native RegisteredTask.Path as the existing `unitPath: string`;
it is a task identifier, never a file-ledger entry or filesystem removal target.
`serviceUnitPath` describes only Unix unit files. Generated JavaScript, its regex
reader, launcher file writes/removal and the install-time utils import URL are
removed, without adding a configuration file or registry.

The published entry opens append logs and creates and joins the root-hash named
service Job before querying task data or launching business children. Its
`Global` namespace and current-user-only DACL let the desktop CLI and service
address the same object; ordinary SupervisedChild owners retain nested Jobs.
Bootstrap failures go to the daemon stderr log. Before installation writes,
the registered task data and WorkingDirectory establish the existing root;
an active or queued task at a different root must first be stopped from outside
its service tree.

External stop disables the task, acquires/reserves its named Job, terminates
members and awaits their held process handles. It then calls Task.Stop and
validates that the task is neither Running nor Queued and has zero instances,
retaining the Job reservation throughout. Finally it releases the Job and
restores the prior enabled state. Neither Job-name availability nor Scheduler
state alone is a process-exit barrier. Restart completes this stop before one
COM Run; a failure does not fall through to Run. Start/restart enable the task,
require the returned running instance to leave Queued and enter Running, then
await `server.status` at the registered root within a 30-second startup deadline.
The responding PID must belong to the opened service Job. Observation opens an
existing Job without reserving its name. This proves an answering admin endpoint,
not readiness of every provider or Dispatcher. Unix service managers are unchanged.

A caller inside the service hands stop/restart to a short-lived WMI-created Node
process invoking that same published entry, task name and control verb. The
control branch does not join the service Job it must terminate. The caller reports
`handedOff`, not completion; the external controller performs the same stop/start
and readiness checks and writes errors to the registered root's daemon stderr.
The new server's existing restart-intent consumer alone consumes the resumed
notice from that registered root. No extra task or durable operation record is
introduced. This retains the documented
[WMI process creation behavior for Job membership](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
without enabling breakaway for ordinary supervised children.

### Approved Windows alpha service reinstall

The operator approved the published entry and one-time reinstall on 2026-11-12
in the [service-entry revision](service-entry-revision.md). A task without the
new Data fails loudly; WorkingDirectory cannot establish an old launcher's
Local/Global Job identity, and no legacy parser or fallback is retained.

Before upgrading an existing Windows alpha service:

1. Keep the old version available and use the original Windows account and
   original `DREAMUX_ROOT`, from a terminal outside the service tree.
2. Run the old version's `dreamux daemon uninstall` and confirm success. If it
   fails, stop the upgrade rather than overwrite the task. If the old version
   is unavailable, restore a usable old version before proceeding.
3. Upgrade and run `dreamux daemon install`, using the native credential dialog.

This removes and recreates only the service installation; do not delete config,
state or logs. It is the approved upgrade-blocking service-format change, not
an automatic migration or authorization to operate the live installation.
Real dialog interaction, saved-credential reuse and cross-session operation
remain unverified native acceptance boundaries. Query results and registration
shadows do not establish them.

### Filesystem and log privacy

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
routing and provider-neutral orchestration remain in force. The Windows service
definition changes to task-owned launch data and a published entry, with the
explicitly approved one-time alpha service reinstall above.
