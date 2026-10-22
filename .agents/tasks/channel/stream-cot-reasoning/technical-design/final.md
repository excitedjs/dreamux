# Technical solution

## Neutral live contract

Extend `RuntimeActivity` with `assistant.reasoning`: unchanged native `id`, native `partIndex`, append-only `text`, and `status: streaming | completed`. First nonempty text opens a visible block; an empty completed activity closes an existing block only. Completed means this part is closed, not turn success. The cold activity contract is unchanged.

Codex subscribes to native reasoning delta notifications. Select one carrier per item: the first nonempty delta's carrier, otherwise nonempty completed summary before content. Preserve all native indices within that carrier. Completed emits only parts that did not stream and closes streamed parts. A turn terminal closes any still-open parts.

Claude enables `--include-partial-messages`, parses `stream_event`, and observes the native API message identity and content-block index. Per-event envelope UUIDs are not stream identities. A live metadata-only probe on 2026-10-22 confirmed singleton completed assistant envelopes: the same API message produced a thinking envelope before stop(index 0) and a text envelope before stop(index 1). Therefore correlate snapshots with the active native block, never their singleton array offset. Without any partial context, a completed envelope has its own native UUID and content-array positions. Preserve existing subagent filtering and ordinary assistant mapping. Close incomplete streams at interruption, abandonment, and runtime teardown. Keep deduplication facts until the native message has definitively ended.

## Reasoning passthrough

The operator subsequently requested no chunk redaction. Core returns the reasoning activity unchanged, including completed fallback text because this contract always carries append fragments. Other activity continues through its existing redaction branches. No incremental redactor, Core stream buffer, utils change, or additional lifecycle entity is introduced.

## Feishu presentation

Add compatible optional `cot: { reasoning: boolean }` config, normalizing omission to false. Render native `REASONING_START`, `REASONING_MESSAGE_START` (role reasoning), content increments, message end, and reasoning end. Add `Thinking...` once per visible block on each presentation. Derive display IDs inside Channel from native ID and native part position. No encrypted-value event is used.

Put the 500ms cadence at the actual append boundary, covering create-triggered flushes, multiple batches, and final terminal batches. Merge only adjacent pending deltas for the same block before outbox admission, respecting existing event/request byte and count limits. Text/tool events are ordering barriers. The adapter retains recipient/card policy; a single card writer owns the existing create/append/failure pipeline together with pacing and bounded drain. The pure reasoning projector commits its open-part changes only after outbox admission. Timers participate in close/drain. Anchor replacement and append failure abandon prior presentation state; the next chunk opens a new native block with a fresh prefix and no replay.

## Sender provenance

At the existing member-to-owner `send` producer, attach `notice: {kind: teammate_message, producer: scope.name}`. This is neutral provenance; Core does not infer it from source strings or message bodies. Feishu applies the new label only to the TeamLeader recipient role. Completion notices retain their separate kind and rendering; prompt/envelope content is unchanged.

## Verification and documentation

Use synthetic fixtures, native part sequences and high-frequency bursts for provider, Core and channel tests. Run the four repository gates and the KB check. Record live protocol observations separately from mocks and client-rendering evidence. Update the provider/channel KB, product behavior catalog, Feishu maintenance configuration reference, and ordinary Rush change notes. No persisted schema becomes unreadable.
