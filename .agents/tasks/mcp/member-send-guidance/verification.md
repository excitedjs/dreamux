# Verification

## Gates

Run on 2026-11-16 from the branch worktree, all four with exit 0:

- `node common/scripts/install-run-rush.js build` — SUCCESS. One operation
  rebuilt; the other eight were cache hits (`SKIPPED`).
- `node common/scripts/install-run-rush.js lint` — SUCCESS, 9 operations.
- `node common/scripts/install-run-rush.js test` — SUCCESS across the eight
  operations that define tests. `@excitedjs/dreamux` completed with warnings:
  the only stderr is the live-model cases announcing their own exclusion
  (`DREAMUX_RUN_LIVE_MODEL_GATE` unset), which is the suite's normal
  non-certifying state and not a failure of this change.
- `node common/scripts/install-run-rush.js typecheck:tests` — SUCCESS.

`npx prettier --check` on both touched files passed.

## Built artifact

Both new strings are present in the compiled output, so the change reaches a
launched member rather than stopping at source:

- `packages/dreamux/dist/service/agent/system-prompt.js` contains the delivery
  lead-in.
- `packages/dreamux/dist/service/agent/member-mcp.js` contains the `send`
  condition.

## Existing tests that touch these surfaces

- `packages/dreamux/tests/teammate-system-prompt.test.ts` asserts prompt order
  and that the owner sentence contains the owner name, using
  `stringContaining`. It passed unedited, as it must: the change alters prose,
  not position or the owner address.
- `packages/dreamux/tests/member-messaging.test.ts` pins the receipt text with a
  loose regex over `Message submitted.` plus the admission sentence. It passed
  unedited; the receipt is untouched.
- `packages/dreamux/tests/mcp-tool-descriptions.test.ts` walks the owner
  catalogs only. The ordinary-member catalog has no description assertion, so
  this change adds none — per
  [model-facing writing](/.agents/domains/model-facing-writing.md), prose
  should not be pinned by exact-sentence tests.

## What was checked against source before writing the text

Each claim in the new wording was verified rather than inferred:

- **Only a completed turn's final message can reach the owner, and it may be
  absent even then.** Codex reads the last `agentMessage` item and returns null
  when there is none (`events.ts`, `extractAssistantText`); Claude Code reads
  the `result` text with a last-assistant-text fallback and maps an empty result
  to null (`stream.ts`, `rpc.ts`). Core then hard-codes `result: null` for a
  `failed` or `stopped` turn (`service/agent/service.ts`, the `deliverRuntime`
  call), and the `failed` variant of `RuntimeCompletion` has no `resultText`
  field at all. The owner therefore receives `"…turn failed."` with an empty
  body, pinned by `completion-renderer.test.ts`. This is why the shipped text
  says the *outcome* is reported and a completed turn's final message is *what
  that report delivers* — the earlier draft's unconditional "your final message
  is what reaches it" promised a delivery the failed path does not perform,
  "a completed turn carries your final message as that report" was still false
  for a completed turn whose text is null, and "is the text that report carries"
  was false for a result long enough to be spilled to a file, where the report
  carries the path. "Delivers" holds in all three shapes.
- **Selection is by order, not by a phase filter.** The codex adapter reads the
  last `agentMessage` item and never inspects `AgentMessage.phase`; nothing in
  `packages/agent-runtime/codex/src/` reads that field. Commentary items precede
  the final answer in practice, so the last item is the final answer in the
  observed shape — but that is an ordering fact, not a filter. An earlier draft
  of this page claimed a phase filter; it does not exist.
- Intermediate commentary still reaches the conversation display as
  `assistant.message` activity, which is a separate consumer from the owner's
  context.
- `teammate.send` reaches the owner through `submitInput` with the peer
  reminder; a peer-directed send goes through the collection's `send` and the
  owner is not copied.
- A send receipt is admission only; a reply needs the recipient's own send.

## Deliberate omissions

- **No peer-asymmetry sentence in the `send` description.** An earlier draft
  added "a message to a peer reaches that peer only; your owner receives that
  peer's own turn results, not this message." It is true in source, but nothing
  in the measured sample shows a member misunderstanding it, so it was dropped
  rather than carried as unrequested defense.
- **No restatement of the delivery fact in the `send` description.** The role
  prompt owns it; repeating it in the tool description would give one rule two
  owners.
- **The usage condition lives in the description, not the prompt.** An earlier
  draft stated the condition — "what that recipient needs before your turn
  ends — a blocker, a decision, or a fact that changes its next step" — on both
  surfaces, and added two imperatives to the prompt ("use it for …", "let your
  turn result carry the rest"). Both were removed after review: the duplicated
  rule violated the one-owner bullet this same change adds to
  [model-facing writing](/.agents/domains/model-facing-writing.md), and the
  imperatives contradicted the design's own "no imperative" rationale. The
  prompt now states the delivery fact and the capability; the description states
  the condition.

## Not verified

- **No live-model measurement.** This is guidance, not enforcement. The change
  rests on the observed cause — two texts that never stated the condition —
  not on a claim that a model will now comply. The next Team whose members
  narrate progress is the measurement, and it has not been run.
- **No probe of the peer path** beyond reading its source and the existing
  test's `notices(ownerRuntime)).toEqual([])` assertion.
