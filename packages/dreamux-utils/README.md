# @excitedjs/dreamux-utils

Pure shared utilities for the Dreamux host and its provider packages
(issue [#209](https://github.com/excitedjs/dreamux/issues/209)). These are the
byte-identical helpers that were previously vendored separately into the codex,
claude-code, and feishu-channel packages and the host core; consolidating them
removes the duplication while keeping the provider packages free of any
dependency on `@excitedjs/dreamux` core.

This package depends on nothing: not on `@excitedjs/dreamux` core, and not on
`@excitedjs/dreamux-types`, which is the type set external providers compile
against.

## Exports

- **json-shape** — generic JSON-shape primitives with no error-message
  vocabulary (`isPlainObject`, `asString`, `nonEmptyString`).
- **error-info** — reading an arbitrary thrown value (`errorMessage`,
  `errorInfo`, `ErrorInfo`).
- **config-validate** — neutral config-validation primitives that produce
  `dreamux config error in <file>: ...` messages (`readNonEmptyString`,
  `readStringArray`, …), built on `json-shape`.
- **os** — platform/filesystem primitives (`isProcessAlive`,
  `isProcessGroupAlive`, `killProcessGroup`, `ensureOwnerOnlyDir`,
  `removeEmptyLogFile`, `pathExists`). These are generic OS helpers, not
  Dreamux layout/path contracts.
- **fs** — atomic-write primitives, one per publish semantic
  (`publishFileExclusive` for create-only, `writeFileAtomic` for overwrite).
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
  `SupervisedChildOptions`, `SupervisedChildExit`).
- **activity-scan** — neutral scan mechanism shared by provider-owned Activity
  readers: bounded positional reads, digests, path containment, and a scan
  budget, with no native history layout or record shape of its own
  (`createScanBudget`, `readBytesAt`, `isPathWithin`, `scanDigest`,
  `isScanDigest`, `activityQueryFingerprint`, `SCAN_DISCOVERY_MAX_ENTRIES`,
  `SCAN_DISCOVERY_MAX_ELAPSED_MS`).
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
