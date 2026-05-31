# dreamux — repository operating rules

Always loaded. On-demand context lives in [`.agents/`](.agents/root.md);
read it when you need the *why* behind a decision or a component.

When CLAUDE.md and the KB disagree, CLAUDE.md is authoritative — the KB
is an on-demand reference, not a binding rule. If you find a contradiction,
fix it in the same PR.

## Communication

- Reply to the user in **Chinese**.
- Write all repo docs (README, `.agents/`, code comments, commit messages,
  PR descriptions) in **English**, regardless of conversation language.

## Repository shape

`excitedjs/dreamux` is a **Rush + pnpm monorepo** since issue #4.

- `/packages/<name>/` holds publishable packages. Today: `@excitedjs/dreamux`
  (the host), `@excitedjs/feishu-transport` (the platform-I/O core, sole owner
  of the `@larksuiteoapi/node-sdk` import), and `@excitedjs/feishu-channel`
  (per-host channel layer, a placeholder today) — see the channel refactor (#4).
- `/rush.json`, `/common/config/rush/`, `/common/scripts/install-run-rush.js`
  are the rush + pnpm scaffolding.
- `/bin/` shims forward to `/packages/dreamux/bin/` for backward-compat with
  pre-monorepo PATH entries — see `.agents/decisions/cli-and-package-naming.md`.
- `/.agents/` is the on-demand knowledge base. Start at `.agents/root.md`.

**One install path — the monorepo path.** Build and test through rush:

```
node common/scripts/install-run-rush.js update   # then build / test
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js test
```

The per-package npm path (`cd packages/dreamux && npm install`) is **retired**:
`@excitedjs/dreamux` depends on `@excitedjs/feishu-transport` via the pnpm
`workspace:*` protocol, which `npm` cannot resolve. pnpm rewrites `workspace:*`
to the real version at publish time, so external `npm install @excitedjs/dreamux`
is unaffected — only the in-repo per-package path is gone. There is no committed
per-package `package-lock.json`.

Reasoning: `.agents/decisions/install-model.md` (which retires the
two-paths consequence of `.agents/decisions/rush-pnpm-monorepo.md`).

## CLI surface

The user-facing CLI is `dreamux` (subcommands `server start`, `server status`,
`dispatcher add|remove|list|status|start|stop`). The legacy `dreamux-server`
and `server-ctl` binaries are kept as aliases — see
`.agents/decisions/cli-and-package-naming.md`. New documentation and
examples should introduce `dreamux <verb>`.

## Knowledge-delta protocol

Before finishing a non-trivial PR, ask:

> Did this move a package boundary, a CLI surface, a settled design
> decision, a Codex / Feishu protocol contract, or a cross-process invariant?

If yes → update `.agents/` in the same PR. The full protocol and document
kinds are in [`.agents/CONTRIBUTING.md`](.agents/CONTRIBUTING.md).

Run `.agents/scripts/check.sh` before committing KB changes; CI rejects
what the script rejects.

## Two home directories (global-config decision)

- `~/.dreamux/config.toml` — user-editable global config; auto-created on
  first boot. Source of truth: the operator.
- `~/.codex-host/` — server-owned runtime state (SQLite, sockets, logs).
  Source of truth: the server. Safe to `rm -rf`.

Never mix them. If a new piece of state needs to be persisted, ask: does
the operator edit it (→ config) or does the server own it (→ runtime
dir)? When in doubt, runtime dir — that's the safer default.

## Always-binding engineering rules

- **Public repo — never commit company-internal content. (Red line.)**
  `excitedjs/dreamux` is a public open-source repo. Feishu identifiers
  (`ou_`/`oc_`/`cli_`), internal tokens/secrets, private-mirror registry URLs,
  internal hostnames — none of it ever goes in a commit; a leaked commit is
  public and permanent. The anti-leak guardrail enforces this: the committed
  `.gitleaks.toml`, the `gitleaks protect --staged` pre-commit hook
  (`common/git-hooks/pre-commit`), and a full-history `gitleaks detect`
  CI gate. `.gitleaks.toml` and `.npmrc` are a **shared canonical kept
  byte-identical with the claudemux repo** — do not edit them in only one repo;
  if gitleaks false-positives, stop and ask rather than adding a local
  allowlist, and sync any config change across both repos.
- **No new runtime dependencies on dev tools.** PR #6 removed `tsx`; do
  not reintroduce it for bin launchers. The launchers exec `node` on
  compiled `dist/` output.
- **Bin launchers resolve their own location through symlinks** so they
  work from any cwd and via `~/bin/<x>` shortcuts. The POSIX symlink-walk
  loop in `/packages/dreamux/bin/server` is the reference shape; reuse it
  verbatim for any new launcher.
- **Path builders go in `src/runtime/paths.ts` only.** Cross-process file
  contracts (the admin socket path, the codex socket path, the SQLite db
  path) drift silently if any other file constructs them by raw string
  concatenation.
- **Codex protocol bumps run through `src/codex/handshake.ts` first.** Any
  RPC before `initialize` is rejected with `Not initialized` on codex
  0.134+ — confirmed end-to-end in `tests/codex-0134-live.test.ts`.
- **Tests that depend on a real codex install fail loudly when codex is
  missing**, not silent skip. Opt-in skip via `DREAMUX_SKIP_LIVE_CODEX=1`
  (see `tests/codex-0134-live.test.ts`'s docstring).

## Commits

- Use real author identity. If `git commit` complains about an
  auto-detected email (whoami@hostname), set `user.email` / `user.name`
  explicitly per-commit via `git -c user.email=... -c user.name=...`.
- Commit messages: short subject (50 chars), body wrapped, explain *why*.
  Reference the issue / PR when relevant.
- Co-author trailer: add `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
  to commits authored with this agent (matches the trailer used in
  PR #3, #5, #6).
