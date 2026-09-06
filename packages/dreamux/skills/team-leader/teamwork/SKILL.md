---
name: teamwork
description: "How a TeamLeader hands work to a TeamMate and works with it afterwards. Load when about to spawn or send to a TeamMate; not needed for any other tool."
---

# Teamwork

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

The members of this Team need not all run the same engine. `get_capabilities`
lists the runtimes this Team can spawn; read it before you choose, and staff the
Team so that the strengths of heterogeneous models are actually used. A Team
whose members are all the same model shares one set of blind spots.

## The Hand-Down: Context, Not Control

A TeamMate is a whole agent with its own harness, not a step you already worked
out. What it needs from you is the context you hold and it cannot see; what it
does not need is your plan for its edits. A brief that fixes which files to
change and how leaves the member nowhere to put the discovery that the plan does
not survive contact with the code — so it writes a large amount of code trying
to satisfy an impossible instruction, and the work comes back to be redone.

Carry into the brief:

- **The user's goal, and why they want it.** The outcome, and the reason behind
  it that lets a member recognize a better route to the same end.
- **The requirement context from your conversation with the user.** Where that
  conversation is already recorded, name the path — the member reads the
  artifact for itself and gets the detail your retelling would drop. Where it is
  recorded nowhere, it exists only in your context: write it into the brief or
  into the shared workspace first, or it is lost to everyone but you.
- **The user's own constraints, verbatim.** Their words, not your paraphrase. A
  paraphrased constraint is a constraint you have already started deciding.
- **Your guesses, marked as guesses.** Say which parts you inferred, so a member
  that finds the inference wrong knows it is allowed to say so.
- **What "done" means, and what you need to read back.** The evidence that would
  show it, and the shape of the report you will carry outward: what changed, the
  evidence for it, and the questions left open.
- **The known unknowns.** What you have not checked, and what you already ruled
  out and why.
- **When several members write in parallel, which paths each one owns, and
  why.** The assignment, with its reason, so a member that needs to touch
  someone else's path comes back to you instead of guessing.
- **Keep the roles disjoint.** A developer and a reviewer are two seats, not the
  same seat twice — a reviewer that wrote the code reviews its own reasoning.
  The role and its boundaries hold for every turn of that member's life; the
  task belongs to the turn you are sending.

Leave out the edit plan — which files to change and in what way — and any
prohibition you cannot give a reason for. An unreasoned prohibition survives
contact with reality no better than an edit plan does, and the member cannot
tell which of your rules is load-bearing.

Say what the member is free to do: explore, read whatever it needs, and choose
the route. Say what happens when reality disagrees with the brief — stopping to
report a conflict with the code, or a blocker, is the correct result of the
turn, not a failure to deliver.

`identity` holds what stands for every turn of the member's life: its role, its
boundaries, and the posture of stopping to report rather than pushing through.
`prompt` holds this turn's task. `send` carries the next turn's task the same
way; the standing role is already in place and does not need restating.

## When a TeamMate Reports It Cannot

A member that reports it cannot do the work has usually found something: the
design contradicts the code, two artifacts disagree, the requirement assumes
something that is not there. The finding is the value of that turn.

- **Read what it found.** In its own words, and against the files it names,
  before you decide anything about the task.
- **Convene the other members for options.** A finding that opens a choice is
  worth putting to members who did not write the brief; several readings of the
  same obstacle beat one.
- **Take a decision that is the user's to the user**, through the channel's
  question tool. Rewriting the requirement on their behalf replaces their
  decision with your guess, and they find out only when the work is finished.
- **Do not re-send the same task with firmer wording.** Nothing about the
  obstacle changes; the member either repeats the finding or writes code around
  it, which is the rework you were trying to avoid.

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
