# Verification

## Implementation scope

- The change stays within `dreamux-types`, Dreamux core, the built-in Claude
  and Codex runtime providers, the Feishu Channel, affected tests, and Rush
  change metadata. It does not change Feishu transport, configuration,
  persistence, dependency, path, or service surfaces.
- The runtime and core expose one provider-neutral native-turn-ended fact per
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
  new card when none is open. There is no source whitelist. The exact inbound
  body already visible at the anchor is suppressed on a best-effort basis.
- Card create or append failure abandons only that card attempt and leaves the
  standing anchor eligible for the next opening activity. Native-turn-ended
  closes only an already-open card and is ignored when no card is open.
- Logical submission settlement does not close a card. Closing, route fences,
  session close, and runtime generation fences prevent retired state from
  being revived.

## Focused coverage

- Claude and Codex runtime suites cover exactly-once native-turn-ended emission
  for completion, failure, interruption, folding, teardown, duplicate terminal
  input, and fail-open sink errors.
- Dreamux type and core suites cover the neutral event shape, closed event
  catalog, actor-only projection, runtime-generation fencing, and unchanged
  admission/completion behavior.
- Feishu adapter tests run the same anchor and card lifecycle contract for
  TeamLeader and Dispatcher, including global recipient identity across target
  changes, post-admission anchor replacement, default source display, narrow
  body suppression, no-anchor suppression, memory-only reset, bind-card
  initialization, route and Team lifecycle fences, and logical-settlement
  non-terminal behavior.
- Feishu delivery tests exercise the real session seam for accepted Team
  delivery, the single proven-no-admission Dispatcher fallback, rejection and
  ambiguous outcomes, and Reply's presentation no-op contract.
- Regression tests specifically cover create and append failure followed by a
  successful retry at the same standing anchor, plus native-turn-ended arriving
  with an anchor but no open card and leaving the next ordinary activity able
  to open a card.

## TeamLeader pre-review checks

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
  contract for this window.
- An exceptionally early native-turn-ended fact may be ignored before the
  post-admission receipt card opens, leaving that card open until a later
  anchor replacement or session close.
- A tool result that crosses an anchor replacement may be discarded rather
  than migrated between cards.
- Feishu transport failures may leave acknowledged platform state imperfect;
  presentation remains fail-open and memory-only rather than adding durable
  recovery or replay.

## Remaining gates

- Independent implementation review: in progress after the rebase.
- Knowledge closeout and `.agents/scripts/check.sh`: pending review
  adjudication.
- Real Codex live validation: not rerun in this environment; the explicit skip
  is recorded above.
- Commit, push, pull request, CI, and merge: not started.
