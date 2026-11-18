# Verification

## Authorized live native-post probe

On 2026-11-18, using the development card's explicit live-probe authorization,
a generated non-sensitive PNG was uploaded through `lark-cli im images create`
as the bot. An exact native `post` message with one `md` node was then replied
into the originating conversation. Its Markdown placed the uploaded image key
between two explanatory paragraphs.

The upload and reply APIs both returned success. The operator then visually accepted the inline rendering and placement:

> 没有任何问题。显示非常完美

This establishes that the approved native `post + md` envelope renders an uploaded image key inline between paragraphs. No real image key, message id, chat id, or credential is recorded here.

## Interactive and artifact probes

On 2026-11-18 the authorized interactive Card 2.0 probe, using the same single
Markdown element and uploaded image key shape as ordinary Dreamux replies, was
accepted by Feishu. The operator observed unexpected blank lines between the
image and adjacent paragraphs:

> Interactive 的图片和上下文字之间出现了奇怪的空行。

A follow-up interactive probe with one newline rather than a blank line on each
side of the image was accepted by Feishu. The operator observed no blank line
above the image and one below it, attributed the difference to native-post
versus card rendering, and explicitly ruled:

> 看起来图片上面没有空行，下面有一个空行。应该是post和卡片之间的渲染差异。先不处理了

No spacing normalization was added. This is an accepted rendering difference,
not an unresolved implementation blocker.

A generated valid one-second MP4 first established a real file-message mapping
failure: uploading it as `file_type: "mp4"` and sending `msg_type: "file"` was
rejected with platform code 230055 because the upload type did not match the
message type. Uploading the same bytes as `file_type: "stream"` and sending the
same native file message succeeded. The implementation and tests were corrected
to use `stream` for MP4 artifacts; this preserves the approved downloadable-file
behavior and does not introduce media preview. A generated ZIP was also
successfully delivered as a native file message.

No real resource key, platform log id, message id, chat id, or credential is
recorded here.

## Independent implementation review

On 2026-11-18 the operator approved entry to review. Devbox was asked in the
originating conversation to inspect the complete uncommitted diff against the
approved requirement, final solution, and repository engineering guidance. The
requested coverage explicitly includes source, tests, documentation, reply-only
configuration scope, Markdown source replacement, upload/send ordering, partial
receipts, and the corrected MP4 mapping.

The operator then clarified that Devbox is on a different machine and can review
only a published PR. The task is blocked pending that PR's independent review;
the local review request alone is not evidence of review coverage.

## Local checks

The implementation TeamMate ran the monorepo gates before the MP4 mapping
correction:

- `node common/scripts/install-run-rush.js build` — passed.
- `node common/scripts/install-run-rush.js lint` — passed.
- `node common/scripts/install-run-rush.js typecheck:tests` — passed.
- `node common/scripts/install-run-rush.js test` — passed; transport 235 tests,
  channel 875 tests, and Dreamux 1279 tests passed, with 6 default-gated native
  model cases skipped.
- Targeted transport/channel tests also passed.
- `.agents/scripts/check.sh` — only the expected in-flight task-state rejection
  remained; Markdown-link and binary-artifact issues were resolved.

After the MP4 correction, the TeamLeader reran the complete monorepo sequence:

```bash
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js lint
node common/scripts/install-run-rush.js test
node common/scripts/install-run-rush.js typecheck:tests
```

All four commands completed successfully in one exit-0 sequence. The test stage
completed with warnings only for the default-gated live Codex/model cases
described above; it did not certify those excluded native model behaviors.
`git diff --check` also passed.
