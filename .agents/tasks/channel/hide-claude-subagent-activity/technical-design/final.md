# Final technical solution

## Authority and path

Input: [requirement revision 2026-09-17](/.agents/tasks/channel/hide-claude-subagent-activity/requirement.md).
The operator selected the minimal-change fast path. The TeamLeader implements;
one independent reviewer (the Devbox seat) examines the whole diff on the pull
request. No proposal agents and no solution-review Issue.

## Change

1. In [runtime-activity.ts](/packages/agent-runtime/claude-code/src/runtime-activity.ts)
   `emitStreamActivity`, after the `compact_boundary` branch, return without
   emitting when `line.raw['parent_tool_use_id'] != null`. The check is on the
   envelope, before any block is read, so a subagent's text, `tool_use`, and
   `tool_result` blocks are all dropped and a subagent call never enters the
   `tools` correlation map. `!= null` keeps envelopes from builds that omit the
   field, and matches the existing main-context read in
   [stream.ts](/packages/agent-runtime/claude-code/src/stream.ts).
2. Extend the function's doc comment: a subagent's envelopes are not the agent's
   conversation, and the main agent's own `Agent` call stays.
3. Add tests to
   [runtime-activity.test.ts](/packages/agent-runtime/claude-code/tests/runtime-activity.test.ts)
   using the probed wire shape: a main `Agent` call, then subagent `assistant`
   (text and `tool_use`) and `user` (`tool_result`) envelopes carrying the
   call's id, then the main `Agent` result. Only the two main rows are emitted,
   and the result row still resolves to `Agent`.

## Considered and rejected

- **Filter in `rpc.ts` `onLine`.** The RPC decides which envelope kinds reach
  the display line, but the operator's ruling is about what is *reported*, and
  `runtime-activity.ts` already owns envelope meaning (it hides every `user`
  text block). Filtering in the RPC would also need the check in two `case`
  arms.
- **A typed `parentToolUseId` field on parsed `assistant`/`user` lines.** It
  would move the one-key read from two consumers (context tokens, display) into
  the parser without removing a concept, and widen the diff into `types.ts`,
  `stream.ts`, and every test fixture that builds a line.
- **Classify subagent envelopes as `other` at parse time.** It would also stop
  `TurnAggregator` from reading a background subagent's text into its fallback
  `lastAssistantText` — a completion-text behavior change the operator did not
  ask for. Recorded in the research document instead.

## Knowledge and release

- [provider-runtime.md](/.agents/domains/provider-runtime.md), "Claude Code
  Stream-Json Envelopes On The Display Line": state that subagent envelopes are
  excluded, and drop the item from the deferred-divergence list.
- [Product catalog](/.agents/product/README.md), "Observing agents": a
  subagent's activity is not the agent speaking.
- [claude-code-stream-json-protocol](/.agents/research/claude-code-stream-json-protocol.md):
  row 4 becomes promoted and fixed; record the probe fact that a background
  subagent's text arrives without `--forward-subagent-text`, and the untouched
  `lastAssistantText` observation.
- A patch change file for `@excitedjs/agent-runtime-claude-code`. No config,
  state, or maintenance-skill change.

## Verification

- `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`, and
  `.agents/scripts/check.sh`.
- Coverage limit: the probe exercised the raw CLI, not a Dreamux-launched
  resident session, and the Feishu card is not observed before merge.
