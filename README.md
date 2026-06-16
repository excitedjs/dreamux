# dreamux

Rush + pnpm monorepo for `@excitedjs/dreamux`, a local dispatcher host that
runs N **Dispatchers** in one Node process. A dispatcher binds one Agent Runtime
provider, one or more Channel providers, and Dreamux-owned MCP surfaces for
TeamMate, Team, and channel-tool work.

Replaces the "Claude Code as dispatcher" pattern from
[claudemux](https://github.com/excitedjs/claudemux).

Design background:
[#1 Proposal](https://github.com/excitedjs/dreamux/issues/1) ·
[#2 Engineering plan](https://github.com/excitedjs/dreamux/issues/2) ·
[#4 Monorepo + harness](https://github.com/excitedjs/dreamux/issues/4).

## Where To Look

| Looking for | Read |
|---|---|
| The package itself (install, run, configure, config reference, testing) | [`packages/dreamux/README.md`](packages/dreamux/README.md) |
| Current architecture map | [`.agents/reference/current-architecture.md`](.agents/reference/current-architecture.md) |
| Monorepo layout reference | [`.agents/reference/repo-structure.md`](.agents/reference/repo-structure.md) |
| State/cache/run/log ownership | [`.agents/reference/state-and-paths.md`](.agents/reference/state-and-paths.md) |
| Channel and Feishu runtime | [`.agents/reference/channel-runtime.md`](.agents/reference/channel-runtime.md) |
| Provider architecture and package split | [`.agents/decisions/provider-architecture-realignment.md`](.agents/decisions/provider-architecture-realignment.md), [`.agents/decisions/npm-package-split-and-channel-targets.md`](.agents/decisions/npm-package-split-and-channel-targets.md) |
| Issue #110 closure boundary | [`.agents/decisions/issue-110-epic-closure.md`](.agents/decisions/issue-110-epic-closure.md) |
| Architecture, decisions, knowledge-delta protocol | [`.agents/root.md`](.agents/root.md) |
| Historical proposals | [`.agents/archive/README.md`](.agents/archive/README.md) |
| Always-loaded agent operating rules | [`CLAUDE.md`](CLAUDE.md) (`AGENTS.md` is a symlink) |

## Repo Layout

```text
/
├── packages/
│   ├── dreamux/                 @excitedjs/dreamux host server
│   ├── dreamux-types/           declaration-only provider contracts
│   ├── dreamux-utils/           shared runtime utilities
│   ├── agent-runtime/
│   │   ├── codex/               builtin:codex runtime package
│   │   └── claude-code/         builtin:claude-code runtime package
│   ├── channel/
│   │   ├── feishu-transport/    platform I/O core
│   │   └── feishu-channel/      builtin:feishu channel package
│   └── eslint-config/           private shared lint config
├── bin/                         thin forwarders to packages/dreamux/bin/
├── rush.json                    Rush + pnpm + Node version pins
├── common/                      Rush config and bootstrap
├── .agents/                     on-demand knowledge base
├── .github/workflows/           CI
├── CLAUDE.md                    always-loaded operating rules
└── AGENTS.md                    symlink to CLAUDE.md
```

## Quick Start

The monorepo path is the single supported install path (workspace packages use
`workspace:*`, which per-package `npm install` cannot resolve):

```bash
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js test
./packages/dreamux/bin/dreamux serve
```

Full quick start, config reference, and verification paths are in
[`packages/dreamux/README.md`](packages/dreamux/README.md).

Repo-root `bin/dreamux` is a thin source-checkout shim that forwards to
`packages/dreamux/bin/dreamux`.

## License

MIT — see [`LICENSE`](LICENSE).
