# dreamux knowledge base

This is the on-demand knowledge base for the `excitedjs/dreamux` repo.
Always-loaded rules live in [`/CLAUDE.md`](../CLAUDE.md); navigate to here
when you need the *why* behind a piece of code or a decision history.

## What dreamux is

A long-running Node process that hosts N **Dispatchers**. Each Dispatcher
binds **1 Feishu bot + 1 Codex thread**; all of that bot's inbound chats
funnel into the same thread, and outbound replies route back to the
message's source chat. Background and the full P0 design are in GitHub
issues:

- [#1 Proposal](https://github.com/excitedjs/dreamux/issues/1) — original proposal
- [#2 Engineering plan](https://github.com/excitedjs/dreamux/issues/2) — implementation-ready spec
- [#4 Monorepo + harness](https://github.com/excitedjs/dreamux/issues/4) — current repo shape
- [#18 Global bin onboarding](https://github.com/excitedjs/dreamux/issues/18) — `dreamux onboard` / `dreamux serve` design

## Repo layout (monorepo since issue #4)

```
/                                  rush monorepo root
├── codex-marketplace/             local Codex marketplace for codexmux
├── rush.json                      rush + pnpm config
├── common/                        rush scaffolding (config + bootstrap)
├── packages/
│   ├── dreamux/                   @excitedjs/dreamux — the host server
│   │   ├── bin/                   dreamux / server / server-ctl launchers
│   │   ├── src/                   admin, cli, codex, db, dispatcher, feishu, runtime
│   │   ├── tests/                 vitest (smoke + live-codex + bin-launcher)
│   │   └── db/migrations/         SQLite schema migrations
│   └── channel/
│       ├── feishu-transport/      @excitedjs/feishu-transport — platform-I/O core
│       │                          (sole @larksuiteoapi/node-sdk importer)
│       └── feishu-channel/        @excitedjs/feishu-channel — channel layer (placeholder)
├── bin/                           thin redirectors → packages/dreamux/bin/
├── .agents/                       this knowledge base
├── .github/workflows/             CI
└── CLAUDE.md                      always-loaded operating rules (AGENTS.md is a symlink)
```

## Navigation

- [`components/`](components/) — one doc per piece (repo-structure today;
  codex-marketplace today; server / codex-client / feishu-bot / cli to be
  added as they stabilize).
- [`decisions/README.md`](decisions/README.md) — accepted decision records,
  indexed by topic slug. Do not prefix new records with sequence numbers.
- [`proposals/global-bin-onboard-serve.md`](proposals/global-bin-onboard-serve.md)
  — active issue #18 spec for the global `dreamux` bin, onboarding wizard,
  service registration, and `serve` runtime.
- `domains/`, `proposals/`, `research/`, `rules/` — empty for now; add
  here when material grows past a single file's worth.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — when to update this KB, how to
  format docs, the knowledge-delta protocol.
- [`scripts/check.sh`](scripts/check.sh) — link / orphan checker. Run
  before any KB-touching commit.

## When to read which

| You're about to ... | Read first |
|---|---|
| add/change the Codex plugin marketplace or dispatcher skill | [`components/codex-marketplace.md`](components/codex-marketplace.md) |
| add/change a package, move source between packages | [`components/repo-structure.md`](components/repo-structure.md) |
| browse decisions by topic | [`decisions/README.md`](decisions/README.md) |
| understand why rush + pnpm | [`decisions/rush-pnpm-monorepo.md`](decisions/rush-pnpm-monorepo.md) |
| install / build / test the repo, or wonder why `npm ci` is gone | [`decisions/install-model.md`](decisions/install-model.md) |
| rename or restructure the public CLI / package | [`decisions/cli-and-package-naming.md`](decisions/cli-and-package-naming.md) |
| implement issue #18 global bin / onboard / serve | [`proposals/global-bin-onboard-serve.md`](proposals/global-bin-onboard-serve.md) + [`decisions/global-bin-onboard-serve.md`](decisions/global-bin-onboard-serve.md) |
| add / change a global config key (`~/.dreamux/config.toml`) | [`decisions/global-config-dir.md`](decisions/global-config-dir.md) |
| touch the anti-leak guardrail (`.gitleaks.toml`, `.npmrc`, CI / hook) | [`decisions/anti-leak-guardrail.md`](decisions/anti-leak-guardrail.md) |
| touch npm publishing / the release workflows | [`decisions/npm-release-oidc.md`](decisions/npm-release-oidc.md) |
| add or verify Rush change files | [`components/repo-structure.md#rush-change-files`](components/repo-structure.md#rush-change-files) |
| write a new decision record / new component doc | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| modify the server runtime / Codex protocol handling | the issue links above + read the source — runtime details aren't yet promoted to the KB |
