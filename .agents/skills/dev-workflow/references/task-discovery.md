# Task Discovery and Lineage

## Discover through README indexes

Use README files as the routing surface for task discovery:

1. Read `.agents/tasks/dreamux/README.md` only.
2. Read only the relevant domain README files selected by the root index.
3. Read only the README files of plausible task candidates.
4. Present the candidates to the operator before opening deeper task artifacts by
   default.

Do not scan task subtrees or load requirement, design, progress, or evidence files
merely to find a candidate. README-first discovery keeps intake bounded and
prevents unrelated history from filling the context window.

If one candidate matches, ask whether it is the task to continue. If several match,
summarize the meaningful differences and ask the operator to choose. If none match,
ask whether to create a new task. Do not create or select a task implicitly.

After the operator confirms a new task, have the TeamLeader run:

```bash
python3 .agents/skills/dev-workflow/scripts/init_task.py create \
  --domain <domain> \
  --slug <action-task-slug> \
  --title "<task title>" \
  --goal "<initial outcome>"
```

The script creates only the task README and `requirement.md`, then adds the task to
the existing domain README. Read [task-records.md](task-records.md) for the lean
record contract, new-domain options, validation command, and ownership boundary.

## Explain a candidate before confirmation

If the operator asks what a candidate task was about before deciding whether to
reuse it, read that candidate's final requirement artifact and final technical
solution linked from its README. Limit this expansion to the candidates the
operator asks about. If the README links are missing or stale, search only inside
that candidate task directory for the final requirement and final solution; do not
broaden into other tasks.

Summarize the intended outcome, scope, non-goals, accepted design, and documented
task state. Do not load proposal drafts, peer reviews, chronological progress,
issues, or raw evidence unless the operator asks for that additional history.

Describe requirement and design documents as historical intent and decisions, not
as proof of what ultimately landed. If the operator asks what was actually
implemented, perform a bounded check of the candidate's completion or verification
evidence and the current owning code, and distinguish planned, recorded, and
verified behavior.

After the operator confirms the task, read only the deeper artifacts linked from
its README that are relevant to the current work. Treat README summaries as routing
and current-state records, not as proof of implementation facts; verify those facts
against current code and evidence.

## Preserve one requirement lineage

Use one task directory for one continuing requirement lineage, independent of
developer, TeamLeader, conversation, context reset, branch, or pull request.

Reuse the existing task for:

- unfinished work transferred to another person or TeamLeader;
- later implementation, review, verification, or merge follow-up for the same
  requirement;
- a regression proven to have been introduced by that requirement.

Verify an asserted regression relationship before reusing the task. Create a new
task only for an independent product outcome or a different proven root cause.
When a new task relies on earlier work, link it to the prior task with an explicit
relationship such as `builds-on`, `depends-on`, or `supersedes`; do not copy the
prior task's entire history.

## Keep discovery reliable

Make the task README the stable entry point and sole current-state authority. Keep
its goal, current state, current requirement link, current solution link, next
action, related-task links, and public solution-review Issue link current.

When creating, renaming, reopening, relating, or completing a task, update its task
README and every parent README index needed to discover it. README-first discovery
is reliable only when index maintenance is part of the same change.
