# dreamux

Rush + pnpm monorepo for `@excitedjs/dreamux` — a Codex-host server that
runs N **Dispatchers** in one Node process, each binding 1 Feishu bot to
1 Codex thread.

Replaces the "Claude Code as dispatcher" pattern from
[claudemux](https://github.com/excitedjs/claudemux).

Design background:
[#1 Proposal](https://github.com/excitedjs/dreamux/issues/1) ·
[#2 Engineering plan](https://github.com/excitedjs/dreamux/issues/2) ·
[#4 Monorepo + harness](https://github.com/excitedjs/dreamux/issues/4).

## Where to look

| Looking for | Read |
|---|---|
| The package itself (install, run, configure, MVP verification, config reference, testing) | [`packages/dreamux/README.md`](packages/dreamux/README.md) |
| Codex-native codexmux plugin install and dispatcher skill flow | [`codex-marketplace/README.md`](codex-marketplace/README.md) |
| Architecture, decisions, knowledge-delta protocol | [`.agents/root.md`](.agents/root.md) |
| Always-loaded agent operating rules | [`CLAUDE.md`](CLAUDE.md) (`AGENTS.md` is a symlink) |
| Monorepo layout reference | [`.agents/components/repo-structure.md`](.agents/components/repo-structure.md) |
| Why Rush + pnpm | [`.agents/decisions/rush-pnpm-monorepo.md`](.agents/decisions/rush-pnpm-monorepo.md) |
| Why the monorepo path is the only install path | [`.agents/decisions/install-model.md`](.agents/decisions/install-model.md) |
| Why `@excitedjs/dreamux` + `dreamux` CLI + the two legacy aliases | [`.agents/decisions/cli-and-package-naming.md`](.agents/decisions/cli-and-package-naming.md) |

## Repo layout

```
/
├── codex-marketplace/     local Codex marketplace for the codexmux plugin
├── packages/
│   ├── dreamux/           @excitedjs/dreamux — the host server
│   └── channel/
│       ├── feishu-transport/   @excitedjs/feishu-transport — platform-I/O core
│       └── feishu-channel/     @excitedjs/feishu-channel — channel layer (placeholder)
├── bin/                   thin forwarders → packages/dreamux/bin/
├── rush.json              rush + pnpm + Node version pins
├── common/
│   ├── config/rush/       command-line.json, .npmrc, version-policies.json
│   └── scripts/install-run-rush.js   minimal rush bootstrap
├── .agents/               on-demand knowledge base
├── .github/workflows/     CI: rush change/typecheck/build/test, shellcheck, KB check, author/gitleaks gates
├── CLAUDE.md              always-loaded operating rules
└── AGENTS.md              symlink → CLAUDE.md
```

## Quick start

The monorepo path is the single supported install path (the workspace now
spans three packages wired with `workspace:*`, which `npm` cannot resolve —
see [the install-model decision](.agents/decisions/install-model.md)):

```bash
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js test
./packages/dreamux/bin/dreamux server start
```

Full quick start, config reference, and MVP verification path are in the
package README:
[`packages/dreamux/README.md`](packages/dreamux/README.md).

Repo-root `bin/{dreamux,server,server-ctl}` are thin shims that forward
to `packages/dreamux/bin/` so pre-monorepo PATH entries keep working.

## Codexmux plugin

The codex-native product layer lives in
[`codex-marketplace/`](codex-marketplace/). It installs as a local Codex
marketplace named `dreamux` and provides the `codexmux-dispatcher` skill.

```bash
codex plugin marketplace add ./codex-marketplace
codex plugin add codexmux@dreamux
npm exec --yes --package @excitedjs/tm@2.1.2 -- tm --help
```

The skill keeps the runtime boundary thin: dreamux server hosts dispatchers;
the dispatcher invokes the pinned `tm` CLI for teammate work.

## License

MIT — see [`LICENSE`](LICENSE).
