# Native process and filesystem boundaries

## CLI and processes

The published executable is a plain Node ESM launcher that resolves its own
symlink and compiled entrypoint independently of the caller working directory.
Shared async process utilities own PATH/PATHEXT lookup, npm Node shim execution,
Windows argument preservation and descendant termination. Unix process groups
retain their existing behavior. Native Windows termination waits for process
exit so filesystem cleanup follows handle release.

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
user. Installation owns `DREAMUX_ROOT/daemon.ps1`, including pinned executable,
arguments, environment and append-only log routing. Stop resolves this task's
running engine, terminates its owned process tree, then stops the task. The
previous task-enabled state is preserved. Unix service managers remain unchanged.

Shared filesystem utilities enforce Windows ACLs and Unix modes. Log directory
preparation precedes synchronous file logging. Atomic writes secure new temporary
files before content is written. The WorkflowJournal owner prepares privacy at
creation or recovery load, then appends only to the existing file through its
serialized queue. Path containment uses native path operations.

## Tests and delivery

Every package test command launches Vitest through `common/scripts/run-tests.mjs`.
The wrapper allocates a short disposable home, sets HOME, USERPROFILE, CODEX_HOME,
CLAUDE_CONFIG_DIR and DREAMUX_ROOT, and removes only that generated directory.
Live model opt-in passes the original auth source separately for fixture copies.
Native ACL assertions use real Windows permissions instead of synthetic mode bits.
CI runs Rush gates on Linux, macOS and Windows. Delivery creates the PR to `next`
first, then dispatches the existing alpha workflow on that branch.

## Product behavior review

The product catalog adds native Windows execution and qualifies managed stop:
Windows task termination cannot promise Unix signal-based draining. Existing
Unix shutdown behavior, local state ownership, uninstall containment, channel
routing and provider-neutral orchestration remain in force. The change removes
no existing user-visible capability.
