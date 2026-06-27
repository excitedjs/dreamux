# Reference: development and release process

This document is the operator-facing SOP for how code enters this repo,
moves through the prerelease channels, and ships as a stable npm
`latest` package. Everything here is implemented by GitHub Actions
workflows under [/.github/workflows/](/.github/workflows/); there are no
manual version-write, tag-push, or registry-upload steps.

## Core invariant

Two long-lived branches, one strict topology:

```
main  ──► always a strict prefix of next
        (main is always an ancestor of next in the git DAG)

next  ──► default PR base, accumulates PR merges, beta channel head
```

`main` advances **only** by fast-forward from `next`. No merge commit,
no squash, no rebase, and no direct push of feature/hotfix commits is
allowed. The single allowed deviation is a generated
`chore(release): version packages [skip ci]` commit produced by the
release pipeline itself; the release pipeline immediately re-syncs
`next` onto the freshly bumped `main` so the invariant is restored
before any new PR can land.

This invariant is enforced by a hard topology guard inside the
promote-next workflow. If it breaks, promotion aborts with a structured
debug dump; see [Promotion step](#4-promotion-stable) below.

## Branch lifetime

| Branch | Purpose | Lifetime | Protected |
|---|---|---|---|
| `main` | Stable npm `latest` head; one commit per release plus `[skip ci]` version bumps | permanent | push restricted to `github-actions[bot]` only |
| `next` | Default PR base; beta channel head | permanent | squash-merge only via PR; bot allowed to fast-forward on release |
| `feature/<slug>` | In-progress work for one PR | lives from branch-off to PR merge; PR squash merge deletes it | no |
| `team/<slug>` | Reserved for TeamMate team integration branches; merged via PR | same as feature | no |

PRs target `next`, never `main`. The GitHub repo default branch is
`next`. Hotfixes, like every other change, land on `next` first and
ship through the normal promote path.

## The four-step path

Every stable release goes through exactly four stages, in order.

### 1. Change request: PR to `next`

- Open PR base = `next`.
- CI runs the full gate set described in
  [`.github/workflows/ci.yml`](/.github/workflows/ci.yml):
  rush change declaration, author-email identity, shellcheck (Linux +
  macOS), knowledge base link/orphan check, Rush bootstrap + build +
  typecheck + lint + test (Linux + macOS), and full-history gitleaks.
  All must pass.
- Merge method for PRs into `next`: **squash and merge**. (Configured
  in GitHub repo settings; the `gh pr merge --squash` CLI invocation
  matches.) The resulting squash commit on `next` is one atomic change
  and always carries a descriptive commit subject + PR number in the
  message tail.
- Every PR that touches publishable package surfaces (anything under
  `/packages/*/src/**` that is not a pure refactor with zero behavior
  change, plus workflow files that alter the release pipeline or the
  public npm bin surface) **must** carry a Rush change file under
  `/common/changes/<package>/`. Use
  `node common/scripts/install-run-rush.js change` to generate one.
  Process-workflow-only changes (`type: none`) leave package versions
  untouched but still produce CHANGELOG entries; release surface
  changes use `type: patch|minor|major` as appropriate and drive the
  actual version bump.
- `rush change --verify` is a CI gate; merge is blocked without one
  when the diff touches a package.

Source reference: the CI gates in
[`.github/workflows/ci.yml`](/.github/workflows/ci.yml) (jobs
`rush-change-status`, `commit-metadata`, `shellcheck`, `rush`, `kb`,
`gitleaks`).

### 2. Alpha prerelease (manual, feature branches)

Alpha publishes an ephemeral prerelease from any non-main, non-next
feature branch to let a reviewer install a concrete tarball from
registry instead of building locally.

- Operator action: `Actions → release.yml → Run workflow` → select the
  feature branch in the dropdown. The trigger is manual
  `workflow_dispatch` only; pushes to feature branches never publish
  automatically.
- The `prerelease` job tags with
  `alpha.g<12-char-short-sha>` — every commit produces a distinct
  alpha, and ordering is commit-based. Alpha never touches `latest` or
  `beta`.
- Prerelease publishes never write commits, never push tags, and never
  delete Rush change files; the eventual stable release still sees
  them. Versions are applied ephemerally in the working tree
  (`--partial-prerelease`) before `rush publish --include-all`.

Source reference: `prerelease` job in
[`.github/workflows/release.yml`](/.github/workflows/release.yml),
`if: startsWith(github.ref, 'refs/heads/') && github.ref != 'refs/heads/main' && (github.event_name == 'workflow_dispatch' || github.ref == 'refs/heads/next')`.

### 3. Beta prerelease (automatic, on push to `next`)

Every squash merge into `next` automatically triggers a beta publish
from the freshly merged head. Beta is the "long soak" prerelease
channel; operators test beta installs before deciding to promote to
stable.

- Trigger: `on.push.branches: [next]` in release.yml — fully automatic,
  no operator click.
- The `prerelease` job tags with `beta.<github.run_number>` (integer
  sequence per merge). Install with
  `npm i -g @excitedjs/dreamux@beta`.
- Same ephemeral rules as alpha: no commits pushed, no change files
  consumed, no tag rewritten.
- Each beta carries the Rush-managed manifest audit (tarball
  `package/package.json` present + forbidden internal-content regex
  scan over every packed file). A beta that leaks content aborts
  before upload, which means the leak never reaches the registry.

Source reference: same prerelease job as step 2; branch policy
`github.ref == 'refs/heads/next'` inside the `if` selects the beta
naming scheme.

### 4. Promotion (stable)

When a beta has soaked for long enough, the operator performs exactly
one click:

> `Actions → promote-next → Run workflow → Run` (no inputs)

This drives the ENTIRE remaining stable-release chain end-to-end.
Everything below is automated.

Workflow file:
[`.github/workflows/promote-next.yml`](/.github/workflows/promote-next.yml)
(manual `workflow_dispatch` only — no PR button, no schedule, no
auto-trigger). A concurrency lock (`group: promote-next`,
`cancel-in-progress: false`) serializes promotions so two operators
cannot race.

Pipeline steps:

1. **Full-depth checkout on `main`.**
   A full graph is required for the ancestor check below.

2. **Ref presence check.**
   Verifies both `origin/main` and `origin/next` remote refs exist;
   fails loudly otherwise (defense against a shallow checkout or a
   misconfigured branch rename).

3. **Topology guard — hard fail on non-linear shape.**
   Runs `git merge-base --is-ancestor <main_sha> <next_sha>`. If this
   fails, the step dumps: the merge-base (divergence point), the list
   of commits present on main but not next, and the list present on
   next but not main. The operator uses that output to decide whether
   a hotfix on main needs to be reconciled, whether `next` needs to
   be re-anchored, or (normal path) whether a prior release sync step
   was somehow skipped.

   The ONLY allowed commit on main without going through next is the
   release pipeline's own
   `chore(release): version packages [skip ci]`. Any other main commit
   is a process violation and the topology guard deliberately makes
   the operator fix the topology before proceeding, instead of
   silently producing a merge commit on main.

4. **Fast-forward only merge.**
   `git checkout main && git merge --ff-only origin/next`.
   `--ff-only` is the contract — producing a merge commit, a squash,
   or a rebase here would rewrite the exact commit SHA that beta was
   published from, severing the link between a beta.<run_number>
   tarball and the commit that ships as stable. Any shape that is not
   a strict fast-forward exits non-zero and aborts.

   Emits outputs `before`, `after`, and `noop`. `noop=true` means
   main already equals next (nothing to promote); the remaining steps
   below all skip on `noop`.

5. **Push `main` to origin.**
   Uses the workflow `GITHUB_TOKEN` (not a PAT) as the
   `github-actions[bot]` identity. Main branch protection must allow
   this identity.

   *Known GitHub behavior:* A `git push` performed with the default
   workflow `GITHUB_TOKEN` does **not** re-trigger `on.push.main` in
   release.yml. This is GitHub's documented anti-infinite-loop guard.
   The next step therefore nudges release.yml explicitly.

6. **Dispatch release.yml on the freshly pushed main.**
   `gh workflow run release.yml --ref main`, using the same
   `GITHUB_TOKEN` (this is why promote-next declares
   `permissions.actions: write`). Prints the newest release run URL
   back into the promote-next log so the operator can follow along.

Source reference: promote-next.yml header comments document this
six-step shape and the known coupling to release.yml.

### 5. Stable version + publish (chained off promote-next step 6)

The dispatch from promote-next lands on release.yml targeting `main`.
Two jobs run in sequence; the `prerelease` job for stable branches is
intentionally skipped.

#### 5a. Version job

- Runs only when `github.ref == 'refs/heads/main'`.
- Consumes `/common/changes/**/*.json` via `rush publish --apply`,
  which bumps package versions and rewrites CHANGELOGs per package.
  If no change files are present, `should_publish=false` and both the
  version bump and the subsequent publish step short-circuit.
- Produces one commit on main:
  `chore(release): version packages [skip ci]`. The `[skip ci]` footer
  prevents the push from re-triggering release.yml if someone later
  adds a push-based trigger to main again.
- **Critical invariant repair step — `sync next onto the freshly bumped main`.**
  Immediately after pushing the version commit to main, the version
  job fetches `next`, compares its SHA to `HEAD^` (the pre-bump main
  SHA), and — if `next` has not moved between the promote push and
  here — fast-forward pushes
  `refs/heads/main:refs/heads/next`, bringing `next` to the same SHA
  as the freshly bumped `main`. If `next` has already moved (a new
  PR landed during the release window), the sync step skips with a
  one-line log. This step guarantees that after every successful
  release, `main == next` **or** `next` is a strict child of the
  version bump, so the ancestor invariant for the NEXT promote-next
  run remains true with no manual intervention.

Source reference: `version` job in
[`.github/workflows/release.yml`](/.github/workflows/release.yml),
steps "Push version bump" and
"sync next onto the freshly bumped main (topology invariant)".

#### 5b. Publish job

- Depends on `version`, gated by
  `needs.version.outputs.should_publish == 'true'`.
- Runs the full Rush build + smoke CLI path before upload.
- Publishes changed packages to npm using Rush native
  (`rush publish --include-all --publish`). Rush calls pnpm publish;
  pnpm rewrites `workspace:` deps to registry versions in the
  manifest; npm performs the upload.
- npm trusted publishing is OIDC-based, no long-lived NPM_TOKEN
  exists anywhere. Required permissions are `id-token: write`.
  `NPM_CONFIG_PROVENANCE=true` is set on the publish step so the
  final `npm publish` call exchanges the OIDC id-token for a
  short-lived npm token and attests provenance.
- After publish, `npm view @excitedjs/dreamux dist-tags.latest`
  reflects the new version. `beta` and `alpha` are untouched.

Source reference: `publish` job in
[`.github/workflows/release.yml`](/.github/workflows/release.yml).
Related decision:
[`npm-release-oidc` decision](../decisions/npm-release-oidc.md).

## Failure modes and recovery

| Failure | Where caught | Recovery |
|---|---|---|
| Topology violation: main is not an ancestor of next | promote-next step 3 | Read the divergence-dump section of the log. (a) If main shows only `chore(release)` commits from a prior release, re-anchor next: cherry-pick the `[skip ci]` bump onto next or force-align next to main at the release SHA, then re-run promote. (b) If main shows a non-release commit, that is a process bug — remove/revert it from main and land the change through the normal PR→next path instead. |
| GITHUB_TOKEN push of main did not trigger release.yml | promote-next logs; absence of a new release run URL | Built-in to promote-next V2: the dispatch step (step 6) is the explicit workaround. If this ever appears to regress, re-check that `permissions.actions: write` is still declared and that `gh` still ships on `ubuntu-latest`. |
| version job produced the bump commit, but publish failed mid-upload | release.yml publish job logs | Re-run the workflow with the same commit via `Actions → release.yml → Run workflow → main`. The version job detects the bump commit has already been produced (change files consumed, no diff in `packages/` and `common/changes/`) and short-circuits with `should_publish=true` on `workflow_dispatch` so only the publish job re-runs. Do not push a new commit just to re-trigger CI. |
| Version bump was pushed but sync-next step failed | release.yml version step | Verify next branch protection allows the `github-actions[bot]` identity to push. If `next` moved between the bump and the sync, the step logs "Skipping next sync" intentionally; the next PR merged into next will land on top of the pre-release state from the prior beta, and promote-next will still fast-forward because the beta branch is a descendant of main. |
| Author email fails commit-metadata CI gate | PR CI, or pre-commit hook locally | Fix with `git config user.email <your-github-email>`. Privacy addresses (`*@users.noreply.github.com`) are explicitly allowed. Local pre-commit hook mirrors the CI check; run `rush update` (or `rush install`) to ensure the hook is wired. |
| Rush change verify fails on a workflow-only PR | PR CI `rush-change-status` job | Generate a `type: none` change file for the package whose workflow or surface is being altered. Workflow-only changes still need a paper trail in the CHANGELOG. |

## Related KB entries

- [Repository structure](repo-structure.md) — Rush change file location,
  package list, publishable package flags, bin layout.
- [Current architecture](current-architecture.md) — code-layer map;
  the release pipeline sits outside the runtime packages entirely.
- [`npm-release-oidc` decision](../decisions/npm-release-oidc.md) —
  rationale for OIDC trusted publishing + no long-lived NPM_TOKEN.
- [Anti-leak guardrail decision](../decisions/anti-leak-guardrail.md) —
  `.gitleaks.toml` and the tarball content audit that runs before
  every prerelease/stable upload.
