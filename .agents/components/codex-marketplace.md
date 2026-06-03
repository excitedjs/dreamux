# Component: codex marketplace

`/codex-marketplace/` is a local Codex marketplace root for the codex-native
codexmux product layer. It is not a Rush package and does not add runtime code
to `@excitedjs/dreamux`.

`dreamux onboard` installs Codexmux into each dispatcher-private `CODEX_HOME`
from the public Git repository by default with:

```bash
codex plugin marketplace add excitedjs/dreamux --sparse .agents/plugins --sparse codex-marketplace/plugins/codexmux
codex plugin add codexmux@dreamux
```

For Git marketplace sources, Codex treats the checked-out repository root as
the marketplace root. The repository therefore also carries
`/.agents/plugins/marketplace.json`, whose plugin entry points at
`./codex-marketplace/plugins/codexmux`. Local source checkouts may override the
marketplace source to `./codex-marketplace`; that local root keeps its own
`/codex-marketplace/.agents/plugins/marketplace.json` with paths relative to
`/codex-marketplace/`.

## Files

| Path | Role |
|---|---|
| `/.agents/plugins/marketplace.json` | Git marketplace metadata named `dreamux`; entries point at `./codex-marketplace/plugins/<name>` relative to the repository root |
| `/codex-marketplace/.agents/plugins/marketplace.json` | Marketplace metadata named `dreamux`; entries point at `./plugins/<name>` relative to `/codex-marketplace/` |
| `/codex-marketplace/plugins/codexmux/.codex-plugin/plugin.json` | Codex plugin manifest |
| `/codex-marketplace/plugins/codexmux/skills/codexmux-dispatcher/SKILL.md` | Dispatcher skill for pinned `tm` delegation |
| `/codex-marketplace/README.md` | Local install, prewarm, and demonstration flow |

## Runtime Boundary

The plugin keeps the boundary from
[the dispatcher tm decision](../decisions/dispatcher-tm-boundary.md):

- dreamux server hosts dispatcher Codex app-server processes only
- the dispatcher invokes `tm` through the command boundary
- dreamux does not own teammate daemons, teammate DB state, or `teammate.*`
  admin methods

## tm Strategy

The first product slice pins `@excitedjs/tm@2.1.2` in the dispatcher skill,
requires `tm spawn --engine codex`, and prewarms it with:

```bash
npm exec --yes --package @excitedjs/tm@2.1.2 -- tm --help
```

Do not replace this with bare `@excitedjs/tm@latest`. Do not use
`tm wait --fresh` for Codex teammates; `--fresh` is Claude-only in tm 2.1.2. A
self-contained tm artifact can be added later after the thin dispatcher ->
skill -> tm path is validated end to end.
