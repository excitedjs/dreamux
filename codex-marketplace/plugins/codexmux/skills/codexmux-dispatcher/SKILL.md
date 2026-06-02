---
name: codexmux-dispatcher
description: Use from a dreamux dispatcher thread when work should be delegated to a tm-managed Codex teammate in a specific repository. Applies to bounded engineering tasks, test runs, codebase inspections, or follow-up work where the dispatcher should spawn/send/wait through the pinned @excitedjs/tm CLI and report the result back to the source chat.
---

# Codexmux Dispatcher

Use this skill only from the dispatcher agent. The dreamux server hosts the
dispatcher lifecycle; it does not own tm teammate daemons, teammate DB rows, or
`teammate.*` admin methods.

## Boundaries

- Use `tm` through the pinned package: `@excitedjs/tm@2.1.2`.
- Pass `--engine codex` on every `tm spawn`; `tm spawn` defaults to Claude.
- Do not use bare `npx -y @excitedjs/tm` or `@excitedjs/tm@latest`.
- Do not call dreamux admin APIs to create teammate state.
- Do not infer a repo from the dispatcher cwd. A dispatcher cwd is server-owned
  runtime space, not a worktree.
- Do not ask a tm-managed teammate to spawn another tm teammate.

## Before Delegating

Delegate when the request is bounded and can be completed by one teammate:
running tests, inspecting a code path, drafting a narrow patch, or collecting a
specific result. Handle the work directly when the request is tiny, ambiguous,
security-sensitive, or missing a repository path.

Resolve the repo path in this order:

1. An absolute path in the user request.
2. `TM_DISPATCHER_DIR`, if set by the operator.
3. Ask the user for the repo path. Do not guess.

Use an absolute repo path for `tm spawn`. If the user gives a relative path,
make it absolute only when its base is explicit.

## Command Shape

Use this prefix for every tm command:

```bash
npm exec --yes --package @excitedjs/tm@2.1.2 -- tm
```

Preflight once per dispatcher session or after npm cache cleanup:

```bash
npm exec --yes --package @excitedjs/tm@2.1.2 -- tm --help
```

## First-Turn Delegation

1. Pick a flat teammate name: lowercase letters, digits, and hyphens; keep it
   short and tied to the task, such as `tests-api` or `scan-auth`.
2. Spawn with the repo path, intent, and the full task prompt:

```bash
npm exec --yes --package @excitedjs/tm@2.1.2 -- tm spawn /absolute/repo \
  --name tests-api \
  --engine codex \
  --timeout 180 \
  --intent "Run focused API tests and summarize failures" \
  --prompt "Run the focused API tests. Report commands, failures, and the smallest next fix."
```

3. If `tm spawn` exits `0`, use its printed reply as the teammate result. If it
   exits `124`, the Codex turn did not finish within the sync window; wait
   without `--fresh`:

```bash
npm exec --yes --package @excitedjs/tm@2.1.2 -- tm wait tests-api --timeout 180
```

4. Reply to the source chat with the teammate result, including the command
   summary and any explicit failure.

## Follow-Up Delegation

If a teammate name already exists for the same task, send a follow-up instead
of spawning a duplicate:

```bash
npm exec --yes --package @excitedjs/tm@2.1.2 -- tm send tests-api \
  --prompt "Use the previous context. Re-run the focused test after the latest fix and summarize only changed results."
npm exec --yes --package @excitedjs/tm@2.1.2 -- tm wait tests-api --timeout 180
```

## Failure Reporting

When a tm command fails, stop the delegation sequence and report:

- which `tm` verb failed
- the teammate name and repo path
- the exit status if available
- the first useful stderr/stdout lines
- whether retrying the same teammate is safe

Known early startup failure to report verbatim:

```text
codex daemon (pid N) exited before binding /tmp/teammate-codex/<name>/socket
```

That means the Codex app-server daemon did not become reachable. Do not retry
silently; report the environment failure and ask the operator to verify
`codex app-server --listen unix:///tmp/codexmux-check.sock` in the dispatcher
environment.

Do not say the dreamux server lost or recovered teammate state. The server does
not own that state.
