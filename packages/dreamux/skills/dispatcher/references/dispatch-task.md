# Dispatch A Task

> This is the `tm` fallback path. Default to the `teammate` MCP —
> `spawn` / `send` / `close` (send also reopens a closed TeamMate), then
> inspect with `history` / `last` / `ctx` (see the dispatcher skill; do not
> poll). Use the
> `tm spawn` / `tm send` flow below only when you need an isolated managed
> worktree or legacy tm diagnostics.

## Trigger

You are pushing bounded work into a target repo: bringing up a new teammate
with its first task, or handing follow-up work to one that already owns the
task. Skip this when you only need to recover or re-read a prior session
(`inspect-and-resume.md`).

## Steps

1. Resolve the absolute repo path and the engine. Read `tm spawn --help` for
   the supported engines and current flags; state `--engine` explicitly so the
   choice is intentional.
2. Choose the verb:
   - New teammate plus first task in one call: `tm spawn <path> --prompt "..."`.
   - New teammate, no task yet: `tm spawn <path>`.
   - Existing teammate, new turn: `tm send <name> --prompt "..."`.
   Reuse an existing teammate that already owns this task instead of spawning a
   duplicate.
3. Pick a flat teammate name: lowercase letters, digits, and hyphens, short and
   tied to the task, such as `tests-api` or `scan-auth`. Pass
   `--intent "short subject"` for work worth finding later; tm records it as a
   queryable field in `tm history`.
4. Compose the prompt against the two checklists below before sending.
5. Run the blocking verb and wait for the reply (see "Wait phase").
6. Report the verified result to the source chat (see "Closeout").

```bash
tm spawn /absolute/repo \
  --name tests-api \
  --engine <engine> \
  --intent "Run focused API tests and summarize failures" \
  --prompt "The API suite is reported failing after the latest auth change. Run the focused API tests, report the commands you ran, the failures, and the smallest next fix."
```

## Composing The Prompt

Aim for roughly the length and shape the user would type if they dispatched the
task themselves: a one-line business request plus only the conventions the
teammate cannot infer. The failure mode is either omitting a fact the teammate
cannot derive, or adding noise that anchors and misleads it.

### Include

The pieces a teammate cannot derive from its own checkout:

1. **Intent.** The goal and why it matters, not a step-by-step recipe. The
   teammate plans the steps; a recipe anchors it to your preconception and
   stops it from finding a better path.
2. **Branch and any PR/MR anchor.** Name the branch you expect it to work on,
   stated as an expectation ("work on `feat/foo`"), not a pre-fetched
   observation -- the teammate's own `git status` is the ground truth, and a
   snapshot in the prompt may already be stale. Name the related PR/MR number
   when one is relevant.
3. **Hard context.** Boundary conditions the user actually stated, prior
   decisions that bound the search space, and the symptom you observed --
   load-bearing facts only.
4. **Deliverable shape.** The artifact you want back: a verdict, a PR/MR, a
   patch, a written report, or a one-line answer. Without this, teammates
   sometimes return the wrong shape.

### Keep Out

1. **Noise.** Sub-question checklists, reminders of default behavior (read
   before edit, do not fabricate), and generic exhortations ("be careful").
   If the draft exceeds about ten lines, audit each line against "would the
   teammate not otherwise know this".
2. **Invented restrictions.** Do not add "don't open a new branch" / "don't
   grep X" unless the action has a concrete cost the teammate cannot see, has
   demonstrably caused a foot-gun on this task, or the user said so. Restating
   a worry just removes the teammate's escalation room.
3. **Fabricated user decisions.** Never write "the user decided X" when the
   user did not say it. Vague input ("explore it", "go ahead") does not let you
   pick an option on the user's behalf -- pass the open question through and let
   the teammate raise it or report back.
4. **Your theory of the cause.** Hand the symptom and any concrete evidence (a
   stack trace, a log line, a diff fragment), not the conclusion you drew from
   it. An unverified hypothesis injected as a premise is exactly what the
   teammate has to detox before it can think.
5. **Stale path hints.** When the target repo loads its own context (its
   `CLAUDE.md` / `AGENTS.md` / knowledge base), write the prompt in the repo's
   product terms rather than pasting file paths or "Read X first" hints. The
   repo's own disclosure is more current than any snapshot the dispatcher
   carries. Referencing a current session artifact you just produced, such as a
   PR or issue number, is fine -- that is live state, not a stale knowledge
   path. Keep any reference to a private or scratch location to the teammate's
   own prompt; never let it reach a public commit, PR, or comment.

## Wait Phase

`tm spawn --prompt`, `tm send`, and `tm wait` can block for a full model turn.
Use a `--timeout` and read the exit code:

- **`0`** -- the reply landed within the timeout; stdout carries the reply text.
- **`124`** -- the sync wait expired and the teammate is still running. Do not
  respawn; the name is still taken. Collect the late result with
  `tm wait <name> --timeout <seconds>`.
- **`1`** -- true failure: no such teammate, broken send path, invalid repo or
  name, or the command was rejected. Read stderr before deciding the next step.

```bash
tm wait tests-api --timeout 180
```

If a teammate looks hung mid-turn rather than simply slow, `tm status <name>`
shows its pane and process ground truth so you can tell a stuck teammate from
one still working.

A second `tm send` to a teammate while an earlier send is still waiting steers
it: the earlier send returns early with a note, and only the latest send keeps
waiting. Use this to guide a running teammate. Confirm the verb's current
behavior in `tm send --help`.

When you build any wait loop, match expected result keywords (`merged`,
`done`, an anticipated error code), never words from the prompt you just sent --
the prompt text appears in the teammate's own turn and a prompt-word match
returns instantly.

## Failure Reporting

When a `tm` command fails, stop the delegation sequence and report:

- which `tm` verb failed
- the teammate name and repo path
- the exit status if available
- the first useful stderr/stdout lines
- whether retrying the same teammate is safe

A startup readiness failure such as a daemon exiting before binding its socket
means the teammate engine did not become reachable in the dispatcher
environment. Do not retry silently; report it as an environment failure and
ask the operator to run Dreamux diagnostics (`dreamux-maintenance` skill).

## Closeout

The source chat has the verified teammate result, including the command
summary and any explicit failure. No duplicate teammate was spawned for a task
an existing teammate already owned. Nothing was asserted that a `tm` verb did
not return this turn.
