---
name: dev-workflow
description: The development process for changing the dreamux repo itself, for a TeamLeader coordinating TeamMates. Use when implementing any non-trivial change — a feature, a refactor, or a fix. Covers landing a spec, heterogeneous review before and after implementation, opening a PR to the default branch, and the gate before the operator sees it.
---

# Dreamux Repo Development Workflow

The default flow for any non-trivial change to this repo. Start here; do not skip a
stage to save time — each skipped stage is a class of defect that reaches the
operator. This is a simple baseline; the real process is richer and will grow.

## The loop

1. **Align, land a spec.** Talk to the operator until the requirement is
   unambiguous — play it back, surface the open decisions, and do NOT build on a
   fuzzy ask or an unsettled design decision. Write a short spec: intent, scope,
   hard constraints, acceptance, and what is explicitly OUT of scope.

2. **Heterogeneous spec review (before any code).** Have independent TeamMate
   reviewers check the SPEC — heterogeneous engines (different `agent_runtime` where
   the config offers them), 2–3 recommended, scaled to what is available. They check
   completeness, the design, and fit with the repo's EXISTING architecture. Fold the
   findings back into the spec.

3. **Implement to a PR.** Drive the implementation — a workflow orchestration if the
   runtime supports it, otherwise a dev TeamMate — and open a PR to the default
   branch. A dev TeamMate does NOT commit into the working tree on its own: under the
   single-writer rule the TeamLeader reviews the local diff and commits (never edit
   the tree while a dev TeamMate is live on it).

4. **Heterogeneous PR review (author ≠ reviewer).** Route the PR to independent
   reviewers — never the author, never self-review — 2–3 heterogeneous. Review the
   WHOLE change holistically (not a narrow "did it fix X"):
   - requirement fully landed;
   - no scope creep (no capability added that was not requested);
   - architecture sound and consistent with the repo's existing design;
   - refactor thorough, not glued on;
   - module responsibilities clear;
   - plus correctness, tests not weakened to pass, and public-artifact safety.

5. **Gate before the operator.** Send the PR to the operator ONLY after CI is green
   AND every reviewer's blocking findings are cleared.

6. **Fixes follow the same bar.** Any fix — review follow-up, regression, hotfix —
   runs the same multi-reviewer gate, reviewed holistically, never self-approved.
