# Verification

## TeamLeader pre-review (2026-09-16)

Baseline: `origin/next` at `0b35a6a8`, plus the uncommitted implementation by the
single developer TeamMate.

Diff inspected against the final solution:

- §1: `ASK_USER_CARD_TTL_MS` is `24 * 60 * 60 * 1000`; its comment states what
  the timer is for and the 14-day message-patch bound; the `expiredText()`
  comment no longer states the 15-minute premise.
- §2: `text` is in the input schema between `message_id` and `questions`, parsed
  with `optionalString`, passed through the handler, the session type, and
  `askUserQuestion` to `AskUserRegistry.open({ text?, questions })`. The round
  stores it; the repaint view is `{ ...round }`, so picks and free-text repaints
  keep it. `buildAskUserCard`, `buildAskUserSubmittedCard`, and
  `buildAskUserClosedCard(reason, text?)` prepend one `markdown` element only
  when `text` is present. The tool description gains the usage note, and the
  file header counts five differing fields. `ask_user_question`'s output,
  `next`, and settlement texts are unchanged.
- §3: the 15-minute test is replaced by one pinning 24 hours, the 14-day bound,
  and the timer delay; tests cover the explanation as a pure insertion on the
  live, pick, free-text, cleared, submitted, cancelled, and expired cards, its
  absence from submitted, cancelled, and expired settlement text, parse and
  handler pass-through, empty values (`undefined`, `null`, `''`), the schema key
  order, and the card handed to `sendCard`.
- §4: the `feishu-session-mcp.ts` header comment now says a thrown error reaches
  the model with its own code and message. A minor change file is added.
- Nothing outside `packages/channel/feishu-channel/` and
  `common/changes/@excitedjs/feishu-channel/` changed.

Commands, run by the TeamLeader from the repository root:

| Command | Result |
| --- | --- |
| `node common/scripts/install-run-rush.js build` | 8 operations skipped as up to date after the developer's build of the same sources |
| `node common/scripts/install-run-rush.js lint` | SUCCESS 7, NO OP 1 |
| `node common/scripts/install-run-rush.js typecheck:tests` | SUCCESS 7, NO OP 1 |
| `node common/scripts/install-run-rush.js test` | SUCCESS 4, SUCCESS WITH WARNINGS 3 (expected stderr from runtime-package failure-path tests), NO OP 1; no failures |

Finding sent back to the developer: the change-file note did not name
`ask_user_question` or `text`. Fixed in the change file only; the rewritten note
names the tool and argument, the rendering, the finished cards, and that the
model's answer does not repeat the explanation.

## Independent implementation review (2026-09-16)

External review of the pushed branch (commit `2f05d1c6` on `next` `0b35a6a8`),
used in place of the workflow review for this group's tasks. Verdict: approved,
no blocking code finding
([comment](https://github.com/excitedjs/dreamux/issues/435#issuecomment-5697040277)).
Beyond reading the diff, the reviewer ran the card builders from `next` and the
branch side by side and compared serialized JSON for the live (partly answered),
submitted (including unanswered), cancelled, and expired cards without `text`:
identical. Through the real registry it checked the explanation is exactly one
prepended `markdown` element on seven card states and is absent, mention
included, from all three settlement texts.

| Finding | Verdict | Reason | Conflicts with an operator ruling |
| --- | --- | --- | --- |
| Knowledge updates from final.md §4 are not in the commit and must ride the same PR | Accept | Planned closeout; done in `channel.md` and the product catalog before the PR, with `check.sh` | No |
| Optional: `askUserQuestion` passes the whole input (with `chatId`, `messageId`) to `registry.open` instead of `{ text, questions }` | Reject | The registry's declared parameter type is the boundary and it destructures only `text` and `questions`; there is no behavior difference and no failure scenario, and the reviewer marked it optional | No |

## Knowledge closeout checks

| Command | Result |
| --- | --- |
| `.agents/scripts/check.sh` | Task records OK: 43 checked; KB OK (270 files reachable from root.md) |
| `git diff --check` | Clean |

## Not covered locally

- Feishu client rendering of `text` (heading, list, mention) and whether a
  mention in a question card notifies.
- A click more than two hours after sending, and the 24-hour expiry repaint on a
  real card; the expiry is covered by the unit timer seam only.
- `rush change --verify`, which counts only committed change files; it runs in
  CI after the commit.
