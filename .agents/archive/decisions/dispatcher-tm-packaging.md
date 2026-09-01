# Dispatcher tm packaging

> **Archived 2026-09-01** (decisions tree dissolved into task records). Superseded by MCP-only workflow skills and removal of the tm package surface.

- **Status:** Superseded by MCP-only workflow skills and removal of the `tm`
  package surface
- **Date:** 2026-06-03
- **Affects:** `@excitedjs/dreamux` package dependencies, package bins, dispatcher Codex environment, bundled skill installation
- **PR / Issue:** Local architecture clarification on 2026-06-03; supersedes the `npx @excitedjs/tm` dispatcher-skill command shape and the global dispatcher-skill install path

> **Current status:** this decision is historical. Dreamux now uses the
> server-hosted TeamMate and Team MCP surfaces as the only Dreamux-owned
> orchestration boundary. `@excitedjs/dreamux` no longer exposes a `tm` bin and
> no longer depends on `@excitedjs/tm`; bundled skills must not instruct models
> to use `tm`.

## Historical context

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

## Historical decision

Historically, `@excitedjs/tm` was a direct runtime dependency of
`@excitedjs/dreamux`.

`@excitedjs/dreamux` exposed a package bin named `tm` that forwarded to the
package-local `@excitedjs/tm` executable. The wrapper resolved through symlinks
like the `dreamux` launcher so it worked in global installs, npm-link setups,
and source checkouts.

When `dreamux serve` started a dispatcher Codex app-server, it prepended the
dreamux package `bin/` directory to that child process `PATH`. The historical
dispatcher skill invoked bare `tm`, not `npx`, `npm exec`, or a
version-qualified package command.

Dreamux shipped a small set of bundled Codex skills in the npm package:
`dispatcher`, `team-dev-workflow`, and `dreamux-maintenance`.

> **Superseded by issue #209 slice 6 (role-gated skill injection).** The
> workspace-symlink install described below is retired. Core now injects the
> bundled skills at runtime by role through the Agent Runtime create context's
> `skillSources` — Dispatcher and TeamLeader only — and the runtime applies them
> to its engine (Codex `skills/extraRoots/set`, Claude Code `--add-dir`).
> `dreamux onboard` and dispatcher startup no longer write
> `<dispatcher cwd>/.codex/skills`; pre-existing workspace symlinks are outside
> Dreamux-owned state and are not tracked or reported. See
> [npm-package-split-and-channel-targets.md](/.agents/tasks/architecture/npm-package-split/requirement.md#npm-package-split-and-channel-targets).

Historical model (pre-slice-6): `dreamux onboard` and dispatcher startup
installed these bundled skills into each dispatcher's workspace-local Codex skill
directory as symlinks:

```text
<dispatcher cwd>/.codex/skills/<skill-name> -> <dreamux package>/skills/<skill-name>
```

This was intentionally not `~/.codex/skills/...`. The dispatcher skill is tied
to the dispatcher workspace and command environment, and the workflow /
maintenance skills should appear only in that same dispatcher context. Codex
auth, memory, and user configuration still follow Codex's normal global home.

The bundled source directory, installed directory, and skill frontmatter name
must match for each shipped skill. Older package-specific source-directory names
must be renamed away before this design is implemented.

Historical behavior: `dreamux uninstall` did not delete these workspace-local
skills by default; it reported the workspace skill paths that Dreamux created so
the operator could remove them manually when desired. Current Dreamux no longer
creates, tracks, or reports workspace-local skill symlinks.

## Historical consequences

- The published dreamux package had two bins:
  - `dreamux` for the public operator CLI.
  - `tm` for dispatcher runtime delegation.
- `tm` was a packaging/runtime surface, not a new dreamux admin command tree.
- The dreamux package owned the tm compatibility version. Updating tm required a
  normal package dependency update and release note.
- Dispatcher prompts and skills stayed short by using `tm spawn`, `tm send`, and
  `tm wait`.
- Onboard and dispatcher startup installed bundled skills once per dispatcher cwd.
  A machine with multiple dispatchers may have multiple workspace-local
  symlink sets.
- Correct symlinks were left unchanged. Stale or broken symlinks were replaced.
  Real user files or directories were not overwritten; startup logged a
  diagnostic and onboard reported the path as `skipped`. This included an old
  hand-copied `dispatcher` directory — Dreamux no longer fingerprinted and
  migrated it (issue #98); the operator removed or renamed it to let startup
  recreate the bundled symlink.
- Custom symlinks at bundled skill paths were treated as Dreamux-managed links
  and could be replaced. Operators who intentionally opted out used a real file
  or directory at that skill path.
- A missing `.codex/skills` directory was created, but a missing dispatcher cwd
  was a startup error.
- Unsupported symlink platforms or permission failures failed loudly; Dreamux did
  not copy bundled skills as a fallback.
- Removing or recreating a dispatcher workspace could remove its installed skill
  symlinks; rerun `dreamux onboard` or restart the dispatcher to restore them.
- dreamux did not silently mutate the operator's global `~/.codex/skills/`
  for these dispatcher-scoped skills.
- Uninstall was intentionally asymmetric for workspace files: onboarding wrote
  symlinks into the operator's workspace, while uninstall only reported those
  paths.

## Historical source status

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
- **Make dreamux server own tm teammate state:** historically rejected by
  [dispatcher-tm-boundary](/.agents/archive/decisions/dispatcher-tm-boundary.md) at this record's date.
  Issue #110 supersedes that boundary for the new server-hosted TeamMate
  architecture; see [server-hosted-teammate](/.agents/archive/decisions/server-hosted-teammate.md).
