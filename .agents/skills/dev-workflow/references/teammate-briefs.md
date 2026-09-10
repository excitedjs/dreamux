# TeamMate task briefs: good and bad cases

Read when composing a developer's `spawn` or a follow-up `send`. These examples
apply the bundled `teamwork` skill's "Context, Not Control" guidance to this
repository. They supplement the [developer identity](developer-identity.md) and
[implementation handoff](implementation.md), without changing approval or
ownership rules.

## Where information belongs

| Place | Content |
| --- | --- |
| `identity` | The standing role, write boundaries, and freedom to challenge the brief. |
| Task documents | The current requirement, approved constraints and solution, relevant evidence, and verification expectations. |
| `prompt` | This assignment's outcome, document pointers, important facts not recorded there, and the expected report. |

Keep necessary context available without copying the whole task into every
message. Explain a real constraint once in its owning document; label an
unconfirmed assumption so the recipient can question it. Concision is useful
because it leaves room for judgment, not because prompts have a word limit.

## Good case: an approved implementation

The operator accepted this concise COT handoff after requesting a fresh Claude
developer: "你这次下发的不是很好吗？" (2026-09-10).
The following is an English rendering of the task prompt; the role
and repository-write boundaries were supplied separately in `identity`.

```text
ultracode: Complete the original COT display requirements and correct the
ordering of Failed, including verification.

Requirements:
.agents/tasks/channel/refine-cot-tool-details-and-notifications/implementation-brief.md

The source is at the clean next baseline. Choose the implementation yourself;
report the changes, verification results, and remaining issues when finished.
```

The task document contains the display rules and required checks. The prompt
states the requested outcome and verified starting state, then leaves the
developer to investigate and implement. `ultracode` is included because the
operator explicitly requested it; this example does not make it a default for
other tasks. A reused example must not assert a clean baseline without checking.
The operator accepted the handoff; that is not evidence that the implementation
or its tests have completed.

## Bad case: prescribing the recipient's execution

This condensed counterexample captures the rejected handoff pattern:

```text
Use ultracode. By that I mean the workflow tool I selected. Load these extra
orchestration guides, call that tool, use my stages and runtime choices, and
report its run ID. Restore the old title map, remove the language fields, and
carry forward my previous repair list. Follow this sequence exactly.
```

The TeamLeader replaced the user's method with a similarly named mechanism,
turned implementation guesses into orders, and carried discarded code into a
fresh task. The clean baseline already had the fixed titles and did not have
the added language contract: those repair instructions were stale. More detail
would reinforce the wrong premise.

Instead, name the desired behavior against the actual starting source. Keep
historical decisions where they explain a current constraint; do not hand over
an abandoned patch plan as the new requirement. Forward an operator-selected
method without silently substituting a different system with the same name.

## Good and bad follow-ups

Good: provide the observable mismatch and its owning requirement, then let the
same developer investigate it.

```text
The failed tool row still shows Failed before the arguments. The accepted
display order puts failure text in the RESULT area after arguments. Please
correct that behavior and verify the complete resulting change.
```

Bad: repeat the role, paste the whole requirement again, specify each line to
move, and add new prohibitions after every reply. When an unexpected result
exposes a different reading of the problem, ask for the developer's reasoning
before overriding it. When the operator requests a fresh developer, give that
developer the current task rather than the previous conversation's accumulated
execution instructions.

The TeamLeader's work is accurate requirements and ownership boundaries, followed
by inspection of the complete result. A capable recipient should not have to
work around the TeamLeader's unverified implementation plan to do the task.
