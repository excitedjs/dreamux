# Technical Solution

## Summary

Make Dreamux's structured MCP tool results readable by MCP clients whose model reads `content` (including Antigravity) while keeping Codex and Claude Code behavior clean and avoiding duplicated JSON in Codex COT cards:

1. In the shared MCP wire adapter (`packages/dreamux/src/mcp/server.ts`), emit compact serialized JSON in a single `content` text block alongside `structuredContent` whenever a tool succeeds without nonempty authored `text`.
2. In the Codex runtime provider (`packages/agent-runtime/codex/src/turn-manager.ts`), unwrap completed `mcpToolCall` result envelopes into `RuntimeActivity.result` (`structuredContent`, else joined `content` text blocks, else non-text `content`, else `null`).
3. In `.agents/skills/dev-workflow/`, remove the redundant `awaiting-development-approval` state and `references/development-approval.md` (folding development authorization directly into `solution` confirmation), remove mechanical transition cards for unambiguous new-task `intake` and `implementation -> review -> knowledge-closeout -> PR`, update `scripts/init_task.py` (`STATES`) and `.agents/tasks/channel/simplify-feishu-replies/README.md` (replacing its link to the removed reference), and preserve all core decision, review-adjudication, merge-authorization, and team-dissolution interactive-card gates.

## Owning Components and Intended Behavior

### 1. Shared MCP wire adapter (`packages/dreamux/src/mcp/server.ts`)

`executeTool` is the sole wire projection boundary between Dreamux tool outcomes (`McpToolOutcome`) and MCP `CallToolResult`.

- **Nonempty authored text (`outcome.text !== undefined && outcome.text !== ''`)**: unchanged.
  - Emits `{ content: [{ type: 'text', text: outcome.text }] }` without `structuredContent` and without a JSON copy.
  - Tools that can produce authored text continue to omit `outputSchema`.
  - Preserves PR #480 reminder and receipt visibility on Codex and Claude Code.
- **Structured result (absent or empty `outcome.text`)**:
  - Emits:
    ```ts
    return {
      content: [{ type: 'text', text: JSON.stringify(outcome.structured) }],
      structuredContent: outcome.structured,
    };
    ```
  - Follows the MCP `2025-06-18`, `2025-11-25`, and `2026-07-28` specification `SHOULD` for backwards-compatible structured tool results.
  - Remains completely runtime-neutral: no client sniffing, protocol-version branching, or runtime flags.
  - `outputSchema` advertisement and SDK validation of `structuredContent` are unchanged.
  - No catch/fallback wrapper is added around `JSON.stringify(outcome.structured)`: `outcome.structured` is already constrained to a JSON-representable object by Core's Command JSON boundary, `assertDelegateResult`, and the MCP transport itself.
- **Failure paths**: unchanged (`PublicToolError`, unexpected errors, and SDK input/output validation errors return `isError: true` with text `content` and no `structuredContent`).

### 2. Codex `mcpToolCall` activity unwrapping (`packages/agent-runtime/codex/src/turn-manager.ts`)

Per the official Codex app-server v2 schema (`McpToolCallResult`), a completed `mcpToolCall` item carries:

```ts
type McpToolCallResult = {
  content: Array<JsonValue>;
  structuredContent: JsonValue | null;
  _meta: JsonValue | null;
};
```

`resultFor(item)` will delegate `item.type === 'mcpToolCall'` to `unwrapMcpToolCallResult(item['result'])`:

1. `result == null` -> `null`.
2. Plain object with `structuredContent !== undefined && structuredContent !== null` -> `toJsonValue(record['structuredContent'])` (drops the outer envelope, `_meta`, and accompanying duplicate `content` text).
3. Else plain object with `Array.isArray(record['content'])` -> `normalizeTypedTextItems(record['content'], 'text')`:
   - empty array -> `null`;
   - all entries are `{ type: 'text', text: string }` -> joined with `'\n'`;
   - otherwise (non-text or mixed blocks) -> `toJsonValue(record['content'])`.
4. Otherwise -> `toJsonValue(value)`.

The existing `normalizeInputTextItems` helper (used by `dynamicToolCall` and `renderProviderError` for `{ type: 'inputText', text }`) is generalized via a single local `normalizeTypedTextItems(value, expectedType)` helper accepting `'inputText' | 'text'`, avoiding duplicate block-joining loops while keeping `turn-manager.ts` within the 700-code-line lint cap.

Non-`mcpToolCall` items (`commandExecution`, `fileChange`, `webSearch`, `dynamicToolCall`) and error rendering (`renderProviderError`) remain unchanged.

## Implementation Boundary and Non-Goals

### In scope

- `packages/dreamux/src/mcp/server.ts` (behavior and doc comments).
- `packages/agent-runtime/codex/src/turn-manager.ts` (`resultFor` MCP unwrapping).
- Tests:
  - `packages/dreamux/tests/mcp-protocol-conformance.test.ts` (assert dual `content` + `structuredContent` across `2026-07-28`, `2025-11-25`, `2025-06-18`, plus absent/empty text and schema-free tools; verify nonempty text and validation failures unchanged).
  - `packages/dreamux/tests/mcp-shim-socket.test.ts` (assert dual `content` + `structuredContent` over the real admin-socket shim for absent and empty `text`).
  - `packages/agent-runtime/codex/tests/codex-runtime.test.ts` (assert `mcpToolCall` `RuntimeActivity.result` unwrapping for: `structuredContent` + duplicate JSON `content` + `_meta`, text-only `content` joined by `'\n'`, mixed/non-text `content`, empty `content`, and `null` result).
- Knowledge base closeout:
  - `.agents/tasks/mcp/protocol-conformance/requirement.md` (record that Ruling #1 is superseded by `mcp/emit-structured-content-text`).
  - `.agents/product/README.md`, `.agents/domains/model-facing-writing.md`, `.agents/domains/current-architecture.md`, `.agents/domains/channel.md`, `.agents/domains/dispatcher-orchestration.md` (replace `content: []` contract statements with the serialized JSON `content` + `structuredContent` contract).
- Rush change files:
  - `@excitedjs/dreamux` (ordinary `patch` / non-breaking note).
  - `@excitedjs/agent-runtime-codex` (ordinary `patch` / non-breaking note).

### Non-goals

- No changes to `packages/dreamux/src/mcp/shim.ts`, tool descriptors, `outputSchema` definitions, domain projections, or reminder texts.
- No per-runtime or per-client branches in Core MCP serving.
- No changes to unrelated Codex display behaviors (`declined` command status, exit code, `McpToolCallError` object formatting).
- No persisted config/state format changes and no `BREAKING:` / `Rebuild:` changelog entries.
- No deployment, daemon restart, or merge.

## Affected Contracts, Compatibility, and Upgrade Actions

- **MCP wire contract (non-breaking additive compatibility)**: structured tool calls now populate `content` with one compact JSON text block alongside the unchanged `structuredContent` object. Clients that read `structuredContent` (Codex, Claude Code) continue receiving the exact same validated object; clients whose model reads `content` (Antigravity and standard text-reading MCP clients) now receive the serialized JSON payload instead of an empty result.
- **Codex `RuntimeActivity` (`tool.call`)**: `mcpToolCall` results are now unwrapped to the payload (`structuredContent` or joined `content` text), aligning Codex COT rows with Claude Code COT rows and preventing duplicated JSON in COT output.
- **Config / persisted state**: None changed. No migration or rebuild action required.

## Verification Plan

1. **Automated deterministic tests** (covering AC1–AC6):
   - `packages/dreamux/tests/mcp-protocol-conformance.test.ts`: verifies `2026-07-28`, `2025-11-25`, `2025-06-18` dual `content` + `structuredContent` output, nonempty text content-only output, output-schema validation failures, and error results.
   - `packages/dreamux/tests/mcp-shim-socket.test.ts`: verifies absent and empty `text` over the real admin-socket shim.
   - `packages/agent-runtime/codex/tests/codex-runtime.test.ts`: verifies all `mcpToolCall` unwrapping branches in `TurnManager`.
2. **Repository gates** (AC7):
   - `node common/scripts/install-run-rush.js build`
   - `node common/scripts/install-run-rush.js lint`
   - `node common/scripts/install-run-rush.js test`
   - `node common/scripts/install-run-rush.js typecheck:tests`
   - `node .agents/scripts/check.mjs`
   - `node common/scripts/install-run-rush.js change --verify --no-fetch --target-branch next` (or appropriate verify flags)
3. **Known verification boundary**:
   - Deterministic SDK, shim, and Codex runtime tests verify the exact wire contract and Codex COT projection; they do not restart the running host daemon or execute a live model turn against the newly built binary during this task.

## Unresolved Decisions and Known Limitations

- Unresolved decisions: None.
- Known limitations:
  - Live `agy` / Codex / Claude Code end-to-end verification against the rebuilt binary requires deploying/restarting the installed Dreamux daemon, which is outside this task's scope.
  - Unrelated Codex COT display notes recorded in `channel/feishu-cot-conversation-cards` (such as `McpToolCallError` object formatting or declined command status) remain unchanged.
