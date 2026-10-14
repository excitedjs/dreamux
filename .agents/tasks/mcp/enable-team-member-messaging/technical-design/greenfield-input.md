# Greenfield design input

## Operator instruction and authority

On 2026-10-13, after the product behavior consolidation, the operator said:

> 看起来产品行为是确定的。那剩下的就是代码层的问题了。我觉得你可以用这个思路来看。就是完全重头写的话，这套机制怎么写是最优的

English rendering: "The product behavior looks settled. What remains is the
code-level question. Consider it this way: if we wrote the mechanism completely
from scratch, what would be the best design?"

Use [requirement revision 3](/.agents/tasks/mcp/enable-team-member-messaging/requirement.md)
as the sole product input. The confirmed final product shape decides. Current
code, earlier decisions and proposals explain how the system got here; they
may be knowingly superseded by naming the changed boundary and its rationale.
They are not a preservation order or a preferred answer.

The operator authorizes design, not a repository rewrite. Preserve the
delivered implementation and the existing architecture hold. Do not modify
product code, tests, config, scripts or generated files, run experiments/tests,
commit, push, publish a replacement final solution, or dispatch implementation
review. Each solution seat writes only its assigned existing proposal file;
the TeamLeader owns the reconciled comparison and task state.

## Independent greenfield pass

First derive an ideal design from the product stories without starting from
current class names, existing fields, or the cheapest diff. Then compare that
design against both `HEAD` (pre-feature baseline) and the delivered worktree.
Do not read other seats' new greenfield sections before submitting your own.
Do not treat your earlier recommendations as settled design requirements.

Produce one complete recommended end-to-end design. Include concise contract
sketches in the document when useful, not runnable prototypes. Explain:

- the minimum facts/actions the mechanism needs, their authoritative producers,
  their consumers, and why each component or state exists;
- how all accepted messaging, ordinary-member reporting and specifically
  requested TeamLeader reply paths fit together, without a recursively
  reporting management tree or owner-kind copy forks;
- the exact public runtime contract and what the next provider author must
  implement; which guarantees are intrinsic product requirements and which
  merely follow from the chosen transport/representation;
- one-result delivery, folded inputs, mixed native-result ordering, request
  answers for Workflow, native versus transport failure, interruption, sender
  binding, wake/reopen/lock behavior, stop eligibility, generation replacement,
  and convergence of started deliveries;
- whether submission settlement and native observation need distinct
  representations, side-effect owners, identities or bookkeeping; justify
  coexistence, deletion or replacement rather than assuming either answer;
- how both member collections reuse the design while managed Teams remain
  isolated from unsolicited Dispatcher input;
- concrete counterexamples to your recommendation and verification that would
  falsify it. Mark unverified facts and actual product choices separately.

Existing contracts can constrain adoption but must not silently decide the
ideal. Distinguish an ideal new-provider contract from transition support for
old providers/hosts. Do not introduce version negotiation, queues or fallback
entities merely to preserve the current interface; name any real compatibility
scenario and its cost if proposing those mechanisms.

## Compare ideal and current shape

For every reshaped module, classify the gap as adaptation or replacement.
List the states, fields, entry points, lifetimes, concepts and cross-layer hops
that would disappear, those retained, and genuine additions. Moving code or
extracting a wrapper while both original mechanisms survive is not a removal.
Explain what a maintainer and the next provider would need to understand under
each shape; line counts alone do not prove optimality.

Read owning source and the recorded history before assigning a new owner.
Name which former boundary you follow or supersede and why. A design can be
better while having a larger adoption diff; conversely a rewrite can add more
concepts than it removes. Do not claim a globally optimal architecture from
consultant agreement or a green gate.

## Output and reconciliation

Append `Greenfield design from requirement revision 3 — independent proposal`
to your assigned proposal, preserving all earlier sections as history. Return
the recommendation, exact removals, strongest counterexample, adoption class,
and genuine blockers. After all three independent proposals are received,
perform exactly one cross-review round, then the TeamLeader reconciles against
source. Current implementation remains comparison evidence throughout.
