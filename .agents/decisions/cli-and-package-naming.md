# Package name `@excitedjs/dreamux` and single `dreamux` CLI

- **Status:** Accepted; bin-alias portion superseded by [global-bin-onboard-serve](global-bin-onboard-serve.md)
- **Date:** 2026-05-28
- **Updated:** 2026-06-02
- **Affects:** public CLI surface, npm package name, package bin entries
- **PR / Issue:** [issue #4](https://github.com/excitedjs/dreamux/issues/4), [issue #18](https://github.com/excitedjs/dreamux/issues/18)

## Context

Issue #4 established the npm package name `@excitedjs/dreamux` and moved the
repo into the Rush monorepo. The first monorepo-era implementation kept a
small router plus old package-global aliases while the host MVP was still
settling.

Issue #18 replaced that transitional surface. There are no legacy global-bin
users to protect, so the published package now installs one global bin named
`dreamux`.

## Decision

- npm package name remains **`@excitedjs/dreamux`**.
- The package installs exactly one public bin:

  ```json
  { "dreamux": "./bin/dreamux" }
  ```

- Canonical command tree:

  ```bash
  dreamux onboard
  dreamux serve
  dreamux status
  dreamux doctor
  dreamux dispatcher add
  dreamux dispatcher remove
  dreamux dispatcher list
  dreamux dispatcher status
  dreamux dispatcher start
  dreamux dispatcher stop
  dreamux config path
  dreamux config show
  ```

- `dreamux serve` is the foreground server entry point. Service managers also
  invoke `dreamux serve`.
- `src/cli/server.ts` and `src/cli/server-ctl.ts` remain internal delegated
  modules while the CLI is migrated. They are not package-global bins.
- Repo-root `/bin/dreamux` remains as a source-checkout convenience shim. There
  are no repo-root shims for the removed aliases.

## Consequences

- New code, docs, and READMEs introduce `dreamux <command>`.
- Do not reintroduce package-global aliases for the server or admin client.
- Launcher tests assert that `package.json#bin` contains only `dreamux`.
- Command parsing uses `yargs` per the issue #18 design; commodity CLI parsing
  should not be hand-rolled.

## Superseded behavior

The old three-bin package surface and old server-start command form are no
longer preserved. This is an intentional issue #18 product decision, not a
compatibility regression.

## Alternatives considered

- **Keep package-global aliases for one release:** rejected by issue #18.
  There is no installed-user population that needs a transition period.
- **Publish one bin per verb:** rejected. npm's `bin` field would pollute
  `node_modules/.bin/` with short names that risk collision with other packages.
- **Bare `dreamux` starts the server:** rejected. It hides the onboarding and
  daemon management surface behind a server-only default.
