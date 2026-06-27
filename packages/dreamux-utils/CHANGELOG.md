# Change Log - @excitedjs/dreamux-utils

This log was last generated on Sat, 27 Jun 2026 12:09:24 GMT and should not be manually modified.

## 0.2.0
Sat, 27 Jun 2026 12:09:24 GMT

### Minor changes

- #209 shared leaf-package helpers (@excitedjs/dreamux-utils): pure, dependency-light primitives absorbed from byte-identical duplicates across core and the provider packages (config-validate primitives, owner-only-dir / process / fs helpers, completion-body + turn-render helpers, and the unix-socket-path budget primitives). Depends only on @excitedjs/dreamux-types; no third-party runtime deps.

### Patches

- Add `packages/dreamux-utils/src/fs.ts` with a shared `writeAtomic(dir, filename, data, mode?)` helper (tmpfile + O_CREAT|O_EXCL + rename, default mode 0o600) and re-export it from the package barrel index. Previously this helper lived inside `@excitedjs/feishu-channel` (v3 pairing-code access gate); hoisting it lets downstream packages share the same atomic-write primitive without copying. Future filesystem primitives (safe tmpdir, safe unlink) belong in this module rather than the sibling `os.ts` module (process/signal/directory-enforcement primitives).

