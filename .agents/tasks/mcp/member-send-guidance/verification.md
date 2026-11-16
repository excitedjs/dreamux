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

- Only a turn's final assistant message reaches the owner. Codex reads the last
  `agentMessage` item (`events.ts`, `extractAssistantText`); Claude Code reads
  the `result` text with a last-assistant-text fallback (`stream.ts`,
  `outcome()`).
- Codex marks intermediate assistant messages `phase: "commentary"`
  (app-server `AgentMessage.phase`); the adapter reads their text as display
  activity and never selects one as the result. So mid-turn narration is
  visible on the conversation display and absent from the owner's context.
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

## Not verified

- **No live-model measurement.** This is guidance, not enforcement. The change
  rests on the observed cause — two texts that never stated the condition —
  not on a claim that a model will now comply. The next Team whose members
  narrate progress is the measurement, and it has not been run.
- **No probe of the peer path** beyond reading its source and the existing
  test's `notices(ownerRuntime)).toEqual([])` assertion.
