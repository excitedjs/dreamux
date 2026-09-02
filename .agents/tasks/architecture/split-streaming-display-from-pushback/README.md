# Split streaming display from the push-back mechanism

## Current state

- Goal: Separate the conversation-display surface every channel-facing TeamLeader and Dispatcher needs from the submission push-back mechanism it is currently built on, so a display consumer no longer requires a Dreamux submission to exist.
- State: `implemented` — built on branch `refactor/split-display-from-pushback`;
  `rush build`, `rush lint`, `rush typecheck:tests`, and `rush test` all green,
  and the issue #63 live gate (`tests/codex-live.test.ts`, 8/8) passes against a
  real codex 0.151.0 rather than being skipped. The card terminal is
  three-valued as of the 2026-09-02 probe: `RUN_FINISHED done`,
  `RUN_FINISHED interrupted`, and `RUN_ERROR` for a failed end.
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
  — carries the two flow diagrams (push-back, and COT rendering), the change
  inventory, and an **As built** section recording every departure the
  implementation made from it and why. Both previously-unresolved items (the
  activity-fact dedupe, the embedded-versus-reshaped payload) are resolved
  inline in that document.
- Solution review Issue: Not created.
- Blockers: None. The requirement states three questions to answer before a
  solution is proposed; answering them is the next work, not a blocker.
- Next action: Operator review of two things the implementation decided that
  the design had explicitly left to a ruling.
  1. **A dropped completion push-back is now visible.** Applying rulings 4 and 8
     uniformly moved the input publish above the recipient-liveness check, so a
     push-back to an agent whose runtime is already gone now shows the delivered
     body plus a failed end on that agent's card, where `final.md` said that half
     "stays invisible" and "needs its own ruling". Kept because the alternative
     is a special case; pinned by a test, so reverting is one line. See
     `final.md` § As built, item 2.
  2. **Ruling 4's 「置成失败」 now reaches the card.** All four non-`submitted`
     admissions publish `turn.ended` with `status: 'failed'`, and a failed end
     ends the Feishu card with AG-UI's `RUN_ERROR` event, which the client
     renders as 任务失败. That event carries `code` alone — two probes showed
     its `message` is neither rendered nor required — so the reason reaches the
     card only as the text printed before the terminal. The earlier reading — that the wire had no failure terminal —
     was wrong: it was being looked for among the values of
     `RUN_FINISHED.status`, where AG-UI does not put it. Settled by the
     2026-09-02 live probe and then by the reference the operator pointed at,
     **COT Message Brief** on `open.larkoffice.com`, which the public
     `open.feishu.cn` docs do not carry; see item 3.

  Recorded and deliberately not done:
  - `isSynthetic` is producer-less in `src/` exactly like `priority` was, but
    ruling 1 names only `priority`, so it was left alone (item 9).
  - `submitLocked` re-asserts its lock token after `ensureStarted()`, so the
    workflow lock path still publishes no input when the *start* fails. Closing
    it would announce an input a revoked lock then refuses (item 10).
  - `enterOrdinaryMutation` stays at four call sites, not the three the change
    inventory predicted: the completion path must translate a closing entity's
    refusal into `unsupported` instead of throwing (item 12).

  Review defect fixed on the way:
  - The split left codex's display line asymmetric: an unbound native turn's
    activity displayed while its end was refused, leaving a card nothing could
    close. The end now rides the same path its items already take, on the COT
    requirement's own terms (rules 1 and 8). See `final.md` § As built,
    departure 7.

  Cleanup folded in on the way (ruling 2):
  - `seal.ts`'s `KINDS` allowlist was a bare `ReadonlySet<string>` that silently
    dropped an unlisted kind; it is now derived from an exhaustive
    `Record<ChannelCoreEvent['kind'], true>`, so a missing entry fails to
    compile.
  - `feishu-cot-events.ts` hit its 700-line lint cap, and the recorded seam was
    taken rather than shaved: `feishu-cot-presentation.ts` now owns what a card
    *shows* for a tool call and the byte bounding those strings share, while
    `feishu-cot-events.ts` keeps AG-UI event construction and wire budgets and
    imports from it. 427 and 317 lines, no behaviour change (item 13).
  - `rush typecheck:tests` is not part of `rush build`, `rush lint`, or
    `rush test`, so two test files stayed green while compiling against deleted
    types. Both are rewritten, and that command belongs in the green bar for any
    change that moves a type (item 11).
- Related tasks:
  [feishu-cot-conversation-cards](/.agents/tasks/channel/feishu-cot-conversation-cards/README.md)
  (the display surface this separates from, and whose locked product model stays
  in force), and
  [minimize-provider-boundaries](/.agents/tasks/architecture/minimize-provider-boundaries/README.md)
  (the neutral seam a solution must not undo).

## Open questions

A review found two defects after the split shipped. The operator deferred both:

> 「1和2都很窄，加日志，然后写进task 记录的open-question，本次不修。遇到问题了我再拉task和日志去考虑怎么修。」

and then reversed for the first, once it turned out to be small:

> 「第一个这个判空去掉就好了吧？」

That one is therefore fixed, not open: a codex native turn no submission ever
bound displayed its activity and had its end refused, so it opened a card
nothing could close. Its end now displays like its activity already did, because
a card belongs to no turn — see `final.md` § As built, departure 7, for the
requirement rules that authorise it and the three guards it distinguishes.

The one below stands, instrumented instead of fixed. It is written for whoever
arrives with a wrongly-ended card and no memory of this task. Its log is pino
JSON in `~/.dreamux/logs/dreamux-server.log` under `"name":"server"` — every
dispatcher service shares that one logger, so there is no `dispatcher_id` on the
line; the agent is named by the line's own `teammate` field.

### Core's synthesized failed end lands on a live card

**Scenario.** `classifySteerFailure`
(`packages/agent-runtime/claude-code/src/admission-classify.ts:12-23`) falls
through to `{ status: 'ambiguous' }` for any unclassified error that is not a
stop (`:23`), so an ordinary steer
hiccup makes Core end the agent's display as failed
(`teammate-service/index.ts:272-273`) while that turn keeps running. The
operator sees an error and a closed card, and then a second card that finishes
normally. Before this task a failed admission published nothing, so it could not
reach a live card at all.

**Why it is possible.** `projectFailedEnd`
(`teammate-service/index.ts:322-341`) knows the entity, not what else is running
on it. The design's *Known risks* already names the class — "A stale native turn
can close a fresh card"; the concrete steer path is what is new. Reopening the
card is not a repair here, the way it is for an end that merely arrived early:
what the operator already saw is 任务失败 and an error line for a turn that was
running fine, and no later card retracts that.

**What to grep.** `ending the agent display as failed for an input no runtime
accepted`, and read the `unsettled_turn` field:

- `unsettled_turn: true` is the defect. A non-`submitted` admission never
  retains a turn of its own (`turn-coordinator.ts:56-57` returns
  `admissionWithoutTurn` without calling `attachSubmission`), so a `true` here
  means *another* submission's turn was still live and this end closed its card.
- `unsettled_turn: false` is the ordinary case: nothing else was running, and
  ending the agent's display is exactly right.

The flag counts Dreamux-bound turns only, so a codex native turn no submission
bound reads `false`. The `reason` field cannot separate `failed` from
`ambiguous` — both carry the runtime's error message — which is why the flag,
not the status, is the discriminator.

## Development approval

- Status: Not granted.
- Approved implementation boundary: None.

## Delivery

- Pull request / CI / merge: Question 3 (anti-leak infrastructure) ships in
  [PR #367](https://github.com/excitedjs/dreamux/pull/367), all checks green,
  awaiting review. It depends on none of the design above.
  Two things PR #367 cannot verify before merge, named in its body: the
  `release.yml` step is only exercised by the next real release (watch the
  "Install gitleaks" step and the version-bump commit passing the hook).
  The display split itself is implemented on
  `refactor/split-display-from-pushback` with five Rush change files; no PR
  opened yet.
- Knowledge closeout: Pending.
