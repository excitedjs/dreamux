# Final technical solution

## Decision

Add the judgment dimension to the existing sections of the bundled `teamwork`
skill plus one new situation section. Every section stays one situation and a
few moves.

## Changes

1. Choice section: the TeamMate bullet names its own judgment as the thing a
   subagent lacks; a fifth question asks whether the work needs a judgment that
   can contradict the leader's framing; one sentence says a member briefed like
   a subagent returns a subagent's result.
2. Hand-down: the guesses bullet includes the leader's design; a new bullet puts
   the question the work turns on before the leader's answer.
3. `identity`: standing to contradict the leader's framing.
4. New section “When Every Round Finds Another Hole”: stop patching, write the
   premise, put it to members that have not seen the draft; agreement among
   members that share a brief proves a shared premise.
5. “Keeping the Thread”: the reviewer gets the question, not the developer's
   answer, nor the leader's.

## Why stated here rather than linked

The engineering whitepaper already states the convergence and stop-patching
rules for this repository. `teamwork` ships in the package to every Team and
cannot link into `.agents/`, so it states the leader-side version in its own
words. Different owner, different audience.

## Rejected

- Lifting the PR #392 reviewer identity wording into `teamwork`: that is a
  reviewer identity for this repository; `teamwork` is leader methodology.
- A new tool, prompt surface, review seat, or review mechanism.
