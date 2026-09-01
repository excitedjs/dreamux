# Backfilled decision records: repository guardrail records

> Backfilled 2026-09-01 from the dissolved `.agents/decisions/` tree on
> operator instruction: task records are the single derivation layer. Each
> section preserves one record verbatim (original heading, status, and date;
> headings demoted one level for nesting). Later reality is recorded only in
> dated "Since this was recorded" subsections; historical text is never edited.

## anti-leak-guardrail

## Anti-leak guardrail (gitleaks)

- **Status:** Accepted
- **Date:** 2026-05-30
- **Affects:** repo root (`/.gitleaks.toml`, `/.npmrc`), CI (`/.github/workflows/ci.yml`), git hooks (`/common/git-hooks/`)
- **PR / Issue:** chore/anti-leak-guardrail

### Context

`excitedjs/dreamux` is a **public** open-source repo, but it is developed
alongside company-internal tooling. Company-internal content — Feishu
identifiers (`ou_`/`oc_`/`cli_`), internal tokens/secrets, private-mirror
registry URLs, internal hostnames — must never reach a commit, because a
leaked commit is public and permanent (forks, mirrors, caches survive a
later deletion). A naïve `npm install` can also bake a non-public mirror
URL into the lockfile. The repo shares this concern, and a single canonical
config, with the sibling **claudemux** repo.

### Decision

Land a layered guardrail:

- **`/.gitleaks.toml`** — gitleaks `useDefault` ruleset (private keys,
  generic high-entropy secrets, cloud tokens) plus generic Feishu id /
  credential formats. No real values, so the config is itself safe to
  commit.
- **`/.npmrc`** — pins the public npm registry so `install` never resolves
  through (or records) a private mirror.
- **Pre-commit hook** (`/common/git-hooks/pre-commit`) — `gitleaks protect
  --staged` against the staged diff. If gitleaks isn't installed it
  warn-and-passes; CI is the real gate. Rush installs hooks from
  `common/git-hooks/` on `rush install`/`update` (the idiomatic monorepo
  home — no husky / root `package.json` needed).
- **CI gate** (`/.github/workflows/ci.yml`, job `gitleaks`) — `gitleaks
  detect` over the **full** git history (`fetch-depth: 0`, includes the
  committed lockfile) with `--exit-code 1`. The pinned gitleaks binary is
  downloaded directly rather than via `gitleaks-action` (which needs an org
  license key and hides the command); the invocation is kept identical to
  the hook's.

### Consequences

- **`.gitleaks.toml` and `.npmrc` are a shared canonical, kept
  byte-identical with the claudemux repo.** Do not edit them in only one
  repo. If gitleaks false-positives (e.g. on `package-lock.json` integrity
  hashes), **stop and ask** rather than adding a local allowlist or an
  `--no-git` / path-exclusion workaround — any change must be synced across
  both repos or the two configs drift. (Verified clean on gitleaks 8.30.1:
  the lockfile's sha512 integrity hashes do not trip the generic rule.)
- "Non-bypassable" depends on the repo owner enabling the `gitleaks` job as
  a **required status check** in branch protection; the workflow file alone
  does not enforce it.
- The hook auto-installs on the rush path (`rush install` / `rush update`).
  A contributor who hasn't run rush yet can opt in with
  `git config core.hooksPath common/git-hooks`. CI covers either way.
- The red line is also written into [`/CLAUDE.md`](/CLAUDE.md)
  ("Always-binding engineering rules") so every session loads it.

---

## npm-release-oidc

## npm release via OIDC trusted publishing

- **Status:** Accepted
- **Date:** 2026-05-30 (next beta channel added 2026-06-07; automatic next beta pushes added 2026-06-16)
- **Affects:** npm publishing of every `shouldPublish` package, `/.github/workflows/`, the rush version mechanism
- **PR / Issue:** infra/feishu-transport-release; next beta channel — issue #122

### Context

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
- **The release bot push should not need owner-only secrets by default.** Main
  currently enforces linear history but does not require a release-specific
  GitHub App bypass. The workflow therefore uses the built-in workflow token to
  push the generated version-bump commit. If branch protection later adds
  required checks or a PR-only gate that blocks `github-actions[bot]`, maintainers
  must either allow that bot to bypass the rule or reintroduce a dedicated
  release GitHub App.

### Decision

One workflow, `push: [main, next]` plus manual dispatch:

- **`/.github/workflows/release.yml`** — the single release pipeline and the
  workflow every publishable package registers as its trusted publisher. On a
  push to `main`, it first checks whether pending Rush change files exist under
  `/common/changes/`. If not, it no-ops, which prevents the bot's own release
  commit from looping. If yes, it installs through Rush and runs
  `rush publish --apply` to consume those change files into package.json and
  CHANGELOG bumps across all changed packages. It commits those version
  artifacts back to `main` with the workflow token, then a separate publish job
  checks out the updated branch, builds the monorepo, and runs
  `rush publish --include-all --publish --set-access-level public` against the
  public npm registry. Rush compares every publishable package against npm and
  invokes pnpm publish only for versions that are not already present.
  `id-token: write`, `npm install -g npm@11.5.1`,
  `NPM_CONFIG_PROVENANCE=true`, no `NODE_AUTH_TOKEN`. Manual dispatch against
  `main` is a stable retry hook; stable packages are never published from
  feature branches.

So **Rush owns versioning and publish orchestration, pnpm owns the registry
manifest rewrite, npm owns the OIDC/provenance upload**, and all halves are
monorepo-wide.

#### Prerelease channels: `next` beta and feature-branch alpha

A sanctioned prerelease channel publishes from `next` to the **`beta`**
dist-tag without ever moving `latest`, so changes already merged to `next` can
be install-verified in a real dispatcher environment ahead of a stable release.
Feature branches can also be manually dispatched to the **`alpha`** dist-tag for
operator-accepted pre-merge verification.
It reuses the same `release.yml` file — and therefore the **same per-package
npm trusted-publisher entry** (Workflow: `release.yml`) — rather than adding a
second workflow that would need its own npm registration and reintroduce a
default-branch dispatch dance:

- A prerelease job is gated to branch refs other than `main`, and it runs for
  either a `push` to `next` or a manual dispatch on any non-main branch. Pushes
  to `next` publish `beta`; dispatching `release.yml` against `next` also
  publishes `beta`; dispatching against any other non-main branch publishes
  `alpha`. The stable `version`/`publish` jobs are gated to `refs/heads/main`,
  so `main` keeps the stable path, feature branch pushes do not publish, and
  tags cannot satisfy the prerelease gate. The `release-${{ github.ref_name }}`
  concurrency group already namespaces branch runs.
- The dispatch works because `release.yml` already lives on the default branch
  (main) with `workflow_dispatch`, which is what makes the workflow
  dispatchable at all; `workflow_dispatch` then **executes the copy of the file
  from the selected ref**. The prerelease logic must therefore physically exist
  on whichever branch is selected (`next` for beta, a feature branch for alpha).
  No two-step rollout and no new `workflow_dispatch` inputs (inputs added only on
  a non-default branch would not render in the dispatch form, which is read from
  the default branch).
- The job is **ephemeral and writes nothing back to git**. It bumps an in-tree
  prerelease version with `rush publish --apply --partial-prerelease
  --prerelease-name <channel-id>`, builds, packs + audits the tarballs, then
  `rush publish --include-all --publish --tag <tag> --set-access-level public
  --registry https://registry.npmjs.org` with `NPM_CONFIG_PROVENANCE=true`. It is
  a single job because the uncommitted prerelease version must persist across
  apply → build → pack → publish.
- **Version uniqueness is structural.** For beta, `github.run_number` is
  monotonic per workflow, so every dispatch produces a distinct `beta.<n>`
  identifier and can never collide with an already-published prerelease. For
  alpha, the prerelease identifier is `alpha.g<short_sha>`: the `g` prefix keeps
  the semver identifier nonnumeric even when a short hash is all digits, while
  still tying the version to the source commit. A repeated/failed beta run is
  retried by dispatching again (new run number). A repeated alpha dispatch of
  the same commit republishes nothing; a new alpha needs a new commit.
- **The pending change files survive.** A stable `rush publish --apply` deletes
  the consumed change files (which is why the stable `version` job commits
  `common/changes`); prerelease apply (`--prerelease-name`) does **not** delete
  them. Combined with never committing, this guarantees the eventual stable
  release on main still consumes the same change files — beta cannot strip the
  stable release's input.
- **Manifest hygiene gate before upload.** The job packs **real** tarballs with
  `rush publish --include-all --publish --pack --release-folder …` and scans
  each one before the upload step runs. The `--publish` flag is load-bearing:
  `rush publish --pack` under Rush's default read-only mode only prints
  `DRYRUN: pnpm pack` and writes no tarball, so a pack step without `--publish`
  is a silent no-op gate. `--pack` still suppresses the registry upload (and,
  without `--apply-git-tags-on-pack`, applies no git tags), so this remains a
  no-I/O pre-check. Zero tarballs is treated as a hard failure (a gate that
  scans nothing is not a gate). Each tarball is scanned for the public-repo red
  line (internal Feishu identifiers, the internal `/data00` mount, an absolute
  `/home/<user>/` builder/developer path) plus a `package/package.json` sanity
  check. The known **public** examples `/home/volta/` (documented in
  `onboard/service.ts` and compiled into dist) and `/home/linuxbrew/` (the
  standard Linuxbrew prefix, presence-gated by `platform/paths.ts`) are
  allow-listed so they cannot false-fail the gate; any other extracted
  `/home/<user>/` token still fails. The audited tarball is representative of
  the upload because both come from the same deterministic `dist` and `files`
  allow-list.

### Consequences

- **Required setup the npm account owner must do** (per package, cannot be done
  from the repo): for *each* package this pipeline should publish, register a
  trusted publisher on npmjs.com — owner `excitedjs`, repository
  `excitedjs/dreamux`, workflow **`release.yml`** (the same file for every
  package), environment blank. Adding a package later = a rush.json entry + one
  npm entry; no workflow change.
- **The beta channel needs no extra npm owner setup — but the owner must
  confirm one fact.** Because the `beta` job reuses `release.yml`, the existing
  per-package trusted-publisher entry (Workflow: `release.yml`, environment
  blank) already authorizes it: npm's trusted publisher matches on
  repository + workflow filename and does not pin a git ref/branch by default,
  so a `release.yml` run dispatched against `next` is authorized exactly like a
  run on `main`. This "no new config" property is the deciding reason to reuse
  the file; it is owner-verifiable on each package's npmjs.com settings page and
  is the one external item to confirm before the first beta dispatch. If a
  package's entry were ever restricted to a specific environment or ref, the
  beta job would need a matching entry.
- **How to cut and verify prereleases.** For beta, push or merge to `next`; the
  `release` workflow automatically publishes `0.12.x-beta.<run_number>` to the
  `beta` tag. Manual dispatch of the same workflow selecting branch `next`
  remains a beta retry hook with a fresh run number. For alpha, dispatch the
  workflow selecting a feature branch; the job publishes
  `0.12.x-alpha.g<short_sha>` to the `alpha` tag. Install-verify with
  `npm install @excitedjs/dreamux@beta` or `npm install @excitedjs/dreamux@alpha`;
  inspect tags with `npm dist-tag ls @excitedjs/dreamux` and confirm `latest`
  is unchanged. A failed/duplicate beta run is handled by dispatching again
  (new run number). Alpha uniqueness comes from the source commit hash, so a
  repeat dispatch of the same commit republishes nothing and a new alpha needs a
  new commit.
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
- **Runtime workspace dependencies must be deliberate.** If a `shouldPublish:
  true` package depends on a sibling workspace package at runtime, that sibling
  must either already be part of the publish chain or stay out of the runtime
  dependency graph until it is truly consumed. Issue #97 exposed the failure
  mode: pnpm rewrote `@excitedjs/dreamux`'s ahead-of-use
  `@excitedjs/feishu-channel` dependency to a concrete version, while the
  sibling was not publishable, so external `npm install` failed with a missing
  registry dependency.
- **No release GitHub App secrets are required for the current branch
  protection.** The repository action setting must keep workflow tokens writable
  for contents, and `main` must keep allowing `github-actions[bot]` to push the
  generated version-bump commit. If a future protection rule blocks that push,
  this becomes an owner decision: grant the workflow bot a bypass or reintroduce
  a release GitHub App.
- **Optional hardening:** run the publish in a protected GitHub Environment with
  required reviewers (commented in the workflow); if enabled it must match the
  npm trusted-publisher Environment field of every package.
- The workflow self-breaks its trigger loop: push-triggered runs proceed only
  while pending Rush change files exist under `/common/changes/`. The bot
  version-bump commit consumes those files and includes `[skip ci]`, so it does
  not start a redundant CI/release run. Because the guard checks the current
  branch contents rather than only files added by the triggering push, a later
  workflow repair can automatically retry a release that previously failed after
  change files had already landed. Manual dispatch on `main` skips this
  change-file guard so maintainers can retry publishing already-versioned
  packages after a transient npm or OIDC failure.

### Alternatives considered

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
- **Dedicated release GitHub App for the version-bump commit** — deferred. It is
  necessary only when branch protection prevents the built-in workflow token from
  pushing the generated commit. The current repository settings do not require
  that extra owner-managed credential.

---

## no-sync-io-lint-gate

## No synchronous blocking IO in package source

- **Status:** Accepted
- **Date:** 2026-06-05 (source line-count cap added 2026-06-16)
- **Affects:** all `/packages/*/src/`, the new `@excitedjs/eslint-config`
  package, CI, the pre-commit hook
- **PR / Issue:** [#85](https://github.com/excitedjs/dreamux/issues/85)

### Context

dreamux is one long-running Node process hosting N dispatchers on a single
event loop. Any `fs.*Sync` / `child_process.*Sync` call in runtime or CLI code
blocks that loop: while one dispatcher reads a status file synchronously, every
other dispatcher's inbound, outbound, and Codex traffic stalls. The codebase
had accumulated synchronous IO across config, onboarding, channel state, the
admin socket, the Codex supervisor, and the daemon/CLI paths. We wanted both a
one-time cleanup and a permanent guard so new sync IO cannot regress in.

### Decision

Ban synchronous blocking IO in package source and enforce it with ESLint. Also
cap source files at 700 physical lines so oversized modules are split before
they become review and architecture bottlenecks.

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
- Source line count: `/packages/*/src/**/*.ts` is capped at 700 physical lines
  via ESLint `max-lines`. This deliberately does **not** apply to tests,
  generated `dist/`, `.agents/`, lockfiles, or other non-source files.
- `eslint-plugin-n` is pinned to exactly `17.18.0` — the last release before
  `n/no-sync` began requiring TypeScript type information (17.19.0+), which
  would force `parserOptions.project` and break the pure-syntactic config.

### Consequences

- **Enforcement:** `rush lint` (a Rush bulk command) runs `eslint .` per
  package; the CI `rush` job runs it after typecheck; the committed
  `common/git-hooks/pre-commit` lints staged package `src/**/*.ts` and
  `tests/**/*.ts` against each package's flat config. The local hook fails loud
  when a package-local `eslint` binary is missing, because Rush installs the
  hook only after `rush install` / `rush update` and those commands should also
  install package dependencies.
  The `lint` bulk command sets `ignoreDependencyOrder: true` so one package's
  lint failure does not block downstream packages from reporting their own
  source-local violations.
  `/packages/dreamux/tests/no-sync-io-gate.test.ts` is an executable contract
  for the rule behaviour (src sync IO errors, src line-count errors, tests
  exempt where intended, child_process still banned, reason-less disable
  rejected).
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

### Alternatives considered

- **Warning → error staged rollout.** Rejected: the codebase was zeroed in the
  same PR, so the rule ships as `error` immediately with no warning phase.
- **Per-package inline ESLint config.** Rejected in favour of one shared
  `@excitedjs/eslint-config` so the rule set has a single source of truth.
