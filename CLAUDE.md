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

- `/packages/<name>/` holds packages. Publishable today: `@excitedjs/dreamux`
  (the host), `@excitedjs/feishu-transport` (the platform-I/O core, sole owner
  of the `@larksuiteoapi/node-sdk` import), and `@excitedjs/feishu-channel`
  (per-host channel layer, a placeholder today) — see the channel refactor (#4).
  Private (unpublished): `@excitedjs/eslint-config`, the shared ESLint flat
  config that is the single source of the synchronous-blocking-IO ban (#85).
- `/rush.json`, `/common/config/rush/`, `/common/scripts/install-run-rush.js`
  are the rush + pnpm scaffolding.
- `/bin/dreamux` is a source-checkout convenience shim that forwards to
  `/packages/dreamux/bin/dreamux`; the package also includes a `tm` wrapper
  used by dispatcher skills — see
  `.agents/decisions/dispatcher-tm-packaging.md`.
- `/.agents/` is the on-demand knowledge base. Start at `.agents/root.md`.

**One install path — the monorepo path.** Build and test through rush:

```
node common/scripts/install-run-rush.js update   # then build / test
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js test
```

The per-package npm path (`cd packages/dreamux && npm install`) is **retired**:
`@excitedjs/dreamux` depends on `@excitedjs/feishu-transport` via the pnpm
`workspace:*` protocol, which `npm` cannot resolve. The release workflow
publishes a pnpm-packed tarball, where pnpm rewrites `workspace:*` to real
registry versions before npm uploads it, so external
`npm install @excitedjs/dreamux` is unaffected — only the in-repo per-package
path is gone. There is no committed per-package `package-lock.json`.

Reasoning: `.agents/decisions/install-model.md` (which retires the
two-paths consequence of `.agents/decisions/rush-pnpm-monorepo.md`).

## CLI surface

The user-facing CLI is the single global bin `dreamux`. Current command tree:
`onboard`, `uninstall`, `serve`, `status`, `doctor`,
`daemon install|uninstall|start|stop|restart`,
`dispatcher add|remove|list|status|start|stop`, `feishu-mcp`, and
`config path|show`. `dreamux serve` is the foreground server entry point. The
`daemon` group wraps the native user-level service manager (Linux
`systemctl --user`, macOS `launchctl`); `daemon uninstall` removes only the
service unit, whereas top-level `dreamux uninstall` removes config/state/logs
too. `daemon restart --notify-resumed --dispatcher <id>` drops a one-shot
restart marker before restarting, so a resumed dispatcher gets a
`Restart completed.` turn injected — see issue #78. Do not reintroduce
global aliases such as `dreamux-server` or `server-ctl`; issue #18 explicitly
removed the legacy global-bin transition period.

## Knowledge-delta protocol

Before finishing a non-trivial PR, ask:

> Did this move a package boundary, a CLI surface, a settled design
> decision, a Codex / Feishu protocol contract, or a cross-process invariant?

If yes → update `.agents/` in the same PR. The full protocol and document
kinds are in [`.agents/CONTRIBUTING.md`](.agents/CONTRIBUTING.md).

Run `.agents/scripts/check.sh` before committing KB changes; CI rejects
what the script rejects.

## Config, state, and logs (top-level design)

Current architecture is documented in
[`.agents/decisions/top-level-design.md`](.agents/decisions/top-level-design.md).
That record wins over older runtime-dir / SQLite decisions.

- `~/.dreamux/config.json` — the only dreamux operator-editable config
  source. It holds dispatcher declarations and local Feishu credentials.
  `dreamux serve` must fail loudly when it is missing and tell the operator
  to run `dreamux onboard`.
- `~/.dreamux/state/` — server-owned state: `server.json`, `admin.sock`, and
  per-dispatcher `status.json`, `access.json`, and Codex socket files. Safe to
  remove when the operator intentionally wants to discard server state.
- `~/.dreamux/logs/` — server-owned logs, split by component; Codex
  app-server logs use `~/.dreamux/logs/codex-app-server/<dispatcher>.log`.
- `~/.codex/` — Codex's own global home for auth, config, and memory.
  Dispatcher app-server processes follow Codex here; dreamux must not create
  dispatcher-private `CODEX_HOME` directories for the MVP.
- `<dispatcher cwd>/.codex/skills/dispatcher/SKILL.md` — workspace-local
  dispatcher skill installed by `dreamux onboard`; do not install this skill
  into the operator's global `~/.codex/skills/` for the MVP.

Do not reintroduce `runtime_dir`, SQLite-backed dispatcher state, or
`~/.codex-host/` as dreamux runtime state unless a new decision record
explicitly supersedes the top-level design.

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
- **No synchronous blocking IO in package source. (#85.)** dreamux is one
  event loop hosting N dispatchers; a `*Sync` fs/`child_process` call stalls
  every dispatcher. `n/no-sync` (plus import / syntax backstops, shared via
  `@excitedjs/eslint-config`) makes `/packages/*/src/**` a hard error; use
  `node:fs/promises` and the async `child_process` API. `tests/**` allows sync
  `fs` fixtures but still bans sync `child_process` (two audited exemptions
  carry reasoned `eslint-disable`s). `runtime/logger.ts` keeps
  `pino.destination({ sync: true })` deliberately — a config flag, not a `*Sync`
  call. Enforced by `rush lint` (CI + pre-commit). The config is pure-syntactic,
  so `no-floating-promises` is unavailable: audit a newly-`async` function's
  callers by hand. See `.agents/decisions/no-sync-io-lint-gate.md`.
- **No new runtime dependencies on dev tools.** PR #6 removed `tsx`; do
  not reintroduce it for bin launchers. The launchers exec `node` on
  compiled `dist/` output.
- **Bin launchers resolve their own location through symlinks** so they
  work from any cwd and via `~/bin/<x>` shortcuts. The POSIX symlink-walk
  loop in `/packages/dreamux/bin/dreamux` is the reference shape; reuse it
  verbatim for any new launcher.
- **Path builders go in `src/runtime/paths.ts` only.** Cross-process file
  contracts (the admin socket path, dispatcher state files, logs, and Codex
  socket path) drift silently if any other file constructs them by raw string
  concatenation.
- **Codex protocol bumps run through `src/codex/handshake.ts` first.** Any
  RPC before `initialize` is rejected with `Not initialized` on codex
  0.134+ — confirmed end-to-end in `tests/codex-0135-live.test.ts`.
- **Tests that depend on a real codex install fail loudly when codex is
  missing**, not silent skip. Opt-in skip via `DREAMUX_SKIP_LIVE_CODEX=1`
  (see `tests/codex-0135-live.test.ts`'s docstring).

## Commits

- Use real author identity. If `git commit` complains about an
  auto-detected email (whoami@hostname), set `user.email` / `user.name`
  explicitly per-commit via `git -c user.email=... -c user.name=...`.
- Commit messages: short subject (50 chars), body wrapped, explain *why*.
  Reference the issue / PR when relevant.
- Co-author trailer: add `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
  to commits authored with this agent (matches the trailer used in
  PR #3, #5, #6).
