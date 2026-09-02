# Split streaming display from the push-back mechanism

## Current state

- Goal: Separate the conversation-display surface every channel-facing TeamLeader and Dispatcher needs from the submission push-back mechanism it is currently built on, so a display consumer no longer requires a Dreamux submission to exist.
- State: `intake`
- Requirement: [Current requirement](/.agents/tasks/architecture/split-streaming-display-from-pushback/requirement.md)
- Review record:
  [review-corrections.md](/.agents/tasks/architecture/split-streaming-display-from-pushback/review-corrections.md)
  — what two independent reviewers changed in the design on 2026-09-02, what
  they corrected as fact, and what held under challenge.
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
- Final solution:
  [technical-design/final.md](/.agents/tasks/architecture/split-streaming-display-from-pushback/technical-design/final.md)
  — proposed, not approved. Carries the two flow diagrams (push-back, and COT
  rendering) and the change inventory.
- Solution review Issue: Not created.
- Blockers: None. The requirement states three questions to answer before a
  solution is proposed; answering them is the next work, not a blocker.
- Next action: Operator ruling on the technical design, then development
  approval. The design has been through two review rounds; what is still open is
  listed in `final.md` (the activity-fact dedupe, which needs a probe, and the
  embedded-versus-reshaped activity payload). `priority` is no longer open — the operator ruled it
  deleted. Whether the unread `teammate.turn.settled` may go is still open, and
  is a flowx question too.
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

- Pull request / CI / merge: Question 3 (anti-leak infrastructure) ships in
  [PR #367](https://github.com/excitedjs/dreamux/pull/367), all checks green,
  awaiting review. It depends on none of the design above. The display split
  itself is not started and needs an operator ruling first.
  Two things PR #367 cannot verify before merge, named in its body: the
  `release.yml` step is only exercised by the next real release (watch the
  "Install gitleaks" step and the version-bump commit passing the hook).
- Knowledge closeout: Pending.
