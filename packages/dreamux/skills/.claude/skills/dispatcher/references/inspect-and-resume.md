# Inspect And Resume

> Default to the `teammate` MCP for inspection: `list`, `status`, `history`,
> and `last` cover server-owned TeamMate state without `tm`; do not poll. `list`
> / `status` / `history` are backed by the per-name records; `last` reads the
> most recent settled turn(s) (turns 1..5) from the per-name turns archive by the
> concrete name `spawn` returned, even for a closed TeamMate. This `tm` fallback
> owns what the MCP does not: legacy tm sessions, worktrees, and tm history.

## Trigger

You need to see what a tm-managed teammate is doing, re-read a tm reply, or
continue a legacy tm session whose process is gone. Skip this when you are
sending fresh work (`dispatch-task.md`).

## Steps

1. For a live snapshot of who is running and what they last said, read the
   fleet state:

```bash
tm states
```

2. To re-read the last settled reply from a still-live teammate:

```bash
tm last <name>
```

3. To look up past or in-flight sessions for recovery, query history. It is
   the tm-owned index that survives kills; default to a bounded field subset
   for broad scans:

```bash
tm history --repo /absolute/repo --fields id,engine,name,state,intent,resumeCommand
tm history --id <full-or-prefix>
```

4. To continue a dead session, prefer the row's `resumeCommand` over rebuilding
   the command by hand. The explicit-id form is the reliable one:

```bash
tm resume --engine <engine> --repo /absolute/repo --id <sid-or-thread-id>
```

Prefer `resumeCommand` or an explicit `--id` whenever you have one -- that is
the unambiguous path. The name form `tm resume <name>` without an id does not
hand the choice to the engine: tm itself probes its live, archived, and history
state for that name and routes the single matching candidate. When more than one
candidate matches, it asks for `--engine claude|codex` to break the tie rather
than guessing. Use the name form only when you lack an id clue, and pass
`--engine` if tm reports an ambiguous match. Read `tm history --help` and
`tm resume --help` for current fields and flags.

## When The User Hands You A Session Id

If the user supplies a session id with a phrase like "this is the X result,
take over", do not infer what "X" means from whatever is loudest in the current
chat. The dispatcher did not witness that session, so its actual content is the
authority. Verify the subject first -- `tm last <name>`, an independent check on
the suspected target (e.g. the PR's own reviews/comments), or one short
clarifying question -- before briefing a downstream teammate.

When you send the first turn to a resumed teammate, ask it to summarize its
existing conclusions rather than asserting the subject yourself. A wrong
subject then surfaces as a push-back, not as invented compliance.

## Closing Work

When a task reaches a terminal state, record queryable close metadata at the
kill boundary so later history scans can find the outcome:

```bash
tm kill <name> --status <merged|done|shelved|abandoned|blocked> --note "<short text>"
```

Confirm the current status values and note semantics in `tm kill --help`. Do
not maintain a manual dispatcher ledger; `tm history` is the query surface and
durable outcomes belong in the issue, PR, or repo artifact the teammate already
worked on.

## Closeout

The recovered teammate is on the intended session, its subject is verified
rather than assumed, and any terminal work carries a queryable close status.
