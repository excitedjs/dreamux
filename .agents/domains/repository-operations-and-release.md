# Repository Operations And Release

How code enters this repository, which gates it must clear, and how it reaches
npm as an `alpha`, `beta`, or stable `latest` package. Read this before
changing Rush config, package manifests, the public CLI bin surface, CI or
release workflows, anti-leak guardrails, lint gates, or changelog behavior.

## Ownership

- **GitHub Actions owns every release action.** Version writes, changelog
  rewrites, and registry uploads all happen inside
  [/.github/workflows/](/.github/workflows/). There is no manual version-write,
  tag-push, or `npm publish` step.
- **Rush owns package versions and generated changelogs**, consuming the change
  files under `/common/changes/<package>/`. A human writes change files; a human
  never edits a generated `CHANGELOG.md` / `CHANGELOG.json`.
- **The `release-pipeline` deploy key is the only identity that writes `main` or
  `next` directly.** Its private half is the Actions secret
  `RELEASE_DEPLOY_KEY`; `GITHUB_TOKEN` stays `contents: read` in both pushing
  workflows.
- **`@excitedjs/eslint-config` owns the source gates** — the synchronous
  blocking-IO ban and the 700-line file cap — for every package.
- **`/.gitleaks.toml` and `/.npmrc` are shared canonical guardrails** with the
  sibling repo, not per-repo tunables.
- **`/packages/dreamux/package.json` owns the published surface**: the single
  `dreamux` bin and the `files` allowlist.
- **npm trusted publishing owns publish authentication.** Each publishable
  package carries an npm trusted-publisher entry (provider GitHub Actions, owner
  `excitedjs`, repository `excitedjs/dreamux`, workflow `release.yml`). No
  long-lived npm token exists.
- **The TeamLeader-only [development workflow](../skills/dev-workflow/SKILL.md)
  owns how a non-trivial feature, refactor, or bug fix is driven** from task
  discovery through review, merge, and knowledge closeout.

Source: `/.github/workflows/`, `/rush.json`, `/common/changes/`,
`/packages/eslint-config/`, `/.gitleaks.toml`, `/.npmrc`,
`/packages/dreamux/package.json`.

## Contracts

### Branch Topology

Two long-lived branches, one strict topology:

```
main  ──► always a strict prefix of next
        (main is always an ancestor of next in the git DAG)

next  ──► default PR base, accumulates PR merges, beta channel head
```

`main` advances **only** by fast-forward from `next`. No merge commit, no
squash, no rebase, and no direct push of feature/hotfix commits. The single
allowed deviation is the generated `chore(release): version packages [skip ci]`
commit produced by the release pipeline itself, which immediately re-syncs
`next` onto the freshly bumped `main` so the invariant is restored before any
new PR can land.

| Branch | Purpose | Lifetime | Protected |
|---|---|---|---|
| `main` | Stable npm `latest` head; one commit per release plus `[skip ci]` version bumps | permanent | ruleset PR gate; only the release deploy key pushes directly |
| `next` | Default PR base; beta channel head | permanent | squash-merge only via PR (1 approval); release deploy key may fast-forward on release |
| `feature/<slug>` | In-progress work for one PR | branch-off to PR merge; squash merge deletes it | no |
| `team/<slug>` | TeamMate team integration branches; merged via PR | same as feature | no |

PRs target `next`, never `main`; the GitHub repo default branch is `next`.
Hotfixes land on `next` first and ship through the normal promote path.

Two layers guard `main` and `next`:

- **Classic branch protection** on each branch blocks force pushes and deletions
  and applies to administrators (`enforce_admins`). It carries no pull-request
  rule.
- **Repository ruleset `release-branch-pr-gate`** (targets `refs/heads/main` and
  `refs/heads/next`) requires a pull request with 1 approving review for every
  ordinary actor — including administrators and `github-actions[bot]` — and
  lists **deploy keys** as its only bypass actor.

The bypass exists because GitHub cannot exempt the Actions app from a
pull-request rule (neither classic protection nor rulesets accept it as a bypass
actor). The release pipeline therefore pushes over SSH with the repository's
read-write deploy key `release-pipeline`, pinning GitHub's SSH host keys from
the meta API instead of trusting first use. Both pushing workflows fail loudly
when `RELEASE_DEPLOY_KEY` is missing. Rotating the key means generating a new
keypair and replacing the deploy key and the secret — no workflow change.

Source: `/.github/workflows/promote-next.yml`, `/.github/workflows/release.yml`.

### Install And Build

The repo has one supported source install path: Rush + pnpm.

```bash
node common/scripts/install-run-rush.js update   # then build / lint / test
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js lint
node common/scripts/install-run-rush.js test
```

Per-package `npm install` is retired and unsupported: source manifests use the
pnpm `workspace:*` protocol, which `npm` cannot resolve, and no per-package
`package-lock.json` is committed. External consumers are unaffected — the
release pipeline publishes a pnpm-packed tarball in which pnpm rewrites
`workspace:*` to real registry versions before npm uploads it.

`test`, `typecheck`, `typecheck:tests`, `lint`, and `smoke-built-cli` are Rush
bulk commands that fan out to each package's own npm script. `lint` also ignores
dependency order, because ESLint is source-local and every package's violations
should surface in one run.

Source: `/rush.json`, `/common/config/rush/command-line.json`,
`/common/scripts/install-run-rush.js`, `/packages/dreamux/package.json`.

### Source Gates

Package source under `packages/*/src/**` must not use synchronous blocking IO.
The shared flat config enforces, for `src/**`:

- `max-lines` at 700 physical lines (blank lines and comments counted) — a hard
  error;
- `n/no-sync`, which matches any callee whose name ends in `Sync`;
- `no-restricted-imports` as backstop #1, banning `*Sync` named imports so a
  renamed import cannot slip past the call-site rule;
- `no-restricted-syntax` as backstop #2, banning the `const { readFileSync: read } = fs`
  destructure form;
- `eslint-comments/require-description` plus `reportUnusedDisableDirectives`, so
  every sync exemption carries a written reason and a stale disable is itself an
  error.

`tests/**` turns `n/no-sync` off — synchronous fixture IO does not run on the
server event loop — but keeps synchronous `child_process` banned, so new sync
subprocess usage in tests still needs a reasoned disable.

TypeScript is not a source gate for module-edge shape — see
[Assuming a green build proves more than it does](#assuming-a-green-build-proves-more-than-it-does).

`rush lint` is the authoritative bulk gate; the pre-commit hook lint-gates
staged package `src/` and `tests/` TypeScript against each package's own flat
config as a local pre-flight.

Source: `/packages/eslint-config/`, `/packages/dreamux/tests/no-sync-io-gate.test.ts`,
`/packages/dreamux/tsconfig.json`, `/common/git-hooks/pre-commit`.

### CI Gates

`ci.yml` runs on every pull request whatever its base branch, and on pushes to
`main`, `next`, and `feature/**`. The jobs:

| Job | Gate |
|---|---|
| `rush-change-status` | PRs only: `rush change --verify --target-branch origin/<base>`, plus the 0.x major-change-file scan |
| `commit-metadata` | Author email must have a domain and must not be machine-local; `*@users.noreply.github.com` always passes; an optional private denylist regex comes from a repo variable, never from a committed file |
| `shellcheck` | Linux + macOS, over `.agents/scripts/check.sh`, `common/git-hooks/pre-commit`, `common/scripts/check-internal-content.sh`, `common/scripts/install-gitleaks.sh`, `bin/dreamux`, `packages/dreamux/bin/dreamux` |
| `kb` | `.agents/scripts/check.sh` — knowledge-base link and orphan check |
| `rush` | Linux + macOS: update → build → built-CLI smoke → typecheck → typecheck:tests → lint → install codex → test |
| `gitleaks` | Full-history `gitleaks git .` with the pinned binary and `.gitleaks.toml` |
| `internal-content` | `common/scripts/check-internal-content.sh --tree` over every tracked file |

Order inside the `rush` job is load-bearing. Build precedes typecheck because a
package's `tsc --noEmit` resolves workspace dependencies through their emitted
`dist/*.d.ts`. `typecheck:tests` exists separately because `rush build` uses the
src-only tsconfig and `rush test` runs vitest through esbuild with no
typechecking, so a test-only type error surfaces nowhere else.

`smoke-built-cli` is an ESM initialization gate on the service graph, not just a
CLI liveness check: in one fresh Node process it imports the package main
`dist/server.js` (asserting the `Server` export), imports `dist/service/index.js`
and asserts its exports are exactly `DispatcherService`, `Dispatchers`,
`TeamService`, `WorkflowService` and all are values, and only then spawns
`bin/dreamux --version`. Both halves are load-bearing
([why](#assuming-a-green-build-proves-more-than-it-does)). The same command runs
before every publish, stable and prerelease alike.

Source: `/.github/workflows/ci.yml`, `/packages/dreamux/scripts/smoke-built-cli.mjs`,
`/packages/dreamux/bin/dreamux`, `/common/config/rush/command-line.json`.

### Rush Change Files

Every PR that touches publishable package surface — anything under
`packages/*/src/**` that is not a pure zero-behavior refactor, plus workflow
files that alter the release pipeline or the public npm bin surface — must carry
a Rush change file under `/common/changes/<package>/`. `type: none` leaves
package versions untouched but still produces a CHANGELOG entry;
`type: patch|minor` drives the actual version bump (`major` only for a package
already past 1.0.0 — see below).

Always validate before pushing:

```bash
node common/scripts/install-run-rush.js change --verify --target-branch origin/next --no-fetch
```

Pass `--target-branch` explicitly. `rush.json` declares no
`repository.defaultBranch`, so Rush falls back to its own built-in default
rather than this repo's PR base; CI passes `origin/<base_ref>`, which is
normally `origin/next`.

Rush can generate change files non-interactively when every changed package
shares one release type and message:

```bash
node common/scripts/install-run-rush.js change \
  --bulk \
  --message "Short release note" \
  --bump-type patch \
  --target-branch origin/next \
  --no-fetch \
  --overwrite
```

Use `--email "<git author>"` only when Rush cannot infer the author from git. Do
not paste real email addresses into chat or issue comments; some channels treat
them as sensitive data.

When changed packages need different release notes, write one JSON file per
package instead of forcing `--bulk`. The accepted schema is:

```json
{
  "changes": [
    {
      "comment": "Short release note",
      "type": "patch",
      "packageName": "@excitedjs/dreamux"
    }
  ],
  "packageName": "@excitedjs/dreamux",
  "email": "<git author>"
}
```

Then run the same `rush change --verify` command, so Rush stays the validator.

Source: `/common/changes/`, `/.github/workflows/ci.yml`, `/rush.json`.

### Changelog Responsibility

Dreamux 0.x handles incompatible config/state/cache/run/log/workspace shape,
version, or path changes by fail-loud plus explicit rebuild guidance rather than
automatic migration. Any change that can block or break a user's upgrade needs a
Rush change file.

Incompatible shape, version, or path notes lead with `BREAKING:` and include
`Rebuild:` with the exact manual action. A same-shape semantic change may retain
its state version only when the operator explicitly approves that tradeoff; its
note leads with `BREAKING:`, immediately includes `Review:` with the required
operator check, explicitly says no rebuild is needed, and contains no `Rebuild:`
instruction. The V3 Feishu `allow_chats` trust change is the accepted example
(see [Feishu pairing and access](feishu-pairing-access.md)).

While a package stays on the 0.x version line its change files must never use
type `major`: Rush bumps a 0.x package straight to 1.0.0 on a pending major.
Record 0.x breaking changes as `minor` with the `BREAKING:` note leading.
Packages already past 1.0.0 — currently `@excitedjs/feishu-channel` — use real
semver majors. The operator decides when a package leaves 0.x. This is
CI-enforced because it already went wrong: the 2026-08-16 release run produced
an unwanted, never-published 1.0.0 version state for the core packages. The
`rush-change-status` job therefore scans the **entire** pending change set, not
the PR diff, and exempts only packages whose `package.json` version is already
past 1.0.0 — so a stray major left by an earlier PR still fails the gate.

`dreamux changelog` is the upgrade-time reading entry point: it prints the
installed package's shipped Rush-generated `CHANGELOG.md` (or `CHANGELOG.json`
with `--json`), never fetches over the network, and fails loud when the file is
absent — so both files must stay in the package `files` allowlist.

Release-specific transition detail belongs in Rush change notes, public docs,
loader errors, and the owning task record. It is not copied into the
Dispatcher-only `dreamux-maintenance` skill, whose root and ordinary references
are current-state-only and whose sole transition exception is the generic,
explicit-intent managed-daemon self-upgrade SOP
(`/packages/dreamux/skills/dispatcher/dreamux-maintenance/`).

Source: `/common/changes/`, `/packages/dreamux/CHANGELOG.md`,
`/packages/dreamux/src/cli/changelog.ts`, `/.github/workflows/ci.yml`.

### Published Package Surface

The public operator package is `@excitedjs/dreamux`. It exposes exactly one
public bin:

```json
{ "dreamux": "./bin/dreamux" }
```

The `files` allowlist ships `bin`, `dist`, `skills`, `README.md`, `LICENSE`,
`CHANGELOG.md`, and `CHANGELOG.json`. The single MCP shim is reached through
Dreamux-managed MCP descriptors and the internal `dreamux mcp` subcommand; it is
not a separate public npm bin. `/bin/dreamux` at the repo root is a
source-checkout convenience shim only and is not published.

Test doubles are not package surface. `createFakeFeishuBot` / `FakeFeishuBot`
were removed from published package API as a breaking cleanup; the double now
lives under `/packages/dreamux/tests/helpers/` and implements the production
`FeishuBot` seam, injected through `createFeishuChannelProvider({ botFactory })`
so the real channel, gate, routing, and MCP tool code still runs unmodified.
A new test double belongs in `tests/` and must implement a production seam, not
be exported from a package.

Source: `/packages/dreamux/package.json`, `/packages/dreamux/bin/dreamux`,
`/bin/dreamux`, `/packages/dreamux/src/cli/commands/mcp.ts`,
`/packages/dreamux/tests/helpers/fake-feishu-bot.ts`.

### Public-Repo Red Line

This is a public repository. Do not commit internal identifiers, secrets,
private registry URLs, internal hostnames, real Feishu ids, or tokens.

- `/.gitleaks.toml` extends the gitleaks default ruleset with Feishu
  `open_id` / `chat_id` / app-id / credential formats. It contains only generic
  public formats, so the config itself leaks nothing.
- `/.npmrc` pins the public npm registry, keeping a private mirror URL out of
  the lockfile.
- `common/git-hooks/pre-commit` runs `gitleaks git --staged` and
  `common/scripts/check-internal-content.sh --staged`. The gate is **mandatory**:
  a missing gitleaks binary fails the commit rather than warning and passing,
  and `--no-verify` is not an accepted way past it. Install with
  `common/scripts/install-gitleaks.sh` — a pinned, checksum-verifying script
  that installs into `~/.local/bin` by default (`GITLEAKS_INSTALL_DIR` overrides
  it). The hook looks in `$GITLEAKS_INSTALL_DIR` and `~/.local/bin` as well as
  `PATH`, because that default directory is not on every shell's `PATH`.
- The `gitleaks` CI job scans the full history with the same pinned binary, so a
  secret added and later "fixed" is still caught. The pin lives only in
  `install-gitleaks.sh`; CI and the release workflow both install through it.
- **Internal paths are a separate gate from secrets.** `.gitleaks.toml` is
  shared verbatim with the internal sibling repository, which legitimately
  contains the internal mount and developer home paths this repository must not
  publish — so those patterns cannot live there.
  `common/scripts/check-internal-content.sh` owns them instead, and runs in the
  hook (`--staged`) and in the `internal-content` CI job (`--tree`, every
  tracked file). Its allowlist is by reviewed placeholder user name and by
  named pattern-definition file, never by directory: the leak that motivated
  the tree scan was in `tests/`, which a directory exclusion would have missed.
- The prerelease job additionally audits every packed tarball before upload —
  `package/package.json` must be present, and a regex scan over every packed
  file rejects Feishu identifier formats, the internal `/data00/` mount, and any
  absolute `/home/<user>/` path except the reviewed public `/home/volta/` and
  `/home/linuxbrew/` examples compiled into `dist`. The tarball audit and the
  tree scan must extract the same pattern; `internal-content-scan.test.ts`
  asserts they do, because two gates only cover for each other while they look
  for the same thing.
- The release `version` job commits the version bump **through this hook**, with
  no `--no-verify`, so it installs gitleaks first. Release automation is not
  exempt from the red line. It is also the only workflow job that commits at
  all — `grep -n "git commit" .github/workflows/*.yml` returns exactly that one
  site — so it is the only one that needs the binary.

**Running the full-history scan locally is red in a clone that has the internal
sibling repository as a remote.** `gitleaks git .` walks every reachable commit,
including `remotes/flowx/*`, whose history legitimately contains Feishu ids. A
finding there is not a finding in this repository — check
`git merge-base --is-ancestor <sha> origin/next` before treating it as one. The
CI job clones only `origin`, so it never sees them.

If a guardrail false-positives, stop and ask. Do not edit a local allowlist,
path exclusion, or bypass flag in only this repo.

Source: `/.gitleaks.toml`, `/.npmrc`, `/common/git-hooks/pre-commit`,
`/common/scripts/install-gitleaks.sh`,
`/common/scripts/check-internal-content.sh`,
`/.github/workflows/ci.yml`, `/.github/workflows/release.yml`,
`/packages/dreamux/tests/release-workflow-manifest-audit.test.ts`,
`/packages/dreamux/tests/internal-content-scan.test.ts`.

### The Four-Step Release Path

Every stable release goes through exactly four operator-visible stages, in
order; the fifth stage is the automated consequence of the fourth.

**1. Change request: PR to `next`.** Base = `next`. The full CI gate set above
must pass. Merge method is **squash and merge**, so one PR becomes one atomic
commit on `next` carrying a descriptive subject and the PR number.

**2. Alpha prerelease (manual, feature branches).** Alpha publishes an ephemeral
prerelease from any non-`main`, non-`next` branch so a reviewer can install a
concrete tarball instead of building locally.

- Operator action: `Actions → release.yml → Run workflow` → pick the branch.
  The trigger is `workflow_dispatch` only; pushes to feature branches never
  publish.
- The `prerelease` job tags `alpha.g<12-char-short-sha>`, so every commit
  produces a distinct alpha and ordering is commit-based. Alpha never touches
  `latest` or `beta`.

**3. Beta prerelease (automatic, on push to `next`).** Every squash merge into
`next` triggers a beta publish from the freshly merged head — no operator click.
Beta is the long-soak channel; operators test beta installs before promoting.

- The job tags `beta.<github.run_number>`. Install with
  `npm i -g @excitedjs/dreamux@beta`.
- Both prerelease channels are ephemeral in the same way: the version is applied
  in the working tree with `--partial-prerelease`, and the job commits nothing,
  pushes no tag, and **does not delete pending Rush change files**, so the
  eventual stable release still consumes them.
- Both pack and audit every tarball before upload. A prerelease that would leak
  internal content aborts before the registry sees it.

**4. Promotion (stable).** When a beta has soaked long enough the operator
performs exactly one click: `Actions → promote-next → Run workflow → Run` (no
inputs). A concurrency lock (`group: promote-next`, `cancel-in-progress: false`)
serializes promotions so two operators cannot race. The job:

1. **Full-depth checkout on `main`** — the ancestor check needs the whole graph.
2. **Ref presence check** — both `origin/main` and `origin/next` must exist.
3. **Topology guard** — `git merge-base --is-ancestor <main_sha> <next_sha>`. On
   failure it dumps the merge-base plus the commits on each side, and aborts:
   the operator fixes the topology rather than having the workflow paper over a
   violation with a merge commit.
4. **Fast-forward-only merge** — `git merge --ff-only origin/next`. Any other
   shape would rewrite the exact commit SHA the beta was published from,
   severing the link between a `beta.<run_number>` tarball and the commit that
   ships as stable. It emits `before` / `after` / `noop`; `noop=true` (main
   already equals next) skips the remaining steps.
5. **Push `main` with the release deploy key** — the ruleset's bypass actor. A
   deploy-key push is an ordinary push, so `on.push.main` in `release.yml` fires
   by itself and no dispatch step exists.

**5. Stable version and publish (triggered by that push).** Two jobs run in
sequence; the `prerelease` job is gated off for `main`.

- **Version job.** Runs only for `refs/heads/main`. On a push it first checks
  for pending change files and short-circuits when there are none. It consumes
  `/common/changes/**/*.json` via `rush publish --apply`, which bumps versions
  and rewrites per-package CHANGELOGs, then commits
  `chore(release): version packages [skip ci]` and pushes it with the deploy
  key. The `[skip ci]` footer is load-bearing: deploy-key pushes *are* visible
  to `on.push`, and that footer is what stops the bump from retriggering
  `release.yml`.
- **Topology repair, in the same job.** Immediately after the bump push it
  fetches `next` and, only if `next` still points at the exact pre-bump SHA
  (`HEAD^`), fast-forward pushes `refs/heads/main:refs/heads/next`. If `next`
  already moved, it logs a one-line skip. Either way the ancestor invariant
  holds for the next promote run with no manual intervention.
- **Publish job.** Gated on `should_publish`. It installs, builds, runs
  `smoke-built-cli`, then `rush publish --include-all --publish
  --set-access-level public --registry https://registry.npmjs.org`. Rush calls
  pnpm publish, pnpm rewrites `workspace:` deps to registry versions, and npm
  uploads. `NPM_CONFIG_PROVENANCE=true` plus `id-token: write` make the final
  `npm publish` exchange the OIDC id-token for a short-lived token and attest
  provenance. Afterwards `npm view @excitedjs/dreamux dist-tags.latest` reflects
  the new version; `beta` and `alpha` are untouched.

Note the asymmetry: the packed-tarball manifest and leak audit lives in the
**prerelease** job only. The stable publish job builds, smokes, and uploads
without repacking; on the normal path that commit already cleared the audit as a
beta from `next`.

Source: `/.github/workflows/release.yml`, `/.github/workflows/promote-next.yml`,
`/.github/workflows/ci.yml`.

## Invariants

- **`main` is always an ancestor of `next`.** The topology guard aborts
  promotion rather than repairing it silently, and the version job re-syncs
  `next` after every bump.
- **A stable release ships the exact commit its beta was published from.**
  Promotion is fast-forward-only; nothing in the pipeline rewrites that SHA.
- **`[skip ci]` on the version-bump commit is load-bearing.** Removing it makes
  `release.yml` retrigger itself on its own bump push.
- **Prereleases mutate nothing durable.** No commit, no tag, no consumed change
  file — a later stable release still sees every pending change file.
- **All publishing goes through Rush/pnpm.** Raw `npm publish` from a package
  directory would upload unrewritten `workspace:*` dependencies.
- **No long-lived npm credential exists.** Publishing is OIDC trusted publishing
  with `id-token: write`; there is no `NPM_TOKEN` / `NODE_AUTH_TOKEN` anywhere.
- **`GITHUB_TOKEN` never pushes.** Both pushing workflows keep it
  `contents: read` and authenticate with the release deploy key.
- **A 0.x package never carries a `type: major` change file.**
- **No synchronous blocking IO in `packages/*/src/**`, and no source file over
  700 physical lines.**
- **Nothing internal is committed or published.** Full-history gitleaks in CI
  and the prerelease tarball audit are both non-bypassable.

## Regression Traps

### Pushing release refs with `GITHUB_TOKEN`

**Trigger:** simplifying the deploy-key setup away, or letting
`actions/checkout`'s default credentials perform the promote push.

**What happened:** the promote push originally used `GITHUB_TOKEN`. GitHub's
anti-infinite-loop guard makes a `GITHUB_TOKEN`-originated push invisible to
other workflows, so `on.push.main` in `release.yml` silently never fired and
every release needed a manual `gh workflow run` nudge. The `release-branch-pr-gate`
ruleset now also rejects that identity outright, since deploy keys are its only
bypass actor.

**Rejected direction:** any push identity other than the `release-pipeline`
deploy key. Manual dispatch of `release.yml` against `main` remains the
*retry* hook, not the normal path.

Source: `/.github/workflows/promote-next.yml`, `/.github/workflows/release.yml`.

### A tarball audit that scans nothing, or fails on pipe timing

**Trigger:** touching the prerelease pack-and-audit step.

**What goes wrong, in two independent ways:** `rush publish --pack` alone is a no-op under Rush's
default read-only mode — it prints `DRYRUN: pnpm pack` and writes no tarball, so
the audit loop had nothing to scan and passed vacuously. Real tarballs require
`--include-all --publish --pack` into a release folder. Separately, an existence
check written as `tar tzf "$tgz" | grep -q ...` false-failed as "missing
package.json": under `set -o pipefail`, `grep -q` exits on first match, the
upstream `tar` takes SIGPIPE and exits 141, and pipefail propagates it.

**Rejected direction:** trusting a gate that produces no artifacts (zero
tarballs now fails hard: "a manifest gate that scans nothing is not a gate"),
and piping `tar` into a short-circuiting consumer (use a here-string, which has
no upstream process to signal). Extend the `/home/<user>/` allow-list only with
reviewed, provably-public example paths;
`/packages/dreamux/tests/release-workflow-manifest-audit.test.ts` locks the exact
two-stage filter against the real workflow text.

Source: `/.github/workflows/release.yml`,
`/packages/dreamux/tests/release-workflow-manifest-audit.test.ts`.

### Assuming a green build proves more than it does

**Trigger:** moving declarations between modules, or adding an import edge
across `src/service/`, and concluding from a passing `rush build` that the edge
is safe.

**What it does not prove:**

- **Type-only edges.** With `verbatimModuleSyntax: false` and no
  `consistent-type-imports` rule, a value import written where `import type` was
  intended compiles cleanly and still creates a runtime module edge. Only a
  syntax-aware source check proves the edge is erased.
- **ESM initialization cycles.** `bin/dreamux --version` execs
  `dist/cli/dreamux.js` and never loads the package main or the service graph,
  so a CLI-only smoke would not see a cycle among service modules. That is
  precisely why `smoke-built-cli` imports `dist/server.js` and
  `dist/service/index.js` in the same fresh Node process before running the
  bin.

**Rejected direction:** reaching for a repo-wide `consistent-type-imports` rule
to cover the general case — that enforces across every package to protect one
edge. The honest alternative is a targeted, syntax-aware check on the edge
actually being moved.

Source: `/packages/dreamux/tsconfig.json`,
`/packages/dreamux/scripts/smoke-built-cli.mjs`,
`/common/config/rush/command-line.json`.

## Failure Modes And Recovery

| Failure | Where caught | Recovery |
|---|---|---|
| Topology violation: main is not an ancestor of next | promote-next topology guard | Read the divergence dump. (a) If main shows only `chore(release)` commits from a prior release, re-anchor next: cherry-pick the `[skip ci]` bump onto next or force-align next to main at the release SHA, then re-run promote. (b) If main shows a non-release commit, that is a process bug — remove/revert it from main and land the change through the normal PR→next path instead. |
| Promote push of main did not trigger release.yml | Actions tab: no new release run on main after promote | Check whether the promoted HEAD commit message contains `[skip ci]` (workflows are skipped for it). Recovery either way: `Actions → release.yml → Run workflow → main` — manual dispatch is the designed retry hook. |
| Pipeline push rejected (GH013 rule violation) or deploy-key auth failed | promote-next push step / release.yml version job logs | Verify the `release-branch-pr-gate` ruleset still lists deploy keys as bypass actors, the `release-pipeline` deploy key still exists with write access, and the `RELEASE_DEPLOY_KEY` secret matches it. Setup steps already fail loudly when the secret is absent. |
| Version job produced the bump commit, but publish failed mid-upload | release.yml publish job logs | Re-run against the same commit via `Actions → release.yml → Run workflow → main`. The version job sees no diff in `packages/` or `common/changes/` and short-circuits with `should_publish=true` on `workflow_dispatch`, so only the publish job re-runs. Do not push a new commit just to re-trigger CI. |
| Version bump was pushed but the next-sync step failed | release.yml version job | Verify the deploy-key bypass (previous row) is intact for `next`. If `next` moved between the bump and the sync, the step logs "Skipping next sync" intentionally; the next PR merged into next lands on top of the pre-release state, and promote-next still fast-forwards because that branch is a descendant of main. |
| Author email fails the commit-metadata gate | PR CI, or the pre-commit hook locally | Fix with `git config user.email <your-github-email>`. Privacy addresses (`*@users.noreply.github.com`) are explicitly allowed. The local hook mirrors the CI check; run `rush update` to ensure it is wired. |
| `rush change --verify` fails on a workflow-only PR | PR CI `rush-change-status` | Generate a `type: none` change file for the package whose workflow or surface is being altered. Workflow-only changes still need a paper trail in the CHANGELOG. |

History: [/.agents/tasks/architecture/README.md](/.agents/tasks/architecture/README.md)
