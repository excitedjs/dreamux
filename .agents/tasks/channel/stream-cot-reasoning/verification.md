# Verification

## Live native protocol probes

These probes used synthetic arithmetic prompts and recorded only event kinds,
relative arrival times, text lengths, and block identity relationships. Neither
reasoning content nor credentials were printed or retained in the evidence.
They verify native delivery, independently of the new Dreamux adapters.

- Claude Code with its configured Anthropic-compatible upstream and partial
  messages enabled: 1,850 thinking deltas, totaling 4,551 characters, arrived
  from 1,771ms through 9,491ms. A singleton thinking assistant snapshot arrived
  at 9,494ms before block stop(index 0). The same API message then produced a
  singleton text snapshot at block index 1; result arrived at 10,276ms.
  This confirms progressive upstream delivery and proves completed-array
  offsets cannot be used as native streamed block indices.
- Codex app-server with its configured Responses upstream: an initial probe
  received 291 summary-text deltas totaling 3,504 characters within an 88ms
  burst immediately before item completion. A second probe used unbuffered
  stdout reads to exclude the observer's text buffering: 170 deltas totaling
  2,245 characters arrived between 5,521ms and 5,526ms, immediately followed
  by reasoning item completion. All deltas used native summary index 0.
  The integration can consume increments, but this upstream delivered them
  near completion in these two runs. A 500ms channel interval can therefore
  combine them into one update; these observations do not demonstrate
  progressive wall-clock reasoning display through this upstream.
- Previous native Feishu probes in this task's conversation established API
  acceptance of reasoning events and mixed reasoning/text/tool sequences.
  The operator reported that reasoning and text looked identical in that
  client. That visual observation motivates the explicit Thinking prefix;
  it is not evidence of a distinct native folding style.

## Local checks

Both runtime providers passed targeted Rush build, lint, test and
`typecheck:tests`: Codex has 212 tests in 10 files; Claude Code has 249 tests
in 13 files. Feishu Channel passed its targeted four gates with 793 tests in
38 files.

The final full-repository Rush run passed `build`, `lint`, `test`, and
`typecheck:tests`, including installed-CLI contract checks. The optional live
model-behavior gate was not enabled; the separate native reasoning probes above
are the live upstream evidence for this change. No implementation source changed
after these four gates.

Additional Channel tests cover:

- 6,000 native increments totaling 192KB: complete text survives coalescing,
  multiple wire requests stay inside event/count/request limits, append starts
  remain at least 500ms apart, and the run terminal follows all content.
- A 384KB burst exceeds the 256KB outbox: only a trailing suffix is dropped;
  output order and wire limits remain valid, and the run terminal still arrives.
- A 4,700ms stalled append crosses the 5,000ms shutdown drain cutoff: no
  prematurely released cadence wait starts another platform append, and no
  cadence timer survives close.

The existing drop-newest policy remains best effort. With a saturated outbox,
reasoning message/section END events can also be rejected; the run terminal is
constructed outside that queue and still arrives. This does not claim complete
per-block END delivery under capacity loss or validate client rendering when
those events are missing. Close retains the existing five-second drain cap.

## Independent review

An architect independently reviewed the complete change, including the final
pressure and drain tests. No blocking functional or layering issue was found.
The review checked raw-fragment projection scope, authenticated send provenance,
native part identity, completed fallback, subagent filtering, lifecycle cleanup,
and preservation of the existing load-bearing test assertions. It also checked
that extracting the single-card writer removed the old adapter pipeline rather
than adding a second mechanism.

Core's observer now forwards the remaining native activity union directly to
its typed projection after handling result/title events. This removes a second
activity-kind list that could omit new events; an integration test proves
reasoning reaches the Channel observer before the turn settles.

Claude multi-thinking-part, abandoned/late-snapshot and snapshot-only cases
have synthetic coverage. Snapshot association follows observed native block
type and arrival order; it does not claim arbitrary out-of-order correlation.
The new Dreamux implementation has not been deployed or validated visually in a
live Feishu client; native upstream probes and synthetic integration tests prove
only their stated boundaries.
