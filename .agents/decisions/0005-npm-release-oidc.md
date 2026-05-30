# 0005 — npm release via OIDC trusted publishing

- **Status:** Accepted (scaffolding; unexecutable until a publishable package builds)
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

- **`rush publish` cannot do OIDC.** Confirmed against Rush 5.140.0:
  `rush publish` has no `--provenance` flag and authenticates only via
  `--npm-auth-token` / `common/config/rush/.npmrc-publish` (a token). It cannot
  do tokenless OIDC or emit provenance.
- **npm trusted publishing is per-package; `npm publish` is per-package.** Each
  package is configured on npmjs.com individually. But one workflow *run* can
  publish many packages: each `npm publish` does its own OIDC exchange, so every
  package just lists the same workflow file as its trusted publisher.
- **Main is protected.** The anti-leak guardrail (decision 0004) makes the
  `gitleaks` check required on `main`, so CI cannot push a version-bump commit
  straight to `main` with the default `GITHUB_TOKEN`.

## Decision

Two workflows, both `push: [main]`:

- **`/.github/workflows/release.yml`** — the OIDC publish, and the single
  workflow every publishable package registers as its trusted publisher. A plan
  step enumerates `rush list --json` projects with `shouldPublish: true` and
  **classifies each against npm into three states**: *published* (skip),
  *new version of an existing package* (publish), or *never published* (skip +
  warn — its first publish needs a one-time token bootstrap, see below). It then
  loops `npm publish --provenance --access public` over the publish set (one
  OIDC exchange per package). A non-404 lookup error (network / 5xx / auth)
  fails the job loudly rather than being read as "not published". `id-token:
  write`, `setup-node` `registry-url`, `npm install -g npm@11.5.1`, no
  `NODE_AUTH_TOKEN`. No-ops (green) when nothing is ready to publish.
- **`/.github/workflows/version.yml`** — the rush-native replacement for
  `changeset version`. On merge to `main` it runs `rush publish --apply`
  (consumes `common/changes/*` into package.json + CHANGELOG bumps across all
  changed packages; no registry contact, no token) and opens a "version
  packages" PR rather than pushing to protected `main`.

So **Rush owns versioning, npm owns the OIDC upload**, and both halves are
monorepo-wide.

## Consequences

- **Required setup the npm account owner must do** (per package, cannot be done
  from the repo): for *each* package this pipeline should publish, register a
  trusted publisher on npmjs.com — owner `excitedjs`, repository
  `excitedjs/dreamux`, workflow **`release.yml`** (the same file for every
  package), environment blank. Adding a package later = a rush.json entry + one
  npm entry; no workflow change.
- **Any push/merge is always safe — a never-published package is skipped, not
  failed.** The plan step's three-state classification means a `shouldPublish`
  package that does not exist on npm yet (e.g. `@excitedjs/dreamux`,
  `shouldPublish: true`, v0.1.0, currently 404) is **skipped with a warning**,
  not pushed through a doomed `npm publish`. So merging this PR — and every
  later push — is green by default. The package is picked up automatically once
  it has been bootstrapped (see next bullet); no `shouldPublish: false` toggle
  is needed (and that toggle would be wrong anyway — it also drops the package
  from `version.yml`'s `rush publish --apply` bumping). Classification reads
  the registry only, so a misconfigured trusted publisher is **not** mistaken
  for "absent": such a package exists on npm, so it is queued and its
  `npm publish` fails loudly — which is the correct signal.
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
  recommended so `npm pack` == CI output); a `repository` field pointing at
  github.com/excitedjs/dreamux (npm provenance requires it); and no `workspace:`
  protocol deps (`npm publish` does not rewrite them, unlike `pnpm publish`).
- **Optional hardening:** run the publish in a protected GitHub Environment with
  required reviewers (commented in the workflow); if enabled it must match the
  npm trusted-publisher Environment field of every package.
- The version workflow self-breaks its trigger loop: the version PR's merge
  carries no new change files, so the next `rush publish --apply` is a no-op
  (verified locally with an empty `common/changes/`).

## Alternatives considered

- **`rush publish --publish` for the upload** — rejected: no provenance,
  token-only auth, incompatible with OIDC tokenless.
- **Per-package release workflows** — rejected: N near-identical files that
  drift, fighting Rush's coordinated monorepo model. One looping workflow scales
  by adding a rush.json entry + one npm config. Revisit only if a package needs
  different release governance (its own environment / reviewers).
- **Single-run version+publish that pushes the bump to `main`** (the claudemux
  shape) — rejected: needs a GitHub App token to push to protected `main`; the
  version-PR model needs no extra secret.
