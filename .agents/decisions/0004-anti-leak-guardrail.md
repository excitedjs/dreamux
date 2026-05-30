# 0004 — Anti-leak guardrail (gitleaks)

- **Status:** Accepted
- **Date:** 2026-05-30
- **Affects:** repo root (`/.gitleaks.toml`, `/.npmrc`), CI (`/.github/workflows/ci.yml`), git hooks (`/common/git-hooks/`)
- **PR / Issue:** chore/anti-leak-guardrail

## Context

`excitedjs/dreamux` is a **public** open-source repo, but it is developed
alongside company-internal tooling. Company-internal content — Feishu
identifiers (`ou_`/`oc_`/`cli_`), internal tokens/secrets, private-mirror
registry URLs, internal hostnames — must never reach a commit, because a
leaked commit is public and permanent (forks, mirrors, caches survive a
later deletion). A naïve `npm install` can also bake a non-public mirror
URL into the lockfile. The repo shares this concern, and a single canonical
config, with the sibling **claudemux** repo.

## Decision

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

## Consequences

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
