# Component: dispatcher skill

`/packages/dreamux/skills/dispatcher/SKILL.md` is the bundled Codex
skill that teaches dispatcher app-server sessions how to delegate product work
through `tm`.

It is not installed through Codex plugin marketplaces. `dreamux onboard` copies
the bundled skill into each dispatcher's workspace-local Codex skill directory:

```text
<dispatcher cwd>/.codex/skills/dispatcher/SKILL.md
```

Dispatcher app-server processes do not set `CODEX_HOME`; they use Codex's
global default home for auth, config, and memory. The dispatcher skill is
workspace-local because it belongs to that dispatcher's command environment.
See [the dispatcher tm packaging decision](../decisions/dispatcher-tm-packaging.md).

## Files

| Path | Role |
|---|---|
| `/packages/dreamux/skills/dispatcher/SKILL.md` | Bundled dispatcher skill shipped in the npm package |
| `<dispatcher cwd>/.codex/skills/dispatcher/SKILL.md` | Installed copy written by `dreamux onboard` for one dispatcher |
| `/packages/dreamux/bin/tm` | Public wrapper that forwards to the package-local `@excitedjs/tm` executable |

## Runtime Boundary

The skill keeps the boundary from
[the dispatcher tm decision](../decisions/dispatcher-tm-boundary.md):

- dreamux server hosts dispatcher Codex app-server processes only
- the dispatcher invokes `tm` through the command boundary
- dreamux does not own teammate daemons, teammate DB state, or `teammate.*`
  admin methods

## tm Strategy

`@excitedjs/tm` is a direct dependency of `@excitedjs/dreamux`, and the package
exports a `tm` bin wrapper. `dreamux serve` prepends the dreamux package bin
directory to dispatcher app-server `PATH`, so the dispatcher skill must invoke
bare `tm`.

Do not reintroduce `npx`, `npm exec`, plugin marketplace installation, or
`@excitedjs/tm@latest` in the dispatcher skill. The installed package version is
the compatibility boundary.
