# Dispatcher tm packaging

- **Status:** Accepted
- **Date:** 2026-06-03
- **Affects:** `@excitedjs/dreamux` package dependencies, package bins, dispatcher Codex environment, bundled skill installation
- **PR / Issue:** Local architecture clarification on 2026-06-03; supersedes the `npx @excitedjs/tm` dispatcher-skill command shape and the global dispatcher-skill install path

## Context

The dispatcher skill needs to delegate bounded work to tm-managed Codex
teammates. The earlier long-form command shape made the model construct
fragile commands such as `npx` / `npm exec --package @excitedjs/tm ...`.
That is the wrong boundary:

- it makes every model call remember package-manager syntax
- it can drift to an unintended tm version
- it adds network/package-manager failure modes to every delegation
- it makes the skill text longer and easier for the model to misuse

The dreamux package already owns the dispatcher runtime and can own the tm
version used by that runtime.

## Decision

`@excitedjs/tm` is a direct runtime dependency of `@excitedjs/dreamux`.

`@excitedjs/dreamux` exposes a package bin named `tm` that forwards to the
package-local `@excitedjs/tm` executable. The wrapper must resolve through
symlinks like the `dreamux` launcher so it works in global installs, npm-link
setups, and source checkouts.

When `dreamux serve` starts a dispatcher Codex app-server, it prepends the
dreamux package `bin/` directory to that child process `PATH`. The dispatcher
skill must invoke bare `tm`, never `npx`, `npm exec`, or a version-qualified
package command.

Dreamux ships a small set of bundled Codex skills in the npm package:
`dispatcher`, `team-dev-workflow`, and `dreamux-maintenance`.

`dreamux onboard` and dispatcher startup install these bundled skills into each
dispatcher's workspace-local Codex skill directory as symlinks:

```text
<dispatcher cwd>/.codex/skills/<skill-name> -> <dreamux package>/skills/<skill-name>
```

This is intentionally not `~/.codex/skills/...`. The dispatcher skill is tied
to the dispatcher workspace and command environment, and the workflow /
maintenance skills should appear only in that same dispatcher context. Codex
auth, memory, and user configuration still follow Codex's normal global home.

The bundled source directory, installed directory, and skill frontmatter name
must match for each shipped skill. Older package-specific source-directory names
must be renamed away before this design is implemented.

`dreamux uninstall` does not delete these workspace-local skills by default. It
removes dreamux-owned config, state, logs, and service integration, then reports
the workspace skill paths created by Dreamux so the operator can remove them
manually when desired. This avoids deleting files under arbitrary operator
workspaces during a global uninstall.

## Consequences

- The published dreamux package has two bins:
  - `dreamux` for the public operator CLI.
  - `tm` for dispatcher runtime delegation.
- `tm` is a packaging/runtime surface, not a new dreamux admin command tree.
- The dreamux package owns the tm compatibility version. Updating tm requires a
  normal package dependency update and release note.
- Dispatcher prompts and skills stay short: use `tm spawn`, `tm send`, and
  `tm wait`.
- Onboard and dispatcher startup install bundled skills once per dispatcher cwd.
  A machine with multiple dispatchers may have multiple workspace-local
  symlink sets.
- Correct symlinks are left unchanged. Stale or broken symlinks are replaced.
  Real user files or directories are not overwritten; startup logs a diagnostic
  and onboard reports the path as `skipped`. This includes an old hand-copied
  `dispatcher` directory — Dreamux no longer fingerprints and migrates it
  (issue #98); the operator removes or renames it to let startup recreate the
  bundled symlink.
- Custom symlinks at bundled skill paths are treated as Dreamux-managed links
  and may be replaced. Operators who intentionally opt out should use a real
  file or directory at that skill path.
- A missing `.codex/skills` directory is created, but a missing dispatcher cwd
  is a startup error.
- Unsupported symlink platforms or permission failures fail loudly; Dreamux does
  not copy bundled skills as a fallback.
- Removing or recreating a dispatcher workspace can remove its installed skill
  symlinks; rerun `dreamux onboard` or restart the dispatcher to restore them.
- dreamux must not silently mutate the operator's global `~/.codex/skills/`
  for these dispatcher-scoped skills.
- Uninstall is intentionally asymmetric for workspace files: onboarding writes
  symlinks into the operator's workspace, while uninstall only reports those
  paths.

## Current source status

At the time of this decision, the branch already contains:

- `@excitedjs/tm` as a `@excitedjs/dreamux` dependency.
- `/packages/dreamux/bin/tm`.
- dispatcher app-server `PATH` injection for the dreamux package bin directory.
- `dreamux onboard` and dispatcher startup install bundled skill symlinks to
  `<dispatcher cwd>/.codex/skills/<skill-name>`.
- The bundled skill source directories and frontmatter names match their public
  skill names.

## Alternatives considered

- **Use `npx` or `npm exec` from the skill:** rejected. The model should not
  assemble package-manager commands for a runtime dependency owned by dreamux.
- **Install the dispatcher skill globally under `~/.codex/skills`:** rejected.
  The skill is dispatcher-workspace behavior and should not mutate the
  operator's global Codex skill set.
- **Make dreamux server own tm teammate state:** rejected by
  [dispatcher-tm-boundary](dispatcher-tm-boundary.md). dreamux starts the
  dispatcher; tm owns teammate lifecycle behind its CLI boundary.
