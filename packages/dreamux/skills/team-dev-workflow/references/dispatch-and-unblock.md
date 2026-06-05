# Dispatch And Unblock

## Trigger

You are assigning a teammate to a target repo, or a teammate is blocked by git
state, wrong base, missing context, or missed platform comments.

## Steps

1. Verify the target repository path and intended base branch before spawning.
2. Reuse an existing teammate when it already owns the branch or MR/PR.
3. Ensure the teammate brief includes only:
   - intent
   - branch, issue, or MR/PR coordinates
   - hard constraints
   - requested artifact
4. Tell the teammate to sync its working branch before editing when the task
   will produce commits.
5. Tell the teammate to pull all current issue or MR/PR comments before acting.
   Repeat this on follow-up turns when comments may have changed.
6. For public targets, include the no-internal-content constraint explicitly.
7. Set a short queryable task subject if the teammate tooling supports it.

## Unblocking

If a teammate cannot write git metadata because of sandbox permissions, the
coordinator may run the git operation from outside the sandbox: fetch, create a
branch, commit staged teammate-authored content, push, or clean a worktree. Do
only the git movement needed to unblock. The teammate still owns analysis and
content changes.

If a teammate started from the wrong base, stop it, remove the bad worktree,
reset the main checkout to the intended base, and spawn again. Do not ask a
teammate to build on a known-bad branch unless the human accepts that risk.

## Closeout

The teammate is on the intended base, has current platform comments, has a
minimal brief, and is no longer blocked on git or missing context.
