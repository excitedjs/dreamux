# Change Log - @excitedjs/dreamux-utils

This log was last generated on Tue, 25 Aug 2026 11:45:34 GMT and should not be manually modified.

## 0.4.0
Tue, 25 Aug 2026 11:45:34 GMT

### Minor changes

- Add a neutral SupervisedChild process-group lifecycle primitive.
- BREAKING: Review: callers of completion body preparation must stop supplying a public completion ID, and process supervisors must handle stop failures when process-group absence cannot be proved. Oversized completion spills now use opaque exclusive names; shared transcript helpers provide stable rendering, redaction, caps, and fixed-budget projection for provider-owned native readers. No rebuild is required: spill artifacts are rebuildable cache and the new transcript helpers persist no state.

### Patches

- Cap native transcript tool names at 256 Unicode code points and report page truncation only when returned content is clipped. No rebuild is required because transcript projection remains stateless.

## 0.3.4
Mon, 27 Jul 2026 08:35:50 GMT

_Version update only_

## 0.3.3
Sun, 26 Jul 2026 02:44:44 GMT

_Version update only_

## 0.3.2
Sun, 19 Jul 2026 03:45:02 GMT

_Version update only_

## 0.3.1
Wed, 15 Jul 2026 02:54:37 GMT

_Version update only_

## 0.3.0
Fri, 03 Jul 2026 04:51:35 GMT

### Minor changes

- BREAKING: Refine completion body resolution for core-owned plain text completion delivery; the helper now accepts the minimal source/id/result input shape instead of the provider-facing AgentRuntime completion envelope.
- Refine completion body resolution for core-owned plain text completion delivery; the helper now accepts the minimal source/id/result input shape instead of the provider-facing AgentRuntime completion envelope.

## 0.2.0
Sat, 27 Jun 2026 12:09:24 GMT

### Minor changes

- #209 shared leaf-package helpers (@excitedjs/dreamux-utils): pure, dependency-light primitives absorbed from byte-identical duplicates across core and the provider packages (config-validate primitives, owner-only-dir / process / fs helpers, completion-body + turn-render helpers, and the unix-socket-path budget primitives). Depends only on @excitedjs/dreamux-types; no third-party runtime deps.

### Patches

- Add `packages/dreamux-utils/src/fs.ts` with a shared `writeAtomic(dir, filename, data, mode?)` helper (tmpfile + O_CREAT|O_EXCL + rename, default mode 0o600) and re-export it from the package barrel index. Previously this helper lived inside `@excitedjs/feishu-channel` (v3 pairing-code access gate); hoisting it lets downstream packages share the same atomic-write primitive without copying. Future filesystem primitives (safe tmpdir, safe unlink) belong in this module rather than the sibling `os.ts` module (process/signal/directory-enforcement primitives).

