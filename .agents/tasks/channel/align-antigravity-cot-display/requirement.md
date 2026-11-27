# Requirement

## Initial request

- Operator request (2026-11-27): "帮我优化一下 Antigravity 的 COT 输出吧，现在看起来不是很规整"
- Operator follow-up observations (2026-11-27):
  - "现在为什么会有 readFile 后面跟一长串相对路径的问题？" (screenshot showing `Read File ../../../../../../../.../SKILL.md` and `</> Run mcp_channel-feishu_reply`)
  - "另外，工具调用，特别是 command 执行这个工具，返回的是一个 JSON。看起来有点奇怪" (screenshot showing `run_command` RESULT rendered as `{ "output": "...", "exit_code": 0 }`)
  - "另外 read file 在 codex 那边，是 items 里是长路径，外面是 文件名，没有路径信息"
  - "然后有一些其实是有 summary 的，但是 COT 这边好像没有消费,你可以参考一下 claude code 那边是怎么使用 summary 的"

## Current alignment

- Status: Confirmed by the operator on 2026-11-27.
- Confirmed current behavior and evidence (verified against live `agy` 1.5.17 ACP probes, `packages/agent-runtime/antigravity/src/acp/activity.ts`, `packages/channel/feishu-channel/src/cot/card.ts`, `packages/agent-runtime/claude-code/src/tool-display.ts`, `packages/agent-runtime/codex/src/tool-display.ts`, and prior task records):
  1. **File tools (`read_file`, `write_file`, `edit_file`)**: `agy acp` emits `title: "File <relpath-from-cwd>"` (producing `../../../../...` for files outside the worktree cwd) while `rawInput.Path` and `locations[0].path` retain the clean absolute path. `AcpActivity` forwards `current.title` as `summary` with `action: 'read'`/`'edit'`, so Feishu renders `Read File ../../../...` / `Edit File ...` and the relative path bypasses Core's home-prefix redaction (`~`).
  2. **Command execution (`run_command`)**: `agy acp` emits `rawInput: { CommandLine, toolSummary, ... }`, `rawOutput: { output, exit_code }`, and `content: [{ type: "content", content: { type: "text", text } }]`. `AcpActivity` ignores `toolSummary` (passing `current.title`, i.e., the raw command line) and forwards `rawOutput` directly as `result`, causing Feishu to render an escaped JSON code block instead of plain text. Also, a non-zero `exit_code` (e.g. `exit 1`) arrives with `status: "completed"` and `rawOutput.exit_code: 1`.
  3. **MCP tools**: `agy acp` emits `kind: "execute"`, `title: "Run <mcp_tool_name>"`, and `rawInput.toolSummary`. `AcpActivity` maps `kind: "execute"` to `action: 'run'`, causing Feishu to render MCP calls with a bash icon and `Run ...`.
  4. **Duplicate `started` events**: `AcpActivity.tool()` emits `status: 'started'` on every non-terminal `tool_call` / `tool_call_update` notification for the same `toolCallId`.
  5. **Reasoning (`agent_thought_chunk`) and assistant text (`agent_message_chunk`)**: Live `agy` 1.5.17 emits both updates without `messageId`. Because `integrate-antigravity-runtime` required native IDs and `AcpActivity` had no `agent_thought_chunk` handler, both streams are dropped on live `agy` 1.5.17.
  6. **Token usage**: Live `agy` 1.5.17 emits `usage_update` (context window footprint only) and per-turn `PromptResponse.usage` (verified across two consecutive turns). No native session-cumulative counter is provided.
- Desired outcome: Antigravity ACP live COT cards render clean tool rows, plain-text tool outputs, streamed reasoning blocks (when `cot.reasoning` is enabled), and completed assistant messages, consistent with Claude Code and Codex while preserving existing Dreamux contracts.
- Desired behavior:
  1. **Tool display projection (ACP)**:
     - `read_file`: `action: 'read'`, `summary`: file basename (e.g. `SKILL.md` → `Read SKILL.md`), `invocation: null`, `items`: `[path]` using the original path from `rawInput.Path` or `locations[0].path` (so Core redacts workspace paths to relative and home paths to `~/...` in the expanded pill).
     - `write_file`, `edit_file`: `action: 'edit'`, `summary`: file basename, `invocation: null`, `items`: `[path]`.
     - `run_command`: `action: 'run'`, `summary`: `rawInput.toolSummary` if non-empty, else first non-empty line of `rawInput.CommandLine` (falling back to `current.title` if `CommandLine` is absent), `invocation`: `rawInput.CommandLine`, `items: []`.
     - `search_web`: `action: 'search'`, `summary`: `rawInput.query`, `invocation: null`, `items: []`.
     - `invoke_subagent`: `action: null`, `summary`: `rawInput.Role`, `invocation`: `rawInput.Prompt`, `items: []`.
     - `run_workflow`: `action: null`, `summary`: `rawInput.Description`, `invocation`: `rawInput.Script`, `items: []`.
     - MCP tools (and other unmapped tools): `action: null` (never misclassified as `'run'`), `summary`: `"<toolName> · <toolSummary>"` when `rawInput.toolSummary` is non-empty, else `null` (falling back to Feishu's default app icon + tool name), `invocation: null`, `items: []`.
     - `tool.call` lifecycle: emit `status: 'started'` at most once per `toolCallId`, and emit `completed` or `failed` once when the tool terminates.
  2. **Tool result projection (ACP)**:
     - Extract plain text from ACP `content` entries when all entries are text content blocks (`{ type: 'content', content: { type: 'text', text } }`, joined with `\n`), falling back to string `rawOutput.output` (for `run_command`-shaped objects) and then `rawOutput`.
     - Treat `run_command` with numeric non-zero `rawOutput.exit_code` as `status: 'failed'`, and populate `error` from the extracted text when `status === 'failed'`.
  3. **Live reasoning (`agent_thought_chunk`) and assistant messages (`agent_message_chunk`)**:
     - Use native `update.messageId` whenever supplied; when omitted (as in `agy` 1.5.17), allocate a live-only in-memory display block ID per contiguous reasoning or assistant message block.
     - Stream `agent_thought_chunk` text as `assistant.reasoning` (`partIndex: 0`, `status: 'streaming'`) and close the open reasoning block (`text: ''`, `status: 'completed'`) before any tool call, assistant message, reasoning ID change, turn end, or reset/teardown.
     - Accumulate `agent_message_chunk` text per block and emit one completed `assistant.message` when flushed before a tool call, reasoning chunk, message ID change, or turn end.
     - Cold `readRecentActivity` remains unchanged and never uses these live-only display IDs.
  4. **Token usage**:
     - Antigravity ACP continues to omit `token.usage` (neither `usage_update` nor per-turn `PromptResponse.usage` is emitted or accumulated by the provider), preserving the `standalone-token-usage-activity` invariant.
- Scope:
  - In scope: `@excitedjs/agent-runtime-antigravity` ACP live activity projection, unit/ACP-runtime tests, and corresponding documentation/KB updates (updating the superseded ACP `messageId` display note in docs/product catalog as needed) plus Rush change file.
  - Out of scope (non-goals):
    - Antigravity `tmux` transport COT projection.
    - `token.usage` emission or provider-side usage accumulation in Antigravity.
    - Changes to Core redaction, `@excitedjs/dreamux-types` union shapes, `@excitedjs/feishu-channel` COT rendering rules, Claude Code, or Codex.
- Constraints and invariants:
  - Keep all changes provider-local inside `@excitedjs/agent-runtime-antigravity`; no Antigravity-specific branches in Core or Feishu channel.
  - Preserve existing ACP turn settlement, transcript-drain ordering, permission handling, cancellation, and multi-prompt group isolation.
  - Preserve the `standalone-token-usage-activity` rule that providers do not accumulate or fabricate cumulative token counters.
  - Knowingly supersede only the narrow `integrate-antigravity-runtime` rule that omitted ID-less `agent_message_chunk` / `agent_thought_chunk` live display blocks, while keeping cold reads and `turn.interrupted` native-ID-only.

## Acceptance criteria

1. `read_file`, `write_file`, and `edit_file` emit `action: 'read'`/`'edit'`, `summary` set to the file basename (never `"File ..."` or `"../../../..."`), and `items` carrying the original path from `rawInput.Path` / `locations[0].path` so Core redacts it cleanly.
2. `run_command` emits `action: 'run'`, `summary` preferring `rawInput.toolSummary` over the first line of `CommandLine`, `invocation` set to `CommandLine`, and plain-text `result` extracted from ACP `content` / `rawOutput.output` (never `{ output, exit_code }` JSON); non-zero `exit_code` maps to `status: 'failed'` with text `error`.
3. MCP tools emit `action: null` (never `'run'`), `summary: "<toolName> · <toolSummary>"` when `toolSummary` is non-empty (or `null` when absent), and plain-text `result` when ACP `content` carries text blocks.
4. `search_web`, `invoke_subagent`, and `run_workflow` emit aligned `action`/`summary`/`invocation` fields matching Claude Code conventions, and repeated in-progress updates for one `toolCallId` emit `status: 'started'` at most once.
5. `agent_thought_chunk` streams `assistant.reasoning` increments and closes open reasoning blocks before tool calls, assistant messages, turn ends, or reset/teardown—both with native `messageId` and without `messageId`.
6. `agent_message_chunk` emits completed `assistant.message` blocks when flushed—both with native `messageId` and without `messageId`—without breaking overlapping-group message projection.
7. Neither `usage_update` nor `PromptResponse.usage` emits `token.usage`.
8. Full monorepo gates (`rush build`, `rush lint`, `rush test`, `rush typecheck:tests`) and `.agents/scripts/check.mjs` pass, plus a live `agy` 1.5.17 ACP verification confirms the projected activities.

## Decisions and unknowns

- Confirmed operator decisions:
  - 2026-11-27: Create a new task under `channel` and enter `clarification`.
  - 2026-11-27: Scope confirmed as "ACP 全量 COT 优化 (Recommended)" (Antigravity ACP only; `tmux` out of scope).
  - 2026-11-27: MCP tool display confirmed as "工具名 + toolSummary" (`action: null`, `summary: "<toolName> · <toolSummary>"` when `toolSummary` is non-empty, else `null`).
  - 2026-11-27: Streaming & usage rule confirmed as "只补推理与消息，不报用量" (live-only in-memory display IDs for `agent_thought_chunk` and `agent_message_chunk` when native `messageId` is absent; `token.usage` remains omitted).
- Non-blocking assumptions and notes:
  - Feishu `card.ts` is left untouched; as noted during MCP display confirmation, titled `action: null` rows (`<toolName> · <toolSummary>`) follow Feishu's existing rule (no app icon on titled action-less rows), while untitled MCP rows keep `app-default_outlined`.
  - Non-zero `exit_code` on `run_command` is projected as `status: 'failed'` on the COT tool row without changing ACP's `hasFailedTools()` permission-cancellation settlement guard (the solution will verify whether `hasFailedTools()` should track only native ACP `status === 'failed'` so an ordinary `exit 1` command cannot misclassify an `end_turn` settlement!).
- Blocking unknowns: None.
