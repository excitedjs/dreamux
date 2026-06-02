# One install path: the monorepo (rush) path only

- **Status:** Accepted
- **Date:** 2026-05-31
- **Affects:** install workflow, CI, `CLAUDE.md`, `README.md`, every package's `package.json`
- **PR / Issue:** channel refactor [#4](https://github.com/excitedjs/dreamux/issues/4); this record completes its install-model decision.

## Context

[The Rush + pnpm decision](rush-pnpm-monorepo.md) committed the repo to keeping
**two** install paths working "until a future decision retires one":

1. **Per-package** — `cd packages/dreamux && npm install && npm test`, backed
   by a committed `packages/dreamux/package-lock.json`.
2. **Monorepo** — `rush update` / `rush build` / `rush test`.

The channel refactor (#4) made path 1 unworkable. `@excitedjs/dreamux` now
depends on the freshly-extracted `@excitedjs/feishu-transport` via the pnpm
`workspace:*` protocol. `npm` does not understand `workspace:*`, so
`npm install` / `npm ci` inside `packages/dreamux/` can no longer resolve the
dependency graph. The WIP that merged #4 therefore **deleted**
`packages/dreamux/package-lock.json` (it cannot be regenerated while a
`workspace:*` dep is present) and left the contradiction unresolved — the CI
`package` job (`npm ci`) was left broken and `CLAUDE.md`'s "two install paths"
rule was left violated. This record settles it.

By the time this was decided, `@excitedjs/feishu-transport@0.0.1` and
`@excitedjs/dreamux@0.1.1` were already published to npm, so the
publish-blocker that #4 was waiting on is gone; the only open question was
which install model to keep.

## Decision

**Keep only the monorepo (rush) path. Retire the per-package npm path.**

- `package.json` dependencies stay on `workspace:*` — the correct idiom for a
  rush `useWorkspaces: true` repo. The release workflow must publish a
  pnpm-packed tarball, where pnpm rewrites those source-only dependencies to
  real registry versions in the **published** manifest.
- No per-package `package-lock.json` is committed.
- CI's `package` job (`npm ci`) is removed; its typecheck/build/test coverage
  moves into the `rush` job, which now runs `rush update` → `rush typecheck` →
  `rush build` → `rush test` (`DREAMUX_SKIP_LIVE_CODEX=1`, no codex binary on
  the runner).

Path 1 was always framed as "pre-monorepo muscle memory." The Rush + pnpm decision itself
made the monorepo path "required once a second package lands"; three packages
now exist, so retiring path 1 is the natural close-out, not a new constraint.

## Consequences

- **External consumers are unaffected.** `workspace:*` is a source-only
  protocol; the release workflow's `rush-pnpm pack` step rewrites it to the real
  published version before `npm publish <tarball>`, so
  `npm install @excitedjs/dreamux` resolves `@excitedjs/feishu-transport`
  normally. Raw `npm publish` from a package directory is forbidden because it
  preserves `workspace:*` in the registry manifest.
- **In-repo build/test is rush-only.** `cd packages/dreamux && npm install` now
  fails by design. Use `node common/scripts/install-run-rush.js update` first.
- **Foot-gun:** don't re-add a per-package `package-lock.json` or a `package`
  CI job — `npm` cannot lock a `workspace:*` graph, so either would reintroduce
  the exact breakage this record removes.
- **Guards:** the `rush` CI job is the authoritative
  install/typecheck/build/test gate; PRs also run `rush change --verify` against
  the base branch so release-surface changes declare Rush change files.
  `CLAUDE.md`, `README.md`, and `components/repo-structure.md` all describe the
  single path; this record supersedes the "two paths" consequence of
  [the Rush + pnpm decision](rush-pnpm-monorepo.md).

## Alternatives considered

- **(b) Pin to the published version + regenerate a per-package lockfile.**
  Replace `workspace:*` with `@excitedjs/feishu-transport: ^0.0.1` and commit a
  fresh `packages/dreamux/package-lock.json` so `npm ci` works again. Rejected:
  it abandons the `workspace:*` idiom, couples every core version bump to a
  dreamux relock, and risks the in-repo build silently resolving the *published*
  core from npm instead of the local workspace source — defeating the point of
  the monorepo. `workspace:*` already links the local package (verified: the
  symlink `packages/dreamux/node_modules/@excitedjs/feishu-transport →
  ../../../channel/feishu-transport`).
- **Keep both paths.** Not possible: one `package.json` dependency string cannot
  be both `workspace:*` (for pnpm) and a registry range (for npm) at once.
