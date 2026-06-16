# dreamux repository operating rules

Always loaded. Keep this file to guardrails that must be present in every
agent context. On-demand architecture and reference material lives in
[`.agents/root.md`](.agents/root.md).

When this file and `.agents/` disagree, this file is authoritative for operating
rules. For architecture facts, read the current source first, then the linked
KB entry.

## Communication

- Reply to the user in **Chinese**.
- Write all repo docs, `.agents/` docs, code comments, commit messages, and PR
  descriptions in **English**.

## Current Source Of Truth

- Current architecture entry point: [`.agents/reference/current-architecture.md`](.agents/reference/current-architecture.md).
- Repository/package layout: [`.agents/reference/repo-structure.md`](.agents/reference/repo-structure.md).
- State/cache/run/log paths: [`.agents/reference/state-and-paths.md`](.agents/reference/state-and-paths.md).
- Channel/Feishu runtime: [`.agents/reference/channel-runtime.md`](.agents/reference/channel-runtime.md).
- Task routing and KB index: [`.agents/root.md`](.agents/root.md).
- KB writing rules: [`.agents/CONTRIBUTING.md`](.agents/CONTRIBUTING.md).

Before answering architecture/domain questions, verify against source code. The
KB explains intent and history; code is the current behavior.

## Build And Test

`excitedjs/dreamux` is a Rush + pnpm monorepo. Use the monorepo path only:

```bash
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js test
```

Do not use per-package `npm install`; workspace dependencies use `workspace:*`.

## Always-Binding Rules

- **Public repo red line:** never commit internal identifiers, secrets, private
  registry URLs, internal hostnames, or real Feishu ids/tokens. `.gitleaks.toml`
  and `.npmrc` are shared canonical guardrails with the sibling repo; if a
  guardrail false-positives, stop and ask rather than editing a local allowlist.
- **No synchronous blocking IO in package source:** `/packages/*/src/**` must
  use async fs/process APIs. `rush lint` enforces the shared
  `@excitedjs/eslint-config` no-sync-IO gate.
- **No runtime dependencies on dev tools:** bin launchers execute compiled
  `dist/` with plain `node`; do not reintroduce `tsx`.
- **Launcher path handling:** new bin launchers must follow the
  `/packages/dreamux/bin/dreamux` symlink-walk shape.
- **Path contracts:** host-owned path builders belong in
  `/packages/dreamux/src/platform/paths.ts`; volatile runtime socket allocation
  belongs in `/packages/dreamux/src/platform/runtime-sockets.ts`; runtime-owned
  path derivation belongs in the runtime package that uses it (for example
  `/packages/agent-runtime/codex/src/paths.ts`).
- **No legacy architecture rollback:** do not reintroduce `runtime_dir`,
  SQLite-backed dispatcher state, `~/.codex-host/`, legacy global CLI aliases,
  or workspace `.codex/skills` installation unless a new decision record
  explicitly supersedes the current architecture.
- **Codex protocol bumps:** update the
  `@excitedjs/agent-runtime-codex` package first. Core must stay behind the
  neutral `AgentRuntimeProvider` interface.
- **Teammate reverse delivery:** Codex completion delivery depends on codex
  0.137+ `thread/inject_items`; older versions fail loudly instead of silently
  dropping completion.
- **Live Codex tests:** tests that require a real Codex install fail loudly when
  Codex is missing. Use `DREAMUX_SKIP_LIVE_CODEX=1` only when the environment
  intentionally lacks Codex.

## Knowledge Delta

Before finishing a non-trivial PR, ask:

> Did this move a package boundary, CLI surface, settled design decision,
> Codex / Feishu protocol contract, state/config format, or cross-process
> invariant?

If yes, update `.agents/` in the same PR and run:

```bash
.agents/scripts/check.sh
```

## Changelog Responsibility

Dreamux 0.x handles incompatible config/state changes by fail-loud plus manual
rebuild. Any change that can block or break a user's upgrade needs a Rush change
file. Use `rush change`; never hand-edit generated changelogs.

Typical upgrade blockers include config/state/cache/run/log path semantics,
persisted file formats, onboard/daemon behavior, bundled skills, dispatcher
cwd/work directory contracts, and any manual rebuild requirement.

For breaking notes, lead with `BREAKING:` and include `Rebuild:` when the user
must recreate a file/path.

## Commits

- Use real author identity. If git reports an auto-detected email, set
  `user.email` / `user.name` explicitly for the commit.
- Commit messages: short subject, wrapped body, explain why, reference issues or
  PRs when relevant.
- Co-author trailer for this agent:
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
