---
name: dispatcher-workflow
description: "How a Dispatcher hands work to a TeamMate or a Team and works with it afterwards. Load when about to spawn or send to a TeamMate, or create or send to a Team; not needed for any other tool."
---

# Dispatcher Workflow

How a Dispatcher hands work down and works with a delegate afterwards.
Methodology, not tool operation.

## Yourself, a Subagent, a TeamMate, or a Team

Four ways to get a piece of work done:

- **Yourself.** The work fits this turn and needs the context you already hold.
- **An engine-native subagent.** Delegation inside your own turn and your own
  engine. Your engine describes its delegation feature — what it can see, how
  long it lives, what it returns — and that description is the one to read.
- **A TeamMate.** A Dreamux peer that continues independently: its own runtime
  and context, its own history, a conversation you can continue across turns,
  and visible to the user.
- **A Team.** A TeamLeader with its own workspace and its own members, for work
  that needs a coordinator of its own rather than a single worker.

Choose by asking about the work, not about the size of the request:

- Does it outlive your turn?
- Does it need its own context, or its own workspace?
- May the user want to inspect it or continue it?
- Does it need coordination of its own — several workers, several roles, work
  that has to be sequenced?

The first three questions push past a subagent to a TeamMate. The fourth pushes
past a TeamMate to a Team.

## Writing the Hand-Down Prompt

The prompt is the whole brief. A delegate sees what you write and nothing else
of your reasoning.

- **State the outcome and the evidence that would show it, not the steps.** Say
  what "done" looks like and how you will recognize it. A delegate that knows
  the outcome can find a better route than the one you would have dictated; a
  delegate given only steps stops when the steps run out.
- **Give the context it cannot see.** The source request in the user's own
  terms, the constraints, the files and paths that matter, what is already known
  and what has already been ruled out. Everything you leave implicit, it has to
  rediscover or guess.
- **Set the boundary.** What not to touch, whether the work is read-only or
  writing, and — when several delegates share one workspace — that only one of
  them writes to a given path.
- **Ask for a report shape.** What changed, the evidence for it, and the
  questions left open. A named shape is what makes several reports comparable.
- **Separate the standing from the momentary.** The role and the boundaries hold
  for every turn of that delegate's life and belong with it from the start; the
  task belongs to the turn you are sending.

What the brief carries is context, not control. The goal, the constraints in the
user's own words, what you already know and what you are only guessing — those
are yours to give. The edit plan is not: a delegate handed the files to change
and the way to change them has nowhere to put the discovery that the plan does
not survive contact with the code, so it writes code around the obstacle instead
of reporting it. When a delegate comes back saying it cannot do the work, that
is a finding: read what it found, and either take the decision to the user or
put the options to another delegate, rather than re-sending the same task with
firmer wording.

## When a TeamMate Does Something You Did Not Expect

Unexpected is not the same as wrong. A TeamMate has read files you have not and
has been working in a context you cannot see.

- **Ask why before overriding.** Get its reasoning first, in its own words.
- **Read the answer as a second perspective, not a defence.** It may have seen
  something that changes the task: a constraint in the code, a contradiction in
  the request, a cheaper route. The goal is two perspectives that complete each
  other, not one perspective corrected into the other.
- **Discuss until you converge.** Say what you expected and why, and let it say
  the same. Most surprises come from a brief that was thinner than you thought.
- **Then act on what you agreed.** Restate the boundary if the delegate was
  wrong; change your own plan if it was right; and if the collaboration is over,
  close it saying what it settled.

An unexplained override teaches nothing and repeats itself on the next task.

## Keeping the Thread

A conversation with one TeamMate accumulates context that a new one does not
have.

- Continue with the same TeamMate for follow-ups on the same work rather than
  starting another.
- Start a fresh TeamMate when the work itself is fresh: a different area, a
  different role, a perspective that should not inherit the first one's
  conclusions.
