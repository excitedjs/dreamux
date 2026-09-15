# Verification

## Gates

Run by the TeamLeader from the repository root after the implementation report,
reading the summary lines rather than the exit code:

| Gate | Result |
| --- | --- |
| `rush build` | `SKIPPED: 6` / `SUCCESS: 2`, no `FAILURE` |
| `rush lint` | `SUCCESS: 7` |
| `rush test` | `SUCCESS: 4` / `SUCCESS WITH WARNINGS: 3`, no `FAILURE` |
| `rush typecheck:tests` | `SUCCESS: 7` |

The three warning operations are the codex and claude-code runtime suites
writing to stderr while asserting error paths; they predate this change and do
not touch it.

These are the numbers after the rebase onto the trunk, and the rebase is why
they are the ones that count. Four files conflicted with the slash-command
change that landed first, all of them additive, and resolving two of them by
keeping both sides produced a `routing/document.ts` whose second doc comment had
lost its opening `/**` — the package stopped compiling, and all four gates
reported `FAILURE` on it. The same resolution had also left the routing
document's binding-versus-space invariant attached to the wrong interface; it
was moved back onto `FeishuRoutingDocument` and its opening line now names the
two sections it governs, because a third section exists now. Separately, the
trunk had gained a `yargs-parser` dependency this worktree had never installed,
so `rush update` was needed before the package could type-check at all.

## Platform facts closed by probe

The probe matrix in [`requirement.md`](./requirement.md) covers delivery. Two
further facts the implementation depends on were probed against the live app:

- **A comment thread's own comment is `reply_list.replies[0]`.** The delivered
  body has to resolve "the item this event names", and an event for a top-level
  comment carries an empty `reply_id` while the API gives that comment its own
  non-empty reply id — so the empty case cannot be resolved by lookup. A live
  `drive.fileComment.batchQuery` on a known comment returned exactly one entry,
  the comment itself, at index 0, with elements `['person', 'text_run']` — the
  two element kinds the text extractor handles. The claim in
  `transport/feishu.ts` is therefore observed, not assumed.
- **A whole-document comment carries no `quote`.** The same response returned
  `quote` absent, which is why an empty quote renders no block rather than an
  empty one.

## Not verifiable before deployment

Both need the new code running against Feishu, so they are post-merge:

- **A wiki-hosted document.** That a comment event carries the object token
  rather than the wiki node token is derived, not probed: every comment API
  takes the object token and `lark-cli` unwraps wiki tokens before calling them,
  but no probe has seen an event payload for a wiki-hosted document, because the
  daemon logs only that the event had no handler. Subscribe a wiki page,
  @-mention the bot, and confirm the event reaches the subscriber; the new
  route logs the token. If the inference is wrong, wiki subscriptions never
  fire.
- **`--as bot` keeps a thread alive.** Probe rows F1/F2 establish that Feishu
  resumes pushing a thread's replies once this bot has replied in it. That the
  reminder's instruction produces that state — a lark-cli reply posted
  `--as bot` arming later delivery — has not been walked end to end.

## Reviewed by the TeamLeader

Whole diff read before independent review. Checked and found correct: the
discriminated submission union, the composite source id, the discriminated
metadata result, `validated()` materializing `subscriptions: []`, `forgetTeam`
reporting subscriptions apart from routes, the caller-derived recipient on all
three tools, and the rewritten event-seam note. Two things were checked because
they looked wrong and were not:

- The comment text is XML-escaped rather than passed through byte for byte. The
  chat body takes the same `escapeXmlText`; Core's "no rewriting" rule governs
  what Core does to what a Channel hands it, not what the Channel renders.
- `forgetTeam` can now return routes empty and subscriptions non-empty, which
  reaches `announceRoutesRemoved` past the early return.
  `announceRoutesRemoved` iterates `removed`, so an empty list announces
  nothing.

No real Feishu identifiers, tokens, or internal hostnames appear in the change.
