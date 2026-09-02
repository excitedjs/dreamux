# Split streaming display from the push-back mechanism

## Current state

- Goal: Separate the conversation-display surface every channel-facing TeamLeader and Dispatcher needs from the submission push-back mechanism it is currently built on, so a display consumer no longer requires a Dreamux submission to exist.
- State: `intake`
- Requirement: [Current requirement](/.agents/tasks/architecture/split-streaming-display-from-pushback/requirement.md)
- Analysis: [analysis.md](/.agents/tasks/architecture/split-streaming-display-from-pushback/analysis.md)
  — question 1 answered (what Core could delete if display did not exist), 1b
  answered (what COT changed in the push-back mechanism: no behaviour, four
  additive shape changes), question 2 answered (the design, what it deletes,
  what it costs). Question 3 (anti-leak) is implemented.
- Established facts this task rests on:
  [runtime-input-semantics.md](/.agents/tasks/architecture/split-streaming-display-from-pushback/runtime-input-semantics.md)
  — input semantics, the 2026-09-02 live probe, the per-input identities that
  exist at the provider boundary, and what the official documentation does and
  does not guarantee.
- Final solution: Not created.
- Solution review Issue: Not created.
- Blockers: None. The requirement states three questions to answer before a
  solution is proposed; answering them is the next work, not a blocker.
- Next action: Bring the question-2 design to the operator for a ruling before
  any implementation. Two items in it are explicitly open: whether the unused
  `teammate.turn.settled` core event may simply go, and whether the claude steer
  envelope's `priority` field is inert.
- Related tasks:
  [feishu-cot-conversation-cards](/.agents/tasks/channel/feishu-cot-conversation-cards/README.md)
  (the display surface this separates from, and whose locked product model stays
  in force), and
  [minimize-provider-boundaries](/.agents/tasks/architecture/minimize-provider-boundaries/README.md)
  (the neutral seam a solution must not undo).

## Development approval

- Status: Not granted.
- Approved implementation boundary: None.

## Delivery

- Pull request / CI / merge: Question 3 (anti-leak infrastructure) is
  implemented and ships separately from the display split — it depends on none
  of the design above. The split itself is not started.
- Knowledge closeout: Pending.
