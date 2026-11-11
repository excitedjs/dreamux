# Requirement

## Problem

Dreamux pushes a settled turn's completion back to the agent that is waiting for
it. On Codex that push is an ordinary `turn/start`, which the runtime folds into
the active turn as a steer whenever one is running. A steer cancels the
in-flight model response: the assistant message that was being written is
aborted and never completes.

Measured on codex-cli 0.166.0: a completion delivered mid-response left the
first assistant message at 65 streamed deltas with no `item/completed`, while
the same text delivered as appended context let it finish at 294.

So every completion report currently costs the recipient whatever it was
writing. The busier a TeamLeader is, the more of its work is discarded.

## Required behavior

1. A submission states why its turn exists.
2. Only a person's message (`user`) may interrupt work already in progress.
3. Every other source — a cron fire, a completion report, an assigned task, a
   host notice — is delivered into a busy thread without interrupting it.
4. When the thread is idle, that same submission starts a turn, because an idle
   thread is exactly the case where the news is what resumes the work.
5. A runtime that cannot distinguish these keeps its previous behaviour.
6. The Claude Code runtime keeps its current delivery: it never interrupts on a
   stream-json submission, so it has nothing to fix, but it still states the
   reason on the envelope.

## Operator's rule, verbatim

> 只有 user 才允许在 turn 中 steer，其他一律走忙碌判断，忙碌就 inject，idle 就拉起新 turn。

## Scope

Neutral submission contract, both built-in runtime adapters, Core's
source-to-trigger mapping, and the admission receipts that read a new
`appended` outcome.

## Out of scope

- Batching or coalescing several completions into one turn.
- Any durable queue for undelivered completions.
- Changing what a completion report says.
