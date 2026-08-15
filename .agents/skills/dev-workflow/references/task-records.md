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
- delivery summary for pull request, CI, and merge when recorded;
- knowledge-closeout status and links.

Use one of these states:

`intake`, `clarification`, `solution`, `awaiting-development-approval`,
`implementation`, `review`, `knowledge-closeout`, `done`, or `blocked`.

Do not keep a parallel progress file or free-form maturity field. Preserve only
milestones that another TeamLeader cannot safely reconstruct: development approval,
material re-approval, review adjudication, and merge.

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
  --slug <task-slug>
```

The initializer and every authoritative task update belong to the TeamLeader.
Developer TeamMates treat `.agents/**` as read-only and return evidence in their
completion message. During solution consultation only, proposal and solution-review
TeamMates may write the one disjoint task file explicitly assigned to them.
