---
name: dispatcher
description: Use from a Dreamux dispatcher thread when bounded repository work should be delegated to a tm-managed teammate. Applies to spawning, sending, waiting, checking status, resuming, recovering, or summarizing teammate work through the tm CLI exposed by the Dreamux package.
---

# Dispatcher

Use this skill only from a Dreamux dispatcher session. Dreamux hosts the
dispatcher Codex app-server and exposes `tm` on the dispatcher `PATH`. `tm`
owns teammate lifecycle, history, and repository worktrees; Dreamux does not.

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
- Do not call dreamux admin APIs to create or recover teammate state. The
  server hosts the dispatcher; tm owns teammates.
- Do not infer the target repository from the dispatcher cwd unless the user or
  operator explicitly made that cwd the requested repo.
- Do not ask a tm-managed teammate to spawn another tm teammate.

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

Read the matching reference before reaching for the verb:

| Intent | Reference |
|---|---|
| Spawn a teammate, compose its prompt, send follow-up, collect the result | `references/dispatch-task.md` |
| Look up, re-read, or resume a prior or dead teammate session | `references/inspect-and-resume.md` |

For multi-teammate review, design negotiation, merge, or unblock coordination,
use the `team-dev-workflow` skill, which layers methodology on top of this one.

## Verified Reports

A reply to the source chat that asserts an outcome must be verifiable from this
turn's tool calls.

- Report only what `tm` returned. Do not invent a teammate result that was not
  printed by a `tm` verb.
- Verify any command, flag, or path before naming it; if you cannot verify it
  this turn, say so rather than guessing a name.
- Translate dispatcher-internal identifiers into plain language before the
  message goes out. Issue and PR numbers the user can look up are shared
  vocabulary; ad-hoc internal labels are not.
- For public target repos, forbid internal domains, tokens, private
  identifiers, and machine-local paths in commits, PRs/MRs, and comments in the
  teammate brief.

## State Boundary

Do not say the Dreamux server lost or recovered teammate state. The server does
not own that state. Teammate liveness, history, and recovery flow through `tm`
(see `references/inspect-and-resume.md`).
