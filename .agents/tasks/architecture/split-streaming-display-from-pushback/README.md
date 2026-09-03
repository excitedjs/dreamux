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
- Blockers: None. Questions 1, 1b and 2 are answered and question 3 is
  implemented, so the solution they gated is built rather than pending.
- Next action: Operator review of three things the implementation decided.
  The design had explicitly left the first two to a ruling; the third is a
  review-time deletion made without one.
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
  3. **The provider-side guard around the activity sink is deleted without a
     ruling** (commit `34208cdf`). `AgentRuntimeActivitySink` now states that
     the sink never throws — Core's `createConversationProjection` wraps every
     call — so the try/catch in both providers defended no named scenario and
     the tests that forged a throwing sink went with it. Its own commit, so one
     revert drops it. The two display-state rulings of 2026-09-03 that the
     rest of the branch rests on are recorded verbatim in `requirement.md`
     § Ruling on display state.

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

A review raised two things after the split shipped. The operator deferred both:

> 「1和2都很窄，加日志，然后写进task 记录的open-question，本次不修。遇到问题了我再拉task和日志去考虑怎么修。」

and then reversed for the first, once it turned out to be small:

> 「第一个这个判空去掉就好了吧？」

That one was a real defect and is fixed, not open: a codex native turn no
submission ever bound displayed its activity and had its end refused, so it
opened a card nothing could close. Its end now displays like its activity
already did, because a card belongs to no turn — see `requirement.md`
§ Ruling on display state for the rule that authorises it, and
`final.md` § As built, departure 7, for the gate table that shows what no
longer stands in front of the end.

The second is not a defect at all; the operator ruled the behaviour intended,
and it stays here as an observation with the log the operator asked for. It is written for
whoever meets a 任务失败 card and wants to know whether something is broken. That
log is pino JSON in `~/.dreamux/logs/dreamux-server.log` under `"name":"server"`
— every dispatcher service shares that one logger, so there is no
`dispatcher_id` on the line; the agent is named by the line's own `teammate`
field.

### A failed end closes the open card, and a live turn then opens a second one

> 「不,那几个情况就把卡置成失败。说的就是唯一开着的卡,不是当前输入开的那张新卡。所有的卡都是当前teammate 自己的,没有别人的。这个先加日志吧。」

**What is displayed.** Every card belongs to this TeamMate, one at a time, and
ruling 4 is about that one open card — not about a card the failing input
opened. When an input reaches no runtime, Core ends the open card as failed
(`teammate-service/index.ts:272-273`) and says why. If a turn happens to still
be running, it keeps producing afterwards, and rule 8 of the COT product model
opens a **new** card at the same anchor for the rest of it. So the reader sees a
任务失败 card followed by a card that finishes normally. That is the display
model working as specified, and this note exists so nobody later reads it as a
bug and "fixes" it. Separating the display line from the push-back line (see
`final.md` departure 7) does not change this and does not need to: that end is
Core's own, synthesized for an input **no runtime ever accepted**, so there is
no provider terminal to move it onto. The two lines each report a fact that is
true — the submission failed, and a native turn really is running — and the two
cards are those two facts.

**Two paths that reach it.**

- An unclassified steer error. `classifySteerFailure`
  (`packages/agent-runtime/claude-code/src/admission-classify.ts:12-23`) falls
  through to `{ status: 'ambiguous' }` for any error that is not a stop (`:23`),
  and an `ambiguous` admission ends the display as failed carrying the runtime's
  own message.
- A close that overtakes an accepted input. An inbound that passed
  `enterOrdinaryMutation` and then met `phase = 'closing'` — set synchronously
  at `index.ts:554` — reaches a runtime that is stopping or already gone, so the
  admission is `stopped` and the card ends failed with "the agent runtime is not
  running" (`turn-recording.ts:239`). That input genuinely never reached a
  runtime, so the failed end is exactly right.

**What to grep.** `ending the agent display as failed for an input no runtime
accepted`, and read the `unsettled_turn` field:

- `unsettled_turn: false` — nothing else was running. The card closes and stays
  closed until the next input opens one.
- `unsettled_turn: true` — a submission's turn was still live, so the second
  card is expected rather than surprising. A non-`submitted` admission never
  retains a turn of its own (`turn-coordinator.ts:56-57` returns
  `admissionWithoutTurn` without calling `attachSubmission`), so the flag is
  only ever about work that was already running.

The flag counts Dreamux-bound turns only, so a codex native turn no submission
bound reads `false`. The `reason` field cannot separate `failed` from
`ambiguous` — both carry the runtime's error message — which is why the flag,
not the status, is what says which shape to expect.

## Development approval

- Status: Not granted.
- Approved implementation boundary: None.

## Delivery

- Pull request / CI / merge: [PR #367](https://github.com/excitedjs/dreamux/pull/367)
  carries both halves — the display split and question 3's anti-leak
  infrastructure, which depends on none of the design above — all checks green,
  awaiting review.
  One thing PR #367 still cannot verify before merge, named in its body: the
  `release.yml` step is only exercised by the next real release (watch the
  "Install gitleaks" step and the version-bump commit passing the hook). The
  other — the new `internal-content` job and the rewritten `gitleaks` job,
  which `ci.yml` runs on this branch only through the pull request — ran green
  on the PR itself.
  The display split ships in the same PR: #367 carries it on
  `refactor/split-display-from-pushback` with five Rush change files, alongside
  the anti-leak gate's one.
- Follow-up fix (2026-09-03, branch `fix/leader-start-failure-display`): after
  #367 merged, a TeamLeader whose codex could not start left its Feishu card on
  the opening label with no error. Every TeamLeader path pre-started the leader
  in `TeamService.ensureRouteReady()`, outside the entity's announce/end span,
  so the start failure reached no display. The operator's directive:

  > 这两个问题都修一下，找一个合适的时机把错误信息也放进ended 事件里丢给 channel，让他能反映出 provider 的真实报错 第二个是在 codex 如果精确命中了 no rollout found 错误，就丢弃 resume 语义拉起一个新的 对话来

  The first half is built by deleting `ensureRouteReady()` — no new event or
  field: the entity's existing failed `turn.ended` already carries the
  provider's error, and the leader paths now reach it. Departure 10 of
  `technical-design/final.md` is corrected in place. The second half (codex,
  fresh thread on an exact "no rollout found") was withheld on the operator's
  own words, and stays open:

  > 哎不对，我想一下，第二个问题的修法不一定是这样。
- Knowledge closeout: Pending.
