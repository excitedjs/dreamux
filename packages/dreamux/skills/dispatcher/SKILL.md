---
name: dispatcher
description: Use from a Dreamux dispatcher thread when bounded repository work should be delegated to a TeamMate. The server-hosted TeamMate MCP is the default interface — run_task and execute_task execute a worker for real, list_tasks/get_task/pull_result/await_completion read and wait without polling, and cancel_task/get_task_logs/get_capabilities control and inspect it. The tm CLI is the explicit fallback for resume, multi-turn continuation, dead-session recovery, and isolated worktrees. Applies to scheduling, running, tracking, retrieving, sending, waiting, cancelling, inspecting, resuming, recovering, or summarizing teammate work.
---

# Dispatcher

Use this skill only from a Dreamux dispatcher session. The dispatcher delegates
bounded repository work to TeamMates and reports verified results back to the
source chat.

## TeamMate Interface

Reach a TeamMate through the server-hosted TeamMate MCP by default. Drop to the
`tm` CLI only for what the MCP does not yet cover. Pick by what you need, not by
habit.

### Server-hosted TeamMate MCP — the primary interface

Dreamux injects a dispatcher-scoped `teammate` MCP server. It executes
repository work for real and lets you run, watch, collect, and control a worker
without holding a shell session or polling a process.

**Run.**

- `run_task` — create a task and start a worker against a confined local target
  in one call. The default `builtin:codex` worker runs the turn to completion;
  pin `builtin:claude-code` via `provider_ref` for a single-turn, `steer:false`
  worker. The worker runs in place at the target path.
- `execute_task` — start or retry execution for an already-accepted task.
- `schedule` — record an accepted task id in the ledger *without* executing it.
  Use it to register work you will run later, not to run a task now.
- `send_input` — fold a follow-up into a live `builtin:codex` turn (`steer`).
  This is steering, not multi-turn continuation: on a single-turn worker or a
  task with no live session the input is recorded as queued, not re-executed.

**Watch and collect — no polling.**

- `list_tasks` — this dispatcher's tasks and their statuses.
- `get_task` — one task in full: result, history, and delivery state.
- `pull_result` — a retained or latest result; the fallback when push delivery
  failed.
- `await_completion` — a bounded, server-side wait for a terminal state. On
  timeout it returns a `still_running` snapshot to resume with `after_event_id`,
  not an error. Together these serve status / history / last / poll directly,
  so you do not need `tm` to check on a running task.

**Control and inspect.**

- `cancel_task` — stop a live worker, close a not-yet-running or orphaned task,
  or no-op idempotently on an already-terminal task.
- `get_task_logs` — a bounded tail of a worker's diagnostic logs (worker
  stderr, plus `builtin:codex` app-server stdout protocol frames) for a slow or
  failed worker. This is diagnostics, not the clean result — that still comes
  from `get_task` / `pull_result` / `await_completion`.
- `get_capabilities` — each worker's advertised execution modes.

The persistent ledger is the source of truth. A completion delivered into the
dispatcher is a best-effort wake-up, not the result contract — confirm and
re-read with `get_task` / `pull_result` (or `await_completion`) rather than
trusting that a pushed notification arrived.

### tm CLI — the explicit fallback

Dreamux hosts the dispatcher Codex app-server and exposes `tm` on the dispatcher
`PATH`. `tm` owns live tm **session** state: teammate liveness, repository
worktrees, and resumable session history. Reach for it only for what the MCP
does not yet cover — resuming or recovering a dead session, multi-turn
continuation, and isolated managed worktrees — and for legacy diagnostics. It is
not the default orchestration path. The rest of this skill and its references
are the operational manual for that fallback.

## Router Posture

The dispatcher routes repository work to a teammate that lives in the target
repo. It does not investigate that repo itself.

- Hand the teammate the symptom and any concrete evidence, not your diagnosis.
  Skip `grep`, file reads, and `git -C <repo>` probes done "to understand the
  bug first". The teammate has the repo's own context and conventions;
  pre-investigation burns dispatcher context and anchors the teammate to a
  conclusion you drew before delegating.
- Treat the user's framing adversarially. A request like "find which commit
  broke X" embeds claims ("X is broken", "it is a regression") that may be
  false. Pass such claims into the teammate brief as things to verify, not as
  settled premises.
- Keep repo-local instructions, git state, and tool output inside the teammate
  context instead of mixing them into the dispatcher thread.

## Boundaries

These govern the tm fallback path. For the primary MCP path, call the injected
`teammate` MCP tools directly.

- Invoke bare `tm` from the dispatcher environment `PATH`. Dreamux injects its
  package `bin/` directory into the dispatcher app-server PATH.
- Do not use `npx`, `npm exec --package @excitedjs/tm`, or a version-qualified
  `@excitedjs/tm`; the Dreamux package owns the compatible tm version.
- Choose the teammate engine deliberately. `tm spawn` takes `--engine`; the
  engines it supports are listed in `tm spawn --help`. Pick by task shape and
  by what the dispatcher environment actually provides -- a persistent,
  resumable Codex daemon suits ongoing repo work; an engine whose CLI is not
  installed or authenticated in this environment is not a usable choice. State
  `--engine` explicitly so the selection is intentional rather than inherited
  from a tm version default.
- Do not call dreamux admin APIs directly to create or recover teammate state.
  Reach server-owned TeamMate task state only through the `teammate` MCP tools;
  reach live tm sessions only through `tm`.
- Do not infer the target repository from the dispatcher cwd unless the user or
  operator explicitly made that cwd the requested repo.
- Do not ask a TeamMate to schedule or spawn another TeamMate.

## When To Delegate

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

## Command Contract

`tm --help` is the top-level synopsis. `tm <verb> --help` owns each verb's
flags, accepted arguments, exit codes, and exact stdout/stderr contract. This
skill and its references own operational semantics and scenario selection; the
live help owns the executable contract. Read the verb's own help before relying
on a flag -- do not infer one verb's flags from another.

## Scenario Routing

These references cover the `tm` fallback path. For ordinary delegation —
running a task, watching it, collecting the result, cancelling it, or reading
its logs — use the `teammate` MCP tools above and you do not need a reference.
Read the matching reference when you have dropped to `tm`:

| Intent | Reference |
|---|---|
| Spawn a teammate, compose its prompt, send follow-up, collect the result | `references/dispatch-task.md` |
| Look up, re-read, or resume a prior or dead teammate session | `references/inspect-and-resume.md` |

For multi-teammate review, design negotiation, merge, or unblock coordination,
use the `team-dev-workflow` skill, which layers methodology on top of this one.

## Verified Reports

A reply to the source chat that asserts an outcome must be verifiable from this
turn's tool calls.

- Report only what the TeamMate interface returned, whether a `teammate` MCP
  tool result or a `tm` verb. Do not invent a teammate result that was not
  produced by one of them.
- Verify any command, flag, or path before naming it; if you cannot verify it
  this turn, say so rather than guessing a name.
- Translate dispatcher-internal identifiers into plain language before the
  message goes out. Issue and PR numbers the user can look up are shared
  vocabulary; ad-hoc internal labels are not.
- For public target repos, forbid internal domains, tokens, private
  identifiers, and machine-local paths in commits, PRs/MRs, and comments in the
  teammate brief.

## State Boundary

Two state owners, kept distinct:

- The Dreamux server owns the TeamMate **task ledger** behind the `teammate`
  MCP — task records, statuses, retained results, and delivery state. Read,
  wait on, and control it with `list_tasks`, `get_task`, `pull_result`,
  `await_completion`, `cancel_task`, and `get_task_logs`.
- `tm` owns live tm **session** state — teammate liveness, worktrees, and
  resumable session history (see `references/inspect-and-resume.md`).

Do not conflate the two. Recovering a tm session is not the same as reading a
server task record, and the server does not own tm session liveness.
