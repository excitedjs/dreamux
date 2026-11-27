# Verification

Date: 2026-11-27.

## Local repository gates

All required local gates passed against the complete current change:

- `node common/scripts/install-run-rush.js update` — passed.
- `node common/scripts/install-run-rush.js build` — passed across all 10 workspace packages.
- `node common/scripts/install-run-rush.js lint` — passed across all 10 workspace packages (ESLint + Prettier + `max-lines` + no-sync-IO gate).
- `node common/scripts/install-run-rush.js test` — passed across all 10 workspace packages (retained the standard opt-in live-Codex model-gate warning when `DREAMUX_RUN_LIVE_MODEL_GATE=1` is not set).
- `node common/scripts/install-run-rush.js typecheck:tests` — passed across all 9 packages defining test typecheck (`@excitedjs/eslint-config` is a no-op).
- `node common/scripts/install-run-rush.js change --verify --no-fetch --target-branch next` — passed (validated both `@excitedjs/dreamux` and `@excitedjs/agent-runtime-codex` patch change files).
- `python3 .agents/skills/dev-workflow/scripts/init_task.py check-all --allow-in-flight` — passed (`Task records OK: 68 checked`).
- `git diff --check` — passed with no whitespace issues.

## Deterministic coverage

- `packages/dreamux/tests/mcp-protocol-conformance.test.ts`: verifies that across `2026-07-28`, `2025-11-25`, and `2025-06-18`, structured tool successes (including conditional text tools returning absent text and schema-free structured tools) return both `structuredContent` and a single compact JSON text block in `content`, while nonempty authored text continues returning content-only without `structuredContent` or a JSON copy, and output/input schema validation and error paths remain unchanged.
- `packages/dreamux/tests/mcp-shim-socket.test.ts`: verifies absent and empty `text` end-to-end through the real admin-socket MCP shim emit both `content: [{ type: 'text', text: JSON.stringify(...) }]` and `structuredContent`.
- `packages/agent-runtime/codex/tests/codex-runtime.test.ts`: verifies Codex `TurnManager` unwraps completed `mcpToolCall` result envelopes into `RuntimeActivity.result` across five cases:
  1. `structuredContent` + duplicate JSON `content` + `_meta` -> `structuredContent` payload only;
  2. text-only `content` blocks (`structuredContent: null`) -> joined text string (`'\n'`);
  3. non-text `content` blocks (`image`) -> raw `content` block array;
  4. empty `content: []` (`structuredContent: null`) -> `null`;
  5. `result: null` (and `started` phase) -> `null`.

## Independent review and adjudication

Independent review by Devbox on [PR #495](https://github.com/excitedjs/dreamux/pull/495) verified both production changes (`packages/dreamux/src/mcp/server.ts` against `@modelcontextprotocol/server@2.0.0` codecs, and `packages/agent-runtime/codex/src/turn-manager.ts` against Codex v2 `McpToolCallResult` schema and Feishu COT/redaction boundaries) and re-ran all local Rush gates. Three findings were raised and adjudicated against the already-confirmed streamlining boundary:

| Finding | Accept, reject, or defer | Evidence and reason | Operator ruling affected |
| --- | --- | --- | --- |
| 1. `.agents/skills/dev-workflow/references/large-refactor-mode.md:17-19` still mandated a confirmation card at every stage boundary, contradicting `SKILL.md`. | Accept | Verified directly in `large-refactor-mode.md:17-19` and reachable from `SKILL.md:78-80`. Updated to keep slice reconciliation while scoping cards to the surviving `SKILL.md` gates and advancing mechanical stage boundaries directly. | Implements the 2026-11-27 operator ruling ("整体精简并立即开工 (Recommended)"). |
| 2. `.agents/skills/dev-workflow/references/task-records.md:45` still listed removed "stage-transition decisions". | Accept | Verified at `task-records.md:45`. Updated to enumerate the surviving gate cards (solution/development authorization, unsettled scope decisions, review-finding rulings, material re-approval, merge, and dissolution). | Implements the 2026-11-27 operator ruling ("整体精简并立即开工 (Recommended)"). |
| 3. `normalizeTypedTextItems`/`toJsonValue` in Codex `turn-manager.ts` mirrors `normalizeTextBlocks`/`toJsonValue` in Claude Code `runtime-activity.ts` and could be consolidated into `@excitedjs/dreamux-utils`. | Defer | Pre-existing cross-runtime duplication outside this PR's approved boundary; recorded here as a cleanup trail for a separate refactor. | None (non-blocking follow-up). |

## Coverage limits and residual risks

- Local tests verify the wire protocol contract (through the official MCP client/server SDK and real admin-socket shim) and Codex `TurnManager` activity projection with fake RPC items. They do not restart the running host Dreamux daemon or execute a live model turn against the newly built binary during this task.
- Unrelated Codex COT display items previously deferred in `channel/feishu-cot-conversation-cards` (such as `McpToolCallError` object formatting and declined command status) remain out of scope and unchanged.
- Cleanup trail: `normalizeTypedTextItems`/`toJsonValue` in `packages/agent-runtime/codex/src/turn-manager.ts` and `normalizeTextBlocks`/`toJsonValue` in `packages/agent-runtime/claude-code/src/runtime-activity.ts` can be consolidated into `@excitedjs/dreamux-utils` in a separate refactor.
