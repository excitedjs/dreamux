# Split streaming display from the push-back mechanism

## Current state

- Goal: Separate the conversation-display surface every channel-facing TeamLeader and Dispatcher needs from the submission push-back mechanism it is currently built on, so a display consumer no longer requires a Dreamux submission to exist.
- State: `intake`
- Requirement: [Current requirement](/.agents/tasks/architecture/split-streaming-display-from-pushback/requirement.md)
- Established facts this task rests on:
  [runtime-input-semantics.md](/.agents/tasks/architecture/split-streaming-display-from-pushback/runtime-input-semantics.md)
  — input semantics, the 2026-09-02 live probe, the per-input identities that
  exist at the provider boundary, and what the official documentation does and
  does not guarantee.
- Final solution: Not created.
- Solution review Issue: Not created.
- Blockers: None. The requirement states three questions to answer before a
  solution is proposed; answering them is the next work, not a blocker.
- Next action: Answer requirement questions 1 and 2 — what Core could delete
  without display, and what display would be if designed against the recorded
  input semantics — then bring both to the operator before any implementation.
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

- Pull request / CI / merge: Not started.
- Knowledge closeout: Pending.
