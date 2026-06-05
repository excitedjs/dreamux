---
name: dispatcher
description: Use from a Dreamux dispatcher thread when bounded repository work should be delegated to a tm-managed Codex teammate. Applies to spawning, sending, waiting, checking status, resuming, or summarizing teammate work through the tm CLI exposed by the Dreamux package.
---

# Dispatcher

Use this skill only from a Dreamux dispatcher session. Dreamux hosts the
dispatcher Codex app-server and exposes `tm` on the dispatcher `PATH`; `tm`
owns teammate lifecycle, history, and repository worktrees.

## Boundaries

- Use `tm` from the dispatcher environment `PATH`. Dreamux injects its package
  `bin/` directory into the dispatcher Codex app-server PATH.
- Pass `--engine codex` on every `tm spawn`; do not rely on version-specific
  defaults.
- Do not use `npx`, `npm exec --package @excitedjs/tm`, or a version-qualified
  `@excitedjs/tm`; the Dreamux package owns the compatible tm version.
- Do not call dreamux admin APIs to create teammate state.
- Do not infer the target repository from the dispatcher cwd unless the user or
  operator explicitly made that cwd the requested repo.
- Do not ask a tm-managed teammate to spawn another tm teammate.

## Before Delegating

Delegate when the request is bounded and can be completed by one teammate:
running tests, inspecting a code path, drafting a narrow patch, or collecting a
specific result. Handle the work directly when the request is tiny, ambiguous,
security-sensitive, or missing a repository path.

Resolve the repo path in this order:

1. An absolute path in the user request.
2. An explicit dispatcher environment variable set by the operator.
3. Ask the user for the repo path.

Use an absolute repo path for `tm spawn`. If the user gives a relative path,
make it absolute only when its base is explicit.

## Command Shape

Preflight once per dispatcher session and trust live help for flags:

```bash
tm --help
```

## First-Turn Delegation

1. Pick a flat teammate name: lowercase letters, digits, and hyphens; keep it
   short and tied to the task, such as `tests-api` or `scan-auth`.
2. Spawn with the repo path, Codex engine, intent, timeout, and full task
   prompt:

```bash
tm spawn /absolute/repo \
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
tm wait tests-api --timeout 180
```

4. Reply to the source chat with the teammate result, including the command
   summary and any explicit failure.

## Follow-Up Delegation

If a teammate name already exists for the same task, send a follow-up instead
of spawning a duplicate:

```bash
tm send tests-api \
  --prompt "Use the previous context. Re-run the focused test after the latest fix and summarize only changed results."
tm wait tests-api --timeout 180
```

## Status And Readback

- Use `tm status <name>` when a teammate appears stuck.
- Use `tm wait <name> --timeout <seconds>` to collect the next completed reply.
- Use `tm last <name>` or `tm history` when recovering a prior result.
- Report the command outcome, the teammate name, the repository path, and any
  explicit failure. Do not invent a result that was not returned by `tm`.

## Failure Reporting

When a tm command fails, stop the delegation sequence and report:

- which `tm` verb failed
- the teammate name and repo path
- the exit status if available
- the first useful stderr/stdout lines
- whether retrying the same teammate is safe

Known early startup failure to report verbatim:

```text
codex daemon (pid N) exited before binding <socket path>
```

That means the Codex app-server daemon did not become reachable. Do not retry
silently; report the environment failure and ask the operator to run Dreamux
diagnostics in the dispatcher environment.

Do not say the Dreamux server lost or recovered teammate state. The server does
not own that state.
