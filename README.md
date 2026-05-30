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
| Architecture, decisions, knowledge-delta protocol | [`.agents/root.md`](.agents/root.md) |
| Always-loaded agent operating rules | [`CLAUDE.md`](CLAUDE.md) (`AGENTS.md` is a symlink) |
| Monorepo layout reference | [`.agents/components/repo-structure.md`](.agents/components/repo-structure.md) |
| Why Rush + pnpm | [`.agents/decisions/0001-rush-pnpm-monorepo.md`](.agents/decisions/0001-rush-pnpm-monorepo.md) |
| Why `@excitedjs/dreamux` + `dreamux` CLI + the two legacy aliases | [`.agents/decisions/0002-cli-and-package-naming.md`](.agents/decisions/0002-cli-and-package-naming.md) |

## Repo layout

```
/
├── packages/
│   └── dreamux/           @excitedjs/dreamux — the only package today
├── bin/                   thin forwarders → packages/dreamux/bin/
├── rush.json              rush + pnpm + Node version pins
├── common/
│   ├── config/rush/       command-line.json, .npmrc, version-policies.json
│   └── scripts/install-run-rush.js   minimal rush bootstrap
├── .agents/               on-demand knowledge base
├── .github/workflows/     CI: package typecheck/build/test, KB check, rush smoke
├── CLAUDE.md              always-loaded operating rules
└── AGENTS.md              symlink → CLAUDE.md
```

## Quick start

Two install paths are supported and both work; CI exercises both.

**Per-package** (matches pre-monorepo muscle memory):

```bash
cd packages/dreamux
npm install
npm test
./bin/dreamux server start
```

**Monorepo** (required once a second package exists):

```bash
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js test
```

Full quick start, config reference, and MVP verification path are in the
package README:
[`packages/dreamux/README.md`](packages/dreamux/README.md).

Repo-root `bin/{dreamux,server,server-ctl}` are thin shims that forward
to `packages/dreamux/bin/` so pre-monorepo PATH entries keep working.

## License

MIT — see [`LICENSE`](LICENSE).
