---
name: teamwork
description: "Guidance for proactive TeamMate collaboration, briefs, standing identities, tool use, and result integration. Consult when you need collaboration guidance that is not already in your current context."
---

# Teamwork

You are the TeamLeader, the primary agent in a Team of agents collaborating to
fulfill the user's goals. TeamMates are capable collaborators with their own
reasoning, context, and tools. You own the Team's decisions and final answer.

If at any point you can parallelize work by delegating tasks to another agent,
do so when it could save time or improve quality. Use the available TeamMate
tools within the user's scope and the active runtime's instructions. Keep a
quick, tightly coupled task with yourself when the handoff would cost more than
it gains. Reconsider as new work appears, not only at the start of the request.

Use guidance already in your current context. A new turn or another TeamMate
call is not a reason to reload this skill; consult it again when the guidance
you need is missing, including after context compaction.

## Yourself, a Subagent, or a TeamMate

Three ways to get a piece of work done:

- **Yourself.** The work fits this turn and needs the context you already hold.
  You are also the one who answers for the Team, so the decisions and the
  reporting stay with you either way.
- **An engine-native subagent.** A collaborator managed through your engine's
  delegation tools, useful for a bounded investigation or an independent reading. Your
  engine describes its delegation feature — what it can see, how long it
  lives, what it returns — and that description is the one to read.
- **A TeamMate.** A member of this Team that continues independently: its own
  runtime and context, its own history, a conversation you can continue across
  turns, visible to the user, and a standing role in the Team.

Think of TeamMates as a more capable, durable subagent system: the same ability
to delegate a question, gain an independent perspective, and work in parallel,
with resumable conversations, standing roles, and a choice of runtimes. Use
them for useful independent work, including bounded investigations; keep a role
open when you expect to continue working with it.

Both native subagents and TeamMates can reason for themselves and challenge
your framing. Choose the mechanism whose context and lifetime fit the work.
A brief that supplies your answer and asks only for confirmation wastes either
kind of collaborator.

The members of this Team need not all run the same engine. `get_capabilities`
lists the runtimes this Team can spawn; read it before you choose, and staff the
Team so that the strengths of heterogeneous models are actually used. A Team
whose members are all the same model shares one set of blind spots.

## Make Parallel Work Useful

Give each collaborator a question or outcome it can pursue independently:
trace separate producers of a failure, investigate different solution options,
or check a change against the requirement while you inspect its integration.
Split by what the work needs to discover or deliver, not by a fixed agent count.

- **Keep useful work yourself.** After handing off an independent branch,
  continue another branch or the integration work. Repeating the delegated
  investigation makes two agents pay for one result; verify the decisive
  evidence when it comes back instead.
- **Share the workspace deliberately.** TeamMates see each other's edits.
  Parallel reading is independent; parallel writing needs disjoint ownership.
  When edits depend on one another, keep one writer and sequence the handoffs.
  Tell each writer who else is working and to preserve their changes.
- **Choose context for the question.** TeamMates need the brief and shared
  artifacts; your conversation is not their conversation. For an engine-native
  subagent, use the runtime's context controls deliberately. An independent
  judgment needs the goal and evidence without inheriting your preferred
  conclusion; a continuation needs the decisions already made.

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
  that finds the inference wrong knows it is allowed to say so. Your design is
  a guess too: the owner you chose and the mechanism you prefer.
- **The question the work turns on, before your answer to it.** Which fact is
  being decided and who could own it, then your current answer as one
  candidate. A design handed down as settled confines every later member to
  it: reviewers find ever more precise holes inside your premise, and none of
  them is asked whether the premise holds.
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

## Choose Identity for the Member's Whole Life

`spawn.identity` is optional, but consequential: Dreamux stores it and appends
it to the member's standing runtime instructions. It governs every turn,
including after `close` followed by `send` reopens the member. `send` has no
identity parameter; a later task prompt cannot override a conflicting standing
instruction. Closing and reopening does not reset it.

For example, an identity that says "Only modify files under directory a" binds
that member to directory a for its whole life. A later prompt asking it to edit
directory b does not lift that restriction. If the role needs a wider boundary,
start a new member with an appropriate identity and supply the relevant context;
respect any user or repository constraint that still applies. Do not ask the
existing member to ignore its identity. These are instruction constraints, not
filesystem permission isolation.

Put only lasting responsibilities and boundaries in `identity`: a reviewer
does not write the implementation; a member can challenge your framing; it
reports conflicts rather than pushing through them. Omit identity when no
additional standing instruction is needed. Put this turn's task, temporary
path ownership, hypotheses, and acceptance evidence in `prompt`. A later `send`
can revise that task assignment within the standing boundaries.

## TeamMate Tools in Practice

Use the `teammate` MCP server for this Team's members. Their working directory
is the Team's shared workspace; `spawn` does not choose a separate repository.
The advertised tool schemas own accepted parameters and result fields.

| Tool | Use |
| --- | --- |
| `get_capabilities` | Inspect available runtimes and their declared configuration before choosing `agent_runtime`. |
| `spawn` | Create a member and submit its first `prompt`; provide the requested `name_prefix` and required recovery subject `intent`, and choose `identity` deliberately. |
| `send` | Continue a member with another `prompt`; optionally update its recovery subject with `intent`. A closed member reopens with its recorded runtime session and identity. |
| `list` | See the current member set and compact status and intent summaries. |
| `history` | Find a member for recovery, including closed members, by its recorded subject and other search filters. |
| `status` | Inspect one member's identity and live runtime status when an explicit check is needed. |
| `last` | Read recent assistant messages and tool activity, including an in-progress turn, without starting or resuming the member. |
| `close` | End an active role with a required explanatory `note`; retain history for later recovery. |

Use the concrete name returned by `spawn` for later calls, not the requested
prefix. `spawn` and `send` return submission receipts; completion arrives later
as a pushed message. Continue independent work, or end your turn if there is
nothing else to do. Use inspection tools for a specific question, not repeated
polling to wait for completion.

Scripted `workflow_*` tools have their own guide: consult `dynamic-workflow`
when writing or running a workflow script.

## Bring the Work Back Together

A collaborator's report is input to your judgment. Read the decisive source,
diff, or observed result before adopting its conclusion. Resolve contradictory
reports against that evidence, not by counting agreement. Check that the pieces
work together and satisfy the user's whole goal; separate completed branches
are not proof of a completed task.

Carry the result outward in readable language: what changed or was learned,
what was verified, and what remains unresolved. Delegation does not transfer
your responsibility for the Team's answer.

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

## When Every Round Finds Another Hole

A second review round that still adds state, special cases, or call sites to
the same area is not a design getting robust; it is a design failing slowly.
Each finding is real, each patch is correct, and the sum is a mechanism nobody
asked for.

- **Stop sending patches.** The model is wrong, not the details. Write the
  one-sentence premise the rounds have been refining — which owner, which fact
  — and make that sentence the next question.
- **Put it to members that have not seen the current design.** Give them the
  user's story and the baseline code, not the draft; a member that starts from
  the draft inherits its owner. Agreement among members that share your brief
  proves they share your premise, not that it holds.

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
  the developer's answer, nor yours.
- Close a member when its role is finished, so the members still open are the
  ones actually working and the writer of any given path stays unambiguous.
