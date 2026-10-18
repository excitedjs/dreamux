# @excitedjs/dreamux-utils

Shared utilities for the Dreamux host and its provider packages
(issue [#209](https://github.com/excitedjs/dreamux/issues/209)). These are the
byte-identical helpers that were previously vendored separately into the codex,
claude-code, and feishu-channel packages and the host core; consolidating them
removes the duplication while keeping the provider packages free of any
dependency on `@excitedjs/dreamux` core.

This package does not depend on `@excitedjs/dreamux` core or
`@excitedjs/dreamux-types`. Its Windows adapters use Koffi to call Win32 APIs
directly; operating-system libraries load only when a Windows operation runs.

## Exports

- **json-shape** — generic JSON-shape primitives with no error-message
  vocabulary (`isPlainObject`, `asString`, `nonEmptyString`).
- **error-info** — reading an arbitrary thrown value (`errorMessage`,
  `errorInfo`, `ErrorInfo`).
- **rule-violation** — the error a validator throws for a value it checked and
  refused (`RuleViolation`). It lives here so a provider's config reader and
  the host's request readers share one class without the provider depending on
  the host.
- **config-validate** — neutral config-validation primitives that throw a
  `RuleViolation` carrying a `dreamux config error in <file>: ...` message
  (`readNonEmptyString`, `readStringArray`, …), built on `json-shape`.
- **os** — platform/filesystem primitives (`isProcessAlive`,
  `isProcessGroupAlive`, `killProcessGroup`, `ensureOwnerOnlyDir`, `ensureOwnerOnlyFile`,
  `removeEmptyLogFile`, `pathExists`). These are generic OS helpers, not
  Dreamux layout/path contracts. Group probes and signals apply only to POSIX;
  Windows termination requires a launch-owned Job through `SupervisedChild`. Windows
  private paths use a protected current-user ACL instead of POSIX mode bits.
  Permission tightening rejects symlink leaves and foreign owners; an elevated
  token may adopt paths owned by Administrators. ACL reads and writes call
  Win32 directly without starting a command interpreter or utility process.
- **process-command** — async executable resolution (`resolveExecutableOnPath`)
  and launch (`spawnCommand`) with Windows PATH/PATHEXT handling, hidden child
  windows, and literal argument forwarding through npm command shims. Standard
  npm Node shims launch their script directly, preserving multiline arguments;
  other batch files reject multiline arguments that `cmd.exe` cannot preserve.
- **windows-security** — native pipe privacy (`restrictWindowsPipe`), replacing
  the existing pipe DACL with current-user full access before admitting clients.
- **fs** — atomic-write primitives, one per publish semantic
  (`publishFileExclusive` for create-only, `writeFileAtomic` for overwrite).
  Private Windows files receive current-user ownership and a protected ACL
  before data is written, replacing explicit default grants as well as inherited
  permissions. Completion spill files use this same publication owner.
  Their temporary handle remains open through publication and temporary-link
  cleanup so an exclusively created file stays replaceable on Windows.
  Atomic replacement retries transient Windows sharing locks for at most one
  second without unlinking the previously committed file.
- **completion-body** — bounded teammate-completion resolution: inline a short
  result, spill an over-budget result to an owner-only file under a
  host-supplied spill directory (`resolveCompletionBody`,
  `completionInlineBudget`, `COMPLETION_INLINE_BUDGET_DEFAULT`,
  `COMPLETION_INLINE_BUDGET_MAX`).
- **socket-budget** — Unix-domain socket path-budget primitives so a rendezvous
  socket path fits the kernel's `sun_path` limit on every platform
  (`DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES`, `unixSocketPathFitsBudget`,
  `assertUnixSocketPathBudget`).
- **supervised-child** — spawn or fork a child process and track its exit under
  one shape (`SupervisedChild`, `SupervisedChildLaunch`,
  `SupervisedChildOptions`, `SupervisedChildExit`). On Windows a controlled Node
  bootstrap waits until its held process handle is verified over its original
  IPC channel and assigned to a native Job. Only then can target code or user
  preloads run. Stdio and fork IPC retain their ordinary contracts. Stop prevents
  new Job members, retains and verifies the current members' native process
  handles, then terminates the Job and waits for those objects to finish exiting,
  including descendants whose parents already exited. The Job's active count
  alone can reach zero before process resources are released. Kernel
  kill-on-close also cleans the tree if its owning host dies. No PID ancestry
  discovery or command-line termination is used.
- **windows-job** — native Job ownership for the Windows launch adapter and
  daemon service boundary. Named service Jobs have a protected current-user ACL;
  daemon control can acquire an existing Job or reserve its name before startup.
  Termination waits for its nested trees to exit; the caller retains the Job
  until `close()` so a concurrent service launch cannot reuse its name.
- **activity-scan** — neutral scan mechanism shared by provider-owned Activity
  readers: file opening with canonical-root and inode checks, bounded
  positional reads, digests, path containment, and a scan
  budget, with no native history layout or record shape of its own
  (`openActivityFile`, `OpenedActivityFile`,
  `createScanBudget`, `readBytesAt`, `isPathWithin`, `scanDigest`,
  `isScanDigest`, `activityQueryFingerprint`, `SCAN_DISCOVERY_MAX_ENTRIES`,
  `SCAN_DISCOVERY_MAX_ELAPSED_MS`). POSIX opens use `O_NOFOLLOW`; Windows
  checks the leaf before and after each open and matches both identities to
  the held descriptor before exposing it for reading. Links and replaced
  files are rejected, with all failed-open handles closed.
- **activity-error** — the error a provider-owned Activity reader throws and
  catches for its own control flow, with a `reason` that projects across the
  provider seam (`ActivityError`, `ActivityErrorDetail`,
  `ActivityErrorReason`).
- **unsupported-feature** — the structural error shape a runtime returns when a
  caller asks for a neutral feature it cannot serve
  (`unsupportedFeatureError`, `isUnsupportedFeatureError`,
  `UnsupportedAgentRuntimeFeatureError`).
- **runtime-state-fence** — the provider-local fatal path for authoritative
  state writes: a write failure or a revoked lease closes the fence, tears the
  native runtime down once, and stops any restart loop
  (`RuntimeStateFence`, `RuntimeStateFencedError`, `isStateLeaseRevoked`,
  `STATE_LEASE_REVOKED_ERROR_NAME`, `RuntimeStateFenceReason`).
- **json-invoke** — the failure boundary for a one-request/one-result JSON
  invocation: a marker a deep implementation can throw, and a runner that
  turns exactly that marker into a settled `ok: false` answer
  (`settleJsonInvoke`, `PublicInvokeFailure`, `SettledInvoke`).
- **redaction** — what a conversation, a log line, and a printed config must
  not publish verbatim, by text shape or by field name
  (`redactText`, `redactJson`, `isSecretKeyName`, `redactSecretKeyValues`,
  `RedactedText`, `JsonValue`).
- **transactional-store** — the generic shape behind every persisted runtime
  store: one file, one owner-supplied loader, one committed in-memory value,
  and one serialized queue for every change (`TransactionalStore`,
  `TransactionalStoreOptions`).
