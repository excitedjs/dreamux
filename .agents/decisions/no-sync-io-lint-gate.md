# No synchronous blocking IO in package source

- **Status:** Accepted
- **Date:** 2026-06-05
- **Affects:** all `/packages/*/src/`, the new `@excitedjs/eslint-config`
  package, CI, the pre-commit hook
- **PR / Issue:** [#85](https://github.com/excitedjs/dreamux/issues/85)

## Context

dreamux is one long-running Node process hosting N dispatchers on a single
event loop. Any `fs.*Sync` / `child_process.*Sync` call in runtime or CLI code
blocks that loop: while one dispatcher reads a status file synchronously, every
other dispatcher's inbound, outbound, and Codex traffic stalls. The codebase
had accumulated synchronous IO across config, onboarding, channel state, the
admin socket, the Codex supervisor, and the daemon/CLI paths. We wanted both a
one-time cleanup and a permanent guard so new sync IO cannot regress in.

## Decision

Ban synchronous blocking IO in package source and enforce it with ESLint.

- All `/packages/*/src/**/*.ts` is converted to the async APIs
  (`node:fs/promises`, async `child_process`). The async ripple is threaded
  through every caller (e.g. `DispatcherStore` mutators, `Server.start()`'s
  `await store.hydrate()`, `resolveServiceExecutable`, the doctor/onboard
  chains).
- The rule set lives in a single private workspace package,
  [`@excitedjs/eslint-config`](/packages/eslint-config/), re-exported by a thin
  per-package `eslint.config.js`. Primary rule: `eslint-plugin-n`'s `n/no-sync`
  (suffix `Sync` matcher). Backstops: `no-restricted-imports` (alias imports of
  `*Sync` from `node:fs`/`node:child_process`) and a narrow
  `no-restricted-syntax` (destructure rebind). Disable comments must carry a
  reason (`@eslint-community/eslint-comments/require-description`) and unused
  disables are an error (`reportUnusedDisableDirectives`).
- Scope by glob: `src/**` is a hard `error`; `tests/**` turns `n/no-sync`
  **off** (sync `fs` fixtures are allowed) but still bans synchronous
  `child_process` to discourage new usage.
- `eslint-plugin-n` is pinned to exactly `17.18.0` — the last release before
  `n/no-sync` began requiring TypeScript type information (17.19.0+), which
  would force `parserOptions.project` and break the pure-syntactic config.

## Consequences

- **Enforcement:** `rush lint` (a Rush bulk command) runs `eslint .` per
  package; the CI `rush` job runs it after typecheck; the committed
  `common/git-hooks/pre-commit` lints staged `.ts` against each package's flat
  config (warn-and-pass when eslint isn't installed — CI is the real gate).
  `/packages/dreamux/tests/no-sync-io-gate.test.ts` is an executable contract
  for the rule behaviour (src errors, tests exempt, child_process still banned,
  reason-less disable rejected).
- **`createLogger` stays synchronous.** The `Server` constructor builds loggers
  synchronously, so `runtime/logger.ts` lets `pino.destination({ mkdir, mode,
  sync: true })` own the file open (a config flag, not a `*Sync` call, so it is
  outside the gate). It keeps `sync: true` deliberately — an async destination
  would force a `flushSync()` in a `process.on('exit')` handler, re-adding sync
  IO in the one truly sync-only context. The pre-existing-wider-file 0600
  tighten is preserved as a fire-and-forget async `chmod`.
- **Two audited test exemptions** for synchronous `child_process`:
  `bin-launcher.test.ts` (`spawnSync`) and `codex-live.test.ts` (`execSync`),
  each with a reasoned `eslint-disable`.
- **Foot-gun:** the config is intentionally pure-syntactic (no
  `parserOptions.project`), so `no-floating-promises` is **not** available — a
  newly-`async` function called as a bare statement compiles and lints clean but
  floats at runtime. The cleanup audited every converted write helper's callers
  by hand; future async conversions must do the same.

## Alternatives considered

- **Warning → error staged rollout.** Rejected: the codebase was zeroed in the
  same PR, so the rule ships as `error` immediately with no warning phase.
- **Per-package inline ESLint config.** Rejected in favour of one shared
  `@excitedjs/eslint-config` so the rule set has a single source of truth.
