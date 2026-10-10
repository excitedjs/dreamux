---
name: teamwork
description: "Guide TeamMate delegation and follow-up work. Consult when needed collaboration guidance is missing from the current context."
---

# Teamwork

TeamMates are a more capable, durable subagent system: independent agents with
their own runtimes and context, resumable conversations, and standing identities.
Members of this Team work in the same shared workspace.

If independent work can be delegated to save time or improve quality, use the
TeamMate tools within the user's scope and current instructions. For example,
a member can investigate one cause while you trace another, or review a change
while you check its integration. Keep tightly coupled work with yourself when
handoff costs more than it gains. Reuse this guidance while it remains in
context; a new turn or handoff does not require rereading the skill.

## Delegate a Question or Outcome

Choose a runtime using `get_capabilities` and what the work needs: a particular
model's strengths, another perspective, or continuity with earlier work. Native
subagents also have independent judgment; use their engine's context and
lifetime controls when that delegation mechanism fits the task.

A TeamMate receives its brief and shared artifacts, not your conversation.
Supply the missing context: the user's goal, their constraints verbatim,
relevant artifact paths, known evidence, and what result would count as done.
Label your assumptions and proposed solution so the member can challenge them.
Carry through confirmed user implementation choices; leave unsettled choices
for the member to investigate. For independent review, give the requirement and
evidence without presenting the developer's conclusion as the expected answer.

Shared files make parallel reading straightforward. For parallel edits, assign
paths to each writer and identify other active writers. A member that needs to
edit someone else's paths should raise the overlap before writing. Sequence
handoffs when edits depend on one another. These assignments belong in the
turn's task prompt unless they are genuinely permanent role boundaries.

## Choose Identity for the Member's Whole Life

`spawn.identity` is optional. Dreamux stores it and appends it to the member's
standing runtime instructions on every turn, including after `close` and
reopening through `send`. `send` has no identity-update parameter. A task
prompt cannot override a conflicting standing instruction; reopening preserves
that instruction too. This is instruction precedence, not filesystem isolation.

An identity saying "Only modify files under directory a" binds that member to
directory a throughout its life. A later prompt asking it to edit directory b
does not lift the restriction. If its standing role must change, start a new
member with the appropriate identity and relevant context, respecting any user
or repository constraints that continue to apply.

Use identity for lasting role boundaries, such as an independent reviewer who
does not edit the implementation. Keep the current task, temporary path
ownership, assumptions, and acceptance evidence in `prompt`; later `send`
turns can revise those assignments within the standing boundaries. Omit
identity when no additional standing instruction is needed.

## TeamMate Tools

The `teammate` MCP server manages this Team's members; `spawn` inherits the
shared workspace rather than selecting a repository. Tool schemas describe
accepted parameters and result fields.

| Tool | Use |
| --- | --- |
| `get_capabilities` | Choose an available `agent_runtime` from its declared capabilities. |
| `spawn` | Create a member with its first `prompt`, a requested `name_prefix`, a recovery subject `intent`, and optional standing `identity`. |
| `send` | Continue an existing member; a closed member reopens with its recorded session and identity. Optional `intent` updates its recovery subject. |
| `list` | See members and their status and intent summaries. |
| `history` | Find members for recovery, including closed ones. |
| `status` | Check one member's identity and live runtime status. |
| `last` | Inspect recent messages and tool activity, including an in-progress turn, without starting or resuming the member. |
| `close` | Close a member with an explanatory `note`, retaining its history for recovery. |

Use the concrete, never-reused name returned by `spawn` for later calls.
`spawn` and `send` return submission receipts; completion is pushed later as a
new message. Continue independent work, or end your turn when none remains.
Inspection tools answer specific questions; wait for completion through the
pushed message. For scripted `workflow_*` operations, consult `dynamic-workflow`
when writing or running the script.

## Continue and Integrate

Continue with the same member for related follow-ups, preserving its context.
Use another member when the work calls for a different standing role or an
independent perspective; keep implementation and independent review separate.
Close a member when its role is finished.

When a report is surprising or blocked, read its evidence and ask what led to
it before redirecting the work. A contradiction in the brief may require a
new decision rather than firmer wording. Take changes to the user's requirement
back to the user; resolve implementation disagreements against source evidence.

If successive review rounds keep adding state or special cases, revisit the
premise they share. An independent reading of the requirement and baseline can
help test that premise without inheriting the current design as settled.

Read decisive source, diffs, or observed results before adopting a member's
conclusion. Check that the contributions work together and satisfy the whole
request; the TeamLeader remains responsible for the final answer and its
validation limits.
