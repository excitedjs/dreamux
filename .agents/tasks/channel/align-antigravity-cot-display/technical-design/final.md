# Final technical solution

## Decision

Keep all changes inside `@excitedjs/agent-runtime-antigravity` (`packages/agent-runtime/antigravity/src/acp/`). Add one small pure display/result module (`src/acp/tool-display.ts`, mirroring `claude-code/src/tool-display.ts` and `codex/src/tool-display.ts`) and update `src/acp/activity.ts` so Antigravity ACP projects clean tool rows, plain-text tool outputs, streamed reasoning blocks, and completed assistant messages through the existing neutral `RuntimeActivity` contract.

No runtime or type changes are made to `@excitedjs/dreamux-types` (comment-only JSDoc alignment for live-only display block IDs was ratified during review), Dreamux Core, `@excitedjs/feishu-channel`, `@excitedjs/agent-runtime-claude-code`, `@excitedjs/agent-runtime-codex`, or Antigravity `tmux` mode.

## Owning components and intended behavior

### 1. `packages/agent-runtime/antigravity/src/acp/tool-display.ts` (new pure module)

Owns Antigravity's tool-vocabulary mapping and ACP tool-result extraction with zero runtime state:

- **`toolDisplay(tool: NativeTool): ToolDisplay`** returns `{ action, summary, invocation, items }`:
  - Reads `rawInput` as a plain object when applicable (`stringField` returns non-empty strings only).
  - Resolves file path from `rawInput.Path` falling back to `tool.locations?.[0]?.path`; extracts basename handling both `/` and `\` separators (`fileBasename`).
  - Tool mapping table:
    - `read_file`: `action: 'read'`, `summary: basename`, `invocation: null`, `items: path ? [path] : []`.
    - `write_file`, `edit_file`: `action: 'edit'`, `summary: basename`, `invocation: null`, `items: path ? [path] : []`.
    - `run_command`: `action: 'run'`, `summary: toolSummary ?? firstLine(CommandLine) ?? nonEmpty(tool.title)`, `invocation: CommandLine`, `items: []`.
    - `search_web`: `action: 'search'`, `summary: query`, `invocation: null`, `items: []`.
    - `invoke_subagent`: `action: null`, `summary: Role`, `invocation: Prompt`, `items: []`.
    - `run_workflow`: `action: null`, `summary: Description`, `invocation: Script`, `items: []`.
    - Default (all `mcp_*` tools and other unmapped tools): `action: null`, `summary: toolSummary ? `${name} · ${toolSummary}` : null`, `invocation: null`, `items: []`.
  - Removing `actionFor(current.kind)` and verbatim `current.title` forwarding eliminates both the `Read File ../../../...` / `Edit File ...` double-prefix relative-path bug and the `</> Run mcp_*` misclassification at the root.
- **`toolResult(tool: NativeTool): JsonValue | null`**:
  - If `tool.content` is a non-empty array and every entry is `{ type: 'content', content: { type: 'text', text: string } }`, joins the text entries with `'\n'` and returns that plain string.
  - Otherwise, if `tool.name === 'run_command'` and `tool.rawOutput` is a plain object with string `output`, returns `rawOutput.output`.
  - Otherwise returns `(tool.rawOutput ?? null) as JsonValue | null`.
- **`isCommandExitFailure(tool: NativeTool): boolean`**:
  - Returns `true` when `tool.name === 'run_command'` and `tool.rawOutput` is a plain object whose `exit_code` is a non-zero number.
  - Raw `Path` (in `items`) and raw `CommandLine` / `Prompt` / `Script` (in `invocation`) are preserved verbatim without trimming; only display `summary` fields are trimmed.
  - Structured failures are never serialized into `error`: `activity.ts` populates `error` only when `status === 'failed' && typeof result === 'string'`, leaving structured failures on `result` so Core runs `redactJson` over secret key names and Feishu renders `event.error ?? event.result`.

### 2. `packages/agent-runtime/antigravity/src/acp/activity.ts` (updated)

Owns live ACP stream correlation, block boundaries, tool lifecycle tracking, and turn end:

- **Tool lifecycle (`tool(update)`)**:
  - Preserves existing `runningTools` and `failedTools` sets strictly on native ACP `current.status === 'failed'` / `'completed'` so `AcpRuntime.completeGroups()` permission-cancellation settlement is completely unaffected by ordinary `run_command` non-zero exit codes.
  - Merges `tool_call_update` according to ACP v1 null-preserves-previous semantics (`name`, `title`, `rawInput`, `locations` retain cached values when omitted or `null` on a partial update).
  - Before emitting a tool activity, closes any open reasoning block (`closeReasoning()`) and flushes any active assistant message (`flushCurrentMessage()`), keeping card chronology faithful.
  - Tracks `startedTools: Set<string>` to emit `status: 'started'` at most once per `toolCallId`, suppressing duplicate rows on repeated `in_progress` `tool_call_update` notifications.
  - On terminal update (`current.status === 'completed' || current.status === 'failed'`), computes display status as `'failed'` when `current.status === 'failed' || isCommandExitFailure(current)`, else `'completed'`. Passes `result: toolResult(current)` and `error: displayStatus === 'failed' && typeof result === 'string' ? result : null` (and `result: null, error: null` on `'started'`). Removes `id` from `tools` and `startedTools`.
- **Reasoning stream (`agent_thought_chunk`)**:
  - Handles `update.sessionUpdate === 'agent_thought_chunk'` when `update.content.type === 'text'` and `update.content.text !== ''`.
  - Flushes any active assistant message (`flushCurrentMessage()`) before opening/continuing reasoning.
  - Tracks `currentReasoning: { id: string; nativeId: string | null } | null` and a monotonic `nextBlockId` counter (never reset across turns in the same `AcpActivity` instance so display IDs never collide inside one standing Feishu presentation).
  - Closes `currentReasoning` whenever `nativeId` changes, then reuses or allocates `nativeId ?? acp-reasoning-${++this.nextBlockId}`.
  - Emits `{ kind: 'assistant.reasoning', occurredAt: Date.now(), id, partIndex: 0, text: update.content.text, status: 'streaming' }`.
  - `closeReasoning()` emits `{ kind: 'assistant.reasoning', occurredAt: Date.now(), id, partIndex: 0, text: '', status: 'completed' }` and clears `currentReasoning`. Called before tool calls, assistant messages, `finishTurn()`, and `reset()`.
- **Assistant message stream (`agent_message_chunk`)**:
  - Tracks `currentMessage: { id: string; nativeId: string | null; text: string } | null` (no separate `Map` or `anonymous` boolean).
  - When `update.content.type === 'text'` and `update.content.text !== ''`: closes any open reasoning block (`closeReasoning()`), flushes `currentMessage` if `nativeId` changed, opens `{ id: nativeId ?? acp-message-${++this.nextBlockId}, nativeId, text: '' }` when none is active, and appends `update.content.text`.
  - `flushCurrentMessage()` emits `assistant.message` if non-empty and clears `currentMessage`. Called before tool calls, reasoning chunks, message switches, and `finishMessages()`.
- **Turn terminal and teardown (`finishTurn`, `reset`)**:
  - `finishTurn()` calls `closeReasoning()` and flushes an open anonymous message block (`currentMessage?.nativeId === null`) before emitting `turn.result` / `turn.ended`, preventing overlapping prompt groups from concatenating ID-less answers across turns while preserving native-ID overlapping flush behavior.
  - `reset()` calls `closeReasoning()` before discarding buffered messages and clearing tool tracking sets (`tools`, `runningTools`, `failedTools`, `startedTools`), keeping `nextBlockId` monotonic.
  - `usage_update` and `PromptResponse.usage` continue to emit no `token.usage`.

## Implementation boundary and non-goals

- **In-scope files**:
  - `packages/agent-runtime/antigravity/src/acp/tool-display.ts` (new)
  - `packages/agent-runtime/antigravity/src/acp/activity.ts` (updated)
  - `packages/agent-runtime/antigravity/tests/acp-activity.test.ts` (new focused unit tests) and `packages/agent-runtime/antigravity/tests/acp-runtime.test.ts` (updated/extended ACP runtime tests)
  - `packages/dreamux-types/src/activity.ts` (comment-only JSDoc alignment for live-only display block IDs, ratified in review adjudication 2/2)
  - Documentation & change files: `.agents/product/README.md`, `.agents/domains/provider-runtime.md`, `packages/agent-runtime/antigravity/README.md` (if affected), task record updates, and ordinary Rush change files.
- **Explicit non-goals**:
  - No edits to `packages/agent-runtime/antigravity/src/tmux/` or `src/transcript/`.
  - No `token.usage` emission or provider-side usage accumulation.
  - No type or runtime changes to `@excitedjs/dreamux-types` (JSDoc comment alignment only), and no changes to Dreamux Core, `@excitedjs/feishu-channel`, Claude Code, or Codex.

## Affected contracts, compatibility, and upgrades

- **Neutral contract (`RuntimeActivity`)**: Unchanged. All emitted events conform to the existing `tool.call`, `assistant.reasoning`, `assistant.message`, `context.compacted`, and `turn.ended` union members.
- **Superseding prior design note**: Knowingly supersedes the narrow sentence in `integrate-antigravity-runtime/technical-design/final.md` that omitted `agent_message_chunk` / `agent_thought_chunk` when ACP lacks `messageId`, per the operator's 2026-11-27 ruling ("只补推理与消息，不报用量"). Cold `readRecentActivity` and `turn.interrupted` retain strict native-identity requirements.
- **Compatibility and upgrades**: No persisted config, state, cache, run, or log file format changes. No `BREAKING:` or `Rebuild:` note is needed; one ordinary Rush change file for `@excitedjs/agent-runtime-antigravity` suffices.

## Verification plan

1. **Unit tests (`packages/agent-runtime/antigravity/tests/acp-activity.test.ts`)**:
   - `read_file` / `write_file` / `edit_file` (POSIX and Windows paths, outside-cwd `File ../../../...` titles, fallback to `locations[0].path`) → verify `action`, basename `summary`, original path in `items`.
   - `run_command`: `toolSummary` preferred over first line of `CommandLine`; `invocation` set to `CommandLine`; text extracted from ACP `content` and fallback `rawOutput.output` (never `{ output, exit_code }` JSON); non-zero `exit_code` maps to `status: 'failed'` with text `error` while `hasFailedTools()` stays `false` (preserving permission-cancellation settlement).
   - MCP tools (`mcp_*`) with and without `toolSummary` (including `kind: 'execute'`, `title: 'Run ...'`) → `action: null`, `summary: "<toolName> · <toolSummary>"` or `null`, text content extraction.
   - `search_web`, `invoke_subagent`, `run_workflow` display mapping.
   - Repeated `in_progress` `tool_call_update` emits `started` only once.
   - `agent_thought_chunk` with and without `messageId`: streams `assistant.reasoning` increments, closes before tool calls, assistant messages, ID changes, `finishTurn`, and `reset`, and assigns distinct monotonic IDs across turns.
   - `agent_message_chunk` with and without `messageId`: accumulates and flushes before tool calls, reasoning chunks, ID changes, and `finishMessages()`.
   - `usage_update` emits no `token.usage`.
2. **ACP runtime tests (`packages/agent-runtime/antigravity/tests/acp-runtime.test.ts`)**:
   - Existing overlapping-group message projection, permission-cancellation settlement, cancellation/stop teardown (verifying open reasoning closes before `turn.ended`), and no-`token.usage` invariants all pass.
   - Add regression verifying an ordinary `run_command` with `exit_code: 1` does not break `end_turn` settlement when followed by a planner response, and verifying `stop()` / transport loss closes an open reasoning block before `turn.ended`.
3. **Live `agy` 1.5.17 ACP probe**:
   - Run a real `agy acp` session through the updated `AcpRuntime` (without modifying or committing any repo fixtures) exercising `read_file` outside cwd, `run_command` (exit 0 and exit 1), `agent_thought_chunk`, and `agent_message_chunk`, verifying the emitted `RuntimeActivity` stream and Core redaction output.
4. **Full monorepo gates**:
   - `node common/scripts/install-run-rush.js build`
   - `node common/scripts/install-run-rush.js lint`
   - `node common/scripts/install-run-rush.js test`
   - `node common/scripts/install-run-rush.js typecheck:tests`
   - `node .agents/scripts/check.mjs`

## Unresolved decisions and known limitations

- **Unresolved decisions**: None.
- **Known limitations**:
  - `tmux` transport COT projection is out of scope for this task.
  - `token.usage` remains omitted for Antigravity ACP until/unless `agy` exposes native cumulative session counters.
  - Per existing `feishu-channel/src/cot/card.ts` rules, titled `action: null` rows (`<toolName> · <toolSummary>`) render without an icon, while untitled MCP rows keep `app-default_outlined`.
