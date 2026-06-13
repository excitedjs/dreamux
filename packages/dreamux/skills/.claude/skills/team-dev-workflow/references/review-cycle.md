# Review Cycle

## Trigger

An MR/PR or issue proposal needs adversarial review before it can merge or move
to implementation.

Skip this cycle only when the change is trivial, the human already accepted the
risk, or an equally rigorous independent review already exists on the current
head.

## Steps

1. Identify the author, branch, MR/PR or issue number, and current head SHA.
2. Confirm the target repo and platform visibility. If public, include a
   no-internal-content constraint in the reviewer brief.
3. Confirm the change is ready to review: current branch pushed, required
   checks known, and merge state readable.
4. Reuse an existing reviewer teammate only if it already owns this exact
   branch or review thread. Otherwise spawn one independent reviewer.
5. Give the reviewer an adversarial brief:
   - verify the author's claims instead of trusting them
   - inspect the current diff against the target base
   - run or justify focused verification
   - report P0/P1/P2 findings with file and line references
   - do not edit, commit, push, or merge
6. Bucket the verdict:
   - no P0/P1: eligible for merge once required checks are green
   - P0/P1: send the author a fix brief quoting the findings exactly
   - P2 only: merge with follow-up or ask for a cheap one-shot fix
7. Recheck with the same reviewer after any force-push. Anchor the recheck on
   the prior findings, new head SHA, and reported fixes.

## Closeout

The current head has an independent clean verdict, required checks are green,
and any remaining non-blocking follow-up is explicit.

## Exceptions

| Case | Action |
|---|---|
| Base advanced | Ask the author to rebase or merge the target base, then re-run checks. |
| Reviewer and author disagree | Escalate both positions to the human; do not silently pick a side. |
| Formal review action is rejected | Post the same verdict as a top-level MR/PR comment. |
| A reviewed line moved after force-push | Quote the problem statement so the reviewer can relocate it. |
