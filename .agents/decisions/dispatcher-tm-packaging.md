# Dispatcher tm packaging

- **Status:** Accepted
- **Date:** 2026-06-03
- **Affects:** `@excitedjs/dreamux` package dependencies, package bins, dispatcher Codex environment, dispatcher skill installation
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

`dreamux onboard` installs the bundled dispatcher skill into each dispatcher's
workspace-local Codex skill directory:

```text
<dispatcher cwd>/.codex/skills/dispatcher/SKILL.md
```

This is intentionally not `~/.codex/skills/...`. The dispatcher skill is tied
to the dispatcher workspace and command environment, while Codex auth, memory,
and user configuration still follow Codex's normal global home.

The bundled source directory, installed directory, and skill frontmatter name
must all use `dispatcher`. Older package-specific source-directory names must
be renamed away before this design is implemented.

`dreamux uninstall` does not delete this workspace-local skill by default. It
removes dreamux-owned config, state, logs, and service integration, then reports
the workspace skill paths created by `onboard` so the operator can remove them
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
- Onboard must write the dispatcher skill once per dispatcher cwd. A machine
  with multiple dispatchers may have multiple workspace-local installed copies.
- Removing or recreating a dispatcher workspace can remove its installed skill;
  rerun `dreamux onboard` for that dispatcher to restore it.
- dreamux must not silently mutate the operator's global `~/.codex/skills/`
  for this dispatcher skill.
- Uninstall is intentionally asymmetric for workspace files: onboarding writes
  the dispatcher skill into the operator's workspace, while uninstall only
  reports that path.

## Current source status

At the time of this decision, the branch already contains:

- `@excitedjs/tm` as a `@excitedjs/dreamux` dependency.
- `/packages/dreamux/bin/tm`.
- dispatcher app-server `PATH` injection for the dreamux package bin directory.
- `dreamux onboard` installs the bundled dispatcher skill to
  `<dispatcher cwd>/.codex/skills/dispatcher/`.
- The bundled skill source directory and frontmatter name are `dispatcher`.

## Alternatives considered

- **Use `npx` or `npm exec` from the skill:** rejected. The model should not
  assemble package-manager commands for a runtime dependency owned by dreamux.
- **Install the dispatcher skill globally under `~/.codex/skills`:** rejected.
  The skill is dispatcher-workspace behavior and should not mutate the
  operator's global Codex skill set.
- **Make dreamux server own tm teammate state:** rejected by
  [dispatcher-tm-boundary](dispatcher-tm-boundary.md). dreamux starts the
  dispatcher; tm owns teammate lifecycle behind its CLI boundary.
