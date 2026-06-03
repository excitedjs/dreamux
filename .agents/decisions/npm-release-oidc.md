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
  `gitleaks` check required on `main`, so CI cannot push a version-bump commit
  straight to `main` with the default `GITHUB_TOKEN`.

## Decision

Two workflows, both `push: [main]`:

- **`/.github/workflows/release.yml`** — the OIDC publish, and the single
  workflow every publishable package registers as its trusted publisher. It
  installs through Rush, builds the monorepo, then runs
  `rush publish --include-all --publish --set-access-level public` against the
  public npm registry. Rush compares every publishable package against npm and
  invokes pnpm publish only for versions that are not already present.
  `id-token: write`, `setup-node` `registry-url`, `npm install -g npm@11.5.1`,
  `NPM_CONFIG_PROVENANCE=true`, no `NODE_AUTH_TOKEN`. No-ops (green) when
  nothing is ready to publish.
- **`/.github/workflows/version.yml`** — the rush-native replacement for
  `changeset version`. On merge to `main` it runs `rush publish --apply`
  (consumes `common/changes/*` into package.json + CHANGELOG bumps across all
  changed packages; no registry contact, no token) and opens a "version
  packages" PR rather than pushing to protected `main`.

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
- **Optional hardening:** run the publish in a protected GitHub Environment with
  required reviewers (commented in the workflow); if enabled it must match the
  npm trusted-publisher Environment field of every package.
- The version workflow self-breaks its trigger loop: the version PR's merge
  carries no new change files, so the next `rush publish --apply` is a no-op
  (verified locally with an empty `common/changes/`).
- The version workflow must only treat an **open** `release/version-packages` PR
  as reusable. Historical merged or closed PRs with the same head branch are not
  blockers; when no open version PR exists, the workflow creates a new one.
- The generated `release/version-packages` PR is exempt from the CI
  `rush change --verify` job. That branch is the result of
  `rush publish --apply`: it intentionally consumes `common/changes/*` into
  package.json and changelog updates, so requiring another change file would
  make the version PR unmergeable.

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
- **Single-run version+publish that pushes the bump to `main`** (the claudemux
  shape) — rejected: needs a GitHub App token to push to protected `main`; the
  version-PR model needs no extra secret.
