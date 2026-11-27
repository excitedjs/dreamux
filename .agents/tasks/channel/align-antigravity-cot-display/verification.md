# Verification

Date: 2026-11-27.

## Repository gates

All four required monorepo gates passed across all workspace packages after the final Round 2 fixes:

- `node common/scripts/install-run-rush.js build` — passed (10 packages).
- `node common/scripts/install-run-rush.js lint` — passed (ESLint + Prettier, 10 packages).
- `node common/scripts/install-run-rush.js test` — passed (all 9 testable packages green; `@excitedjs/dreamux` retained the standard unauthenticated live-Codex model-case warning).
- `node common/scripts/install-run-rush.js typecheck:tests` — passed (all 9 packages).

## Deterministic coverage

- `packages/agent-runtime/antigravity/tests/acp-activity.test.ts` (new):
  - `read_file`, `write_file`, and `edit_file` map to `action: 'read'`/`'edit'`, basename `summary` via `node:path` `win32.basename` (handling POSIX/Windows separators, trailing slashes such as `/outside/repo/folder/`, root `/`, and preserving trailing spaces in raw paths), and raw original path in `items` (including fallback to `locations[0].path`).
  - `run_command` prefers `rawInput.toolSummary` over first line of `CommandLine`, preserves raw `CommandLine` in `invocation`, extracts plain text from ACP `content` blocks and fallback `rawOutput.output` (never `{ output, exit_code }` JSON), and marks non-zero `exit_code` as `status: 'failed'` with text `error` without flagging `hasFailedTools()`.
  - Structured tool failures (`rawOutput` object without text `content`) remain on `result` with `error: null` so Core applies `redactJson` key redaction and Feishu falls back to `result`.
  - Partial `tool_call_update` with explicit `null` fields (`name`, `title`, `rawInput`, `locations`) preserves cached values and still emits terminal tool results.
  - MCP tools (`mcp_*`) classify with `action: null` (never `'run'`), `summary: "<toolName> · <toolSummary>"` when `toolSummary` is non-empty or `null` when absent, and plain-text extraction from ACP `content`.
  - `search_web`, `invoke_subagent`, and `run_workflow` map `action`/`summary`/`invocation`, and repeated `in_progress` `tool_call_update` notifications emit `status: 'started'` at most once.
  - `agent_thought_chunk` and `agent_message_chunk` work both with native `messageId` (including native reasoning ID switches) and without `messageId` (including empty-chunk suppression): reasoning streams incrementally and closes before tool calls, assistant messages, ID switches, `finishTurn`, and `reset`; display IDs remain distinct across turns; assistant messages flush cleanly across boundaries.
- `packages/agent-runtime/antigravity/tests/acp-runtime.test.ts` (extended):
  - Open reasoning block closes before `turn.ended` on `stop()` and on transport loss (`peer.close()`).
  - Overlapping prompt groups without `messageId` flush each turn's anonymous assistant message before its own `turn.ended` without concatenating across turns.
  - `PromptResponse` carrying per-turn `usage` on `end_turn` emits no `token.usage`.
  - Ordinary `run_command` with `exit_code: 1` emits `status: 'failed'` with text `error` while allowing normal `end_turn` settlement when followed by a planner response.
  - All existing ACP runtime tests (overlapping native-ID groups, permission-cancellation settlement, cancellation, transcript drains, no `token.usage` on `usage_update`) remain unchanged and green.

## Live `agy` 1.5.17 ACP evidence

Executed a live `agy` 1.5.17 ACP turn through the compiled `@excitedjs/agent-runtime-antigravity` `AcpRuntime` (with Core `redactText` applied to observed outputs, and temporary scratch deleted afterward):

- `read_file` on a file outside the worktree cwd emitted `action: "read"`, `summary: ".bashrc"`, `items: ["~/.bashrc"]` (after Core redaction) — no `"File ../../../..."`.
- `run_command` (`echo hi && exit 1`, `toolSummary: "Fail echo"`) emitted `action: "run"`, `summary: "Fail echo"`, `invocation: "echo hi && exit 1"`, `status: "failed"`, plain-text `result` and `error` (no JSON wrapper), and the turn settled cleanly as `completed`.
- `agent_message_chunk` (omitting `messageId` on live `agy` 1.5.17) emitted `assistant.message` (`text: "DONE"`).
- No `token.usage` activity was emitted.
- Live `agy` 1.5.17 raw ACP probes during clarification additionally confirmed that `tool_call` notifications carry `rawInput` and `locations` immediately on initial `in_progress`, that `agent_thought_chunk` omits `messageId`, and that `agy` 1.5.17 declares exactly 15 built-in tools in ACP (`read_file`, `write_file`, `edit_file`, `run_command`, `manage_task`, `update_steps`, `ask_question`, `search_web`, `schedule`, `define_subagent`, `invoke_subagent`, `manage_subagents`, `send_message`, `run_workflow`, `swarm`).

## Coverage limits and residual risks

- The compiled-runtime live `agy` 1.5.17 probe ran prior to the Round 2 micro-adjustments (which only changed `win32.basename`, inlined `discardMessages()`, and tightened comments) and did not trigger a live MCP tool call or long thinking block in that single turn; both wire shapes were verified in earlier `agy` 1.5.17 probes / production screenshots and are covered by deterministic tests (plus `gpt-astra`'s end-to-end Core redaction + Feishu projection probe on compiled `dist/`).
- `tmux` transport COT projection and `token.usage` remain explicitly out of scope per operator rulings.

## Implementation review adjudication

### Round 1

Independent reviews were conducted in parallel by four heterogeneous TeamMates (`kimi`, `glm`, `gpt-astra`, `qwen`) against the complete local working-tree diff. All four returned `REQUEST CHANGES`.

| Finding | Disposition | Evidence and reason | Operator ruling affected |
| --- | --- | --- | --- |
| Structured tool error `JSON.stringify` bypasses key-name secret redaction (`gpt-astra` P1) | Accepted & fixed | `conversation-projection.ts` runs `redactJson` on `result` and `redactText` on `error`; `card.ts` already falls back `event.error ?? event.result`. Deleted `formatToolError` and restricted `error` to string results. | Ratified 2026-11-27 ("批准上述裁决并修复 (Recommended)") |
| Overlapping prompt groups concatenate two turns' ID-less assistant messages across `turn.ended` (`kimi` #1, `qwen` F1, `gpt-astra` P2, `glm` #1) | Accepted & fixed | `finishTurn()` now flushes an open anonymous message block (`nativeId === null`) before `turn.result` / `turn.ended`, preserving native-ID overlapping behavior. | Ratified 2026-11-27 ("批准上述裁决并修复 (Recommended)") |
| ACP `tool_call_update` with explicit `name: null` overwrites cached name and drops tool terminal (`kimi` #2, `gpt-astra` P2) | Accepted & fixed | ACP v1 specifies omitted or `null` `ToolCallUpdate.name` keeps the existing name; merge now retains cached `name`, `title`, `rawInput`, and `locations` when omitted or `null`. | Ratified 2026-11-27 ("批准上述裁决并修复 (Recommended)") |
| Raw `Path` / `CommandLine` altered by `trim()`, unreachable defensive checks, redundant `messages` Map + `anonymous` boolean, unused `update()` return value, and test fidelity gaps (`qwen` F3–F6, `gpt-astra` P3, `kimi` #3, `glm` #5/#7) | Accepted & fixed | Preserved raw `Path`/`CommandLine`/`Prompt`/`Script`; collapsed `messages` Map + `anonymous` into `{ id, nativeId, text }`; removed dead checks and unused return value; added `PromptResponse.usage`, transport-loss, and native reasoning switch tests. | Ratified 2026-11-27 ("批准上述裁决并修复 (Recommended)") |
| `packages/dreamux-types/src/activity.ts` `NativeActivity.id` JSDoc conflicts with live-only in-memory ACP display IDs (`qwen` F2, `glm` #3, `gpt-astra`) | Accepted & fixed | Updated JSDoc comments on `NativeActivity.id` and `assistant.reasoning` (comment-only, no type or runtime change). | Ratified 2026-11-27 ("同步改注释（推荐） (Recommended)") |
| Built-in tool table omits binary strings `grep_search`/`code_search`/`view_file`/`list_dir` (`glm` #2) | Rejected | Live `agy` 1.5.17 ACP tool declaration list exposes only 15 built-in tools; these names do not exist in ACP. | Ratified 2026-11-27 ("批准上述裁决并修复 (Recommended)") |
| Pending-tool start deferral, terminal-only synthetic start, post-terminal `tool_call_update` tombstone, and nameless `tool_call` reasoning split (`gpt-astra` P2 #4/#5/#6, `glm` #4) | Rejected | No evidence that live `agy` 1.5.17 emits these sequences; rejected under `engineering-whitepaper` §1. | Ratified 2026-11-27 ("批准上述裁决并修复 (Recommended)") |
| MCP row renders tool name twice (`glm` #6) | Rejected | False premise: `.agents/domains/channel.md` confirms Feishu titled rows render only `title`, not `toolCallName` beside `title`. | Ratified 2026-11-27 ("批准上述裁决并修复 (Recommended)") |

### Round 2

All four TeamMates (`kimi`, `glm`, `qwen`, `gpt-astra`) performed a holistic re-review of the complete diff. `kimi`, `glm`, and `qwen` returned `PASS` (with `qwen` proving zero native-ID regressions across 161,051 differential sequences and `gpt-astra` confirming end-to-end Core redaction and Feishu projection on compiled `dist/`); `gpt-astra` added two follow-up polish items alongside two shared non-blocking nits from `glm`/`qwen`:

| Finding | Disposition | Evidence and reason | Operator ruling affected |
| --- | --- | --- | --- |
| `fileBasename` fell back to full path on trailing-slash directories like `/outside/repo/folder/` (`gpt-astra`) | Accepted & fixed | Switched `fileBasename` to `node:path` `win32.basename(path) || null` and added directory/root unit assertions. | Ratified 2026-11-27 ("批准收尾微调（推荐） (Recommended)") |
| `dreamux-types/src/activity.ts` JSDoc wording too broad; suggested naming Antigravity ACP (`gpt-astra`) | Partially accepted & fixed | Kept `dreamux-types` strictly provider-neutral (no provider name), tightened wording to protocols that structurally omit native message IDs (not an isolated missing field), and aligned `final.md` line 7. | Ratified 2026-11-27 ("批准收尾微调（推荐） (Recommended)") |
| `activity.ts` merge comment overstated ACP v1 null semantics for non-`name` fields; `discardMessages()` was a single-caller one-liner (`glm`, `qwen`, `gpt-astra`) | Accepted & fixed | Narrowed comment to cite ACP v1 for `name` only and inlined `discardMessages()` into `reset()`. | Ratified 2026-11-27 ("批准收尾微调（推荐） (Recommended)") |
