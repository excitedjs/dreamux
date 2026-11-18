# Configure Feishu reply presentation and artifacts

## Current state

- Goal: Allow ordinary Feishu replies to select interactive cards or native posts, render local Markdown images, and send non-image artifacts
- State: `blocked`
- Requirement: [Approved requirement](/.agents/tasks/channel/configure-feishu-card-mode/requirement.md)
- Final solution: [Approved implementation design](/.agents/tasks/channel/configure-feishu-card-mode/technical-design/final.md)
- Solution review Issue: Not created.
- Verification: [Live probe and local-check evidence](/.agents/tasks/channel/configure-feishu-card-mode/verification.md)
- Blockers: Devbox can review only a published PR, so independent review is blocked until that PR is opened.
- Resume stage: `review` after the PR review arrives.
- Next action: Commit and publish the complete change, open a PR to `next`, and request Devbox review on the PR.
- Related tasks: Builds on the native-post implementation and preserved send semantics from [simplify-feishu-replies](/.agents/tasks/channel/simplify-feishu-replies/README.md); preserves the interactive default selected by [read-feishu-inbound-as-text](/.agents/tasks/channel/read-feishu-inbound-as-text/README.md).

## Task selection

On 2026-11-18 the operator selected "创建新任务 (Recommended)" rather than reopening the completed native-post task. The new requirement lineage is configurable reply presentation, not a reopening of that completed work.

## Requirement confirmation

On 2026-11-18 the operator selected "确认完整需求 (Recommended)" on the revised requirement card. The confirmed boundary includes `interactive` / `post` reply presentation, local absolute-path Markdown images without an image argument, and optional non-image `artifacts`; width changes remain excluded. This confirmation authorizes solution work only.

## Solution confirmation

On 2026-11-18 the operator selected "确认方案 (Recommended)" after confirming that `card_mode` belongs in the Feishu channel instance's existing `config` object and clarifying that Markdown/image processing precedes card/post envelope selection. The confirmed solution remains reply-only; this decision does not authorize implementation.

## Development approval

- Status: Granted on 2026-11-18 by the operator's "批准开发与探针 (Recommended)" answer to the dedicated development-authorization card.
- Approved implementation boundary: The complete approved requirement and final solution, including Feishu channel config, reply Markdown images, non-image artifacts, tests, owning documentation, Rush change notes, and all required checks. The card also authorizes live interactive/post inline-image probes and representative MP4/archive messages in the originating conversation. If native post cannot render the inline image, stop and request a product decision. No merge authority was granted.

## Review transition

On 2026-11-18 the operator selected "进入代码评审 (Recommended)" after the complete implementation, live-probe evidence, whole-diff inspection, and all required monorepo gates were presented. The review target is the entire uncommitted change in this Team worktree against the approved requirement and solution, including the corrected MP4 mapping and all test/documentation changes.

The operator then required the review vehicle explicitly:

> devbox 和你不在一台机器，你只能开pr后让他review pr

This authorizes committing, publishing, and opening the PR needed for that independent review. It does not grant merge authority or declare review/knowledge closeout complete. The task remains blocked on the PR review and resumes at `review`.

## Delivery

- Pull request: [#492](https://github.com/excitedjs/dreamux/pull/492)
- Knowledge closeout: Pending.
