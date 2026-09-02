---
name: team-workflow
description: "Guidance for a TeamLeader working with this Team's TeamMates: TeamMate versus engine-native subagent, writing the hand-down prompt for a shared workspace, and what to do when a TeamMate's behaviour surprises you. Useful before handing work down and when a TeamMate needs discussing. Tool calls do not depend on it."
---

# Team Workflow

How a TeamLeader hands work down to this Team's members and works with them
afterwards. Methodology, not tool operation.

## Yourself, a Subagent, or a TeamMate

Three ways to get a piece of work done:

- **Yourself.** The work fits this turn and needs the context you already hold.
  You are also the one who answers for the Team, so the decisions and the
  reporting stay with you either way.
- **An engine-native subagent.** Delegation inside your own turn and your own
  engine. Your engine describes its delegation feature — what it can see, how
  long it lives, what it returns — and that description is the one to read.
- **A TeamMate.** A member of this Team that continues independently: its own
  runtime and context, its own history, a conversation you can continue across
  turns, and visible to the user.

Choose by asking about the work, not about the size of the request:

- Does it outlive your turn?
- Does it need a context of its own, one that would crowd out yours if you read
  it all here?
- May the user want to inspect it or continue it?
- Does it need a standing role — someone who writes, someone who reviews — held
  across several turns?

Any yes points past a subagent to a TeamMate. A member is a seat, not a single
errand: spawn one for a role you will keep sending work to.

## Writing the Hand-Down Prompt

The prompt is the whole brief. A member sees what you write and nothing else of
your reasoning; it did not read the request you are answering.

- **State the outcome and the evidence that would show it, not the steps.** Say
  what "done" looks like and how you will recognize it. A member that knows the
  outcome can find a better route than the one you would have dictated; a member
  given only steps stops when the steps run out.
- **Point at the task artifacts by path.** The requirement, the design, the
  notes, the files in question — they are in the workspace this Team shares, so
  name where they are instead of retelling them. Retold context goes stale and
  loses the detail the member would have read for itself.
- **Name the paths it owns.** Members write into one shared workspace. Let one
  member write a given path at a time; give the others read-only work, or edit
  paths that do not overlap. Two members editing the same file is the one
  failure a brief can always prevent.
- **Keep the roles disjoint.** A developer and a reviewer are two seats, not the
  same seat twice — a reviewer that wrote the code reviews its own reasoning.
  The role and its boundaries hold for every turn of that member's life; the
  task belongs to the turn you are sending.
- **Ask for a report shape.** What changed, the evidence for it, and the
  questions left open. A named shape is what makes several reports comparable,
  and it is what you carry outward.

You are the Team's only voice outward: what a member finds reaches the user when
you carry it there, through whatever visible reply path the connected channel
exposes. Put that in the brief — a member that needs a decision from the user
asks you for it rather than choosing for them.

## When a TeamMate Does Something You Did Not Expect

Unexpected is not the same as wrong. A member has read files you have not and
has been working in the shared workspace while you were elsewhere.

- **Ask why before overriding.** Get its reasoning first, in its own words.
- **Read the answer as a second perspective, not a defence.** It may have seen
  something that changes the task: a constraint in the code, a contradiction
  between two artifacts, a cheaper route. The goal is two perspectives that
  complete each other, not one perspective corrected into the other.
- **Discuss until you converge.** Say what you expected and why, and let it say
  the same. Most surprises come from a brief that was thinner than you thought,
  and the fix belongs in the next brief as much as in this member's next turn.
- **Then act on what you agreed.** Restate the boundary if the member was wrong;
  change your own plan if it was right; and take the disagreement to the user
  when what it exposed is a decision that was never yours to make.

An unexplained override teaches nothing and repeats itself on the next task.

## Keeping the Thread

A conversation with one member accumulates context that a new one does not have,
and every member you keep open is another writer in the shared workspace.

- Continue with the same member for follow-ups on the same work rather than
  starting another.
- Start a fresh member when the work itself is fresh: a different area, a
  different role, a perspective that should not inherit the first one's
  conclusions.
- Independence is worth paying for when you want a real check. Two members that
  share a brief also share its blind spots; give the reviewer the question, not
  the developer's answer.
- Close a member when its role is finished, so the members still open are the
  ones actually working and the writer of any given path stays unambiguous.
