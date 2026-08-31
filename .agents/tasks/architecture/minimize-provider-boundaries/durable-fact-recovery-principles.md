# Durable-Fact Recovery And Defensive-Rebuild Review Guide

## Why this note exists

The Stage 8 Team-dissolve review repeatedly turned one operator rule into a
stronger requirement that the operator never asked for. The rule was:

> A Team is dissolved only when its durable Team record says `closed`.

The mistaken extrapolation was:

> If the Team record did not become `closed`, every resource touched by the
> dissolve must be restored immediately so the Team behaves as if the dissolve
> never happened.

That extrapolation produced compensation code, eager reconstruction, and tests
for a rollback product that does not exist. This note records the corrected
principle and gives reviewers a concrete lens for finding the same mistake in
other domains.

This is not a general ban on recovery. It distinguishes ordinary recovery from
invented transactional rollback.

## Operator principle

1. Persisted owner facts are the recovery input. A later process or ordinary
   access reconstructs only from what actually committed.
2. A failed aggregate operation does not erase durable side effects that
   completed before the failure. There is no implied transaction across
   independently owned records and files.
3. Do not add a compensating entity, persisted phase, recovery ledger, retry
   registry, generation, boolean mirror, or eager materialization merely to make
   a rare failure look as though the operation never started.
4. If an in-memory object no longer represents its durable record, discard that
   object. The next ordinary materialization path may reconstruct the normal
   object from the normal record. Do not create a failure-specific domain
   object.
5. Starting a service after failure is acceptable when `start()` reads and acts
   on committed facts. It must not synthesize or restore facts that were
   durably removed or made terminal.
6. An operation's existing Promise is its in-process fence. A rejected
   retryable operation releases that fence; a later ordinary call may retry. Do
   not add a second phase machine to restate the Promise lifecycle.
7. Second-order failure during ordinary reconstruction is allowed to fail
   loudly. Do not recursively defend recovery from recovery unless a concrete
   product requirement and producer justify it.

## Team-dissolve example

The Team record is the sole Team-lifecycle fact:

- `status: closed` means the Team is dissolved.
- Any other readable Team record means the Team still exists.
- No Team record means there is no Team.

A dissolve may nevertheless commit other durable facts before the final Team
record write:

- Workflow runs may become terminal.
- TeamMate and TeamLeader identities may become `closed`.
- The Team cron store may be deleted.
- Runtime leases may be revoked and native processes may be stopped.

If the final Team-record write fails, those facts are not rolled back. The Team
still exists because its Team record is open, but its next use reconstructs from
the facts above:

- closed members stay closed until an ordinary member send explicitly reopens
  one;
- a missing cron store means no jobs are re-armed;
- terminal Workflow records stay terminal;
- the next TeamLeader use may construct the ordinary TeamLeader
  `TeammateService` from the existing durable Identity and provider session;
- no new Team, TeamLeader Identity, dissolve entity, or failure record is
  created.

The next dissolve uses the same retryable close operations. Work already
settled is idempotent; work that failed is attempted again. No persisted
dissolve phase is needed.

Pre-close refusal is different. If the operation refuses before resource
closing begins, such as a Dispatcher-side clean-worktree check, it has not yet
authorized durable teardown and must leave those resources untouched.

## What went wrong in this review

1. The TeamLeader correctly stated that a Team record which did not become
   `closed` means the Team was not dissolved.
2. The review incorrectly strengthened that statement into an immediate
   usability guarantee for every partial-close failure.
3. The correction then rebuilt a TeamLeader service eagerly, restarted
   Workflow and Scheduler as compensation, and added tests saying that a
   half-closed Team must be handed back as if no close occurred.
4. A later review found that a TeamLeader service could remain in its
   in-memory `closing` phase and be mistaken for a reusable live service.
5. The first response proposed another defensive phase check. That still
   preserved the false rollback requirement.
6. The operator clarified the actual rule: keep every intermediate persisted
   fact, discard obsolete memory, and let the next ordinary access rebuild from
   disk. A failed dissolve is not a distributed transaction.

Reviewers must not inherit any of the rejected interpretations above merely
because they appeared in an earlier review, implementation prompt, test, or
comment.

## Audit target

Review current production source for the same conceptual error beyond Team
dissolve. Inspect at least Team, TeamMate, Workflow, Scheduler, Dispatcher,
Channel routing/provisioning, runtime ownership, host shutdown, and worktree
cleanup.

Look for real production paths that do one or more of the following:

- catch an operation failure and recreate or restart resources to simulate a
  rollback that no product contract requires;
- preserve or rewrite durable state only so an earlier state can be restored if
  a later independent write fails;
- eagerly materialize a Service or entity solely for rare failure repair;
- keep a second lifecycle fact, phase, generation, ledger, or registry whose
  only purpose is defensive reconstruction;
- restore children of an aggregate even though their own committed records are
  already authoritative;
- convert a durable partial result into an invented all-or-nothing transaction;
- keep deleted files or stopped work recoverable even though the operator
  already authorized their loss;
- use an in-memory phase as recovery truth after the durable owner has already
  stated the current fact;
- treat process restart or ordinary lazy materialization as insufficient without
  demonstrating a user-visible product consequence.

For every candidate, trace the producer, the exact trigger, the durable facts
before and after it, and the consumer that experiences a product consequence.
Reject theoretical hardening with no real producer. Prefer deletion or reuse of
the ordinary materialization path over a new repair mechanism.

## Legitimate mechanisms that are not findings by themselves

Do not report these merely because they reconstruct or retain state:

- startup recovery that reads current persisted records;
- ordinary lazy materialization after a cache miss;
- a retryable Promise releasing after rejection;
- exact-instance cache eviction by the cache owner;
- Agent Runtime generation and MCP leases that fence real stale external
  writers;
- scheduler timer generations that prevent a real stopped timer from firing;
- completion FIFO/deduplication backed by real delivery producers;
- Workflow journal and terminal settlement required to converge external
  processes and durable runs;
- record-only cleanup of a `cleanup-pending` worktree;
- reconstruction of a closed Agent on an explicit ordinary `send`.

The question is not whether recovery exists. The question is whether it derives
from an authoritative fact and serves a real caller, or whether it was invented
to make an unrequested failure scenario look transactional.

## Required review output

The Claude and Seed reviews are independent and read-only. Each surviving
finding must include:

1. current `file:line` evidence;
2. the real production trigger;
3. the authoritative durable fact and any competing in-memory fact;
4. the user-visible or resource consequence;
5. why ordinary retry, restart, or lazy materialization is insufficient;
6. the smallest deletion, move, or narrowing that corrects ownership;
7. whether the issue is introduced by the current diff or inherited from
   `next`.

Report `CLEAN` when no candidate survives. Do not edit code, tests, change
files, or `.agents` material during this audit, and do not coordinate findings
with the other reviewer before both independent reports are complete.
