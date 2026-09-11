# Lean Task Records

## Keep one current-state authority

Use the task README as the only current-state authority and discovery entry. Keep
the detailed requirement, final solution, and verification evidence in their own
files; link them from the README instead of copying them into several status
documents. The linked GitHub Issue is the operator review surface for the final
solution, not a second task-state authority.

For a newly created task, initialize only:

```text
.agents/tasks/<domain-path>/<task-slug>/
  README.md
  requirement.md
```

Create later artifacts only when their stage begins:

- `technical-design/final.md` for the authoritative solution;
- `technical-design/draft.md`, `technical-design/proposals/`, and
  `technical-design/reviews/` only when the selected consultation path needs them;
- `verification.md` when implementation begins producing evidence;
- `sources/` or `artifacts/` only when an external requirement, incident artifact,
  screenshot, or acceptance result cannot be reconstructed reliably.

Do not initialize `context/`, `development-plan/`, `progress/`, `issues/`,
`public-knowledge/`, `module-design/`, `interface-info/`, or duplicate verification
files. Put scope and blockers in the requirement or README, implementation choices
in the final solution, and durable public knowledge directly in the maintained
`.agents` knowledge base.

Historical tasks may retain their old shape. Do not migrate them merely to match
this layout. On reuse, identify and link the artifacts that are authoritative for
the new slice, and make the README the sole current state.

## Maintain the README

Keep these fields current and concise:

- goal;
- finite workflow state;
- requirement and final-solution links;
- public GitHub solution-review Issue link;
- development approval source, time, and approved boundary;
- blockers and next action;
- lineage and related-task links;
- the pull request link once one is open;
- knowledge-closeout status and links.

Use one of these states:

`intake`, `clarification`, `solution`, `awaiting-development-approval`,
`implementation`, `review`, `knowledge-closeout`, `done`, or `blocked`.

Do not keep a parallel progress file or free-form maturity field. Preserve only
milestones that another TeamLeader cannot safely reconstruct: development approval,
material re-approval, and review adjudication.

## Write only facts that cannot expire on their own

A record is committed inside the pull request that delivers it, so it can never
contain the result of its own merge. Everything written here is read later by
someone who has no way to tell a current fact from a fact that was true when it
was typed, so the record carries only the second kind — and git and GitHub
already record the first kind authoritatively, for free, and without drifting.

Apply one test to every line: **can something outside this repository make this
false while the file sits untouched?**

- A state of `intake`, `blocked`, or `done` survives the test. The six middle
  states do not: `review` stops being true the moment a reviewer answers, and
  `implementation` stops being true when the branch is pushed. They are correct
  and expected on a working branch, which is a working copy — and they are a
  lie the moment that branch merges. `.agents/scripts/check.sh` rejects them,
  so set `done`, `blocked`, or `intake` before opening the pull request.
  `done` means the work is finished and submitted; whether it merged is git's
  fact, not the record's.
- The pull request *link* survives the test; its *status* does not. Write the
  link. Do not write `(open)`, a CI result, a merge commit, a list of green
  gates, or a merge date: each is a snapshot that GitHub will contradict within
  the day.
- A date that records when something happened survives the test — an operator
  approval on a given day stays true forever. A date that stands in for a
  status does not.
- The `State:` line carries the state and stops. A branch name, a date, or a
  parenthetical appended to it is a fact that expires while the state beside it
  stays put, so the check rejects the whole line.
- A domain index entry carries the title, the link, and the goal. It does not
  repeat the task's state: two copies of one fact in two files is the drift
  itself, because the record moves on and the index keeps yesterday's answer.

**Rewrite stale facts in place; do not append change history.** When something
recorded here is no longer true, edit the line to say what is true now. A record
is the current state of one task, not a log of how that state was reached — git
holds the log, and appending to the file makes the reader work out for himself
which of several claims is live.

## Keep the requirement current

Continuously edit `requirement.md` during clarification. It should contain only
decision-relevant material:

- the initial request or durable source link;
- confirmed current behavior and evidence;
- desired outcome and behavior;
- scope and non-goals;
- constraints and invariants;
- observable acceptance criteria;
- accepted decisions, assumptions, blockers, and unknowns.

Distinguish facts, operator decisions, hypotheses, and unknowns. Replace superseded
positions in the current alignment instead of appending a conversational timeline;
retain exact original wording only when it has continuing interpretive value.

## Initialize

Run the initializer only as the TeamLeader and only after the operator confirms a
new task:

```bash
python3 .agents/skills/dev-workflow/scripts/init_task.py create \
  --domain repository/workflow \
  --slug refine-example-behavior \
  --title "Refine example behavior" \
  --goal "Provide the confirmed example behavior"
```

The command keeps path names predictable, updates the discovery index, and does not
overwrite an existing task.

For a genuinely new domain, require real routing information rather than
generating TODO placeholders. Create empty parent domain indexes explicitly from
the top down when the first real task belongs only in a deeper child:

```bash
python3 .agents/skills/dev-workflow/scripts/init_task.py create-domain \
  --domain runtime \
  --domain-summary "Tasks owned by runtime capabilities" \
  --code-signal "Runtime packages=packages/agent-runtime"
```

Then create a task and its missing leaf domain together:

```bash
python3 .agents/skills/dev-workflow/scripts/init_task.py create \
  --domain runtime/new-domain \
  --slug develop-example-capability \
  --title "Develop example capability" \
  --goal "Provide the confirmed capability" \
  --create-domain \
  --domain-summary "Tasks owned by the example runtime" \
  --code-signal "Runtime=packages/example-runtime"
```

Validate a task and its parent indexes with:

```bash
python3 .agents/skills/dev-workflow/scripts/init_task.py check \
  --domain <domain-path> \
  --slug <task-slug> \
  --allow-in-flight
```

Pass `--allow-in-flight` while the task is still on its branch; without it the
check holds the record to what may land on the trunk. `.agents/scripts/check.sh`
runs the same validation over every record in the repository and never passes
that flag, which is what makes the rule binding rather than advisory.

The initializer and every authoritative task update belong to the TeamLeader.
Developer TeamMates treat `.agents/**` as read-only and return evidence in their
completion message. During solution consultation only, proposal and solution-review
TeamMates may write the one disjoint task file explicitly assigned to them.
