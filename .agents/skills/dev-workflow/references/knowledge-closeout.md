# TeamLeader Knowledge Closeout

Run this stage after implementation review and accepted corrections are complete,
but before committing and pushing the GitHub PR. The TeamLeader owns every write in
this stage.

## Reconcile the task with reality

Read the final requirement, approved solution, complete workspace change, current
owning code, tests, and TeamLeader verification results. Then:

- set the task README state to `knowledge-closeout`;
- correct stale requirement or solution facts without rewriting historical intent;
- update `verification.md` with TeamLeader pre-review, independent-review findings
  and adjudication, commands and results, skipped coverage, and residual risk;
- verify the approval boundary still covers the actual implementation.

If the implementation materially changes the requirement, architecture, public
contract, or approved scope, stop closeout and return to the earliest affected
workflow stage. Do not turn a documentation correction into retroactive approval.

## Update each knowledge owner once

Keep one owner for each fact and link to it elsewhere:

- `.agents/tasks/**` owns this requirement's lineage, current state, approved
  requirement and solution, and delivery evidence.
- `.agents/decisions/**` owns durable settled choices and why they were chosen.
  Capture the durable requirement outcome needed to understand the choice, the
  accepted decision points, rejected alternatives, consequences, and a task link;
  do not copy the full requirement or a chronological work log. Use a stable topic
  slug and update `.agents/decisions/README.md`.
- `.agents/domains/**` owns current cross-cutting flows, ownership boundaries,
  invariants, traps, source pointers, and decision links. Update only affected
  domain pages.
- `.agents/reference/**` owns current behavior, repository structure, and
  operational mental models. Update only the single affected owner.
- `.agents/glossary.md` owns overloaded terms.
- `.agents/root.md` owns only routing and repository-wide entry points.

For a purely restorative change that re-establishes an existing documented
contract, link that contract and record the decision update as `N/A`. Record each
affected knowledge owner as updated, or `N/A` with a concrete reason.

Apply every repository-specific synchronization rule from `AGENTS.md`. In
particular, changes to Dreamux config or persisted-state shape, validation, default,
ownership, or meaning must update the owning `dreamux-maintenance` reference and
its routing when required.

## Record through the TeamLeader

Developer and implementation-review TeamMates provide reports and evidence; the
TeamLeader writes accepted facts into task and knowledge records. Technical-solution
collaborators retain only their assigned proposal or review file.

## Validate before the PR

Run at least:

```bash
python3 .agents/skills/dev-workflow/scripts/init_task.py check \
  --domain <domain> \
  --slug <task-slug>
.agents/scripts/check.sh
git diff --check
```

Also run the validator for any changed skill and the focused test for any changed
knowledge or task script. Check that links and cited paths resolve against the
current repository; the general knowledge checker does not replace the task check.

When closeout passes, record the knowledge links or justified `N/A` results in the
task README, set `State: done`, and include all task and knowledge changes in the
commit that will be pushed for the PR.
