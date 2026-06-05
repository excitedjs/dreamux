# dreamux knowledge base

This is the on-demand knowledge base for the `excitedjs/dreamux` repo.
Always-loaded rules live in [`/CLAUDE.md`](../CLAUDE.md); navigate to here
when you need the *why* behind a piece of code or a decision history.

## What dreamux is

A long-running Node process that hosts N **Dispatchers**. Each Dispatcher
binds **1 Feishu channel + 1 Codex app-server child + 1 Codex thread + 1
Feishu MCP endpoint**. All inbound chats for a dispatcher enter that
dispatcher's single Codex thread; Feishu outbound is sent only when Codex
calls the dispatcher-bound `feishu` MCP server. The current top-level
architecture is:

- [Top-level design](decisions/top-level-design.md) — current source of truth
  for runtime state, Feishu MCP, access gating, and config shape.

Background and older issue context:

- [#1 Proposal](https://github.com/excitedjs/dreamux/issues/1) — original proposal
- [#2 Engineering plan](https://github.com/excitedjs/dreamux/issues/2) — implementation-ready spec
- [#4 Monorepo + harness](https://github.com/excitedjs/dreamux/issues/4) — current repo shape
- [#18 Global bin onboarding](https://github.com/excitedjs/dreamux/issues/18) — `dreamux onboard` / `dreamux serve` design

## Repo layout (monorepo since issue #4)

```
/                                  rush monorepo root
├── rush.json                      rush + pnpm config
├── common/                        rush scaffolding (config + bootstrap)
├── packages/
│   ├── dreamux/                   @excitedjs/dreamux — the host server
│   │   ├── bin/                   dreamux and tm launchers
│   │   ├── skills/                bundled dispatcher Codex skill
│   │   ├── src/                   admin, cli, codex, dispatcher, feishu, runtime, legacy db
│   │   ├── tests/                 vitest (smoke + live-codex + bin-launcher + onboard)
│   │   └── db/migrations/         legacy SQLite migrations targeted for removal
│   ├── channel/
│   │   ├── feishu-transport/      @excitedjs/feishu-transport — platform-I/O core
│   │   │                          (sole @larksuiteoapi/node-sdk importer)
│   │   └── feishu-channel/        @excitedjs/feishu-channel — Feishu channel
│   │                              layer (Codex-facing inbound body,
│   │                              attachments, cache/fallback)
│   └── eslint-config/             @excitedjs/eslint-config — shared lint config
│                                  (private; no-sync-IO gate, issue #85)
├── bin/                           thin redirectors → packages/dreamux/bin/
├── .agents/                       this knowledge base
├── .github/workflows/             CI
└── CLAUDE.md                      always-loaded operating rules (AGENTS.md is a symlink)
```

## Navigation

- [`components/`](components/) — one doc per piece (repo-structure and
  dispatcher-skill today; server / codex-client / feishu-bot / cli to be
  added as they stabilize).
- [`decisions/top-level-design.md`](decisions/top-level-design.md) — current
  top-level design; read this before runtime, Feishu, MCP, config, state, or
  dispatcher-lifecycle work.
- [`decisions/README.md`](decisions/README.md) — accepted decision records,
  indexed by topic slug. Do not prefix new records with sequence numbers.
- [`proposals/global-bin-onboard-serve.md`](proposals/global-bin-onboard-serve.md)
  — superseded issue #18 proposal; accepted behavior lives in
  [`decisions/global-bin-onboard-serve.md`](decisions/global-bin-onboard-serve.md).
- [`proposals/post-mvp-hardening.md`](proposals/post-mvp-hardening.md) —
  consolidated post-MVP hardening proposal (bounded state, restart/startup
  reconciliation, access surface, message-format, CLI/diagnostic robustness);
  groups the deferred epic follow-ups + the #58 ultracode findings into the next
  workstream.
- [`proposals/feishu-bot-trust-context.md`](proposals/feishu-bot-trust-context.md)
  — issue #69 follow-up to #62: trusted-bot next-message context, a
  `list_chat_bots` query tool, and add-then-cancel reaction ordering
  (implemented; settled behavior in `domains/feishu-introduce.md` +
  `domains/non-blocking-dispatcher-inbound.md`).
- [`domains/non-blocking-dispatcher-inbound.md`](domains/non-blocking-dispatcher-inbound.md)
  — final issue #63 runtime model for accepted Feishu inbound: every accepted
  deduped message submits `turn/start`, and reactions move through the
  received / in-progress / cleared states.
- [`domains/feishu-introduce.md`](domains/feishu-introduce.md)
  — issue #62 first increment: the Feishu typed event-route seam, and the group
  `/introduce` hard contract (no `@`-mention required; the sender must be
  allowlisted; awareness never grants trust).
- `proposals/`, `research/`, `rules/` — add here when material grows past a
  single file's worth.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — when to update this KB, how to
  format docs, the knowledge-delta protocol.
- [`scripts/check.sh`](scripts/check.sh) — link / orphan checker. Run
  before any KB-touching commit.

## When to read which

| You're about to ... | Read first |
|---|---|
| add/change the dispatcher Codex skill or `tm` wrapper | [`components/dispatcher-skill.md`](components/dispatcher-skill.md) |
| change dispatcher `tm` packaging, PATH injection, or skill install location | [`decisions/dispatcher-tm-packaging.md`](decisions/dispatcher-tm-packaging.md) |
| add/change a package, move source between packages | [`components/repo-structure.md`](components/repo-structure.md) |
| modify runtime state, dispatcher lifecycle, Feishu MCP, access gating, or config shape | [`decisions/top-level-design.md`](decisions/top-level-design.md) |
| change Feishu inbound attachment downloads, cache, or Codex-facing message body | [`decisions/feishu-inbound-attachments.md`](decisions/feishu-inbound-attachments.md) |
| browse decisions by topic | [`decisions/README.md`](decisions/README.md) |
| understand why rush + pnpm | [`decisions/rush-pnpm-monorepo.md`](decisions/rush-pnpm-monorepo.md) |
| install / build / test the repo, or wonder why `npm ci` is gone | [`decisions/install-model.md`](decisions/install-model.md) |
| rename or restructure the public CLI / package | [`decisions/cli-and-package-naming.md`](decisions/cli-and-package-naming.md) |
| implement issue #18 global bin / onboard / serve | [`proposals/global-bin-onboard-serve.md`](proposals/global-bin-onboard-serve.md) + [`decisions/global-bin-onboard-serve.md`](decisions/global-bin-onboard-serve.md) |
| add / change a config key (`~/.dreamux/config.json`) | [`decisions/top-level-design.md`](decisions/top-level-design.md) first, then historical context in [`decisions/global-config-dir.md`](decisions/global-config-dir.md) |
| touch the anti-leak guardrail (`.gitleaks.toml`, `.npmrc`, CI / hook) | [`decisions/anti-leak-guardrail.md`](decisions/anti-leak-guardrail.md) |
| touch npm publishing / the release workflows | [`decisions/npm-release-oidc.md`](decisions/npm-release-oidc.md) |
| change dispatcher inbound delivery, turn submission, or received-reaction timing | [`domains/non-blocking-dispatcher-inbound.md`](domains/non-blocking-dispatcher-inbound.md) + [`decisions/top-level-design.md`](decisions/top-level-design.md) + read the source |
| add or verify Rush change files | [`components/repo-structure.md#rush-change-files`](components/repo-structure.md#rush-change-files) |
| write a new decision record / new component doc | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| modify the server runtime / Codex protocol handling | [`decisions/top-level-design.md`](decisions/top-level-design.md) + read the source |
