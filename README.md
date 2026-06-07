# dreamux

Rush + pnpm monorepo for `@excitedjs/dreamux` — a local dispatcher host that
runs N **Dispatchers** in one Node process. Each dispatcher binds a Channel
provider, an Agent Runtime provider, and Dreamux-owned MCP surfaces for channel
reply and TeamMate work.

Replaces the "Claude Code as dispatcher" pattern from
[claudemux](https://github.com/excitedjs/claudemux).

Design background:
[#1 Proposal](https://github.com/excitedjs/dreamux/issues/1) ·
[#2 Engineering plan](https://github.com/excitedjs/dreamux/issues/2) ·
[#4 Monorepo + harness](https://github.com/excitedjs/dreamux/issues/4).

## Where to look

| Looking for | Read |
|---|---|
| The package itself (install, run, configure, Phase 1 verification, config reference, testing) | [`packages/dreamux/README.md`](packages/dreamux/README.md) |
| Dispatcher skill and tm packaging | [`.agents/decisions/dispatcher-tm-packaging.md`](.agents/decisions/dispatcher-tm-packaging.md) |
| Plugin/provider architecture and #110 closure boundary | [`.agents/proposals/plugin-provider-architecture.md`](.agents/proposals/plugin-provider-architecture.md), [`.agents/decisions/issue-110-epic-closure.md`](.agents/decisions/issue-110-epic-closure.md) |
| Architecture, decisions, knowledge-delta protocol | [`.agents/root.md`](.agents/root.md) |
| Always-loaded agent operating rules | [`CLAUDE.md`](CLAUDE.md) (`AGENTS.md` is a symlink) |
| Monorepo layout reference | [`.agents/components/repo-structure.md`](.agents/components/repo-structure.md) |
| Why Rush + pnpm | [`.agents/decisions/rush-pnpm-monorepo.md`](.agents/decisions/rush-pnpm-monorepo.md) |
| Why the monorepo path is the only install path | [`.agents/decisions/install-model.md`](.agents/decisions/install-model.md) |
| Why `@excitedjs/dreamux` + `dreamux` CLI + the two legacy aliases | [`.agents/decisions/cli-and-package-naming.md`](.agents/decisions/cli-and-package-naming.md) |

## Repo layout

```
/
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
./packages/dreamux/bin/dreamux serve
```

Full quick start, config reference, and Phase 1 verification path are in the
package README:
[`packages/dreamux/README.md`](packages/dreamux/README.md).

Repo-root `bin/dreamux` is a thin source-checkout shim that forwards to
`packages/dreamux/bin/dreamux`.

## License

MIT — see [`LICENSE`](LICENSE).
