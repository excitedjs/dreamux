# Requirement

## Initial request

- Operator asked on 2026-11-27 whether Antigravity (`agy`) lacks support for Dreamux MCP `structuredContent` output, reviewed the investigation findings and three candidate options, and selected Option A ("走 A 吧。"): emit serialized JSON text in `content` alongside `structuredContent` in the shared MCP server adapter.
- During requirement confirmation on 2026-11-27, the operator expanded scope with "一并处理 codex 的 cot 问题" to also unwrap Codex `mcpToolCall` result envelopes so Codex COT cards do not display the raw `{ content, structuredContent, _meta }` envelope (which would otherwise show duplicated JSON).
- On the development-authorization card on 2026-11-27, the operator requested streamlining `dev-workflow` ("awaiting-development-approval 这个阶段好像有点多余啊，你顺手把 dev-workflow 梳理一下吧。") and confirmed via interactive card ("整体精简并立即开工 (Recommended)") to include the `dev-workflow` streamlining in this same change: remove `awaiting-development-approval` (folding development authorization into `solution` confirmation) and remove mechanical transition cards for unambiguous new-task `intake` and `implementation -> review -> knowledge-closeout -> PR`, while preserving all core operator decision, review-adjudication, merge-authorization, and team-dissolution gates.

## Current alignment

- Status: Ready for operator confirmation.
- Confirmed current behavior and evidence:
  - In `packages/dreamux/src/mcp/server.ts` (`executeTool`), a successful tool outcome with nonempty `outcome.text` returns `{ content: [{ type: 'text', text: outcome.text }] }` without `structuredContent`, whereas an outcome with absent or empty `text` returns `{ content: [], structuredContent: outcome.structured }`.
  - Under Antigravity CLI (`agy` 1.5.17), `structuredContent` is parsed by the underlying Go MCP SDK for MCP Apps UI rendering (`app.ontoolresult`) but is not passed to the model; the model reads only `content` blocks (confirmed both by Antigravity's built-in `mcp-app-development` skill — "the model sees `content`; the app sees the full result" — and by live calls to `team.status`, `teammate.get_capabilities`, `teammate.list`, `cron.cron_list`, `channel-feishu.list_subscriptions`, and `channel-feishu.list_chat_bots` in an active `agy` session, all of which delivered empty output to the model).
  - Historical Ruling #1 in `mcp/protocol-conformance` deliberately omitted the MCP specification's backwards-compatibility `SHOULD` (duplicating `structuredContent` as serialized JSON in `content`) under the earlier two-client contract (Codex and Claude Code).
  - In `packages/agent-runtime/codex/src/turn-manager.ts`, `resultFor(item)` forwards `item['result']` verbatim for `mcpToolCall` items. Per the official Codex app-server v2 schema (`codex app-server generate-ts`), `McpToolCallResult` is `{ content: Array<JsonValue>, structuredContent: JsonValue | null, _meta: JsonValue | null }`. Without unwrapping, Codex COT rows print the whole envelope and would print duplicated JSON once `content` carries the serialized text.
- Desired outcome:
  - Every structured MCP tool result emitted by Dreamux's shared MCP server is readable both by clients that consume `structuredContent` (Codex, Claude Code) and by clients whose model consumes `content` (Antigravity and any standards-conforming text-reading MCP client), without adding per-runtime or per-client branches.
  - Codex `mcpToolCall` activity results emitted for COT display unwrap the MCP result envelope to the single payload (`structuredContent`, else joined `content` text, else non-text `content`, else `null`).
- Desired behavior:
  - **Shared MCP wire adapter (`packages/dreamux/src/mcp/server.ts`)**:
    - When a tool succeeds with absent or empty `outcome.text`, `executeTool` returns both:
      - `structuredContent: outcome.structured` (unchanged), and
      - `content: [{ type: 'text', text: JSON.stringify(outcome.structured) }]` (compact serialized JSON in a single text block, following the MCP `2025-06-18` / `2025-11-25` / `2026-07-28` specification `SHOULD`).
    - When a tool succeeds with nonempty `outcome.text`, behavior is unchanged: emit `{ content: [{ type: 'text', text: outcome.text }] }` verbatim, with no `structuredContent` and no serialized JSON copy (preserving reminder and authored-receipt visibility on Codex and Claude Code from PR #480).
    - Tool failure paths (`PublicToolError`, unexpected errors, and SDK input/output schema validation failures) remain unchanged (`isError: true` with text `content` and no `structuredContent`).
    - Tool `outputSchema` advertisement and SDK validation remain unchanged.
  - **Codex provider MCP result unwrapping (`packages/agent-runtime/codex/src/turn-manager.ts`)**:
    - For `item.type === 'mcpToolCall'`, `resultFor(item)` unwraps the `McpToolCallResult` envelope:
      1. If `result` is `null` or `undefined`, return `null`.
      2. If `result` is an object with non-null, defined `structuredContent`, return `toJsonValue(result.structuredContent)`.
      3. Else if `result` is an object with an array `content`: if empty return `null`; if every entry is a text block (`{ type: 'text', text: string }`), return their `text` joined with `'\n'`; otherwise return `toJsonValue(result.content)`.
      4. Otherwise return `toJsonValue(result)`.
    - Non-`mcpToolCall` Codex items (`commandExecution`, `fileChange`, `webSearch`, `dynamicToolCall`) remain unchanged.
- Scope:
  - Shared MCP wire adapter in `packages/dreamux/src/mcp/server.ts` and its doc comments.
  - Codex `mcpToolCall` result unwrapping in `packages/agent-runtime/codex/src/turn-manager.ts`.
  - Affected unit/conformance tests in `packages/dreamux/tests/` and `packages/agent-runtime/codex/tests/`.
  - Affected knowledge owners and product catalog entries in `.agents/` (`protocol-conformance`, `product/README.md`, `domains/model-facing-writing.md`, `domains/current-architecture.md`, `domains/channel.md`, `domains/dispatcher-orchestration.md`).
  - Ordinary Rush change files for `@excitedjs/dreamux` and `@excitedjs/agent-runtime-codex` (non-breaking).
- Non-goals:
  - No runtime-specific or client-sniffing branches in the MCP server or shim.
  - No changes to authored-text tools, reminder texts, tool `inputSchema`/`outputSchema` definitions, or domain result projections.
  - No changes to unrelated Codex COT items (such as `declined` command status, exit code, or `McpToolCallError` object formatting — only `mcpToolCall` result unwrapping is in scope).
  - No live deployment, daemon restart, or merge.
- Constraints and invariants:
  - Core MCP serving stays completely runtime-neutral behind `@modelcontextprotocol/server`.
  - All three supported MCP protocol revisions (`2026-07-28`, `2025-11-25`, `2025-06-18`) emit the same dual-channel structured result shape.
  - No defensive catch/fallback wrapper around `JSON.stringify(outcome.structured)` without a concrete reachable failure scenario.
  - Persisted config/state files are untouched (no `BREAKING:` changelog entry).

## Acceptance criteria

1. Across all three supported MCP revisions (`2026-07-28`, `2025-11-25`, `2025-06-18`), a successful tool call with absent or empty `outcome.text` returns `structuredContent: outcome.structured` and `content: [{ type: 'text', text: JSON.stringify(outcome.structured) }]`.
2. Both direct `runMcpServer` calls and end-to-end admin-socket shim calls (`runDreamuxMcp`) satisfy AC1 for absent and empty `text`.
3. A successful tool call with nonempty `outcome.text` continues to return `{ content: [{ type: 'text', text: outcome.text }] }` with no `structuredContent` and no serialized JSON copy.
4. `outputSchema` validation still rejects malformed `structuredContent` as `isError: true` and rejects nonempty `text` on a schema-advertising tool.
5. Error results (`PublicToolError`, unknown errors, input validation errors) remain `isError: true` with text `content` and no `structuredContent`.
6. Codex `TurnManager` unwraps `mcpToolCall` completed `result` envelopes into `RuntimeActivity.result`: returning `structuredContent` when present (ignoring accompanying `content` and `_meta`), else joined `content` text blocks when all blocks are `{ type: 'text', text }`, else non-text `content` array, else `null` when `content` is empty or `result` is `null`.
7. Repository gates pass: `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`, `node .agents/scripts/check.mjs`, and `rush change --verify`.

## Decisions and unknowns

- Confirmed operator decisions:
  - 2026-11-27: Operator selected Option A ("走 A 吧。"): emit serialized JSON text in `content` alongside `structuredContent` in the shared MCP adapter, superseding Ruling #1 of `mcp/protocol-conformance`.
  - 2026-11-27: Operator confirmed creating a new task record under `.agents/tasks/mcp/` via the intake interactive card.
  - 2026-11-27: Operator expanded scope on the requirement-confirmation card ("一并处理 codex 的 cot 问题") to unwrap Codex `mcpToolCall` result envelopes for COT display.
- Assumptions:
  - Compact `JSON.stringify(outcome.structured)` (without pretty-printing whitespace) is preferred to minimize context overhead.
  - Codex and Claude Code continue reading `structuredContent` in preference to accompanying `content` text as previously observed during PR #480.
  - Only `mcpToolCall` result-envelope unwrapping is included for Codex COT (unrelated Codex display notes in `feishu-cot-conversation-cards` remain out of scope).
- Blocking unknowns: None.
