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

## Repo layout (monorepo since issue #4)

```
/                                  rush monorepo root
├── rush.json                      rush + pnpm config
├── common/                        rush scaffolding (config + bootstrap)
├── packages/
│   └── dreamux/                   @excitedjs/dreamux — the only package today
│       ├── bin/                   dreamux / server / server-ctl launchers
│       ├── src/                   admin, cli, codex, db, dispatcher, feishu, runtime
│       ├── tests/                 vitest (smoke + live-codex + bin-launcher)
│       └── db/migrations/         SQLite schema migrations
├── bin/                           thin redirectors → packages/dreamux/bin/
├── .agents/                       this knowledge base
├── .github/workflows/             CI
└── CLAUDE.md                      always-loaded operating rules (AGENTS.md is a symlink)
```

## Navigation

- [`components/`](components/) — one doc per piece (repo-structure today;
  server / codex-client / feishu-bot / cli to be added as they stabilize).
- [`decisions/`](decisions/) — accepted decision records. Newest at the
  top of the index in each file's frontmatter; ordered numerically.
- `domains/`, `proposals/`, `research/`, `rules/` — empty for now; add
  here when material grows past a single file's worth.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — when to update this KB, how to
  format docs, the knowledge-delta protocol.
- [`scripts/check.sh`](scripts/check.sh) — link / orphan checker. Run
  before any KB-touching commit.

## When to read which

| You're about to ... | Read first |
|---|---|
| add/change a package, move source between packages | [`components/repo-structure.md`](components/repo-structure.md) |
| understand why rush + pnpm | [`decisions/0001-rush-pnpm-monorepo.md`](decisions/0001-rush-pnpm-monorepo.md) |
| rename or restructure the public CLI / package | [`decisions/0002-cli-and-package-naming.md`](decisions/0002-cli-and-package-naming.md) |
| add / change a global config key (`~/.dreamux/config.toml`) | [`decisions/0003-global-config-dir.md`](decisions/0003-global-config-dir.md) |
| touch the anti-leak guardrail (`.gitleaks.toml`, `.npmrc`, CI / hook) | [`decisions/0004-anti-leak-guardrail.md`](decisions/0004-anti-leak-guardrail.md) |
| write a new decision record / new component doc | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| modify the server runtime / Codex protocol handling | the issue links above + read the source — runtime details aren't yet promoted to the KB |
