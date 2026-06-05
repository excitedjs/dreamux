# Component: dispatcher skill

`/packages/dreamux/skills/` contains the bundled Codex skills that Dreamux
ships in the npm package:

- `dispatcher` teaches dispatcher app-server sessions how to delegate product
  work through `tm`.
- `team-dev-workflow` covers multi-teammate review, design, merge, and unblock
  coordination.
- `dreamux-maintenance` covers installed Dreamux diagnosis and safe operation.

They are not installed through Codex plugin marketplaces. `dreamux onboard` and
dispatcher startup symlink the bundled skill directories into each dispatcher's
workspace-local Codex skill directory:

```text
<dispatcher cwd>/.codex/skills/<skill-name> -> <dreamux package>/skills/<skill-name>
```

Dispatcher app-server processes do not set `CODEX_HOME`; they use Codex's
global default home for auth, config, and memory. The bundled skills are
workspace-local because they belong to that dispatcher's command environment.
See [the dispatcher tm packaging decision](../decisions/dispatcher-tm-packaging.md).

## Files

| Path | Role |
|---|---|
| `/packages/dreamux/skills/<skill-name>/` | Bundled skill directory shipped in the npm package |
| `<dispatcher cwd>/.codex/skills/<skill-name>` | Workspace-local symlink installed for one dispatcher |
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
directory to dispatcher app-server `PATH`, so the dispatcher skills must invoke
bare `tm`.

Do not reintroduce `npx`, `npm exec`, plugin marketplace installation, or
`@excitedjs/tm@latest` in the dispatcher skill. The installed package version is
the compatibility boundary.

## Symlink Strategy

The runtime installer is intentionally symlink-only:

- correct symlinks are left unchanged
- stale or broken symlinks are replaced
- a legacy copied `dispatcher` directory whose `SKILL.md` exactly matches a
  known Dreamux-managed fingerprint is migrated to a symlink
- real user files/directories are not overwritten; startup logs a diagnostic
  and onboard reports the path as `skipped`
- custom symlinks in these bundled skill slots are treated as replaceable
  Dreamux-managed links; use a real file or directory to opt out
- missing `.codex/skills` directories are created
- a missing dispatcher cwd is a startup error because it likely means the
  configured dispatcher path is wrong
- unsupported symlink platforms or permission errors fail loudly instead of
  copying bundled content
