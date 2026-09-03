# Verification

## Implementation scope

- The change stays within `dreamux-types`, Dreamux core, the built-in Claude
  and Codex runtime providers, the Feishu Channel, affected tests, and Rush
  change metadata. It does not change Feishu transport, configuration,
  persistence, or dependency surfaces. It does change how projected text renders
  host paths, and it adds one resolved value to the dispatcher composition; no
  path *contract* — none of the host-owned builders in `platform/paths.ts` —
  changed.
- (Superseded 2026-09-03: a provider keeps no display state, so it reports an
  end from the native terminal it observed and again, without asking whether a
  turn was open, when it tears down a live native session; Core reports one of
  its own for an input no runtime accepted. One Dreamux-owned native turn
  therefore no longer means one fact — the Channel ignores an end with nothing
  open — and the fact also carries the producer's own reason beside the actor
  and terminal status. See
  [split-streaming-display-from-pushback](/.agents/tasks/architecture/split-streaming-display-from-pushback/README.md).)
  The runtime and core expose one provider-neutral native-turn-ended fact per
  Dreamux-owned native turn. The fact carries only the actor and terminal
  status; it does not expose folded logical submissions, presentation targets,
  or Feishu concepts.
- The Feishu Channel owns one session-memory standing anchor and at most one
  open card per channel-facing TeamLeader or Dispatcher. Feishu targets are
  anchor attributes rather than presentation identities.
- A successfully admitted Channel inbound replaces the recipient's anchor.
  Reply does not affect COT presentation. A visible bind card initializes only
  an anchorless TeamLeader; Dispatcher presentation starts with its first
  successfully admitted Channel inbound.
- With an anchor, ordinary supported facts append to the open card or open a
  new card when none is open. There is no source whitelist and no body
  suppression: the body of the message this Channel submitted displays like any
  other input.
- Card create or append failure abandons only that card attempt and leaves the
  standing anchor eligible for the next opening activity. Native-turn-ended
  closes only an already-open card and is ignored when no card is open.
- Logical submission settlement does not close a card. Closing, route fences,
  session close, and runtime generation fences prevent retired state from
  being revived.

## Focused coverage

- Claude and Codex runtime suites cover native-turn-ended emission for
  completion, failure, interruption, folding, teardown, and fail-open sink
  errors. (Superseded 2026-09-03: the three throwing-sink tests are deleted
  with the provider-side guard they exercised — two in the Claude submissions
  suite, one in the codex runtime suite. `AgentRuntimeActivitySink` now states
  that the sink never throws: Core's conversation projection catches and logs a
  projection failure itself, so a provider calls it bare and there is no branch
  left to exercise. See
  [split-streaming-display-from-pushback](/.agents/tasks/architecture/split-streaming-display-from-pushback/README.md).) One terminal `result` reports one end; a resident Claude execution
  window that answers several commands in sequence reports one end per result;
  a synthesized end is reported only by the call that actually settled a
  still-open submission, so an ordinary success reports exactly one end.
  (Superseded 2026-09-03: the provider display state that made the synthesized
  end at-most-once is deleted, so a teardown reports an end without asking
  whether a turn was open — an ordinary success followed by `stop()` reports
  the completed end and then an interrupted one, which the Channel ignores
  because nothing is open. See
  [split-streaming-display-from-pushback](/.agents/tasks/architecture/split-streaming-display-from-pushback/README.md).)
- Dreamux type and core suites cover the neutral event shape, closed event
  catalog, actor-only projection, runtime-generation fencing, and unchanged
  admission/completion behavior.
- Feishu adapter tests run the same anchor and card lifecycle contract for
  TeamLeader and Dispatcher, including global recipient identity across target
  changes, post-admission anchor replacement, default source display, narrow
  no-anchor suppression, memory-only reset, bind-card
  initialization, route and Team lifecycle fences, and logical-settlement
  non-terminal behavior. A user body displays like any other projected input.
- Feishu delivery tests exercise the real session seam for accepted Team
  delivery, the single proven-no-admission Dispatcher fallback, rejection and
  ambiguous outcomes, and Reply's presentation no-op contract.
- Regression tests specifically cover create and append failure followed by a
  successful retry at the same standing anchor, plus native-turn-ended arriving
  with an anchor but no open card and leaving the next ordinary activity able
  to open a card.

## Path projection coverage

`packages/dreamux/tests/cot-projection-privacy.test.ts` pins the boundary rules
that decide when a known prefix is really the head of a path:

- a home prefix inside a `file://` URL renames; a doubled filesystem separator
  such as `/mnt/backup//<home>/x` does not, because only an exact `://` counts
  as a scheme boundary;
- a trailing period is prose punctuation only when what follows it is itself a
  boundary, so `see <home>.` renames while `<home>.bak/notes.md` stays verbatim;
- a workspace-adjacent sibling the workspace prefix declines still renames
  through the containing home prefix — `<workspace>.git/config` reads
  `~/work/repo.git/config`, never the raw home path and never `..git/config`;
- a longer name that merely starts with the same characters (`<home>xyz`,
  `<home>-old`, another account's directory) is untouched;
- with no resolvable host home, workspace renaming still works and nothing is
  renamed to `~`.

Ordering, not a second ownership rule, is what makes the longest prefix win: the
workspace pass runs first and rewrites the positions it claims, so the home pass
only ever sees positions the workspace declined. An earlier attempt to add an
explicit shadowing rule was rejected in pre-review because it suppressed correct
home renames at exactly those positions and published the operator's raw home
path instead.

## TeamLeader pre-review checks

The 2026-09-02 simplification round repeated the whole set below after each of
its two correction cycles, and the TeamLeader additionally probed the compiled
projection directly for the path-boundary cases rather than reading the diff for
them. Both cycles were opened by a TeamLeader finding, not by a failing check —
a full green suite is not evidence that a boundary rule is right.

### 2026-09-01 corrective round

- `node common/scripts/install-run-rush.js build` — passed.
- `node common/scripts/install-run-rush.js lint` — passed.
- `DREAMUX_SKIP_LIVE_CODEX=1 node common/scripts/install-run-rush.js test` —
  passed. The real Codex live suite was intentionally skipped; all other
  affected package suites passed.
- Source and test TypeScript checks for `dreamux-types`, Dreamux core, both
  built-in runtime providers, and the Feishu Channel — passed with `--noEmit`.
- `node common/scripts/install-run-rush.js change --verify` — passed.
- `git diff --check` — passed before and after rebasing onto the current
  `origin/next`; the rebase changed knowledge files only and introduced no
  product-code conflict.

## Accepted best-effort losses

- A fact synchronously projected before steer or queue success returns may be
  appended to the predecessor card or discarded when no anchor exists. The
  Channel does not buffer, reorder, or add a private/public correlation
  contract for this window. This is also why no body suppression exists: the
  body of this Channel's own inbound is exactly such a fact.
- An exceptionally early native-turn-ended fact may be ignored before the
  post-admission receipt card opens, leaving that card open until a later
  anchor replacement or session close.
- A tool result that crosses an anchor replacement may be discarded rather
  than migrated between cards.
- Feishu transport failures may leave acknowledged platform state imperfect;
  presentation remains fail-open and memory-only rather than adding durable
  recovery or replay.
- A card whose create or append is still in flight when the session closes may be
  abandoned unfinished. A single COT operation may run up to
  `FEISHU_COT_OPERATION_TIMEOUT_MS` (20s) while `close()` drains for
  `FEISHU_COT_CLOSE_DRAIN_MS` (5s) before aborting, so a slow request is cut off
  rather than completed and the card stays visually running with nothing in
  session memory that remembers it. This is structural rather than exceptional,
  because the drain budget is shorter than one operation's own deadline.
  Presentation stays fail-open and memory-only rather than adding durable
  close-out or replay; bounding it properly would mean letting the closing
  writes finish outside the aborted controller, which is a design change this
  task does not carry.
- A submission Core disproves leaves a spent card on the message that produced
  no turn: the receipt was already written when the Channel took the anchor, so
  retiring it closes that card as interrupted rather than erasing it. The
  proven-no-admission Dispatcher fallback shows it most clearly — one dead card
  under the operator's message and one live card beside it. This is the
  structural cost of taking the anchor before calling Core, which is what
  removes the predecessor-card losses in the first place; the alternative is to
  wait for Core again and get those back. Retiring deliberately leaves the
  recipient anchorless rather than restoring the previous anchor: that card is
  already closed, so restoring its anchor would only make the next activity open
  a fresh card under an older message.
- (Superseded 2026-09-02: the optional `nativeTurn` sink is deleted; the end
  arrives as a `turn.ended` member of the single activity sink. See
  [split-streaming-display-from-pushback](/.agents/tasks/architecture/split-streaming-display-from-pushback/README.md).)
  An Agent Runtime provider that does not implement the optional `nativeTurn`
  sink publishes no native-turn end, so a COT card for that provider opens and
  never closes until an anchor replacement or session close. Both built-in
  providers implement it. Core deliberately derives no fallback from
  `teammate.turn.settled`, because a settlement is per logical submission and a
  native turn is not; the alternative would reintroduce the repeated closing this
  task removed. The seam stays optional so its absence cannot break a provider —
  the cost falls on presentation only, which is the same fail-open rule the rest
  of this path follows.

## Remaining gates

- Implementation: complete. The 2026-09-01 corrective round and the 2026-09-02
  simplification round both passed TeamLeader pre-review.
- Knowledge closeout and `.agents/scripts/check.sh`: complete. The accepted
  decision record carries the corrected-lifecycle amendment, and
  [`domains/channel.md`](/.agents/domains/channel.md) and
  [`domains/provider-runtime.md`](/.agents/domains/provider-runtime.md) state the
  recipient-keyed card model and the leased native-turn seam.
- Commit, push, and CI: done. Pushed to `fix/feishu-cot-mid-turn-card` for draft
  pull request [#357](https://github.com/excitedjs/dreamux/pull/357); CI is 8/8
  green on that head.
- Independent implementation review: approved.
- Real Codex live validation: not rerun in this environment; the explicit skip
  is recorded above.
- Marking the pull request ready and merging: authorized by the operator and
  carried out by the TeamLeader.
