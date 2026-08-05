# Repository Operations And Release

This page is the stable contract for repo-level operational rules: install
path, package/bin surface, public-repo safeguards, lint gates, changelog
responsibility, and npm release.

Read this before changing Rush config, package manifests, public CLI bins,
release workflows, anti-leak guardrails, lint gates, or changelog behavior.

## Install And Build

The repo has one supported source install path: Rush + pnpm.

```bash
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js test
```

Per-package `npm install` is not supported in this monorepo. Source manifests
use `workspace:*`; pnpm/Rush resolve those locally, and Rush-native publish
rewrites them for registry install.

Source:

- `/rush.json`
- `/common/config/rush/command-line.json`
- `/packages/dreamux/package.json`

## Package Surface

The public operator package is `@excitedjs/dreamux`. It exposes one public bin:

```json
{ "dreamux": "./bin/dreamux" }
```

Runtime support shims such as `channel-mcp`, `team-mcp`, `teammate-mcp`, and
`cron-mcp` are reached through Dreamux-managed MCP descriptors and internal CLI
subcommands. They are not separate public npm bins.

`dreamux changelog` reads the installed package's shipped Rush-generated
`CHANGELOG.md` / `CHANGELOG.json`; both files must remain in the package
`files` allowlist.

Source:

- `/packages/dreamux/package.json`
- `/packages/dreamux/bin/dreamux`
- `/packages/dreamux/src/platform/paths.ts`

## Public-Repo Red Line

This is a public repository. Do not commit internal identifiers, secrets,
private registry URLs, internal hostnames, real Feishu ids, or tokens.

Guardrails:

- `/.gitleaks.toml` is the canonical secret/id rule config, shared with the
  sibling repo.
- `/.npmrc` pins the public npm registry.
- `common/git-hooks/pre-commit` scans staged changes with gitleaks when present.
- CI runs full-history gitleaks detection.

If a guardrail false-positives, stop and ask. Do not edit a local allowlist,
path exclusion, or bypass flag in only this repo.

Source:

- `/.gitleaks.toml`
- `/.npmrc`
- `/common/git-hooks/pre-commit`
- `/.github/workflows/ci.yml`

## Lint And Source Gates

Package source under `/packages/*/src/**` must not use synchronous blocking IO.
The shared `@excitedjs/eslint-config` enforces:

- `n/no-sync` in source;
- import/syntax backstops for renamed sync APIs;
- reasoned eslint-disable comments;
- source file physical line cap;
- test-specific carve-outs for sync fixture IO while keeping synchronous
  `child_process` banned by default.

`rush lint` is the authoritative bulk lint gate. The pre-commit hook lint-gates
staged package TypeScript against each package's flat config.

Source:

- `/packages/eslint-config/`
- `/packages/dreamux/tests/no-sync-io-gate.test.ts`
- `/common/git-hooks/pre-commit`
- `/common/config/rush/command-line.json`

## Release

Publishing is Rush-native and npm OIDC trusted-publishing based.

Stable release:

- `release.yml` runs on `main`;
- if Rush change files exist, it runs `rush publish --apply`;
- it commits version/CHANGELOG artifacts back to `main`;
- the publish job builds and runs
  `rush publish --include-all --publish --set-access-level public`;
- npm provenance is enabled with `NPM_CONFIG_PROVENANCE=true`;
- there is no long-lived npm token in the workflow.

Prerelease:

- pushes or manual dispatches on `next` publish `beta`;
- manual dispatch on other non-main branches publishes `alpha`;
- prerelease jobs do not commit or delete Rush change files;
- tarballs are packed and audited before upload.

Raw `npm publish` from package directories is forbidden because it would publish
unrewritten `workspace:*` dependencies.

Source:

- `/.github/workflows/release.yml`
- `/rush.json`
- `/common/config/rush/version-policies.json`

## Changelog Responsibility

Dreamux 0.x handles incompatible config/state/cache/run/log/workspace shape,
version, or path changes by fail-loud plus explicit rebuild/delete/onboard
guidance. Any change that can block or break an upgrade needs a Rush change
file.

Incompatible shape, version, or path notes start with `BREAKING:` and include
`Rebuild:` with the exact action. A same-shape semantic change may retain its
state version only with explicit operator approval; its note starts with
`BREAKING:`, immediately adds `Review:` with the required check, explicitly
says no rebuild is needed, and contains no `Rebuild:` instruction. The V3
Feishu `allow_chats` trust change is the accepted example.

Use `rush change`; do not hand-edit generated changelogs.

The Dispatcher-only `dreamux-maintenance` skill keeps its root and ordinary
references current-state-only. Its sole transition exception is a generic,
explicit-intent managed-daemon self-upgrade SOP. That SOP stages and validates
exact old and target artifacts, selects the full `(oldVersion, targetVersion]`
range from the staged changelog, and routes concrete config/provider work
through the staged target's owner references. Release-specific transitions
remain in Rush change notes, public docs, loader errors, and decisions; they are
not copied into the skill.

Source:

- `/common/changes/`
- `/common/config/rush/version-policies.json`
- `/packages/dreamux/CHANGELOG.md`

## Decision Trail

- [Rush pnpm monorepo](../decisions/rush-pnpm-monorepo.md)
- [Install model](../decisions/install-model.md)
- [CLI and package naming](../decisions/cli-and-package-naming.md)
- [Global bin/onboard/serve](../decisions/global-bin-onboard-serve.md)
- [Dispatcher tm packaging](../decisions/dispatcher-tm-packaging.md)
- [NPM release OIDC](../decisions/npm-release-oidc.md)
- [Anti-leak guardrail](../decisions/anti-leak-guardrail.md)
- [No sync IO lint gate](../decisions/no-sync-io-lint-gate.md)
- [Maintenance progressive disclosure and self-upgrade SOP](../archive/proposals/dreamux-maintenance-progressive-disclosure.md)
