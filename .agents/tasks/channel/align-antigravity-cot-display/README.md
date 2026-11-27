# Align Antigravity COT display

## Current state

- Goal: Align Antigravity ACP live activity projection so Feishu COT cards render cleanly and consistently
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/channel/align-antigravity-cot-display/requirement.md)
- Final solution: [Antigravity ACP COT display alignment](/.agents/tasks/channel/align-antigravity-cot-display/technical-design/final.md)
- Verification: [Local gates and live ACP evidence](/.agents/tasks/channel/align-antigravity-cot-display/verification.md)
- Solution review Issue: Not created.
- Blockers: None.
- Next action: Follow the delivery PR in GitHub, which owns CI and merge status, and obtain explicit merge authorization after required checks pass.
- Related tasks: Builds on [Integrate Antigravity runtime](/.agents/tasks/architecture/integrate-antigravity-runtime/README.md), [Stream opt-in reasoning into Feishu COT](/.agents/tasks/channel/stream-cot-reasoning/README.md), and [Emit a neutral token.usage activity instead of a synthetic usage message](/.agents/tasks/architecture/standalone-token-usage-activity/README.md).

## Stage decisions

- 2026-11-27 intake: The operator selected "新建任务 (Recommended)" on the task-discovery card, authorizing a new independent task under `channel` and entry into `clarification`.
- 2026-11-27 clarification (scope): The operator selected "ACP 全量 COT 优化 (Recommended)", scoping the task to Antigravity ACP live COT projection while excluding `tmux`.
- 2026-11-27 clarification (MCP display): The operator selected "工具名 + toolSummary" for Antigravity MCP tool rows (`action: null`, `summary: "<toolName> · <toolSummary>"` when `toolSummary` is present).
- 2026-11-27 clarification (streaming & usage): After reviewing the historical `integrate-antigravity-runtime` and `standalone-token-usage-activity` constraints, the operator selected "只补推理与消息，不报用量", authorizing live-only in-memory display IDs for `agent_thought_chunk` and `agent_message_chunk` when `agy` omits `messageId`, while keeping `token.usage` omitted to preserve the no-provider-accumulation invariant.
- 2026-11-27 clarification (requirement confirmation): The operator selected "确认需求，进入方案阶段 (Recommended)", confirming `requirement.md` and authorizing entry into `solution`.
- 2026-11-27 solution confirmation: The operator selected "确认方案 (Recommended)", confirming `technical-design/final.md` and authorizing entry into `awaiting-development-approval`.
- 2026-11-27 review entry: The operator selected "进入 review（本地独立 TeamMate 评审）" on the review-transition card, authorizing entry into `review` via an independent local TeamMate review of the complete diff without pushing or opening a PR.
- 2026-11-27 review adjudication (1/2): Four independent TeamMates (`kimi`, `glm`, `gpt-astra`, `qwen`) completed full-diff review. The operator selected "批准上述裁决并修复 (Recommended)", ratifying the four in-boundary fixes (plain-string-only `error` to prevent secret-redaction bypass, flushing anonymous messages in `finishTurn()`, preserving cached fields on `tool_call_update` with `null` values, and preserving raw `Path`/`CommandLine` while simplifying state/tests) and rejecting the three theoretical/false-premise items.
- 2026-11-27 review adjudication (2/2): The operator selected "同步改注释（推荐） (Recommended)", widening the approved boundary strictly to update the JSDoc comment on `NativeActivity.id` and `assistant.reasoning` in `packages/dreamux-types/src/activity.ts` (comment-only, no type or runtime change) alongside KB updates.
- 2026-11-27 review round 2 adjudication: `kimi`, `glm`, and `qwen` returned `PASS`; `gpt-astra` verified all Round 1 fixes and raised two follow-up polish items. The operator selected "批准收尾微调（推荐） (Recommended)", ratifying `win32.basename` for trailing-slash paths, narrowing the `activity.ts` merge comment and inlining `discardMessages()`, and tightening the provider-neutral `dreamux-types` JSDoc wording.
- 2026-11-27 knowledge-closeout entry: The operator selected "进入 knowledge-closeout (Recommended)" on the stage-transition card after all four Rush gates passed on the final diff.
- 2026-11-27 done & PR authorization: The operator selected "确认 done 并提交 PR (Recommended)" on the closeout card, confirming `done` state and authorizing commit, push, and PR creation targeting `next` (no merge authorization).

## Development approval

- Status: Granted on 2026-11-27 through the development-authorization card ("是否正式授权进入开发实现（implementation）阶段？") and the operator's explicit approving response ("授权开发 (Recommended)"), with the comment-only `packages/dreamux-types/src/activity.ts` JSDoc alignment ratified on 2026-11-27 through review adjudication card 2/2.
- Approved implementation boundary: Linked [requirement](/.agents/tasks/channel/align-antigravity-cot-display/requirement.md) and [final solution](/.agents/tasks/channel/align-antigravity-cot-display/technical-design/final.md) — `@excitedjs/agent-runtime-antigravity` ACP live activity projection (`src/acp/tool-display.ts`, `src/acp/activity.ts`), unit and runtime tests, comment-only JSDoc alignment in `packages/dreamux-types/src/activity.ts`, live ACP verification, required KB/documentation updates, and ordinary Rush change files. No changes to `tmux`, `token.usage`, Core, `feishu-channel`, Claude Code, or Codex.

## Delivery

- Pull request: [#497](https://github.com/excitedjs/dreamux/pull/497).
- Knowledge closeout:
  - `.agents/product/README.md`: Updated (`Antigravity runtime provider` ACP live display behavior).
  - `.agents/domains/provider-runtime.md`: Updated (`Antigravity External Provider` live activity ids and `acp/tool-display.ts` / `acp/activity.ts` pointers).
  - `packages/dreamux-types/src/activity.ts`: Updated (comment-only JSDoc alignment for structurally id-less live streams).
  - Directory `CLAUDE.md` files: N/A (none exist in `@excitedjs/agent-runtime-antigravity` or `@excitedjs/dreamux-types`).
  - `.agents/glossary.md`: N/A (no new or overloaded domain term introduced).
  - `.agents/root.md`: N/A (no new domain or routing change).
  - `packages/dreamux/skills/dispatcher/dreamux-maintenance/`: N/A (no config or persisted-state schema/default/ownership change).
