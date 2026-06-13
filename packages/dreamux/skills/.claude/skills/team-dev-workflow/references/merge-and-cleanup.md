# Merge And Cleanup

## Trigger

An MR/PR has a clean independent review on the current head and required checks
are green.

## Steps

1. Re-read the current head SHA, required check status, draft state, and merge
   state from the target platform.
2. If the MR/PR is a draft, mark it ready before merging and confirm the head
   SHA did not change.
3. Scan the MR/PR title for bracketed CI-skip tokens. Remove or reword them
   before squash merging so post-merge workflows are not skipped.
4. Merge using the target repo's allowed mode and branch-deletion policy.
5. Clean up the review cycle immediately:
   - stop or close the reviewer teammate
   - remove the review worktree
   - delete the review branch if the cycle created one
   - close the author teammate when its branch is no longer needed
6. Record the final status in teammate history where the tooling supports it.

## Closeout

The change is on the target branch, required post-merge workflows are not
accidentally skipped, and no temporary teammate, worktree, or review branch from
the cycle remains active.

## Exceptions

| Case | Action |
|---|---|
| Merge state is unclear | Check required status checks specifically; optional jobs may be noisy. |
| Same-account formal approval is missing | Use the clean review comment as the gate when platform policy allows owner/admin merge. |
| Worktree removal refuses | Use the platform or git command intended for forced worktree cleanup; the branch already landed. |
| Cleanup must be delayed | State what remains and when it will be removed. |
