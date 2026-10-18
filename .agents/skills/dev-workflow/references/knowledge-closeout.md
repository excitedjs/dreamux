# Knowledge Closeout

Enter `knowledge-closeout` after implementation review, ratified corrections, and
local verification are complete and the operator confirms the transition.
Reconcile the final requirement, approved solution, complete diff, and evidence.
Check that the development approval still covers the actual change.

Update each affected knowledge owner once:

- the task owns its requirement, solution, operator rulings, and verification;
- `.agents/product/` owns user-visible behavior;
- `.agents/domains/` owns current architecture, contracts, and source pointers;
- directory `CLAUDE.md` files own local load-bearing invariants;
- `.agents/glossary.md` owns overloaded terms;
- `.agents/root.md` owns routing.

Apply the synchronization rules from `AGENTS.md`, including the owning maintenance
reference for config or persisted-state changes. Record affected owners as updated
or `N/A` with a reason. If closeout reveals a material requirement, solution, or
scope change, stop and return to the earliest affected stage through its card.
Documentation cannot provide retroactive approval.

Update `verification.md` with review dispositions, commands and observed results,
coverage limits, and residual risks. During closeout, validate the current task
with `--allow-in-flight` as described in [task records](task-records.md); the trunk
check rejects in-flight states.

Once closeout is ready, request `done` through a stage-transition card and set that
state after approval. Before committing, run:

```bash
node .agents/scripts/check.mjs
git diff --check
```

Include the completed task and knowledge changes in the PR. A check failure must
be resolved before submission.
