# npm release via OIDC trusted publishing

- **Status:** Accepted
- **Date:** 2026-05-30
- **Affects:** npm publishing of every `shouldPublish` package, `/.github/workflows/`, the rush version mechanism
- **PR / Issue:** infra/feishu-transport-release

## Context

The monorepo publishes more than one package to the public npm registry (the
`@excitedjs/dreamux` CLI today; `@excitedjs/feishu-transport` and others as they
are re-homed). We want **zero long-lived npm tokens**: npm's OIDC trusted
publishing (GA 2025-07-31) lets a GitHub Actions job exchange its short-lived
OIDC id-token for a publish token, and stamps build **provenance**. The
reference flow exists in the sibling **claudemux** repo, but it is pnpm +
changesets; dreamux is a Rush + pnpm monorepo, so the version+publish half has
to be rush-native — and the publish must span every publishable package.

Three hard constraints shaped the design:

- **Publishing must stay Rush-native.** `rush publish --publish` invokes pnpm's
  publish path for Rush projects, which lets pnpm rewrite source-only
  `workspace:*` dependencies into registry-installable semver in the published
  manifest. Raw `npm publish` from a package directory is forbidden because it
  preserves `workspace:*` and breaks external installs.
- **npm trusted publishing is per-package.** Each package is configured on
  npmjs.com individually, but one workflow *run* can publish many packages:
  Rush compares every `shouldPublish: true` project against npm and invokes
  publish only for versions that are not already present.
- **Provenance is carried through npm's environment contract.** Rush 5.140 has
  no dedicated `--provenance` flag, but the workflow upgrades npm to 11.5.1+
  and sets `NPM_CONFIG_PROVENANCE=true` on the Rush publish step. That setting
  is inherited by the final npm publish process used by pnpm, where npm
  exchanges the GitHub Actions OIDC id-token for a short-lived publish token.
- **Main is protected.** The [anti-leak guardrail](anti-leak-guardrail.md) makes the
  `gitleaks` check required on `main`, so the workflow uses a GitHub App token
  rather than the default `GITHUB_TOKEN` when it pushes the bot version-bump
  commit to `main`.

## Decision

One workflow, `push: [main]` plus manual dispatch:

- **`/.github/workflows/release.yml`** — the single release pipeline and the
  workflow every publishable package registers as its trusted publisher. On a
  push to `main`, it first checks whether that push introduced new Rush change
  files under `/common/changes/`. If not, it no-ops, which prevents the bot's
  own release commit from looping. If yes, it installs through Rush and runs
  `rush publish --apply` to consume those change files into package.json and
  CHANGELOG bumps across all changed packages. It commits those version
  artifacts back to `main` with a GitHub App token, then a separate publish job
  checks out the updated branch, builds the monorepo, and runs
  `rush publish --include-all --publish --set-access-level public` against the
  public npm registry. Rush compares every publishable package against npm and
  invokes pnpm publish only for versions that are not already present.
  `id-token: write`, `npm install -g npm@11.5.1`,
  `NPM_CONFIG_PROVENANCE=true`, no `NODE_AUTH_TOKEN`. Manual dispatch is a
  retry hook for `main` only; packages are never published from feature
  branches.

So **Rush owns versioning and publish orchestration, pnpm owns the registry
manifest rewrite, npm owns the OIDC/provenance upload**, and all halves are
monorepo-wide.

## Consequences

- **Required setup the npm account owner must do** (per package, cannot be done
  from the repo): for *each* package this pipeline should publish, register a
  trusted publisher on npmjs.com — owner `excitedjs`, repository
  `excitedjs/dreamux`, workflow **`release.yml`** (the same file for every
  package), environment blank. Adding a package later = a rush.json entry + one
  npm entry; no workflow change.
- **First publish of any package is a one-time token bootstrap, not OIDC.** npm's
  trusted-publisher config lives on a package's settings page, which exists only
  after the package has been published once — so the *first* publish of each
  package (dreamux, feishu-transport, …) must be a manual `npm publish` with a
  token to create it; only then can the trusted publisher be configured and
  `release.yml` (pure OIDC) take over from the next version. Confirmed from the
  sibling **claudemux** repo: `@excitedjs/tm`'s only version (1.1.0) carries no
  provenance despite `claudemux-release.yml` using `--provenance`, and the OIDC
  workflow (PR #150) landed *after* the package was first published (PR #148).
- **Per-package requirements** for a green publish: `shouldPublish: true` in
  rush.json; a build (`npm run build` → `dist`) + a `files` allowlist (`prepack`
  recommended so pack output matches CI output); and a `repository` field
  pointing at github.com/excitedjs/dreamux (npm provenance requires it).
  `workspace:` dependencies are valid in source package manifests, but raw
  `npm publish` from a package directory is forbidden; the release workflow must
  use Rush native publish so pnpm prepares the registry manifest.
- **Required GitHub App secrets:** `DREAMUX_RELEASE_APP_ID` and
  `DREAMUX_RELEASE_APP_PRIVATE_KEY`. The App must be allowed to push the
  release bot commit to protected `main`.
- **Optional hardening:** run the publish in a protected GitHub Environment with
  required reviewers (commented in the workflow); if enabled it must match the
  npm trusted-publisher Environment field of every package.
- The workflow self-breaks its trigger loop: push-triggered runs proceed only
  when the push added a Rush change file under `/common/changes/`. The bot
  version-bump commit consumes those files and includes `[skip ci]`, so it does
  not start a redundant CI/release run. Manual dispatch on `main` skips this
  change-file guard so maintainers can retry publishing already-versioned
  packages after a transient npm or OIDC failure.

## Alternatives considered

- **Raw `npm publish` from each package directory** — rejected: it keeps
  `workspace:*` in the published manifest, so external `npm install` fails with
  `EUNSUPPORTEDPROTOCOL`.
- **Custom `rush-pnpm pack` + `npm publish <tarball>` orchestration** —
  rejected after review: it duplicates Rush's publish orchestration and is more
  fragile than the native Rush + pnpm publish path. Provenance is supplied
  through `NPM_CONFIG_PROVENANCE=true` instead.
- **Per-package release workflows** — rejected: N near-identical files that
  drift, fighting Rush's coordinated monorepo model. One looping workflow scales
  by adding a rush.json entry + one npm config. Revisit only if a package needs
  different release governance (its own environment / reviewers).
- **Separate version PR workflow** — rejected after the claudemux release flow
  proved the operational shape: a merge to `main` should be enough to version
  and publish packages. The PR model avoided a GitHub App secret, but it made
  every release a second maintainer action.
