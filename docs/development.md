# Development

[Documentation](README.md) / Development

Dreamux is a Rush + pnpm TypeScript monorepo. This page is for working on the
source; users installing the published package should start with
[getting started](getting-started.md).

## Build a checkout

Use Node.js 22.7 or newer. Clone the integration branch:

```bash
git clone --branch next https://github.com/excitedjs/dreamux.git
cd dreamux
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
```

The bootstrap script installs the Rush version pinned in `rush.json`, which also
pins pnpm. Source packages use `workspace:*` dependencies: do not run
per-package `npm install` or create per-package npm lockfiles.

Run the compiled CLI from the repository root:

```bash
./packages/dreamux/bin/dreamux --help
./packages/dreamux/bin/dreamux onboard
```

The launcher uses plain Node.js and built `dist/` output. There is no `tsx`
runtime dependency. Onboarding can register the checkout's launcher as a user
service, so keep that checkout available for as long as the service uses it.
For foreground work, use `onboard --no-register-service`, then
`./packages/dreamux/bin/dreamux serve`.

## Verify a change

Run repository checks from the root, in sequence:

```bash
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js lint
node common/scripts/install-run-rush.js test
node common/scripts/install-run-rush.js typecheck:tests
```

All four are required before calling a change green. Test-aware typechecking is
separate because the production build excludes test files and Vitest transpiles
without typechecking them.

The built CLI and source typechecks have dedicated commands as well:

```bash
node common/scripts/install-run-rush.js smoke-built-cli
node common/scripts/install-run-rush.js typecheck
```

Build first so workspace consumers can resolve dependency declarations. Tests
that exercise live Codex require an installed Codex binary and fail if it is
missing. Use `DREAMUX_SKIP_LIVE_CODEX=1` only in an environment intentionally
without Codex, and state that verification limit in the PR.

## Repository layout

```text
packages/
  dreamux/                 Host, CLI, orchestration, and bundled skills
  dreamux-types/           Neutral provider and plugin contracts
  dreamux-utils/           Shared runtime utilities
  agent-runtime/
    codex/                 Codex provider
    claude-code/           Claude Code provider
  channel/
    feishu-channel/        Feishu user-facing behavior
    feishu-transport/      Feishu platform I/O
  plugins/bootstrap/       Unpublished development plugin
  eslint-config/           Shared source-quality rules
docs/                      User and contributor guides
common/                    Rush configuration, hooks, and release change files
.agents/                   Maintainer knowledge and task records
```

See [architecture and extensions](architecture.md) before adding a provider or
crossing a package boundary.

## Contribution expectations

Read [CLAUDE.md](../CLAUDE.md), also exposed as `AGENTS.md`, before editing.
Repository documentation, comments, commits, and PR descriptions are written in
English.

The project's central design rule is to reduce the concepts a maintainer needs
to understand. Put behavior in the layer that owns it; keep runtime and channel
specifics behind their neutral provider contracts. A refactor must preserve
user-visible capabilities unless the operator explicitly changes the requirement.
The [engineering whitepaper](../.agents/skills/engineering-whitepaper/SKILL.md)
records the full review standard.

The pre-commit hook scans staged changes for secrets and private content. Install
its required scanner if needed:

```bash
common/scripts/install-gitleaks.sh
```

Ensure the installed binary is on `PATH` and use the repository hook. Never skip
it with `--no-verify`. Examples and fixtures must not contain real chat IDs,
tokens, internal hosts, or private registry URLs.

Changes to architecture, configuration/state formats, protocol contracts, or
cross-process behavior also update the owning knowledge entry. Validate those
updates with:

```bash
.agents/scripts/check.sh
```

User-facing release changes need a Rush change file, created with
`node common/scripts/install-run-rush.js change`. Do not edit generated
changelogs. Follow the repository's special rules for upgrade-blocking state
changes and the 0.x version line.

## Branches and releases

Open development PRs against **`next`**. It is the integration branch and the
source of beta releases. **`main`** is the stable release branch. GitHub Actions
owns version updates and npm publishing; do not publish or push release tags
manually.

For complete PR, release, and changelog policy, see
[repository operations](../.agents/domains/repository-operations-and-release.md).
